// The Nightlight Camera routes and the places a Nightlight Camera shows up in existing answers: the ONVIF probe, the
// camera list, the chart history. The camera itself is a faked global fetch (requests to the test server pass through).
//
// What must hold: only an admin can switch it on or read it; the SERVER decides a camera is a Nightlight Camera (a client
// cannot forge its id); nothing the camera says is echoed unfiltered; the login never leaves in any answer.
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, makeCamera, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const realOnvif = await import('../src/lib/onvif.js');
let probeAnswer = { ok: true, rtspHost: '192.168.3.50' };
mock.module('../src/lib/onvif.js', { exports: { ...realOnvif, probeOnvifCamera: async () => ({ ...probeAnswer }) } });
const { default: router } = await import('../src/routes/cameras.js');
const { resetCameraSensorsForTest, stopCameraSensors, tickOnce } = await import('../src/lib/cameraSensors.js');

const PASSWORD = 'sup3r-secret-pw';
const IP = '192.168.3.50';
const CAM = 'nl-route-cam';
let server, admin, caregiver, respondTo;
let seen = [];
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const health = (over = {}) => ({ ok: true, api: 'v1', device_id: 'nlcam-c011cb72ca2a', name: 'Nightlight Camera', model: 'nightlight-camera',
  board: 'raspberrypi-zero2w', firmware: '0.1.0', simulated: true, ...over });
const asNightlight = (url) => {
  if (String(url).endsWith('/api/v1/health')) return json(health());
  if (String(url).endsWith('/api/v1/capabilities')) return json({ simulated: true, sensors: { radar: true, environment: true, pressure: { kind: 'none' } } });
  if (String(url).endsWith('/api/v1/sensors')) return json({ error: 'unauthorized' }, 401);
  return json({ error: 'nope' }, 404);
};
const cam = () => db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
const url = (p) => `${server.url}/api/cameras${p}`;

before(async () => {
  mock.method(globalThis, 'fetch', (target, opts) => (String(target).startsWith(server.url) ? realFetch(target, opts) : (seen.push(String(target)), Promise.resolve(respondTo(target, opts)))));
  server = await mountRouter('/api/cameras', router);
  const a = makeUser(db, { id: 'nl-admin', username: 'nl-admin', role: 'admin' });
  const c = makeUser(db, { id: 'nl-care', username: 'nl-care', role: 'caregiver' });
  admin = signToken({ id: a.id, username: a.username, role: a.role, sid: makeSession(db, a.id) });
  caregiver = signToken({ id: c.id, username: c.username, role: c.role, sid: makeSession(db, c.id) });
});
after(async () => { stopCameraSensors(); mock.restoreAll(); await server.close(); cleanupTempDataDirs(); });
beforeEach(() => {
  resetCameraSensorsForTest();
  seen = [];
  db.prepare('DELETE FROM cameras').run();
  makeCamera(db, { id: CAM, name: 'Bedroom', extra: { rtsp_url: `rtsp://nightlight:${PASSWORD}@${IP}:554/main` } });
  respondTo = asNightlight;
  probeAnswer = { ok: true, rtspHost: IP };
});

test('both routes are admin only, and an unknown camera is a 404', async () => {
  for (const method of ['GET', 'PUT']) {
    assert.equal((await call(url(`/${CAM}/nightlight`), { method, body: method === 'PUT' ? { enabled: true } : undefined })).status, 401);
    assert.equal((await call(url(`/${CAM}/nightlight`), { method, token: caregiver, body: method === 'PUT' ? { enabled: true } : undefined })).status, 403);
    assert.equal((await call(url('/nope/nightlight'), { method, token: admin, body: method === 'PUT' ? { enabled: true } : undefined })).status, 404);
  }
});

