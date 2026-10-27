import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: router } = await import('../src/routes/esphome.js');
const { demoGuard } = await import('../src/middleware/demoMode.js');
const { stopEsphome } = await import('../src/lib/esphomeManager.js');
let server;
let base;
let admin;
let caregiver;
const KEY = Buffer.alloc(32, 3).toString('base64');
const KEY2 = Buffer.alloc(32, 4).toString('base64');

before(async () => {
  makeUser(db, { id: 'admin', username: 'admin', role: 'admin' });
  makeUser(db, { id: 'caregiver', username: 'caregiver', role: 'caregiver' });
  admin = signToken({ id: 'admin', username: 'admin', role: 'admin', sid: makeSession(db, 'admin') });
  caregiver = signToken({ id: 'caregiver', username: 'caregiver', role: 'caregiver', sid: makeSession(db, 'caregiver') });
  db.prepare("INSERT INTO children (id, name) VALUES ('child-a', 'Sample A'), ('child-b', 'Sample B')").run();
  const app = express();
  app.use(express.json(), demoGuard);
  app.use('/api/esphome', router);
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { stopEsphome(); await new Promise((resolve) => server.close(resolve)); db.close(); cleanupTempDataDirs(); });
const api = (path, options = {}) => call(`${base}/api/esphome${path}`, options);

test('#506 key save, blank keep, new key validation, clear and secret-free replies', async () => {
  const created = await api('/devices', { method: 'POST', token: admin,
    body: { name: 'Neutral sensor', host: '127.0.0.1', key: KEY, enabled: false, child_id: 'child-a' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.key_set, true);
  assert.ok(!JSON.stringify(created.body).includes(KEY));
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, KEY);
  const list = await api('/devices', { token: admin });
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(KEY));
  assert.ok(!JSON.stringify(list.body).includes(KEY.slice(0, 4)));

  const kept = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { key: '', name: 'Renamed' } });
  assert.equal(kept.status, 200);
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, KEY);
  const malformed = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { key: 'bad' } });
  assert.equal(malformed.status, 400);
  assert.ok(!JSON.stringify(malformed.body).includes('bad'));
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, KEY);
  const replaced = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { key: KEY2 } });
  assert.equal(replaced.status, 200);
  assert.ok(!JSON.stringify(replaced.body).includes(KEY2));
  const cleared = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { clear_key: true } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.key_set, false);
  assert.equal(db.prepare('SELECT encryption_key FROM esphome_devices WHERE id = ?').get(id).encryption_key, null);
});

test('#506 moving a child keeps old readings with the old child; export is UTC and neutralises formulas', async () => {
  const id = db.prepare('SELECT id FROM esphome_devices LIMIT 1').get().id;
  db.prepare(`INSERT INTO esphome_entities (device_id, object_id, child_id, kind, name)
    VALUES (?, 'rate', 'child-a', 'sensor', '=formula')`).run(id);
  const entityId = db.prepare('SELECT id FROM esphome_entities WHERE device_id = ?').get(id).id;
  const bucket = Math.floor(Date.parse('2026-10-01T12:34:00Z') / 60000);
  db.prepare('INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n) VALUES (?, ?, 1, 1, 1, 1, 1)')
    .run(entityId, bucket);
  const moved = await api(`/devices/${id}`, { method: 'PUT', token: admin, body: { child_id: 'child-b' } });
  assert.equal(moved.status, 200);
  assert.deepEqual(db.prepare('SELECT child_id, active FROM esphome_entities WHERE device_id = ? ORDER BY id').all(id),
    [{ child_id: 'child-a', active: 0 }, { child_id: 'child-b', active: 1 }]);
  const exported = await api(`/export?device=${id}&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`, { token: admin });
  assert.equal(exported.status, 200);
  assert.match(String(exported.body), /2026-10-01T12:34:00\.000Z/);
  assert.match(String(exported.body), /#1/);
  assert.match(String(exported.body), /'=formula/);
  assert.match(String(exported.body), /child-a/);
  assert.equal((await api(`/export?device=${id}`, { token: admin })).status, 400);
  assert.equal((await api(`/export?device=${id}&from=2026-01-01&to=2026-03-01`, { token: admin })).status, 400);
});

test('#506 settings, host rejection, admin gate and demo block', async () => {
  assert.deepEqual((await api('/settings', { token: admin })).body, { retention_days: 30 });
  assert.equal((await api('/settings', { method: 'PUT', token: admin, body: { retention_days: 0 } })).status, 400);
  assert.equal((await api('/settings', { method: 'PUT', token: admin, body: { retention_days: 365 } })).status, 200);
  assert.equal((await api('/settings', { token: admin })).body.retention_days, 365);
  const host = await api('/devices', { method: 'POST', token: admin, body: { name: 'Other', host: 'sensor.local' } });
  assert.equal(host.status, 400);
  assert.match(host.body.error, /IP address/);
  assert.equal((await api('/devices', { method: 'POST', token: admin,
    body: { name: 'Other', host: 'sensor.local.' } })).status, 400);
  assert.equal((await api('/devices', { token: caregiver })).status, 403);
  process.env.DEMO_MODE = 'true';
  try { assert.equal((await api('/devices', { token: admin })).status, 403); }
  finally { delete process.env.DEMO_MODE; }
});

test('#506 deleting a device removes its entity history', async () => {
  const id = db.prepare('SELECT id FROM esphome_devices LIMIT 1').get().id;
  const entityId = db.prepare('SELECT id FROM esphome_entities WHERE device_id = ? LIMIT 1').get(id).id;
  const add = db.prepare('INSERT OR IGNORE INTO esphome_readings (entity_id, bucket, n) VALUES (?, ?, 0)');
  db.transaction(() => { for (let bucket = 1; bucket <= 1002; bucket++) add.run(entityId, bucket); })();
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings').get().n > 1000);
  assert.equal((await api(`/devices/${id}`, { method: 'DELETE', token: admin })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_entities').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_devices').get().n, 0);
});

test('#506 device count is capped at eight', async () => {
  for (let i = 0; i < 8; i++) {
    const result = await api('/devices', { method: 'POST', token: admin,
      body: { name: `Unit ${i}`, host: '127.0.0.1', enabled: false } });
    assert.equal(result.status, 201);
  }
  assert.equal((await api('/devices', { method: 'POST', token: admin,
    body: { name: 'Ninth unit', host: '127.0.0.1', enabled: false } })).status, 400);
});
