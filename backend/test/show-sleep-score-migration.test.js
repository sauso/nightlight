// db.js adds `children.show_sleep_score` (sleep score plan, phase 2). Same two-boot shape as
// alert-hold-migration.test.js, for the same reason: on a fresh database the ALTER guard always runs, so a guard that
// re-ran on every boot (resetting a family's choice) or a wrong default would only show on a real upgrade.
//
// What is pinned: the default is 1 (the score is SHOWN) for a child that existed before the column, and for a child
// added after it; and a choice of 0 survives the next boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const flagOf = (db, id) => db.prepare('SELECT show_sleep_score FROM children WHERE id = ?').get(id).show_sleep_score;

test('show_sleep_score: on for an existing child after the upgrade and for a new one, and an off choice survives a boot', async () => {
  const { default: oldDb } = await import('../src/db.js');
  try {
    // An install that last ran before the column: today's schema with it taken away again.
    oldDb.exec('ALTER TABLE children DROP COLUMN show_sleep_score');
    oldDb.prepare("INSERT INTO children (id, name) VALUES ('migration-child', 'Child A')").run();
    const columns = oldDb.prepare('PRAGMA table_info(children)').all().map((c) => c.name);
    assert.equal(columns.includes('show_sleep_score'), false, 'precondition: the column is gone, as on an older install');
  } finally { oldDb.close(); }

  const { default: upgraded } = await import('../src/db.js?show-score-upgrade');
  try {
    assert.equal(flagOf(upgraded, 'migration-child'), 1);
    upgraded.prepare("INSERT INTO children (id, name) VALUES ('new-child', 'Child B')").run();
    assert.equal(flagOf(upgraded, 'new-child'), 1);
    upgraded.prepare('UPDATE children SET show_sleep_score = 0 WHERE id = ?').run('migration-child');
  } finally { upgraded.close(); }

  const { default: rebooted } = await import('../src/db.js?show-score-reboot');
  try {
    assert.equal(flagOf(rebooted, 'migration-child'), 0);
    assert.equal(flagOf(rebooted, 'new-child'), 1);
  } finally { rebooted.close(); cleanupTempDataDirs(); }
});
