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
const read = (db, column, id) => db.prepare(`SELECT ${column} FROM children WHERE id = ?`).get(id)[column];

test('#919 existing children gain an off hold flag and later boots retain changes; show_sleep_score gains an ON flag', async () => {
  const { default: oldDb } = await import('../src/db.js');
  try {
    // An install that last ran before both columns: today's schema with them taken away again.
    oldDb.exec('ALTER TABLE children DROP COLUMN hold_alerts_until_asleep');
    oldDb.exec('ALTER TABLE children DROP COLUMN show_sleep_score');
    oldDb.prepare("INSERT INTO children (id, name) VALUES ('migration-child', 'A child')").run();
    const columns = oldDb.prepare('PRAGMA table_info(children)').all().map((c) => c.name);
    assert.equal(columns.includes('show_sleep_score'), false, 'precondition: the column is gone, as on an older install');
  } finally { oldDb.close(); }
  const { default: upgraded } = await import('../src/db.js?hold-migration-upgrade');
  try {
    assert.equal(read(upgraded, 'hold_alerts_until_asleep', 'migration-child'), 0);
    // The score is shown for a child that existed before the column, and for one added after it.
    assert.equal(read(upgraded, 'show_sleep_score', 'migration-child'), 1);
    upgraded.prepare("INSERT INTO children (id, name) VALUES ('new-child', 'Another child')").run();
    assert.equal(read(upgraded, 'show_sleep_score', 'new-child'), 1);
    upgraded.prepare('UPDATE children SET hold_alerts_until_asleep = 1, show_sleep_score = 0 WHERE id = ?').run('migration-child');
  } finally { upgraded.close(); }
  const { default: rebooted } = await import('../src/db.js?hold-migration-reboot');
  try {
    assert.equal(read(rebooted, 'hold_alerts_until_asleep', 'migration-child'), 1);
    // An off choice survives the next boot; the other child is untouched.
    assert.equal(read(rebooted, 'show_sleep_score', 'migration-child'), 0);
    assert.equal(read(rebooted, 'show_sleep_score', 'new-child'), 1);
  } finally { rebooted.close(); cleanupTempDataDirs(); }
});
