// The database, for the console scripts (reset-mfa.js, promote-admin.js, backup-db.js), which run beside the app
// through `docker exec` and do not import db.js (that would run the schema migrations from a second process).
//
// #553 phase 2a: they RESOLVE the database the way db.js does (lib/dataPaths.js): private/babymonitor.db once the
// start-up move has run, the top-level one on an install it has not reached. They never move anything, and they
// never CREATE anything: `fileMustExist`, because they run as root through `docker exec`, and a root-owned empty
// database (or a root-owned private/ folder) left behind on an empty or unreadable volume would shadow the real one or
// lock the app out of its own folder. SQLite does not create folders, so a missing private/ is never made here either.
import Database from 'better-sqlite3';
import { dataDirFrom, resolveDbPath } from '../lib/dataPaths.js';

export function consoleDbPath(env = process.env) {
  return resolveDbPath(dataDirFrom(env));
}

/** Opens the resolved database, or prints why it cannot and exits 1. */
export function openConsoleDatabase({ readonly = false, env = process.env } = {}) {
  const file = consoleDbPath(env);
  try {
    return new Database(file, { fileMustExist: true, readonly });
  } catch (err) {
    console.error(
      `Cannot open the Nightlight database at ${file} (${err.message}). Is this the Nightlight container, and has it ` +
        'started at least once? Without DAC_OVERRIDE (the optional hardening) root cannot read the owner-only data ' +
        'directory either: see docs/operations.md.'
    );
    process.exit(1);
  }
}
