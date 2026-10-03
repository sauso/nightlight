// #454: the frame-diff motion ALERT cooldown survives a detector relaunch, through the REAL motion detector.
//
// Before #454 the stamp of the last alert was a `let lastAlert = 0` inside launch(), so every ffmpeg relaunch (a
// camera reconnect, a transport restart, the #369 watchdog kill, the #500 return to the sub) started with a zero
// stamp and sustained motion could alert again sooner than `detect_cooldown_s` after the previous alert. It now
// lives at module level, keyed by camera id (motionDetector.js, the header over `motionAlertStamps`), clamped to
// `now` after a backward wall-clock step (`alertStampFor`), and cleared only by the camera DELETE route (that half
// is in motion-alert-cooldown-routes.test.js, which drives the real router).
//
// WHAT THIS FILE PINS, by claim (every test name starts `#454 C<n>:` so a mutant can target it by regex):
//   C1  the premise through the real launch(): alert, ffmpeg exits (code 1 and code 0), relaunch, sustained motion
//       inside the cooldown does NOT alert again;
//   C2  the cooldown still ENDS, to the millisecond: +59 999 ms is suppressed, +60 000 ms alerts, a later relaunch
//       alerts normally;
//   C3  the other restart causes keep it: the #369 watchdog kill, the #500 return to the sub (both with a 300 s
//       cooldown, see below), and a refused kill relaunches nothing;
//   C4  a startMotionDetector re-entry keeps it (what a closure-level hoist would lose);
//   C7  a changed `detect_cooldown_s` is judged against the stored START time;
//   C8  a backward wall-clock step: at most ONE cooldown of silence (the old code: the step plus a cooldown), no
//       storm of alerts, the stamp written back clamped; `alertStampFor` itself;
//   C9  `detect_confirm_s = 0` and `detect_cooldown_s = 1` across a relaunch;
//   C10 an alert the quiet-hours schedule suppressed does not stamp;
//   C11 cameras are isolated, and an activity-only leg never writes a stamp;
//   C12 #452 is not undone: after a relaunch a run still needs a full confirm time of frames;
//   C14 the return-to-sub log line no longer says the alert cooldown resets.
//
// WHY A 300 s COOLDOWN FOR THE WATCHDOG AND RETURN-TO-SUB CASES (plan review): at the default 60 s a watchdog kill
// needs >= 60 s of silence and a return to the sub needs 90 s of quiet, so those paths only matter above ~70 s /
// ~95 s. With 300 s the cases fail on the old code for the REAL reason (the zeroed stamp), not because the mocked
// `Date` is decoupled from the real-time gates (the watchdog's ages and the return check's quiet gate run on
// performance.now() and real timers).
//
// HARNESS: the motion-frame-gap.test.js one. Only `node:child_process` is mocked; the DB, the alert path and the
// logger are real; MediaMTX readiness is a real local server; `Date` is mocked and set before every stdout delivery
// (so "59 999 ms later" is one `setTime`), while setTimeout and performance.now stay REAL (the relaunch delay, shrunk
// to 30 ms through the detector's own test seam, and the watchdog/return gates run on them). The observation clock is
// switched off: this file is about the alert stamp, not about what the taps say.
//
// The `_..ForTests` store helpers are reached through `seam()`, which fails ONE test with a clear message when the
// export is missing, so running this file against code without #454 shows assertion failures, not a crash of the file.
import { test, mock, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera, makeChild } from './helpers/harness.js';
import { FakeFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

useTempDataDir();

// Paths MediaMTX answers "ready" for. A camera's own main path is added when it is created; a test flips its sub path.
const readyPaths = new Set();
// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load, so the fake must be listening first.
const mediamtx = await startFakeMediamtx({ isReady: (name) => readyPaths.has(name) });

// The monotonic clock the watchdog lever and the return check read, shifted by an offset that only grows so a
// process can be aged past the lever's 10 s minimum without waiting for it (detector-watchdog-levers.test.js).
const nativeNow = performance.now.bind(performance);
let monoOffset = 0;
performance.now = () => nativeNow() + monoOffset;

const detectorProcs = [];
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new FakeFfmpeg(command, args);
      if (args.includes('rawvideo') || args.includes('s16le')) detectorProcs.push(proc);
      else proc.finish(1); // snapshot grabs fail at once, so each alert resolves without a network
      return proc;
    },
  },
});

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const { _resetActivityTrackerForTests } = await import('../src/lib/activityTracker.js');
const motion = await import('../src/lib/motionDetector.js');
const { startMotionDetector, stopMotionDetector } = motion;
const { _setObservationClockFactoryForTests, _resetObservationClocksForTests } = await import('../src/lib/observationClock.js');

