// The route-level wiring that arms/disarms a WAKE-ONLY clip ring immediately, rather than waiting up
// to 5 minutes for the periodic reconcile (issue #387, the 2026-09-11 Codex review's R3).
//
// clipRing.test.js pins the PREDICATE (clipRingWanted now accounts for wake clips) and
// clip-capture.test.js pins that startClipCapture/stopClipCapture/reconcileClipRing actually produce a
// real segmenter for that predicate. Neither exercises the FOUR route call sites this file is for:
//   * PUT /api/children/:id — reconcileChildLegs, when "Track sleep" changes.
//   * PUT /api/settings — the wakeClipsChanged re-arm, when the global wake-clip switch changes.
//   * PUT /api/cameras/:id/assign — reconcileClipRing, when a camera's child_id changes.
//   * DELETE /api/children/:id — reconcileClipRing per affected camera, when a child (and so its
//     cameras' child_id) goes away.
// A regression here looks exactly like children-route.test.js's own documented gap: nothing crashes,
// nothing errors, the setting just silently doesn't take effect until the next reconcile (or, before
// this fix existed at all, never — the last two routes had NO reconcile at all until an adversarial
// review of this same issue found them: assign is the path someone actually takes to reach wake-clip
// eligibility, and unassign/delete leaked a running ffmpeg segmenter permanently, since index.js's own
// periodic reconcile had only the start half at the time — see clipCapture.js's reconcileClipRing.
//
// ⚠️ PATH IS EMPTIED BEFORE ANY IMPORT, same reasoning as clip-capture.test.js: startClipCapture spawns
// real ffmpeg on a machine that has one. Emptying PATH makes the spawn fail identically everywhere.
//
// ⚠️ WHY "STARTED" IS CHECKED VIA THE RING DIRECTORY, NOT isSegmenterRunning, BUT "STOPPED" IS CHECKED
// VIA isSegmenterRunning. Asymmetric on purpose:
//   * stopSegmenter deletes the live-process map entry SYNCHRONOUSLY and never touches the ring
//     directory on disk — so after an awaited stop, isSegmenterRunning===false is exact, and checking
//     the directory would be wrong (it deliberately survives a stop, ready for the next start).
//   * startSegmenter writes the map entry SYNCHRONOUSLY too, but the spawn's ENOENT failure clears it
//     back out ASYNCHRONOUSLY — and a real HTTP round trip through mountRouter's server is enough real
//     event-loop time for that async teardown to win the race. The first version of this file asserted
//     isSegmenterRunning after every `await put...(...)` and failed 4 of 6 tests against CORRECT code,
//     for exactly that reason. `fs.mkdirSync(ringDir, ...)`, by contrast, runs synchronously inside
//     startSegmenter before the spawn even happens and is never undone by a failed spawn — so its
//     presence (or a marker file surviving inside it) is a reliable, non-racy proof that startSegmenter
//     ran, matching the technique clip-capture.test.js already uses ("starting twice does not restart
//     it", "restart really restarts").
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken,
  mountRouter, call,
} from './helpers/harness.js';

