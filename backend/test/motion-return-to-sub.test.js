// #500: a motion detector that fell back to the MAIN stream (the sub was not ready within SUB_GRACE_MS) used to
// stay on it until its ffmpeg next exited: nothing re-evaluated the choice. It now polls the sub and, once the
// sub has been ready for a stable stretch AND the room has been quiet, relaunches itself onto the sub through
// the ordinary exit-handler relaunch. This file drives the REAL detector against a fake ffmpeg and a fake,
// scriptable MediaMTX; see the plan's R1..R9 (each case below carries its id).
//
// HOW (the restart-cancellation.test.js / detector-observation-wiring.test.js pattern):
//   * ffmpeg is faked by mocking `node:child_process` ONLY (not in test:core's include list: mocking an included
//     module corrupts coverage suite-wide). processGuards.js, which IS in that list, is imported for real.
//   * MediaMTX is a real local HTTP server whose per-path answers the test scripts (helpers/fakeFfmpeg.js).
//   * TIME. The production timings (45 s grace, 20 s checks, 90 s quiet, 5 s relaunch) are shrunk through the
//     detector's own test seam to tens of milliseconds, so every case runs in real time and takes about a second.
//     The seam is reset after every case; the cases that pin production defaults never set it.
//   * The #500 claim being tested is named in each case. A case that passes with its fix removed is worthless,
//     so scripts/mutants.json carries a mutant per claim, including a CONTROL that arms nothing, which R1 must kill.
import { test, mock, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera, makeChild } from './helpers/harness.js';
import { FakeFfmpeg, WedgedFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

useTempDataDir();

// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load (see helpers/fakeFfmpeg.js).
// Per-path answers. `queue` is consumed first (one entry per request), then `dflt` answers forever. An entry is
// true / false / 'hang' (never answers: with the API timeout shrunk it becomes a real `unknown`) / { ready, delayMs }.
const answers = new Map();
const requests = []; // every /v3/paths/get/<name> the detector made, in order
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mediamtx = await startFakeMediamtx({
  isReady: (name) => {
    requests.push(name);
    const a = answers.get(name);
    if (!a) return false;
    if (a.queue.length) {
      const v = a.queue.shift();
      if (v && typeof v === 'object') return sleep(v.delayMs).then(() => v.ready);
      return v;
    }
    return a.dflt;
  },
});

const procs = [];
const wedged = new Set(); // input URLs whose NEXT detector spawn ignores SIGTERM
const pidless = new Set(); // input URLs whose NEXT detector spawn never really started (no pid, #257)
const exitCodes = new Map(); // input URL -> the code a SIGTERM makes the fake exit with (default: null + signal)
class ExitsWith extends FakeFfmpeg {
  constructor(command, args, code) { super(command, args); this.code = code; }
  kill(signal) { this.signals.push(signal); this.finish(this.code, null); return true; }
}
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const isDetector = args.includes('rawvideo') || args.includes('s16le');
      const url = args[args.indexOf('-i') + 1];
      let proc;
      if (isDetector && wedged.delete(url)) proc = new WedgedFfmpeg(command, args);
      else if (isDetector && exitCodes.has(url)) proc = new ExitsWith(command, args, exitCodes.get(url));
      else proc = new FakeFfmpeg(command, args);
      if (isDetector && pidless.delete(url)) proc.pid = undefined;
      if (isDetector) procs.push(proc);
      else proc.finish(1); // snapshot grabs and the like: fail at once, no network
      return proc;
    },
  },
});

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const motion = await import('../src/lib/motionDetector.js');
const { killStalledDetector } = await import('../src/lib/processGuards.js');
const { createDetectorWatchdog } = await import('../src/lib/cameraWatchdogs.js');
const { setMediamtxApiTimeoutForTest } = await import('../src/lib/mediamtx.js');
const { _setObservationClockFactoryForTests, _resetObservationClocksForTests } = await import('../src/lib/observationClock.js');
const { createBedTransitionTracker, OOB_CONFIRM_QUIET_MS } = await import('../src/lib/bedTransitionTracker.js');
const { OOB_LINK_SLOW_MS } = await import('../src/lib/bedTransitionRules.js');

// No observation clock: this file is about which stream is read, not about what the taps say.
_setObservationClockFactoryForTests(() => null);

// The monotonic clock the detector and the watchdog lever read, shifted by an offset that only grows, so the one
// case that needs a process "older than MIN_KILL_AGE_MS" (the lever refuses a younger one) need not wait 10 s
// (the detector-watchdog-levers.test.js technique). The test's own waits use the NATIVE clock.
const nativeNow = performance.now.bind(performance);
let monoOffset = 0;
// #609: a case that has to pin a quiet-gate BOUNDARY must not let real time move it. `frozenMono`, when set, IS the
// monotonic clock until the case sets another value or `afterEach` clears it (null = the offset clock above). The
// case then advances logical time by hand and only waits for real timer ticks, so a loaded machine cannot change
// what it measures.
let frozenMono = null;
performance.now = () => (frozenMono ?? nativeNow() + monoOffset);

after(async () => {
  await motion.stopAllMotionDetectors();
  _resetObservationClocksForTests();
  delete performance.now; // back to Performance.prototype.now
  await mediamtx.close();
  cleanupTempDataDirs();
});
afterEach(async () => {
  frozenMono = null;
  motion._resetReturnTimingForTests();
  setMediamtxApiTimeoutForTest(null);
  await motion.stopAllMotionDetectors();
});

