// activity_samples: the per-minute timeline every sleep number is derived from.
//
// This module had NO tests, which matters more than its size suggests — sleepAnalysis.js sits at 99.5%
// coverage while the thing that FEEDS it was unmeasured, and that is exactly where a real defect hid
// (the sound baseline investigation of 2026-08-31). The choices pinned here are the ones downstream
// code silently depends on:
//   * `*_peak` is a MAXIMUM over the minute and `*_level` is a MEAN. Sleep thresholds are compared
//     against the peak, so which of the two a caller gets is the difference between "the child moved"
//     and "the room was noisy on average".
//   * A channel with no samples in the minute writes NULL, not 0 — "we did not look" must stay
//     distinguishable from "we looked and it was still".
//   * The bucket map is swapped out BEFORE the insert, so a signal arriving mid-flush lands in the
//     next minute rather than being lost or double-counted.
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';
// No db.js behind this import: the rig takes the tracker's functions as arguments (#493 tests below).
import { motionRig, feedStream, steadyFrames, withLedger } from './helpers/obsRig.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const at = await import('../src/lib/activityTracker.js');

const rows = () => db.prepare('SELECT * FROM activity_samples ORDER BY camera_id').all();
const rowFor = (cam) => db.prepare('SELECT * FROM activity_samples WHERE camera_id = ?').get(cam);

// Listeners live in a module-level Set; every test that adds one must remove it or later tests inherit
// it. Collect the unsubscribes and run them in beforeEach.
let unsubs = [];
const listen = (cb) => { unsubs.push(at.onMinuteFlushed(cb)); };

before(() => {
  makeCamera(db, { id: 'cam-1', name: 'One' });
  makeCamera(db, { id: 'cam-2', name: 'Two' });
});
// ⚠️ stopActivityTracker IS LOAD-BEARING, not tidiness (issue #278). The interval-guard test below
// calls startActivityTracker for real, and its two timers used to have no way to be cleared — so this
// file alone kept `node --test` alive forever, and the whole suite was run under `--test-force-exit`
// to compensate. That flag is what cancelled 14 files on a contended CI runner.
after(() => { at.stopActivityTracker(); db.close(); cleanupTempDataDirs(); });
beforeEach(() => {
  while (unsubs.length) unsubs.pop()();
  db.prepare('DELETE FROM activity_samples').run();
  at.flushActivity(); // drain anything a previous test left in the in-memory buckets
  db.prepare('DELETE FROM activity_samples').run();
});

// --- accumulating -----------------------------------------------------------------------------

test('peak is the maximum and level is the mean over the minute', () => {
  for (const f of [0.10, 0.50, 0.20]) at.recordMotion('cam-1', f);
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.motion_peak, 0.5, 'peak is the MAX — this is what sleep thresholds compare against');
  assert.ok(Math.abs(r.motion_level - 0.8 / 3) < 1e-9, 'level is the MEAN of the same samples');
  assert.equal(r.motion_frames, 3);
});

test('out-of-bed motion is accumulated separately from in-bed motion', () => {
  // Kept apart so the timeline can tell stirring IN the bed from someone moving around the room.
  at.recordMotion('cam-1', 0.02);
  at.recordMotionOut('cam-1', 0.40);
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.motion_peak, 0.02);
  assert.equal(r.motion_out_peak, 0.4);
});

test('sound is accumulated as dB over ambient', () => {
  for (const d of [2, 11, 0]) at.recordSound('cam-1', d);
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.sound_peak, 11);
  assert.ok(Math.abs(r.sound_level - 13 / 3) < 1e-9);
  assert.equal(r.sound_windows, 3);
});

// ROADMAP §1.4 Phase 1: aggregate the already-rectified recordDb stream. These diagnostics do
// not choose a future sleep threshold or exercise the separately-tested soundBaseline EMA.
for (const { label, values, p75, p90, sd } of [
  { label: 'even count, unsorted and spanning two digits', values: [12, 0, 4, 2], p75: 4, p90: 12, sd: Math.sqrt(20.75) },
  { label: 'odd count', values: [12, 0, 4, 2, 7], p75: 7, p90: 12, sd: Math.sqrt(17.6) },
  { label: 'all equal', values: [3, 3, 3, 3], p75: 3, p90: 3, sd: 0 },
  { label: 'single reading', values: [7], p75: 7, p90: 7, sd: 0 },
  { label: 'round-off below zero variance', values: [0.1, 0.1, 0.1], p75: 0.1, p90: 0.1, sd: 0 },
]) {
  test(`sound percentile and population sd: ${label}`, () => {
    for (const value of values) at.recordSound('cam-1', value);
    assert.equal(at.flushActivity(), 1);
    const r = rowFor('cam-1');
    assert.equal(r.sound_windows, values.length);
    assert.equal(r.sound_p75, p75);
    assert.equal(r.sound_p90, p90);
    assert.equal(typeof r.sound_sd, 'number', 'NaN can reach SQLite as NULL; do not coerce it to zero');
    assert.ok(Math.abs(r.sound_sd - sd) < 1e-9, `sd ${r.sound_sd}, expected ${sd}`);
  });
}

