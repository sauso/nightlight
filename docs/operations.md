# Operations: backup, restore, upgrade, rollback

Procedures for backing up, moving, upgrading and (if needed) rolling back a Nightlight
installation. Everything here is read-only against the running container except where marked.

## What makes up an installation

Everything that matters lives under the data volume you mapped to `/app/data` (`APPDATA_DIR` in
`.env`, or the **Data Directory** field on Unraid) — there's nothing else to back up unless
you've moved clips elsewhere:

- `babymonitor.db` (+ its `-wal`/`-shm` companion files — see "Backing up" below, this matters)
- `.jwt_secret` — signs every session; losing it just signs everyone out, it isn't sensitive
  key material for anything else
- Generated MediaMTX config
- `clips/` — automatic clips, wake clips, manual recordings, timelapses (unless you've set
  `CLIPS_DIR` to a separate mount — see [recording.md](recording.md) — in which case back that
  path up too)

Firebase push credentials, if you use them, are entered through the UI and stored in the
database, not as a separate file.

### Who can read the data directory

The database holds every secret Nightlight keeps — camera passwords, notification-provider tokens,
MFA secrets, the list of signed-in sessions — **in plaintext, by design**: the app has to read them
back to use them, so it cannot lock them away from itself. `.jwt_secret` signs every session, and
snapshots and clips show your home. What protects all of this at rest is **the file mode**, so
don't share the data directory with anything that doesn't need it.

Since #549 the container makes everything in it **owner-only** — files `600`, folders `700`, owned
by `PUID`:`PGID` — and on every start takes group/other access off anything in it that still has
some. Before that, new files were readable by every account on the host (`644`, folders `755`).

| `UMASK` | The file-creation mask for the app and the FFmpeg/MediaMTX processes it starts. |
|---|---|
| Default | `077` (owner only). Blank or unset means the default. |
| Range | 3 or 4 octal digits whose **owner digit is `0`**: `000`–`077`, or `0000`–`0077`. For example `077`, `027` (the group may read), `022` (everyone may read, as before #549). |
| Anything else | Ignored with one warning in the log, and `077` is used. That includes a mask with an owner digit (`700`, `0777`): it would create files the app itself cannot open. A bad value never stops the container starting. |
| Existing files | Tightened on every start **only at `077`**. With any other value, files already there are left exactly as they are, and only new ones follow the mask. |

Each start logs two lines (`docker logs nightlight`). The first is the container's start-up script,
the second is the app itself, which shows the mask actually reached it:

```
[entrypoint] umask 077; existing entries with group/other access found: 0; modes: babymonitor.db=600 babymonitor.db-wal=600 babymonitor.db-shm=600 .jwt_secret=600
[data-dir] app umask 077; babymonitor.db mode 600
```

`absent` in the first line is normal on a first start (no database or `.jwt_secret` yet), and for
`-wal`/`-shm`, which come and go with the open database. The count is the files and folders the
start **found** with group/other access; the same start then takes that access away, and the
modes after it are what the line shows. So expect a large number once, on the first start after
upgrading, and `0` after that. A number that comes back on **every** start means the modes are not
sticking (see the filesystem limit below); a change that failed is logged as a separate warning.

**Who keeps access, and who loses it**, at the default, from the first start after upgrading:

- **Unchanged:** the app, FFmpeg and MediaMTX (they run as `PUID`), and anything running as
  **root**: Unraid's CA Appdata Backup, `docker exec`, a file manager running as root.
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

**Known limits:**

- A **default ACL** on the host folder (`setfacl -d …`) overrides the umask: new files get the ACL's
  permissions, not `600`. Check with `getfacl` if the log shows `600` but another user can still read.
- On a filesystem that **ignores `chmod`** — a Docker Desktop for Windows bind mount (which is what
  the Compose default `./data` is there), or a CIFS/NTFS mount with a fixed `file_mode` — modes
  cannot change: the start-up line reports the same count on every start and the modes it shows stay
  as they were. What protects the data there is that filesystem's own access control.
- The start-up pass walks the data directory the way the ownership fix (`chown -R`) always has: a
  **hard link** to a file elsewhere, or **another mount nested inside** the data directory, is
  changed too. A **symbolic link** is never followed: what it points to keeps its mode. On a large
  `clips/` folder the pass takes about as long as the ownership fix does.
- A `DATA_DIR` that is **itself a symbolic link** is neither re-owned nor tightened (the ownership
  fix stops at the link, and tightening files another user still owns would lock the app out of
  them); only new files in it follow the mask. The default `/app/data` mount is not a link.
- An **external `CLIPS_DIR`** (e.g. a `/recordings` mount) is neither re-owned nor tightened: new
  clips there are `600`, files already there keep their mode.
- **Demo mode**'s reset ([demo-mode.md](demo-mode.md)) copies its sample pictures and clips with
  the image's own modes (`644`), not the mask. They are stock media, not secrets.
- Only the image's start-up script sets the mask. Running the backend directly (`node src/index.js`,
  development) uses your own shell's umask and tightens nothing.