test('GET asks the camera and reports what it is, never the login', async () => {
  const r = await call(url(`/${CAM}/nightlight`), { token: admin });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    enabled: false, groups: { climate: true, radar: true, light: true, pad: true }, device_id: 'nlcam-c011cb72ca2a',
    detected: true, firmware: '0.1.0', simulated: true, capabilities: { radar: true, environment: true, pressure: false },
    status: 'off', readings: {},
  });
  assert.ok(!JSON.stringify(r.body).includes(PASSWORD));
  // Not a Nightlight Camera, a camera with no answer, and an address that is never contacted.
  respondTo = () => json(health({ model: 'other' }));
  assert.equal((await call(url(`/${CAM}/nightlight`), { token: admin })).body.detected, false);
  respondTo = () => { throw new TypeError('fetch failed'); };
  assert.equal((await call(url(`/${CAM}/nightlight`), { token: admin })).body.reason, 'no_answer');
  db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run('rtsp://u:p@camera.local:554/main', CAM);
  let asked = 0;
  respondTo = () => { asked++; return json(health()); };
  const named = await call(url(`/${CAM}/nightlight`), { token: admin });
  assert.deepEqual([named.body.detected, named.body.reason, asked], [false, 'address', 0]);
});

test('PUT validates its body strictly', async () => {
  const bad = [{ enabled: 'yes' }, { enabled: 1 }, { retry: 'true' }, { groups: 'all' }, { groups: [] }, { groups: null },
    { groups: { radar: 'off' } }, { groups: { climate: 1 } }, { groups: { heartbeat: true } }, { groups: { __proto__x: true } }, { groups: { constructor: true } }, { groups: { toString: true } }];
  for (const body of bad) {
    const r = await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(cam().sensor_source, null);
});

test('switching on re-asks the camera: the server records the id itself, and a camera that does not answer is refused', async () => {
  const r = await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin,
    body: { enabled: true, nlcam_device_id: 'forged-by-client', sensor_source: 'something-else', sensor_api_port: 1 } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.enabled, r.body.groups.climate], [true, true]);
  const row = cam();
  assert.deepEqual([row.sensor_source, row.nlcam_device_id, row.sensor_api_port], ['nightlight-api', 'nlcam-c011cb72ca2a', 8080]);

  db.prepare('UPDATE cameras SET sensor_source = NULL, nlcam_device_id = NULL WHERE id = ?').run(CAM);
  respondTo = () => json(health({ model: 'sonoff' }));
  const refused = await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { enabled: true } });
  assert.equal(refused.status, 422, 'a 4xx, so a proxy keeps the message');
  assert.match(refused.body.error, /Nightlight Camera/);
  assert.deepEqual([cam().sensor_source, cam().nlcam_device_id], [null, null]);
  respondTo = () => { throw new TypeError('fetch failed'); };
  assert.equal((await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { enabled: true } })).status, 422);
  // A camera added by a hostname is refused without any request being made.
  db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run('rtsp://u:p@camera.local:554/main', CAM);
  let asked = 0;
  respondTo = () => { asked++; return json(health()); };
  assert.equal((await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { enabled: true } })).status, 422);
  assert.equal(asked, 0);
});

test('groups merge into what is stored, and switching off clears the source but keeps the groups', async () => {
  await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { enabled: true, groups: { radar: false } } });
  let r = await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { groups: { light: false } } });
  assert.deepEqual(r.body.groups, { climate: true, radar: false, light: false, pad: true });
  assert.equal(r.body.enabled, true);
  r = await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { enabled: false } });
  assert.deepEqual([r.body.enabled, r.body.status, r.body.groups.radar], [false, 'off', false]);
  assert.equal(cam().sensor_source, null);
  assert.equal((await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: {} })).status, 200, 'an empty body is a no-op');
  // Retry on a camera that is not polled is harmless.
  assert.equal((await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { retry: true } })).status, 200);
});

test('the camera list carries nightlight_sensors only for a camera whose sensors are on, and never a login', async () => {
  makeCamera(db, { id: 'plain', name: 'Plain' });
  let list = (await call(url(''), { token: admin })).body;
  assert.ok(list.every((c) => !('nightlight_sensors' in c)), 'additive: absent for every camera that is not on');
  await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { enabled: true } });
  for (const token of [admin, caregiver]) {
    list = (await call(url(''), { token })).body;
    const on = list.find((c) => c.id === CAM);
    assert.deepEqual(on.nightlight_sensors, { status: 'connecting', simulated: null, metrics: {} });
    assert.ok(!('nightlight_sensors' in list.find((c) => c.id === 'plain')));
    assert.ok(!JSON.stringify(list).includes(PASSWORD), 'no answer carries the login');
  }
});

