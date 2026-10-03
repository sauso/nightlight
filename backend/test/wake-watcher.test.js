// The live wake watcher: decides, minute by minute, whether what's happening is a wake worth
// recording or a stir to ignore.
//
// This is the whole feature's judgement, it runs unattended overnight behind a timer, and its two
// failure modes are both silent: record every stir and you quietly fill a disk that is already 98%
// full, or record nothing and the morning timeline still has no evidence behind it. Neither shows up
// in a log you'd read. So the state machine is tested directly, one synthetic minute at a time.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';

const DATA_DIR = useTempDataDir();

// Before any import that can spawn: an empty directory as the entire PATH, so ffmpeg never resolves.
// #446's regression test arms a REAL segmenter (clipRecorder.startSegmenter) to prove whether a WAKE
// hold gets taken — same technique, same reasoning, as clip-capture.test.js (read its header): a real
// ffmpeg would spawn against an RTSP address that isn't there, behave differently per machine, and leak
// a relaunching process into whatever test runs next. `node --test` runs each file in its own process,
// so this cannot leak into another suite.
const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

const { default: db } = await import('../src/db.js');
const { SLEEP_THRESHOLDS } = await import('../src/lib/sleepAnalysis.js');
const { startSegmenter, stopAllSegmenters, isSegmenterRunning, ringDepthMs } = await import('../src/lib/clipRecorder.js');
const { holdOwners, effectiveHold, RING_OWNER } = await import('../src/lib/ringHolds.js');
const activity = await import('../src/lib/activityTracker.js');
const { logger } = await import('../src/lib/logger.js');
const { handleMinute, startWakeWatcher, stopWakeWatcher, sweepStaleRuns, _state } =
  await import('../src/lib/wakeWatcher.js');

const { MOTION_ACTIVE, SOUND_ACTIVE, ONSET_QUIET_MIN, WAKE_ACTIVE_MIN, WAKE_GAP_MIN } = SLEEP_THRESHOLDS;

const CHILD = 'kid-1';
const CAM = 'cam-1';

// The watcher only runs inside a tracked child's sleep window, so the fixture opens a window that is
// always "now" regardless of when the suite runs.
// NOTE the hours are UTC, not local: the window is resolved against the app's `timezone` setting,
// which is 'UTC' on a fresh database. Building it from local hours shifts it by the dev machine's
// offset and the watcher is simply never in-window (which is exactly how this was first written).
function windowAroundNow() {
  const now = Date.now();
  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(now - 6 * 60 * 60 * 1000);
  const end = new Date(now + 6 * 60 * 60 * 1000);
  return {
    start: `${pad(start.getUTCHours())}:${pad(start.getUTCMinutes())}`,
    end: `${pad(end.getUTCHours())}:${pad(end.getUTCMinutes())}`,
  };
}

// A minute of activity, `n` minutes after the run's notional start.
//
// ⚠️ #448: the labels are measured from ONE minute-aligned instant fixed when the file loads, not from
// Date.now() at every call. The watcher now treats the distance between two labels as elapsed TIME, so a
// wall clock that rolled over a minute boundary between two calls of a test would shift the later label by a
// whole minute and read as a one-minute hole (or a repeated label), breaking settle() about once in every
// few thousand runs. The window the watcher checks is the real clock's (windowAroundNow), unaffected.
const BASE_MS = Math.floor(Date.now() / 60_000) * 60_000;
let clock = 0;
// Start (ms) of the minute the label `idx` names; the watcher's own `at` for it is this + 60 s.
const labelStartMs = (idx) => BASE_MS - (200 - idx) * 60 * 1000;
function labelFor(idx) {
  const t = new Date(labelStartMs(idx));
  const p = (x) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
}
const deliver = (bucketStart, motion = 0, sound = 0) =>
  handleMinute({ cameraId: CAM, bucketStart, motionPeak: motion, soundPeak: sound });
function minute({ motion = 0, sound = 0 } = {}) {
  const idx = clock;
  clock++;
  return deliver(labelFor(idx), motion, sound);
}
// The notional clock moves on by `n` minutes without a payload: what an outage looks like to the watcher,
// because activityTracker sends nothing at all for a minute with neither a motion frame nor a sound window.
const skip = (n) => { clock += n; };
// Where the watcher puts a run that starts at label `idx` (the minute's END, #447).
const endMs = (idx) => labelStartMs(idx) + 60 * 1000;
const stateOf = () => _state().get(CAM);

const quiet = () => minute({ motion: 0, sound: 0 });
const loud = () => minute({ sound: SOUND_ACTIVE + 10 });
const moving = () => minute({ motion: MOTION_ACTIVE + 0.05 });

// Walk past the onset gate: the watcher records nothing until the child is actually asleep.
function settle() {
  for (let i = 0; i < ONSET_QUIET_MIN; i++) quiet();
  assert.equal(_state().get(CAM).asleep, true, 'expected the watcher to be armed after the onset gate');
}

before(() => {
  const w = windowAroundNow();
  makeChild(db, { id: CHILD, name: 'Kid' });
  db.prepare('UPDATE children SET track_sleep = 1, sleep_window_start = ?, sleep_window_end = ? WHERE id = ?')
    .run(w.start, w.end, CHILD);
  makeCamera(db, { id: CAM, name: 'Kid Room', childId: CHILD });
});

after(() => {
  stopWakeWatcher();
  stopAllSegmenters();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  stopWakeWatcher();
  stopAllSegmenters(); // #446 tests arm a real segmenter; never let one leak into the next test
  _state().clear();
  clock = 0;
});

describe('the onset gate — bedtime settling is never recorded', () => {
  test('activity before the child is asleep does not start a run', () => {
    for (let i = 0; i < WAKE_ACTIVE_MIN + 3; i++) assert.equal(moving(), null);
    const st = _state().get(CAM);
    assert.equal(st.asleep, false, 'still awake — the onset gate has not passed');
    assert.equal(st.run, null, 'no run should be tracked before onset');
  });

  test('the gate needs CONTINUOUS quiet — a blip resets it', () => {
    for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
    loud(); // one noisy minute...
    assert.equal(_state().get(CAM).asleep, false, 'a blip must reset the quiet run');
    for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
    assert.equal(_state().get(CAM).asleep, false, 'still one minute short');
    quiet();
    assert.equal(_state().get(CAM).asleep, true);
  });
});

describe('stirs are ignored', () => {
  test(`a run of ${WAKE_ACTIVE_MIN - 1} active minutes never records`, () => {
    settle();
    for (let i = 0; i < WAKE_ACTIVE_MIN - 1; i++) assert.equal(moving(), null);
    // Then it goes quiet for longer than the bridging window, so the run is abandoned.
    for (let i = 0; i <= WAKE_GAP_MIN + 1; i++) quiet();
    assert.equal(_state().get(CAM).run, null, 'the stir should have been discarded');
  });

  test('a single active minute is not a wake', () => {
    settle();
    assert.equal(loud(), null);
    for (let i = 0; i <= WAKE_GAP_MIN + 1; i++) quiet();
    assert.equal(_state().get(CAM).run, null);
  });
});

