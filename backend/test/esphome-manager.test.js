import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const manager = await import('../src/lib/esphomeManager.js');
const { logger } = await import('../src/lib/logger.js');
after(() => { manager.stopEsphomeSampler(); manager.stopEsphome(); db.close(); cleanupTempDataDirs(); });

const entity = (object_id, kind) => ({ object_id, kind, name: object_id, device_class: null,
  unit: null, state_class: null, entity_category: null, ignored: false });
const read = () => db.prepare('SELECT e.object_id, r.* FROM esphome_readings r JOIN esphome_entities e ON e.id = r.entity_id ORDER BY r.bucket, e.id').all();

test('#506 numeric buckets preserve missing updates and binary values only while connected', async () => {
  db.prepare("INSERT INTO esphome_devices (name, host, enabled) VALUES ('Neutral unit', '127.0.0.1', 1)").run();
  let now = 1000000 * 60000;
  let hooks;
  const open = async (_config, callbacks) => {
    hooks = callbacks;
    callbacks.onEntities([entity('rate', 'sensor'), entity('presence', 'binary_sensor')]);
    callbacks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() {} };
  };
  manager.refreshEsphome({ open, clock: () => now });
  await Promise.resolve();
  const event = (objectId, kind, value, missing = false) => hooks.onState({ objectId, kind, value, missing });
  event('rate', 'sensor', 0, true);
  event('rate', 'sensor', NaN);
  event('presence', 'binary_sensor', 1);
  now += 60000;
  event('rate', 'sensor', 10);
  assert.equal(read().length, 0, 'incoming updates must never write the database');
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().map((r) => [r.object_id, r.bucket, r.last, r.n, r.nmiss]), [
    ['rate', 1000000, null, 0, 2], ['presence', 1000000, 1, 1, 0],
  ]);

  event('rate', 'sensor', 20);
  event('rate', 'sensor', 15);
  now += 60000;
  manager.flushEsphomeMinute(now);
  const second = read().filter((r) => r.bucket === 1000001);
  assert.deepEqual(second.map((r) => [r.object_id, r.last, r.mean, r.min, r.max, r.n, r.nmiss]), [
    ['rate', 15, 15, 10, 20, 3, 0], ['presence', 1, 1, 1, 1, 0, 0],
  ]);
  manager.flushEsphomeMinute(now);
  assert.equal(read().length, 4, 'a duplicate tick must not duplicate a bucket');

  now += 60000;
  event('presence', 'binary_sensor', 0);
  assert.equal(read().filter((r) => r.bucket === 1000002).length, 0);
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === 1000002).map((r) => r.object_id), ['presence'],
    'silent numeric minutes are gaps');
  assert.equal(read().find((r) => r.bucket === 1000002).last, 1,
    'a new binary state cannot rewrite the preceding minute');

  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === 1000003).map((r) => [r.last, r.n]), [[0, 1]]);

  hooks.onConnection({ state: 'disconnected', encrypted: false, error_code: 'CLOSED', error: 'The device closed the connection.' });
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.equal(read().filter((r) => r.bucket === 1000004).length, 0, 'nothing carries across a drop');
});

test('#506 category guesses use class before entity name', () => {
  const guess = manager.guessEsphomeCategory;
  assert.equal(guess({ device_class: 'occupancy', name: 'heart rate' }), 'occupancy');
  assert.equal(guess({ name: 'Heart Rate' }), 'heart_rate');
  assert.equal(guess({ name: 'Respiratory Rate' }), 'respiratory_rate');
  assert.equal(guess({ name: 'Breath Rate' }), 'respiratory_rate');
  assert.equal(guess({ name: 'Target Number' }), 'target_number');
  assert.equal(guess({ device_class: 'illuminance' }), 'illuminance');
  assert.equal(guess({ device_class: 'distance' }), 'distance');
  assert.equal(guess({ name: 'Unknown sensor' }), null);
});

