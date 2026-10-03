// #454: which camera routes touch the frame-diff motion alert stamp (motionDetector.js, `motionAlertStamps`).
// The detector side of the claim (a relaunch and a re-entry keep it) is motion-alert-cooldown.test.js. This file is
// about the WIRING, through the REAL router, because a route that forgot (or wrongly added) a `forgetMotionAlert`
// call is invisible to every test of the pure store:
//
//   C5  a detection PUT, `PUT /:id` (a rename, an address edit), `PUT /:id/assign` and `PUT /:id/enabled` do NOT clear
//       the stamp. The frontend autosaves every detection control through that one PUT, and any of these re-enters
//       startMotionDetector, so clearing here would re-arm the cooldown on an unrelated edit (plan review, #454);
//   C6  `DELETE /api/cameras/:id` clears THIS camera's stamp and no other's, so the store does not grow with deleted
//       cameras.
//
// ⚠️ Every camera here is `disabled: 1` ON PURPOSE (detection-route.test.js explains): the handlers' tails start the
// real frame-diff, ONVIF, sound and clip-ring legs for an ENABLED camera, which this suite has no business spawning.
// The calls under test (`forgetMotionAlert`, if a route made one) sit ahead of that block or outside it, so a disabled
// camera still exercises them. `PUT /:id/enabled` is called with enabled=false, the path that stops things and
// removes the MediaMTX path (answered by the stand-in below).
//
// The stamp is read and planted through the detector's `_..ForTests` helpers via seam(): a missing export fails the
// ONE test with a clear message instead of crashing the file (so this file can be run against code without #454).
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, makeChild, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

// A stand-in MediaMTX that answers every call at once (camera-delete-observation.test.js): the disable and delete
// routes remove the camera's paths. Listening BEFORE the dynamic imports: mediamtx.js reads MEDIAMTX_API at load.
const mediamtx = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const motion = await import('../src/lib/motionDetector.js');

function seam(name) {
  const fn = motion[name];
  if (typeof fn !== 'function') assert.fail(`motionDetector.js does not export ${name}: the #454 alert-stamp store is missing`);
  return fn;
}

let server;
let token;
const CAM = 'cam-454';
const OTHER = 'cam-454-other';
const PLANTED = 1_700_000_000_000; // a wall time well in the past: any code that "refreshed" it would change it
const api = (path, method, body) => call(`${server.url}/api/cameras/${path}`, { method, token, body });

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
  makeChild(db, { id: 'kid-454', name: 'Route Child' });
});
after(async () => {
  await server?.close();
  await new Promise((r) => mediamtx.close(r));
  motion._resetMotionAlertsForTests?.(); // optional-call: absent on code without #454
  cleanupTempDataDirs();
});
beforeEach(() => {
  motion._resetMotionAlertsForTests?.();
  for (const id of [CAM, OTHER]) {
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    makeCamera(db, { id, name: `Route ${id}`, extra: { disabled: 1 } });
  }
});

describe('#454 which camera routes touch the motion alert stamp', { concurrency: false }, () => {
  const keeps = [
    ['PUT /:id/detection (a settings save, which the frontend autosaves)', () => api(`${CAM}/detection`, 'PUT', { motion_enabled: true, sensitivity: 61, cooldown_s: 45, confirm_s: 7 })],
    ['PUT /:id (a rename)', () => api(CAM, 'PUT', { name: 'Renamed in the test' })],
    ['PUT /:id/assign (a camera assigned to a child)', () => api(`${CAM}/assign`, 'PUT', { child_id: 'kid-454' })],
    ['PUT /:id/enabled with enabled=false (a camera switched off)', () => api(`${CAM}/enabled`, 'PUT', { enabled: false })],
  ];
  for (const [label, doCall] of keeps) {
    test(`#454 C5: ${label} does NOT clear the stamp`, async () => {
      seam('_setMotionAlertStampForTests')(CAM, PLANTED);
      seam('_setMotionAlertStampForTests')(OTHER, PLANTED + 1);
      const res = await doCall();
      assert.equal(res.status, 200, `the call itself failed: ${JSON.stringify(res.body)}`);
      assert.equal(seam('_motionAlertStampForTests')(CAM), PLANTED, 'the route cleared or moved this camera\'s alert stamp');
      assert.equal(seam('_motionAlertStampForTests')(OTHER), PLANTED + 1, 'the route touched another camera\'s stamp');
    });
  }

  test('#454 C6: DELETE clears THIS camera\'s stamp only, and the store returns to what it was', async () => {
    const count = seam('_motionAlertStampCountForTests');
    const stampOf = seam('_motionAlertStampForTests');
    assert.equal(count(), 0, 'precondition: an empty store');
    seam('_setMotionAlertStampForTests')(CAM, PLANTED);
    seam('_setMotionAlertStampForTests')(OTHER, PLANTED + 1);
    assert.equal(count(), 2);
    const res = await call(`${server.url}/api/cameras/${CAM}`, { method: 'DELETE', token });
    assert.equal(res.status, 204);
    assert.equal(stampOf(CAM), undefined, 'DELETE left the deleted camera\'s stamp behind');
    assert.equal(stampOf(OTHER), PLANTED + 1, 'DELETE cleared another camera\'s stamp');
    assert.equal(count(), 1, 'the store holds more than the one surviving camera');
  });
});
