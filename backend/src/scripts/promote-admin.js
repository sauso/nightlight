// Console failsafe for issue #441: recovery for an install that has ALREADY lost its last admin (the
// sole admin demoted themselves before this fix shipped, or the database was edited by hand). Once
// that happens nothing in the app can fix it - /setup refuses to run again once a user exists, and
// every repair route needs an admin to reach it - so this, like reset-mfa.js, talks to the database
// directly instead of going through the API. Modelled on reset-mfa.js: same arg handling, listing and
// output style, same "run it against the live container" invocation.
//
//   docker exec nightlight node src/scripts/promote-admin.js               # list accounts + roles
//   docker exec nightlight node src/scripts/promote-admin.js <username>    # make that account admin
//   docker exec nightlight node src/scripts/promote-admin.js -- <username> # same, when <username>
//                                                                           #  itself starts with "-"
//
// See README.md's "Adding caregivers" section and docs/mfa.md's Recovery section, where this is
// documented alongside the reset-mfa recovery path.
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR || '/app/data';

// --- core logic, exported so a test can exercise it directly against a throwaway database without
// going through argv/console/process.exit (there is no reset-mfa test file to model this on; grepped
// for one and found none). -----------------------------------------------------------------------

/** Every account and its role, for the no-argument listing. */
export function listUsers(db) {
  return db.prepare('SELECT username, role FROM users ORDER BY created_at').all();
}

// Deliberately never picks an account on its own - no `--all`, no "promote whoever was created
// first" default. An unattended script that promoted an arbitrary caregiver to admin would itself be
// a privilege-escalation path: anyone who could get a caregiver account created (a caregiver added by
// mistake, or one that later turns hostile) would only have to wait for this to run. A human operator
// must name the specific account they are choosing to trust with admin.
/**
 * Set one account's role to 'admin'. Returns { id, username, wasAdmin }, or null if no account has
 * that username. `wasAdmin` lets the caller report "already an admin" instead of implying a change
 * that did not happen - the same distinction reset-mfa.js makes for a user who already had MFA off.
 */
export function promoteToAdmin(db, username) {
  const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(username);
  if (!user) return null;
  const wasAdmin = user.role === 'admin';
  if (!wasAdmin) db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  return { id: user.id, username: user.username, wasAdmin };
}

// --- CLI, only when run directly (so importing the functions above for a test does not also open
// the live database file or touch process.exit). -------------------------------------------------

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

// #441 review: this used to check `--help`/`-h` unconditionally before ever treating the argument
// as a username, but the account routes allow those exact strings AS usernames (there is no
// reserved-word exclusion) - so an install whose intended admin was literally named "-h" could
// never be promoted or recovered by this script. `--` is the POSIX end-of-options marker: once
// seen, everything after it is a positional argument, never re-interpreted as a flag, so
// `promote-admin.js -- -h` promotes the user "-h" instead of printing help. Kept as its own pure
// function (no argv/console/process.exit) so the parsing itself is directly testable.
/**
 * @param {string[]} argv - just the arguments, i.e. `process.argv.slice(2)`
 * @returns {{mode: 'help'|'list'|'promote', username?: string}}
 */
export function parseArgs(argv) {
  const [first, second] = argv;
  if (first === '--') return { mode: 'promote', username: second };
  if (first === '--help' || first === '-h') return { mode: 'help' };
  if (first === undefined) return { mode: 'list' };
  return { mode: 'promote', username: first };
}

if (isMainModule()) {
  const db = new Database(path.join(DATA_DIR, 'babymonitor.db'));
  db.pragma('busy_timeout = 5000');

  const { mode, username } = parseArgs(process.argv.slice(2));

  if (mode === 'help') {
    console.log('Usage:');
    console.log('  promote-admin.js                  List every account and its role');
    console.log('  promote-admin.js <username>       Make that account an admin');
    console.log('  promote-admin.js -- <username>    Same, for a username that starts with "-" (e.g. "-h")');
    process.exit(0);
  }

  if (mode === 'list') {
    const rows = listUsers(db);
    if (rows.length === 0) {
      console.log('No accounts exist yet - run first-run setup instead.');
    } else {
      console.log('Accounts:');
      rows.forEach((r) => console.log(`  - ${r.username} (${r.role})`));
    }
    process.exit(0);
  }

  const result = promoteToAdmin(db, username);
  if (!result) {
    console.error(`No user named "${username}". Run with no argument to see accounts.`);
    process.exit(1);
  }
  console.log(
    result.wasAdmin
      ? `"${username}" is already an admin; nothing to change.`
      : `"${username}" is now an admin.`
  );
  process.exit(0);
}
