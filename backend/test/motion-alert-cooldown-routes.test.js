// #454: which camera routes touch the frame-diff motion alert stamp (motionDetector.js, `motionAlertStamps`).
// The detector side of the claim (a relaunch and a re-entry keep it) is motion-alert-cooldown.test.js. This file is
// about the WIRING, through the REAL router, because a route that forgot (or wrongly added) a `forgetMotionAlert`
// call is invisible to every test of the pure store:
//
//   C5  a detection PUT, `PUT /:id` (a rename, an address edit), `PUT /:id/assign` and `PUT /:id/enabled` (both
//       directions) do NOT clear the stamp. The frontend autosaves every detection control through that one PUT, and
//       any of these re-enters startMotionDetector, so clearing here would re-arm the cooldown on an unrelated edit
//       (plan review, #454);
//   C6  `DELETE /api/cameras/:id` clears THIS camera's stamp and no other's, so the store does not grow with deleted
//       cameras.
//
// ENABLED AND DISABLED CAMERAS, BOTH (code review round 1, verified by running hand mutants): most of these handlers
// do their real work inside `if (!updated.disabled)` / `if (!existing.disabled)`, so a stray `forgetMotionAlert`
// placed INSIDE that block (ahead of the start/stop calls) is invisible on a disabled camera. The C5 cases therefore
// run on an ENABLED camera too, one whose legs are not wanted (motion off, no child tracking sleep, sound off, no
// clips, no sub stream) so the only process any route can start is the transcoder (`PUT /:id/enabled` with
// enabled=true), which `node:child_process` is mocked to fake. The disabled-camera cases stay: they reach the
// handlers' other branches. NOT covered here (negative space): the 5-minute reconcile in index.js and
// children.js's reconcileChildLegs, which would need the whole app booted.
//
// The stamp is read and planted through the detector's `_..ForTests` helpers via seam(): a missing export fails the
// ONE test with a clear message instead of crashing the file (so this file can be run against code without #454).
import { test, mock, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeCamera, makeChild, signToken, mountRouter, call,
} from './helpers/harness.js';
import { FakeFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();

// ffmpeg is faked by mocking `node:child_process` ONLY (not in test:core's include list; see fakeFfmpeg.js). An
// ffprobe (the transcoder's audio probe) fails at once so it resolves "not AAC"; any other process (the transcoder
// that `PUT /:id/enabled` starts) just sits there until the route stops it.
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      if (command === 'ffprobe') proc.finish(1);
      return proc;
    },
  },
});

// A stand-in MediaMTX that answers every call at once (camera-delete-observation.test.js): the enable, disable and
// delete routes talk to it. Listening BEFORE the dynamic imports: mediamtx.js reads MEDIAMTX_API at load.
const mediamtx = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{}');
});
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const motion = await import('../src/lib/motionDetector.js');
const { stopTranscoder } = await import('../src/lib/transcoder.js');

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
  // track 0: a child whose sleep is not tracked, so assigning a camera to it does not want the activity-only leg
  // (which would depend on the time of day the suite runs at).
  makeChild(db, { id: 'kid-454', name: 'Route Child', track: 0 });
});
after(async () => {
  await server?.close();
  await stopTranscoder(CAM).catch(() => {});
  await new Promise((r) => mediamtx.close(r));
  motion._resetMotionAlertsForTests?.(); // optional-call: absent on code without #454
  cleanupTempDataDirs();
});

// `extra` = columns for the CAM row. Every leg-wanting column is off in both variants, so no detector starts.
const baseColumns = { detect_motion_enabled: 0, detect_sound_enabled: 0, detect_record_clips: 0 };
function makeCameras(disabled) {
  for (const id of [CAM, OTHER]) {
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    makeCamera(db, { id, name: `Route ${id}`, extra: { ...baseColumns, disabled } });
  }
}
beforeEach(() => motion._resetMotionAlertsForTests?.());

describe('#454 which camera routes touch the motion alert stamp', { concurrency: false }, () => {
  // [label, camera is disabled at the start, the call]
  const keeps = [
    ['PUT /:id/detection (a settings save, which the frontend autosaves)', 1, () => api(`${CAM}/detection`, 'PUT', { motion_enabled: false, sensitivity: 61, cooldown_s: 45, confirm_s: 7 })],
    ['PUT /:id (a rename)', 1, () => api(CAM, 'PUT', { name: 'Renamed in the test' })],
    ['PUT /:id/assign (a camera assigned to a child)', 1, () => api(`${CAM}/assign`, 'PUT', { child_id: 'kid-454' })],
    ['PUT /:id/enabled with enabled=false (a camera switched off)', 1, () => api(`${CAM}/enabled`, 'PUT', { enabled: false })],
    ['PUT /:id/detection on an ENABLED camera', 0, () => api(`${CAM}/detection`, 'PUT', { motion_enabled: false, sensitivity: 61, cooldown_s: 45, confirm_s: 7 })],
    ['PUT /:id (a rename) on an ENABLED camera', 0, () => api(CAM, 'PUT', { name: 'Renamed in the test' })],
    ['PUT /:id/assign on an ENABLED camera', 0, () => api(`${CAM}/assign`, 'PUT', { child_id: 'kid-454' })],
    ['PUT /:id/enabled with enabled=false on an ENABLED camera', 0, () => api(`${CAM}/enabled`, 'PUT', { enabled: false })],
    // enabled=true starts the transcoder (faked) and re-registers the path (the stand-in); the camera starts disabled.
    ['PUT /:id/enabled with enabled=true (a camera switched back on)', 1, () => api(`${CAM}/enabled`, 'PUT', { enabled: true })],
  ];
  for (const [label, disabled, doCall] of keeps) {
    test(`#454 C5: ${label} does NOT clear the stamp`, async () => {
      makeCameras(disabled);
      seam('_setMotionAlertStampForTests')(CAM, PLANTED);
      seam('_setMotionAlertStampForTests')(OTHER, PLANTED + 1);
      const res = await doCall();
      assert.equal(res.status, 200, `the call itself failed: ${JSON.stringify(res.body)}`);
      assert.equal(seam('_motionAlertStampForTests')(CAM), PLANTED, 'the route cleared or moved this camera\'s alert stamp');
      assert.equal(seam('_motionAlertStampForTests')(OTHER), PLANTED + 1, 'the route touched another camera\'s stamp');
      await stopTranscoder(CAM); // the enabled=true case left a (fake) transcoder running
    });
  }

  test('#454 C6: DELETE clears THIS camera\'s stamp only, and the store returns to what it was', async () => {
    makeCameras(1);
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
