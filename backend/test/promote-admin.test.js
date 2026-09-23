// backend/src/scripts/promote-admin.js — the console failsafe for issue #441: recovery for an
// install that has ALREADY lost its last admin. There is no reset-mfa test file to model this on
// (grepped for one, per the plan, and found none), so this tests the exported core functions
// directly against a real (throwaway) database rather than shelling out to the CLI - the CLI wrapper
// itself is a thin argv/console/process.exit shim around them and is exercised by hand per the
// runbook, the same way reset-mfa.js's CLI is.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { listUsers, promoteToAdmin, parseArgs } = await import('../src/scripts/promote-admin.js');

after(() => { db.close(); cleanupTempDataDirs(); });

beforeEach(() => {
  db.prepare('DELETE FROM users').run();
});

describe('parseArgs — CLI argument parsing, kept separate from process.argv/console/process.exit so it is a pure function a test can call directly', () => {
  // #441 review: the CLI used to check `--help`/`-h` BEFORE ever treating the argument as a
  // username, but the account routes allow those exact strings as usernames (`isValidUsername`
  // in routes/auth.js has no such exclusion). An install whose admin account happened to be named
  // "-h" could never be promoted or recovered by this script. `--` is the POSIX end-of-options
  // marker: once seen, everything after it is a literal positional argument, never re-interpreted
  // as a flag - so `parseArgs(['--', '-h'])` promotes the user "-h" instead of printing help.
  test('no arguments → list', () => {
    assert.deepEqual(parseArgs([]), { mode: 'list' });
  });

  test('--help → help', () => {
    assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
  });

  test('-h → help', () => {
    assert.deepEqual(parseArgs(['-h']), { mode: 'help' });
  });

  test('a plain username → promote', () => {
    assert.deepEqual(parseArgs(['alice']), { mode: 'promote', username: 'alice' });
  });

  test('★ -- <username> promotes an account literally named like a flag (e.g. "-h")', () => {
    assert.deepEqual(parseArgs(['--', '-h']), { mode: 'promote', username: '-h' });
  });
});

describe('listUsers', () => {
  test('lists every account with its role', () => {
    // Not asserted in a specific order: `created_at` has only second resolution (SQLite's
    // `datetime('now')`), so two inserts in the same test can tie, and this test should not depend on
    // how ties happen to break.
    makeUser(db, { id: 'u-1', username: 'alice', role: 'admin' });
    makeUser(db, { id: 'u-2', username: 'bob', role: 'caregiver' });
    const rows = listUsers(db).sort((a, b) => a.username.localeCompare(b.username));
    assert.deepEqual(rows, [
      { username: 'alice', role: 'admin' },
      { username: 'bob', role: 'caregiver' },
    ]);
  });

  test('an empty install lists nothing, without throwing', () => {
    assert.deepEqual(listUsers(db), []);
  });
});

describe('promoteToAdmin — the #441 recovery path', () => {
  test('★ a stranded caregiver becomes an admin', () => {
    makeUser(db, { id: 'u-care', username: 'carol', role: 'caregiver' });
    const result = promoteToAdmin(db, 'carol');
    assert.deepEqual(result, { id: 'u-care', username: 'carol', wasAdmin: false });
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('u-care').role, 'admin',
      'promoteToAdmin ran without error but did not actually write the new role');
  });

  test('an unknown username changes nothing and is reported back as not found', () => {
    makeUser(db, { id: 'u-care', username: 'carol', role: 'caregiver' });
    const result = promoteToAdmin(db, 'nobody-here');
    assert.equal(result, null, 'a non-existent username was silently treated as a match');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c, 0,
      'some account was promoted despite the requested username not existing');
  });

  test('promoting an account that is already an admin is a no-op that says so', () => {
    makeUser(db, { id: 'u-admin', username: 'alice', role: 'admin' });
    const result = promoteToAdmin(db, 'alice');
    assert.deepEqual(result, { id: 'u-admin', username: 'alice', wasAdmin: true },
      'an already-admin account was not reported as such — the operator would be told a change happened when none did');
  });

  test('★★ it never picks an account on its own — an empty/undefined username matches nobody', () => {
    // The whole point of #441's recovery script is that an operator names the ONE account they are
    // choosing to trust with admin. A falsy username silently matching an arbitrary row (e.g. via a
    // WHERE clause that treats undefined as "no filter") would turn this into exactly the
    // privilege-escalation risk the design note warns against.
    makeUser(db, { id: 'u-1', username: 'alice', role: 'caregiver' });
    makeUser(db, { id: 'u-2', username: 'bob', role: 'caregiver' });
    for (const bad of [undefined, null, '']) {
      assert.equal(promoteToAdmin(db, bad), null, `${JSON.stringify(bad)} matched an account`);
    }
    assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin'").get().c, 0);
  });

  test('only the named account changes — an unrelated caregiver is left alone', () => {
    makeUser(db, { id: 'u-1', username: 'alice', role: 'caregiver' });
    makeUser(db, { id: 'u-2', username: 'bob', role: 'caregiver' });
    promoteToAdmin(db, 'alice');
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('u-2').role, 'caregiver',
      'promoting one account changed a different one');
  });
});