const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: childrenRouter, reconcileChildLegs } = await import('../src/routes/children.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { CLIPS_DIR, isSegmenterRunning } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const { startClipCapture, stopAllClipCapture } = await import('../src/lib/clipCapture.js');
const { stopAllMotionDetectors } = await import('../src/lib/motionDetector.js');

const MOUNTED = `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${path.resolve(CLIPS_DIR)} xfs rw 0 0\n`;

let childrenServer, settingsServer, camerasServer, token;
const KID = 'kid-1';

const putChild = (body) => call(`${childrenServer.url}/api/children/${KID}`, { method: 'PUT', token, body });
const putSettings = (body) => call(`${settingsServer.url}/api/settings`, { method: 'PUT', token, body });
const putAssign = (camId, body) => call(`${camerasServer.url}/api/cameras/${camId}/assign`, { method: 'PUT', token, body });
const deleteChild = (id) => call(`${childrenServer.url}/api/children/${id}`, { method: 'DELETE', token });
const camRow = (id = 'cam-1') => db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
const ringDir = (id = 'cam-1') => path.join(CLIPS_DIR, '.ring', id);
const markerPath = (id = 'cam-1') => path.join(ringDir(id), 'marker.mkv');
const plantMarker = (id = 'cam-1') => fs.writeFileSync(markerPath(id), 'x');

before(async () => {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  const st = checkClipStorage({ mounts: MOUNTED });
  assert.equal(st.ok, true, `clip storage did not come up ready (${st.reason}) — every test here would be vacuous`);
  childrenServer = await mountRouter('/api/children', childrenRouter);
  settingsServer = await mountRouter('/api/settings', settingsRouter);
  camerasServer = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  token = signToken({ id: admin.id, sub: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
});

after(async () => {
  stopAllClipCapture();
  // PUT /:id/assign (and reconcileChildLegs) also call startMotionDetector as a side effect of
  // exercising the route — a second, unrelated ffmpeg-spawn subsystem this file was never tearing
  // down. On the ENOENT path that leaves an orphaned ChildProcess + its piped stdout/stderr Sockets
  // as active libuv handles, which silently keeps the process alive forever (not a timeout — verified
  // waiting 90s+ with nothing happening). Reproduced identically on native Windows and in two different
  // Docker base images while chasing an unrelated question about running this suite under Codex, so
  // it isn't platform-specific; CI's own runners apparently don't hit the same handle-count/timing
  // window, which is why `npm test` looked green there despite the underlying leak being real. Same
  // stop-all index.js already calls on real shutdown (see recordings-shutdown.test.js).
  await stopAllMotionDetectors();
  await childrenServer.close();
  await settingsServer.close();
  await camerasServer.close();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(async () => {
  stopAllClipCapture();
  await stopAllMotionDetectors();
  fs.rmSync(path.join(CLIPS_DIR, '.ring'), { recursive: true, force: true }); // clean slate for the dir-existence checks
  db.prepare('DELETE FROM children').run();
  db.prepare('DELETE FROM cameras').run();
  db.prepare(
    'UPDATE settings SET ondemand_enabled = 0, wake_clips_enabled = 1 WHERE id = ?'
  ).run('app'); // isolate wake clips as the ONLY reason a camera in this file could want a ring
  makeChild(db, { id: KID, track: 1 });
  makeCamera(db, { id: 'cam-1', name: 'Nursery', childId: KID });
});

describe('★ children.js: reconcileChildLegs arms/disarms the wake-only ring immediately', () => {
  test('turning "Track sleep" ON starts the ring right away, without a separate reconcile tick', async () => {
    db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID);
    assert.equal(fs.existsSync(ringDir()), false, 'precondition: no ring directory — nothing should be buffering');
    const res = await putChild({ track_sleep: true });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(ringDir()), true, 'PUT track_sleep:true did not start a segmenter for the wake-only camera');
  });

  // ⚠️ Called DIRECTLY, not through the route: the ON-direction test above already proves the route
  // reaches reconcileChildLegs at all (nothing else in the handler could have started a segmenter for
  // this camera), and both directions share that one call site — `if (newTrack !== existing.track_sleep
  // ...) reconcileChildLegs(...)`. What a real HTTP round trip CANNOT prove is the STOP direction: see
  // the file header — isSegmenterRunning dies on its own within ~10-20ms of the empty-PATH spawn
  // failure, faster than the round trip itself, so an awaited PUT reads false whether or not this
  // function's stop branch ever ran. A same-tick call is the only way to discriminate it.
  test('reconcileChildLegs stops an already-running wake-only ring once "Track sleep" is off', () => {
    startClipCapture(camRow()); // seed the running state as if it had started while tracking was still on (fixture default: track_sleep=1)
    assert.equal(isSegmenterRunning('cam-1'), true, 'precondition: the wake-only ring is running');
    db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID); // now flip it off, same as a PUT would
    reconcileChildLegs(KID);
    assert.equal(isSegmenterRunning('cam-1'), false, 'reconcileChildLegs left the segmenter running for a non-tracked child');
  });

  test('a change unrelated to tracking/window does not restart (and so does not wipe) the ring', async () => {
    startClipCapture(camRow());
    plantMarker(); // startSegmenter empties the ring dir on every (re)start — this proves whether one happened
    assert.equal(fs.existsSync(markerPath()), true, 'precondition: the marker is there to begin with');
    const res = await putChild({ name: 'Renamed', track_sleep: true }); // track_sleep unchanged: 1 -> 1
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(markerPath()), true, 'an unrelated field change restarted (and wiped) the ring');
  });
});

describe('★ settings.js: the global wake-clip switch re-arms every camera immediately', () => {
  test('turning wake clips ON starts an eligible camera\'s ring right away', async () => {
    db.prepare('UPDATE settings SET wake_clips_enabled = 0 WHERE id = ?').run('app');
    assert.equal(fs.existsSync(ringDir()), false, 'precondition: wake clips are off globally, nothing buffering');
    const res = await putSettings({ wake_clips_enabled: true });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(ringDir()), true, 'PUT wake_clips_enabled:true did not re-arm the ring');
  });

  // The STOP direction for THIS route is not provable through a real HTTP call either, for the same
  // isSegmenterRunning-dies-first reason documented at the top of this file — and unlike children.js's
  // reconcileChildLegs, this route's re-arm loop has no separate function to call directly; it just
  // calls the already-exported restartClipCapture, which clip-capture.test.js's "restarting a camera
  // that no longer wants the ring leaves it stopped" test already exercises synchronously. The wake-
  // clips-specific case (a camera whose ONLY reason to buffer was wake clips) is added there alongside
  // it, rather than duplicated here against a route that cannot reliably prove it.

  test('a settings save that does not touch wake clips does not restart (and so does not wipe) the ring', async () => {
    startClipCapture(camRow());
    plantMarker();
    assert.equal(fs.existsSync(markerPath()), true, 'precondition: the marker is there to begin with');
    const res = await putSettings({ app_name: 'Casa' });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(markerPath()), true, 'an unrelated settings save restarted (and wiped) the ring');
  });
});

