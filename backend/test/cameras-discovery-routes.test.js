import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken,
  makeCamera, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: router, setCameraDiscoveryScansForTest, existingCameraHostsForDiscovery } = await import('../src/routes/cameras.js');
const { createScanManager, discoverCameras } = await import('../src/lib/cameraDiscovery.js');
const { demoGuard } = await import('../src/middleware/demoMode.js');
let server, adminToken, caregiverToken;
const scanId = '12345678-1234-1234-1234-123456789abc';

before(async () => {
  server = await mountRouter('/api/cameras', router, { middleware: [demoGuard] });
  const admin = makeUser(db, { id: 'admin-discovery', username: 'admin-discovery', role: 'admin' });
  const caregiver = makeUser(db, { id: 'care-discovery', username: 'care-discovery', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: admin.role, sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: caregiver.id, username: caregiver.username, role: caregiver.role, sid: makeSession(db, caregiver.id) });
  setCameraDiscoveryScansForTest(createScanManager({ discover: async ({ onCandidate }) => {
    const candidate = { id: 'abc', ip: '192.168.1.2', name: 'cam-a', rtspPort: 554, sources: ['mdns'] };
    onCandidate(candidate);
    return { candidates: [candidate], sourceErrors: [] };
  } }));
});
after(async () => { await server.close(); cleanupTempDataDirs(); delete process.env.DEMO_MODE; });
const post = (token) => call(`${server.url}/api/cameras/discover`, { method: 'POST', token, body: {} });
const get = (id, token) => call(`${server.url}/api/cameras/discover/${id}`, { token });

test('discovery routes require an admin and return an injected scan', async () => {
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
  assert.equal((await get('bad', adminToken)).status, 404);
  assert.equal((await get(scanId, adminToken)).status, 404);
});

test('a saved camera found by a scan is marked alreadyAdded, using the real saved-host query (#950)', async () => {
  makeCamera(db, { id: 'cam-existing', name: 'cam-a', extra: { rtsp_url: 'rtsp://user:pass@192.168.1.9:554/stream' } });
  assert.equal(existingCameraHostsForDiscovery().has('192.168.1.9'), true);
  // The hosts come from the real database, the scan is the real discoverCameras with a fake network.
  const callbacks = {};
  const bonjour = { find: ({ type }, cb) => { callbacks[type] = cb; return { stop() {} }; }, destroy() {} };
  const pending = discoverCameras({ createBonjour: () => bonjour, wsProbe: async () => {}, timeoutMs: 20,
    existingHosts: existingCameraHostsForDiscovery() });
  callbacks.thingino({ addresses: ['192.168.1.9'], name: 'cam-a' });
  callbacks.thingino({ addresses: ['192.168.1.2'], name: 'cam-b' });
  const { candidates } = await pending;
  const saved = candidates.find((item) => item.ip === '192.168.1.9');
  assert.equal(saved.alreadyAdded, true);
  assert.equal('alreadyAdded' in candidates.find((item) => item.ip === '192.168.1.2'), false);
});

test('burst is limited and the public demo blocks both routes', async () => {
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await post(adminToken)).status);
  assert.ok(statuses.includes(429));
  process.env.DEMO_MODE = 'true';
  assert.equal((await post(adminToken)).status, 403);
  assert.equal((await get(scanId, adminToken)).status, 403);
  delete process.env.DEMO_MODE;
});
