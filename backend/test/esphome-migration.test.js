import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: first } = await import('../src/db.js');
let upgraded;
after(() => { upgraded?.close(); first.close(); cleanupTempDataDirs(); });

test('#506 an existing populated database gets the new tables and default without losing rows', async () => {
  first.prepare("INSERT INTO children (id, name) VALUES ('existing-child', 'Sample')").run();
  for (const table of ['esphome_readings', 'esphome_entities', 'esphome_devices'])
    first.exec(`DROP TABLE ${table}`);
  first.exec('ALTER TABLE settings DROP COLUMN esphome_retention_days');
  upgraded = (await import(`../src/db.js?upgrade=${Date.now()}`)).default;
  assert.equal(upgraded.prepare("SELECT name FROM children WHERE id = 'existing-child'").get().name, 'Sample');
  assert.equal(upgraded.prepare("SELECT esphome_retention_days FROM settings WHERE id = 'app'").get().esphome_retention_days, 30);
  for (const table of ['esphome_readings', 'esphome_entities', 'esphome_devices'])
    assert.ok(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  // The minute row counts zeros apart from n and nmiss (#506 review, round 2), and a row written without it means none.
  assert.deepEqual(upgraded.prepare('PRAGMA table_info(esphome_readings)').all().map((c) => c.name),
    ['entity_id', 'bucket', 'last', 'mean', 'min', 'max', 'n', 'nzero', 'nmiss']);
  const nzero = upgraded.prepare('PRAGMA table_info(esphome_readings)').all().find((c) => c.name === 'nzero');
  assert.deepEqual([nzero.type, nzero.notnull, nzero.dflt_value], ['INTEGER', 1, '0']);
});
