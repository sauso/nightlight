// Console failsafe for two-factor lockout — the last-resort way back in when an admin loses their
// authenticator AND backup codes, so no one can clear it from the UI. Run it against the live
// container; it opens the same SQLite DB (WAL mode allows the concurrent write) and clears the MFA
// fields for a user, so their next login is password-only again.
//
//   docker exec nightlight node src/scripts/reset-mfa.js --list           # who has MFA on
//   docker exec nightlight node src/scripts/reset-mfa.js <username>       # clear one user
//   docker exec nightlight node src/scripts/reset-mfa.js --all            # clear everyone
//
// (Staging container name is nightlight-dev.) See docs/mfa.md.
import Database from 'better-sqlite3';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const db = new Database(path.join(DATA_DIR, 'babymonitor.db'));
db.pragma('busy_timeout = 5000');

const arg = process.argv[2];

// Two fully-literal statements rather than one with an interpolated WHERE clause — the query text is
// static, and the only variable (a user id) is bound as a parameter. (The clause was always a
// hardcoded literal, never user input, but keeping the SQL constant leaves no room for doubt.)
const clearAllStmt = db.prepare(
  'UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE mfa_enabled = 1'
);
const clearOneStmt = db.prepare(
  'UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?'
);

if (!arg || arg === '--help' || arg === '-h') {
  console.log('Usage:');
  console.log('  reset-mfa.js --list          List users with two-factor enabled');
  console.log('  reset-mfa.js <username>      Turn off two-factor for that user');
  console.log('  reset-mfa.js --all           Turn off two-factor for every user');
  process.exit(arg ? 0 : 1);
}

if (arg === '--list') {
  const rows = db.prepare('SELECT username, role, mfa_enabled FROM users ORDER BY created_at').all();
  const on = rows.filter((r) => r.mfa_enabled);
  if (on.length === 0) {
    console.log('No users have two-factor enabled.');
  } else {
    console.log('Two-factor enabled for:');
    on.forEach((r) => console.log(`  - ${r.username} (${r.role})`));
  }
  process.exit(0);
}

if (arg === '--all') {
  const n = clearAllStmt.run().changes;
  console.log(`Cleared two-factor for ${n} user(s).`);
  process.exit(0);
}

// Otherwise treat the argument as a username.
const user = db.prepare('SELECT id, username, mfa_enabled FROM users WHERE username = ?').get(arg);
if (!user) {
  console.error(`No user named "${arg}". Use --list to see accounts.`);
  process.exit(1);
}
clearOneStmt.run(user.id);
console.log(
  user.mfa_enabled
    ? `Two-factor turned off for "${arg}". They can sign in with just their password now.`
    : `"${arg}" didn't have two-factor on; nothing to change (any half-finished setup was cleared).`
);
process.exit(0);
