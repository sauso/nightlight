// The live wake watcher: decides, minute by minute, whether what's happening is a wake worth
// recording or a stir to ignore.
//
// This is the whole feature's judgement, it runs unattended overnight behind a timer, and its two
// failure modes are both silent: record every stir and you quietly fill a disk that is already 98%
// full, or record nothing and the morning timeline still has no evidence behind it. Neither shows up
// in a log you'd read. So the state machine is tested directly, one synthetic minute at a time.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';

const DATA_DIR = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { SLEEP_THRESHOLDS } = await import('../src/lib/sleepAnalysis.js');
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
let clock = 0;
function minute({ motion = 0, sound = 0 } = {}) {
  const t = new Date(Date.now() - (200 - clock) * 60 * 1000);
  clock++;
  const p = (x) => String(x).padStart(2, '0');
  const bucketStart =
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:00`;
  return handleMinute({ cameraId: CAM, bucketStart, motionPeak: motion, soundPeak: sound });
}

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
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  stopWakeWatcher();
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