describe('a wake records exactly once', () => {
  test(`${WAKE_ACTIVE_MIN} consecutive active minutes triggers a capture`, () => {
    settle();
    let fired = null;
    for (let i = 0; i < WAKE_ACTIVE_MIN; i++) fired = moving() || fired;
    assert.ok(fired?.captured, `expected a capture on the ${WAKE_ACTIVE_MIN}th active minute`);
  });

  test('the clip is anchored on the wake\'s FIRST active minute, not the minute it qualified', () => {
    settle();
    let first = null;
    let fired = null;
    for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
      moving();
      if (first == null) first = _state().get(CAM).run.startMs;
    }
    fired = _state().get(CAM).run;
    assert.equal(fired.captured, true);
    assert.equal(fired.startMs, first, 'capture must reach back to where the wake began');
  });

  test('a longer wake does not keep re-recording', () => {
    settle();
    let captures = 0;
    for (let i = 0; i < WAKE_ACTIVE_MIN + 10; i++) if (moving()?.captured) captures++;
    assert.equal(captures, 1, 'one clip per wake, not one per minute');
  });

  test('sound alone is enough — that is the case that never alerts', () => {
    // The wake that prompted this feature was 17 minutes of brief sound spikes with zero movement.
    settle();
    let fired = null;
    for (let i = 0; i < WAKE_ACTIVE_MIN; i++) fired = loud() || fired;
    assert.ok(fired?.captured, 'a sound-only wake must still be recorded');
  });

  test('activity just UNDER each threshold is not active at all', () => {
    settle();
    for (let i = 0; i < WAKE_ACTIVE_MIN + 2; i++) {
      assert.equal(minute({ motion: MOTION_ACTIVE, sound: SOUND_ACTIVE }), null, 'thresholds are exclusive');
    }
    assert.equal(_state().get(CAM).run, null);
  });
});

describe('intermittent wakes', () => {
  test(`quiet gaps up to ${WAKE_GAP_MIN} minutes are bridged into one wake`, () => {
    settle();
    let captures = 0;
    // active, gap, active, gap... — never WAKE_ACTIVE_MIN in a row, but WAKE_ACTIVE_MIN in total.
    for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
      if (moving()?.captured) captures++;
      if (i < WAKE_ACTIVE_MIN - 1) for (let g = 0; g < WAKE_GAP_MIN; g++) quiet();
    }
    assert.equal(captures, 1, 'an on-and-off wake is still one wake');
  });

  test(`a gap longer than ${WAKE_GAP_MIN} minutes splits the run`, () => {
    settle();
    for (let i = 0; i < WAKE_ACTIVE_MIN - 1; i++) moving();
    for (let g = 0; g <= WAKE_GAP_MIN + 1; g++) quiet();
    assert.equal(_state().get(CAM).run, null, 'the first run is over');
    // The next few active minutes start a fresh run rather than topping up the old count.
    for (let i = 0; i < WAKE_ACTIVE_MIN - 1; i++) assert.equal(moving(), null, 'must not inherit the old count');
  });
});

describe('scope guards', () => {
  test('a camera with no child is ignored entirely', () => {
    makeCamera(db, { id: 'cam-orphan', name: 'Hallway' });
    const r = handleMinute({
      cameraId: 'cam-orphan', bucketStart: '2026-08-25 11:05:00', motionPeak: 1, soundPeak: 99,
    });
    assert.equal(r, null);
    assert.equal(_state().get('cam-orphan').run, null);
  });

  test('sleep tracking turned off for the child disarms the watcher', () => {
    settle();
    db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
    try {
      for (let i = 0; i < WAKE_ACTIVE_MIN + 2; i++) assert.equal(moving(), null);
      assert.equal(_state().get(CAM).asleep, false, 'watcher should have been reset');
    } finally {
      db.prepare('UPDATE children SET track_sleep = 1 WHERE id = ?').run(CHILD);
    }
  });

  test('an unknown camera id does not throw', () => {
    assert.equal(
      handleMinute({ cameraId: 'nope', bucketStart: '2026-08-25 11:05:00', motionPeak: 1, soundPeak: 1 }),
      null
    );
  });

  test('a malformed bucket timestamp is ignored rather than poisoning the run', () => {
    settle();
    assert.equal(
      handleMinute({ cameraId: CAM, bucketStart: 'not-a-time', motionPeak: 1, soundPeak: 1 }),
      null
    );
  });
});

describe('a camera that stops reporting mid-wake', () => {
  // activityTracker only flushes cameras that saw signal, so a camera going offline mid-run stops
  // calling the watcher altogether. Nothing on the per-minute path can notice that — precisely because
  // the per-minute path has stopped — so an un-swept run would hold its ring open for as long as the
  // camera stayed down, and the ring grows without bound.
  test('has its run abandoned by the sweep, rather than holding the ring forever', () => {
    settle();
    for (let i = 0; i < WAKE_ACTIVE_MIN - 1; i++) moving(); // a run in progress, not yet a wake
    assert.ok(_state().get(CAM).run, 'precondition: a run is open');

    // Anchored on the run's own last active minute, not wall-clock: the synthetic minutes above are
    // deliberately backdated, so Date.now() would already look "stale" to the sweep.
    const lastActive = _state().get(CAM).run.lastActiveMs;
    assert.equal(sweepStaleRuns(lastActive + 1000), 0, 'a fresh run must not be swept');
    assert.ok(_state().get(CAM).run, 'still open');

    assert.equal(sweepStaleRuns(lastActive + 60 * 60 * 1000), 1);
    assert.equal(_state().get(CAM).run, null, 'the stale run is gone');
  });

  test('the sweep leaves cameras with no run alone', () => {
    settle(); // armed, but nothing active — so there is no run to sweep
    assert.equal(_state().get(CAM).run, null);
    assert.equal(sweepStaleRuns(Date.now() + 60 * 60 * 1000), 0);
  });
});

describe('★ #446 — a WAKE hold is gated on wake clips actually being enabled', () => {
  // clipCapture.js's reconcileClipRing defers stopping a ring that's no longer wanted while ANY hold
  // exists on it. Before this fix, handleMinute took a WAKE hold for every active run purely because a
  // segmenter was running, with no regard for wake_clips_enabled — so after an admin switched wake clips
  // off, a restless child kept creating pointless WAKE holds (captureWakeClip already no-ops when
  // disabled — recordings.js) and the ring's stop kept getting deferred until the sleep window ended.
  //
  // Both tests arm a REAL segmenter (clipRecorder.startSegmenter) rather than stub isSegmenterRunning,
  // because that live map entry is the actual gate handleMinute checks. With no ffmpeg on PATH the
  // entry only exists SYNCHRONOUSLY, right after startSegmenter returns — the spawn's 'error' event
  // deletes it on a later tick (see the file-header note and clip-capture.test.js's own). handleMinute,
  // settle() and moving() are all plain synchronous calls, so running them with no `await` in between
  // keeps the segmenter "live" for the whole test.
  function armSegmenter() {
    const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
    startSegmenter(CAM, camera.mediamtx_path, { preRollSec: 5, postRollSec: 15 });
    assert.equal(isSegmenterRunning(CAM), true, 'precondition: the segmenter armed synchronously');
  }

  test('an active run on a sleeping child takes NO hold once wake clips are switched off (fails on current code)', () => {
    db.prepare("UPDATE settings SET wake_clips_enabled = 0 WHERE id = 'app'").run();
    armSegmenter();

    settle();
    for (let i = 0; i < WAKE_ACTIVE_MIN; i++) moving();

    assert.deepEqual(holdOwners(CAM), [], 'a WAKE hold was taken even though wake clips are disabled');
  });

  test('the same run DOES take a WAKE hold when wake clips are enabled (control)', () => {
    db.prepare("UPDATE settings SET wake_clips_enabled = 1 WHERE id = 'app'").run();
    armSegmenter();

    settle();
    for (let i = 0; i < WAKE_ACTIVE_MIN; i++) moving();

    assert.deepEqual(holdOwners(CAM), [RING_OWNER.WAKE], 'a WAKE hold should have been taken');
  });
});