## 1. Check the current version and image revision

**Settings → About** shows the running version. For the exact commit, check the image's build
label from the host:

```bash
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' nightlight
```

(Empty if the image was built manually rather than by CI — that label only exists on images
built through this repo's `docker-publish.yml` workflow.)

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
docker exec nightlight node -e "
process.umask(0o077);
const Database = require('/app/node_modules/better-sqlite3');
const db = new Database('/app/data/babymonitor.db', { readonly: true });
db.backup('/app/data/backup-$(date +%Y%m%d-%H%M%S).db')
  .then(() => { console.log('Backup complete.'); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
"
```

This uses SQLite's official online-backup API (via `better-sqlite3`, already installed in the
image) — safe to run at any time, including while Nightlight is actively writing. Copy the
resulting `backup-<timestamp>.db` file out of the data volume; it's a single self-contained
file, no `-wal`/`-shm` companions needed.

The first line, `process.umask(0o077)`, makes the copy owner-only (`600`). `docker exec` does not
go through the container's start-up script, so without it the copy would be created with Docker's
`022`: a world-readable file holding every secret in the database, sitting in the data directory
until the next start tightens it (at the default `UMASK`; see
[Who can read the data directory](#who-can-read-the-data-directory)).
The copy belongs to root until then, so copy it out as root.

**If you'd rather back up with the container stopped**, copy **all three** files together —
`babymonitor.db`, `babymonitor.db-wal`, and `babymonitor.db-shm` (the last two may not exist if
there's nothing pending, which is also fine) — never just the `.db` file alone, for the reason
above.

Either way, also copy `.jwt_secret` and (if you don't use the online method) the whole data
directory is simplest — `clips/` included, though it's large and, if you're not worried about
losing a few recent clips, arguably more disposable than the database.

## 4. Restoring

1. Stop Nightlight (or don't yet start it on a new host).
2. Put the backed-up files in the target's data directory (`APPDATA_DIR` / Data Directory) —
   just `babymonitor.db` if you used the online-backup method, or all three database files plus
   `.jwt_secret` and `clips/` for a full restore.
3. **Ownership matters**: the container `chown`s the data directory to `PUID`/`PGID` on startup,
   so restoring as root (or a different user) and starting with the usual `PUID=99`/`PGID=100`
   self-corrects — you don't need to manually `chown` first. At the default `UMASK` the same
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

## 7. Recovering from a corrupt or partial backup

If a `.db` file won't open (the classic symptom described in "Backing up" above — a plain
mid-write copy with no `-wal`/`-shm`), first check whether you also have the companion files
from the same backup: if `babymonitor.db-wal` and `-shm` from the *same* backup are available
alongside it, put all three in place together and SQLite will recover the pending writes on
next open. If you only have the bare `.db` file and it won't open, there is no supported repair
— restore an earlier backup instead. This is exactly why the online-backup method in step 3 is
recommended: it never produces a partial file in the first place.
