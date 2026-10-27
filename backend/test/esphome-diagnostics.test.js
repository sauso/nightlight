// ESPHome in the support bundle (#506): the bundle carries counts and fixed status only, and the stored-key sweep refuses
// to send a bundle that still contains a device key. Neither was covered by name before this file.
//
// Real findCredentialLeak, real route: only the DATA is rigged (a raw camera_events row planted with the device's key in it,
// simulating a future producer that writes a bare key into a bundle field; the logger and urlCredentials only recognise
// `//user:pass@` shapes, so the per-key sweep in routes/diagnostics.js is the only thing that can catch it).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: diagnosticsRouter } = await import('../src/routes/diagnostics.js');

const KEY = Buffer.alloc(32, 9).toString('base64');
const LABEL = 'Neutral sensor label';
const HOST = '10.99.88.77';

let server;
let adminToken;

before(async () => {
  const admin = makeUser(db, { id: 'diag-esphome-admin', username: 'admin', role: 'admin' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: admin.role, sid: makeSession(db, admin.id) });
  server = await mountRouter('/api/diagnostics', diagnosticsRouter);
});

beforeEach(() => {
  db.prepare('DELETE FROM camera_events').run();
  db.prepare('DELETE FROM esphome_devices').run();
  db.prepare('INSERT INTO esphome_devices (name, host, port, encryption_key) VALUES (?, ?, 6053, ?)').run(LABEL, HOST, KEY);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('#506 the bundle shows ESPHome counts and fixed status, never a label, address or key', async () => {
  const res = await call(`${server.url}/api/diagnostics`, { token: adminToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const esphome = res.body.integrations?.esphome;
  assert.equal(esphome?.configured, 1);
  assert.deepEqual(Object.keys(esphome.devices[0]).sort(), ['connected', 'encrypted', 'error_code', 'id']);
  const text = JSON.stringify(res.body);
  for (const secret of [KEY, LABEL, HOST]) assert.ok(!text.includes(secret), `the bundle contains ${secret.slice(0, 6)}...`);
});

test('#506 a bundle that still contains a stored device key is refused, not sent', async () => {
  db.prepare('INSERT INTO camera_events (camera_id, camera_name, type, detail) VALUES (?, ?, ?, ?)')
    .run('esphome-gate-cam', 'Gate Camera', 'restart', `debug dump: ${KEY}`);
  const res = await call(`${server.url}/api/diagnostics`, { token: adminToken });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.ok(!('cameras' in res.body), 'the flagged bundle body was sent anyway');
});
