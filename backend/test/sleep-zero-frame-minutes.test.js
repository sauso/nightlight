// Issue #508: a minute the VIDEO never saw is not an observed minute, however many rows it has.
//
// The motion detector can die while the sound detector keeps writing `activity_samples` rows (issue #369).
// Every such row used to read as a watched, quiet minute: measured on staging, stalls of 522 minutes
// (ending 2026-09-17 10:00) and 284 (ending 2026-09-27 10:00) reported full coverage and zero unknown
// minutes; 342 and 104 of those minutes fall inside the night's window and now leave it. The rule now is `motion_frames > 0` (sleepAnalysis.js,
// `motionSeen`): a row with no analysed frame leaves its minute UNKNOWN, exactly like a minute with no row
// (issue #442), and sound is not used in it.
//
// Every regression test here FAILS on the code before #508 (verified by serving the pre-#508 source through
// a loader hook, see the PR). Some pass there BY DESIGN: the controls (T3b,
// T6e) prove a fixture can produce the answer at all; T5 and T8 pin the rule against over-reach (a frame
// threshold) and are killed by the `> 1` / `>= 10` mutants instead; T9e is a source tripwire. The tests
// added in the #508 fix round (T4b, T6g, T6h, T6i, T7b, T7c) close gaps where a mutant of the NEW code
// survived; each is proven by the named `#508 A27`-`A33` mutant in scripts/mutants.json, not by the
// pre-#508 code (not run against it; T7b and T7c are expected to pass there, since they guard the new skip
// against becoming a merge). The fixtures
// are hostile on purpose: an unwatched row is always given something that WOULD
// change the answer if it leaked (a loud sound, a big peak, a quiet reading), because an unwatched row that
// carries nothing interesting looks exactly like one that was correctly ignored.
//
// Not covered here, deliberately (follow-ups named in the PR): bedTransitions.getActivitySamples and the
// live wakeWatcher still read `motion_peak` alone, and applyCorrection's aggregate unknown_minutes
// subtraction is unchanged.

import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { computeNight } = await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');

const CHILD = 'zf-child';
const CAM = 'zf-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge to reason about
const TZ_OFF = 10 * 3600 * 1000;
// Window 19:30-07:00 = 690 minutes. MIN_COVERAGE_FRAC 0.5 => the no_data line is 345 watched minutes;
// EMPTY_MIN_COVERAGE_FRAC 0.9 => the `empty` line is 621 (690 * 0.9 is exactly 621 in floating point).
const WIN = 690;

const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;
const addMin = (d, n) => new Date(d.getTime() + n * 60000);
const within = (t, ranges) => ranges.some(([a, b]) => t >= a && t < b);

// The quiet in-bed peak of a sleeping child (above OCCUPANCY_MIN_PEAK, below MOTION_ACTIVE), and of an
// empty bed (below both). Same values and reasoning as sleepAnalysis.test.js.
const STILL_OCCUPIED = 0.004;
const STILL_EMPTY = 0.0002;
const QUIET_DB = 0.5; // sound over ambient on a quiet minute
const LOUD_DB = 20; // a clear cry (SOUND_ACTIVE is 6)

const insertRow = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows, motion_out_level, motion_out_peak)
   VALUES (?, ?, ?, ?, 0, ?, ?, 300, 0, ?)`
);
const insertTransition = db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)');

// One row. `frames` is explicit on every row this file writes — the whole point of the file.
function row(t, { frames = 1, peak = STILL_OCCUPIED, sound = QUIET_DB, out = 0.0004 } = {}) {
  insertRow.run(CAM, sqlTime(t), peak, peak, sound, frames, out);
}

// A WATCHED minute per row across [from, to). `move` ranges carry real in-bed movement; `noise` ranges a
// clear sound with nothing moving.
function watched(from, to, { move = [], noise = [], still = STILL_OCCUPIED, frames = 1 } = {}) {
  for (let t = from; t < to; t = addMin(t, 1)) {
    row(t, { frames, peak: within(t, move) ? 0.4 : still, sound: within(t, noise) ? LOUD_DB : QUIET_DB });
  }
}

// A DEAD-VIDEO minute per row across [from, to), the shape the writer produces when the motion detector
// delivers nothing and the sound detector keeps going: `motion_frames` 0, `motion_peak` and
// `motion_out_peak` NULL, and a real sound reading (`loud` minutes get a cry).
function deadVideo(from, to, { loud = [] } = {}) {
  for (let t = from; t < to; t = addMin(t, 1)) {
    insertRow.run(CAM, sqlTime(t), null, null, within(t, loud) ? LOUD_DB : QUIET_DB, 0, null);
  }
}

// A CLONE-ONLY minute per row across [from, to) (issue #493): every analysed frame was a proven ffmpeg
// repeat, so `motion_frames` 0 with `motion_peak` 0 and `motion_out_peak` 0 — a reading of "perfectly
// still" that nobody took.
function cloneOnly(from, to) {
  for (let t = from; t < to; t = addMin(t, 1)) insertRow.run(CAM, sqlTime(t), 0, 0, QUIET_DB, 0, 0);
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'ZF', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'ZF Cam', 'rtsp://example/stream', ?, 'zfcam')`).run(CAM, CHILD);
});