after(async () => {
  await motion.stopAllMotionDetectors();
  _resetObservationClocksForTests();
  delete performance.now; // back to Performance.prototype.now
  await mediamtx.close();
  cleanupTempDataDirs();
});
afterEach(async () => {
  motion._resetReturnTimingForTests();
  motion._resetMotionAlertsForTests?.(); // optional-call: absent on code without #454
  _resetActivityTrackerForTests();
  await motion.stopAllMotionDetectors();
});

// --- the store, through guarded accessors --------------------------------------------------------------------------
function seam(name) {
  const fn = motion[name];
  if (typeof fn !== 'function') assert.fail(`motionDetector.js does not export ${name}: the #454 alert-stamp store is missing`);
  return fn;
}
const stampOf = (id) => seam('_motionAlertStampForTests')(id);

// --- time and polling -----------------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll on the REAL clock: Date is frozen by the mock and performance.now is shifted.
async function waitFor(pred, what, capMs = 8_000) {
  const deadline = nativeNow() + capMs;
  while (!pred()) {
    if (nativeNow() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// --- frames (the detector's own geometry: 320x180 gray, one byte per pixel; no zone, so the whole frame is the zone) --
const FW = 320;
const FH = 180;
const FRAME_BYTES = FW * FH;
const BASE = 60;
const LIT = 200; // |LIT - BASE| = 140, far over the detector's PIXEL_DELTA of 24
function paint() {
  const f = Buffer.alloc(FRAME_BYTES, BASE);
  for (let y = 0; y < 60; y++) f.fill(LIT, y * FW, y * FW + 160); // 9,600 px = 16.7% of the frame: active (threshold 5.15%)
  return f;
}
const UNLIT = Buffer.alloc(FRAME_BYTES, BASE);
const LIT_BED = paint();

let seq = 0;
const camera = (id, extra = {}) => ({
  id,
  name: `Cool ${id}`,
  mediamtx_path: `path_cool_${id}`,
  sub_rtsp_url: null,
  disabled: 0,
  child_id: null,
  detect_motion_enabled: 1,
  detect_source: 'framediff',
  detect_sensitivity: 50,
  detect_confirm_s: 3,
  detect_cooldown_s: 60,
  detect_zone: null,
  detect_schedule_enabled: 0,
  detect_record_clips: 0,
  snapshot_url: null,
  ...extra,
});
const urlOf = (p) => `rtsp://127.0.0.1:8554/${p}`;
const uniq = (label) => `${label}-${++seq}`;

// Starts a detector (observation clock OFF, relaunch delay shrunk) and returns a rig to drive it. Frames go to
// whichever ffmpeg process is the camera's CURRENT one, so the same rig keeps working across relaunches.
//   feed(at, frame)  sets the mocked clock to `at`, then delivers one frame
//   baseline(at)     an unlit frame: the FIRST frame of a process (no diff is taken against nothing)
//   active(at)       a frame that DIFFERS from the previous one (lit/unlit alternately), quiet(at) repeats it
//   burst(endAt)     a baseline then 5 fps of active frames, the run's confirm time elapsing at exactly `endAt` (for the
//                    default 3 s confirm time). Its baseline is an UNLIT frame: on a process whose last picture was lit
//                    that frame is itself a (very first) active one, so use it on a fresh process or after a burst
//                    (which ends on an unlit frame)
async function rig(t, cam, { first = true, timing = {} } = {}) {
  if (first) {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    logger.clear();
    _resetObservationClocksForTests();
    _setObservationClockFactoryForTests(() => null);
    t.after(() => _setObservationClockFactoryForTests(null));
  }
  motion._setReturnTimingForTests({ restartDelayMs: 30, ...timing });
  readyPaths.add(cam.mediamtx_path);
  makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
  const mine = (p) => {
    const url = p.args[p.args.indexOf('-i') + 1];
    return url === urlOf(cam.mediamtx_path) || url === urlOf(`${cam.mediamtx_path}-sub`);
  };
  const cur = () => detectorProcs.filter((p) => mine(p) && !p.ended).at(-1);
  await startMotionDetector(cam);
  // A camera with a sub waits out SUB_GRACE_MS on the (mocked) Date before settling for main: step past it.
  if (cam.sub_rtsp_url) t.mock.timers.setTime(T0 + 10_000);
  await waitFor(() => cur() !== undefined, `${cam.id} spawn`);
  t.after(async () => { await stopMotionDetector(cam.id); await settle(); });
  let current = UNLIT;
  const feed = (at, frame) => {
    t.mock.timers.setTime(at);
    cur().stdout.emit('data', frame);
  };
  const lines = (needle) => logger.getRecent().map((l) => l.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /, '')).filter((l) => l.includes(needle) && l.includes(cam.name));
  const g = {
    cur,
    feed,
    baseline: (at) => { current = UNLIT; feed(at, current); },
    active: (at) => { current = current === LIT_BED ? UNLIT : LIT_BED; feed(at, current); },
    quiet: (at) => feed(at, current),
    burst: (endAt) => {
      g.baseline(endAt - 3200);
      for (let at = endAt - 3000; at <= endAt; at += 200) g.active(at);
    },
    lines,
    // Alerts so far, read two ways that must agree: the decision log line and the stored event.
    alerts: async () => { await settle(); return lines('motion on "').length; },
    rows: async () => { await settle(); return db.prepare("SELECT COUNT(*) AS c FROM detection_events WHERE camera_id = ? AND type = 'motion'").get(cam.id).c; },
    // Ends the current process (as ffmpeg exiting does) and waits for the exit handler's relaunch.
    relaunch: async (code = 1) => {
      const old = cur();
      old.finish(code);
      await waitFor(() => cur() !== undefined && cur() !== old, `${cam.id} relaunch`);
    },
    // Waits for a process other than `old` (a kill, a re-entry) to be the camera's current one.
    replacedBy: async (old) => waitFor(() => cur() !== undefined && cur() !== old, `${cam.id} replacement`),
  };
  return g;
}

describe('#454 the frame-diff alert cooldown across a detector relaunch', { concurrency: false }, () => {
  // ---- C1 ----
  for (const code of [1, 0]) {
    test(`#454 C1: an ffmpeg exit (code ${code}${code === 0 ? ', "stream ended"' : ''}) and relaunch inside the cooldown: sustained motion does NOT alert again`, async (t) => {
      const cam = camera(uniq('c1'));
      const g = await rig(t, cam);
      g.burst(T0 + 3200);
      assert.equal(await g.alerts(), 1, 'premise: the first run alerts at its confirm time');
      await g.relaunch(code);
      g.burst(T0 + 3200 + 20_000); // a full confirm time of fresh frames, 20 s after the alert: inside the 60 s cooldown
      assert.equal(await g.alerts(), 1, 'a relaunched detector alerted again 20 s after the last alert (the cooldown was reset by the relaunch)');
      assert.equal(await g.rows(), 1, 'the second alert was also recorded as a detection event');
    });
  }

  // ---- C2 ----
  test('#454 C2: 59 999 ms after the alert, a relaunched detector is still suppressed', async (t) => {
    const g = await rig(t, camera(uniq('c2a')));
    g.burst(T0 + 3200);
    const alertAt = T0 + 3200;
    await g.relaunch();
    g.burst(alertAt + 59_999);
    assert.equal(await g.alerts(), 1, '59 999 ms is inside the 60 s cooldown');
    g.active(alertAt + 60_000); // the same run, one millisecond later
    assert.equal(await g.alerts(), 2, 'exactly 60 000 ms after the alert it may alert again');
  });

  test('#454 C2: exactly 60 000 ms after the alert it alerts (>= not >), and a LATER relaunch alerts normally', async (t) => {
    const g = await rig(t, camera(uniq('c2b')));
    g.burst(T0 + 3200);
    const alertAt = T0 + 3200;
    await g.relaunch();
    g.burst(alertAt + 60_000);
    assert.equal(await g.alerts(), 2, 'a run whose confirm time elapses exactly one cooldown after the alert alerts');
    await g.relaunch(0);
    g.burst(alertAt + 60_000 + 61_000);
    assert.equal(await g.alerts(), 3, 'a relaunch more than a cooldown after the last alert alerts normally');
  });

  // ---- C3 ----
  // The ages the lever judges are on performance.now(): aged by hand, not waited for (detector-watchdog-levers.test.js).
  const OLD_ENOUGH_MS = 11_000;
  const tokens = (h) => ({ expectSpawn: h.spawnedMono, expectLastData: h.lastDataMono });
  const ageTo = (health, ms) => { monoOffset += Math.max(0, ms - health.spawnAgeMs); };

  test('#454 C3: the #369 watchdog kill keeps the cooldown (300 s cooldown)', async (t) => {
    const cam = camera(uniq('c3wd'), { detect_cooldown_s: 300 });
    const g = await rig(t, cam);
    g.burst(T0 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    const old = g.cur();
    ageTo(motion.getMotionDetectorHealth(cam.id), OLD_ENOUGH_MS);
    assert.equal(motion.restartMotionDetector(cam.id, tokens(motion.getMotionDetectorHealth(cam.id))), true, 'the lever refused');
    await g.replacedBy(old);
    // (that line names the path, not the camera, so `g.lines` would not see it)
    assert.equal(
      logger.getRecent().filter((l) => l.includes(`[detect:${cam.mediamtx_path}] stopped by the detector watchdog`)).length, 1,
      'the relaunch did not go through the watchdog-kill path'
    );
    g.burst(T0 + 3200 + 20_000); // 20 s after the alert, inside the 300 s cooldown
    assert.equal(await g.alerts(), 1, 'a relaunch after a watchdog kill alerted inside the cooldown');
  });

  test('#454 C3: a return from main to the sub keeps the cooldown (300 s cooldown)', async (t) => {
    const cam = camera(uniq('c3rs'), { detect_cooldown_s: 300, sub_rtsp_url: 'rtsp://192.0.2.10:554/sub' });
    const subPath = `${cam.mediamtx_path}-sub`;
    const g = await rig(t, cam, { timing: { subGraceMs: 150, readyPollMs: 20, recheckMs: 40, stableChecks: 2, quietMs: 120, minGapMs: 0 } });
    const onMain = g.cur();
    assert.ok(onMain.args.includes(urlOf(cam.mediamtx_path)), 'premise: the detector settled for the main stream (the sub is not ready)');
    g.burst(T0 + 30_000 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    readyPaths.add(subPath); // the sub comes back: after 2 ready checks and 120 ms of quiet it relaunches itself
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the return to the sub');
    await g.replacedBy(onMain);
    assert.ok(g.cur().args.includes(urlOf(subPath)), 'the relaunch read the sub');
    g.burst(T0 + 30_000 + 3200 + 20_000);
    assert.equal(await g.alerts(), 1, 'the detector alerted again 20 s after the last alert because it switched streams');
    readyPaths.delete(subPath);
  });

  test('#454 C3: a refused watchdog kill (the process is too young) relaunches nothing and leaves the stamp alone', async (t) => {
    const cam = camera(uniq('c3ref'));
    const g = await rig(t, cam);
    g.burst(T0 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    const before = detectorProcs.length;
    assert.equal(motion.restartMotionDetector(cam.id, tokens(motion.getMotionDetectorHealth(cam.id))), false, 'a just-spawned process was killed');
    await sleep(200); // many times the shrunk 30 ms relaunch delay
    assert.equal(detectorProcs.length, before, 'a refused kill relaunched the detector');
    // The same process carries on, and the stamp must still be the ALERT's time: the cooldown ends exactly one
    // cooldown after it, not later (a refused kill that moved the stamp would push that out). Frames every 1.4 s
    // (under the 1.5 s gap floor) keep it one run. A control: it holds with or without #454.
    const alertAt = T0 + 3200;
    for (let at = alertAt + 200; at <= alertAt + 59_000; at += 1400) g.active(at);
    g.active(alertAt + 59_999);
    assert.equal(await g.alerts(), 1, 'inside the cooldown');
    g.active(alertAt + 60_000);
    assert.equal(await g.alerts(), 2, 'the cooldown ended exactly one cooldown after the alert');
  });

  // ---- C4 ----
  test('#454 C4: a re-entry on a LIVE detector (a settings save) keeps the cooldown', async (t) => {
    const cam = camera(uniq('c4a'));
    const g = await rig(t, cam);
    g.burst(T0 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    const old = g.cur();
    await startMotionDetector({ ...cam }); // what a detection PUT, a rename, an assign or an enable does
    await g.replacedBy(old);
    g.burst(T0 + 3200 + 20_000);
    assert.equal(await g.alerts(), 1, 'a re-entered startMotionDetector alerted inside the cooldown (the stamp lived in the closure)');
  });

  test('#454 C4: a re-entry inside the 5 s relaunch GAP (the reconcile tick that lands there) keeps the cooldown', async (t) => {
    const cam = camera(uniq('c4b'));
    const g = await rig(t, cam, { timing: { restartDelayMs: 5_000 } }); // a gap long enough to land in on purpose
    g.burst(T0 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    const old = g.cur();
    old.finish(1);
    await settle(); // the exit handler has run and armed its relaunch timer
    assert.equal(g.cur(), undefined, 'premise: the detector is in the relaunch gap');
    await startMotionDetector({ ...cam }); // cancels the pending relaunch and builds a NEW closure
    await g.replacedBy(old);
    g.burst(T0 + 3200 + 20_000);
    assert.equal(await g.alerts(), 1, 'a start inside the relaunch gap alerted inside the cooldown');
  });

  // ---- C7 ----
  test('#454 C7: a cooldown RAISED from 60 s to 120 s is judged against the stored START: still suppressed at +90 s', async (t) => {
    const cam = camera(uniq('c7a'), { detect_cooldown_s: 60 });
    const g = await rig(t, cam);
    g.burst(T0 + 3200);
    const alertAt = T0 + 3200;
    const old = g.cur();
    await startMotionDetector({ ...cam, detect_cooldown_s: 120 });
    await g.replacedBy(old);
    g.burst(alertAt + 90_000);
    assert.equal(await g.alerts(), 1, '90 s is inside the NEW 120 s cooldown');
    g.burst(alertAt + 120_000); // a new run (the 30 s of silence is a gap, #452), whose confirm time elapses at +120 s
    assert.equal(await g.alerts(), 2, '120 s after the alert the new cooldown has elapsed');
  });

  test('#454 C7: a cooldown LOWERED from 120 s to 60 s alerts at +90 s (the stored time against the new cooldown)', async (t) => {
    const cam = camera(uniq('c7b'), { detect_cooldown_s: 120 });
    const g = await rig(t, cam);
    g.burst(T0 + 3200);
    const alertAt = T0 + 3200;
    const old = g.cur();
    await startMotionDetector({ ...cam, detect_cooldown_s: 60 });
    await g.replacedBy(old);
    g.burst(alertAt + 90_000);
    assert.equal(await g.alerts(), 2, '90 s is past the NEW 60 s cooldown');
  });

  // ---- C8 ----
  test('#454 C8: alertStampFor: never alerted -> 0; a past stamp is kept; equal to now stays; ahead of now is clamped to now', () => {
    const alertStampFor = seam('alertStampFor');
    assert.equal(alertStampFor(null, 500), 0, 'null: never alerted');
    assert.equal(alertStampFor(undefined, 500), 0, 'undefined: never alerted');
    assert.equal(alertStampFor(100, 500), 100, 'a past stamp is the stamp');
    assert.equal(alertStampFor(500, 500), 500, 'equal to now: kept, so a frame in the same millisecond is still inside the cooldown');
    assert.equal(alertStampFor(1000, 500), 500, 'ahead of now (the clock stepped back): clamped to now, NOT treated as "never alerted"');
    assert.equal(alertStampFor(0, 500), 0, 'a stored 0 is a stamp, not "absent"');
  });

  test('#454 C8: after the wall clock steps BACK an hour, the cooldown is ONE cooldown from the step (not the step plus a cooldown)', async (t) => {
    const g = await rig(t, camera(uniq('c8step')));
    g.burst(T0 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    const step = T0 + 3200 - 3_600_000; // the clock now says an hour BEFORE the alert
    g.quiet(step); // the first frame after the step
    // A sustained run from just after the step. Frames every 1.4 s (under the 1.5 s gap floor) keep it ONE run.
    for (let at = step + 200; at <= step + 59_000; at += 1400) g.active(at);
    g.active(step + 59_999);
    assert.equal(await g.alerts(), 1, '59 999 ms after the step is inside one cooldown');
    g.active(step + 60_000);
    assert.equal(await g.alerts(), 2, 'one cooldown after the step it alerts (before the fix the stamp, an hour ahead, kept it silent for an hour)');
  });

  test('#454 C8: the stamp ahead of now is clamped to now and WRITTEN BACK on the first frame after the step, and the next alert stamps the stepped clock', async (t) => {
    const cam = camera(uniq('c8wb'));
    const g = await rig(t, cam);
    g.burst(T0 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    assert.equal(stampOf(cam.id), T0 + 3200, 'premise: the alert stamped its own time');
    const step = T0 + 3200 - 3_600_000;
    g.quiet(step);
    assert.equal(stampOf(cam.id), step, 'the stamp ahead of now was not clamped to now (and written back) on the first frame after the step');
    for (let at = step + 200; at <= step + 59_000; at += 1400) g.active(at);
    g.active(step + 60_000);
    assert.equal(await g.alerts(), 2);
    assert.equal(stampOf(cam.id), step + 60_000, 'the new alert is stamped with the (stepped) clock');
  });

  test('#454 C8: repeated backward steps with detect_confirm_s = 0 fire nothing extra (clamp to now, never "no previous alert")', async (t) => {
    const cam = camera(uniq('c8storm'), { detect_confirm_s: 0 });
    const g = await rig(t, cam);
    g.baseline(T0);
    g.active(T0 + 200);
    assert.equal(await g.alerts(), 1, 'premise: confirm 0 alerts on the first active frame');
    g.active(T0 + 200); // the same millisecond: the stamp equals now, still inside the cooldown
    assert.equal(await g.alerts(), 1, 'a frame in the SAME millisecond as the alert alerted again');
    // The clock steps back a second on every frame. A future stamp read as "no previous alert" would alert on all 25.
    for (let k = 1; k <= 25; k++) g.active(T0 + 200 - 1000 * k);
    assert.equal(await g.alerts(), 1, 'a clock stepping back on every frame produced extra alerts');
    assert.equal(await g.rows(), 1);
  });

  // ---- C9 ----
  test('#454 C9: detect_confirm_s = 0: the first active frame after a relaunch alerts at once IF the cooldown has elapsed', async (t) => {
    const g = await rig(t, camera(uniq('c9a'), { detect_confirm_s: 0 }));
    g.baseline(T0);
    g.active(T0 + 200);
    assert.equal(await g.alerts(), 1, 'premise');
    await g.relaunch();
    g.baseline(T0 + 100_000);
    g.active(T0 + 100_200); // 100 s after the alert: past the 60 s cooldown
    assert.equal(await g.alerts(), 2, 'cooldown elapsed across the relaunch: the first active frame alerts at once');
  });

  test('#454 C9: detect_confirm_s = 0: the first active frame after a relaunch does NOT alert while the cooldown has not elapsed', async (t) => {
    const g = await rig(t, camera(uniq('c9b'), { detect_confirm_s: 0 }));
    g.baseline(T0);
    g.active(T0 + 200);
    assert.equal(await g.alerts(), 1, 'premise');
    await g.relaunch();
    g.baseline(T0 + 10_000);
    g.active(T0 + 10_200); // 10 s after the alert
    assert.equal(await g.alerts(), 1, 'confirm 0 alerted at once inside the cooldown after a relaunch');
  });

  test('#454 C9: detect_cooldown_s = 1 is honoured across a relaunch, and never lasts longer than set', async (t) => {
    const g = await rig(t, camera(uniq('c9c'), { detect_confirm_s: 0, detect_cooldown_s: 1 }));
    g.baseline(T0);
    g.active(T0 + 200);
    assert.equal(await g.alerts(), 1, 'premise');
    await g.relaunch();
    g.baseline(T0 + 500);
    g.active(T0 + 1199); // 999 ms after the alert
    assert.equal(await g.alerts(), 1, '999 ms is inside a 1 s cooldown');
    g.active(T0 + 1200); // exactly 1000 ms after
    assert.equal(await g.alerts(), 2, 'a 1 s cooldown ended at exactly 1 s');
  });

  // ---- C10 ----
  test('#454 C10: an alert the quiet-hours schedule suppressed does not stamp, so one can fire promptly when the window opens (across a relaunch)', async (t) => {
    // Window 12:05-13:00 UTC (the app timezone defaults to UTC). The cooldown is an hour, so a stamp written at the
    // suppressed alert (12:00:03) would still be in force at 12:05.
    const cam = camera(uniq('c10'), { detect_schedule_enabled: 1, detect_start: 12 * 60 + 5, detect_end: 13 * 60, detect_cooldown_s: 3600 });
    const g = await rig(t, cam);
    g.burst(T0 + 3200); // would alert, but the window is closed
    assert.equal(await g.alerts(), 0, 'premise: nothing alerts outside the schedule');
    await g.relaunch();
    g.burst(T0 + 5 * 60_000 + 3200); // the window opened at 12:05:00
    assert.equal(await g.alerts(), 1, 'the first run inside the window alerts promptly: a suppressed alert wrote a stamp that is still in force');
  });

  // ---- C11 ----
  test('#454 C11: another camera alerts at once while this one is in its cooldown (the stamp is per camera)', async (t) => {
    const a = camera(uniq('c11a'));
    const b = camera(uniq('c11b'));
    const ga = await rig(t, a);
    const gb = await rig(t, b, { first: false });
    ga.burst(T0 + 3200);
    assert.equal(await ga.alerts(), 1, 'premise: A alerted');
    gb.burst(T0 + 3200 + 5_000); // 5 s later, inside A's cooldown
    assert.equal(await gb.alerts(), 1, 'camera B was suppressed by camera A\'s alert');
    assert.equal(await ga.alerts(), 1, 'camera A alerted again');
  });

  test('#454 C11: an activity-only leg (MQTT source, sleep tracking) never writes a stamp', async (t) => {
    // One always-open child so the sleep-tracking-only leg is wanted whatever the date is (motion-return-to-sub.test.js).
    const childId = uniq('kid');
    makeChild(db, { id: childId, name: 'Cooldown Child', start: '00:00', end: '23:59' });
    const cam = camera(uniq('c11act'), { detect_source: 'mqtt', child_id: childId });
    const g = await rig(t, cam);
    g.baseline(T0);
    for (let at = T0 + 200; at <= T0 + 4000; at += 200) g.active(at); // plenty of motion, 4 s of it
    assert.equal(await g.alerts(), 0, 'premise: an activity-only leg fires no alerts');
    // The probe is behavioural: the same camera is switched to the alerting source a few seconds later. If the
    // activity-only leg had stamped, its first alert would be suppressed (the cooldown is 60 s).
    const old = g.cur();
    await startMotionDetector({ ...cam, detect_source: 'framediff', child_id: null });
    await g.replacedBy(old);
    g.burst(T0 + 4000 + 8000);
    assert.equal(await g.alerts(), 1, 'the first alert after an activity-only stretch was suppressed: the activity-only leg wrote a stamp');
  });

  // ---- C12 ----
  test('#454 C12: after a relaunch a run still needs a FULL confirm time of frames (#452 is not undone by a surviving stamp)', async (t) => {
    const g = await rig(t, camera(uniq('c12')));
    g.burst(T0 + 3200);
    assert.equal(await g.alerts(), 1, 'premise');
    await g.relaunch();
    const end = T0 + 3200 + 70_000; // well past the cooldown
    g.baseline(end - 3200);
    for (let at = end - 3000; at < end; at += 200) g.active(at); // 2.8 s of the run
    assert.equal(await g.alerts(), 1, 'a run of 2.8 s alerted on a relaunched detector');
    g.active(end);
    assert.equal(await g.alerts(), 2, 'a full 3 s confirms it');
  });

  // ---- C14 ----
  test('#454 C14: the return-to-sub log line says the alert cooldown carries over (it used to say the state reset)', async (t) => {
    const cam = camera(uniq('c14'), { sub_rtsp_url: 'rtsp://192.0.2.10:554/sub' });
    const subPath = `${cam.mediamtx_path}-sub`;
    const g = await rig(t, cam, { timing: { subGraceMs: 150, readyPollMs: 20, recheckMs: 40, stableChecks: 2, quietMs: 120, minGapMs: 0 } });
    const onMain = g.cur();
    readyPaths.add(subPath);
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the return to the sub');
    const found = g.lines('returning the motion detector from main to sub');
    assert.equal(found.length, 1);
    assert.ok(found[0].includes('the alert cooldown carries over'), `the switch line does not say the cooldown carries over: ${found[0]}`);
    assert.ok(found[0].includes('the bed-transition state resets'), `the switch line lost the bed-transition half: ${found[0]}`);
    assert.ok(!found[0].includes('alert-cooldown state reset'), `the switch line still claims the alert cooldown resets: ${found[0]}`);
    readyPaths.delete(subPath);
  });
});