test('sound percentile diagnostics stay below the active boundary for a fixed rectified quiet minute', () => {
  // A coarse, fixed aggregation analogue, not a random draw or a replay of the EMA pipeline.
  // For X ~ N(0, 2²), P(max(0, X) <= v) = Phi(v/2), v >= 0: p75 ≈ 1.35, p90 ≈ 2.56.
  // Half the readings are exactly zero; rank 225 is 1.35 and rank 270 is 2.56. One tail reading
  // crosses today's 6 dB SOUND_ACTIVE boundary. Hand totals: sum=244.31, sum of squares=608.5161.
  const values = [
    ...Array(150).fill(0), ...Array(74).fill(0.6), 1.35,
    ...Array(44).fill(2), 2.56, ...Array(29).fill(3.5), 6.5,
  ];
  for (const value of values.reverse()) at.recordSound('cam-1', value);
  assert.equal(at.flushActivity(), 1);
  const r = rowFor('cam-1');
  assert.equal(r.sound_windows, 300);
  assert.equal(r.sound_p75, 1.35);
  assert.equal(r.sound_p90, 2.56);
  assert.ok(Math.abs(r.sound_sd - Math.sqrt(608.5161 / 300 - (244.31 / 300) ** 2)) < 1e-9);
  assert.equal(r.sound_peak, 6.5);
  assert.ok(r.sound_peak >= 6);
  for (const value of [r.sound_p75, r.sound_p90, r.sound_sd]) assert.ok(value < 3, 'well below 6 dB');
});

for (const { elevated, p75, p90 } of [
  { elevated: 30, p75: 2, p90: 2 },
  { elevated: 31, p75: 2, p90: 12 },
  { elevated: 75, p75: 2, p90: 12 },
  { elevated: 76, p75: 12, p90: 12 },
]) {
  test(`sound percentile burst boundary: ${elevated} of 300 elevated readings`, () => {
    // Lower p75 needs a LONGER burst: 76 windows (~15.2s), versus p90's 31 (~6.2s).
    for (let i = 0; i < 300; i++) at.recordSound('cam-1', i < elevated ? 12 : 2);
    assert.equal(at.flushActivity(), 1);
    const r = rowFor('cam-1');
    assert.equal(r.sound_p75, p75);
    assert.equal(r.sound_p90, p90);
    assert.equal(r.sound_peak, 12);
    // Two-point population variance: (12-2)² * k * (n-k) / n².
    const sd = 10 * Math.sqrt(elevated * (300 - elevated)) / 300;
    assert.ok(Math.abs(r.sound_sd - sd) < 1e-9);
  });
}

test('sound percentile uses the accepted count even for a catch-up burst above 300 windows', () => {
  for (let i = 0; i < 600; i++) at.recordSound('cam-1', i < 61 ? 12 : 2);
  assert.equal(at.flushActivity(), 1);
  const r = rowFor('cam-1');
  assert.equal(r.sound_windows, 600);
  assert.equal(r.sound_p75, 2);
  assert.equal(r.sound_p90, 12);
  assert.ok(Math.abs(r.sound_sd - 10 * Math.sqrt(61 * 539) / 600) < 1e-9);
});

test('sound percentile and sd stay isolated between cameras and reset after flushing', () => {
  for (const value of [12, 0, 4, 2]) at.recordSound('cam-1', value);
  for (const value of [1, 3, 5, 7, 9]) at.recordSound('cam-2', value);
  assert.equal(at.flushActivity(), 2);
  const first = rowFor('cam-1');
  const second = rowFor('cam-2');
  assert.equal(first.sound_p75, 4);
  assert.equal(first.sound_p90, 12);
  assert.ok(Math.abs(first.sound_sd - Math.sqrt(20.75)) < 1e-9);
  assert.equal(second.sound_p75, 7);
  assert.equal(second.sound_p90, 9);
  assert.ok(Math.abs(second.sound_sd - Math.sqrt(8)) < 1e-9);

  db.prepare('DELETE FROM activity_samples').run();
  at.recordSound('cam-1', 6);
  assert.equal(at.flushActivity(), 1);
  const next = rowFor('cam-1');
  assert.equal(next.sound_windows, 1);
  assert.equal(next.sound_p75, 6);
  assert.equal(next.sound_p90, 6);
  assert.equal(next.sound_sd, 0);
  assert.equal(rowFor('cam-2'), undefined);
});

test('sound percentile bindings preserve all five distinct sound and outside-motion diagnostics', () => {
  // All five are nullable REALs: SQLite cannot detect an INSERT column/argument-order swap.
  for (const value of [0.2, 0.6]) at.recordMotionOut('cam-1', value);
  for (const value of [12, 0, 4, 2]) at.recordSound('cam-1', value);
  assert.equal(at.flushActivity(), 1);
  const r = rowFor('cam-1');
  assert.equal(r.motion_out_level, 0.4);
  assert.equal(r.motion_out_peak, 0.6);
  assert.equal(r.sound_p75, 4);
  assert.equal(r.sound_p90, 12);
  assert.ok(Math.abs(r.sound_sd - Math.sqrt(20.75)) < 1e-9);
});

