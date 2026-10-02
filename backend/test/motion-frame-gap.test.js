// #452: a confirmation must not span a sampling outage, through the REAL motion detector.
//
// bedTransitionLink.test.js pins createFrameGapDetector (the adaptive bound) and bedTransitionTracker.test.js pins what
// a pending exit/entry does with a gap. THIS file pins the wiring in motionDetector.js that no other test can reach
// (it is not in `test:core`'s include list): the motion-alert run reset, the floor passed to the tracker, and the three
// log lines. Acceptance criterion (a): an active frame, a long silence, then another active frame is not proof of
// motion sustained through the silence.
//
// HARNESS: the same one as detector-observation-wiring.test.js (which is where the explanation of every choice lives):
// only `node:child_process` is mocked (it is outside `test:core`, so mocking it is safe), the DB, tracker, logger and
// alert path are real, MediaMTX readiness is a real local server, and `Date` is mocked and set before every stdout
// delivery so a 20 s hole is one `setTime`. Copied rather than imported because that file is a test (importing it would
// run its ~18 tests), and its fixtures (`stallSchedule`, the stderr captures) belong to the observation clock, which
// this rule deliberately does not read: the gap is decided from stdout RECEIPT times alone, so no tap lines are fed and
// the observation clock is switched off (`() => null`, the golden's `none` variant).
import { test, mock, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';
import { FakeFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

useTempDataDir();
// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load, so the fake must be listening first.
const mediamtx = await startFakeMediamtx();

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
const { startMotionDetector, stopMotionDetector } = await import('../src/lib/motionDetector.js');
const { _setObservationClockFactoryForTests, _resetObservationClocksForTests } = await import('../src/lib/observationClock.js');

after(async () => {
  await mediamtx.close();
  cleanupTempDataDirs();
});
beforeEach(() => _resetActivityTrackerForTests());

const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

// Poll on performance.now(), NOT Date: Date is frozen by the mock.
async function waitFor(pred, what, capMs = 15_000) {
  const deadline = performance.now() + capMs;
  while (!pred()) {
    if (performance.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

// --- frames (the detector's own geometry: 320x180 gray, one byte per pixel; the bed zone is the LEFT half) --------
const FW = 320;
const FH = 180;
const FRAME_BYTES = FW * FH;
const BASE = 60;
const LIT = 200; // |LIT - BASE| = 140, far over the detector's PIXEL_DELTA of 24
function paint({ bed = false, out = false }) {
  const f = Buffer.alloc(FRAME_BYTES, BASE);
  const fill = (x0, x1, y0, y1) => { for (let y = y0; y < y1; y++) f.fill(LIT, y * FW + x0, y * FW + x1); };
  if (bed) fill(0, 160, 0, 60); //  9,600 px: 33% of the zone with a zone, 16.7% of the frame without: active (threshold 5.15%)
  if (out) fill(160, 320, 0, 40); // 6,400 px: 22% of the outside: active
  return f;
}
const UNLIT = paint({});
const LIT_BED = paint({ bed: true });

const camera = (id, extra = {}) => ({
  id,
  name: `Gap ${id}`,
  mediamtx_path: `path_gap_${id}`,
  sub_rtsp_url: null,
  disabled: 0,
  child_id: null,
  detect_motion_enabled: 1,
  detect_source: 'framediff',
  detect_sensitivity: 50,
  detect_confirm_s: 3,
  detect_cooldown_s: 60,
  detect_zone: null, // no zone: the whole frame is the zone, so only the motion ALERT runs (no bed-transition tracker)
  detect_schedule_enabled: 0,
  detect_record_clips: 0,
  snapshot_url: null,
  ...extra,
});
const withZone = (id, extra = {}) => camera(id, { detect_zone: JSON.stringify([{ x: 0, y: 0, w: 0.5, h: 1 }]), ...extra });

// Starts a detector with the observation clock OFF and returns a rig to drive it. `feed(at, frame)` sets the mocked
// clock to `at`, then delivers one frame; `active(at)` delivers a frame that DIFFERS from the previous one (the bed
// lit on alternate frames, as every run in detector-observation-wiring.test.js is), `quiet(at)` repeats the previous
// one (a still room).
async function rig(t, cam) {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  logger.clear();
  _resetObservationClocksForTests();
  _setObservationClockFactoryForTests(() => null);
  t.after(() => _setObservationClockFactoryForTests(null));
  makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
  const before = detectorProcs.length;
  await startMotionDetector(cam);
  await waitFor(() => detectorProcs.length === before + 1, `${cam.id} spawn`);
  const proc = detectorProcs[before];
  t.after(async () => { await stopMotionDetector(cam.id); await settle(); });
  let current = UNLIT;
  const feed = (at, frame) => {
    t.mock.timers.setTime(at);
    proc.stdout.emit('data', frame);
  };
  const lines = (needle) => logger.getRecent().map((l) => l.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /, '')).filter((l) => l.includes(needle) && l.includes(cam.name));
  const r = {
    proc,
    feed,
    baseline: (at = T0) => { current = UNLIT; feed(at, current); },
    active: (at) => { current = current === LIT_BED ? UNLIT : LIT_BED; feed(at, current); },
    // for a zone camera, the exit/entry scripts light the outside region instead
    paintFrame: (at, spec) => { current = paint(spec); feed(at, current); },
    quiet: (at) => feed(at, current),
    lines,
    alerts: async () => { await settle(); return lines('motion on "').length; },
    restarts: () => lines('motion run restarted'),
  };
  return r;
}
// n frames at `from`, `from + 200`, ... (the real 5 fps), through `emit`.
const run = (from, to, emit, step = 200) => { for (let at = from; at <= to; at += step) emit(at); };

describe('#452 motion alert: a run is not confirmed across a gap in the frames', { concurrency: false }, () => {
  test('control: continuous 5 fps active frames alert at exactly the confirm time (>= not >), and log no restart', async (t) => {
    const g = await rig(t, camera('ctl'));
    g.baseline();
    // The first active frame is at +200 (the run starts there); the alert needs now - activeSince >= 3000.
    run(T0 + 200, T0 + 3000, g.active);
    assert.equal(await g.alerts(), 0, '2.8 s into the run: not yet');
    g.active(T0 + 3200); // exactly 3000 ms after the run began
    assert.equal(await g.alerts(), 1, 'exactly confirmMs after the first active frame: alerts (kills >= -> >)');
    assert.deepEqual(g.restarts(), []);
  });

  test('(a) active frames, a 20 s hole, active frames: no alert until confirmMs of frames received AFTER the hole', async (t) => {
    const cam = camera('hole');
    const g = await rig(t, cam);
    g.baseline();
    run(T0 + 200, T0 + 1000, g.active); // a 0.8 s run
    // 20 s of nothing, then the run "continues". Before #452 this satisfied `now - activeSince >= 3000` on the spot.
    run(T0 + 21_000, T0 + 23_800, g.active);
    assert.equal(await g.alerts(), 0, 'the hole is not 3 s of observed motion');
    assert.deepEqual(g.restarts(), [`[INFO] [detect] "${cam.name}" motion run restarted — no frames for 20000ms`], 'exactly once');
    g.active(T0 + 24_000); // 3000 ms after the first POST-gap frame (21 s)
    assert.equal(await g.alerts(), 1, 'it alerts once a full confirm time of frames has been received since the gap');
  });

  test('the line is exact, and names the length of the hole', async (t) => {
    const cam = camera('line');
    const g = await rig(t, cam);
    g.baseline();
    run(T0 + 200, T0 + 600, g.active);
    g.active(T0 + 8600); // 8000 ms hole
    assert.deepEqual(g.restarts(), [`[INFO] [detect] "${cam.name}" motion run restarted — no frames for 8000ms`]);
  });

  // The gap floor is exact at the detector. Cold detector (200 ms frames first), so the floor alone governs. Kills a
  // floor of 1501 (or a >= on the bound) in one test and a floor that is too wide in the other.
  test('the gap floor is exact at the detector: a 1500 ms hole continues the run', async (t) => {
    const g = await rig(t, camera('b1500'));
    g.baseline();
    run(T0 + 200, T0 + 400, g.active);
    g.active(T0 + 1900); // exactly 1500 ms after 400
    run(T0 + 2100, T0 + 3300, g.active); // frames at 2100 ... 3300: the one at 3300 is 3100 ms into the run
    assert.deepEqual(g.restarts(), [], '1500 ms: not a gap');
    assert.equal(await g.alerts(), 1, 'the run began at 200 and was never broken: it alerts by 3300');
  });

  test('the gap floor is exact at the detector: a 1501 ms hole restarts it', async (t) => {
    const g = await rig(t, camera('b1501'));
    g.baseline();
    run(T0 + 200, T0 + 400, g.active);
    g.active(T0 + 1901); // 1501 ms
    run(T0 + 2101, T0 + 3301, g.active); // the same frames, shifted 1 ms: 3301 is 3101 ms after the FIRST active frame
    assert.equal(g.restarts().length, 1, '1501 ms: a gap');
    assert.equal(await g.alerts(), 0, 'the run restarted at 1901, so 3301 is only 1400 ms into it (without the restart it would alert)');
  });

  test('the gap is measured between CONSECUTIVE FRAMES, not from the last active one', async (t) => {
    // Active, then 1.4 s of QUIET frames, then active at +1.6 s: the room was watched the whole time, so the run
    // continues (the pre-existing grace rule: a dip under ACTIVE_GRACE_MS does not end a run) and alerts at 3 s.
    // A gap measured as `now - lastActive` (1600 > 1500) would restart it here.
    const g = await rig(t, camera('between'));
    g.baseline();
    g.active(T0 + 200);
    run(T0 + 400, T0 + 1600, g.quiet); // 1.4 s of quiet frames after the last active one
    g.active(T0 + 1800); // 1.6 s after the last active frame
    run(T0 + 2000, T0 + 3200, g.active);
    assert.deepEqual(g.restarts(), []);
    assert.equal(await g.alerts(), 1, 'one unbroken run from 200 to 3200');
  });

  test('a gap while NO run is pending logs nothing (a healthy or idle stream gains no noise)', async (t) => {
    const g = await rig(t, camera('idle'));
    g.baseline();
    run(T0 + 200, T0 + 1000, g.quiet);
    g.quiet(T0 + 21_000); // a 20 s hole with nothing running
    g.active(T0 + 21_200); // and the run starts fresh: nothing to restart
    assert.deepEqual(g.restarts(), []);
  });

  test('a backward wall-clock step is a gap too, and the line says the clock stepped back', async (t) => {
    const cam = camera('back');
    const g = await rig(t, cam);
    g.baseline();
    run(T0 + 200, T0 + 1000, g.active);
    g.active(T0 + 500); // the clock stepped back 500 ms
    assert.deepEqual(g.restarts(), [`[INFO] [detect] "${cam.name}" motion run restarted — system clock stepped back 500ms`]);
  });

  test('detect_confirm_s = 0 is a legal setting and still alerts on the first active frame after a gap', async (t) => {
    // "A gap frame can never confirm" means a POSITIVE confirm time: with 0, the post-gap active frame starts a
    // fresh run and 0 >= 0 alerts at once. Cooldown is 1 s here so the second alert is not suppressed by the first.
    const g = await rig(t, camera('zero', { detect_confirm_s: 0, detect_cooldown_s: 1 }));
    g.baseline();
    g.active(T0 + 200);
    assert.equal(await g.alerts(), 1, 'confirm 0: the first active frame alerts');
    g.active(T0 + 21_000); // after a 20 s hole
    assert.equal(g.restarts().length, 1, 'the open run was restarted');
    assert.equal(await g.alerts(), 2, '...and the post-gap active frame still alerts at once');
  });

  // ★ REGRESSION (#452 code review round 1, verified by running): the first stall after a launch used to BE the typical
  // interval and widen the bound for the next frame. active@200, active@2200, active@9200: the 2 s delta was the
  // window's only entry, the 7 s hole was judged against a 10 s bound, and `now - activeSince` (7 s) alerted ONCE on
  // frames that were never 3 s of observed motion. With fewer than 9 deltas held the floor alone governs: both are gaps.
  test('a lone stall right after a launch cannot widen the bound: active@200, @2200, @9200 does not alert', async (t) => {
    const cam = camera('lone');
    const g = await rig(t, cam);
    g.baseline();
    g.active(T0 + 200);
    g.active(T0 + 2200);
    g.active(T0 + 9200);
    assert.equal(await g.alerts(), 0, 'no alert: the run restarted at 9200 and has lasted 0 ms');
    assert.deepEqual(
      g.restarts(),
      [`[INFO] [detect] "${cam.name}" motion run restarted — no frames for 2000ms`, `[INFO] [detect] "${cam.name}" motion run restarted — no frames for 7000ms`],
    );
  });

  // A QUIET frame after a hole ends the run too, and says so. (Kills a reset that is conditional on the gap frame being
  // active: the pre-existing grace branch would still clear the run, silently, so only the log line tells them apart.)
  test('a QUIET frame after a hole also restarts the run and logs it', async (t) => {
    const cam = camera('quietgap');
    const g = await rig(t, cam);
    g.baseline();
    run(T0 + 200, T0 + 1000, g.active);
    g.quiet(T0 + 21_000); // the room is still, 20 s later
    assert.deepEqual(g.restarts(), [`[INFO] [detect] "${cam.name}" motion run restarted — no frames for 20000ms`]);
    run(T0 + 21_200, T0 + 23_800, g.active); // a run starting here has not lasted 3 s yet
    assert.equal(await g.alerts(), 0);
  });

  // The ALERT's own detector must use the default factor 5, like the tracker's: with a factor of 1 the bound is the typical
  // interval itself (2 s here), so a 6 s hole in a 0.5 fps stream, which the 10 s bound lets through, would restart a run.
  // Also pins the cold-camera cost: a stream at 2 s per frame is a run of gaps until 9 deltas are held (9 restarts, at
  // frames 2 to 10 of the run), and only then can a 3 s confirmation complete.
  test('a slow (2 s) stream learns its bound after 9 restarts; a 6 s hole in it is then NOT a gap (factor 5, not 1)', async (t) => {
    const cam = camera('slow');
    const g = await rig(t, cam);
    g.baseline();
    run(T0 + 2000, T0 + 22_000, g.active, 2000); // frames 1 to 11 of the run
    assert.equal(g.restarts().length, 9, 'frames 2 to 10 are judged against the floor (fewer than 9 deltas held); frame 11 is not');
    assert.equal(await g.alerts(), 0, 'the run restarted at frame 10 (T0 + 20 s): frame 11 is only 2 s into it');
    g.active(T0 + 28_000); // 6 s after frame 11: inside the learnt 5 x 2 s bound
    assert.equal(g.restarts().length, 9, 'a 6 s hole in a 2 s cadence is not a gap');
    assert.equal(await g.alerts(), 1, 'the run is 8 s old (since frame 10): it alerts');
  });
});

describe('#452 bed transitions through the real detector: a pending exit/entry is not confirmed by a quiet frame after a hole', { concurrency: false }, () => {
  // The exit: the bed moves for 1.2 s, then the outside does (the candidate opens on its first frame, at +1200), then
  // the room is quiet. The entry is the mirror. Both then meet a 20 s hole.
  const exitScript = (g) => {
    g.baseline();
    // frames 1-6: the bed lit on alternate frames; frames 7-8: the outside lit then unlit (a clean BASE picture after)
    for (let k = 0; k < 6; k++) g.paintFrame(T0 + 200 * (k + 1), { bed: k % 2 === 0 });
    g.paintFrame(T0 + 1400, { out: true }); //  opens (bed was active 200 ms ago): the exit candidate
    g.paintFrame(T0 + 1600, {});
  };
  const entryScript = (g) => {
    g.baseline();
    for (let k = 0; k < 4; k++) g.paintFrame(T0 + 200 * (k + 1), { out: k % 2 === 0 }); // the outside moves
    g.paintFrame(T0 + 1000, { bed: true }); //  opens (the outside was active 200 ms ago): the entry candidate
    g.paintFrame(T0 + 1200, {});
  };

  for (const side of [
    { name: 'exit', script: exitScript, from: T0 + 1600, tag: 'oob', confirmed: 'OUT OF BED', needs: 6000 },
    { name: 'entry', script: entryScript, from: T0 + 1200, tag: 'intobed', confirmed: 'INTO BED', needs: 6000 },
  ]) {
    test(`${side.name}: one quiet frame after a 20 s hole confirms nothing; the restart is logged; the full window afterwards does confirm`, async (t) => {
      const cam = withZone(`z-${side.name}`);
      const g = await rig(t, cam);
      side.script(g);
      const confirmedLines = () => g.lines(`] "${cam.name}" ${side.confirmed}`).filter((l) => l.includes(`[${side.tag}]`));
      assert.equal(g.lines('candidate').filter((l) => l.includes(`[${side.tag}]`)).length >= 1, true, 'a candidate is pending');
      run(side.from + 200, side.from + 1000, g.quiet); // a second of quiet, continuous
      const hole = side.from + 21_000;
      g.quiet(hole); // 20 s later: ONE quiet frame
      assert.deepEqual(confirmedLines(), [], 'before #452 this frame confirmed it (6 s "elapsed")');
      assert.deepEqual(
        g.lines('confirmation restarted'),
        [`[INFO] [${side.tag}] "${cam.name}" confirmation restarted — no frames for 20000ms (needs ${side.needs}ms of received quiet from here)`]
      );
      run(hole + 200, hole + side.needs - 200, g.quiet);
      assert.deepEqual(confirmedLines(), [], 'one frame short of a full received window');
      g.quiet(hole + side.needs);
      assert.equal(confirmedLines().length, 1, 'a full window of received quiet confirms it (reset, not cancel)');
    });
  }

  // The floor the DETECTOR hands the tracker (maxFrameGapMs: FRAME_GAP_MS), pinned to the millisecond. The tracker's
  // own unit tests construct it with whatever they like, so a detector passing the wrong value is only visible here.
  for (const [holeMs, restarts] of [[1500, 0], [1501, 1]]) {
    test(`exit: a ${holeMs} ms hole is ${restarts ? '' : 'NOT '}a gap for the tracker the detector builds`, async (t) => {
      const cam = withZone(`zb-${holeMs}`);
      const g = await rig(t, cam);
      exitScript(g);
      run(T0 + 1800, T0 + 2600, g.quiet);
      g.quiet(T0 + 2600 + holeMs);
      assert.equal(g.lines('confirmation restarted').length, restarts);
    });
  }
});