describe('★ cameras.js: PUT /:id/assign reconciles the ring immediately (issue #387)', () => {
  // ★ THE REGRESSION AS FOUND: assigning a camera to a sleep-tracked, wake-eligible child is the path
  // someone actually takes to reach wake-clip eligibility in the first place (create child -> assign
  // camera -> toggle tracking, or assign a camera that's already tracking) — and this route never
  // reconciled the ring at all before the adversarial review found it, so the FIRST night after assigning
  // buffered nothing until the periodic reconcile caught up (up to 5 min).
  test('assigning a camera to a wake-eligible child starts the ring right away', async () => {
    db.prepare('DELETE FROM cameras').run();
    makeCamera(db, { id: 'cam-2', name: 'Unassigned', childId: null });
    assert.equal(fs.existsSync(ringDir('cam-2')), false, 'precondition: unassigned, nothing buffering');
    const res = await putAssign('cam-2', { child_id: KID });
    assert.equal(res.status, 200);
    assert.equal(db.prepare('SELECT child_id FROM cameras WHERE id = ?').get('cam-2').child_id, KID);
    assert.equal(fs.existsSync(ringDir('cam-2')), true, 'PUT /assign did not start the wake-only ring');
  });

  // ⚠️ "Does a same-child assign avoid a needless restart" is NOT tested here, and trying it found a
  // real limit of this harness rather than a bug: seeding "already running" via a direct startClipCapture
  // call, then checking a marker survived an HTTP round trip, is flaky in THIS environment for the
  // opposite reason the STOP-direction tests are unprovable — the empty-PATH segmenter can die naturally
  // (~10-20ms) DURING the round trip, so by the time the route's reconcile runs it may correctly (from
  // its own perspective) see "wanted, not running" and legitimately restart. That is startClipCapture
  // doing exactly what "starting twice does not restart it" (clip-capture.test.js) already proves it
  // does when the ring is ACTUALLY still running — the flakiness is in this test's precondition
  // surviving the round trip, not in the code. Left undone rather than asserted unreliably.
  //
  // ⚠️ The STOP direction (unassigning a camera whose only reason to buffer was wake clips) is NOT
  // re-proven here through HTTP, for the reason documented at the top of this file: isSegmenterRunning
  // dies on its own from the empty-PATH spawn failure faster than the round trip, so the check would
  // pass whether or not the route's reconcile actually ran. reconcileClipRing's stop branch is proven
  // directly and synchronously in clip-capture.test.js ("★ THE FIX: stops a running ring that is no
  // longer wanted") — what's specific to THIS route is that it calls reconcileClipRing(updated) at all
  // on assign, which the two tests above already establish (one via a real state change, one via its
  // absence). Full live-process proof of the unassign path belongs in e2e with a real ffmpeg, same as
  // clipRing.test.js's own header says about the on-demand bug this issue's fix mirrors.
});