test('sound percentile and sd are NULL with no sound windows and the motion row survives', () => {
  at.recordMotion('cam-1', 0.3);
  assert.equal(at.flushActivity(), 1, 'undefined sound bindings would silently drop this whole row');
  const r = rowFor('cam-1');
  assert.equal(r.motion_peak, 0.3);
  assert.equal(r.sound_windows, 0);
  assert.equal(r.sound_p75, null);
  assert.equal(r.sound_p90, null);
  assert.equal(r.sound_sd, null);
});

test('negative and clearly non-numeric samples are rejected', () => {
  // `!(v >= 0)` rejects NaN, which is the one that matters most: a NaN reaching motionSum would make
  // the whole minute's level NaN, and nothing downstream would notice.
  for (const bad of [-0.1, NaN, undefined, 'x', {}, [1, 2]]) {
    at.recordMotion('cam-1', bad);
    at.recordMotionOut('cam-1', bad);
    at.recordSound('cam-1', bad);
  }
  assert.equal(at.flushActivity(), 0, 'nothing was recorded, so no row is written');
  at.recordMotion('cam-1', 0);
  at.flushActivity();
  assert.equal(rowFor('cam-1').motion_frames, 1, 'zero IS a valid sample — a still room is data');
});

// ⚠️ CHARACTERISATION, not an endorsement, and deliberately NOT fixed while the sleep holdout runs.
//
// `!(v >= 0)` is a coercion test, not a type test, so every value JavaScript coerces to a number ≥ 0
// gets through: `null`, `false`, `''` and `[]` all become 0, and a numeric STRING gets through as
// itself. That last one is the worst of them — `motionSum += '5'` CONCATENATES, so two '5' samples
// give a sum of "055" and a mean of 27.5 rather than 5.
//
// This matters because it destroys the distinction the module works hard to preserve everywhere else:
// a channel with no samples writes NULL, not 0, so "we did not look" stays separable from "we looked
// and it was still". A null sample quietly becomes the second of those.
//
// No current caller can pass any of these — motionDetector passes `changed / zonePixels` and
// soundDetector passes `Math.max(0, rms - baseline)`, both always real numbers — so this is latent,
// not live. Pinned here so the next person sees it, and so a future fix is a deliberate change rather
// than a surprise. The fix, when it happens, is `Number.isFinite(v) && v >= 0`.
test('KNOWN QUIRK: anything coercible to a non-negative number passes the guard', () => {
  for (const v of [null, false, '', []]) {
    at.recordMotion('cam-1', v);
    assert.equal(at.flushActivity(), 1, `${JSON.stringify(v)} was recorded as a real sample`);
    const r = rowFor('cam-1');
    assert.equal(r.motion_frames, 1);
    assert.equal(r.motion_peak, 0, 'it lands as zero motion, i.e. "the room was still"');
    db.prepare('DELETE FROM activity_samples').run();
  }
});

test('KNOWN QUIRK: a numeric string concatenates instead of adding', () => {
  at.recordMotion('cam-1', '5');
  at.recordMotion('cam-1', '5');
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 2);
  assert.equal(r.motion_level, 27.5, 'sum was "0"+"5"+"5" = "055", divided by 2 — not 5');
});

// --- flushing ---------------------------------------------------------------------------------

test('a channel with no samples writes NULL, not zero — both directions', () => {
  at.recordMotion('cam-1', 0.3);
  at.flushActivity();
  const motionOnly = rowFor('cam-1');
  assert.equal(motionOnly.sound_peak, null, '"we did not listen" must not read as "it was silent"');
  assert.equal(motionOnly.sound_level, null);
  assert.equal(motionOnly.sound_windows, 0);
  assert.equal(motionOnly.motion_out_peak, null, 'no zone painted means no out-of-bed channel at all');
  db.prepare('DELETE FROM activity_samples').run();

  // The mirror case: a sound-only minute must leave the MOTION columns null, not 0. Without this the
  // whole invariant is only half pinned, and a sleep threshold comparing motion_peak against a
  // number would read "perfectly still" for a camera that was never watched.
  at.recordSound('cam-1', 4);
  at.flushActivity();
  const soundOnly = rowFor('cam-1');
  assert.equal(soundOnly.motion_peak, null);
  assert.equal(soundOnly.motion_level, null);
  assert.equal(soundOnly.motion_frames, 0);
});

test('the live listener carries NULL for an unsampled channel too', () => {
  // wakeWatcher consumes this payload rather than re-reading the row, so the same "we did not look"
  // distinction has to survive the hand-off. Recording BOTH channels — as the other listener test
  // does — never exercises this, because then neither side is null.
  const seen = [];
  listen((e) => seen.push(e));
  at.recordMotion('cam-1', 0.2);
  at.flushActivity();
  assert.equal(seen.at(-1).soundPeak, null, 'nothing was heard, and that is not the same as silence');

  at.recordSound('cam-2', 9);
  at.flushActivity();
  assert.equal(seen.at(-1).motionPeak, null, 'nothing was seen, and that is not the same as stillness');
  assert.equal(seen.at(-1).soundPeak, 9);
});

