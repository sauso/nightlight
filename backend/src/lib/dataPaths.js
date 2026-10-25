// #553 phase 2a: ONE owner for every path under the data directory that holds a secret.
//
// WHY A PRIVATE FOLDER. The database (every camera password, MFA secret, session and provider token, in
// plaintext by design), .jwt_secret, the Firebase files and the snapshot folders now live in DATA_DIR/private/,
// a folder that is always 0700 and owned by the app. A later phase opens DATA_DIR itself to the media group
// (so a separate media user can write clips); anything protected only by its OWN mode is then one wrong chmod,
// one restore as root or one UMASK=022 away from being readable by a compromised ffmpeg. A 0700 folder protects
// even a wrongly permissive file inside it (three plan reviewers agreed, #553 decision 2-A).
//
// WHO MOVES WHAT. Nothing in the app moves anything. The move is src/scripts/migrate-private-layout.js, which the
// image's start-up script runs in the foreground, as the app user, before the app starts (so nothing else can have
// the database open). Every consumer here only RESOLVES, by existence:
//   - the database: private/babymonitor.db if it exists, else babymonitor.db at the top if THAT exists (an install
//     the move has not reached yet: never create a second, empty database next to real data), else private/ (a
//     fresh install);
//   - a secret file (.jwt_secret): private/ first, then the top level, else private/ for a new one;
//   - a file the admin drops in (the two Firebase files): private/ first, then the top level, where the docs tell
//     people to drop them (the next start moves them in);
//   - a snapshot folder: it belongs to its database, so the database's place first, then the other place, else the
//     database's place.
// So a start without the start-up script (development, the test suite, a `docker exec` before the app is up) can
// never lose data or hide it behind an empty copy.
//
// ⚠️ PURE: importing this module does nothing, and every resolve* function only stats (lstat) and reads a folder
// listing. Creation is done by the writers (db.js, middleware/auth.js, the move tool), through ensurePrivateDir
// below, so the 0700 rule is written once.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_DATA_DIR = '/app/data';
export const PRIVATE_DIR_NAME = 'private';
// Owner only, set with an explicit chmod every time: the umask must not decide it (UMASK=022 is a supported opt-out,
// and a folder made under it would be 0755).
export const PRIVATE_DIR_MODE = 0o700;
// The secret files the move tool puts into private/ are chmod-ed to this, whatever they were (a Firebase file copied
// in by hand is often 0644).
export const SECRET_FILE_MODE = 0o600;

export const DB_FILE = 'babymonitor.db';
// SQLite's companions of the database file. -journal only exists for a database in rollback mode (or mid-crash);
// the app runs in WAL mode, so normally only -wal and -shm appear, and only while it is open.
export const DB_SIDECARS = ['babymonitor.db-wal', 'babymonitor.db-shm', 'babymonitor.db-journal'];
export const JWT_SECRET_FILE = '.jwt_secret';
export const FIREBASE_CREDENTIALS_FILE = 'firebase-service-account.json';
export const FIREBASE_CLIENT_CONFIG_FILE = 'google-services.json';
export const DETECTION_SNAPSHOTS_DIR = 'detection-snapshots';
export const TRANSITION_SNAPSHOTS_DIR = 'transition-snapshots';
export const SNAPSHOT_DIRS = [DETECTION_SNAPSHOTS_DIR, TRANSITION_SNAPSHOTS_DIR];
// What the move tool sets aside instead of overwriting (private/legacy-<date>-<time>/): see migrate-private-layout.js.
export const QUARANTINE_PREFIX = 'legacy-';
// Online backups, the documented command's names (backup-<date>-<time>.db). The old command wrote them to the top
// level; src/scripts/backup-db.js writes them into private/.
export const BACKUP_FILE_RE = /^backup-.+\.db$/;

export function dataDirFrom(env = process.env) {
  return env.DATA_DIR || DEFAULT_DATA_DIR;
}

export function privateDirOf(dataDir) {
  return path.join(dataDir, PRIVATE_DIR_NAME);
}