describe('★ #447 — the WAKE hold is taken young enough for every ring size the settings allow', () => {
  // activityTracker labels a minute by when its samples ARRIVED and hands it over at the minute's END, on a
  // 1 s tick. handleMinute anchors the run at that END and holds the ring HOLD_LEAD_MS (15 s) before it. The
  // ring is only as deep as the clip settings make it (clipRecorder.ringDepthMsFor, nothing sizes it for wake
  // clips): 63 s with on-demand Record on, 38 s with it off, 23 s at the smallest clip settings. A hold point
  // older than the ring when it is taken protects nothing: the lead-in is already gone.
  // This drives the REAL chain — samples into the tracker, its ticks, its listener into handleMinute, the hold —
  // so it fails both on a minute delivered late (at +GRACE, 22.9 s old here) and on a hold anchored at the
  // minute's START (75.9 s old here: past every ring). Before #447 the hold was 15 s + the flush phase (0-60 s)
  // old; ≤ 16 s is never worse than the best case that had.
  for (const { preRollSec, postRollSec, ring, why } of [
    { preRollSec: 30, postRollSec: 15, ring: 63_000, why: 'on-demand Record on (its 30 s pre-roll)' },
    { preRollSec: 5, postRollSec: 15, ring: 38_000, why: 'Record off, default clip settings' },
    { preRollSec: 0, postRollSec: 5, ring: 23_000, why: 'the smallest clip settings allowed' },
  ]) {
    test(`${ring / 1000} s ring (${why}): the hold point is at most 16 s old when it is taken, and at least 15 s`, () => {
      db.prepare("UPDATE settings SET wake_clips_enabled = 1 WHERE id = 'app'").run();
      const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
      startSegmenter(CAM, camera.mediamtx_path, { preRollSec, postRollSec });
      assert.equal(ringDepthMs(CAM), ring, 'precondition: the ring this case is about');
      settle();
      activity._resetActivityTrackerForTests();
      const off = activity.onMinuteFlushed(handleMinute);
      try {
        // The last whole minute: inside the child's window, which is built around the real clock.
        const M = Math.floor(Date.now() / 60_000) * 60_000 - 60_000;
        activity.recordMotion(CAM, MOTION_ACTIVE + 0.05, null, M + 20_000); // the wake's first active minute
        let takenAt = null;
        // The tracker's 1 s timer on a .9 s phase: the worst case, the minute ends just after a tick.
        for (let t = M + 900; t < M + 3 * 60_000 && takenAt === null; t += 1000) {
          activity.flushActivity(t);
          if (effectiveHold(CAM) !== null) takenAt = t;
        }
        assert.ok(takenAt !== null, 'a WAKE hold was taken');
        assert.deepEqual(holdOwners(CAM), [RING_OWNER.WAKE]);
        const age = takenAt - effectiveHold(CAM);
        assert.ok(age <= ring, `the hold point was ${age} ms old against a ${ring} ms ring: the lead-in is gone`);
        assert.ok(age <= 16_000, `the hold point was ${age} ms old: more than HOLD_LEAD_MS + one tick`);
        // ...and from BELOW (#447 fix round 1: with only the upper bound, an anchor a minute or 30 s LATER than the
        // minute's end passed, because a hold point in the future has a negative age). The listener hears a minute
        // at or after its end, so an anchor at the end is never later than the tick that took the hold, and the
        // hold sits HOLD_LEAD_MS (15 s, wakeWatcher.js, not exported) before that anchor: at least 15 s old. Less
        // means the anchor is a moment that had not happened yet, and the clip would open after the movement.
        assert.ok(age >= 15_000, `the hold point was ${age} ms old: younger than HOLD_LEAD_MS, so anchored in the future`);
      } finally {
        off();
      }
    });
  }
});

// -------------------------------------------------------------------------------------------
// ★ THE NUMBERS THEMSELVES. Everything above this line derives its fixtures, its loop bounds and even
// its test NAMES from SLEEP_THRESHOLDS, which makes it a good test of the state machine and no test at
// all of the thresholds: issue #263 confirmed that all 18 tests pass with `WAKE_ACTIVE_MIN` at 60 and
// `MOTION_ACTIVE` at 0.25 — one quiet minute declaring a child asleep, or an hour of crying not
// counting as a wake, and the suite stays green. That is one of the four trap shapes the issue names,
// and it is the subtlest, because the derivation looks like good practice.
//
// The parameterised tests stay: the state machine genuinely IS parameterised, and re-deriving the
// numbers by hand in twenty places would be worse. What is added here is the missing half — the values
// pinned against literals, and a handful of fixtures whose numbers are REAL READINGS rather than
// expressions in the constants.
describe('★ the calibrated thresholds are pinned, not merely referenced', () => {
  test('the five exported constants have exactly these values', () => {
    // ⚠️ CHANGING A NUMBER HERE IS A DELIBERATE ACT. Each was measured on two cameras in one house
    // (see the provenance comments in sleepAnalysis.js); they are hypotheses about every other room,
    // not laws. If you are re-tuning, update this test in the SAME commit and say in the PR which
    // nights moved it — that is the house rule for a calibrated number.
    assert.deepEqual(
      { ...SLEEP_THRESHOLDS },
      {
        MOTION_ACTIVE: 0.01, // in-bed changed-fraction above this = real movement (a sleeping room reads ~0)
        SOUND_ACTIVE: 6, // dB over ambient = a clear noise/cry
        ONSET_QUIET_MIN: 15, // continuous quiet minutes before we call it asleep
        WAKE_ACTIVE_MIN: 5, // active minutes inside one run before it is a wake, not a stir
        WAKE_GAP_MIN: 3, // quiet minutes bridged inside a single wake
      }
    );
  });

  test('the live watcher and the nightly job share ONE definition, by reference', () => {
    // wakeWatcher imports SLEEP_THRESHOLDS rather than copying the numbers, so a clip can never appear
    // for a wake the morning timeline does not show. Object.freeze is what stops a caller mutating the
    // shared object out from under the other half.
    assert.equal(Object.isFrozen(SLEEP_THRESHOLDS), true, 'a caller could rewrite the thresholds at runtime');
  });
});

