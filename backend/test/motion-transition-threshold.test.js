// #368: the motion ALERT threshold and the bed-transition threshold are two numbers, through the REAL motion detector.
//
// Before #368 `startMotionDetector` turned `detect_sensitivity` into ONE threshold and used it for the motion alert
// AND for the bed/outside classification the bed-transition tracker reads, so tuning how many notifications someone
// wanted moved the stored out_of_bed / into_bed rows that sleep analysis treats as authoritative. It also governed the
// activity-only legs (MQTT / ONVIF source, motion off), whose slider the UI hides. The tracker now reads a fixed
// constant (bedTransitionRules.js, BED_TRANSITION_ACTIVE_FRACTION = 1.19 % of the zone, the value sensitivity 90
// gives); the alert keeps the slider.
//
// WHAT THIS FILE PINS, by claim (every test name starts `#368 C<n>:` so a mutant can target it by regex). The plan's
// claim table is in planning, the C-numbers are its:
//   C1  the issue's reproduction (a 3.47 % burst in bed, then outside, then quiet) records the SAME exit at sensitivity
//       1, 50, 90 and 100 (today: none at 1 and 50, one at 90 and 100);
//   C2  a ladder of burst sizes (0.5 / 1.0 / 1.5 / 3.47 / 6 / 20 %) gives identical rows and identical
//       [oob]/[intobed]/[coactive] lines at every sensitivity, and the threshold sits where it should in the ladder
//       (1.0 % records nothing, 1.5 % does);
//   C3  the same on the activity-only legs (MQTT source, ONVIF source, motion off), which also never alert;
//   C4  the ALERT is unchanged: it still follows the slider (3.47 % alerts at 90 and 100 but not at 50; 6 % alerts at
//       50; 1.0 % alerts only at 100), which is also what kills a mutant that mixes the two thresholds;
//   C5  the pixel boundary through launch(): 342 px of a 28 800 px zone is inactive and 343 is active; 588 / 589 px of
//       a 49 500 px area on EACH channel (589 / 49 500 is exactly the constant, so `>=` vs `>` differ). The LITERAL pin
//       of the constant is in motionDetector.test.js (a pixel boundary cannot tell 0.0119 from 0.011899);
//   C9  a camera at 90 behaves exactly as before: one scripted night with an expectation written out BY HAND;
//   C10 the cancel band is part of the calibrated policy and identical at every sensitivity: a 2 % bed movement cancels
//       a pending exit (and, with the outside quiet, opens an entry) at every sensitivity.
//   (C6 is in motion-return-to-sub.test.js, C7 in detector-observation-wiring.test.js, C8 in
//    docs-motion-sensitivity.test.js.)
//
// FRAME GEOMETRY. 320x180 gray, one byte per pixel. Zone = the LEFT half `{x:0,y:0,w:0.5,h:1}`: 28 800 px in the zone and
// 28 800 outside, so 1 % = 288 px and the constant (1.1899 %) is 342.69 px: 342 inactive, 343 active. A frame's lit set
// is the first `bed` pixels of the bed region (row by row) plus the first `out` pixels of the outside region, so the
// number of pixels that changed between two frames is EXACTLY the difference of those counts. A burst alternates N and 0
// (every frame active, ending on 0 so the frames after it are identical = quiet); a persistent movement steps from 0 to
// N and stays (ONE active frame). Frames are 200 ms apart on a mocked `Date` (set before every delivery, as the
// motion-frame-gap / motion-alert-cooldown harnesses do), so every time in an expected log line is derivable by hand.
//
// HARNESS: only `node:child_process` is mocked; the DB, the alert path, the tracker and the logger are real; MediaMTX is
// a real local server; the observation clock is off (this file is about the threshold, not about what the taps say).
import { test, mock, after, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera, makeChild } from './helpers/harness.js';
import { FakeFfmpeg, startFakeMediamtx } from './helpers/fakeFfmpeg.js';

useTempDataDir();

const readyPaths = new Set();
// ⚠️ ORDER MATTERS: mediamtx.js reads MEDIAMTX_API at module load, so the fake must be listening first.
const mediamtx = await startFakeMediamtx({ isReady: (name) => readyPaths.has(name) });

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

