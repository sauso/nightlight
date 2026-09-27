// Deleting a camera forgets its observation clocks AND their continuity tombstones (issue #373 Stage 2,
// plan §B "Eviction: on camera delete"). A stopped or disabled camera keeps both, so its next start still
// reports the restart; a DELETED camera must not leave per-camera state behind in a long-running backend.
//
// Through the REAL route (DELETE /api/cameras/:id), because the claim is about the wiring: the pure
// forgetObservationClocks() is tested in observation-clock.test.js, and a route that forgot to call it
// would leave that test green.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

// A stand-in MediaMTX that answers every call at once, so the route's path removal neither hangs nor
// reaches a real server. Listening BEFORE the dynamic imports: mediamtx.js reads MEDIAMTX_API at load.
const mediamtx = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { getObservationClock, sweepIdleClocks, _resetObservationClocksForTests } = await import('../src/lib/observationClock.js');

let server;
before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
});
after(async () => {
  await server?.close();
  await new Promise((r) => mediamtx.close(r));
  db.close();
  cleanupTempDataDirs();
});

test('DELETE /api/cameras/:id drops the camera\'s clocks and tombstones; another camera\'s are untouched', async () => {
  _resetObservationClocksForTests();
  const admin = makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  const token = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  makeCamera(db, { id: 'cam-gone' });
  makeCamera(db, { id: 'cam-kept' });

  const t = { mono: 100_000 };
  const clocks = { monoNow: () => t.mono, wallNow: () => t.mono + 1e12 };
  const gone = getObservationClock('cam-gone', 'sound', { clocks });
  const kept = getObservationClock('cam-kept', 'sound', { clocks });
  kept.beginGeneration({ path: 'q' }); // an OPEN generation: the idle sweep below must not take it
  // cam-gone: an idle clock already evicted to a TOMBSTONE (the case a plain registry delete would miss).
  const g = gone.beginGeneration({ path: 'p' });
  g.end('stop');
  t.mono += 3_600_000;
  sweepIdleClocks();
  const goneMotion = getObservationClock('cam-gone', 'motion', { clocks });

  const res = await call(`${server.url}/api/cameras/cam-gone`, { method: 'DELETE', token });
  assert.equal(res.status, 204);

  assert.notEqual(getObservationClock('cam-gone', 'motion', { clocks }), goneMotion, 'the live clock is gone');
  // The tombstone is gone too: a new clock for that id carries no continuity from the deleted camera.
  assert.equal(getObservationClock('cam-gone', 'sound', { clocks }).prevLastObsMono, null);
  assert.equal(getObservationClock('cam-kept', 'sound', { clocks }), kept, 'other cameras are untouched');
});