beforeEach(() => {
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM bed_transitions').run();
});

after(() => {
  db.close();
  cleanupTempDataDirs();
});

// An ordinary occupied night (settle 19:30-19:40, then still) with a 120-minute video stall from 01:00 to
// 03:00 during which the sound detector kept writing rows. `loud` puts cries inside the stall.
function layStallNight({ loud = [] } = {}) {
  watched(at(19, 30), at(1, 0, 1), { move: [[at(19, 30), at(19, 40)]] });
  deadVideo(at(1, 0, 1), at(3, 0, 1), { loud });
  watched(at(3, 0, 1), at(7, 0, 1));
}

describe('#508 a dead-video run is unknown, not asleep', () => {
  test('#508 T1: a stall with sound rows is excluded from coverage, counted unknown, and breaks the longest stretch', () => {
    // Before #508: coverage 690, unknown 0, asleep 680, longest 680 — the 120 unseen minutes read as sleep.
    layStallNight();
    const night = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(night.status, 'ok');
    assert.equal(hhmm(night.onset_at), '19:40');
    assert.equal(night.coverage_minutes, WIN - 120, 'a minute with no video is not a watched minute');
    assert.equal(night.unknown_minutes, 120, 'every dead-video minute is unknown');
    assert.equal(night.asleep_minutes, 680 - 120, 'and none of them is asleep');
    assert.equal(night.longest_stretch_minutes, 320, 'the stall breaks the stretch (19:40-01:00), it does not bridge it');
    const mid = night.timeline.find((m) => hhmm(m.t) === '02:00');
    assert.equal(mid.state, 'gap', 'the timeline draws the stall as a gap, like a missing row');
  });

  test('#508 T2: LOUD minutes inside the stall are still unknown: not a wake, not awake, not asleep', () => {
    // A six-minute cry (a full wake run on the old code) and three isolated cries (each counted ASLEEP on
    // the old code: active, but not in a wake run). Sound alone is not used in a minute nobody watched.
    layStallNight({
      loud: [
        [at(1, 30, 1), at(1, 36, 1)],
        [at(2, 0, 1), at(2, 1, 1)], [at(2, 10, 1), at(2, 11, 1)], [at(2, 40, 1), at(2, 41, 1)],
      ],
    });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(night.unknown_minutes, 120, 'a loud unwatched minute is unknown, exactly like a quiet one');
    assert.equal(night.wake_count, 0, 'a cry nobody saw is not reported as a wake');
    assert.equal(night.awake_minutes, 0);
    assert.equal(night.asleep_minutes, 680 - 120, 'an isolated loud unwatched minute is not counted asleep either');
  });

  test('#508 T2b: put down, then the video stalls while the child cries: onset never lands on a crying minute', () => {
    // Before #508 the unwatched cries were ACTIVE in `state` but CONFIRMED QUIET in the onset view (sound
    // with no movement nearby is discounted after a put-down), so the put-down-anchored search settled on
    // the crying minute 19:47. Now the stall is unknown and onset waits for real, watched quiet: 21:00.
    watched(at(19, 30), at(19, 45), { move: [[at(19, 30), at(19, 45)]] }); // someone at the bed
    insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 44)));
    deadVideo(at(19, 45), at(21, 0), { loud: [[at(19, 45), at(20, 5)]] });
    watched(at(21, 0), at(7, 0, 1), { move: [[at(2, 0, 1), at(2, 3, 1)]] });

    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(hhmm(night.onset_at), '21:00', 'onset is the first WATCHED quiet run after the stall');
  });
});

// The departure scan (extRows) reads its own query. The stretch `after` lays sits AFTER the window end so
// the main timeline (which stops at 07:00) and the metrics extension (no post-window exit here) cannot be
// what moves the answer: only the departure scan can (plan review, Opus 7). Used by T3b/T3c and T7b.
function layLateExitThen(after) {
  watched(at(19, 30), at(6, 59, 1), {
    move: [[at(19, 30), at(19, 40)], [at(23, 0), at(23, 6)], [at(6, 49, 1), at(6, 59, 1)]],
    still: STILL_EMPTY,
  });
  watched(at(6, 59, 1), at(7, 0, 1), { still: STILL_EMPTY });
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(6, 59, 1, 30)));
  after(at(7, 0, 1), at(7, 40, 1));
}

describe('#508 clone-only minutes (motion_frames 0, motion_peak 0) are unknown too', () => {
  test('#508 T3: in the main timeline', () => {
    watched(at(19, 30), at(1, 0, 1), { move: [[at(19, 30), at(19, 40)]] });
    cloneOnly(at(1, 0, 1), at(3, 0, 1));
    watched(at(3, 0, 1), at(7, 0, 1));
    const night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, WIN - 120);
    assert.equal(night.unknown_minutes, 120, 'a peak of 0 from repeated frames is not a reading of a still bed');
  });

  test('#508 T3b: control — 40 WATCHED quiet minutes after the exit confirm the 06:59 departure', () => {
    layLateExitThen((a, b) => watched(a, b, { still: STILL_EMPTY }));
    assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '06:59', 'sanity: this fixture CAN confirm the departure');
  });

  test('#508 T3c: in the departure scan — 40 CLONE-ONLY minutes after the exit do not confirm it', () => {
    // Before #508 the clones' motion_peak 0 passed `motion_peak != null` as confirmed-quiet, not-occupied
    // evidence, and the departure was confirmed by a camera that saw nothing (#350's failure mode).
    layLateExitThen(cloneOnly);
    const night = computeNight(CHILD, DATE);
    assert.notEqual(hhmm(night.wake_at), '06:59', 'repeated frames are not 20 minutes of an empty bed');
    assert.equal(night.wake_at, null);
  });
});