describe('★ what the numbers MEAN, in real readings rather than expressions', () => {
  // These use literal values taken from the measurements the constants were set from, so each fails if
  // its threshold drifts — without any test needing to name the constant. Between them they band every
  // number: raising or lowering it past the stated point breaks a named test with a stated reason.

  // 20 > ONSET_QUIET_MIN (15), spelled as a literal so this settles independently of the constant.
  const settleLiterally = () => {
    for (let i = 0; i < 20; i++) quiet();
    assert.equal(_state().get(CAM).asleep, true, 'twenty quiet minutes did not arm the watcher');
  };

  test('a bed reading of 0.05 is movement — a genuine climb-out reads 0.07-0.10', () => {
    // Fails if MOTION_ACTIVE rises above 0.05. The spurious outside-bed readings on record top out at
    // 0.023 and the quietest genuine event measured 0.074, so anything at or above 0.05 must count.
    settleLiterally();
    let fired = null;
    for (let i = 0; i < 10; i++) fired = minute({ motion: 0.05 }) || fired;
    assert.ok(fired?.captured, 'a real movement reading was treated as a quiet minute');
  });

  test('a bed reading of 0.001 is not — a motionless child still registers ~0.0002-0.004', () => {
    // Fails if MOTION_ACTIVE drops below 0.001, which would make a still, occupied bed look like a
    // wake every night. The measured in-bed floor for the STILLEST genuine bedtime on record is 0.0045.
    settleLiterally();
    for (let i = 0; i < 10; i++) assert.equal(minute({ motion: 0.001 }), null, 'the noise floor was read as a wake');
  });

  test('8 dB over ambient is a cry; 2 dB is the room', () => {
    // Bands SOUND_ACTIVE into (2, 8]. A sound-only wake is the case that never produces an alert, so
    // both directions matter: too high and a crying child is invisible, too low and the house next door
    // records a clip every night.
    settleLiterally();
    let fired = null;
    for (let i = 0; i < 10; i++) fired = minute({ sound: 8 }) || fired;
    assert.ok(fired?.captured, '8 dB over ambient did not count as a noise');

    _state().clear();
    clock = 0;
    settleLiterally();
    for (let i = 0; i < 10; i++) assert.equal(minute({ sound: 2 }), null, '2 dB over ambient was treated as a cry');
  });

  test('three quiet minutes is not asleep; twenty is', () => {
    // Bands ONSET_QUIET_MIN into (3, 20]. The low end is the one that matters: at 1, a child put down
    // and briefly still is "asleep", and the first minute of settling gets recorded as a wake.
    for (let i = 0; i < 3; i++) quiet();
    assert.equal(_state().get(CAM).asleep, false, 'three quiet minutes was enough to call it asleep');
    for (let i = 0; i < 17; i++) quiet();
    assert.equal(_state().get(CAM).asleep, true, 'twenty quiet minutes was not enough');
  });

  test('ten active minutes is a wake; two is a stir', () => {
    // Bands WAKE_ACTIVE_MIN into (2, 10]. At 60 (the mutant #263 reports surviving) an hour of crying
    // records nothing; at 1 every roll-over produces a clip and fills the disk.
    settleLiterally();
    let captures = 0;
    for (let i = 0; i < 10; i++) if (minute({ motion: 0.05 })?.captured) captures++;
    assert.equal(captures, 1, 'ten active minutes did not produce exactly one clip');

    _state().clear();
    clock = 0;
    settleLiterally();
    assert.equal(minute({ motion: 0.05 }), null);
    assert.equal(minute({ motion: 0.05 }), null, 'two active minutes recorded a clip');
  });

  test('a two-minute pause stays one wake; a thirty-minute one does not', () => {
    // Bands WAKE_GAP_MIN into [2, 30). Intermittent crying with short pauses is the ordinary shape of a
    // real wake; half an hour of quiet in between is two separate ones.
    settleLiterally();
    let captures = 0;
    for (let i = 0; i < 10; i++) {
      if (minute({ motion: 0.05 })?.captured) captures++;
      if (i < 9) { quiet(); quiet(); }
    }
    assert.equal(captures, 1, 'two-minute pauses split one wake into several (or into none)');

    _state().clear();
    clock = 0;
    settleLiterally();
    minute({ motion: 0.05 });
    minute({ motion: 0.05 });
    for (let i = 0; i < 30; i++) quiet();
    assert.equal(_state().get(CAM).run, null, 'a thirty-minute silence did not end the run');
  });

  // #448 (C16). The bridge limit is in MINUTES, whoever did or did not report them: the literals 3 and 4 are
  // the WAKE_GAP_MIN boundary spelled out (a gap of 3 non-active minutes bridges, 4 splits, as the nightly
  // job's markWakeRuns), so a drift of the constant breaks a named test without any fixture being derived
  // from it. Both kinds of gap: minutes that arrived quiet, and minutes that never arrived at all.
  for (const [what, fill] of [
    ['unreported minutes', (n) => { clock += n; }],
    ['quiet minutes', (n) => { for (let i = 0; i < n; i++) quiet(); }],
  ]) {
    test(`C16: five active minutes 3 ${what} apart are one wake; 4 ${what} apart are five stirs`, () => {
      const wakeWithGap = (between) => {
        settleLiterally();
        let captures = 0;
        for (let i = 0; i < 5; i++) {
          if (minute({ motion: 0.05 })?.captured) captures++;
          if (i < 4) fill(between);
        }
        return captures;
      };
      assert.equal(wakeWithGap(3), 1, `a gap of 3 ${what} should be bridged`);
      _state().clear();
      clock = 0;
      assert.equal(wakeWithGap(4), 0, `a gap of 4 ${what} should split the run`);
    });
  }
});