// ⚠️ CHARACTERISATION of a real gap, pinned rather than fixed (the holdout freezes this module).
// A minute is written only when motionFrames or soundWindows is non-zero — motionOutFrames is not
// consulted. So a minute in which ONLY out-of-bed motion was recorded is silently discarded, and the
// out-of-bed channel is precisely the one the exit rule depends on. No live caller can reach it today
// (motionDetector always records in-bed motion alongside out-of-bed motion, so motionFrames > 0
// whenever motionOutFrames > 0), which is why it has never bitten.
test('KNOWN GAP: a minute of only out-of-bed motion is dropped entirely', () => {
  at.recordMotionOut('cam-1', 0.9);
  assert.equal(at.flushActivity(), 0, 'no row at all, and the sample is gone');
  assert.equal(rows().length, 0);
});

test('flushActivity writes one row per camera that saw something, and returns the count', () => {
  at.recordMotion('cam-1', 0.1);
  at.recordSound('cam-2', 3);
  assert.equal(at.flushActivity(), 2);
  assert.deepEqual(rows().map((r) => r.camera_id), ['cam-1', 'cam-2']);
});

test('flushing an empty tracker writes nothing and returns 0', () => {
  assert.equal(at.flushActivity(), 0);
  assert.equal(rows().length, 0);
});

test('buckets reset after a flush, so a minute is never counted twice', () => {
  at.recordMotion('cam-1', 0.9);
  at.flushActivity();
  assert.equal(at.flushActivity(), 0, 'the second flush has nothing left to write');
  assert.equal(rows().length, 1);
});

test('bucket_start is a UTC minute, matching the format sleepAnalysis queries on', () => {
  at.recordMotion('cam-1', 0.1);
  at.flushActivity();
  const b = rowFor('cam-1').bucket_start;
  assert.match(b, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/, 'seconds are always :00 — this is a minute bucket');
  const drift = Math.abs(new Date(`${b.replace(' ', 'T')}Z`).getTime() - Date.now());
  assert.ok(drift < 120000, `bucket ${b} should be the current UTC minute, not local time`);
});

// --- the live subscription --------------------------------------------------------------------

test('listeners get the same peaks that were just written', () => {
  const seen = [];
  listen((e) => seen.push(e));
  at.recordMotion('cam-1', 0.42);
  at.recordSound('cam-1', 7);
  at.flushActivity();
  assert.equal(seen.length, 1);
  const r = rowFor('cam-1');
  assert.equal(seen[0].cameraId, 'cam-1');
  assert.equal(seen[0].motionPeak, r.motion_peak, 'wakeWatcher must see EXACTLY the stored signal');
  assert.equal(seen[0].soundPeak, r.sound_peak);
  assert.equal(seen[0].bucketStart, r.bucket_start);
});

test('unsubscribing actually stops the callbacks', () => {
  let calls = 0;
  const off = at.onMinuteFlushed(() => { calls++; });
  at.recordMotion('cam-1', 0.1);
  at.flushActivity();
  assert.equal(calls, 1);
  off();
  at.recordMotion('cam-1', 0.1);
  at.flushActivity();
  assert.equal(calls, 1, 'no further calls after unsubscribe');
});

test('a listener that throws cannot cost us the rest of the flush', () => {
  // This runs on a timer with nothing upstream to catch what escapes, so one bad consumer must not
  // stop the other consumers or the other cameras.
  const seen = [];
  listen(() => { throw new Error('consumer exploded'); });
  listen((e) => seen.push(e.cameraId));
  at.recordMotion('cam-1', 0.1);
  at.recordMotion('cam-2', 0.2);
  assert.equal(at.flushActivity(), 2, 'both rows still written');
  assert.deepEqual(seen.sort(), ['cam-1', 'cam-2'], 'the surviving listener still saw both cameras');
});

// --- retention --------------------------------------------------------------------------------

test('pruneActivitySamples cuts exactly at the 30-day line', () => {
  // Straddle the boundary by an hour on each side rather than by days. A fixture sitting comfortably
  // clear of the line does not test the line: with -31/-29 days, moving RETENTION_DAYS to 29 still
  // passed. An hour is tight enough to pin the constant and wide enough that the wall clock ticking
  // mid-test cannot flip the result.
  const insert = (ago) =>
    db.prepare(
      `INSERT INTO activity_samples (camera_id, bucket_start, motion_frames, sound_windows, created_at)
       VALUES ('cam-1', '2026-01-01 00:00:00', 1, 0, datetime('now', ?, ?))`
    ).run('-30 days', ago);
  insert('-1 hour'); // just past the window — must go
  insert('+1 hour'); // just inside it — must stay
  at.pruneActivitySamples();
  assert.equal(rows().length, 1, 'exactly one row survives, and it is the newer one');
  const kept = rows()[0].created_at;
  const cut = db.prepare("SELECT datetime('now', '-30 days') AS t").get().t;
  assert.ok(kept > cut, `kept row ${kept} must be newer than the ${cut} cutoff`);
});