test('#508 T4: past the window, dead-video minutes between window end and a late departure are unknown in the metrics', () => {
  // The metrics extension (extraRows) reads its own query. Same shape as the #442 "late exit after a
  // camera outage" test, but the outage has rows: the sound detector kept writing.
  watched(at(19, 30), at(7, 0, 1), { move: [[at(19, 30), at(19, 40)], [at(23, 0), at(23, 6)]], still: STILL_EMPTY });
  deadVideo(at(7, 0, 1), at(7, 20, 1));
  watched(at(7, 20, 1), at(7, 50, 1), { move: [[at(7, 40, 1), at(7, 50, 1)]], still: STILL_EMPTY });
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 50, 1, 30)));
  watched(at(7, 50, 1), at(8, 20, 1), { still: STILL_EMPTY });

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(hhmm(night.wake_at), '07:50', 'sanity: the post-window departure is adopted, so the extension runs');
  assert.equal(night.unknown_minutes, 20, 'the 20 post-window dead-video minutes are unknown, not asleep');
  const span = Math.round((new Date(night.wake_at.replace(' ', 'T') + 'Z') - new Date(night.onset_at.replace(' ', 'T') + 'Z')) / 60000);
  assert.equal(night.asleep_minutes + night.awake_minutes + night.unknown_minutes, span, 'every minute in exactly one bucket');
});

test('#508 T4b: past the window, a LOUD dead-video stall is not a wake in the metrics extension either', () => {
  // T4's stall carries only quiet sound, so a metrics extension that skipped the unwatched row for
  // `stateMetrics` but still let its SOUND mark the minute active (`activeMetrics`) passed T4 — the
  // loudness was the one thing it never saw (#508 code review, Opus B01). Rows the writer really
  // produces: a sound-only minute with a cry in it, frames 0, motion_peak NULL.
  watched(at(19, 30), at(7, 0, 1), { move: [[at(19, 30), at(19, 40)], [at(23, 0), at(23, 6)]], still: STILL_EMPTY });
  deadVideo(at(7, 0, 1), at(7, 20, 1), { loud: [[at(7, 2, 1), at(7, 12, 1)]] });
  watched(at(7, 20, 1), at(7, 50, 1), { move: [[at(7, 40, 1), at(7, 50, 1)]], still: STILL_EMPTY });
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 50, 1, 30)));
  watched(at(7, 50, 1), at(8, 20, 1), { still: STILL_EMPTY });

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.wake_at), '07:50', 'sanity: the post-window departure is adopted, so the extension runs');
  assert.equal(night.unknown_minutes, 20, 'all 20 stalled minutes are unknown, the loud ones included');
  assert.equal(night.awake_minutes, 16, 'awake is the two WATCHED wakes only (23:00-23:06, 07:40-07:50)');
  assert.equal(night.wake_count, 2, 'a cry nobody saw is not a third wake-up');
});

describe('#508 zero and only zero: any real frame is a watched minute', () => {
  // A normal night, laid with a per-minute frame count from `framesAt`.
  function layNight(framesAt) {
    for (let t = at(19, 30); t < at(7, 0, 1); t = addMin(t, 1)) {
      const moving = within(t, [[at(19, 30), at(19, 40)], [at(1, 0, 1), at(1, 9, 1)]]);
      row(t, { frames: framesAt(t), peak: moving ? 0.4 : STILL_OCCUPIED });
    }
  }

  test('#508 T5: minutes with 1 or 30 frames, and 21 short low-frame runs (the daily-reboot pattern), lose no coverage', () => {
    // The daily camera reboot leaves short runs of sparse minutes (measured on staging over 30 days: 36
    // runs, every one a single minute, 30 starting at the 10:00 reboot; issue #508's "21" did not hold; 21 is
    // kept here only as a generous fixture size). None of them may cost coverage: a sparse minute still saw
    // what it saw.
    const lowRuns = [];
    for (let k = 0; k < 21; k++) {
      const start = addMin(at(19, 45), k * 30);
      lowRuns.push([start, addMin(start, 1 + (k % 9))]); // 1..9 minutes long
    }
    layNight((t) => {
      const k = lowRuns.findIndex(([a, b]) => t >= a && t < b);
      if (k >= 0) return 1 + (k % 9); // 1..9 frames
      return t.getUTCMinutes() % 2 ? 1 : 30;
    });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, WIN, 'no minute with at least one frame may be dropped');
    assert.equal(night.unknown_minutes, 0);
  });

  test('#508 T8: the same night at 1 frame a minute and at 300 gives identical output', () => {
    // Frame-rate independence: nothing may read `motion_frames` as anything but "was there video".
    layNight(() => 1);
    const low = computeNight(CHILD, DATE, { includeTimeline: true });
    db.prepare('DELETE FROM activity_samples').run();
    layNight(() => 300);
    const high = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(low.status, 'ok', 'sanity: a real, scored night');
    assert.deepEqual(high, low);
  });
});

