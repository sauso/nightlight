// #780: the route must save a changed RTSP URL before it queues a transcoder start. A stale child
// assignment can fail at the UPDATE after an ONVIF probe; that failure must leave the stream alone.
import { test, mock, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, makeChild, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const starts = [];
let db;
let startError = null;
// Only transcoder.js is mocked. The route, SQLite schema, MediaMTX client and ONVIF probe are real.
mock.module('../src/lib/transcoder.js', {
  exports: {
    startTranscoder: async (...args) => {
      starts.push({ args, savedUrl: db.prepare('SELECT rtsp_url FROM cameras WHERE id = ?').get(args[0])?.rtsp_url });
      if (startError) throw startError;
    },
    stopTranscoder: async () => {},
    isRunning: () => false,
  },
});

let mediaStatus = 200;
const mediamtx = createServer((req, res) => {
  res.writeHead(mediaStatus, { 'content-type': 'application/json' });
  res.end(mediaStatus === 200 ? '{}' : '{"error":"rejected"}');
});
await new Promise((resolve) => mediamtx.listen(0, '127.0.0.1', resolve));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

({ default: db } = await import('../src/db.js'));
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const server = await mountRouter('/api/cameras', camerasRouter);
const admin = makeUser(db, { id: 'u-780', username: 'admin-780', role: 'admin' });
const token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
const CAM = 'cam-780';
const OLD = 'rtsp://user:pass@example/stream';
const put = (body) => call(`${server.url}/api/cameras/${CAM}`, { method: 'PUT', token, body });
const row = () => db.prepare('SELECT rtsp_url, disabled FROM cameras WHERE id = ?').get(CAM);

beforeEach(() => {
  starts.length = 0;
  startError = null;
  mediaStatus = 200;
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  makeCamera(db, { id: CAM, extra: { disabled: 0, detect_motion_enabled: 0, detect_sound_enabled: 0 } });
  assert.equal(row().disabled, 0, 'precondition: an enabled camera can actually restart');
  assert.equal(row().rtsp_url, OLD);
});

after(async () => {
  await server.close();
  await new Promise((resolve) => mediamtx.close(resolve));
  db.close();
  cleanupTempDataDirs();
});

test('changed address is saved when startTranscoder is called', async () => {
  const res = await put({ rtsp_host: 'new.example', force: true });
  const NEW = 'rtsp://user:pass@new.example:554/stream';
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.notEqual(NEW, OLD, 'precondition: the address really changed');
  assert.equal(starts.length, 1, 'precondition: startTranscoder actually ran');
  assert.equal(starts[0].args[1], NEW);
  assert.equal(starts[0].savedUrl, NEW, 'start was queued while SQLite still held the old address');
  assert.equal(row().rtsp_url, NEW);
});

test('stale child assignment returns 409 after ONVIF probe without starting or saving', async () => {
  const childId = 'child-780-stale';
  makeChild(db, { id: childId, name: 'A child' });
  let probeSeen;
  const probing = new Promise((resolve) => { probeSeen = resolve; });
  const sockets = new Set();
  // Reply 404 to the real RTSP backchannel probe. The first request lets us delete the child
  // after childExists checked it, but before UPDATE's foreign-key check (#780).
  const { createServer: createTcpServer } = await import('node:net');
  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.once('data', () => {
      probeSeen();
      socket.end('RTSP/1.0 404 Not Found\r\nCSeq: 1\r\n\r\n');
    });
  });
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  try {
    const pending = put({ rtsp_host: '127.0.0.1', rtsp_port: tcp.address().port, force: true,
      child_id: childId, discovery_source: 'onvif', backchannel_supported: 'yes' });
    await probing;
    assert.equal(row().rtsp_url, OLD, 'precondition: UPDATE is still awaiting the probe');
    db.prepare('DELETE FROM children WHERE id = ?').run(childId);
    const res = await pending;
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(row().rtsp_url, OLD);
    assert.equal(starts.length, 0, 'failed save changed the running stream');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => tcp.close(resolve));
  }
});

test('disabled camera saves a changed address without starting', async () => {
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  assert.equal(row().disabled, 1);
  const res = await put({ rtsp_host: 'new.example', force: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(row().rtsp_url, 'rtsp://user:pass@new.example:554/stream');
  assert.equal(starts.length, 0);
});

test('unchanged address does not restart', async () => {
  const res = await put({ name: 'Renamed' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(row().rtsp_url, OLD);
  assert.equal(starts.length, 0);
});

test('MediaMTX path failure answers 502 before saving or starting', async () => {
  mediaStatus = 500;
  const res = await put({ rtsp_host: 'new.example', force: true });
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(row().rtsp_url, OLD);
  assert.equal(starts.length, 0);
});

test('a failed transcoder start keeps the saved address and the existing 500 answer', async () => {
  startError = new Error('simulated start failure');
  const res = await put({ rtsp_host: 'new.example', force: true });
  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.deepEqual(res.body, { error: 'Something went wrong on the server. Check the Nightlight logs for details.' });
  assert.equal(starts.length, 1);
  assert.equal(row().rtsp_url, 'rtsp://user:pass@new.example:554/stream');
});
