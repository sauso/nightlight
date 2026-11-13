import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken,
  mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: router, setEsphomeDiscoveryScansForTest, existingEsphomeHostsForDiscovery } = await import('../src/routes/esphome.js');
const { createScanManager } = await import('../src/lib/cameraDiscovery.js');
const { discoverEsphomeDevices } = await import('../src/lib/esphomeDiscovery.js');
const { demoGuard } = await import('../src/middleware/demoMode.js');
let server, adminToken, caregiverToken;
const scanId = '12345678-1234-1234-1234-123456789abc';

before(async () => {
  server = await mountRouter('/api/esphome', router, { middleware: [demoGuard] });
  const admin = makeUser(db, { id: 'admin-discovery', username: 'admin-discovery', role: 'admin' });
  const caregiver = makeUser(db, { id: 'care-discovery', username: 'care-discovery', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: admin.role, sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: caregiver.id, username: caregiver.username, role: caregiver.role, sid: makeSession(db, caregiver.id) });
  setEsphomeDiscoveryScansForTest(createScanManager({ discover: async ({ onCandidate }) => {
    const candidate = { id: 'abc', ip: '192.168.1.2', name: 'ESPHome device', port: 6053 };
    onCandidate(candidate);
    return { candidates: [candidate], sourceErrors: [] };
  } }));
});
after(async () => { await server.close(); cleanupTempDataDirs(); delete process.env.DEMO_MODE; });
const post = (token) => call(`${server.url}/api/esphome/discover`, { method: 'POST', token, body: {} });
const get = (id, token) => call(`${server.url}/api/esphome/discover/${id}`, { token });

test('admin routes start and read a scan without caching; invalid IDs are hidden (#1071)', async () => {
  assert.equal((await post()).status, 401);
  assert.equal((await post(caregiverToken)).status, 403);
  assert.equal((await get(scanId, caregiverToken)).status, 403);
  const started = await post(adminToken);
  assert.equal(started.status, 200);
  assert.match(started.body.scanId, /^[0-9a-f-]{36}$/);
  await new Promise((resolve) => setImmediate(resolve));
  const result = await get(started.body.scanId, adminToken);
  assert.equal(result.status, 200);
  assert.equal(result.body.candidates[0].ip, '192.168.1.2');
  const raw = await fetch(`${server.url}/api/esphome/discover/${started.body.scanId}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(raw.headers.get('cache-control'), 'private, no-store');
  assert.equal((await get('bad', adminToken)).status, 404);
  assert.equal((await get(scanId, adminToken)).status, 404);
});

test('saved address and port mark only an exact match (#1071)', async () => {
  db.prepare("INSERT INTO esphome_devices (name, host, port) VALUES ('ESPHome device', '192.168.1.9', 6053)").run();
  assert.equal(existingEsphomeHostsForDiscovery().has('192.168.1.9:6053'), true);
  let callback;
  const bonjour = { find: (_, cb) => { callback = cb; return { stop() {} }; }, destroy() {} };
  const pending = discoverEsphomeDevices({ createBonjour: () => bonjour,
    existingHosts: existingEsphomeHostsForDiscovery(), timeoutMs: 5 });
  callback({ addresses: ['192.168.1.9'], port: 6054 });
  const { candidates } = await pending;
  assert.equal(candidates[0].alreadyAdded, undefined);
});

test('rate limit and demo mode cover both discovery paths (#1071)', async () => {
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await post(adminToken)).status);
  assert.ok(statuses.includes(429));
  process.env.DEMO_MODE = 'true';
  assert.equal((await post(adminToken)).status, 403);
  assert.equal((await get(scanId, adminToken)).status, 403);
  delete process.env.DEMO_MODE;
});