_setObservationClockFactoryForTests(() => null);

after(async () => {
  await motion.stopAllMotionDetectors();
  _resetObservationClocksForTests();
  await mediamtx.close();
  cleanupTempDataDirs();
});
afterEach(async () => {
  motion._resetReturnTimingForTests();
  motion._resetMotionAlertsForTests();
  _resetActivityTrackerForTests();
  await motion.stopAllMotionDetectors();
});

// --- time and polling ---------------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);
const FRAME_MS = 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nativeNow = performance.now.bind(performance);
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

// --- frames -------------------------------------------------------------------------------------------------------
const FW = 320;
const FH = 180;
const FRAME_BYTES = FW * FH;
const BASE = 60;
const LIT = 200; // |LIT - BASE| = 140, far over the detector's PIXEL_DELTA of 24

// Three zone shapes. `bedW` is the width of the bed region the lit pixels are laid out in; the outside region starts at
// `outX0` and is `outW` wide, always outside the zone.
//  LEFT_HALF  28 800 px zone, 28 800 outside: the 342 / 343 boundary.
//  SMALL_ZONE 90x90 = 8 100 px zone, 49 500 outside: 589 changed OUTSIDE px = 589 / 49 500 = the constant EXACTLY.
//  BIG_ZONE   275x180 = 49 500 px zone, 8 100 outside: 589 changed BED px = the constant EXACTLY.
// (0.28125 * 320 = 90 and 0.5 * 180 = 90; 0.859375 * 320 = 275, all exact in binary, so buildZoneMask's rounding adds
// nothing. Verified against the real buildZoneMask when this file was written.)
const LEFT_HALF = { zone: [{ x: 0, y: 0, w: 0.5, h: 1 }], bedW: 160, outX0: 160, outW: 160 };
const SMALL_ZONE = { zone: [{ x: 0, y: 0, w: 0.28125, h: 0.5 }], bedW: 90, outX0: 160, outW: 160 };
const BIG_ZONE = { zone: [{ x: 0, y: 0, w: 0.859375, h: 1 }], bedW: 275, outX0: 275, outW: 45 };

const frameCache = new Map();
function frameOf(bed, out, geom) {
  const key = `${geom.bedW}/${geom.outX0}/${bed}/${out}`;
  let f = frameCache.get(key);
  if (!f) {
    f = Buffer.alloc(FRAME_BYTES, BASE);
    for (let i = 0; i < bed; i++) f[Math.floor(i / geom.bedW) * FW + (i % geom.bedW)] = LIT;
    for (let i = 0; i < out; i++) f[Math.floor(i / geom.outW) * FW + geom.outX0 + (i % geom.outW)] = LIT;
    frameCache.set(key, f);
  }
  return f;
}

// A script is an array of [bedLitPx, outLitPx], one per frame, frame i at T0 + i * 200 ms.
//   frame 0           the baseline (no diff is taken against nothing)
//   frames 1..10      a 2 s burst in the bed (bedPx changed per frame)
//   frames 11..16     a 1.2 s burst outside (outPx changed per frame): the exit candidate opens on frame 11 (T0 + 2.2 s),
//                     200 ms after the bed's last active frame
//   frames 17..       quiet, long enough for the 6 s confirmation (frame 41 = T0 + 8.2 s) with room to spare
function exitScript(bedPx, outPx, { quiet = 45 } = {}) {
  const s = [[0, 0]];
  for (let k = 1; k <= 10; k++) s.push([k % 2 ? bedPx : 0, 0]);
  for (let k = 1; k <= 6; k++) s.push([0, k % 2 ? outPx : 0]);
  for (let k = 0; k < quiet; k++) s.push([0, 0]);
  return s;
}
// A sustained 3.4 s run of bed motion (frame 1 starts it, frame 16 = T0 + 3.2 s is its 3 s confirm time).
function alertScript(bedPx) {
  const s = [[0, 0]];
  for (let k = 1; k <= 18; k++) s.push([k % 2 ? bedPx : 0, 0]);
  return s;
}

