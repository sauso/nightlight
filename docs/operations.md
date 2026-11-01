# Operations: backup, restore, upgrade, rollback

Procedures for backing up, moving, upgrading and (if needed) rolling back a Nightlight
installation. Everything here is read-only against the running container except where marked.

## What makes up an installation

Everything that matters lives under the data volume you mapped to `/app/data` (`APPDATA_DIR` in
`.env`, or the **Data Directory** field on Unraid) — there's nothing else to back up unless
you've moved clips elsewhere. The database and the app's secrets are in a folder of their own
inside it, `private/` (see [The private folder](#the-private-folder)):

- `private/babymonitor.db` (+ its `-wal`/`-shm` companion files — see "Backing up" below, this
  matters): cameras, children, settings, accounts, sessions, and every stored password and token
- `private/.jwt_secret` — signs every session; losing it just signs everyone out, it isn't sensitive
  key material for anything else (there is none if you set `JWT_SECRET`)
- `private/firebase-service-account.json` and `private/google-services.json`, if you use Firebase
  push ([notifications.md](notifications.md#option-b-firebase))
- `private/detection-snapshots/` and `private/transition-snapshots/` — the pictures taken for alerts
  and bed changes
- `private/backup-<date>-<time>.db` — online backups, if you have made any ([Backing up](#3-backing-up))
- `clips/` — automatic clips, wake clips, manual recordings, timelapses (unless you've set
  `CLIPS_DIR` to a separate mount — see [recording.md](recording.md) — in which case back that
  path up too)

Nothing else in it needs backing up. The MediaMTX configuration is written fresh at every start
into the container's temporary folder, not the data volume, and the logs go to Docker
(`docker logs`), not to a file here.

### The private folder

`private/` is always `700` and owned by `PUID`:`PGID`, whatever `UMASK` says. Only the app can open
it. This is what lets FFmpeg, ffprobe and MediaMTX run as a separate, unprivileged user that writes clips into
the data directory ([Media isolation](#media-isolation), on by default), so that a camera stream that takes
over FFmpeg cannot read the app's secrets. A folder only the app may enter protects even a file inside it
whose own mode is too open, after a restore as root, say.

**An install from before this version is moved for you, once.** It has these files at the top of the
data directory. The first start of this version moves them into `private/` before the app starts, and
says so in one line of `docker logs nightlight`:

```
[entrypoint] private layout: the database and secrets are in /app/data/private (or there are none yet)
```

What the move does, and what it never does:

- The database moves only when nothing else has it open. It is first merged into one self-contained
  file (no `-wal` beside it) and locked, then moved by a single rename. If that cannot be proven, or
  the rename fails (for example because `private/` is a separate mount on another disk), it stays
  where it is, the app uses it there, the line above becomes a **warning**, and the next start tries
  again.
- A `-wal`, `-shm` or `-journal` already in `private/` with no database beside it (left by a database
  that was deleted from there) is set aside before the database moves in, so SQLite cannot replay it
  over the one moving in. Pictures in `private/` from that database are set aside the same way.
- The snapshot folders move with the database, never ahead of it.
- A **symbolic link** is never moved, since moving it can break it. It stays at the top level, and the
  warning says so on every start. A `private/` that is itself a symbolic link to a folder is used, and
  the folder it points to is made `700`; it is never re-owned through the link (the start-up warns if
  its owner is wrong).
- **Nothing is deleted, and nothing is written over.** If `private/` already has a file and the top
  level has another copy, the one in `private/` is used and the other is set aside. See
  [Two copies of the database](#two-copies-of-the-database).
- A file named by `FIREBASE_CREDENTIALS` or `FIREBASE_CLIENT_CONFIG` stays where it is. With
  `JWT_SECRET` set, a `.jwt_secret` file is not used, and it is left where it is.
- It runs on every start and is quick when there is nothing to do, so a Firebase file or an old
  backup that lands at the top level later is moved at the next start.
- It waits up to 30 seconds for the database checks before it gives up for that start. A network share
  that stops answering altogether holds the start-up while it waits, exactly as it would hold the app.
- **Known limit:** two containers on the same data directory are not supported (they never were: each
  would open the same database). The move cannot tell another container's database from its own.

The move is **one way**: an older version does not look in `private/`. Read
[Rolling back](#6-rolling-back) before you go back to one.

### Who can read the data directory

The database holds every secret Nightlight keeps — camera passwords, notification-provider tokens,
MFA secrets, the list of signed-in sessions — **in plaintext, by design**: the app has to read them
back to use them, so it cannot lock them away from itself. `.jwt_secret` signs every session, and
snapshots and clips show your home. What protects all of this at rest is **the file mode**, so
don't share the data directory with anything that doesn't need it.

Since #549 the container makes everything in it **owner-only** — files `600`, folders `700`, owned
by `PUID`:`PGID` — and on every start takes group/other access off anything in it that still has
some. Before that, new files were readable by every account on the host (`644`, folders `755`).

| `UMASK` | The file-creation mask for the app, and for the FFmpeg/MediaMTX processes it starts when [media isolation](#media-isolation) is off. With isolation on, those processes always use their own mask (`007`: their files are readable and writable by the media group and by no one else), whatever `UMASK` says. |
|---|---|
| Default | `077` (owner only). Blank or unset means the default. |
| Range | 3 or 4 octal digits whose **owner digit is `0`**: `000`–`077`, or `0000`–`0077`. For example `077`, `027` (the group may read), `022` (everyone may read, as before #549). |
| Anything else | Ignored with one warning in the log, and `077` is used. That includes a mask with an owner digit (`700`, `0777`): it would create files the app itself cannot open. A bad value never stops the container starting. |
| Existing files | Tightened on every start **only at `077`**. With any other value, files already there are left exactly as they are, and only new ones follow the mask. |
| Not affected | **`private/` is always `700`**, whatever the mask (see [The private folder](#the-private-folder)). So at `022` the clips and the data directory itself are readable by other accounts, but the database, the secrets, the snapshots and the backups are not. |

⚠️ **`UMASK=022` no longer opens the database to other users.** Before this version the opt-out
below also let a backup job running as another user read the database. Now that it is in
`private/`, such a job cannot read it at any `UMASK`. Run the job as root (Unraid's CA Appdata Backup
does), or have it copy the file [the online backup](#3-backing-up) writes.

Each start logs these lines (`docker logs nightlight`). The first two are the container's start-up
script; the last is the app itself, which shows the mask actually reached it:

```
[entrypoint] private layout: the database and secrets are in /app/data/private (or there are none yet)
[entrypoint] umask 077; existing entries with group/other access found: 0; modes: private=700 private/babymonitor.db=600 private/babymonitor.db-wal=600 private/babymonitor.db-shm=600 private/.jwt_secret=600
[data-dir] app umask 077; private/babymonitor.db mode 600
```

Each file is named by where it is. On an install whose move has not happened (see
[The private folder](#the-private-folder)) the database is named without `private/`, and the first
line is a warning that says why.

`absent` in the second line is normal on a first start (no database or `.jwt_secret` yet), and for
`-wal`/`-shm`, which come and go with the open database (they are also absent on the start that moves
the database, which merges them into it). The count is the files and folders the
start **found** with group/other access; the same start then takes that access away, and the
modes after it are what the line shows. So expect a large number once, on the first start after
upgrading, and `0` after that. A number that comes back on **every** start means the modes are not
sticking (see the filesystem limit below); a change that failed is logged as a separate warning.

**Who keeps access, and who loses it**, at the default, from the first start after upgrading:

- **Unchanged:** the app (it runs as `PUID`), and anything running as **root**: Unraid's CA Appdata
  Backup, `docker exec`, a file manager running as root. FFmpeg, ffprobe and MediaMTX run as `PUID` too
  when [media isolation](#media-isolation) is off; with it on (the default) they run as a separate
  user and cannot read the database or the secrets, only the clips and recordings.
- **Loses access:** anything that reads the data directory as a **different user** — a backup job
  or `rsync` running as a non-root user, another container that mounts the same folder with a
  different `PUID`, any other account on the host.
- **SMB (Unraid shares) — not verified:** access mapped to `nobody` (uid 99, the default `PUID`),
  such as guest access to a Public share, should be unchanged, because that user owns the files. A
  **named** Unraid user on a Secure or Private share is not the owner, and **may lose access (not
  verified)** once the group bits go; so may every SMB user if you set a non-default `PUID`. None of
  this has been checked on a real Unraid share yet.
- **Unraid's "New Permissions" tool**, run on the share that holds the data directory, makes it
  world-readable again; the next container start tightens it back. (The "Docker Safe New Perms"
  variant is meant to skip appdata.)

**Opting out is one-way, so decide before you upgrade.** If something else has to read the data
directory, set **`UMASK=022`** *before* the first start of a version with this change. After one
start at `077`, existing folders are `700` and files `600`, and `UMASK=022` only changes files
created after that: nothing loosens the old ones automatically. To loosen them by hand, as root on
the host, then keep `UMASK=022` set (or the next start tightens everything again):

```bash
chmod -R go+rX /mnt/user/appdata/nightlight     # your Data Directory / APPDATA_DIR
```

That opens the clips and the data directory itself. `private/` is tightened back to `700` at the next
start whatever you do, so the database and secrets stay owner-only.

**Known limits:**

- A **default ACL** on the host folder (`setfacl -d …`) overrides the umask: new files get the ACL's
  permissions, not `600`. Check with `getfacl` if the log shows `600` but another user can still read.
- On a filesystem that **ignores `chmod`** — a Docker Desktop for Windows bind mount (which is what
  the Compose default `./data` is there), or a CIFS/NTFS mount with a fixed `file_mode` — modes
  cannot change: the start-up line reports the same count on every start and the modes it shows stay
  as they were. What protects the data there is that filesystem's own access control.
- The start-up pass walks the data directory the way the ownership fix (`chown -R`) does when it
  runs: a **hard link** to a file elsewhere, or **another mount nested inside** the data directory, is
  changed too. A **symbolic link** is never followed: what it points to keeps its mode. On a large
  `clips/` folder this pass still reads every entry on every start (it writes only what needs
  tightening); the ownership fix, which rewrites every entry, now runs only when the data directory,
  `private/`, the database (in either place) or `.jwt_secret` has the wrong owner. A Firebase file, a
  snapshot folder or a backup at the top level with the wrong owner (copied in as root) is re-owned on
  its own, without the walk, so that it can be moved into `private/`.
- A `DATA_DIR` that is **itself a symbolic link** is neither re-owned nor tightened (the ownership
  fix stops at the link, and tightening files another user still owns would lock the app out of
  them); only new files in it follow the mask. `private/` is still made inside it, `700` and owned by
  `PUID`:`PGID`. The default `/app/data` mount is not a link.
- An **external `CLIPS_DIR`** (e.g. a `/recordings` mount) is neither re-owned nor tightened: new
  clips there are `600`, files already there keep their mode.
- **Demo mode**'s reset ([demo-mode.md](demo-mode.md)) copies its sample pictures and clips with
  the image's own modes (`644`), not the mask. They are stock media, not secrets.
- Only the image's start-up script sets the mask. Running the backend directly (`node src/index.js`,
  development) uses your own shell's umask and tightens nothing.

### Health check

The image defines a Docker `HEALTHCHECK`: every 30 seconds it requests `GET /api/health` (no login
needed; it answers `{"ok":true}`) on the port the app listens on (`PORT`, default 4000), with a
5 second timeout. After 3 failures in a row the container is marked **unhealthy**; failures during
the first **120 seconds** after start do not count, because MediaMTX and the detectors start slowly.
`docker ps`, `docker inspect` and Unraid's Docker tab show it.

**It only shows a state. Nothing restarts an unhealthy container**: plain Docker, Compose and
Unraid ignore it for restarts (`restart: unless-stopped` acts only when the process exits). It
answers "is the web server responding", not "is every camera streaming". If you want automatic
restarts, that needs something outside the image that watches the health status.

## 1. Check the current version and image revision

**Settings → About** shows the running version. For the exact commit, check the image's build
label from the host:

```bash
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' nightlight
```

(Empty if the image was built manually rather than by CI — that label only exists on images
built through this repo's `docker-publish.yml` workflow or its weekly rebuild.)

Images published by that workflow (and by the weekly rebuild) also carry an **SBOM** and a **build provenance**
attestation (#566). `docker buildx imagetools inspect sauso/nightlight:latest` lists them; a registry page may
show them as extra `unknown/unknown` entries, and `docker pull` ignores them.

The build uses moving major-version tags for its runtime Node 24 and MediaMTX 1 base images, rather
than fixed digests (#555 item 5). This picks up compatible base updates on rebuild, but rebuilding the
same Nightlight commit later may produce different image contents. The revision label identifies the
app commit, not identical image bytes; use the published image digest when you need that exact image.

### The weekly rebuild

Every Monday, `:latest` (from `main`) and `:dev` (from `dev`) are rebuilt with freshly pulled base
images and packages, so operating-system security fixes reach those tags without waiting for a
release. The code and the version number stay the same; **Settings → About** shows the new build
date. Release tags (`vX.Y.Z`) are never rebuilt. Nothing is deployed for you: pull the tag to get the
update.

A rebuilt image is tested before the tag moves to it (#566). Each image is built once and uploaded
without a tag. That exact image is started with a synthetic camera and has to deliver live video and
AAC audio over HLS, and its arm64 version has to start ffmpeg, MediaMTX and the database driver. Only
then is `:latest` or `:dev` pointed at it, by digest, so the tag serves the bytes that were tested,
SBOM and provenance included. If the build or any check fails, the tag stays on the image it had and the
run fails. After the tag moves, the run reads it back and checks it points at the tested image; if that
check ever fails the run is red, the tag may already have moved, and the run summary prints the command
that points it back. If `main` or `dev` gets a newer commit while the rebuild runs, that run leaves the tag alone.

What the test does not cover:

- Only the amd64 image streams in the test. The arm64 image is only checked for starting.
- The synthetic camera (`bluenviron/mediamtx:latest-ffmpeg`) and the test's HTTPS proxy
  (`caddy:2-alpine`) are not pinned, so a change in either can fail a rebuild that is fine. The tag
  then stays on the previous image until the cause is fixed.
- Rebuilds carry the same `org.opencontainers.image.revision` label as a normal publish (#864), set to
  the commit that was rebuilt. Rebuilds from before that change did not, so the command above prints
  nothing for them. A Monday run uses the workflow file on `main`, so `:latest` keeps its label through
  a rebuild only after a release that contains the fix and the Monday after it (the release's own
  publish labels `:latest` in between, until that Monday). **Settings → About** shows the commit
  either way.

Each run's summary on the repository's Actions page lists the digest the tag had before. To go back
to that image, pull it by digest (`docker pull sauso/nightlight@sha256:<digest>`) or pin a release
tag. The maintainer can point the tag itself back with
`docker buildx imagetools create -t sauso/nightlight:latest sauso/nightlight@sha256:<previous digest>`.

## 2. Stopping cleanly

`docker stop` (or `docker compose down` / `docker compose stop`) sends `SIGTERM` and waits up to
its configured grace period before `SIGKILL`. Nightlight needs a few seconds to finish an
in-flight recording safely — the Compose file, Unraid template, and the quick-start `docker run`
command all set a **30-second** grace period (`stop_grace_period` / `--stop-timeout 30`) for this
reason. If you've customized your own run command, keep that flag — the default grace period on
recent Docker Engine versions is short enough to cut a recording off mid-save.

## 3. Backing up

⚠️ **Read this before copying the database file.** Nightlight opens its database in SQLite's
**WAL (write-ahead log) mode**, and — verified against the current shutdown code — **it never
calls the database's own `close()` before exiting**, even on a clean `SIGTERM`. That means
recent writes can still be sitting in a separate `babymonitor.db-wal` file, not yet merged into
`babymonitor.db` itself, **even right after a clean stop**. Copying just the `.db` file in that
state doesn't just risk losing a few recent rows — verified with a throwaway test: it can
produce a copy that's missing tables entirely and fails to open at all, if a schema-changing
write happened to be the one still sitting in the WAL.

**Recommended — works while the container is running, no downtime:**

```bash
docker exec nightlight node src/scripts/backup-db.js
# Backup written to /app/data/private/backup-20261026-101500.db
```

This uses SQLite's official online-backup API — safe to run at any time, including while
Nightlight is actively writing. The copy is a single self-contained file (no `-wal`/`-shm`
companions needed), named by the date and time in the container's timezone (`TZ`), and written
**into `private/`**, owner-only (`600`) and owned by `PUID`:`PGID`, so it is as protected as the
database itself. Copy it out of the data directory as root on the host, for example
`cp /mnt/user/appdata/nightlight/private/backup-*.db /mnt/user/backups/` (your Data Directory /
`APPDATA_DIR`), and delete the old ones from `private/` when you no longer need them.

It refuses, and writes nothing, before the first start of this version (there is no `private/`
yet), and on a data directory with no database. It never creates either.

⚠️ **A scheduled job that runs the old command from this page** (`docker exec nightlight node -e "…
new Database('/app/data/babymonitor.db', { readonly: true }) … backup('/app/data/backup-…')"`) stops
working at the upgrade: once the database has moved, that path no longer exists, so the command fails
with `unable to open database file` and writes nothing (it opens the path read-only, so it never
creates an empty database there either). Change the job to the command above. Copies the old
command left at the top of the data directory are moved into `private/` at the next start.

**If you'd rather back up with the container stopped**, copy **all three** files together —
`private/babymonitor.db`, `private/babymonitor.db-wal`, and `private/babymonitor.db-shm` (the last
two may not exist if there's nothing pending, which is also fine) — never just the `.db` file alone,
for the reason above.

Either way, also copy `private/.jwt_secret` and (if you don't use the online method) the whole data
directory is simplest — `clips/` included, though it's large and, if you're not worried about
losing a few recent clips, arguably more disposable than the database.

## 4. Restoring

1. Stop Nightlight (or don't yet start it on a new host).
2. Put the backed-up files in the target's data directory (`APPDATA_DIR` / Data Directory), **in its
   `private/` folder** (create it if it is a new data directory) — just the database if you used the
   online-backup method, renamed to `private/babymonitor.db`, or all three database files plus
   `private/.jwt_secret`, the two snapshot folders and `clips/` (at the top level, not in `private/`)
   for a full restore. Remove any `babymonitor.db-wal` and `-shm` already in `private/` that do not
   belong to the copy you are restoring.
   - A backup from before this version has the files at the top of the data directory. Put them in
     `private/` the same way, or restore them to the top of an **empty** data directory: the first
     start moves them in.
   - ⚠️ **Do not put a restored database at the top level of a data directory that already has
     `private/babymonitor.db`.** The one in `private/` is used, and your restored copy is set aside, not
     used (the start-up log has a warning; see [Two copies of the database](#two-copies-of-the-database)).
3. **Ownership matters**: the container `chown`s the data directory to `PUID`/`PGID` on startup
   when the directory itself, `private/`, or the database / `.jwt_secret` (in either place), is not
   already owned by them, so
   restoring those as root (or a different user) and starting with the usual `PUID=99`/`PGID=100`
   self-corrects — you don't need to manually `chown` first. ⚠️ It no longer walks the whole tree
   on every start (that was slow with many GB of clips): a **restored `clips/` folder** owned by
   someone else, inside a data directory that is already right, is not fixed. Run
   `chown -R 99:100 <data directory>` on the host (your `PUID:PGID`) after restoring clips. If the data
   directory, or the database inside it, is a **symlink**, the start-up `chown` does not follow it: when the
   linked-to folder or file has the wrong owner the log says `fixing the whole data directory` on every start
   and nothing changes, so re-own the target on the host. (`PUID`/`PGID` written with leading zeros, such as
   `099`, are compared as numbers, so they do not cause a walk on every start.) At the default `UMASK` the same
   start also makes the restored files owner-only again (see
   [Who can read the data directory](#who-can-read-the-data-directory)).
4. Start the container. Existing sessions from the backup are still valid if `.jwt_secret` was
   restored too; otherwise everyone signs in fresh.
5. Confirm cameras, children and recent recordings all show up before considering the restore
   done.

## 5. Upgrading

```bash
docker compose pull && docker compose up -d          # Compose
# or, on Unraid: the container's "Check for Updates" / re-apply the template
# or, plain docker run: docker pull sauso/nightlight:latest && re-run your docker run command
```

Migrations run automatically and are additive (new columns, sentinel-gated, wrapped in a
transaction per group) — there's no separate migration step to run by hand.

**Upgrading to a version with #549 for the first time?** That start makes the data directory
owner-only. If a backup job, another container or an SMB user other than `nobody` reads it, read
[Who can read the data directory](#who-can-read-the-data-directory) **before** you upgrade: the
opt-out (`UMASK=022`) has to be set before that first start to keep the old modes.

**Upgrading to the version with the private folder for the first time?** That start moves the
database and secrets into `private/` ([The private folder](#the-private-folder)), and it is one way.
Before you upgrade: make a backup, read [Rolling back](#6-rolling-back), and change any scheduled
backup job to the new [backup command](#3-backing-up). Afterwards, check the start-up log for the
`private layout:` line: a warning there means something stayed at the top level, and says why. Then,
a day or so later, **check that your newest backup is dated after the upgrade**: a scheduled job still
using the old command fails without anyone seeing it. A job on the host that copies `backup-*.db` from
the top of the data directory now copies nothing, because backups are written into `private/`: point it
at `private/backup-*.db` (and run it as root).

After upgrading:

1. Check `docker logs nightlight` for a clean startup with no error lines.
2. `curl http://<host>:4000/api/health` should return `{"ok":true}`.
3. Open the app and confirm at least one camera is streaming.

## 6. Rolling back

Pull and run an **older** tag/digest the same way as upgrading, in reverse. Because migrations
are **additive-only** (no column is ever removed or renamed, and nothing here has a "down"
migration), an older version's code generally still reads a newer database correctly — it just
doesn't know about whatever new columns/features arrived after it. This is **not a guarantee**
for every possible change (a rollback across a release that changed the *meaning* of existing
data, not just added columns, would need checking against that release's own notes) — but for
the common case of "this update broke something, go back one version," it's expected to work.
Confirm with the same three checks as upgrading (logs, `/api/health`, one camera) before trusting it.

**Going back past the private folder needs one more step.** A version from before the private folder
looks for its database at the top of the data directory. Once this version has moved it into
`private/`, an older image finds none there and **starts empty**: it asks for first-run setup as if
it were a new install. Your data is still there, in `private/`; the older version does not look
there. (This is checked by the automated `private-layout` test, which starts the previous release
on a moved data directory.)

To roll back, stop the container and move the files back to the top level, as root on the host,
before you start the older image:

```bash
cd /mnt/user/appdata/nightlight                       # your Data Directory / APPDATA_DIR
mv private/babymonitor.db* private/.jwt_secret .
mv private/detection-snapshots private/transition-snapshots .
mv private/firebase-service-account.json private/google-services.json .    # only if you use Firebase push
```

(Leave out any file that is not there.) Or restore a backup you made before the upgrade. If you have
already started the older image on the moved data directory, it made a new, empty `babymonitor.db`
(and `.jwt_secret`) at the top level: move those aside first (`mkdir empty-copy && mv babymonitor.db*
.jwt_secret empty-copy/`), then move yours back as above.

**Coming forward again later:**

- If you rolled back by **moving the files back** as above, `private/` has no database, and the next
  start of this version moves them in again.
- If you rolled back by **restoring a backup to the top level** instead, `private/` still holds the
  copy from before the rollback. Coming forward as it is would keep using THAT copy, and set your
  rolled-back weeks aside as the "other" copy ([Two copies](#two-copies-of-the-database)). So before you
  start this version again, move the old private copy out of the way, as root on the host:
  `cd private && mkdir before-rollback && mv babymonitor.db* detection-snapshots transition-snapshots before-rollback/`
  (leave out anything that is not there).

## 7. Recovering from a corrupt or partial backup

If a `.db` file won't open (the classic symptom described in "Backing up" above — a plain
mid-write copy with no `-wal`/`-shm`), first check whether you also have the companion files
from the same backup: if `babymonitor.db-wal` and `-shm` from the *same* backup are available
alongside it, put all three in place together (in `private/`) and SQLite will recover the pending
writes on next open. If you only have the bare `.db` file and it won't open, there is no supported
repair — restore an earlier backup instead. This is exactly why the online-backup method in step 3 is
recommended: it never produces a partial file in the first place.

## Two copies of the database

The start-up script sets a copy aside when `private/` already has a file and the top of the data
directory has another one by the same name. That happens after a restore put at the top level of a
moved install, or after an older version ran on it (see [Rolling back](#6-rolling-back)). The copy in
`private/` is always the one used: nothing is chosen by size or date, and nothing is deleted or
overwritten. The other copy is moved to `private/legacy-<date>-<time>/` as one unit: the database
first, then its `-wal`/`-shm` and its snapshot folders into the same folder (if the database itself
cannot be moved, none of it is, and the next start tries again). The start-up log has one warning:

```
[entrypoint] warning: private layout: a copy at the top of /app/data was set aside in /app/data/private/legacy-*/ because /app/data/private already had one, which is the one used (docs/operations.md, "Two copies of the database"); starting anyway
```

The same rule applies to `.jwt_secret` (so nobody is signed out), the Firebase files, a backup with
the same name, and a snapshot folder when both hold pictures (it is set aside whole, never merged). The
pictures of a set-aside database never go into `private/`: they are named by its own row ids, and would
show up against the wrong alerts there.
While any `legacy-*` folder exists, `GET /api/about` reports `"layoutConflict": true` (and so does the
diagnostics bundle, as `layout_conflict`). The About page itself does not show it yet.

Then decide:

- **Keep what is running:** check the set-aside copy is not something you need, then delete the
  `legacy-*` folder. The flag clears at once.
- **Use the set-aside copy instead:** stop the container and swap them, as root on the host, then
  start it:

  ```bash
  cd /mnt/user/appdata/nightlight/private                # your Data Directory / APPDATA_DIR
  mkdir replaced
  mv babymonitor.db* detection-snapshots transition-snapshots replaced/                # the copy in use
  mv legacy-<date>-<time>/babymonitor.db* legacy-<date>-<time>/*-snapshots .          # the one you want
  ```

  (Leave out a snapshot folder that is not there.) The database and its pictures go together, both
  ways: pictures are named by their database's row ids. Move `.jwt_secret` the same way if you want
  that copy's sign-ins too. Keep `replaced/` until you are sure; it is not used.

## Hardening the container (optional)

You can run Nightlight with fewer privileges than Docker gives a container by default. This is optional,
and nothing changes unless you add it: the Compose file has the lines commented out, and the Unraid
template does not include them.

**How far it is tested:** an automated test (the `hardened` job in `.github/workflows/e2e.yml`) runs it on
**bridge networking only**. It has also been tried by hand on one Unraid install, with host networking and with a
dedicated LAN address (clean start, clean stop, recordings saved, WebRTC and HLS playing); those hand checks are not automated. If you turn it on, run
the checks in [Checking it works](#checking-it-works).

### What it changes, and what it does not

The container starts as root just long enough to set up the data directory, then hands over to `PUID`.
The app already runs as that user, with no special privileges, and so do FFmpeg, ffprobe and MediaMTX
unless [media isolation](#media-isolation) is on (it is by default, and it works with this hardening: the
app then keeps `SETUID`, `SETGID` and `KILL` as its own capabilities, and the media programs run as a
separate user with none). The hardening limits what stays root: the container's init process, the start-up
script, `docker exec` commands and the health check keep only the six capabilities listed below, and
nothing in the container can gain privileges again (`no-new-privileges`). Raw network access (`NET_RAW`)
is among the capabilities removed, which matters most on host networking.

It does **not**:

- keep FFmpeg away from the database by itself. That is [media isolation](#media-isolation), which is a
  separate thing: it is on by default whether or not you add these flags. If it cannot start on your host
  (the log has a `media isolation is off` warning), FFmpeg runs as the app's user and could still read the
  database.
- hold the app itself back if you set `PUID=0`. The app then runs as root and keeps all six capabilities.
- replace keeping the data directory private (see [Who can read the data directory](#who-can-read-the-data-directory)).

A `PORT` below 1024 behaves as it does today.

### Turning it on

**Unraid:** edit the container, switch to **Advanced View**, and replace the whole **Extra Parameters**
field with:

```
--log-opt max-size=10m --log-opt max-file=3 --stop-timeout 30 --cap-drop=ALL --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=FOWNER --cap-add=KILL --cap-add=SETUID --cap-add=SETGID --security-opt=no-new-privileges=true
```

⚠️ Keep the first three flags. They are the log rotation and the 30-second stop grace. Pasting only the
new flags removes them, and without the grace a restart can cut a recording off mid-save.

**Compose:** uncomment these lines in `docker-compose.yml` (under `stop_grace_period`), then run
`docker compose up -d`:

```yaml
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
      - DAC_OVERRIDE
      - FOWNER
      - KILL
    security_opt:
      - no-new-privileges=true
```

**Your own `docker run` command:** add the same flags as the Unraid field, keeping `--stop-timeout 30`.

### If a capability is missing

Each of the six has one job. If one is left out, this is what you see, in the order you would notice it:

- **CHOWN, SETUID, SETGID** re-own the data directory to `PUID`:`PGID` and hand the app over to that user.
  Without one of them the container stops at every start, and the log shows `Operation not permitted` or
  `usermod: Failed to change ownership of the home directory`. With [media isolation](#media-isolation),
  the app keeps `SETUID` and `SETGID` (and `KILL`) after the hand-over, to start each media program as the
  media user.
- **DAC_OVERRIDE** lets root into the owner-only (`700`) data directory and its `private/` folder. Without
  it the first start works,
  but once the container is re-created (an update, or **Apply** on Unraid) it stops at start with
  `usermod: Failed to change ownership of the home directory`. That message points at ownership; the cause
  is the missing capability. The `docker exec` commands in these guides (the
  [online backup](#3-backing-up), the [two-factor reset](mfa.md#recovery)) also fail, because they run as
  root and cannot open the database.
- **FOWNER** lets the start-up script take group/other access off files the app owns. Without it the
  container runs, but logs `could not tighten every entry` (and `could not make /app/data/private
  owner-only`), and the data directory keeps whatever access it had.
- **KILL** lets the container's init process pass Docker's stop signal on to the app. **This is the silent
  one:** everything works until the container stops. Then the app is killed instead of stopping cleanly, so
  a recording in progress is lost on every stop, restart and update. The log shows a
  `[FATAL tini (1)] Unexpected error when forwarding signal` line and no `Shutting down` line, and the exit
  code is 1. (With media isolation, a missing `KILL` is caught at start instead: isolation turns itself off with a
  warning and the container starts the plain way, where the stop problem above applies.)

The automated test checks the KILL, DAC_OVERRIDE and FOWNER cases. The CHOWN, SETUID and SETGID messages
are worked out from the start-up script, not tested.

### Checking it works

Run these after turning it on. The pass is the log line and the exit code in step 5, **not** how quickly
the container restarts: without KILL it also stops quickly, because it is killed.

1. The flags applied:
   `docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}} {{.HostConfig.SecurityOpt}}' nightlight`
   shows `ALL`, the six capabilities (Docker may write them as `CAP_CHOWN` and so on) and
   `no-new-privileges=true`.
2. The start-up log (`docker logs nightlight`) has no `could not tighten` line.
3. Every camera streams.
4. Start a manual recording and, while it is recording, stop the container: `docker stop nightlight`.
5. `docker inspect -f '{{.State.ExitCode}}' nightlight` prints `0`, and the end of `docker logs nightlight`
   shows `Shutting down - stopping transcoders and MediaMTX.`
6. Start the container again (`docker start nightlight`) and check that the recording was saved.

On Unraid, run the commands in the Unraid terminal; the template names the container `nightlight`.

### Turning it off

On Unraid, set **Extra Parameters** back to `--log-opt max-size=10m --log-opt max-file=3 --stop-timeout 30`
and apply. With Compose, comment the lines out again and run `docker compose up -d`. Nothing in the data
directory depends on the hardening, so you can turn it off at any time.

## Media isolation

**Status:** on by default. Nothing to set. The container tries it at every start and, if the host cannot do it, starts
the old way with one warning (below). **The setting:** `NIGHTLIGHT_MEDIA_ISOLATION`, read only when the container
starts. **Default:** not set, which means "try it". **Range:** `0`, `off` or `false` (any capitals) turns it off, and
nothing else does: blank, `1` or any other text is the same as not set. Because it is read only at start, changing it
needs the container to be re-created (**Apply** on Unraid, `docker compose up -d`), not just restarted. On Unraid,
add it as a variable on the container: it is deliberately not in the template.

**What it does.** FFmpeg, ffprobe and MediaMTX read video from your cameras, so they handle data that the camera (or
whoever has taken over the camera) controls. With isolation on, they run as a separate user inside the container (id
`1700`, with no extra privileges), so a fault in one of them cannot read the database or the secrets. Off, they run as
the same user as the app, which is how Nightlight worked before. **Settings → About** shows one line, "Media
isolation: on" or "off", for what this start decided; `GET /api/about` reports it as `mediaIsolation`.

**When About warns you.** "Off" has four different causes, and two of them are worth a warning. `GET /api/about`
reports which as `mediaIsolationReason` (`null` when isolation is on), with a fixed sentence in `mediaIsolationDetail`
when there is something to fix:

- `disabled`: you turned it off with `NIGHTLIGHT_MEDIA_ISOLATION`. That is your choice, so About shows only the quiet
  line.
- `root`: `PUID=0`. Isolation stays off by design when the app runs as root, so About shows only the quiet line.
- `id-clash`: `PUID` or `PGID` is `1700`, the media user's own id. You can fix this, so **admins see a warning at the
  top of About** telling them to change it to another number and re-create the container.
- `fallback`: isolation was on (the default) but the host could not provide it. **Admins see a warning at the top of
  About** saying the camera programs are running without the extra protection, with one of these causes:
  - the start-up trial run found a media program could reach files only the app may read, or could not run as the
    media user;
  - the trial run did not finish in time (a stalled network share, say);
  - the container lacks a capability the app needs (`SETUID`, `SETGID` or `KILL`), or the trial run could not start;
  - the data or clips folders could not be set up for the media user;
  - a database, backup or secret is still at the top of the data directory instead of in `private/`;
  - `PUID` or `PGID` is not a number;
  - anything else, in which case the sentence says the container log has the reason.

Caregivers never see the warning. The full reason, with file and folder names, is only in the container log, as the
`[entrypoint] warning: media isolation is off: ...` line. The page and `GET /api/about` (which every signed-in user can
read) carry one of the fixed sentences above and nothing from your host: no file names, no folder paths.

**Turning it off.** Set `NIGHTLIGHT_MEDIA_ISOLATION=0` and re-create the container. Going back is automatic and needs
nothing else: files the media user wrote are handed back to `PUID`:`PGID` once, at that start (see "Going back to
off" below). Use it if something on your host misbehaves with isolation and the log does not say why, and please
report it.

**What changes for you when it is on.** Recordings, clips and timelapses that already exist stay exactly as they are
(owned by `PUID`, mode `600`). New ones are written by the media user, so they are owned by uid `1700`, group `1700`,
mode `660`: **another account on the host, or a share user over SMB, can no longer read new recordings straight from
the folder**, only root and the app can. The app plays and downloads them as it always did. If a backup job or file
manager that is not root reads your clips folder, see "Known limits" below before you rely on it. The database,
secrets, backups and pictures are in [`private/`](#the-private-folder), as before.

**What it needs, and what it checks.** The container checks this at every start and, if anything is wrong, starts the
usual way (isolation off) with one `[entrypoint] warning: media isolation is off: <reason>` line. It never refuses to
start. It stays off when:

- `PUID` is `0` (the app would run as root; the warning then appears at every start, and `NIGHTLIGHT_MEDIA_ISOLATION=0`
  silences it), `PUID` or `PGID` is `1700` (the media user's own id), or either is not a number;
- the database, a backup, a snapshot folder, `.jwt_secret` or a Firebase file is still at the top level of the data
  directory instead of in [`private/`](#the-private-folder). Isolation opens the data directory to the media group, so a
  file left at the top would be protected only by its own permissions. A `.jwt_secret` is exempt if you set
  `JWT_SECRET`, and a Firebase file is exempt if you named it with `FIREBASE_CREDENTIALS` or `FIREBASE_CLIENT_CONFIG`.
  `.demo-ready` and the clips folder are not checked;
- the clips folder (or its parent folders inside the data directory) belongs to a user other than `PUID`. The start-up
  script gives the folders to the media group; it does not take over a folder somebody else owns, because the app could
  no longer write there. Fix the owner on the host (`chown PUID:PGID`);
- the container lacks the three capabilities the app keeps (`SETUID`, `SETGID`, `KILL`), or a media program cannot run
  as the media user;
- a trial run of the folders fails or takes longer than 30 seconds (a network share that has stalled, say). The trial
  is a dry run: nothing it does changes your data;
- the host does not behave the way isolation needs, so the trial fails. Known cases: **rootless Docker or Podman**
  (the container cannot use the media user's id), **an SMB or CIFS share, or an ACL-based share, that ignores
  `chmod`** and ownership, and **NFS with `root_squash`** (the start-up script's root cannot change the group of the
  folders). What has been checked: the permission checks by hand on one Unraid user share, and the whole chain in
  automated tests on a Linux runner. It has not been tried on rootless Docker, rootless Podman or NFS.

**Who can read what, with isolation on.**

| Folder | Owner and group | Mode | The media user can |
| --- | --- | --- | --- |
| Data directory | `PUID`, group `1700` | `710` | pass through to the clips folder; not list it, not read anything in it |
| `private/` (database, secrets, backups, snapshots) | `PUID`:`PGID` | `700` | nothing, not even see that it is there |
| Clips folder, and the folders above it inside the data directory | `PUID`, group `1700` | `750` | enter and list; not create, rename or delete |
| `.ring/<camera>`, `<camera>/`, `timelapse/<child>/` | `PUID`, group `1700` | `1770` (sticky) | write its own files; not delete or replace the app's |
| Lists and pictures the app writes for FFmpeg to read (`.concat/`, `.timelapse-frames/`) | `PUID`, group `1700` | `750` folders, `640` files | read; not change |

The three write folders are made when the app first needs them, so a running install gets them on its first recording.
There is no `setgid` bit anywhere: the kernel on at least one common NAS drops it, so nothing relies on it. Clips and
recordings that already exist keep their owner and mode (`600`), and only the app reads them.

**What the app does with what the media user writes.** It treats the files in the three write folders as untrusted: it
opens them without following a symbolic link, serves only a regular file with a single name (a second hard link to
the database would otherwise pass), and deletes one file at a time rather than walking the folder. It ignores any file
in the ring folder that is not named like one of its own segments. A clip request returns what it always did (same status,
headers, and seeking).

**An external clips folder** (`CLIPS_DIR`, for example a `/recordings` mount): only its top folder is changed, to group
`1700` and mode `750`, and nothing above it. The start-up script does not walk the clips, so a large mount costs
nothing at start. The media user must be able to reach the mount: the folders above it need the execute permission for
"other" (`755` is usual). If it cannot, the trial run fails and isolation stays off.

**Start-up file modes.** With isolation asked for, the walk that removes group and other access from existing files
(see [Who can read the data directory](#who-can-read-the-data-directory)) is limited to `private/` and the files at the top level,
because it would otherwise remove the group access this layout depends on. If isolation then turns out to be off, the
whole tree is walked as usual.

**Going back to off.** Clips and recordings made while isolation was on belong to the media user. If a later start ends
with isolation off (the trial failed, a capability went missing, or the setting was removed), the start-up script gives
the data directory and the clips folder (an external one too) back to `PUID`:`PGID` **once**, before it tightens modes,
and logs `[entrypoint] media isolation is off, but an earlier start had it on: giving … back`. Without that the app,
which is not in the media group when isolation is off, could not play those clips. It recognises the case by the media
group (or media-owned entries) on the data directory or clips folder, so the next start finds nothing to do. On a big
clips folder that one pass reads every entry, like the ownership fix described under [Who can read the data directory](#who-can-read-the-data-directory).

**Known limits.** This protects the database and the secrets from a fault in FFmpeg, ffprobe or MediaMTX. It does not
make the container a sandbox, and it does not stop everything:

- **The app itself can still become root inside the container.** It keeps `SETUID` and `SETGID` to start the media
  programs. A fault in the app (not in FFmpeg) could use them to become any user in the container. If the data share is
  not mounted `nosuid`, it could also create setuid files on it. Isolation is aimed at the camera-facing programs, not
  at a compromised app.
- **All the media programs share one user.** One taken-over FFmpeg can signal or inspect the others, MediaMTX and
  other cameras' FFmpeg included.
- **MediaMTX's control API (`127.0.0.1:9997`) and its RTSP port (`127.0.0.1:8554`) have no password.** A taken-over
  media program can add, change or remove stream paths, and read or publish a camera's stream. It cannot get a camera's
  address or password from them: MediaMTX is never told them (FFmpeg connects to the camera itself). A password on the
  API would not help while all the media programs share one user, which can already signal or inspect MediaMTX. The
  passwords that can be read are the ones on FFmpeg's command line, next.
- **Camera passwords are on FFmpeg's command line,** visible to every process in the container, and they are in that
  FFmpeg's memory too. Whether another media program can read that memory depends on your host's kernel: where Yama's
  `ptrace_scope` is 1 or higher it cannot, and only the command line leaks. On a kernel without Yama, as on Unraid
  (`cat /proc/sys/kernel/yama/ptrace_scope` says "No such file"), it can, so hiding the command line alone would not
  help and nothing here closes this. Only a separate user for each camera would, which is a large change that is not
  planned. This is why the advice to keep cameras on their own network matters.
- **Other accounts can no longer read new recordings** (see "What changes for you" above). A backup job or file manager
  running as a non-root user needs read access to files owned by uid `1700`, group `1700`; root (Unraid's CA Appdata
  Backup, `docker exec`) is unaffected. Give such a job the group, or turn isolation off.
- **Playback on real devices is not proven by the automated tests.** They show that a live stream is served and that
  recordings are made and played back through the app, not that every phone or browser decodes it. After an upgrade,
  check that each camera plays and that a recording saves, as in [Checking it works](#checking-it-works).

Keep cameras on their own network, as [cameras.md](cameras.md) says; that advice is unchanged by isolation.

## Logs

Use Docker's logs to check what the app and MediaMTX are doing. Both log to stdout, which Docker captures:

```bash
docker logs -f nightlight
```

Docker's own log rotation caps total log storage at 10MB × 3 files, so the logs don't grow without limit. This matters particularly on Unraid, where Docker's storage is a fixed-size image that can break the whole Docker service if it fills up.

- The `docker run`/Compose examples in the [installation guide](installation.md) and the Unraid template's extra parameters already configure this rotation.
- If you deployed before this was added, add `--log-opt max-size=10m --log-opt max-file=3` yourself (or use the Unraid template's "Extra Parameters" field) to get the same protection.

Log timestamps use the container's local time rather than UTC, so they line up with when you actually remember something happening. Set it with the `TZ` variable in the [installation guide](installation.md); `TZ` also names the video buffer's segment files. The times shown in the app follow [Settings → General](#times-and-your-timezone).

## Times and your timezone

Set your home timezone in **Settings → General** so the app's times agree across devices. Every time the app shows is in your **home** time: the timezone set there (an IANA
name such as `Europe/London`; **default `UTC`** until you set it, so set it first). It is the same zone
the sleep reports, the morning review and the alert schedule already use, so an alert at "7:00 pm" is
the same moment on every phone, and it agrees with the sleep card. It is **not** the zone of the phone or
browser you happen to be using.

- **When your device is in a different zone** (travelling, or someone watching from abroad), a time
  carries a short zone label after it, such as **7:00 pm GMT-7**, so it cannot be mistaken for the
  device's own clock. **When the device is in your home zone nothing is added**, so a household that
  stays put sees no change. Clock format (12 or 24 hour) and date order follow the device's own language
  settings, not the timezone.
- **Where it applies:** the alert and camera-history lists (the exact time is in the tooltip on each row
  and in the clip player), **Settings → Camera and Recording → Clip management** (clips are grouped under their home-time **day**, and the
  date filter and its "today" use home days, so two people never see the same clip on different days),
  the **Recordings** card, a camera tile's **silenced until** time, and the nightly timelapse dates (a
  night is a calendar date worked out in home time, so it never shifts).
- **Not affected:** ages such as "3h ago" (elapsed time is the same everywhere), the sleep screens (they
  were already in home time), and the build date under **About**.
- **Known limits.** The label appears whenever the device's zone *name* differs from home, even if the two
  happen to share an offset today (Paris and Berlin, say); it never hides a real difference. A time from
  before a daylight-saving change shows the offset that applied then. Right after the page opens, before the setting has
  loaded, times show in `UTC` for a moment and then switch to your home zone.