describe('★ #448 — the watcher counts MINUTES, not callbacks', () => {
  // The live watcher is the mirror of the nightly job's wake rule (sleepAnalysis.js markWakeRuns), and the
  // nightly job treats a minute with no reading as NON-ACTIVE: a run bridges at most WAKE_GAP_MIN of them,
  // observed-quiet or missing. Before #448 the watcher counted callbacks instead of minutes, which broke it
  // three ways at once: an ACTIVE sample after a hole never checked elapsed time (the issue's repro: five
  // active minutes ten minutes apart were ONE wake), settling counted callbacks (14 quiet minutes, a
  // 40-minute outage and 1 more quiet minute armed the watcher), and the 20-minute sweep was never the
  // bridge enforcer its header comment claimed.
  //
  // THE SHAPE OF A HOLE: activityTracker.closeMinute calls its listeners only `if (hasSignal(s))`, so a minute
  // with neither a motion frame nor a sound window produces NO payload (not a payload of nulls). An outage is
  // visible only as a jump in `bucketStart`; `skip(n)` is exactly that. C14 pins this premise against the
  // real tracker instead of assuming it.
  //
  // ⚠️ SWEEP TRAP (plan review, verified): this file's labels sit ~200 minutes in the past, so
  // sweepStaleRuns() with its default Date.now() would end EVERY run here and any test that calls it would
  // pass on the old code. Every sweep call below takes the SIMULATED time (run.lastActiveMs + k minutes).

  // Deliver `n` active minutes; the startMs of every capture they produced.
  function actives(n, fn = moving) {
    const got = [];
    for (let i = 0; i < n; i++) {
      const r = fn();
      if (r?.captured) got.push(r.startMs);
    }
    return got;
  }

  // A REAL segmenter, as the #446 tests arm one (see that block for why): the entry exists only
  // synchronously, so every call that needs it must run with no `await` in between.
  function armSegmenterNow() {
    const camera = db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
    startSegmenter(CAM, camera.mediamtx_path, { preRollSec: 5, postRollSec: 15 });
    assert.equal(isSegmenterRunning(CAM), true, 'precondition: the segmenter armed synchronously');
  }
  const wakeClips = (on) => db.prepare("UPDATE settings SET wake_clips_enabled = ? WHERE id = 'app'").run(on ? 1 : 0);

  describe('a hole in the readings is time, not nothing', () => {
    test('C1: the issue\'s fixture (five active minutes ten minutes apart) is five stirs, not one wake', () => {
      settle();
      const got = [];
      for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
        const idx = clock;
        const r = moving();
        if (r?.captured) got.push(r.startMs);
        const run = stateOf().run;
        assert.equal(run.activeCount, 1, `active minute ${i + 1}: the run must have restarted after the hole`);
        assert.equal(run.startMs, endMs(idx), `active minute ${i + 1}: the new run starts HERE`);
        // C15: the 20-minute sweep is not what enforces the bridge. Ten minutes of simulated silence never
        // reaches it, so a split that only happened because of the sweep would show up as a nonzero count.
        for (let k = 1; k <= 9; k++) {
          assert.equal(sweepStaleRuns(run.lastActiveMs + k * 60_000), 0, `C15: the sweep must not be what ends the run (+${k} min)`);
        }
        skip(9); // the next active minute is ten minutes after this one
      }
      assert.deepEqual(got, [], 'nothing may be recorded: the nightly job sees five one-minute runs, zero wakes');
    });

    test(`C2 (control): five active minutes ${WAKE_GAP_MIN} unreported minutes apart are still ONE wake`, () => {
      settle();
      const got = [];
      for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
        got.push(...actives(1));
        if (i < WAKE_ACTIVE_MIN - 1) skip(WAKE_GAP_MIN);
      }
      assert.deepEqual(got, [endMs(ONSET_QUIET_MIN)], 'a gap of exactly the bridge limit is bridged, whoever did not report it');
    });

    test(`C3: one minute past the bridge (${WAKE_GAP_MIN + 1} unreported minutes) splits the run`, () => {
      settle();
      const got = [];
      for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
        got.push(...actives(1));
        assert.equal(stateOf().run.activeCount, 1, `active minute ${i + 1}: each one opens a fresh run`);
        skip(WAKE_GAP_MIN + 1);
      }
      assert.deepEqual(got, []);
    });

    test(`C4a (control): the quiet branch is unchanged — ${WAKE_GAP_MIN} quiet minutes still bridge`, () => {
      settle();
      actives(WAKE_ACTIVE_MIN - 1);
      for (let g = 0; g < WAKE_GAP_MIN; g++) quiet();
      assert.deepEqual(actives(1), [endMs(ONSET_QUIET_MIN)]);
    });

    test(`C4b (control): the quiet branch is unchanged — ${WAKE_GAP_MIN + 1} quiet minutes end the run`, () => {
      settle();
      actives(WAKE_ACTIVE_MIN - 1);
      for (let g = 0; g < WAKE_GAP_MIN + 1; g++) quiet();
      assert.equal(stateOf().run, null, 'ended by the quiet minute that made the gap one too long');
      assert.deepEqual(actives(1), [], 'the fifth active minute starts a fresh run, it does not complete the old one');
    });

    test('C5: two real wakes with an outage between them are two captures, not one', () => {
      settle();
      const first = actives(WAKE_ACTIVE_MIN);
      skip(10);
      const second = actives(WAKE_ACTIVE_MIN);
      assert.equal(first.length, 1);
      assert.equal(second.length, 1, 'the second wake was merged into the first');
      assert.equal(second[0] - first[0], (WAKE_ACTIVE_MIN + 10) * 60_000, 'the second clip starts at the second wake');
    });

    test('C12b: the bridge is measured from the last ACTIVE minute, not from the last payload', () => {
      // 4 active, 2 quiet, 2 missing, active: 4 non-active minutes between the actives, which the nightly job
      // splits. A rule that restarts its clock at every payload sees a gap of only 2 after the last quiet one,
      // bridges, and records a wake: it passes C1, C3 and C5 and fails only here.
      settle();
      actives(WAKE_ACTIVE_MIN - 1);
      quiet();
      quiet();
      skip(2);
      assert.deepEqual(actives(1), [], 'a hole after quiet payloads extends the same gap');
      assert.equal(stateOf().run.activeCount, 1);
    });

    test('C8 (control): a hole does NOT disarm an armed watcher', () => {
      // Only the settling PROGRESS is reset by a hole. Disarming would drop a real wake that follows a camera
      // reconnect, and the arming gate exists only to keep bedtime settling out of the recorder.
      settle();
      skip(90);
      assert.deepEqual(actives(WAKE_ACTIVE_MIN), [endMs(ONSET_QUIET_MIN + 90)]);
      assert.equal(stateOf().asleep, true);
    });
  });

  describe('settling needs consecutive OBSERVED minutes', () => {
    test('C6: 14 quiet minutes, one missing minute, 1 more is NOT asleep; the count restarted at the hole', () => {
      for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
      skip(1);
      quiet();
      assert.equal(stateOf().asleep, false, 'the missing minute counted toward the 15');
      assert.equal(stateOf().quietRun, 1, 'the count restarted at the hole');
      for (let i = 0; i < ONSET_QUIET_MIN - 2; i++) quiet();
      assert.equal(stateOf().asleep, false, 'fourteen consecutive observed minutes since the hole: one short');
      quiet();
      assert.equal(stateOf().asleep, true, 'fifteen consecutive observed minutes since the hole');
    });

    test('C7: a LONG outage is not settled time either (14 quiet, 60 missing, 1 more)', () => {
      for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
      skip(60);
      quiet();
      assert.equal(stateOf().asleep, false, 'an hour nobody saw armed the watcher');
      for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
      assert.equal(stateOf().asleep, true, 'control half: 15 contiguous observed minutes do arm it');
    });
  });

  describe('an ordering guard on the labels', () => {
    test('C9: a repeated label counts ONCE (defensive branch): five copies of one active minute are not a wake', () => {
      settle();
      const idx = clock;
      moving();
      for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
        assert.equal(deliver(labelFor(idx), MOTION_ACTIVE + 0.05), null, 'a repeated label must never capture');
      }
      assert.equal(stateOf().run.activeCount, 1, 'the copies were counted');
    });

    test('C9b: a repeated QUIET label does not advance settling', () => {
      for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
      const idx = clock - 1;
      for (let i = 0; i < 3; i++) deliver(labelFor(idx), 0, 0);
      assert.equal(stateOf().asleep, false, 'a repeated label counted as a new quiet minute');
      assert.equal(stateOf().quietRun, ONSET_QUIET_MIN - 1);
      quiet();
      assert.equal(stateOf().asleep, true);
    });

    test('C10: a label that goes BACKWARDS ends the run and re-baselines: not deaf, and no inherited count', () => {
      settle();
      actives(3);
      assert.equal(stateOf().run.activeCount, 3, 'precondition');
      clock -= 60; // the wall clock steps back an hour
      const stepIdx = clock;
      const calls = [];
      for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
        calls.push(moving());
        if (i === 0) {
          assert.equal(stateOf().run.activeCount, 1, 'the run before the step was ended, not extended');
          assert.equal(stateOf().run.startMs, endMs(stepIdx), 'the new run starts at the first label after the step');
        }
      }
      // WHICH call captures and WHICH startMs is what discriminates: today's code carries the old count over and
      // captures on the 2nd call with the old run's startMs; a "drop older labels" version never captures.
      assert.deepEqual(calls.map((r) => r?.captured === true), [false, false, false, false, true], 'the 5th call, not an earlier one');
      assert.equal(calls[4].startMs, endMs(stepIdx), 'startMs is the first of the five re-lived minutes');
    });

    test('C10b: a backward label resets the settling progress (14 quiet, step back, quiet is not asleep)', () => {
      for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
      clock = 2;
      quiet(); // the first minute after the step
      assert.equal(stateOf().asleep, false, 'progress made before the step was carried across it');
      assert.equal(stateOf().quietRun, 1);
      for (let i = 0; i < ONSET_QUIET_MIN - 2; i++) quiet();
      assert.equal(stateOf().asleep, false);
      quiet();
      assert.equal(stateOf().asleep, true, 'fifteen consecutive minutes after the step');
    });

    // Fix round 1 (#448 review): a SMALL backward step is a backward step too. C10 steps a whole hour, which any
    // threshold between 0 and 60 minutes passes; these step exactly 1, 2 and 3 minutes (the sizes a `< lastAt - N`
    // mutant tolerates), so a rule that only notices "big" steps back fails here. activityTracker itself absorbs
    // steps of up to STEP_CLAMP_MS (2 min) before they reach the watcher, but the watcher must not depend on that:
    // it is a different module's number and the ordering guard is written against the labels alone.
    for (const back of [1, 2, 3]) {
      test(`C10c: a label ${back} min OLDER than the last one still ends the run and re-baselines`, () => {
        settle();
        actives(3);
        const lastIdx = clock - 1; // the label of the 3rd active minute
        assert.equal(stateOf().run.activeCount, 3, 'precondition');
        clock = lastIdx - back;
        const stepIdx = clock;
        const calls = [];
        for (let i = 0; i < WAKE_ACTIVE_MIN; i++) {
          calls.push(moving());
          if (i === 0) {
            assert.equal(stateOf().run.activeCount, 1, `a label ${back} min back inherited the old run's count`);
            assert.equal(stateOf().run.startMs, endMs(stepIdx), 'the new run starts at the first label after the step');
          }
        }
        assert.deepEqual(calls.map((r) => r?.captured === true), [false, false, false, false, true], 'the 5th call, not an earlier one');
        assert.equal(calls[4].startMs, endMs(stepIdx), 'startMs is the first of the five re-lived minutes');
      });

      test(`C10d: a label ${back} min OLDER than the last one resets the settling progress`, () => {
        for (let i = 0; i < ONSET_QUIET_MIN - 1; i++) quiet();
        clock = clock - 1 - back; // `back` minutes before the last accepted label
        quiet();
        assert.equal(stateOf().quietRun, 1, `the ${back}-minute step back carried the settling progress across it`);
        assert.equal(stateOf().asleep, false);
        for (let i = 0; i < ONSET_QUIET_MIN - 2; i++) quiet();
        assert.equal(stateOf().asleep, false, 'fourteen consecutive minutes since the step: one short');
        quiet();
        assert.equal(stateOf().asleep, true, 'fifteen consecutive minutes since the step');
      });
    }

    test('C12: reset() forgets lastAt: a label re-delivered after the watcher left the window is a NEW minute', () => {
      // Not "the first sample after returning counts 1": that passes whether or not lastAt was cleared
      // (plan review verified). Re-delivering the label from just BEFORE the reset is what tells them apart:
      // cleared, it is a fresh quiet minute; kept, it is a repeated label and is ignored.
      for (let i = 0; i < 5; i++) quiet();
      const lastIdx = clock - 1;
      assert.equal(stateOf().lastAt, endMs(lastIdx), 'precondition: lastAt follows the last accepted label');
      db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
      try {
        quiet(); // out of tracking: the watcher resets
      } finally {
        db.prepare('UPDATE children SET track_sleep = 1 WHERE id = ?').run(CHILD);
      }
      assert.equal(stateOf().quietRun, 0);
      assert.equal(stateOf().lastAt, null, 'reset() left a stale lastAt behind');
      clock = lastIdx;
      quiet();
      assert.equal(stateOf().quietRun, 1, 'the re-delivered label was treated as a repeat of the one before the reset');
    });
  });

  describe('the ring hold follows the run', () => {
    test('C11: after a hole the NEW run holds from ITS first minute, with one WAKE owner and a log line', () => {
      try {
        wakeClips(true);
        armSegmenterNow();
        settle();
        logger.clear();
        const t0 = clock;
        moving();
        assert.equal(effectiveHold(CAM), endMs(t0) - 15_000, 'precondition: held from the first minute');
        skip(10);
        const t1 = clock;
        moving();
        assert.deepEqual(holdOwners(CAM), [RING_OWNER.WAKE]);
        assert.equal(effectiveHold(CAM), endMs(t1) - 15_000, 'the hold is still anchored on the run the hole ended');
        assert.ok(
          logger.getRecent().some((l) => l.includes('run ended (readings 11 min apart)')),
          'the log must say the READINGS were apart (a forward clock jump looks the same), not claim an outage'
        );
      } finally {
        wakeClips(true);
      }
    });

    test('C11 (leak half): the ended run\'s hold is RELEASED even when the new run takes none (wake clips switched off in the hole)', () => {
      // One hold slot per owner: with wake clips on, the new run's hold would overwrite the old one and hide a
      // missed release. Switching them off during the hole is what makes a leak visible.
      try {
        wakeClips(true);
        armSegmenterNow();
        settle();
        moving();
        assert.deepEqual(holdOwners(CAM), [RING_OWNER.WAKE], 'precondition');
        skip(10);
        wakeClips(false);
        moving();
        assert.deepEqual(holdOwners(CAM), [], 'the old run\'s hold leaked');
      } finally {
        wakeClips(true);
      }
    });

    test('C11b: the late .finally of an OLD capture cannot release a NEW run\'s hold (run identity, not startMs)', async () => {
      // Everything up to the first await is synchronous so the segmenter entry exists and the old capture's
      // promise chain has not run yet. The old run captures (clips switched off just before, so the attempt
      // resolves at once and its .finally is queued); the clock steps back to exactly the first label, which
      // starts a NEW run with the SAME startMs and its own hold. A guard on startMs equality releases it.
      try {
        wakeClips(true);
        armSegmenterNow();
        settle();
        const firstIdx = clock;
        moving();
        assert.equal(stateOf().run.holding, true, 'precondition: the first minute took a hold');
        wakeClips(false);
        for (let i = 1; i < WAKE_ACTIVE_MIN; i++) moving();
        const oldRun = stateOf().run;
        assert.equal(oldRun.captured, true, 'precondition: the run captured');
        wakeClips(true);
        clock = firstIdx;
        moving();
        const newRun = stateOf().run;
        assert.notEqual(newRun, oldRun);
        assert.equal(newRun.startMs, oldRun.startMs, 'precondition: the same startMs, which is what fooled the old guard');
        assert.equal(newRun.holding, true, 'precondition: the new run took its own hold');
        await new Promise((resolve) => setImmediate(resolve)); // NOW the old capture's .finally runs
        assert.equal(stateOf().run, newRun);
        assert.equal(newRun.holding, true, 'the old capture released the new run\'s hold');
        assert.deepEqual(holdOwners(CAM), [RING_OWNER.WAKE]);
      } finally {
        wakeClips(true);
      }
    });
  });

  // Fix round 1 (#448 review): the WORDING of "run ended" is the only trace an operator has of why a run was
  // dropped, and endRun only logs when the run was HOLDING a ring hold, so these need a REAL segmenter (as the
  // #446 tests arm one: the entry exists only synchronously, so no await before the last assertion). A mutant
  // that changes only a log argument is invisible to every assertion on state; these pin the three reasons and
  // the "a captured run says nothing" rule.
  describe('what the log says when a held run ends', () => {
    const runEndedLines = () => logger.getRecent().filter((l) => l.includes('run ended'));
    const nothingRecordedLines = () => logger.getRecent().filter((l) => l.includes('nothing recorded'));
    function armedWithHeldRun(activeMin) {
      wakeClips(true);
      armSegmenterNow();
      settle();
      logger.clear();
      actives(activeMin);
      assert.equal(stateOf().run.holding, true, 'precondition: the run holds the ring');
    }

    test('C17a: a run ended by a hole says the READINGS were N min apart, with the right N', () => {
      try {
        armedWithHeldRun(2);
        skip(10);
        moving();
        const lines = runEndedLines();
        assert.equal(lines.length, 1, `expected exactly one "run ended" line, got ${JSON.stringify(lines)}`);
        assert.match(lines[0], /run ended \(readings 11 min apart\)/);
      } finally {
        wakeClips(true);
      }
    });

    test('C17b: ONE missing minute is still a hole, and is named as one (3 quiet reported, 1 missing, active)', () => {
      // 2 active, 3 quiet payloads (3 non-active minutes: still bridged), 1 missing minute, then an active one:
      // 4 non-active minutes between the actives, so the run ends, and exactly one of them was a missing minute.
      // A `missingMin > 1` test for "was there a hole" would call this one a plain stir.
      try {
        armedWithHeldRun(2);
        quiet();
        quiet();
        quiet();
        assert.equal(stateOf().run?.holding, true, 'precondition: 3 reported quiet minutes still bridge');
        skip(1);
        moving();
        const lines = runEndedLines();
        assert.equal(lines.length, 1, `expected exactly one "run ended" line, got ${JSON.stringify(lines)}`);
        assert.match(lines[0], /run ended \(readings 2 min apart\)/);
      } finally {
        wakeClips(true);
      }
    });

    test('C17c: a run ended by REPORTED quiet minutes is a stir, not a hole', () => {
      try {
        armedWithHeldRun(2);
        for (let i = 0; i < WAKE_GAP_MIN + 1; i++) quiet();
        const lines = runEndedLines();
        assert.equal(lines.length, 1, `expected exactly one "run ended" line, got ${JSON.stringify(lines)}`);
        assert.match(lines[0], /run ended \(stir, under the wake threshold\)/);
        assert.doesNotMatch(lines[0], /readings/);
      } finally {
        wakeClips(true);
      }
    });

    test('C17d: a run ended by an older label says the clock went back', () => {
      try {
        armedWithHeldRun(2);
        clock -= 30;
        moving();
        const lines = runEndedLines();
        assert.equal(lines.length, 1, `expected exactly one "run ended" line, got ${JSON.stringify(lines)}`);
        assert.match(lines[0], /run ended \(the clock went back\)/);
      } finally {
        wakeClips(true);
      }
    });

    test('C17e: a run that ALREADY CAPTURED logs no "nothing recorded" line when a hole ends it', () => {
      // The capture is still pending (no await), so the run is still holding: endRun releases it, and must not
      // claim "nothing recorded" about a wake that was recorded.
      try {
        armedWithHeldRun(WAKE_ACTIVE_MIN);
        assert.equal(stateOf().run.captured, true, 'precondition: the run captured');
        skip(10);
        moving();
        assert.equal(stateOf().run.activeCount, 1, 'the hole ended the captured run');
        assert.deepEqual(nothingRecordedLines(), []);
        assert.deepEqual(runEndedLines(), []);
      } finally {
        wakeClips(true);
      }
    });

    test('C17f: a run that ALREADY CAPTURED logs no "nothing recorded" line when an older label ends it', () => {
      try {
        armedWithHeldRun(WAKE_ACTIVE_MIN);
        assert.equal(stateOf().run.captured, true, 'precondition: the run captured');
        clock -= 30;
        moving();
        assert.equal(stateOf().run.activeCount, 1, 'the older label ended the captured run');
        assert.deepEqual(nothingRecordedLines(), []);
        assert.deepEqual(runEndedLines(), []);
      } finally {
        wakeClips(true);
      }
    });
  });

  describe('the model: the live watcher against the nightly job\'s rule, on hostile timelines', () => {
    // A small seeded PRNG so a failure names its seed and can be replayed exactly.
    function mulberry32(seed) {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // A STRUCTURED timeline, one char per minute: Q = a quiet payload, A = an active payload, H = a hole (no
    // payload at all). Uniform random slots would almost never arm (15 quiet payloads in a row at 1/3 each),
    // so the run-splitting code would go unexercised and the test would pass vacuously: a settle block first
    // (sometimes with one hole or one active inside it), then bursts of 1-8 actives separated by 0-6 holes or
    // quiet payloads (per timeline: all holes, all quiet, or a mix), so gaps land on both sides of every bridge
    // limit in both branches.
    function buildTimeline(rand) {
      const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
      const slots = [];
      const settleLen = int(15, 25);
      for (let i = 0; i < settleLen; i++) slots.push('Q');
      const r = rand();
      if (r < 0.3) slots[int(0, settleLen - 1)] = 'H';
      else if (r < 0.5) slots[int(0, settleLen - 1)] = 'A';
      const holeProb = [0, 0.5, 1][int(0, 2)];
      const target = int(60, 100);
      while (slots.length < target) {
        const burst = int(1, 8);
        for (let i = 0; i < burst; i++) slots.push('A');
        const gap = int(0, 6);
        for (let i = 0; i < gap; i++) slots.push(rand() < holeProb ? 'H' : 'Q');
      }
      slots.length = Math.min(slots.length, 100);
      return slots.join('');
    }

    // The OFFLINE reference: the whole timeline at once, the nightly job's semantics (sleepAnalysis.js
    // markWakeRuns: a minute with no payload is non-active, a run bridges <= WAKE_GAP_MIN non-active minutes,
    // a run with >= WAKE_ACTIVE_MIN actives is a wake), and the live arming rule (the first
    // ONSET_QUIET_MIN consecutive payloads that are all quiet). It reads only the timeline array: it shares no
    // state, no `lastAt`, no bridge arithmetic with handleMinute.
    function reference(timeline) {
      const n = timeline.length;
      let armedAt = -1;
      let streak = 0;
      for (let i = 0; i < n && armedAt < 0; i++) {
        streak = timeline[i] === 'Q' ? streak + 1 : 0;
        if (streak >= ONSET_QUIET_MIN) armedAt = i;
      }
      if (armedAt < 0) return { armedAt, startMs: [] };
      const active = Array.from(timeline, (c, i) => i > armedAt && c === 'A');
      const startMs = [];
      for (let i = armedAt + 1; i < n; ) {
        if (!active[i]) { i++; continue; }
        let last = i;
        let count = 0;
        let k = i;
        while (k < n) {
          if (active[k]) { last = k; count++; k++; continue; }
          let g = k;
          while (g < n && !active[g]) g++;
          if (g < n && g - k <= WAKE_GAP_MIN) { k = g; continue; }
          break;
        }
        if (count >= WAKE_ACTIVE_MIN) startMs.push(endMs(i));
        i = last + 1;
      }
      return { armedAt, startMs };
    }

    // Feed a timeline to the real handler. `dupRand`, when given, re-delivers some payloads' labels right
    // after them with the OPPOSITE kind of reading (an active copy of a quiet minute and vice versa): a
    // repeated label has to be ignored whatever it says.
    function replay(timeline, dupRand = null) {
      _state().clear();
      const startMs = [];
      for (let i = 0; i < timeline.length; i++) {
        const c = timeline[i];
        if (c === 'H') continue;
        const r = deliver(labelFor(i), c === 'A' ? MOTION_ACTIVE + 0.05 : 0, 0);
        if (r?.captured) startMs.push(r.startMs);
        if (dupRand && dupRand() < 0.25) {
          const copy = deliver(labelFor(i), c === 'A' ? 0 : MOTION_ACTIVE + 0.05, 0);
          assert.equal(copy, null, `a repeated label captured (minute ${i} of ${timeline})`);
        }
      }
      return startMs;
    }

    // ⚠️ WHY 250 AND NOT MORE: measured, one handleMinute call costs ~0.65 ms here (childWindowActiveNow builds
    // several Intl.DateTimeFormat objects per call, and sleepAnalysis.js is not ours to change or mock), so the
    // 250 timelines of 60-100 minutes (a quarter of them replayed a second time with repeated labels) take
    // ~15 s. The seeds are fixed, so the counts below are exactly reproducible; the floors sit under what the
    // generator produces today and exist to catch a generator edit that makes the comparison vacuous.
    test('C13: 250 seeded timelines: the watcher\'s captures equal the offline reference, with and without repeated labels', () => {
      const SEQUENCES = 250;
      const SEED0 = 448000;
      let armed = 0;
      let withCapture = 0;
      let holeSplits = 0;
      let holeBridges = 0;
      let holesDecide = 0;
      const realInfo = logger.info;
      logger.info = () => {}; // thousands of "settled"/"awake" lines would bury the report
      try {
        wakeClips(false); // captureWakeClip resolves at once: this test is about the decision, not the cut
        for (let s = 0; s < SEQUENCES; s++) {
          const seed = SEED0 + s;
          const timeline = buildTimeline(mulberry32(seed));
          const want = reference(timeline);
          const where = `seed ${seed}: ${timeline}`;
          assert.deepEqual(replay(timeline), want.startMs, `captures differ from the nightly rule (${where})`);
          if (s % 4 === 0) {
            assert.deepEqual(
              replay(timeline, mulberry32(seed ^ 0x5bd1e995)), want.startMs,
              `repeated labels changed the result (${where})`
            );
          }
          if (want.armedAt >= 0) {
            armed++;
            const after = timeline.slice(want.armedAt + 1);
            if (want.startMs.length) withCapture++;
            // A pure hole longer than the bridge, directly between two active minutes, and one of exactly the bridge.
            if (new RegExp(`AH{${WAKE_GAP_MIN + 1},}A`).test(after)) holeSplits++;
            if (new RegExp(`AH{${WAKE_GAP_MIN}}A`).test(after)) holeBridges++;
            // The old, callback-counting behaviour is the same timeline with the holes squeezed out. How many
            // timelines does that change the NUMBER of wakes for (or whether it arms)? Those are the ones this
            // test can fail on the old code with; if the generator stops producing them it proves nothing.
            if (reference(timeline.replace(/H/g, '')).startMs.length !== want.startMs.length) holesDecide++;
          }
        }
      } finally {
        logger.info = realInfo;
        wakeClips(true);
      }
      // The coverage floors: if the generator regresses, the comparison above could pass without ever
      // exercising a split, a bridge or a capture. They are asserts, not logs.
      assert.ok(armed >= 150, `only ${armed} of ${SEQUENCES} timelines armed the watcher`);
      assert.ok(withCapture >= 150, `only ${withCapture} timelines produced a capture`);
      assert.ok(holeSplits >= 40, `only ${holeSplits} timelines had a hole longer than the bridge between two actives`);
      assert.ok(holeBridges >= 30, `only ${holeBridges} timelines had a hole of exactly the bridge between two actives`);
      assert.ok(holesDecide >= 20, `only ${holesDecide} timelines where counting callbacks instead of minutes changes the answer`);
    });
  });

  describe('the premise, against the real tracker', () => {
    test('C14: an outage delivers NO payload, and the watcher then does not bridge it (end to end)', () => {
      activity._resetActivityTrackerForTests();
      const seen = [];
      const offSeen = activity.onMinuteFlushed((p) => seen.push(p.bucketStart));
      const off = activity.onMinuteFlushed(handleMinute);
      // Explicit receipt times well inside the past: the window the watcher checks is the real clock's, the
      // labels are not. Same technique as the #447 block above (recordMotion with a receipt time, flushActivity
      // with the tick's time).
      const M0 = BASE_MS - 150 * 60_000;
      const minuteAt = (i) => M0 + i * 60_000;
      const labelAt = (i) => new Date(minuteAt(i)).toISOString().slice(0, 19).replace('T', ' ');
      const feed = (i, fraction) => {
        activity.recordMotion(CAM, fraction, null, minuteAt(i) + 20_000);
        activity.flushActivity(minuteAt(i + 1) + 900); // the tick just after the minute ends
      };
      const outage = (i) => activity.flushActivity(minuteAt(i + 1) + 900); // the tick runs, nothing was received
      try {
        for (let i = 0; i < ONSET_QUIET_MIN; i++) feed(i, 0);
        assert.equal(stateOf().asleep, true, 'precondition: 15 observed quiet minutes arm the watcher');
        for (let i = 15; i < 15 + WAKE_ACTIVE_MIN - 1; i++) feed(i, MOTION_ACTIVE + 0.05);
        assert.equal(stateOf().run.activeCount, WAKE_ACTIVE_MIN - 1, 'precondition: one active minute short of a wake');
        for (let i = 19; i < 29; i++) outage(i); // ten minutes with no motion frame and no sound window
        feed(29, MOTION_ACTIVE + 0.05);

        // The premise: the tracker skipped the ten minutes instead of sending nulls for them.
        const expected = [];
        for (let i = 0; i <= 18; i++) expected.push(labelAt(i));
        expected.push(labelAt(29));
        assert.deepEqual(seen, expected, 'the tracker must send nothing for a minute with no signal');

        // The chain: the watcher saw the jump and did not bridge it.
        const run = stateOf().run;
        assert.equal(run.activeCount, 1, 'the active minute after a ten-minute outage topped up the old run');
        assert.equal(run.captured, false);
        assert.equal(run.startMs, minuteAt(29) + 60_000);
      } finally {
        off();
        offSeen();
        activity._resetActivityTrackerForTests();
      }
    });
  });
});

describe('lifecycle', () => {
  test('start is idempotent and stop clears all state', () => {
    startWakeWatcher();
    startWakeWatcher(); // must not stack a second subscription or timer
    settle();
    assert.ok(_state().get(CAM), 'state exists while running');

    stopWakeWatcher();
    assert.equal(_state().size, 0, 'stop must drop every camera, releasing any ring holds');
  });
});