test('startActivityTracker prunes immediately, and a second call starts no second timer', () => {
  db.prepare(
    `INSERT INTO activity_samples (camera_id, bucket_start, motion_frames, sound_windows, created_at)
     VALUES ('cam-1', '2026-01-01 00:00:00', 1, 0, datetime('now', '-90 days'))`
  ).run();

  // Count real setInterval calls. Asserting the guard needs something observable: without it a second
  // flusher and a second pruner are registered and never cleared, and the previous version of this
  // test asserted nothing at all about that — replacing `if (flushTimer) return` with `if (false)`
  // left the whole suite green.
  const spy = mock.method(globalThis, 'setInterval');
  try {
    at.startActivityTracker();
    assert.equal(rows().length, 0, 'startup sweeps stale rows without waiting a day for the timer');
    assert.equal(spy.mock.callCount(), 2, 'one flush timer and one prune timer');
    at.startActivityTracker();
    assert.equal(spy.mock.callCount(), 2, 'the second call is a no-op, not a second pair of timers');
  } finally {
    spy.mock.restore();
  }
});

// --- #493: the clone ledger -------------------------------------------------------------------
// ffmpeg's fps=5 fills a camera stall with repeats of the last real frame, and the diff detector reads each
// one as a still room that nobody observed. The observation clock proves which frames were repeats ~5 s
// after the detector counted them; excludeClone takes those back out of the OBSERVED counts. What the
// fixtures below are built to catch, each on purpose:
//   * the peaks, the row-write decision and the minute listener stay on the RAW counts (every fixture
//     that corrects also checks them);
//   * a correction lands once, on the frame and channel it names, and only while its minute is open;
//   * a camera with no bed zone never gets an out-of-bed count, so correcting cannot conjure one;
//   * the key carries the generation, so two ffmpeg launches whose frame numbers collide stay apart.
// PLANTED oracle throughout: every fraction, and which frames are repeats, is a fact of the fixture.

const g7 = (token) => ({ gen: 7, token });
const listenAll = () => { const seen = []; listen((e) => seen.push(e)); return seen; };

test('#493: a proven clone leaves motion_frames and both means; the peaks, the row and the listener stay on the raw count', () => {
  const seen = listenAll();
  // Two real frames that moved, then two repeats (fraction exactly 0, in bed and outside).
  at.recordMotion('cam-1', 0.4, g7(1));
  at.recordMotionOut('cam-1', 0.3, g7(1));
  for (const tok of [2, 3]) {
    at.recordMotion('cam-1', 0, g7(tok));
    at.recordMotionOut('cam-1', 0, g7(tok));
  }
  at.recordMotion('cam-1', 0.2, g7(4));
  at.recordMotionOut('cam-1', 0.1, g7(4));
  assert.equal(at.excludeClone('cam-1', 7, 2), true);
  assert.equal(at.excludeClone('cam-1', 7, 3), true);
  assert.equal(at.flushActivity(), 1);
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 2, 'four counted, two proven repeats');
  assert.ok(Math.abs(r.motion_level - 0.3) < 1e-12, `mean over the two observed frames (0.6 / 2), not over four (0.15): ${r.motion_level}`);
  assert.ok(Math.abs(r.motion_out_level - 0.2) < 1e-12, `out-of-bed mean over two (0.4 / 2): ${r.motion_out_level}`);
  assert.equal(r.motion_peak, 0.4, 'peaks are maxima: a repeat can never have set one');
  assert.equal(r.motion_out_peak, 0.3);
  assert.equal(seen.at(-1).motionPeak, 0.4);
});

test('#493: a correction happens once — a repeated verdict for the same frame is a no-op', () => {
  for (const tok of [1, 2, 3]) at.recordMotion('cam-1', 0, g7(tok));
  assert.equal(at.excludeClone('cam-1', 7, 2), true);
  assert.equal(at.excludeClone('cam-1', 7, 2), false, 'the second verdict finds nothing to undo');
  at.flushActivity();
  assert.equal(rowFor('cam-1').motion_frames, 2, 'three counted, one repeat, taken out ONCE');
});

test('#493: a frame that is never classified stays counted, byte for byte what an unstaged frame gives', () => {
  // The failure mode of a clock that throws, or whose side channel was lost (every verdict `unknown`, which
  // the detector never forwards): no verdict ever arrives. cam-1 is staged, cam-2 is not; same frames.
  for (const [tok, f, fo] of [[1, 0.4, 0.3], [2, 0, 0], [3, 0, 0], [4, 0.2, 0]]) {
    at.recordMotion('cam-1', f, g7(tok));
    at.recordMotionOut('cam-1', fo, g7(tok));
    at.recordMotion('cam-2', f);
    at.recordMotionOut('cam-2', fo);
  }
  assert.equal(at.flushActivity(), 2);
  // created_at is SQLite's own clock: the two inserts can straddle a second.
  const { camera_id: _a, id: _i1, created_at: _c1, ...staged } = rowFor('cam-1');
  const { camera_id: _b, id: _i2, created_at: _c2, ...plain } = rowFor('cam-2');
  assert.deepEqual(staged, plain);
  assert.equal(staged.motion_frames, 4);
});

