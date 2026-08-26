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
