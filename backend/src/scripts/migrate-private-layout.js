// #553 phase 2a: moves the database and the app's secrets into DATA_DIR/private/ (0700), once, on an existing install.
//
//   node src/scripts/migrate-private-layout.js      # what backend/entrypoint.sh runs, as the app user, every start
//
// WHO RUNS IT, AND WHEN. Only the image's start-up script, in the FOREGROUND, as the app user (su-exec), after the
// ownership checks and BEFORE the app starts. Nothing else has the database open then (the old container is gone),
// and the app itself never moves anything: it only resolves (src/lib/dataPaths.js). It is never run in the
// background with a deadline (plan review, Opus: a start-up that stopped waiting could start the app while this was
// between its checks and the rename, and the rename would move a database the app has open).
//
// WHAT IT DOES. A list of independent passes, run on EVERY start, each deciding for itself from lstat and existence,
// so a crash half-way, a file dropped in later or a failure on one item is finished or retried by the next start
// (plan review C3). In order:
//   1. the database (babymonitor.db at the top level): see moveDatabase, the only pass with a point of no return;
//   2. .jwt_secret (only when JWT_SECRET is not set: the app does not read the file then);
//   3. the two Firebase files (each only when its FIREBASE_* variable is unset: a file the environment names stays
//      where it is named, or push would turn off);
//   4. the two snapshot folders (only once the database is in private/: their JPEGs are named by its row ids, so they
//      go WITH it, never ahead of it, and are never merged with another copy by file name);
//   5. leftovers: online backups (backup-*.db) and SQLite companion files whose database is not there any more.
//
// THE RULES (from the plan reviews, each one a way this could lose data or leave the boundary open):
//   - lstat first. A symbolic link is never moved (a relative link would dangle one level deeper, and better-sqlite3
//     would then create a NEW database through it: /setup would appear). It is left where it is, and said.
//   - private/ ALWAYS wins. When both places have an item, the one in private/ is used and stays; the top-level copy
//     (with its companions) is moved, never deleted and never merged, into private/legacy-<date>-<time>/. No scoring:
//     a transient read error must never demote months of data to a stale copy (C6). The owner decides what to keep
//     (docs/operations.md, "Two copies of the database").
//   - Nothing is ever deleted, except an EMPTY folder that would otherwise block a move (C4).
//   - The database moves by ONE rename of the .db file ALONE, after proving nothing else has it open (C2).
//
// EXIT CODES (backend/entrypoint.sh prints one `[entrypoint] ... private layout:` line from them, and never stops the
// container over any of them):
//   0   everything that should be in private/ is there (or there was nothing to move);
//   10  something was LEFT at the top level this start (the database could not be proven unused, a rename failed, a
//       symbolic link, the time limit): the app runs on whatever resolves, and the next start tries again;
//   11  nothing was left, but a top-level copy was SET ASIDE in private/legacy-*/ because private/ already had one;
//   1   the tool itself failed (a bug): the entrypoint warns and starts the app on whatever resolves.
// A phase that opens DATA_DIR to the media group (2b) must refuse to while anything is still at the top level: exit 10
// must not become a permanent silent gap (C11).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { logger } from '../lib/logger.js';
import {
  BACKUP_FILE_RE,
  DB_FILE,
  DB_SIDECARS,
  FIREBASE_CLIENT_CONFIG_FILE,
  FIREBASE_CREDENTIALS_FILE,
  JWT_SECRET_FILE,
  QUARANTINE_PREFIX,
  SECRET_FILE_MODE,
  SNAPSHOT_DIRS,
  dataDirFrom,
  ensurePrivateDir,
  present,
  privateDirOf,
  resolveLayout,
  timestampForName,
} from '../lib/dataPaths.js';

export const EXIT = Object.freeze({ DONE: 0, LEFT: 10, SET_ASIDE: 11, FAILED: 1 });