describe('#508 coverage: mostly unwatched is no_data, and half-watched is never "no one in the bed"', () => {
  test('#508 T6: more than half the window dead-video -> no_data (it was "ok" on the old code)', () => {
    watched(at(19, 30), addMin(at(19, 30), 344), { move: [[at(19, 30), at(19, 40)]] }); // 344 watched
    deadVideo(addMin(at(19, 30), 344), at(7, 0, 1));
    const night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, 344);
    assert.equal(night.status, 'no_data');
  });

  // A quiet, EMPTY-looking watched stretch from 19:30, then dead video to the window end. The watched part
  // alone satisfies every empty-bed signal, which is exactly the trap (plan review, Codex 3): "empty"
  // sends the no-one-in-the-bed report and deletes the night's timelapse frames.
  function layHalfEmpty(watchedMin) {
    watched(at(19, 30), addMin(at(19, 30), watchedMin), { still: STILL_EMPTY });
    deadVideo(addMin(at(19, 30), watchedMin), at(7, 0, 1));
  }

  test('#508 T6b: exactly 50% watched passes the no_data gate but is NOT empty', () => {
    layHalfEmpty(345);
    const night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, 345, 'sanity: exactly on the no_data line');
    assert.equal(night.status, 'no_data', 'half a night unseen is "we could not see", never "no one was there"');
  });

  test('#508 T6c: nowhere in the 50%-90% band reads empty', () => {
    for (const w of [346, 400, 450, 500, 550, 600, 620]) {
      db.prepare('DELETE FROM activity_samples').run();
      layHalfEmpty(w);
      const night = computeNight(CHILD, DATE);
      assert.equal(night.coverage_minutes, w);
      assert.equal(night.status, 'no_data', `${w}/${WIN} watched must not read empty`);
    }
  });

  test('#508 T6d: the empty line is 621 of 690 (0.9): 621 watched reads empty', () => {
    layHalfEmpty(621);
    const night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, 621);
    assert.equal(night.status, 'empty');
  });

  test('#508 T6e: a genuinely empty, fully watched night is still empty', () => {
    watched(at(19, 30), at(7, 0, 1), { still: STILL_EMPTY });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, WIN);
    assert.equal(night.status, 'empty');
  });

  test('#508 T6f: an OCCUPIED night in the same band is still scored ok (the guard is for empty only)', () => {
    watched(at(19, 30), addMin(at(19, 30), 400), { move: [[at(19, 30), at(19, 40)]] });
    deadVideo(addMin(at(19, 30), 400), at(7, 0, 1));
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(night.coverage_minutes, 400);
  });

  test('#508 T6g: watched LOOKBEHIND minutes do not count toward the 90% (only the window does)', () => {
    // Every other T6 fixture leaves the 3 h lookbehind (16:30-19:30) empty, but a camera that samples
    // around the clock (motion alerts on) fills it, so a guard that counted it passed them all (#508 code
    // review, Opus B16). 500 of 690 window minutes watched is "no data"; with the 180 lookbehind minutes
    // wrongly added it would be 680 and read "no one in the bed" — which deletes the night's frames.
    watched(at(16, 30), at(19, 30), { still: STILL_EMPTY });
    layHalfEmpty(500);
    const night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, 500, 'sanity: coverage itself is window-only');
    assert.equal(night.status, 'no_data');
  });

  test('#508 T6h: on a night IN PROGRESS the 90% is of the ELAPSED part of the window, the same basis as the no_data gate', (t) => {
    // TRACED for #508 (fix round 1): no consumer acts on an in-progress `empty`. The nightly job only
    // computes and stores lastCompletedNightDate (a closed window), and only it sends the report or
    // discards frames; RecomputeNight is hidden while `in_progress`. So the guard keeps the basis the
    // 50% no_data gate already uses — minutes elapsed so far — and this pins it (Opus B17: a guard on the
    // full configured window would say "no data" here all night until its last hour).
    // At 00:00 the window has run 270 minutes: 90% of that is 243 (exactly, in floating point).
    t.mock.timers.enable({ apis: ['Date'], now: at(0, 0, 1).getTime() });
    watched(at(19, 30), addMin(at(19, 30), 250), { still: STILL_EMPTY });
    deadVideo(addMin(at(19, 30), 250), at(0, 0, 1));
    let night = computeNight(CHILD, DATE);
    assert.equal(night.in_progress, true, 'sanity');
    assert.equal(night.coverage_minutes, 250);
    assert.equal(night.status, 'empty', '250 of 270 elapsed minutes watched: over 90% of the elapsed window');

    db.prepare('DELETE FROM activity_samples').run();
    watched(at(19, 30), addMin(at(19, 30), 240), { still: STILL_EMPTY });
    deadVideo(addMin(at(19, 30), 240), at(0, 0, 1));
    night = computeNight(CHILD, DATE);
    assert.equal(night.coverage_minutes, 240);
    assert.equal(night.status, 'no_data', '240 of 270 is under 90% of the elapsed window');
  });
});