describe('★ children.js: DELETE /:id reconciles every affected camera\'s ring (issue #387)', () => {
  test('deleting the child a camera is assigned to clears child_id', async () => {
    const res = await deleteChild(KID);
    assert.equal(res.status, 204);
    assert.equal(camRow('cam-1').child_id, null, 'the camera was not detached from the deleted child');
  });

  test('deleting an unrelated child does not restart (and so does not wipe) another child\'s ring', async () => {
    makeChild(db, { id: 'kid-other', track: 1 });
    startClipCapture(camRow()); // cam-1 belongs to KID, not kid-other
    plantMarker();
    assert.equal(fs.existsSync(markerPath()), true, 'precondition: the marker is there to begin with');
    const res = await deleteChild('kid-other');
    assert.equal(res.status, 204);
    assert.equal(fs.existsSync(markerPath()), true, "deleting an unrelated child restarted (and wiped) this one's camera ring");
  });

  // ★ THE FIX I INITIALLY CALLED UNTESTABLE, AND WAS WRONG: my first two tests above don't discriminate
  // the fix's real subject (affectedCameraIds captured BEFORE `UPDATE ... SET child_id = NULL`, not
  // after — see the route's comment for why the order matters). I mutation-tested that and confirmed
  // it: reverting the capture-before-update fix entirely left both tests above green, AND — found on a
  // second adversarial review pass — so did deleting the ENTIRE per-camera reconcile loop. Neither test
  // exercises the loop body at all.
  //
  // The error was assuming the affected camera's reconcile must be a STOP to observe, which is where
  // the real live-segmenter-over-HTTP race lives (documented at the top of this file). It doesn't have
  // to be: give the camera an independent reason to want the ring that OUTLIVES its child
  // (`detect_record_clips = 1`) and leave it not yet running. Now the loop's only correct action is a
  // START, which — like every other START in this file — writes the ring directory SYNCHRONOUSLY and
  // is never undone by the empty-PATH spawn's later failure. Capture-after-update (the bug) means the
  // loop body never runs at all: no camera found, no reconcile, no directory. Capture-before-update (the
  // fix) means it does.
  test('★ reconciles a camera that still WANTS a ring — proves the affected-camera loop actually ran', async () => {
    db.prepare('UPDATE cameras SET detect_record_clips = 1 WHERE id = ?').run('cam-1');
    assert.equal(fs.existsSync(ringDir()), false, 'precondition: nothing buffering yet');
    const res = await deleteChild(KID);
    assert.equal(res.status, 204);
    assert.equal(fs.existsSync(ringDir()), true,
      'DELETE /:id did not reconcile the affected camera — affectedCameraIds was captured AFTER the UPDATE, or the loop never ran');
  });
});