// lstat, not stat: a symbolic link counts as present even when what it points to is missing. Resolution must
// never treat "something is there" as "nothing is there" (that is how an empty database gets created next to a
// real one). An entry that cannot be looked at (no search permission on its folder) reads as absent: that is the
// best a process without the permission can do, and the paths it then picks fail to open rather than shadow data.
export function present(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 'private' or 'legacy': where the database is, by the rule in the header. */
export function resolveLayout(dataDir) {
  if (present(path.join(privateDirOf(dataDir), DB_FILE))) return 'private';
  if (present(path.join(dataDir, DB_FILE))) return 'legacy';
  return 'private';
}

/** The database file the app opens. */
export function resolveDbPath(dataDir) {
  return resolveLayout(dataDir) === 'private'
    ? path.join(privateDirOf(dataDir), DB_FILE)
    : path.join(dataDir, DB_FILE);
}

/** A secret the app creates itself (.jwt_secret): private/ first, then the top level, else private/ for a new one. */
export function resolveSecretFile(name, dataDir) {
  const inPrivate = path.join(privateDirOf(dataDir), name);
  if (present(inPrivate)) return inPrivate;
  const atTop = path.join(dataDir, name);
  if (present(atTop)) return atTop;
  return inPrivate;
}

/**
 * A file the admin puts in by hand (the Firebase files): private/ first, else the top level, where the docs say to
 * drop it. Different from resolveSecretFile on purpose: the app never creates these, so "neither exists" must name
 * the place a person is told to look, and a file dropped there must work at once, before the next start moves it.
 */
export function resolveDropInFile(name, dataDir) {
  const inPrivate = path.join(privateDirOf(dataDir), name);
  if (present(inPrivate)) return inPrivate;
  return path.join(dataDir, name);
}

/**
 * A snapshot folder. Its JPEGs are named by row ids of the database, so it follows the DATABASE (never merged by
 * file name with another copy): the database's place if the folder is there, else the other place if it is there (a
 * move that did not happen yet), else the database's place for a new one.
 */
export function resolveSnapshotDir(name, dataDir) {
  const inPrivate = path.join(privateDirOf(dataDir), name);
  const atTop = path.join(dataDir, name);
  const [first, second] = resolveLayout(dataDir) === 'private' ? [inPrivate, atTop] : [atTop, inPrivate];
  if (present(first)) return first;
  // With a database in private/ AND one at the top level (two copies not set aside yet), the top-level pictures are
  // the OTHER database's: never fall back to them (review of PR #870, P1).
  if (first === inPrivate && present(path.join(dataDir, DB_FILE))) return first;
  if (present(second)) return second;
  return first;
}

/**
 * True when something needs the owner's decision: a copy the move tool set aside (any private/legacy-* entry, which
 * stays until the owner deletes it), or a database at the top level next to the one in private/ that has not been set
 * aside yet. Reported on About and in the diagnostics bundle (additive fields), next to the start-up log's warning.
 */
export function layoutConflict(dataDir) {
  const priv = privateDirOf(dataDir);
  if (present(path.join(priv, DB_FILE)) && present(path.join(dataDir, DB_FILE))) return true;
  try {
    return fs.readdirSync(priv).some((n) => n.startsWith(QUARANTINE_PREFIX));
  } catch {
    return false;
  }
}

/**
 * Create DATA_DIR/private if it is missing and make it 0700, by an explicit chmod (a mkdir mode is cut by the umask).
 * For the writers only (db.js on a fresh install, middleware/auth.js before it writes a new secret, the move tool).
 * A private/ that is a symbolic link is the owner's own arrangement (another disk, say): it is used, and what it points
 * to is made 0700 too (stat and chmod follow the link). Leaving the target's mode alone let an old 0644 database be
 * renamed into a 0755 folder under UMASK=022, where nothing tightens it (Codex review of PR #870). Throws when private/
 * is not a folder or cannot be made 0700 (a target owned by someone else): the caller decides how loudly to fail.
 */
export function ensurePrivateDir(dataDir, { fsImpl = fs } = {}) {
  const dir = privateDirOf(dataDir);
  let st = null;
  try {
    st = fsImpl.statSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // statSync follows a link: ENOENT is either nothing there, or a link that points nowhere.
    let link = null;
    try { link = fsImpl.lstatSync(dir); } catch { /* nothing there at all */ }
    if (link) throw new Error(`${dir} is a symbolic link to something that does not exist`);
  }
  if (st && !st.isDirectory()) throw new Error(`${dir} exists and is not a folder`);
  if (!st) {
    fsImpl.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    st = fsImpl.statSync(dir);
  }
  if ((st.mode & 0o777) !== PRIVATE_DIR_MODE) fsImpl.chmodSync(dir, PRIVATE_DIR_MODE);
  return dir;
}

// <date>-<time> in the container's own timezone (TZ), the shape the old documented backup command produced with
// `date +%Y%m%d-%H%M%S`, so old and new backups sort together. Used for backup and legacy-* folder names only.
export function timestampForName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