describe('#508 the 0.9 itself, on a window where 0.9 and its neighbours give different integer lines', () => {
  // On the 690-minute window 0.899 and 0.9 are the SAME line (620.31 and 621 both need 621 watched
  // minutes), so T6c/T6d could not tell them apart (#508 code review, Codex 3). A 1000-minute window
  // (17:00-09:40, configurable like any window) puts the line at exactly 900: 0.899 would move it to 899,
  // 0.901 to 901. Both sides are pinned. Its own child and camera, so the 19:30-07:00 fixtures stay put.
  const LONG_CHILD = 'zf-long';
  const LONG_CAM = 'zf-long-cam';
  before(() => {
    db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
                VALUES (?, 'ZF Long', 1, '17:00', '09:40')`).run(LONG_CHILD);
    db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
                VALUES (?, 'ZF Long Cam', 'rtsp://example/long', ?, 'zflongcam')`).run(LONG_CAM, LONG_CHILD);
  });
  // `watchedMin` quiet empty-bed minutes from 17:00, then dead video to the window end.
  function layLong(watchedMin) {
    const start = at(17, 0);
    const end = at(9, 40, 1);
    for (let t = start; t < end; t = addMin(t, 1)) {
      const seen = t < addMin(start, watchedMin);
      insertRow.run(LONG_CAM, sqlTime(t), seen ? STILL_EMPTY : null, seen ? STILL_EMPTY : null, QUIET_DB, seen ? 1 : 0, seen ? 0.0004 : null);
    }
  }

  test('#508 T6i: 899 of 1000 watched is no_data, 900 of 1000 is empty', () => {
    layLong(899);
    let night = computeNight(LONG_CHILD, DATE);
    assert.equal(night.coverage_minutes, 899, 'sanity: a 1000-minute window');
    assert.equal(night.status, 'no_data', '899 < 1000 * 0.9');

    db.prepare('DELETE FROM activity_samples').run();
    layLong(900);
    night = computeNight(LONG_CHILD, DATE);
    assert.equal(night.coverage_minutes, 900);
    assert.equal(night.status, 'empty', '900 = 1000 * 0.9 exactly');
  });
});

describe('#508 duplicate rows for one minute: an unwatched twin changes nothing', () => {
  // An ordinary occupied night; `twins` adds a second row for some minutes, in the given order relative
  // to the watched row (activity_samples has no uniqueness on camera+minute, and the queries have no
  // ORDER BY, so both orders are real).
  const TWIN_MINUTES = [at(21, 0), at(21, 1), at(23, 2), at(2, 30, 1)]; // quiet minutes...
  const ACTIVE_TWIN = at(1, 4, 1); // ...and one inside a real wake (01:00-01:09)

  function layTwinNight({ twin = null, unwatchedFirst = false } = {}) {
    for (let t = at(19, 30); t < at(7, 0, 1); t = addMin(t, 1)) {
      const moving = within(t, [[at(19, 30), at(19, 40)], [at(1, 0, 1), at(1, 9, 1)]]);
      const hasTwin = twin && (TWIN_MINUTES.some((m) => +m === +t) || +t === +ACTIVE_TWIN);
      if (hasTwin && unwatchedFirst) twin(t);
      row(t, { peak: moving ? 0.4 : STILL_OCCUPIED });
      if (hasTwin && !unwatchedFirst) twin(t);
    }
  }
  // The unwatched twin is LOUD, so a twin that is merged rather than skipped changes the minute.
  const loudDeadTwin = (t) => insertRow.run(CAM, sqlTime(t), null, null, LOUD_DB, 0, null);

  for (const unwatchedFirst of [false, true]) {
    test(`#508 T7: result equals the watched row alone (unwatched twin ${unwatchedFirst ? 'first' : 'second'})`, () => {
      layTwinNight();
      const alone = computeNight(CHILD, DATE, { includeTimeline: true });
      db.prepare('DELETE FROM activity_samples').run();
      layTwinNight({ twin: loudDeadTwin, unwatchedFirst });
      const withTwins = computeNight(CHILD, DATE, { includeTimeline: true });
      assert.equal(alone.coverage_minutes, WIN, 'sanity');
      // Watched-QUIET then unwatched is the `false || null === null` trap (plan review, Opus 6): a twin
      // merged as "unknown" would erase the watched minute.
      assert.deepEqual(withTwins, alone);
    });
  }

  // T7 twins only inside the window, so it reaches the main timeline alone. The departure scan (extRows)
  // and the metrics extension (extraRows) run their own loops over their own queries, and a twin merged
  // there as `null` (`false || null` is `null`) erased the watched verdict just the same (#508 code review,
  // Opus B05/B06). Duplicate rows are real: after a #447 backward clock step the tracker writes a minute's
  // label twice. Each row here is a watched minute FOLLOWED by a clone-only twin, the order the trap needs.
  const watchedThenCloneTwin = (from, to, opts) => {
    for (let t = from; t < to; t = addMin(t, 1)) {
      watched(t, addMin(t, 1), opts);
      cloneOnly(t, addMin(t, 1));
    }
  };

  test('#508 T7b: in the departure scan, a clone twin after each confirming minute does not unconfirm the departure', () => {
    // T3b's fixture, whose 40 watched quiet minutes after the 06:59 exit confirm it; here each of those
    // minutes has a clone-only twin behind it.
    layLateExitThen((a, b) => watchedThenCloneTwin(a, b, { still: STILL_EMPTY }));
    assert.equal(hhmm(computeNight(CHILD, DATE).wake_at), '06:59', 'the twins are skipped, so the watched minutes still confirm it');
  });

  test('#508 T7c: in the metrics extension, a clone twin after each post-window minute leaves it asleep, not unknown', () => {
    // T4's shape without the stall: 07:00-07:40 watched quiet, each minute with a clone twin, then the
    // real 07:40-07:50 departure. Asleep is 19:40-07:50 (730) less the 16 awake minutes.
    watched(at(19, 30), at(7, 0, 1), { move: [[at(19, 30), at(19, 40)], [at(23, 0), at(23, 6)]], still: STILL_EMPTY });
    watchedThenCloneTwin(at(7, 0, 1), at(7, 40, 1), { still: STILL_EMPTY });
    watched(at(7, 40, 1), at(7, 50, 1), { move: [[at(7, 40, 1), at(7, 50, 1)]], still: STILL_EMPTY });
    insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 50, 1, 30)));
    watched(at(7, 50, 1), at(8, 20, 1), { still: STILL_EMPTY });

    const night = computeNight(CHILD, DATE);
    assert.equal(hhmm(night.wake_at), '07:50', 'sanity: the extension runs');
    assert.equal(night.unknown_minutes, 0, 'every post-window minute had a watched row');
    assert.equal(night.asleep_minutes, 714);
  });
});

