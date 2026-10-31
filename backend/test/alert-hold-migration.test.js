import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

test('#919 existing children gain an off hold flag and later boots retain changes', async () => {
  const { default: oldDb } = await import('../src/db.js');
  try {
    oldDb.exec('ALTER TABLE children DROP COLUMN hold_alerts_until_asleep');
    oldDb.prepare("INSERT INTO children (id, name) VALUES ('migration-child', 'A child')").run();
  } finally { oldDb.close(); }
  const { default: upgraded } = await import('../src/db.js?hold-migration-upgrade');
  try {
    assert.equal(upgraded.prepare('SELECT hold_alerts_until_asleep FROM children WHERE id = ?').get('migration-child').hold_alerts_until_asleep, 0);
    upgraded.prepare('UPDATE children SET hold_alerts_until_asleep = 1 WHERE id = ?').run('migration-child');
  } finally { upgraded.close(); }
  const { default: rebooted } = await import('../src/db.js?hold-migration-reboot');
  try {
    assert.equal(rebooted.prepare('SELECT hold_alerts_until_asleep FROM children WHERE id = ?').get('migration-child').hold_alerts_until_asleep, 1);
  } finally { rebooted.close(); cleanupTempDataDirs(); }
});
