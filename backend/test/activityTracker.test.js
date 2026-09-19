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