describe('#508 hostile fixture: an unwatched row carries NOTHING, whatever it claims', () => {
  // Rows with `motion_frames` 0 but something in another channel. They are what kills a change that gates
  // only the minute's state and lets the other channels through (plan review, Codex 6 / Opus 5). Each is a
  // TWIN of a watched row, so the minute's state is decided by the watched row either way and only the
  // leaked channel could change the answer. One channel per test.
  //
  // Which of these the WRITER can produce (traced in activityTracker.js, fix round 1 of #508 — an earlier
  // version of this comment called them all "writer-impossible", which was false):
  //   * an IN-BED peak above 0 with frames 0 (T9a, T9c, T9d): impossible. `motion_frames` is the in-bed
  //     OBSERVED count, and #493 only takes a frame out of it when that frame's in-bed fraction was
  //     exactly 0 (stageFrame), so a frames-0 minute's in-bed peak is 0 or NULL. Planted deliberately.
  //   * LOUD SOUND with frames 0 (T9f): the ordinary dead-video row, the shape this whole issue is about.
  //   * an OUT-OF-BED peak above 0 with frames 0 (T9b): POSSIBLE, narrowly. The two channels are staged
  //     and corrected separately: a frame the observation clock proves a clone, whose in-bed fraction was
  //     0 but whose out-of-bed fraction was not, loses its in-bed count and KEEPS its out-of-bed reading
  //     (activityTracker.test.js "#493: ...and the mirror" asserts exactly that row: frames 0, out peak
  //     0.3). A whole minute of such frames stores frames 0 with a real out-of-bed peak. #508's rule makes
  //     that whole minute unknown, so it DISCARDS that out-of-bed movement. It needs the clock to call every
  //     frame of the minute a repeat while the picture outside the bed changed, which a true repeat cannot
  //     do; how often it happens is unmeasured. Flagged to the owner as a design question, rule unchanged.
  const hostile = (t, { peak = null, out = null, sound = QUIET_DB } = {}) =>
    insertRow.run(CAM, sqlTime(t), peak, peak, sound, 0, out);

  test('#508 T9a: its in-bed peak does not reach maxBedPeak (an empty night stays empty)', () => {
    watched(at(19, 30), at(7, 0, 1), { still: STILL_EMPTY });
    for (const t of [at(22, 0), at(1, 0, 1), at(4, 0, 1)]) hostile(t, { peak: 0.9 });
    assert.equal(computeNight(CHILD, DATE).status, 'empty');
  });

  test('#508 T9b: its outside-the-bed peak does not reach outAt (no room activity is drawn)', () => {
    // Writer-POSSIBLE (see the describe comment): this pins the deliberate cost of the whole-minute rule,
    // not just a leak. If the owner decides a frames-0 minute's real out-of-bed movement should count,
    // this is the test that has to change, on purpose.
    watched(at(19, 30), at(7, 0, 1), { move: [[at(19, 30), at(19, 40)], [at(1, 0, 1), at(1, 9, 1)]] });
    const base = computeNight(CHILD, DATE, { includeTimeline: true });
    for (let t = at(23, 0); t < at(23, 10); t = addMin(t, 1)) hostile(t, { out: 0.9 });
    const night = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(night.visits.length, 0, 'no "movement outside the bed" from a camera that saw nothing');
    assert.deepEqual(night, base);
  });

  test('#508 T9c: its in-bed peak does not reach motionAt (it cannot witness household noise at bedtime)', () => {
    // A still child in a noisy house, put down at 18:38 — onset is the put-down (sleepAnalysis.test.js's
    // 2026-08-26 test). A hostile "movement" inside the noise would witness it and push onset later.
    watched(at(18, 20), at(7, 0, 1), { noise: [[at(18, 40), at(19, 40)]] });
    insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));
    for (const t of [at(18, 45), at(18, 50)]) hostile(t, { peak: 0.9 });
    assert.equal(hhmm(computeNight(CHILD, DATE).onset_at), '18:38');
  });

  test('#508 T9d: its in-bed peak does not reach bedPeakAt (it cannot make a stray put-down look occupied)', () => {
    // sleepAnalysis.test.js's 2026-08-28 stray-put-down night: an afternoon into_bed over an empty bed
    // must not become the bedtime. Three hostile minutes at 0.0045 (occupied-looking, but below
    // MOTION_ACTIVE and in the lookbehind, so they can reach ONLY the occupancy witness) would otherwise
    // be the three minutes of occupancy OCCUPANCY_MIN_MINUTES asks for.
    for (let t = at(16, 30); t < at(19, 51); t = addMin(t, 1)) {
      row(t, { peak: STILL_EMPTY, sound: within(t, [[at(17, 0), at(19, 30)]]) ? LOUD_DB : QUIET_DB });
    }
    watched(at(19, 51), at(7, 0, 1), { move: [[at(19, 51), at(19, 58)]] });
    insertTransition.run(CAM, 'into_bed', 0.076, sqlTime(at(16, 52)));
    insertTransition.run(CAM, 'out_of_bed', 0.016, sqlTime(at(16, 53)));
    insertTransition.run(CAM, 'into_bed', 0.121, sqlTime(at(19, 51)));
    for (const t of [at(17, 10), at(17, 30), at(17, 50)]) hostile(t, { peak: 0.0045 });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.ok(hhmm(night.onset_at) >= '19:30', `onset ${hhmm(night.onset_at)} came from the stray put-down`);
  });

  test('#508 T9f: its sound does not reach soundAt (a watched movement cannot "witness" a cry nobody saw)', () => {
    // Put down 18:38 with one watched movement at 18:39, so the settle is 18:40. A loud unwatched twin
    // at 18:41 sits within ONSET_SOUND_MOTION_WITHIN_MIN of that movement: leaked into soundAt it would
    // count as witnessed, active noise and push the settle to 18:42.
    watched(at(18, 20), at(7, 0, 1), { move: [[at(18, 39), at(18, 40)], [at(2, 0, 1), at(2, 3, 1)]] });
    insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));
    const base = computeNight(CHILD, DATE);
    assert.equal(hhmm(base.onset_at), '18:40', 'sanity: the settle after the one movement');
    hostile(at(18, 41), { sound: LOUD_DB });
    assert.equal(hhmm(computeNight(CHILD, DATE).onset_at), '18:40');
  });

  test('#508 T9e: TRIPWIRE (not proof) — every activity_samples query in sleepAnalysis.js selects motion_frames', () => {
    // A fourth reader added later without the column would silently treat every row as watched. This
    // only reads the source text; the behavioural tests above are what prove the rule.
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/lib/sleepAnalysis.js'), 'utf8'
    );
    const selects = [...src.matchAll(/SELECT([\s\S]*?)FROM activity_samples/g)].map((m) => m[1]);
    assert.equal(selects.length, 3, 'expected three readers (main timeline, extRows, extraRows)');
    for (const cols of selects) assert.match(cols, /\bmotion_frames\b/, `a reader selects ${cols.trim()} without motion_frames`);
  });
});