// The time limit for the database pass, BEFORE its point of no return (the rename) only. Thirty seconds is far more
// than the checks take on a healthy disk (they open, convert and close one file: well under a second on the CI runner
// and on the owner's Unraid cache pool); it exists so a database on a stalled network share is left where it is and
// the app starts on it, instead of the start-up waiting on the move. After the rename there is no limit and no abort,
// only the independent passes. A blocking filesystem call that never returns hangs this exactly as it would hang the
// app on the same mount: that is accepted and documented, not a new failure (plan review C1).
export const DB_PASS_BUDGET_MS = 30_000;
// SQLite's busy wait for the journal-mode change. Another connection makes it fail, and waiting longer would not help:
// nothing should have the file open at all.
const BUSY_TIMEOUT_MS = 2_000;

const TAG = '[private-layout]';

function lstatOrNull(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isEmptyDir(p) {
  try {
    return fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/**
 * Run every pass once. Returns { code, left, setAside, moved } (the lists name what happened, for the log and tests).
 * Options are seams for the tests: `rename` (to make a rename fail as EXDEV would on a separate mount), `now` (a clock,
 * to run out the time budget), `stamp` (the legacy-* folder's name), `log`.
 */
export function migratePrivateLayout({
  dataDir = dataDirFrom(),
  env = process.env,
  budgetMs = DB_PASS_BUDGET_MS,
  now = Date.now,
  stamp = () => timestampForName(new Date()),
  rename = fs.renameSync,
  log = { info: (m) => logger.info(`${TAG} ${m}`), warn: (m) => logger.warn(`${TAG} ${m}`) },
} = {}) {
  const priv = privateDirOf(dataDir);
  const ctx = { dataDir, priv, env, log, rename, stamp, left: [], setAside: [], moved: [], quarantineDir: null };

  if (!fs.existsSync(dataDir)) return finish(ctx);
  try {
    ensurePrivateDir(dataDir);
  } catch (err) {
    // A file called "private", or a folder the app user cannot write: nothing can move. The app still starts, on the
    // top-level files where they are.
    for (const name of [DB_FILE, JWT_SECRET_FILE, FIREBASE_CREDENTIALS_FILE, FIREBASE_CLIENT_CONFIG_FILE]) {
      if (present(path.join(dataDir, name))) ctx.left.push(name);
    }
    log.warn(`cannot use ${priv} (${err.message}); everything stays where it is this start`);
    return finish(ctx);
  }

  const start = now();
  const overBudget = () => now() - start > budgetMs;
  pass(ctx, 'the database', () => moveDatabase(ctx, overBudget));
  pass(ctx, JWT_SECRET_FILE, () => {
    if (env.JWT_SECRET) {
      if (present(path.join(dataDir, JWT_SECRET_FILE))) {
        log.info(`${JWT_SECRET_FILE} at the top level is not used (JWT_SECRET is set), so it was left where it is`);
      }
      return;
    }
    moveFile(ctx, JWT_SECRET_FILE);
  });
  for (const [name, variable] of [
    [FIREBASE_CREDENTIALS_FILE, 'FIREBASE_CREDENTIALS'],
    [FIREBASE_CLIENT_CONFIG_FILE, 'FIREBASE_CLIENT_CONFIG'],
  ]) {
    pass(ctx, name, () => {
      // Plan review C7: the variable names the file push reads; moving the default one (or the named one) is not ours.
      if (env[variable]) return;
      moveFile(ctx, name);
    });
  }
  pass(ctx, 'the snapshot folders', () => moveSnapshotDirs(ctx));
  pass(ctx, 'the leftovers', () => moveLeftovers(ctx));
  return finish(ctx);
}

// One pass, never allowed to stop the others: an unexpected error is logged and counts as "left".
function pass(ctx, what, fn) {
  try {
    fn();
  } catch (err) {
    ctx.left.push(what);
    ctx.log.warn(`could not finish with ${what} (${err.message}); left where it is this start`);
  }
}

function finish(ctx) {
  const code = ctx.left.length ? EXIT.LEFT : ctx.setAside.length ? EXIT.SET_ASIDE : EXIT.DONE;
  return { code, left: ctx.left, setAside: ctx.setAside, moved: ctx.moved };
}

function rel(ctx, p) {
  return path.relative(ctx.dataDir, p).split(path.sep).join('/');
}

// private/legacy-<date>-<time>/, made the first time something has to be set aside in this run, 0700 like private/.
function quarantineDir(ctx) {
  if (ctx.quarantineDir) return ctx.quarantineDir;
  const base = `${QUARANTINE_PREFIX}${ctx.stamp()}`;
  for (let n = 1; ; n++) {
    const dir = path.join(ctx.priv, n === 1 ? base : `${base}-${n}`);
    if (present(dir)) continue;
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    ctx.quarantineDir = dir;
    return dir;
  }
}

// Move a top-level entry into this run's legacy-* folder, under its own name. Never overwrites (the folder is new).
function setAside(ctx, src, why) {
  const dest = path.join(quarantineDir(ctx), path.basename(src));
  try {
    ctx.rename(src, dest);
  } catch (err) {
    ctx.left.push(path.basename(src));
    ctx.log.warn(`${rel(ctx, src)} could not be set aside (${err.code || err.message}); left where it is`);
    return false;
  }
  ctx.setAside.push(path.basename(src));
  ctx.log.warn(`${rel(ctx, src)} was set aside as ${rel(ctx, dest)}: ${why}. Nothing was deleted.`);
  return true;
}

// lstat a top-level entry; a symbolic link, or the wrong kind of entry, is left where it is and said.
function topLevelEntry(ctx, name, kind) {
  const src = path.join(ctx.dataDir, name);
  const st = lstatOrNull(src);
  if (!st) return null;
  if (st.isSymbolicLink()) {
    ctx.left.push(name);
    ctx.log.warn(`${name} is a symbolic link, so it was not moved (moving a link can break it); it stays at the top level`);
    return null;
  }
  if (kind === 'file' ? !st.isFile() : !st.isDirectory()) {
    ctx.left.push(name);
    ctx.log.warn(`${name} is not a ${kind === 'file' ? 'regular file' : 'folder'}, so it was not moved`);
    return null;
  }
  return src;
}

// ── 1. The database ─────────────────────────────────────────────────────────────────────────────────────────────
// The trio problem: a WAL-mode database is up to three files, and committed rows can live ONLY in -wal. Moving them
// one by one can split them (a .db without its -wal hides committed rows; SQLite would also rebuild an empty -wal).
// So the .db is never moved with companions: it is first PROVEN to be the only connection and turned into a single
// self-contained file, then moved by ONE rename (C2):
//   - open with fileMustExist (never create a database here), which also recovers a WAL left by a crash;
//   - PRAGMA journal_mode=DELETE: merges the WAL into the file and removes -wal and -shm, and it FAILS ("database is
//     locked" after the busy wait; SQLite documents that a refused change can instead return the old mode, hence the
//     check on the result too) while another connection has the database open and has read from it, as every app
//     connection does from its first query. Measured, in this process and from another process, on Linux and Windows:
//     migrate-private-layout.test.js, "another connection has it open" and "ANOTHER PROCESS". (A connection that has
//     opened the file and read nothing yet holds no lock and does not stop it; nothing is in that state at start-up.)
//     A WAL checkpoint is not enough: with another reader open it leaves a 0-byte -wal that a size check cannot tell
//     from a clean one (Opus review);
//   - close, then require that NONE of -wal, -shm, -journal exists. Anything still there means another process, or a
//     companion this connection did not own: nothing is moved;
//   - rename the .db alone. The app opens it and switches it back to WAL itself (db.js).
// The quick_check afterwards is LOGGED only: it never gates the move, and the file has already moved by then.
function moveDatabase(ctx, overBudget) {
  const { dataDir, priv, log } = ctx;
  const privDb = path.join(priv, DB_FILE);
  const src = topLevelEntry(ctx, DB_FILE, 'file');
  if (!src) return;
  if (present(privDb)) {
    // Both exist: private/ wins. The top-level copy goes aside WITH its companions, so a hot WAL stays next to its
    // database (moved one by one; a crash between two of these renames can leave the -wal in a second legacy-*
    // folder, which the docs say how to put back together; nothing is lost either way).
    log.warn(`${DB_FILE} exists both in private/ and at the top level; the one in private/ is the one used`);
    for (const name of DB_SIDECARS) {
      const s = path.join(dataDir, name);
      const st = lstatOrNull(s);
      if (st && !st.isSymbolicLink()) setAside(ctx, s, 'it belongs to the top-level copy of the database');
    }
    setAside(ctx, src, 'private/ already has a database, and the copy in private/ always wins');
    return;
  }
  const skip = (why) => {
    ctx.left.push(DB_FILE);
    log.warn(`${DB_FILE} stays at the top level this start: ${why}. The app uses it there; the next start tries again.`);
  };
  if (overBudget()) return skip('the time limit for the move ran out before it started');
  let conn = null;
  let mode;
  try {
    conn = new Database(src, { fileMustExist: true, timeout: BUSY_TIMEOUT_MS });
    if (overBudget()) return skip('the time limit for the move ran out while opening it');
    mode = String(conn.pragma('journal_mode = DELETE', { simple: true })).toLowerCase();
  } catch (err) {
    return skip(`it could not be prepared for the move (${err.message})`);
  } finally {
    try { conn?.close(); } catch { /* a close that fails leaves a companion file, caught just below */ }
  }
  if (mode !== 'delete') return skip(`another process seems to have it open (its journal mode stayed "${mode}")`);
  const leftover = DB_SIDECARS.filter((name) => present(path.join(dataDir, name)));
  if (leftover.length) return skip(`${leftover.join(', ')} still exists after closing it, so another process may have it open`);
  if (overBudget()) return skip('the time limit for the move ran out');
  if (present(privDb)) return skip('private/babymonitor.db appeared while it was being prepared');
  try {
    ctx.rename(src, privDb);
  } catch (err) {
    return skip(`it could not be moved into private/ (${err.code || err.message}), so nothing was moved`);
  }
  // ── point of no return: the database is in private/ ──
  ctx.moved.push(DB_FILE);
  log.info(`moved ${DB_FILE} into private/ (${rel(ctx, src)} -> ${rel(ctx, privDb)})`);
  let check = null;
  try {
    check = new Database(privDb, { fileMustExist: true, readonly: true });
    const result = check.pragma('quick_check', { simple: true });
    if (result === 'ok') log.info('quick_check of the moved database: ok');
    else log.warn(`quick_check of the moved database reports: ${result} (the move itself is complete)`);
  } catch (err) {
    log.warn(`quick_check of the moved database could not run (${err.message})`);
  } finally {
    try { check?.close(); } catch { /* read-only, nothing to lose */ }
  }
}

// ── 2, 3. A secret file ─────────────────────────────────────────────────────────────────────────────────────────
// private/ wins per item too: a top-level .jwt_secret next to a private one is set aside, never moved in over it
// (that would sign everyone out), and a NEW Firebase file dropped at the top of an install that already has one in
// private/ is set aside as well. The docs say to replace those files inside private/.
function moveFile(ctx, name) {
  const src = topLevelEntry(ctx, name, 'file');
  if (!src) return;
  const dest = path.join(ctx.priv, name);
  if (present(dest)) {
    setAside(ctx, src, `private/ already has a ${name}, and the one in private/ is the one used`);
    return;
  }
  try {
    ctx.rename(src, dest);
  } catch (err) {
    ctx.left.push(name);
    ctx.log.warn(`${name} could not be moved into private/ (${err.code || err.message}); it is still used from the top level`);
    return;
  }
  ctx.moved.push(name);
  ctx.log.info(`moved ${name} into private/`);
  // Owner only whatever it was: a Firebase file copied in by hand is often 0644.
  try {
    fs.chmodSync(dest, SECRET_FILE_MODE);
  } catch (err) {
    ctx.log.warn(`could not make private/${name} owner-only (${err.code || err.message}); private/ itself is`);
  }
}

// ── 4. The snapshot folders ─────────────────────────────────────────────────────────────────────────────────────
function moveSnapshotDirs(ctx) {
  // With the database still at the top level, its pictures stay with it: the app serves them from there.
  if (resolveLayout(ctx.dataDir) !== 'private') return;
  for (const name of SNAPSHOT_DIRS) {
    pass(ctx, name, () => moveSnapshotDir(ctx, name));
  }
}

function moveSnapshotDir(ctx, name) {
  const src = topLevelEntry(ctx, name, 'dir');
  if (!src) return;
  const dest = path.join(ctx.priv, name);
  let dst = lstatOrNull(dest);
  if (dst && (dst.isSymbolicLink() || !dst.isDirectory())) {
    ctx.left.push(name);
    ctx.log.warn(`private/${name} is a symbolic link or not a folder, so ${name} was not moved`);
    return;
  }
  // Plan review C4: the app makes its snapshot folder at start, so a start between a failed move and the next one can
  // leave an EMPTY private/ folder. It holds nothing, so it must not block the move for ever.
  if (dst && isEmptyDir(dest)) {
    fs.rmdirSync(dest);
    dst = null;
  }
  if (!dst) {
    try {
      ctx.rename(src, dest);
    } catch (err) {
      ctx.left.push(name);
      ctx.log.warn(`${name} could not be moved into private/ (${err.code || err.message}); its pictures are still served from the top level`);
      return;
    }
    ctx.moved.push(name);
    ctx.log.info(`moved ${name}/ into private/`);
    return;
  }
  // Both hold something. An empty top-level folder holds nothing to keep.
  if (isEmptyDir(src)) {
    fs.rmdirSync(src);
    return;
  }
  // The pictures are named by row ids of a database, and these two belong to different databases: set the top-level
  // one aside WHOLE, never merged by file name.
  setAside(ctx, src, `private/${name}/ already has pictures, which belong to the database in private/`);
}

// ── 5. Leftovers ────────────────────────────────────────────────────────────────────────────────────────────────
function moveLeftovers(ctx) {
  const { dataDir, priv } = ctx;
  let names;
  try {
    names = fs.readdirSync(dataDir);
  } catch (err) {
    throw new Error(`cannot list ${dataDir} (${err.code || err.message})`);
  }
  // Online backups: every one holds every secret in the database. The old documented command wrote them to the top
  // level; they belong in private/, next to the ones scripts/backup-db.js writes.
  for (const name of names.filter((n) => BACKUP_FILE_RE.test(n))) {
    pass(ctx, name, () => {
      const src = topLevelEntry(ctx, name, 'file');
      if (!src) return;
      const dest = path.join(priv, name);
      if (present(dest)) {
        setAside(ctx, src, `private/ already has a ${name}`);
        return;
      }
      ctx.rename(src, dest);
      ctx.moved.push(name);
      ctx.log.info(`moved ${name} into private/`);
      try { fs.chmodSync(dest, SECRET_FILE_MODE); } catch { /* still inside 0700 private/ */ }
    });
  }
  // A -wal, -shm or -journal with no database next to it (a database moved by hand without them, say). A -wal can hold
  // committed rows, so it is set aside, never deleted. With the database still there they are ITS companions and stay.
  if (!present(path.join(dataDir, DB_FILE))) {
    for (const name of DB_SIDECARS) {
      if (!names.includes(name)) continue;
      const src = topLevelEntry(ctx, name, 'file');
      if (src) setAside(ctx, src, `there is no ${DB_FILE} next to it`);
    }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  let code = EXIT.FAILED;
  try {
    code = migratePrivateLayout().code;
  } catch (err) {
    logger.error(`${TAG} failed: ${err.stack || err.message}`);
  }
  process.exit(code);
}