test('the ONVIF probe adds nightlight_camera for a Nightlight Camera and leaves its own answer unchanged otherwise', async () => {
  const probe = (host = IP) => call(url('/onvif-probe'), { method: 'POST', token: admin, body: { host, username: 'nightlight', password: PASSWORD } });
  let r = await probe();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, rtspHost: IP, nightlight_camera: { device_id: 'nlcam-c011cb72ca2a', firmware: '0.1.0', simulated: true, api_port: 8080 } });
  // Every way a host is not a Nightlight Camera: the ONVIF answer is exactly what it was.
  for (const other of [() => json(health({ model: 'sonoff' })), () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    () => new Response(null, { status: 302, headers: { location: 'http://x/' } }), () => json({}, 404), () => { throw new TypeError('x'); }]) {
    respondTo = other;
    r = await probe();
    assert.deepEqual(r.body, { ok: true, rtspHost: IP });
  }
  // A host that is not a literal private address is never contacted (no oracle for arbitrary hosts).
  let asked = 0;
  respondTo = () => { asked++; return json(health()); };
  for (const host of ['camera.local', '8.8.8.8', '169.254.169.254', '127.0.0.1']) assert.deepEqual((await probe(host)).body, { ok: true, rtspHost: IP }, host);
  assert.equal(asked, 0);
});

test('the chart history marks simulated points and leaves real ones unmarked', async () => {
  const insert = db.prepare("INSERT INTO sensor_readings (camera_id, temperature, humidity, simulated, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))");
  insert.run(CAM, 20, 50, 0, '-2 hours');
  insert.run(CAM, 99, 99, 1, '-1 hours');
  const r = await call(url(`/${CAM}/sensor-history?hours=6`), { token: caregiver });
  assert.deepEqual(r.body.readings.map((p) => [p.temperature, p.simulated]), [[20, false], [99, true]]);
});

// Code review (Codex, 2026-11-20): this page sends the camera's login to /capabilities, and a camera blocks an address
// for 5 minutes after 10 wrong logins in a minute, so ten refreshes with a stale stored password could lock Nightlight out
// of its own camera. The page now sends it at most once a minute per login, and never while the poller knows it is wrong.
test('the settings page sends the login at most once a minute, and never one the poller knows is wrong', async () => {
  const capsCalls = () => seen.filter((u) => u.endsWith('/api/v1/capabilities')).length;
  const setPassword = (pw) => db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(`rtsp://nightlight:${pw}@${IP}:554/main`, CAM);
  setPassword('fresh-pw-1');
  for (let i = 0; i < 4; i++) assert.equal((await call(url(`/${CAM}/nightlight`), { token: admin })).status, 200);
  assert.equal(capsCalls(), 1, 'four page views, one authenticated request');
  setPassword('fresh-pw-2');
  await call(url(`/${CAM}/nightlight`), { token: admin });
  assert.equal(capsCalls(), 2, 'a changed login is a new request');

  setPassword('fresh-pw-3');
  assert.equal((await call(url(`/${CAM}/nightlight`), { method: 'PUT', token: admin, body: { enabled: true } })).status, 200);
  await tickOnce(); // the camera answers /sensors with a 401: the poller learns the login is wrong
  const failed = await call(url(`/${CAM}/nightlight`), { token: admin });
  assert.equal(failed.body.status, 'login_failed');
  seen = [];
  for (let i = 0; i < 3; i++) await call(url(`/${CAM}/nightlight`), { token: admin });
  assert.equal(capsCalls(), 0, 'no request carries a login the poller already knows is wrong');
  assert.equal((await call(url(`/${CAM}/nightlight`), { token: admin })).body.capabilities, null);
});
