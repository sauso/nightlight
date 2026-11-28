import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

// Two `children` columns are checked by this one three-boot test: `hold_alerts_until_asleep` (#919) and
// `show_sleep_score` (sleep score plan, phase 2, default 1 = the score is SHOWN). They share it ON PURPOSE: every extra
// `db.js?query` import is another copy of db.js, and the core coverage gate sums every copy, so a file of its own for
// the second column (three more copies) took the whole run from 95.85% to 94.53% against a 95% gate. On a fresh
// database an ALTER guard always runs, so a guard that re-ran on every boot (resetting a family's choice) or a wrong
// default would only show on a real upgrade, which is what the first boot below recreates.
// For the same reason the four `sessions` columns of #1237 (the TV's view-only session: kind, label, paired_by_session,
// paired_from) ride on the same three boots: an existing sign-in must come out of the upgrade an ORDINARY session
// ('user', nothing paired), and a TV row must not be turned back into one by a later boot.
const read = (db, column, id) => db.prepare(`SELECT ${column} FROM children WHERE id = ?`).get(id)[column];
const sessionRow = (db, id) => db.prepare('SELECT kind, label, paired_by_session, paired_from FROM sessions WHERE id = ?').get(id);

test('#919 existing children gain an off hold flag and later boots retain changes; show_sleep_score gains an ON flag; #1237 existing sessions stay ordinary', async () => {
  const { default: oldDb } = await import('../src/db.js');
  try {
    // An install that last ran before both columns: today's schema with them taken away again.
    oldDb.exec('ALTER TABLE children DROP COLUMN hold_alerts_until_asleep');
    oldDb.exec('ALTER TABLE children DROP COLUMN show_sleep_score');
    oldDb.prepare("INSERT INTO children (id, name) VALUES ('migration-child', 'A child')").run();
    const columns = oldDb.prepare('PRAGMA table_info(children)').all().map((c) => c.name);
    assert.equal(columns.includes('show_sleep_score'), false, 'precondition: the column is gone, as on an older install');
    // #1237: and before the four sessions columns, with a sign-in that existed then.
    for (const col of ['paired_from', 'paired_by_session', 'label', 'kind']) oldDb.exec(`ALTER TABLE sessions DROP COLUMN ${col}`);
    oldDb.prepare("INSERT INTO users (id, username, password_hash) VALUES ('migration-user', 'someone', 'x')").run();
    oldDb.prepare("INSERT INTO sessions (id, user_id, user_agent) VALUES ('migration-session', 'migration-user', 'test')").run();
    const sessionColumns = oldDb.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    assert.equal(sessionColumns.includes('kind'), false, 'precondition: sessions has no kind, as on an older install');
  } finally { oldDb.close(); }
  const { default: upgraded } = await import('../src/db.js?hold-migration-upgrade');
  try {
    assert.equal(read(upgraded, 'hold_alerts_until_asleep', 'migration-child'), 0);
    // The score is shown for a child that existed before the column, and for one added after it.
    assert.equal(read(upgraded, 'show_sleep_score', 'migration-child'), 1);
    upgraded.prepare("INSERT INTO children (id, name) VALUES ('new-child', 'Another child')").run();
    assert.equal(read(upgraded, 'show_sleep_score', 'new-child'), 1);
    upgraded.prepare('UPDATE children SET hold_alerts_until_asleep = 1, show_sleep_score = 0 WHERE id = ?').run('migration-child');
    // #1237: the old sign-in is an ordinary session with nothing paired; a session made now defaults the same way.
    assert.deepEqual({ ...sessionRow(upgraded, 'migration-session') }, { kind: 'user', label: null, paired_by_session: null, paired_from: null });
    upgraded.prepare("INSERT INTO sessions (id, user_id) VALUES ('new-session', 'migration-user')").run();
    assert.equal(sessionRow(upgraded, 'new-session').kind, 'user');
    upgraded.prepare("UPDATE sessions SET kind = 'tv', label = 'A TV', paired_by_session = 'new-session' WHERE id = 'migration-session'").run();
  } finally { upgraded.close(); }
  const { default: rebooted } = await import('../src/db.js?hold-migration-reboot');
  try {
    assert.equal(read(rebooted, 'hold_alerts_until_asleep', 'migration-child'), 1);
    // An off choice survives the next boot; the other child is untouched.
    assert.equal(read(rebooted, 'show_sleep_score', 'migration-child'), 0);
    assert.equal(read(rebooted, 'show_sleep_score', 'new-child'), 1);
    // #1237: a later boot leaves a TV row a TV (the guard does not run again).
    assert.deepEqual({ ...sessionRow(rebooted, 'migration-session') }, { kind: 'tv', label: 'A TV', paired_by_session: 'new-session', paired_from: null });
  } finally { rebooted.close(); cleanupTempDataDirs(); }
});
