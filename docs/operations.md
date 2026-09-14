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
   self-corrects — you don't need to manually `chown` first.
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
transaction per group) — there's no separate migration step to run by hand. After upgrading:

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
