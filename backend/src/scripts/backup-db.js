// Online backup of the database, safe while the app is running (SQLite's own backup API, which copies a consistent
// snapshot even mid-write; a plain file copy of a WAL-mode database can come out without its newest tables).
//
//   docker exec nightlight node src/scripts/backup-db.js
//   -> Backup written to /app/data/private/backup-20261026-101500.db
//
// #553 phase 2a: this replaces the `node -e` one-liner docs/operations.md used to give. That one hard-coded
// /app/data/babymonitor.db, which no longer exists once the start-up move has put the database in private/, and wrote
// its copy to the TOP of the data directory, which a later phase opens to the media group. This one:
//   - reads the database where the app does (scripts/consoleDb.js): private/ or, before the move, the top level;
//   - writes the copy INTO private/ (0700), as backup-<date>-<time>.db in the container's timezone, mode 0600, and
//     gives it the owner of private/ (PUID:PGID) when it can, since `docker exec` runs as root;
//   - never creates private/ (a root-owned private/ made by `docker exec` would lock the app out of it): before the
//     first start of this version there is none, and it says so;
//   - opens the database read-only and never creates one.
// Copy the file out of the data directory as root (or as PUID) afterwards; it is a single self-contained file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirFrom, privateDirOf, SECRET_FILE_MODE, timestampForName } from '../lib/dataPaths.js';
import { openConsoleDatabase } from './consoleDb.js';

/** A path in `dir` that does not exist yet: backup-<stamp>.db, then backup-<stamp>-2.db and so on. */
export function freeBackupPath(dir, stamp, exists = fs.existsSync) {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `backup-${stamp}${n === 1 ? '' : `-${n}`}.db`);
    if (!exists(p)) return p;
  }
}

export async function backupDatabase({ env = process.env, now = () => new Date(), log = console.log } = {}) {
  const dataDir = dataDirFrom(env);
  const priv = privateDirOf(dataDir);
  let privStat;
  try {
    privStat = fs.statSync(priv);
  } catch {
    privStat = null;
  }
  if (!privStat || !privStat.isDirectory()) {
    throw new Error(
      `${priv} does not exist yet. Start the container once with this version (its start-up creates it), then run ` +
        'this again. Nothing was written.'
    );
  }
  // umask 077 first: `docker exec` does not go through the start-up script, so this process has Docker's 022, and the
  // copy would otherwise be created world-readable for the moment before the chmod below.
  process.umask(0o077);
  const db = openConsoleDatabase({ readonly: true, env });
  const dest = freeBackupPath(priv, timestampForName(now()));
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }
  fs.chmodSync(dest, SECRET_FILE_MODE);
  // Root (docker exec) owns the new file; hand it to whoever owns private/ (PUID:PGID), so it reads like everything
  // else in there. Best effort: without CAP_CHOWN, or when not root, it stays as it is, which is still 0600.
  try {
    fs.chownSync(dest, privStat.uid, privStat.gid);
  } catch { /* stays owned by whoever ran this; still 0600 inside a 0700 folder */ }
  log(`Backup written to ${dest}`);
  return dest;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  backupDatabase().then(
    () => process.exit(0),
    (err) => {
      console.error(`Backup failed: ${err.message}`);
      process.exit(1);
    }
  );
}