// --- cameras and runs ---------------------------------------------------------------------------------------------
// One always-open child so an activity-only (sleep-tracking-only) leg is wanted whatever the date is.
makeChild(db, { id: 'kid-thr', name: 'A Child', start: '00:00', end: '23:59' });

let seq = 0;
// kind: 'alerting' (framediff source, motion on: the only kind that alerts), 'mqtt' / 'onvif' (the alert comes from
// elsewhere), 'motion-off' (framediff source with motion detection switched off). All but 'alerting' are child-assigned,
// which is what keeps their activity-only leg running.
function camera(id, { sens, kind = 'alerting', geom = LEFT_HALF }) {
  return {
    id,
    name: `Thr ${id}`,
    mediamtx_path: `path_thr_${id}`,
    sub_rtsp_url: null,
    disabled: 0,
    child_id: kind === 'alerting' ? null : 'kid-thr',
    detect_motion_enabled: kind === 'motion-off' ? 0 : 1,
    detect_source: kind === 'mqtt' ? 'mqtt' : kind === 'onvif' ? 'onvif' : 'framediff',
    detect_sensitivity: sens,
    detect_confirm_s: 3,
    detect_cooldown_s: 60,
    detect_zone: JSON.stringify(geom.zone),
    detect_schedule_enabled: 0,
    detect_record_clips: 0,
    snapshot_url: null,
  };
}

// Date is mocked for the whole test; every delivery sets it first. setTimeout / performance.now stay real.
function begin(t) {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
}

const stripLine = (l) => l.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /, '').replace(/^\[(INFO|WARN|ERROR)\] /, '');

// Runs `script` through a freshly started detector for ONE camera and returns what it produced: the stored
// bed_transitions rows, the tracker's log lines (camera name normalised to CAM so runs on different cameras compare),
// and how many motion alerts it recorded.
async function run(t, spec, script) {
  const geom = spec.geom ?? LEFT_HALF;
  const cam = camera(`r${++seq}`, spec);
  logger.clear();
  readyPaths.add(cam.mediamtx_path);
  makeCamera(db, { id: cam.id, name: cam.name, path: cam.mediamtx_path });
  const url = `rtsp://127.0.0.1:8554/${cam.mediamtx_path}`;
  const cur = () => detectorProcs.filter((p) => p.args[p.args.indexOf('-i') + 1] === url && !p.ended).at(-1);
  await startMotionDetector(cam);
  await waitFor(() => cur() !== undefined, `${cam.id} spawn`);
  script.forEach(([bed, out], i) => {
    t.mock.timers.setTime(T0 + i * FRAME_MS);
    cur().stdout.emit('data', frameOf(bed, out, geom));
  });
  await settle();
  const trace = logger.getRecent()
    .map(stripLine)
    .filter((l) => l.includes(`"${cam.name}"`) && /^\[(oob|intobed|coactive)\]/.test(l))
    .map((l) => l.split(`"${cam.name}"`).join('"CAM"'));
  const rows = db.prepare('SELECT type, peak, out_peak, out_frames FROM bed_transitions WHERE camera_id = ? ORDER BY id').all(cam.id).map((r) => ({ ...r }));
  const alerts = db.prepare("SELECT COUNT(*) AS c FROM detection_events WHERE camera_id = ? AND type = 'motion'").get(cam.id).c;
  await stopMotionDetector(cam.id);
  await settle();
  return { rows, trace, alerts };
}
const SENS = [1, 50, 90, 100];
const onlyTransitions = ({ rows, trace }) => ({ rows, trace });

// The exit the plan's reproduction produces, written out: bed 3.47 % (1000 of 28 800 px) for 2 s, outside 3.47 % for
// 1.2 s (six active frames), then quiet. peak / out_peak are the outside fraction to 0.001 (0.0347 -> 0.035).
const EXIT_3_47 = [{ type: 'out_of_bed', peak: 0.035, out_peak: 0.035, out_frames: 6 }];