test('#506 retention removes old buckets and retired entities in bounded statements', async () => {
  const id = db.prepare('SELECT id FROM esphome_entities WHERE object_id = ?').get('rate').id;
  db.prepare('UPDATE esphome_entities SET active = 0 WHERE id = ?').run(id);
  db.prepare('INSERT INTO esphome_readings (entity_id, bucket, n) VALUES (?, ?, 1)')
    .run(id, 2000000 - 1441);
  db.prepare("UPDATE settings SET esphome_retention_days = 1 WHERE id = 'app'").run();
  await manager.pruneEsphome(2000000 * 60000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings WHERE entity_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_entities WHERE id = ?').get(id).n, 0);
});

test('#506 initial transient failure retries; a wrong key stays final until config changes', async () => {
  const transientId = Number(db.prepare("INSERT INTO esphome_devices (name, host) VALUES ('Retry unit', '127.0.0.1')").run().lastInsertRowid);
  const permanentId = Number(db.prepare("INSERT INTO esphome_devices (name, host, encryption_key) VALUES ('Key unit', '127.0.0.1', 'saved')").run().lastInsertRowid);
  const calls = new Map();
  const open = async (config, hooks) => {
    const id = config.key ? permanentId : transientId;
    calls.set(id, (calls.get(id) || 0) + 1);
    if (id === permanentId) throw Object.assign(new Error('private device text'), { name: 'EncryptionKeyInvalidError' });
    if (calls.get(id) === 1) throw Object.assign(new Error('private device text'), { name: 'ConnectionRefusedError' });
    hooks.onEntities([]);
    hooks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() {} };
  };
  manager.refreshEsphome({ open, retryMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.get(transientId), 2);
  assert.equal(calls.get(permanentId), 1);
  const status = new Map(manager.esphomeStatus().map((s) => [s.id, s]));
  assert.equal(status.get(transientId).state, 'connected');
  assert.equal(status.get(permanentId).error_code, 'KEY_WRONG');
  db.prepare("UPDATE esphome_devices SET encryption_key = 'changed' WHERE id = ?").run(permanentId);
  manager.refreshEsphome({ open, retryMs: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.get(permanentId), 2, 'a changed key must reopen a final failure');
  const lines = JSON.stringify(logger.getRecent().filter((line) => String(line).includes('[esphome]')));
  assert.ok(!lines.includes('private device text') && !lines.includes('127.0.0.1') && !lines.includes('saved'));
  manager.stopEsphome();
});

test('#506 a child purge closes live entity IDs before another minute can write them', async () => {
  db.prepare('UPDATE esphome_devices SET enabled = 0').run();
  db.prepare("INSERT INTO children (id, name) VALUES ('child-live', 'Sample')").run();
  const deviceId = Number(db.prepare("INSERT INTO esphome_devices (name, host, child_id) VALUES ('Assigned unit', '127.0.0.1', 'child-live')").run().lastInsertRowid);
  let now = 3000000 * 60000;
  let oldClosed = false;
  let opens = 0;
  let hooks;
  const open = async (_config, callbacks) => {
    opens++;
    hooks = callbacks;
    callbacks.onEntities([entity('rate', 'sensor')]);
    callbacks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() { if (opens === 1) oldClosed = true; } };
  };
  manager.refreshEsphome({ open, clock: () => now });
  await new Promise((resolve) => setImmediate(resolve));
  const oldId = db.prepare('SELECT id FROM esphome_entities WHERE device_id = ?').get(deviceId).id;
  hooks.onState({ objectId: 'rate', kind: 'sensor', value: 9, missing: false });
  db.transaction(() => {
    db.prepare('DELETE FROM esphome_entities WHERE id = ?').run(oldId);
    db.prepare('UPDATE esphome_devices SET child_id = NULL WHERE id = ?').run(deviceId);
    db.prepare("DELETE FROM children WHERE id = 'child-live'").run();
  })();
  manager.reconcileEsphomeChildDeletion('child-live', { open, clock: () => now });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldClosed, true);
  assert.equal(opens, 2);
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings WHERE entity_id = ?').get(oldId).n, 0);
  assert.equal(db.prepare('SELECT child_id FROM esphome_devices WHERE id = ?').get(deviceId).child_id, null);
  manager.stopEsphome();
});

test('#506 discovery records at most 200 entities and logs the cap once', async () => {
  db.prepare('UPDATE esphome_devices SET enabled = 0').run();
  const deviceId = Number(db.prepare("INSERT INTO esphome_devices (name, host) VALUES ('Many entities', '127.0.0.1')").run().lastInsertRowid);
  let hooks;
  const open = async (_config, callbacks) => {
    hooks = callbacks;
    callbacks.onEntities(Array.from({ length: 205 }, (_, i) => entity(`sensor_${i}`, 'sensor')));
    callbacks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() {} };
  };
  const before = logger.getRecent().filter((line) => line.includes(`device #${deviceId} entity limit reached`)).length;
  manager.refreshEsphome({ open });
  await new Promise((resolve) => setImmediate(resolve));
  hooks.onEntities(Array.from({ length: 205 }, (_, i) => entity(`sensor_${i}`, 'sensor')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_entities WHERE device_id = ? AND active = 1').get(deviceId).n, 200);
  assert.equal(logger.getRecent().filter((line) => line.includes(`device #${deviceId} entity limit reached`)).length - before, 1);
  manager.stopEsphome();
});
