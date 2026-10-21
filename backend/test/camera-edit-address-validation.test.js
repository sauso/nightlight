// #793: hold address validation while a real competing route removes or disables the camera.
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const probeUrls = [];
const pathWrites = [];
let probe = async () => ({ ok: true });
mock.module('../src/lib/rtspProbe.js', {
  exports: {
    validateRtspStream: async (url) => { probeUrls.push(url); return probe(url); },
    probeRtspDetailed: async () => ({ ok: false }),
    ffprobeVersion: async () => null,
  },
});
mock.module('../src/lib/transcoder.js', {
  exports: {
    startTranscoder: async () => {},
    stopTranscoder: async () => {},
    isRunning: () => false,
  },
});
// Keep MediaMTX real over HTTP so the test sees the route's actual config writes.
const mediamtx = createServer((req, res) => {
  pathWrites.push({ method: req.method, path: req.url });
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((resolve) => mediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;
const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const server = await mountRouter('/api/cameras', camerasRouter);
const admin = makeUser(db, { id: 'u-793-address', username: 'admin-793-address', role: 'admin' });
const token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
const CAM = '79300000-0000-4000-8000-000000000002';
const NEW = 'rtsp://user:pass@new.example:554/stream';
const row = () => db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
const put = (body) => call(`${server.url}/api/cameras/${CAM}`, { method: 'PUT', token, body });
const writesForCamera = () => pathWrites.filter(({ method, path }) =>
  (method === 'PATCH' || method === 'POST') && path.endsWith(`/path_${CAM}`));

beforeEach(() => {
  probe = async () => ({ ok: true });
  probeUrls.length = 0;
  pathWrites.length = 0;
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  makeCamera(db, { id: CAM, extra: { disabled: 0, detect_motion_enabled: 0, detect_sound_enabled: 0 } });
  assert.equal(row().disabled, 0, 'precondition: camera is enabled');
  assert.notEqual(row().rtsp_url, NEW, 'precondition: address changes');
});
after(async () => {
  await server.close();
  await new Promise((resolve) => mediamtx.close(resolve));
  db.close();
  cleanupTempDataDirs();
});

async function duringValidation(competing) {
  let entered;
  const seen = new Promise((resolve) => { entered = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  probe = async () => { entered(); await released; return { ok: true }; };
  try {
    const pending = put({ rtsp_host: 'new.example' });
    await seen;
    assert.deepEqual(probeUrls, [NEW], 'precondition: changed address reached validation');
    assert.notEqual(row().rtsp_url, NEW, 'precondition: edit has not saved yet');
    const middle = await competing();
    release();
    return { middle, finish: await pending };
  } finally { release(); }
}

test('delete during address validation returns 404 without recreating its path', async () => {
  const { middle, finish } = await duringValidation(() =>
    call(`${server.url}/api/cameras/${CAM}`, { method: 'DELETE', token }));
  assert.equal(middle.status, 204, JSON.stringify(middle.body));
  assert.equal(finish.status, 404, JSON.stringify(finish.body));
  assert.deepEqual(finish.body, { error: 'Camera not found' });
  assert.equal(writesForCamera().length, 0);
  assert.equal(row(), undefined);
});

test('disable during address validation saves the address without registering a path', async () => {
  const { middle, finish } = await duringValidation(() =>
    call(`${server.url}/api/cameras/${CAM}/enabled`, { method: 'PUT', token, body: { enabled: false } }));
  assert.equal(middle.status, 200, JSON.stringify(middle.body));
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().disabled, 1);
  assert.equal(row().rtsp_url, NEW);
  assert.equal(writesForCamera().length, 0);
});

test('enabled camera with validated changed address registers its path once and saves', async () => {
  const finish = await put({ rtsp_host: 'new.example' });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.deepEqual(probeUrls, [NEW]);
  assert.equal(row().disabled, 0);
  assert.equal(row().rtsp_url, NEW);
  assert.equal(writesForCamera().length, 1);
});

test('unchanged address skips validation and path registration', async () => {
  const finish = await put({ name: 'Renamed' });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.equal(row().name, 'Renamed');
  assert.deepEqual(probeUrls, []);
  assert.equal(writesForCamera().length, 0);
});

test('force skips validation and still registers a changed address', async () => {
  const finish = await put({ rtsp_host: 'new.example', force: true });
  assert.equal(finish.status, 200, JSON.stringify(finish.body));
  assert.deepEqual(probeUrls, []);
  assert.equal(row().rtsp_url, NEW);
  assert.equal(writesForCamera().length, 1);
});

test('validation failure keeps the existing 422 and registers no path', async () => {
  probe = async () => ({ ok: false, error: 'unreachable' });
  const finish = await put({ rtsp_host: 'new.example' });
  assert.equal(finish.status, 422, JSON.stringify(finish.body));
  assert.deepEqual(finish.body, { error: "Couldn't reach the camera stream: unreachable", needsConfirm: true });
  assert.deepEqual(probeUrls, [NEW]);
  assert.notEqual(row().rtsp_url, NEW);
  assert.equal(writesForCamera().length, 0);
});