describe('#368 the bed-transition threshold is fixed; the alert keeps the slider', { concurrency: false }, () => {
  // ---- C1 ----
  test('#368 C1: the issue\'s reproduction (3.47 % in bed, then outside, then quiet) records the SAME exit at sensitivity 1, 50, 90 and 100', async (t) => {
    begin(t);
    for (const sens of SENS) {
      const r = await run(t, { sens }, exitScript(1000, 1000));
      assert.deepEqual(r.rows, EXIT_3_47,
        `sensitivity ${sens}: the stored exit depends on the alert slider (3.47 % is under the alert threshold below ~sensitivity 70)`);
    }
  });

  // ---- C2 ----
  // [percent of each zone, changed px, the stored peak to 0.001, or null when no exit may be recorded]. 1.0 % (288 px) is
  // under the constant's 342.69 px and 1.5 % (432 px) is over it, so the ladder also pins WHERE the line is: a threshold
  // moved to 0.5 % or to 2 % would still be identical across sensitivities and is caught by the null / non-null column.
  const LADDER = [[0.5, 144, null], [1.0, 288, null], [1.5, 432, 0.015], [3.47, 1000, 0.035], [6, 1728, 0.06], [20, 5760, 0.2]];
  for (const [pct, px, peak] of LADDER) {
    test(`#368 C2: a ${pct} % bed + outside burst gives identical rows and [oob]/[intobed]/[coactive] lines at sensitivity 1, 50, 90 and 100`, async (t) => {
      begin(t);
      const results = {};
      for (const sens of SENS) results[sens] = await run(t, { sens }, exitScript(px, px));
      for (const sens of SENS) {
        assert.deepEqual(onlyTransitions(results[sens]), onlyTransitions(results[90]),
          `sensitivity ${sens} recorded something different from sensitivity 90 for a ${pct} % burst`);
      }
      if (peak === null) {
        assert.deepEqual(results[90].rows, [], `a ${pct} % burst is under the 1.19 % threshold and must record no exit`);
      } else {
        assert.equal(results[90].rows.length, 1, `a ${pct} % burst is over the 1.19 % threshold and must record one exit`);
        assert.equal(results[90].rows[0].type, 'out_of_bed');
        assert.equal(results[90].rows[0].peak, peak);
      }
    });
  }

  // ---- C3 ----
  // The activity-only legs. `alerts` must be 0 on every one of them (an activity-only leg fires no alert at ANY
  // sensitivity), and the leg must really have run: the 3.47 % case records its exit.
  for (const kind of ['mqtt', 'onvif', 'motion-off']) {
    test(`#368 C3: an activity-only leg (${kind}) records the same exit at every sensitivity, none under 1.19 %, and never alerts`, async (t) => {
      begin(t);
      for (const sens of SENS) {
        const big = await run(t, { sens, kind }, exitScript(1000, 1000));
        assert.deepEqual(big.rows, EXIT_3_47, `${kind} at sensitivity ${sens}: the (hidden) stored sensitivity moved the stored exit`);
        assert.equal(big.alerts, 0, `${kind} at sensitivity ${sens} raised a motion alert`);
        assert.deepEqual(big.trace, (await run(t, { sens: 90, kind }, exitScript(1000, 1000))).trace, `${kind} at sensitivity ${sens}: the tracker's log lines differ from sensitivity 90`);
        // 1.0 % is above the 0.2 % the slider gives at 100 but below the fixed 1.19 %.
        const small = await run(t, { sens, kind }, exitScript(288, 288));
        assert.deepEqual(small.rows, [], `${kind} at sensitivity ${sens}: a 1.0 % burst (under the fixed threshold) recorded an exit`);
        assert.equal(small.alerts, 0);
      }
    });
  }

  // ---- C4 ----
  // [sensitivity, changed px of the bed zone, alerts]. The alert threshold is 10 % / 5.15 % / 1.19 % / 0.2 % of 28 800 px =
  // 2880 / 1483 / 343 / 58 px at 1 / 50 / 90 / 100.
  const ALERT_CASES = [
    [1, 1000, 0], [50, 1000, 0], [90, 1000, 1], [100, 1000, 1], // 3.47 %
    [1, 1728, 0], [50, 1728, 1], [90, 1728, 1], [100, 1728, 1], // 6 %
    [50, 288, 0], [90, 288, 0], [100, 288, 1], // 1.0 %: only the most sensitive setting alerts
  ];
  for (const [sens, px, expected] of ALERT_CASES) {
    test(`#368 C4: the ALERT still follows the slider: a ${((px / 28800) * 100).toFixed(2)} % sustained bed burst at sensitivity ${sens} ${expected ? 'alerts' : 'does not alert'}`, async (t) => {
      begin(t);
      const r = await run(t, { sens }, alertScript(px));
      assert.equal(r.alerts, expected, `sensitivity ${sens}, ${px} px of 28 800: expected ${expected} alert(s)`);
    });
  }

  // ---- C5 ----
  // 28 800 px zone: 342 / 28 800 = 1.1875 % (inactive), 343 / 28 800 = 1.1910 % (active). Both channels carry the same
  // count, an exit needs both active. Sensitivity 50 (old threshold 5.15 %: 343 px was inactive) and 100 (old 0.2 %: 342 px
  // was active) so each side of the boundary fails on the old code.
  for (const sens of [50, 100]) {
    test(`#368 C5: pixel boundary at sensitivity ${sens}: 342 of 28 800 px is inactive, 343 is active (an exit records only at 343)`, async (t) => {
      begin(t);
      assert.deepEqual((await run(t, { sens }, exitScript(342, 342))).rows, [], '342 px (1.1875 %) is under the 1.1899 % threshold');
      const at343 = await run(t, { sens }, exitScript(343, 343));
      assert.equal(at343.rows.length, 1, '343 px (1.1910 %) is over the threshold');
      assert.equal(at343.rows[0].type, 'out_of_bed');
    });
  }

  // 589 / 49 500 === BED_TRANSITION_ACTIVE_FRACTION exactly (a double), so `>=` is active and `>` is not: the one place a
  // `>=` -> `>` mutation shows. Needs a zone whose channel has 49 500 px: SMALL_ZONE for the OUTSIDE channel, BIG_ZONE for
  // the BED channel. The other channel carries 200 px (2.5 % of 8 100, far over) so only the equality channel decides.
  for (const sens of [50, 100]) {
    test(`#368 C5: equality at sensitivity ${sens}, OUTSIDE channel: 589 of 49 500 outside px is exactly the threshold and is active, 588 is not`, async (t) => {
      begin(t);
      assert.deepEqual((await run(t, { sens, geom: SMALL_ZONE }, exitScript(200, 588))).rows, [], '588 / 49 500 is under the threshold');
      const at589 = await run(t, { sens, geom: SMALL_ZONE }, exitScript(200, 589));
      assert.equal(at589.rows.length, 1, '589 / 49 500 equals the threshold and `>=` makes it active');
      assert.equal(at589.rows[0].type, 'out_of_bed');
    });
    test(`#368 C5: equality at sensitivity ${sens}, BED channel: 589 of a 49 500 px zone is exactly the threshold and is active, 588 is not`, async (t) => {
      begin(t);
      assert.deepEqual((await run(t, { sens, geom: BIG_ZONE }, exitScript(588, 200))).rows, [], '588 / 49 500 is under the threshold');
      const at589 = await run(t, { sens, geom: BIG_ZONE }, exitScript(589, 200));
      assert.equal(at589.rows.length, 1, '589 / 49 500 equals the threshold and `>=` makes it active');
      assert.equal(at589.rows[0].type, 'out_of_bed');
    });
  }

  // ---- C9 ----
  // The control: a camera at sensitivity 90 behaves exactly as it did before #368. Everything below was derived BY HAND
  // from the script (not recorded from a run) and passes on the old code too. Frame i is at T0 + 200 i ms.
  //   i=1   the bed's first active frame, nothing believed about occupancy, no outside activity this run: the
  //         "bed active with no entry link" line (cribWasIdle: cribLastActive was 0);
  //   i=2..10 more bed frames, 200 ms apart (inside the grace): no more near-miss lines;
  //   i=11  the first outside frame, bed last active at i=10 = 200 ms ago (inside the 8 s fast window): the candidate
  //         opens, outside 1000 / 28 800 = 3.47 % -> "3.5%";
  //   i=41  T0 + 8.2 s = 6 000 ms after the candidate opened, the bed quiet throughout: the exit confirms; the peak is
  //         the largest outside fraction since the candidate opened, 0.0347 -> "3.5%", stored to 0.001 as 0.035; six
  //         outside frames were active (i=11..16).
  test('#368 C9 (control): at sensitivity 90 one scripted night gives exactly the rows and lines the tracker gave before #368', async (t) => {
    begin(t);
    const r = await run(t, { sens: 90 }, exitScript(1000, 1000));
    assert.deepEqual(r.trace, [
      '[intobed] "CAM" bed active with no entry link — outside last active never (this run) (need <=8000ms), believed unknown',
      '[oob] "CAM" exit candidate (fast) — bed active 200ms ago, outside now 3.5%',
      '[oob] "CAM" OUT OF BED — motion left the bed, quiet 6000ms since, outside peak 3.5%',
    ]);
    assert.deepEqual(r.rows, [{ type: 'out_of_bed', peak: 0.035, out_peak: 0.035, out_frames: 6 }]);
    assert.equal(r.alerts, 0, 'a 1.8 s burst is under the 3 s confirm time');
  });

  // ---- C10 ----
  // The cancel band. Bed 6 % for 2 s, outside 6 % for 1.2 s (the exit candidate opens at i=11, T0 + 2.2 s), then ONE 2 %
  // (576 px) bed movement at i=26 (T0 + 5.2 s) that PERSISTS (the frames after it are identical, so it is a single
  // active frame). 2 % is between the 1.19 % constant and the old 5.15 % default threshold:
  //   - at the fixed threshold the bed frame is ACTIVE: it cancels the exit (pending for 5.2 - 2.2 = 3 000 ms) and, with
  //     the outside quiet since i=16 (the outside's last active frame, T0 + 3.2 s, 2 000 ms ago, inside the 8 s link),
  //     opens an entry candidate, which confirms 6 000 ms later (T0 + 11.2 s, i=56); bed peak 576 / 28 800 = 2.0 %, the
  //     outside lead-up evidence is the six 6 % frames (0.06, 6);
  //   - on the old code at sensitivity 50 the frame is inactive: the exit confirms at i=41 and no entry opens.
  // So the cancel band is not an alert preference: it is the same at every sensitivity.
  test('#368 C10: a 2 % bed movement cancels a pending exit and opens an entry, identically at sensitivity 1, 50, 90 and 100', async (t) => {
    begin(t);
    const script = [[0, 0]];
    for (let k = 1; k <= 10; k++) script.push([k % 2 ? 1728 : 0, 0]);
    for (let k = 1; k <= 6; k++) script.push([0, k % 2 ? 1728 : 0]);
    for (let i = 17; i <= 25; i++) script.push([0, 0]);
    for (let i = 26; i <= 62; i++) script.push([576, 0]);
    for (const sens of SENS) {
      const r = await run(t, { sens }, script);
      assert.deepEqual(r.trace, [
        '[intobed] "CAM" bed active with no entry link — outside last active never (this run) (need <=8000ms), believed unknown',
        '[oob] "CAM" exit candidate (fast) — bed active 200ms ago, outside now 6.0%',
        '[oob] "CAM" candidate cancelled — bed re-active after 3000ms',
        '[intobed] "CAM" entry candidate — outside active 2000ms ago, bed now 2.0%',
        '[intobed] "CAM" INTO BED — motion entered the bed, outside quiet 6000ms since, bed peak 2.0%',
      ], `sensitivity ${sens}: the tracker's lines`);
      assert.deepEqual(r.rows, [{ type: 'into_bed', peak: 0.02, out_peak: 0.06, out_frames: 6 }], `sensitivity ${sens}: the stored rows`);
    }
  });
});