test('#493: a verdict that arrives after its minute was flushed changes nothing, and the ledger empties at every flush', () => {
  at.recordMotion('cam-1', 0, g7(1));
  at.recordMotion('cam-1', 0.5, g7(2)); // it moved: counted, never staged
  assert.equal(at.cloneLedgerSize(), 1, 'only the zero-fraction frame is staged');
  at.flushActivity();
  assert.equal(at.cloneLedgerSize(), 0, 'the minute closed and took its staged frames with it');
  // The next minute: a frame of the SAME launch.
  at.recordMotion('cam-1', 0, g7(3));
  assert.equal(at.excludeClone('cam-1', 7, 1), false, 'the late verdict for token 1 finds nothing');
  at.flushActivity();
  const inOrder = db.prepare('SELECT motion_frames FROM activity_samples ORDER BY id').all();
  assert.deepEqual(inOrder.map((r) => r.motion_frames), [2, 1], 'neither the flushed minute nor the next one moved');
});

test('#493: the ledger is bounded by one open minute — 300 staged frames, all gone at the flush', () => {
  for (let tok = 1; tok <= 300; tok += 1) at.recordMotion('cam-1', 0, g7(tok));
  at.recordMotion('cam-1', 0); // no clock for this one: never staged
  assert.equal(at.cloneLedgerSize(), 300);
  at.excludeClone('cam-1', 7, 150);
  assert.equal(at.cloneLedgerSize(), 299, 'a resolved frame leaves the ledger');
  at.flushActivity();
  assert.equal(at.cloneLedgerSize(), 0);
  assert.equal(rowFor('cam-1').motion_frames, 300, '301 counted, one repeat');
});

test('#493: two ffmpeg launches whose frame numbers collide are corrected independently — the key carries the generation', () => {
  // A reconnect restarts the detector's frame numbers at 0, so launch 1's frame 5 and launch 2's frame 5
  // share a token. Launch 1 ran with no bed zone (in-bed count only); launch 2 with one (both counts).
  at.recordMotion('cam-1', 0.5);
  at.recordMotionOut('cam-1', 0.5);
  at.recordMotion('cam-1', 0, { gen: 1, token: 5 });
  at.recordMotion('cam-1', 0, { gen: 2, token: 5 });
  at.recordMotionOut('cam-1', 0, { gen: 2, token: 5 });
  assert.equal(at.excludeClone('cam-1', 3, 5), false, 'a third launch\'s frame 5 was never staged');
  assert.equal(at.excludeClone('cam-1', 1, 5), true);
  assert.equal(at.excludeClone('cam-1', 2, 5), true);
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 1, 'three counted, BOTH repeats out');
  assert.equal(r.motion_level, 0.5);
  assert.equal(r.motion_out_level, 0.5, 'two out-of-bed frames counted, only launch 2\'s repeat out');
});

test('#493: a camera with no bed zone — a clone never drives the out-of-bed count below zero, and motion_out_* stay NULL', () => {
  // The detector never calls recordMotionOut without a bed zone. A ledger that undid an out-of-bed count
  // it never made would leave -1, which is TRUTHY: motion_out_level would become 0 instead of NULL.
  at.recordMotion('cam-1', 0.2);
  at.recordMotion('cam-1', 0, g7(1));
  assert.equal(at.excludeClone('cam-1', 7, 1), true);
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 1);
  assert.equal(r.motion_out_level, null, 'no zone painted means no out-of-bed channel, corrected or not');
  assert.equal(r.motion_out_peak, null);
});

test('#493: a frame that REGISTERED movement is never taken out, whatever the verdict says — only its zero channel is', () => {
  // A true repeat is byte-identical to the frame before it, so both its fractions are exactly 0. A frame
  // whose in-bed fraction is not 0 keeps its in-bed count: removing it while its 0.3 stayed in the sum would
  // RAISE the mean for movement that was really measured.
  at.recordMotion('cam-1', 0.3, g7(1));
  at.recordMotionOut('cam-1', 0, g7(1));
  assert.equal(at.excludeClone('cam-1', 7, 1), true, 'its out-of-bed channel was staged');
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 1, 'the in-bed frame stays');
  assert.equal(r.motion_level, 0.3);
  assert.equal(r.motion_out_level, null, 'the out-of-bed channel observed nothing');
  assert.equal(r.motion_out_peak, 0, 'but it WAS sampled, so its peak is 0, not NULL — the raw count decides');
});

test('#493: ...and the mirror — still in bed but moving outside loses only its in-bed count', () => {
  // Review round 1 (gap 1): the test above plants movement only IN bed, so a guard that checked only the
  // in-bed fraction and staged every out-of-bed reading survived it.
  at.recordMotion('cam-1', 0, g7(1));
  at.recordMotionOut('cam-1', 0.3, g7(1));
  assert.equal(at.excludeClone('cam-1', 7, 1), true, 'its in-bed channel was staged');
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 0, 'the in-bed channel observed nothing');
  assert.equal(r.motion_level, null);
  assert.equal(r.motion_peak, 0);
  assert.equal(r.motion_out_level, 0.3, 'the outside reading that moved stays');
  assert.equal(r.motion_out_peak, 0.3);
});