describe('#508 onset across a stall', () => {
  test('#508 T10a: video dead over bedtime (19:10-23:00): onset is when video returns, not the window start', () => {
    // Nobody saw the child fall asleep, so the first WATCHED quiet run is the earliest honest onset. On
    // the old code the stall's quiet sound rows read as confirmed quiet and onset was 19:30.
    watched(at(18, 30), at(19, 10), { move: [[at(18, 30), at(19, 10)]] });
    deadVideo(at(19, 10), at(23, 0));
    watched(at(23, 0), at(7, 0, 1), { move: [[at(2, 0, 1), at(2, 3, 1)]] });
    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok', '480 of 690 minutes watched is enough to score');
    assert.equal(night.coverage_minutes, 480);
    assert.equal(hhmm(night.onset_at), '23:00', '"asleep from 23:00": the first quiet minute anyone saw');
  });

  test('#508 T10b: a stall longer than the occupancy window after a put-down — the traced decision, pinned', () => {
    // Put down at 19:40, two still minutes, then a noisy but motionless room (household noise, discounted
    // after a put-down) until the video stalls at 19:55 for 185 minutes (> OCCUPANCY_WITNESS_MIN, 150).
    // The bed never shows occupancy-level micro-motion before the stall (STILL_EMPTY).
    //   OLD: the stall's sound rows read as watched with an in-bed peak of 0, so bedOccupiedAfter saw 150
    //        "watched, never moved" minutes and REJECTED the put-down; onset fell back to 19:55, a minute
    //        inside the stall that nobody saw.
    //   NEW: the stall is unknown; bedOccupiedAfter fails open on the gap (its documented contract, the
    //        same answer a #442 row outage gets), and the put-down's watched quiet run is the onset: 19:40.
    // Decided in the build from this trace and kept (see the comment on bedOccupiedAfter): the old
    // rejection rested on readings nobody took. The residual risk (a false put-down straight into a
    // stall) is named there.
    watched(at(19, 30), at(19, 40), { move: [[at(19, 30), at(19, 40)]] }); // someone at the bed
    insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(19, 40)));
    watched(at(19, 40), at(19, 55), { noise: [[at(19, 42), at(19, 55)]], still: STILL_EMPTY });
    deadVideo(at(19, 55), at(23, 0));
    watched(at(23, 0), at(7, 0, 1), { move: [[at(2, 0, 1), at(2, 3, 1)]] });

    const night = computeNight(CHILD, DATE);
    assert.equal(night.status, 'ok');
    assert.equal(hhmm(night.onset_at), '19:40');
    assert.equal(night.unknown_minutes, 185, 'the stall itself is reported as unknown, not as sleep');
  });
});