// --- helpers ------------------------------------------------------------------------------------------------
const realNow = () => nativeNow();
async function waitFor(pred, what, capMs = 6_000) {
  const deadline = realNow() + capMs;
  while (!pred()) {
    if (realNow() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
const urlOf = (p) => `rtsp://127.0.0.1:8554/${p}`;
const procsFor = (p) => procs.filter((x) => x.args.includes(urlOf(p)));
const linesFor = (needle) => logger.getRecent().filter((l) => l.includes(needle));

// Production shrunk by ~1000x. NO minGapMs on purpose: a case that does not set one runs the real 10-minute gap,
// which is what proves the first return after a start is not blocked by it (`lastSwitchMono` starts null).
const FAST = { subGraceMs: 150, readyPollMs: 20, restartDelayMs: 30, recheckMs: 40, stableChecks: 2, quietMs: 100 };
const fast = (over = {}) => motion._setReturnTimingForTests({ ...FAST, ...over });

const MAIN = (id) => `path_${id}`;
const SUB = (id) => `path_${id}-sub`;
function setAnswers(id, { main = true, sub = false } = {}) {
  answers.set(MAIN(id), { queue: [], dflt: main });
  answers.set(SUB(id), { queue: [], dflt: sub });
}
const subAnswers = (id) => answers.get(SUB(id));

// One always-open child so an activity-only (sleep-tracking-only) leg is wanted whatever the date is.
makeChild(db, { id: 'kid-ret', name: 'Return Child', start: '00:00', end: '23:59' });
const ZONE = JSON.stringify([{ x: 0, y: 0, w: 0.5, h: 1 }]); // the bed is the LEFT half
// #368: a zone painted over the WHOLE frame. buildZoneMask returns a real mask of 57 600 px (checked), so there is no
// "outside" (outPixels = 0) and no tracker: it must behave as the unzoned leg. `zone: 'whole'` selects it.
const WHOLE_FRAME_ZONE = JSON.stringify([{ x: 0, y: 0, w: 1, h: 1 }]);
// `sens` (#368): the stored motion sensitivity, default 50. It only sets the ALERT threshold now; the quiet gate also
// reads the fixed transition threshold (see the #368 tests below).
function camera(id, { sub = true, activityOnly = false, zone = false, sens = 50 } = {}) {
  makeCamera(db, { id, name: `Ret ${id}`, path: MAIN(id) });
  return {
    id,
    name: `Ret ${id}`,
    mediamtx_path: MAIN(id),
    sub_rtsp_url: sub ? 'rtsp://192.0.2.10:554/sub' : null,
    rtsp_url: 'rtsp://192.0.2.10:554/main',
    disabled: 0,
    child_id: activityOnly ? 'kid-ret' : null,
    detect_motion_enabled: 1,
    // 'mqtt' = the camera alerts elsewhere, so this leg is activity-only (the sleep sampler): no alert bookkeeping.
    detect_source: activityOnly ? 'mqtt' : 'framediff',
    detect_sensitivity: sens,
    detect_confirm_s: 3,
    detect_cooldown_s: 60,
    detect_zone: zone === 'whole' ? WHOLE_FRAME_ZONE : zone ? ZONE : null,
    detect_schedule_enabled: 0,
    detect_record_clips: 0,
    snapshot_url: null,
  };
}

// Start `cam` with the sub NOT ready and the main ready, and wait for the detector to settle for main (after the
// shrunk grace). Returns the live main process.
async function startOnMain(cam) {
  setAnswers(cam.id, { main: true, sub: false });
  await motion.startMotionDetector(cam);
  await waitFor(() => procsFor(MAIN(cam.id)).length === 1, `${cam.id}: the main-stream ffmpeg to spawn`);
  assert.equal(procsFor(SUB(cam.id)).length, 0, 'it spawned on the sub although the sub was not ready');
  return procsFor(MAIN(cam.id))[0];
}

// Frames: the detector's own geometry, 320x180 gray. Regions: bed = rows 0-59 of the left half (33% of the zone,
// active), out = rows 0-39 of the right half (22% of the outside, active). Alternating lit/unlit frames make every
// frame differ from the one before it.
const FW = 320; const FH = 180; const FRAME_BYTES = FW * FH;
const BASE = 60; const LIT = 200;
// #368: `bedPx` / `outPx` / `allPx` light an EXACT number of pixels (row by row, in the left half / the right half / the
// whole frame), for the cases that live between the alert threshold and the fixed transition threshold. Against the zone
// of 28 800 px (the left half): 144 px = 0.5 %, 864 px = 3 %; the unzoned frame is 57 600 px: 1 728 px = 3 %.
function paint({ bed = false, out = false, all = false, bedPx = 0, outPx = 0, allPx = 0 }) {
  const f = Buffer.alloc(FRAME_BYTES, BASE);
  const fill = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) f.fill(LIT, y * FW + x0, y * FW + x1); };
  const lit = (x0, w, n) => { for (let i = 0; i < n; i++) f[Math.floor(i / w) * FW + x0 + (i % w)] = LIT; };
  if (all) fill(0, FW, 0, FH); // the whole frame: what an UNZONED camera sees as motion
  if (bed) fill(0, 160, 0, 60);
  if (out) fill(160, 320, 0, 40);
  lit(0, 160, bedPx);
  lit(160, 160, outPx);
  lit(0, FW, allPx);
  return f;
}
// Emit moving frames for `ms` of real time (one every 25 ms), then return the time of the last one.
async function moveFor(proc, ms, region) {
  const end = realNow() + ms;
  let k = 0;
  let last = realNow();
  while (realNow() < end) {
    proc.stdout.emit('data', paint(k % 2 === 0 ? region : {}));
    last = realNow();
    k += 1;
    await sleep(25);
  }
  return last;
}

// ================================================================================================================
describe('#500: returning from main to the sub', { concurrency: false }, () => {
  test('#500 R1 (regression): sub down past the grace -> main; sub back -> the detector relaunches itself onto the sub', async () => {
    fast(); // production minGapMs: also proves the FIRST return is not blocked by the 10-minute gap
    const cam = camera('r1');
    const onMain = await startOnMain(cam);
    // Still on main while the sub stays down, over several re-checks (it must not flap or loop).
    await sleep(250);
    assert.deepEqual(onMain.signals, [], 'the detector was signalled while the sub was still down');
    assert.equal(motion._returnTimerCountForTests(), 1, 'a detector on main did not arm its return check');

    subAnswers(cam.id).dflt = true;
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the SIGTERM that returns it to the sub');
    await waitFor(() => procsFor(SUB(cam.id)).length === 1, 'the relaunch onto the sub');
    // The relaunch read the SUB, the original the MAIN, and nothing looped.
    assert.ok(procsFor(SUB(cam.id))[0].args.includes(urlOf(SUB(cam.id))));
    assert.ok(onMain.args.includes(urlOf(MAIN(cam.id))) && !onMain.args.includes(urlOf(SUB(cam.id))));
    await sleep(300);
    assert.equal(procsFor(MAIN(cam.id)).length, 1, 'it went back to main');
    assert.equal(procsFor(SUB(cam.id)).length, 1, 'a second relaunch happened');
    assert.deepEqual(onMain.signals, ['SIGTERM'], 'one return = exactly one signal');
    assert.equal(motion._returnTimerCountForTests(), 0, 'a detector on the sub still has a return timer');
  });

  test('#500 R5: a camera with no sub, and a detector already on the sub, make no readiness requests and arm no timer', async () => {
    fast();
    const noSub = camera('r5a', { sub: false });
    setAnswers(noSub.id, { main: true });
    await motion.startMotionDetector(noSub);
    await waitFor(() => procsFor(MAIN(noSub.id)).length === 1, 'r5a spawn');
    const onSub = camera('r5b');
    setAnswers(onSub.id, { main: true, sub: true });
    await motion.startMotionDetector(onSub);
    await waitFor(() => procsFor(SUB(onSub.id)).length === 1, 'r5b spawn on the sub');
    requests.length = 0; // after the spawns: pickReadyPath's own polls are not under test
    await sleep(300); // seven checks' worth
    // ANY name: a `fellBack` that forgot the `sub != null` guard would poll `.../null`, which a sub-only count misses.
    assert.deepEqual(requests, [], `the return check polled MediaMTX: ${requests.join(', ')}`);
    assert.equal(motion._returnTimerCountForTests(), 0);
  });

  test('#500 R3: only an UNBROKEN run of ready samples switches (not-ready, an unknown and a skipped tick each break it)', async () => {
    fast({ stableChecks: 3 });
    const cam = camera('r3');
    const onMain = await startOnMain(cam);
    // 2 ready, a not-ready, 2 ready, a not-ready, 2 ready: the run never reaches 3.
    subAnswers(cam.id).queue = [true, true, false, true, true, false, true, true];
    await sleep(40 * 10 + 100);
    assert.deepEqual(onMain.signals, [], 'a broken run switched');

    // An UNKNOWN (the API timed out): MediaMTX never answers, the client's deadline turns that into
    // { ready: false, unknown: true } (lib/mediamtx.js). 2 ready, unknown, 2 ready: still no switch.
    setMediamtxApiTimeoutForTest(20);
    subAnswers(cam.id).queue = [true, true, 'hang', true, true];
    await sleep(40 * 8 + 100);
    assert.deepEqual(onMain.signals, [], 'an unknown counted as ready');

    // And the positive control: three consecutive ready samples DO switch.
    setMediamtxApiTimeoutForTest(null);
    subAnswers(cam.id).dflt = true;
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the switch after an unbroken run');
  });

  test('#500 R3b: a slow answer that lands after the next tick started is a skipped observation and does not extend the run', async () => {
    fast({ stableChecks: 1 });
    const cam = camera('r3b');
    const onMain = await startOnMain(cam);
    // ONE ready answer that takes 150 ms, three ticks long. With a single sample enough to switch, honouring it
    // would switch at once; as a skipped observation it must be discarded, and everything after it is not ready.
    subAnswers(cam.id).queue = [{ ready: true, delayMs: 150 }];
    await sleep(500);
    assert.deepEqual(onMain.signals, [], 'a skipped (overlapped) tick extended the run');
    // Control: the same single sample, answered at once, switches.
    subAnswers(cam.id).dflt = true;
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'a prompt ready sample did not switch');
  });

  test('#500 R3c: a skipped tick breaks a run that was ALREADY under way, not only a fresh one', async () => {
    fast({ stableChecks: 2 });
    const cam = camera('r3c');
    const onMain = await startOnMain(cam);
    // ready (run 1), then a ready answer that takes 150 ms and overlaps three ticks (so it is discarded), then a
    // ready. Honouring the slow one would make 2 and switch; discarding it leaves the last ready at 1.
    subAnswers(cam.id).queue = [true, { ready: true, delayMs: 150 }, true];
    await sleep(600);
    assert.deepEqual(onMain.signals, [], 'a skipped tick left an existing run intact');
  });

  test('#500 R4: a second return waits out the 10-minute gap (here 600 ms); the first one is not held back by it', async () => {
    fast({ stableChecks: 1, quietMs: 0, minGapMs: 600 });
    const cam = camera('r4');
    const first = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    await waitFor(() => first.signals.includes('SIGTERM'), 'the first return');
    const t1 = realNow();
    await waitFor(() => procsFor(SUB(cam.id)).length === 1, 'the relaunch onto the sub');
    // The sub flaps: the process on it dies and the sub is down, so the detector falls back to main again.
    subAnswers(cam.id).dflt = false;
    procsFor(SUB(cam.id))[0].finish(1);
    await waitFor(() => procsFor(MAIN(cam.id)).length === 2, 'the fall back to main');
    const second = procsFor(MAIN(cam.id))[1];
    subAnswers(cam.id).dflt = true; // ... and the sub is back at once
    await waitFor(() => second.signals.includes('SIGTERM'), 'the second return');
    const gap = realNow() - t1;
    // A gap check that is missing or reset on relaunch would switch at ~250 ms (grace 150 + delays).
    assert.ok(gap >= 550, `the second return came ${Math.round(gap)} ms after the first; the gap is 600 ms`);
  });

  test('#500 R6: stop() in the arming window leaves no timer and no relaunch', async () => {
    fast();
    const cam = camera('r6a');
    // A process that ignores SIGTERM: its 'exit' (which also clears the timer) is 3 s away, and the timer's own
    // next tick is 40 ms away, so a count of 0 observed RIGHT AFTER stop() can only be stop() clearing it.
    wedged.add(urlOf(MAIN(cam.id)));
    const onMain = await startOnMain(cam);
    assert.equal(motion._returnTimerCountForTests(), 1);
    const stopped = motion.stopMotionDetector(cam.id);
    assert.equal(motion._returnTimerCountForTests(), 0, 'stop() left the return timer running');
    subAnswers(cam.id).dflt = true; // the sub comes up after the stop
    requests.length = 0;
    await sleep(300);
    assert.equal(procsFor(SUB(cam.id)).length, 0, 'a stopped detector relaunched onto the sub');
    assert.deepEqual(requests, [], 'a stopped detector kept polling');
    await waitFor(() => onMain.ended, 'the stop to SIGKILL the wedged process', 5_000);
    await stopped;
    assert.deepEqual(onMain.signals, ['SIGTERM', 'SIGKILL'], 'only the stop itself signalled it');
  });

  test('#500 R6: the process exiting by itself clears the timer; a failed spawn does too', async () => {
    fast({ restartDelayMs: 400 }); // a long relaunch gap, so "no timer" can be observed inside it
    const cam = camera('r6b');
    const onMain = await startOnMain(cam);
    onMain.finish(1);
    // Right after the exit event, not "eventually": the timer's own guard would also clear it on its next tick.
    await new Promise((r) => setImmediate(r));
    assert.equal(motion._returnTimerCountForTests(), 0, "the process's exit left the timer running");
    // The relaunch (after the gap) lands on main again and arms a fresh one.
    await waitFor(() => procsFor(MAIN(cam.id)).length === 2, 'the relaunch');
    assert.equal(motion._returnTimerCountForTests(), 1);
    // A spawn that never started emits 'error', not 'exit'.
    procsFor(MAIN(cam.id))[1].emit('error', Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
    assert.equal(motion._returnTimerCountForTests(), 0, "a failed spawn's 'error' left the timer running");
  });

  test('#500 R6: stop() inside the SIGTERM window (a wedged process) and inside the relaunch gap both cancel the relaunch', async () => {
    fast({ restartDelayMs: 300 });
    // (a) the process ignores SIGTERM, so the detector is "returning" for 3 s; stop() lands in that window.
    const a = camera('r6c');
    wedged.add(urlOf(MAIN(a.id)));
    const wedgedProc = await startOnMain(a);
    subAnswers(a.id).dflt = true;
    await waitFor(() => wedgedProc.signals.includes('SIGTERM'), 'the SIGTERM');
    assert.equal(wedgedProc.ended, false, 'the wedged fake exited on SIGTERM');
    const stopped = motion.stopMotionDetector(a.id);
    assert.equal(motion._returnTimerCountForTests(), 0);
    await waitFor(() => wedgedProc.ended, 'the stop to SIGKILL it', 5_000);
    await stopped;
    // The return's SIGTERM, the stop's own SIGTERM, the stop's SIGKILL: no fourth signal, and no second SIGKILL timer.
    assert.deepEqual(wedgedProc.signals, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
    // (b) inside the relaunch gap.
    const b = camera('r6d');
    const onMain = await startOnMain(b);
    subAnswers(b.id).dflt = true;
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the SIGTERM');
    await waitFor(() => onMain.ended, 'the exit');
    await motion.stopMotionDetector(b.id); // the 300 ms relaunch is pending
    await sleep(700);
    assert.equal(procsFor(SUB(a.id)).length, 0, 'a stop inside the SIGTERM window did not cancel the relaunch');
    assert.equal(procsFor(SUB(b.id)).length, 0, 'a stop inside the relaunch gap did not cancel the relaunch');
  });

  test('#500 R6d: the watchdog killed it FIRST: the return check neither signals again nor leaves a timer behind', async () => {
    fast({ stableChecks: 1, quietMs: 0, minGapMs: 0 });
    const cam = camera('r6g');
    wedged.add(urlOf(MAIN(cam.id))); // ignores SIGTERM, so it stays "killed but alive" for 3 s
    const proc = await startOnMain(cam);
    const h = motion.getMotionDetectorHealth(cam.id);
    monoOffset += 11_000; // older than the lever's 10 s minimum
    assert.equal(motion.restartMotionDetector(cam.id, { expectSpawn: h.spawnedMono, expectLastData: h.lastDataMono }), true,
      'premise: the watchdog lever should kill an old, dark detector');
    assert.deepEqual(proc.signals, ['SIGTERM']);
    subAnswers(cam.id).dflt = true; // the sub is up and the room quiet: a return would now be due
    await sleep(300);
    assert.deepEqual(proc.signals, ['SIGTERM'], 'the return check signalled a process the watchdog was already killing');
    assert.equal(linesFor('returning the motion detector from main to sub').filter((l) => l.includes(cam.name)).length, 0,
      'it announced a switch on a process the watchdog was killing');
    // The watchdog's kill does not clear our timer itself: the tick's own guard must, well before the 3 s exit.
    assert.equal(motion._returnTimerCountForTests(), 0, 'the return timer outlived the watchdog kill');
  });

  test('#500 R6e: a stop() while the sub check is awaiting wins: the answer that lands afterwards does not switch', async () => {
    fast({ stableChecks: 1, quietMs: 0, minGapMs: 0 });
    const cam = camera('r6h');
    const proc = await startOnMain(cam);
    // The next check's answer is ready but takes 150 ms; stop() lands while it is in flight.
    subAnswers(cam.id).queue = [{ ready: true, delayMs: 150 }];
    await waitFor(() => requests.filter((r) => r === SUB(cam.id)).length >= 1 && subAnswers(cam.id).queue.length === 0, 'the slow check to start');
    await motion.stopMotionDetector(cam.id);
    assert.deepEqual(proc.signals, ['SIGTERM'], 'premise: only the stop signalled it');
    await sleep(300); // the answer lands
    assert.deepEqual(proc.signals, ['SIGTERM'], 'an answer that landed after the stop signalled the stopped process again');
    assert.equal(linesFor('returning the motion detector from main to sub').filter((l) => l.includes(cam.name)).length, 0);
    assert.equal(procsFor(SUB(cam.id)).length, 0);
    assert.equal(motion._returnTimerCountForTests(), 0);
  });

  test('#500 R6b: a switch arms exactly ONE SIGTERM and ONE SIGKILL on a wedged process, and the watchdog lever refuses an entry that is returning', async () => {
    fast({ stableChecks: 1, quietMs: 0, minGapMs: 0, recheckMs: 30, restartDelayMs: 30 });
    const cam = camera('r6e');
    wedged.add(urlOf(MAIN(cam.id)));
    const proc = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    await waitFor(() => proc.signals.includes('SIGTERM'), 'the SIGTERM');
    await sleep(400); // a dozen more ticks' worth, minGap 0: nothing may signal again
    assert.deepEqual(proc.signals, ['SIGTERM'], 'a tick signalled a process that was already being returned');
    await waitFor(() => proc.signals.includes('SIGKILL'), 'the 3 s SIGKILL fallback', 5_000);
    assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
    await waitFor(() => procsFor(SUB(cam.id)).length === 1, 'the relaunch onto the sub');

    // The #369 watchdog's lever, on an entry that is returning: refused (no signal, no second SIGKILL timer);
    // the same entry without the flag is killed, so the refusal is the flag's doing and not the entry's youth.
    const signals = [];
    let onExit = null;
    const entry = (returning) => ({
      proc: { pid: 4242, kill: (s) => { signals.push(s); return true; }, once: (_e, fn) => { onExit = fn; } },
      spawnedMono: performance.now() - 60_000,
      lastDataMono: null,
      returning,
    });
    const tokens = (e) => ({ expectSpawn: e.spawnedMono, expectLastData: null });
    const returning = entry(true);
    assert.equal(killStalledDetector(returning, tokens(returning), 3000), false);
    assert.deepEqual(signals, []);
    const plain = entry(false);
    assert.equal(killStalledDetector(plain, tokens(plain), 3000), true, 'control: the lever must still kill an ordinary stalled entry');
    assert.deepEqual(signals, ['SIGTERM']);
    onExit?.(); // clears the lever's SIGKILL timer so it cannot keep the test process alive
  });

  // #578: the other half of R6b's lever refusal. R6b proves killStalledDetector REFUSES a returning entry; this proves
  // what the detector WATCHDOG then writes. It used to record a "detector restarted" row (and a WARN) BEFORE the
  // lever ran and ignored the lever's answer, so the refusal R6b pins produced a false row in Camera history.
  // Here the watchdog and the lever are the REAL ones (only MediaMTX, the probes and the event sink are faked),
  // on an entry the REAL detector put into `returning` by its own return check: a fixture in the watchdog's own
  // test file cannot do that, its fake clock makes the real lever refuse as "too young" with or without the flag.
  // The monotonic offset ages the process past the 90 s startup grace so the watchdog judges it entry-stalled.
  const watchdogOn = (cam, events) => createDetectorWatchdog({
    listCameras: () => [cam],
    getPathStatus: async () => ({ ready: true, readers: 1, tracks: ['H264'] }),
    probeVideoFlowing: async () => true,
    probeAudioFlowing: async () => true,
    recordCameraEvent: (_id, _name, _type, detail) => events.push(detail),
  });

  test('#578: the REAL watchdog and lever on a detector that is `returning`: the kill is refused, nothing is signalled and NO restart row is written', async () => {
    fast({ stableChecks: 1, quietMs: 0, minGapMs: 0, recheckMs: 30, restartDelayMs: 30 });
    const cam = camera('w578a');
    wedged.add(urlOf(MAIN(cam.id))); // ignores the return's SIGTERM, so the entry stays `returning` for the 3 s SIGKILL timer
    const proc = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    await waitFor(() => proc.signals.includes('SIGTERM'), 'the return\'s SIGTERM');
    assert.equal(motion.getMotionDetectorHealth(cam.id)?.path, MAIN(cam.id), 'premise: the entry is still the one that is returning');
    monoOffset += 100_000;
    const events = [];
    await watchdogOn(cam, events).tick();
    assert.deepEqual(proc.signals, ['SIGTERM'], 'the watchdog signalled a detector that was already returning');
    assert.deepEqual(events, [], 'a kill the lever refused because the detector was returning was recorded as a restart');
    const mine = linesFor(`[detector-watchdog] "${cam.name}"`);
    assert.equal(mine.length, 1, `expected one watchdog line, got ${mine.length}`);
    assert.ok(mine[0].includes('INFO') && mine[0].includes('lever refused'), mine[0]);
  });

  test('#578 (control): the same watchdog and lever on a stalled detector that is NOT returning: it is signalled and the restart is recorded', async () => {
    fast(); // the sub never becomes ready (setAnswers), so this detector stays on main and is never `returning`
    const cam = camera('w578b');
    const proc = await startOnMain(cam);
    monoOffset += 100_000;
    const events = [];
    await watchdogOn(cam, events).tick();
    assert.deepEqual(proc.signals, ['SIGTERM'], 'the control did not signal the stalled detector, so the refusal above proves nothing');
    assert.equal(events.length, 1);
    assert.match(events[0], /^motion detector getting no frames \(no data in the \d+s since it started\) - motion detector restarted by the detector watchdog$/);
    const mine = linesFor(`[detector-watchdog] "${cam.name}"`);
    assert.equal(mine.length, 1);
    assert.ok(mine[0].includes('WARN') && mine[0].endsWith('lever: detector'), mine[0]);
  });

  test('#500 R6c: when nothing could be signalled (no pid) the detector is not marked returning and tries again', async () => {
    fast({ stableChecks: 1, quietMs: 0, minGapMs: 0 });
    const cam = camera('r6f');
    pidless.add(urlOf(MAIN(cam.id)));
    const proc = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    await sleep(300);
    assert.deepEqual(proc.signals, [], 'a pid-less process was signalled');
    assert.equal(linesFor('returning the motion detector from main to sub').filter((l) => l.includes(cam.name)).length, 0,
      'it announced a switch it did not make');
    assert.equal(motion._returnTimerCountForTests(), 1, 'the return check gave up after a failed signal');
    assert.equal(procsFor(SUB(cam.id)).length, 0);
  });

  for (const [label, code] of [['null (killed by the signal)', null], ['143', 143], ['255 (ffmpeg\'s own exit on SIGTERM)', 255]]) {
    test(`#500 R7: the logs say it fell back and that it returned, and a return is INFO, never an error (exit ${label})`, async () => {
      fast();
      const id = `r7-${code}`;
      const cam = camera(id);
      if (code !== null) exitCodes.set(urlOf(MAIN(id)), code);
      const onMain = await startOnMain(cam);
      const mine = (needle) => linesFor(needle).filter((l) => l.includes(cam.name));
      // The fallback warn: once, naming both paths, WARN level.
      assert.equal(mine('reading the MAIN stream').length, 1);
      assert.ok(mine('reading the MAIN stream')[0].includes(SUB(id)) && mine('reading the MAIN stream')[0].includes('WARN'));
      await sleep(250);
      assert.equal(mine('returning the motion detector from main to sub').length, 0, 'announced a switch while the sub was down');
      subAnswers(id).dflt = true;
      await waitFor(() => onMain.signals.includes('SIGTERM'), 'the switch');
      await waitFor(() => procsFor(SUB(id)).length === 1, 'the relaunch');
      assert.equal(mine('returning the motion detector from main to sub').length, 1, 'the switch line is not logged exactly once');
      const exitLines = linesFor(`[detect:${MAIN(id)}]`).filter((l) => l.includes('returning to the sub stream'));
      assert.equal(exitLines.length, 1);
      assert.ok(exitLines[0].includes('INFO') && exitLines[0].includes('restarting in 5s'), exitLines[0]);
      assert.equal(linesFor(`[detect:${MAIN(id)}] exited (code`).length, 0, 'a deliberate return was logged as a failure');
      assert.equal(linesFor(`[detect:${MAIN(id)}]`).filter((l) => l.includes('ERROR')).length, 0);
      // And ONE fallback line for the whole episode (the relaunch is on the sub: no second warn).
      assert.equal(mine('reading the MAIN stream').length, 1);
    });
  }

  // --- the quiet gate -------------------------------------------------------------------------------------------
  // A relaunch builds a NEW bed-transition tracker, so it must not happen while the room is, or recently was, active.
  // Everything here is an ACTIVITY-ONLY leg with a bed zone (the sleep sampler: the leg whose transitions matter), and
  // the stable-run condition is satisfied almost at once (2 x 40 ms) while the gate is 500 ms: only the gate can defer.
  for (const [region, what] of [[{ out: true }, 'motion OUTSIDE the zone only'], [{ bed: true }, 'motion INSIDE the zone']]) {
    test(`#500 R2: ${what} defers the switch until the room has been quiet (activity-only leg)`, async () => {
      fast({ quietMs: 500, minGapMs: 0 });
      const cam = camera(`r2-${Object.keys(region)[0]}`, { activityOnly: true, zone: true });
      const onMain = await startOnMain(cam);
      subAnswers(cam.id).dflt = true; // the sub is up from now on
      const lastFrame = await moveFor(onMain, 900, region);
      assert.deepEqual(onMain.signals, [], `it switched during ${what} (the quiet gate did not defer it)`);
      await waitFor(() => onMain.signals.includes('SIGTERM'), 'the switch once the room went quiet', 4_000);
      const quietFor = realNow() - lastFrame;
      assert.ok(quietFor >= 450, `it switched only ${Math.round(quietFor)} ms after the last active frame (gate: 500 ms)`);
    });
  }

  test('#500 R2: a still room (frames, but none active) does not defer the switch', async () => {
    fast({ quietMs: 300, minGapMs: 0 });
    const cam = camera('r2-still', { activityOnly: true, zone: true });
    const onMain = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    // Sub-threshold flicker: a few pixels of the bed move by more than PIXEL_DELTA, far under the active fraction.
    const flicker = (on) => { const f = paint({}); if (on) f.fill(LIT, 170 * FW, 170 * FW + 40); return f; };
    const end = realNow() + 1_500;
    let k = 0;
    while (!onMain.signals.includes('SIGTERM') && realNow() < end) {
      onMain.stdout.emit('data', flicker(k++ % 2 === 0));
      await sleep(25);
    }
    assert.ok(onMain.signals.includes('SIGTERM'), 'frames that are not active kept deferring the switch');
  });

  test('#500 R2d: an UNZONED camera (no outside channel): whole-frame motion defers the switch too', async () => {
    fast({ quietMs: 500, minGapMs: 0 });
    // framediff + no zone: `outPixels` is 0, so the in-zone fraction (the whole frame) is the only channel.
    const cam = camera('r2d');
    const onMain = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    const lastFrame = await moveFor(onMain, 900, { all: true });
    assert.deepEqual(onMain.signals, [], 'it switched during whole-frame motion on an unzoned camera');
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the switch once the room went quiet', 4_000);
    assert.ok(realNow() - lastFrame >= 450, 'it did not wait for the quiet gate');
  });

  // --- #368: WHICH movement the quiet gate counts -----------------------------------------------------------------
  // The gate's quiet time (SUB_QUIET_MS) is derived from the bed-transition tracker's own windows, so it has to count
  // the movement the tracker counts: the FIXED transition threshold (1.19 % of the zone, bedTransitionRules.js), not the
  // alert sensitivity. On a camera that ALERTS it also keeps counting what the alert counts, so a relaunch can never
  // split an alert-active run. Each case below uses frames BETWEEN the two thresholds, which the old code (alert
  // threshold only) answered the other way. The stored sensitivity: 50 = alert threshold 5.15 %, 100 = 0.2 %.
  //
  // A DEFERRING case emits frames for 900 ms and checks nothing switched during them (the gate is 500 ms), then that the
  // switch followed the quiet. A NON-deferring case keeps emitting frames and checks the switch happened WHILE they
  // were still arriving (the gate counts quiet from the process start when nothing active has been seen, R2e), which a
  // deferring gate could never do.
  async function moveUntilSwitch(proc, region, capMs) {
    const end = realNow() + capMs;
    let k = 0;
    while (realNow() < end && proc.signals.length === 0) {
      proc.stdout.emit('data', paint(k % 2 === 0 ? region : {}));
      k += 1;
      await sleep(25);
    }
    return proc.signals.includes('SIGTERM');
  }
  const gateDefers = async (id, camOpts, region, what) => {
    fast({ quietMs: 500, minGapMs: 0 });
    const cam = camera(id, camOpts);
    const onMain = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    const lastFrame = await moveFor(onMain, 900, region);
    assert.deepEqual(onMain.signals, [], `it switched during ${what}: the quiet gate did not count that movement`);
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the switch once the room went quiet', 4_000);
    assert.ok(realNow() - lastFrame >= 450, `it switched only ${Math.round(realNow() - lastFrame)} ms after the last frame (gate: 500 ms)`);
  };
  const gateIgnores = async (id, camOpts, region, what) => {
    fast({ quietMs: 500, minGapMs: 0 });
    const cam = camera(id, camOpts);
    const onMain = await startOnMain(cam);
    subAnswers(cam.id).dflt = true;
    assert.ok(await moveUntilSwitch(onMain, region, 2_500), `it never switched while ${what} kept arriving: the gate counted it as activity`);
  };

  test('#368 C6: activity-only zoned leg at sensitivity 50: a 3 % BED burst (under the alert 5.15 %, over the fixed 1.19 %) defers the switch', async () => {
    await gateDefers('c6a', { activityOnly: true, zone: true, sens: 50 }, { bedPx: 864 }, 'a 3 % bed burst');
  });

  test('#368 C6: activity-only zoned leg at sensitivity 50: a 3 % OUTSIDE burst defers the switch', async () => {
    await gateDefers('c6b', { activityOnly: true, zone: true, sens: 50 }, { outPx: 864 }, 'a 3 % outside burst');
  });

  test('#368 C6: an ALERTING zoned leg at sensitivity 100: a 0.5 % BED burst (under the fixed 1.19 %, over the alert 0.2 %) still defers the switch, so a relaunch cannot split an alert run', async () => {
    await gateDefers('c6c', { zone: true, sens: 100 }, { bedPx: 144 }, 'a 0.5 % bed burst the alert counts as active');
  });

  test('#368 C6: an ALERTING zoned leg at sensitivity 100: a 0.5 % OUTSIDE burst does NOT defer it (only the tracker reads the outside, and not below 1.19 %)', async () => {
    await gateIgnores('c6d', { zone: true, sens: 100 }, { outPx: 144 }, 'a 0.5 % outside burst');
  });

  test('#368 C6: an activity-only zoned leg at sensitivity 100: a 0.5 % bed burst does NOT defer it (the stored sensitivity does not govern an activity-only leg)', async () => {
    await gateIgnores('c6e', { activityOnly: true, zone: true, sens: 100 }, { bedPx: 144 }, 'a 0.5 % bed burst');
  });

  test('#368 C6: an UNZONED ALERTING leg keeps its old gate (the alert threshold): at sensitivity 50 a 3 % whole-frame burst does NOT defer, at 100 a 0.5 % one does', async () => {
    await gateIgnores('c6f', { sens: 50 }, { allPx: 1728 }, 'a 3 % whole-frame burst (under the alert 5.15 %)');
    await motion.stopAllMotionDetectors();
    await gateDefers('c6g', { sens: 100 }, { allPx: 288 }, 'a 0.5 % whole-frame burst (over the alert 0.2 %)');
  });

  // Review round 1: an ALERTING zoned leg at sensitivity 50. A 3 % bed burst is alert-inactive (5.15 %) but tracker-active
  // (1.19 %), and a zoned alerting leg has a tracker, so it DEFERS. The old gate used the alert threshold alone and let it
  // switch. This is the only case that tells `zoned` from `false` (and `zoned || !alertDefinesQuiet` from
  // `!alertDefinesQuiet`): every other zoned alerting case here sits at sensitivity 100, where the alert term already wins.
  test('#368 C6: an ALERTING zoned leg at sensitivity 50: a 3 % BED burst (alert-quiet, tracker-active) defers the switch', async () => {
    await gateDefers('c6j', { zone: true, sens: 50 }, { bedPx: 864 }, 'a 3 % bed burst on an ALERTING zoned leg');
  });

  test('#368 C6: a camera whose zone covers the WHOLE frame has no outside and no tracker, so it keeps the alert gate: at 50 a 3 % burst does NOT defer, at 100 a 0.5 % one does', async () => {
    await gateIgnores('c6k', { zone: 'whole', sens: 50 }, { allPx: 1728 }, 'a 3 % whole-frame burst (under the alert 5.15 %)');
    await motion.stopAllMotionDetectors();
    await gateDefers('c6l', { zone: 'whole', sens: 100 }, { allPx: 288 }, 'a 0.5 % whole-frame burst (over the alert 0.2 %)');
  });

  test('#368 C6: an UNZONED ACTIVITY-ONLY leg gates on the fixed threshold: a 3 % whole-frame burst defers it at sensitivity 50, a 0.5 % one does not at sensitivity 100', async () => {
    await gateDefers('c6h', { activityOnly: true, sens: 50 }, { allPx: 1728 }, 'a 3 % whole-frame burst');
    await motion.stopAllMotionDetectors();
    await gateIgnores('c6i', { activityOnly: true, sens: 100 }, { allPx: 288 }, 'a 0.5 % whole-frame burst');
  });

  test('#500 R2e: with no active frame at all, quiet is counted from the process start, not from "forever"', async () => {
    // ⚠️ LOGICAL TIME, NOT A STOPWATCH (#609). This used to assert that real time elapsed between the spawn and the
    // switch was >= 350 ms for a 400 ms gate. The stopwatch started AFTER startOnMain returned, so every ms the
    // spawn took was missing from it, and under load (a full core-coverage run) it read 349 once. Widening the margin
    // would only move the flake. The detector reads its quiet from performance.now(), so freeze that clock, put it
    // exactly at the edge, and the answer no longer depends on how fast the machine ran.
    fast({ quietMs: 400, minGapMs: 0 });
    const cam = camera('r2e');
    const onMain = await startOnMain(cam);
    const spawnedMono = motion._detectorEntryForTests(cam.id).spawnedMono;
    const subChecks = () => requests.filter((n) => n === SUB(cam.id)).length;
    subAnswers(cam.id).dflt = true; // ready from the very first check; only the quiet gate can hold it back

    // 399 ms after the process start, nothing active seen: still inside the gate. The wait proves the detector HAD
    // the chance to switch (it polled the ready sub several times) and chose not to.
    frozenMono = spawnedMono + 399;
    const seen = subChecks();
    await waitFor(() => subChecks() >= seen + 5, 'five more sub checks while the gate is one ms short');
    assert.ok(!onMain.signals.includes('SIGTERM'), 'it switched with 399 ms of quiet on a 400 ms gate');

    // Exactly the gate: quiet is counted from the process start (a fresh process is NOT "quiet forever"), so this is
    // the first instant it may go.
    frozenMono = spawnedMono + 400;
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the switch once 400 ms of quiet had passed', 4_000);
  });

  test('#500 R2c: premise: a relaunch loses a slow-link exit that the un-relaunched tracker confirms, and SUB_QUIET_MS outlasts that window', () => {
    // Bed active for the first second, quiet, then a 12% outside burst at 45 s: oobLinkKind's SLOW link (60 s).
    const frame = (t, { crib = false, out = false }) => ({
      pushArgs: [{ cribActive: crib, outActive: out, fraction: crib ? 0.3 : 0, outFraction: out ? 0.12 : 0 }, t, null],
    });
    // Real clock values, not ones near 0: the tracker's exit cooldown is measured from an initial 0, so a test that
    // starts at t=0 would see every confirm suppressed as "inside the cooldown" (the first run of this case did).
    const EPOCH = 1_000_000_000;
    const eventsFor = (tracker, from, to) => {
      const events = [];
      for (let t = from; t <= to; t += 200) {
        const crib = t < 1000;
        const out = t >= 45_000 && t < 47_000;
        events.push(...tracker.pushFrame(...frame(EPOCH + t + 1, { crib, out }).pushArgs).events.map((e) => e.type));
      }
      return events;
    };
    // #452: maxFrameGapMs is now a required option. 1500 = motionDetector.js's FRAME_GAP_MS; the frames below are
    // 200 ms apart, so it never fires and this premise is about the link windows only.
    const continuous = createBedTransitionTracker({ activeGraceMs: 1500, maxFrameGapMs: 1500 });
    assert.ok(eventsFor(continuous, 0, 60_000).includes('oob-confirmed'), 'premise: the continuous tracker should confirm the exit');
    // A tracker that began at 36 s (a relaunch after ~35 s of quiet) has never seen the bed move.
    const relaunched = createBedTransitionTracker({ activeGraceMs: 1500, maxFrameGapMs: 1500 });
    assert.ok(!eventsFor(relaunched, 36_000, 60_000).includes('oob-confirmed'), 'premise: the relaunched tracker has forgotten the bed');
    // So the quiet the switch waits for must exceed the slow-link window plus the confirm quiet.
    assert.ok(motion.SUB_QUIET_MS > OOB_LINK_SLOW_MS + OOB_CONFIRM_QUIET_MS,
      `SUB_QUIET_MS ${motion.SUB_QUIET_MS} does not outlast ${OOB_LINK_SLOW_MS} + ${OOB_CONFIRM_QUIET_MS}`);
  });

  // --- R9: what survives the relaunch ---------------------------------------------------------------------------
  test('#500 R9: believedOccupied survives the return to the sub (a repeated exit is flagged impossible), per-launch state does not', async (t) => {
    // Date is mocked (the bed-transition tracker times itself with Date.now()); setTimeout and performance.now
    // stay REAL, so the return check and its quiet gate run in real time. pickReadyPath's grace reads Date too,
    // so the test steps the mocked clock past it by hand.
    const T0 = Date.UTC(2026, 8, 25, 22, 0, 0);
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    fast({ quietMs: 120, minGapMs: 0 });
    const cam = camera('r9', { activityOnly: true, zone: true });
    setAnswers(cam.id, { main: true, sub: false });
    await motion.startMotionDetector(cam);
    t.mock.timers.setTime(T0 + 10_000); // past the grace
    await waitFor(() => procsFor(MAIN(cam.id)).length === 1, 'the main-stream ffmpeg');
    const onMain = procsFor(MAIN(cam.id))[0];

    // bed moves 5 s, outside 2 s, then 8 s quiet: an exit candidate opens (bed active <8 s ago) and confirms.
    const script = [
      ...Array(26).fill(0).map((_, k) => paint({ bed: k % 2 === 0 })),
      ...Array(10).fill(0).map((_, k) => paint({ out: k % 2 === 0 })),
      ...Array(40).fill(0).map(() => paint({})),
    ];
    const play = (proc, base) => script.forEach((f, i) => { t.mock.timers.setTime(base + i * 200); proc.stdout.emit('data', f); });
    play(onMain, T0 + 20_000);
    const mine = (needle) => linesFor(needle).filter((l) => l.includes(cam.name));
    assert.equal(mine('OUT OF BED —').length, 1, 'premise: the first exit was not confirmed');
    assert.equal(mine('would be flagged impossible').length, 0);

    subAnswers(cam.id).dflt = true;
    await waitFor(() => onMain.signals.includes('SIGTERM'), 'the return to the sub');
    await waitFor(() => procsFor(SUB(cam.id)).length === 1, 'the relaunch onto the sub');
    play(procsFor(SUB(cam.id))[0], T0 + 120_000);
    // The same exit again. A NEW tracker confirms it (its own cooldown is fresh); the belief that survived the
    // relaunch says the child is already out, so it is flagged. A relaunch that forgot the belief would not flag.
    assert.equal(mine('OUT OF BED —').length, 2, 'the repeated exit was not confirmed by the new launch');
    assert.equal(mine('OUT OF BED would be flagged impossible').length, 1,
      'believedOccupied did not survive the return to the sub');
  });
});

// ================================================================================================================
describe('#500: the pure decisions, against the production defaults (no seam)', () => {
  test('#500 R8: shouldReturnToSub: every argument one step either side of its boundary', () => {
    const base = { readyRun: 3, quietMs: 90_000, sinceLastSwitchMs: null };
    const { shouldReturnToSub } = motion;
    assert.equal(shouldReturnToSub(base), true);
    assert.equal(shouldReturnToSub({ ...base, readyRun: 2 }), false, '3 ready samples are needed');
    assert.equal(shouldReturnToSub({ ...base, readyRun: 4 }), true);
    assert.equal(shouldReturnToSub({ ...base, quietMs: 89_999 }), false, '90 s of quiet is needed');
    assert.equal(shouldReturnToSub({ ...base, quietMs: 90_001 }), true);
    assert.equal(shouldReturnToSub({ ...base, sinceLastSwitchMs: 599_999 }), false, '10 minutes between switches');
    assert.equal(shouldReturnToSub({ ...base, sinceLastSwitchMs: 600_000 }), true);
    assert.equal(shouldReturnToSub({ ...base, sinceLastSwitchMs: 0 }), false, 'a switch just now is not "never"');
    assert.equal(shouldReturnToSub({ ...base, sinceLastSwitchMs: null }), true, 'never switched since this start');
  });

  test('#500 R8: the production constants are what the docs say', () => {
    assert.equal(motion.SUB_RECHECK_MS, 20_000);
    assert.equal(motion.SUB_STABLE_CHECKS, 3);
    assert.equal(motion.SUB_QUIET_MS, 90_000);
    assert.equal(motion.SUB_SWITCH_MIN_GAP_MS, 600_000);
  });

  test('#500 R8: the timings production RUNS with are the documented ones (every behavioural case shrinks them)', () => {
    // Literals on purpose: a value computed from the module's own constants follows a mutated one.
    assert.deepEqual({ ...motion._productionTimingForTests() }, {
      subGraceMs: 45_000, // the grace before settling for main (and the "~5 s" of the log line is restartDelayMs)
      readyPollMs: 2_000,
      restartDelayMs: 5_000,
      recheckMs: 20_000, // the check interval KNOWN-ISSUES promises
      stableChecks: 3,
      quietMs: 90_000,
      minGapMs: 600_000,
    });
  });

  test('#500 R3: nextReadyRun: only a confirmed ready extends the run (not ready, unknown, no answer all reset it)', () => {
    const { nextReadyRun } = motion;
    assert.equal(nextReadyRun(0, { ready: true }), 1);
    assert.equal(nextReadyRun(2, { ready: true, tracks: [] }), 3);
    assert.equal(nextReadyRun(2, { ready: false, tracks: [] }), 0);
    assert.equal(nextReadyRun(2, { ready: false, tracks: [], unknown: true }), 0);
    assert.equal(nextReadyRun(2, { ready: 'yes' }), 0, 'a truthy non-true value is not a confirmed ready');
    assert.equal(nextReadyRun(2, null), 0);
    assert.equal(nextReadyRun(2, undefined), 0);
  });
});