test('#493: the guard is EXACT zero — the smallest reading the detector can make, and a small one, are never staged in either channel', () => {
  // Review round 1 (gap 2): with only 0 and 0.2-0.4 planted, a guard of `> 0.25` or `> 1e-3` passed too.
  // 1/57,600 is one changed pixel of a whole 320x180 frame: the smallest non-zero fraction there is (a bed
  // zone has fewer pixels, so its smallest is larger).
  for (const f of [1 / 57_600, 0.05]) {
    at.recordMotion('cam-1', f, g7(2));
    at.recordMotionOut('cam-1', f, g7(2));
    assert.equal(at.cloneLedgerSize(), 0, `${f}: nothing staged`);
    assert.equal(at.excludeClone('cam-1', 7, 2), false, `${f}: a verdict finds nothing to undo`);
    at.flushActivity();
    const r = rowFor('cam-1');
    assert.deepEqual([r.motion_frames, r.motion_level, r.motion_out_level], [1, f, f], `${f}: counted and kept`);
    db.prepare('DELETE FROM activity_samples').run();
  }
});

test('#493: a minute of nothing but proven clones is still written, with the same peaks as before (0, not NULL); only the frame count and means say so', () => {
  // The plan's second review round: with ONE counter, this bucket skipped its row (no motion, no sound) or
  // NULLed its peaks. The raw count keeps both exactly as the code before #493 wrote them.
  const seen = listenAll();
  for (const tok of [1, 2, 3]) {
    at.recordMotion('cam-1', 0, g7(tok));
    at.recordMotionOut('cam-1', 0, g7(tok));
  }
  for (const tok of [1, 2, 3]) at.excludeClone('cam-1', 7, tok);
  assert.equal(at.flushActivity(), 1, 'the row is written: the raw count says frames were analysed');
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 0);
  assert.equal(r.motion_level, null, 'nothing was observed, so there is no mean');
  assert.equal(r.motion_out_level, null);
  assert.equal(r.motion_peak, 0, 'what the raw count gives: frames were analysed and none moved');
  assert.equal(r.motion_out_peak, 0);
  assert.equal(r.sound_peak, null);
  assert.equal(seen.at(-1).motionPeak, 0, 'the listener (wakeWatcher) sees what it saw before #493');
});

// --- #493 with the real observation clock (obsRig; no ffmpeg) -----------------------------------
// The detector's wiring around a real ObservationClock: count the frame, then show it to the clock with the
// same token, and send each PROVEN clone verdict to excludeClone. The oracle is feedStream's planted truth
// ({ outN, slot, src } per output): output k repeats the frame before it exactly when its src is the same.
// Planted movement: a quarter of the real frames are still (fraction exactly 0, so they ARE staged and must
// survive their `real` verdict), the rest move by 0.02-0.10.
const movement = (content) => {
  const src = Number(String(content).slice(1));
  return src % 4 === 0 ? 0 : 0.02 * (1 + (src % 5));
};
const truthClones = (truth) => truth.filter((x, i) => i > 0 && x.src === truth[i - 1].src).map((x) => x.outN);

// Feed `frames`, end the generation, flush once: every verdict has landed before the flush.
function throughClock(frames, opts = {}) {
  const rig = motionRig();
  const w = withLedger(rig, at, { cameraId: 'cam-1', movement, ...opts });
  const s = feedStream(w, frames);
  const last = frames[frames.length - 1].rx;
  s.flush(last + 300);
  w.end(last + 400);
  at.flushActivity();
  const sum = w.counted.reduce((a, c) => a + c.fraction, 0);
  const peak = Math.max(...w.counted.map((c) => c.fraction));
  return { rig, w, s, counted: w.counted.length, sum, peak };
}

// The #373 soak box's stall, rebuilt at 5 fps: frames 0-150, nothing for 3.06 s, then 5 fps again. Each frame
// sits 8,000 ticks (89 ms) into its output slot, so the gap spans 15.3 slots and fps fills slots 151-165 with
// repeats of frame 150: the 15-frame burst the soak run showed. rx = when it reached the server.
function soakStall(after = 150) {
  const frames = [];
  for (let n = 0; n <= 150; n += 1) {
    const pts = n * 18000 + 8000;
    frames.push({ n, pts, rx: 100_000 + Math.ceil(pts / 90) + 10 });
  }
  const resume = 150 * 18000 + 8000 + 275_400; // + 3.06 s at 90 kHz
  for (let n = 151; n <= 150 + after; n += 1) {
    const pts = resume + (n - 151) * 18000;
    frames.push({ n, pts, rx: 100_000 + Math.ceil(pts / 90) + 10 });
  }
  return frames;
}