// Issue #453: a digitally silent microphone (all-zero audio windows) now stores what a quiet one stores. Before
// #453 such a window was thrown away, so a silent minute stored NULL sound, and a silent minute with no video
// stored no row at all; since #453 it stores sound_peak 0 with its windows counted, and a silent minute with no
// video writes a row. The sleep numbers must read both exactly as before: 0 is never a "heard" minute
// (SOUND_ACTIVE is 6 dB), and a row with no video is unwatched (#508) whatever its sound column says. These pass
// on the code before #453 too: they pin that the stored change cannot move a sleep number.
describe('#453 C3: a minute heard as digital silence (sound_peak 0) reads exactly like one with no sound reading', () => {
  const insertFull = db.prepare(
    `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak,
       motion_frames, sound_windows, motion_out_level, motion_out_peak, sound_p75, sound_p90, sound_sd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // The sound columns as the writer stores them: `silent` = since #453 (300 windows, every one 0);
  // otherwise = before #453 (no sound window counted, every sound column NULL).
  const sound = (silent) => (silent
    ? { level: 0, peak: 0, windows: 300, p75: 0, p90: 0, sd: 0 }
    : { level: null, peak: null, windows: 0, p75: null, p90: null, sd: null });
  const MOVES = [[at(19, 30), at(19, 40)], [at(1, 0, 1), at(1, 9, 1)]]; // the settle, and a real wake
  function watchedRow(t, silent) {
    const peak = within(t, MOVES) ? 0.4 : STILL_OCCUPIED;
    const s = sound(silent);
    insertFull.run(CAM, sqlTime(t), peak, peak, s.level, s.peak, 1, s.windows, 0, 0.0004, s.p75, s.p90, s.sd);
  }
  function noVideoSilentRow(t) {
    const s = sound(true);
    insertFull.run(CAM, sqlTime(t), null, null, s.level, s.peak, 0, s.windows, null, null, s.p75, s.p90, s.sd);
  }

  test('#453 C3: a watched night whose every minute stored sound_peak 0 is the same night as with sound NULL', () => {
    for (let t = at(19, 30); t < at(7, 0, 1); t = addMin(t, 1)) watchedRow(t, false);
    const before = computeNight(CHILD, DATE, { includeTimeline: true });
    db.prepare('DELETE FROM activity_samples').run();
    for (let t = at(19, 30); t < at(7, 0, 1); t = addMin(t, 1)) watchedRow(t, true);
    const after = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(before.status, 'ok', 'sanity: a real, scored night');
    assert.ok(before.wake_count >= 1, 'sanity: the night has a wake for a stray "heard" minute to disturb');
    assert.deepEqual(after, before);
  });

  test('#453 C3: silent minutes with NO video (rows that exist only since #453) give the same night as no rows', () => {
    // A two-hour video outage (03:00-05:00) during which the microphone heard only digital silence: before #453
    // those minutes stored no row; now each stores frames 0 and sound_peak 0. Both must be unknown, not asleep.
    const lay = (withSilentRows) => {
      for (let t = at(19, 30); t < at(7, 0, 1); t = addMin(t, 1)) {
        if (!within(t, [[at(3, 0, 1), at(5, 0, 1)]])) watchedRow(t, false);
        else if (withSilentRows) noVideoSilentRow(t);
      }
    };
    lay(false);
    const before = computeNight(CHILD, DATE, { includeTimeline: true });
    db.prepare('DELETE FROM activity_samples').run();
    lay(true);
    const after = computeNight(CHILD, DATE, { includeTimeline: true });
    assert.equal(before.unknown_minutes, 120, 'sanity: the outage is unknown');
    assert.deepEqual(after, before);
  });
});