test('#493 AC4, the soak-box shape: a 3.06 s stall is a burst of 15 fps clones, and exactly those 15 leave the minute\'s motion_frames and means', () => {
  const r = throughClock(soakStall());
  const clones = truthClones(r.s.truth);
  assert.deepEqual(clones, Array.from({ length: 15 }, (_, i) => 151 + i), 'the planted truth: repeats of frame 150 in slots 151-165');
  // Each output is exactly one stdout sample, in order, so a sample's token IS its output number.
  assert.deepEqual(r.w.verdicts.map((v) => v.token), clones, 'the clock proved exactly those, and nothing else');
  const row = rowFor('cam-1');
  assert.equal(row.motion_frames, r.counted - 15, `${r.counted} counted, the 15 repeats out`);
  assert.ok(Math.abs(row.motion_level - r.sum / (r.counted - 15)) < 1e-12, `level ${row.motion_level}`);
  assert.ok(Math.abs(row.motion_out_level - r.sum / (r.counted - 15)) < 1e-12, `out level ${row.motion_out_level}`);
  assert.ok(row.motion_level > r.sum / r.counted, 'taking out zero-valued repeats can only RAISE a mean');
  assert.equal(row.motion_peak, r.peak, 'the peak is the real frames\' maximum, untouched');
  assert.equal(row.motion_out_peak, r.peak);
});

for (const fps of [2, 3, 4.5]) {
  test(`#493: a camera genuinely slower than 5 fps (${fps} fps) — fps pads every second with repeats, and exactly those leave the counts`, () => {
    const r = throughClock(steadyFrames({ fps, count: Math.round(fps * 60) }));
    const clones = truthClones(r.s.truth);
    // Planted: at f fps, 5 - f of every 5 output slots per second have no input.
    assert.ok(Math.abs(clones.length / r.s.truth.length - (5 - fps) / 5) < 0.02, `${clones.length} of ${r.s.truth.length}`);
    assert.deepEqual(r.w.verdicts.map((v) => v.token), clones);
    const row = rowFor('cam-1');
    assert.equal(row.motion_frames, r.counted - clones.length);
    assert.ok(Math.abs(row.motion_level - r.sum / (r.counted - clones.length)) < 1e-12);
    assert.ok(Math.abs(row.motion_out_level - r.sum / (r.counted - clones.length)) < 1e-12);
    assert.equal(row.motion_peak, r.peak);
    assert.equal(row.motion_out_peak, r.peak);
  });
}

test('#493: the soak-box stall on a camera with NO bed zone — the repeats leave the in-bed count, and there is still no out-of-bed channel', () => {
  const r = throughClock(soakStall(), { out: false });
  assert.equal(r.w.verdicts.length, 15);
  const row = rowFor('cam-1');
  assert.equal(row.motion_frames, r.counted - 15);
  assert.equal(row.motion_out_level, null);
  assert.equal(row.motion_out_peak, null);
});

test('#493 KNOWN LIMIT: a repeat whose verdict lands after its minute was flushed stays counted — about 8% of a 3 fps camera\'s', () => {
  // A verdict arrives FINALIZE_MS (5 s) after its frame, and the minute is flushed every 60 s, so repeats
  // counted in a minute's last ~5 s are classified after it closed: 5/60 = 8.3% of evenly spread repeats.
  // Accepted and documented (KNOWN-ISSUES.md, "The `[obs]` line"); #447's flush-time buckets supersede it.
  // Every row is checked against its own accounting: counted in the minute, minus the repeats whose verdict
  // reached the ledger BEFORE that minute's flush.
  const rig = motionRig();
  const w = withLedger(rig, at, { cameraId: 'cam-1', movement, flushEveryMs: 60_000, flushFrom: 160_000 });
  const frames = steadyFrames({ fps: 3, count: 3 * 600 }); // 10 minutes
  const s = feedStream(w, frames);
  const last = frames[frames.length - 1].rx;
  s.flush(last + 300);
  w.end(last + 400);
  at.flushActivity(); // the last, partial minute: every verdict is in by now
  const bounds = [...w.flushes, Infinity];
  const bucketOf = (t) => bounds.findIndex((b) => t < b);
  const verdictAt = new Map(w.verdicts.map((v) => [v.token, v.at]));
  const buckets = bounds.map(() => ({ counted: 0, frames: 0, sum: 0 }));
  let missed = 0;
  for (const c of w.counted) {
    const b = bucketOf(c.at);
    const v = verdictAt.get(c.token);
    const corrected = v !== undefined && v < bounds[b];
    if (v !== undefined && !corrected) missed += 1;
    buckets[b].counted += 1;
    if (!corrected) buckets[b].frames += 1;
    buckets[b].sum += c.fraction;
  }
  // A minute in which nothing was counted writes no row (the stream can end on a boundary).
  const expected = buckets.filter((b) => b.counted > 0);
  const got = rows().sort((a, b) => a.id - b.id);
  assert.ok(expected.length >= 10, `ten minutes of stream: ${expected.length}`);
  assert.equal(got.length, expected.length, 'one row per minute that counted anything');
  got.forEach((row, i) => {
    assert.equal(row.motion_frames, expected[i].frames, `minute ${i}`);
    assert.ok(Math.abs(row.motion_level - expected[i].sum / expected[i].frames) < 1e-12, `minute ${i} level`);
  });
  assert.equal(w.verdicts.length, truthClones(s.truth).length, 'every repeat was proven — the misses are timing, not classification');
  const share = missed / w.verdicts.length;
  assert.ok(missed > 0, 'the residual is real: some verdicts DO land after their minute closed');
  assert.ok(Math.abs(share - 5 / 60) < 0.01, `missed ${missed} of ${w.verdicts.length} (${(share * 100).toFixed(1)}%), expected ~8.3%`);
});
