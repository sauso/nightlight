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
//   * #447: a row's `bucket_start` is the UTC minute its samples were RECEIVED in, not the minute a timer
//     happened to flush it in. A minute reaches its listeners at its end and its row GRACE_MS (7 s) later.
import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';
// No db.js behind this import: the rig takes the tracker's functions as arguments (#493 tests below).
import { motionRig, feedStream, steadyFrames, withLedger, WALL0 } from './helpers/obsRig.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const at = await import('../src/lib/activityTracker.js');

const rows = () => db.prepare('SELECT * FROM activity_samples ORDER BY camera_id').all();
const rowFor = (cam) => db.prepare('SELECT * FROM activity_samples WHERE camera_id = ?').get(cam);
// Oldest minute first; `id` breaks a tie, so a duplicate label shows up as two consecutive rows.
const rowsOf = (cam) => db.prepare('SELECT * FROM activity_samples WHERE camera_id = ? ORDER BY bucket_start, id').all(cam);

// #447: "write everything now", for the tests that mean DRAIN and nothing about timing. `{ all: true }` also
// closes the minute still receiving, so a sample recorded after a drain in the same test lands in the NEXT
// minute (the last-closed clamp); none of those tests reads bucket_start. Timing tests below pass explicit
// times instead.
const drain = () => at.flushActivity(Date.now(), { all: true });

// A fixed minute boundary, 19:00:00 UTC, for every test that plants receipt times. Local timezone never
// matters: bucket_start is UTC and so is this.
const M = Date.UTC(2026, 8, 29, 19, 0, 0);
const MIN = 60_000;
const label = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
// The running tracker's timer, emulated: one flushActivity per second from `from` to `to` inclusive.
function ticks(from, to) {
  let written = 0;
  for (let t = from; t <= to; t += 1000) written += at.flushActivity(t);
  return written;
}

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
  // #447: every piece of tracker state a previous test could leave behind — open minutes, the clone ledger,
  // the last-closed minutes (a test that drained with `{ all: true }` would otherwise push this test's samples
  // for the same minute into the next one), the late ring, the counters and the timers.
  at._resetActivityTrackerForTests();
  db.prepare('DELETE FROM activity_samples').run();
});

// --- accumulating -----------------------------------------------------------------------------

test('peak is the maximum and level is the mean over the minute', () => {
  for (const f of [0.10, 0.50, 0.20]) at.recordMotion('cam-1', f);
  drain();
  const r = rowFor('cam-1');
  assert.equal(r.motion_peak, 0.5, 'peak is the MAX — this is what sleep thresholds compare against');
  assert.ok(Math.abs(r.motion_level - 0.8 / 3) < 1e-9, 'level is the MEAN of the same samples');
  assert.equal(r.motion_frames, 3);
});

test('out-of-bed motion is accumulated separately from in-bed motion', () => {
  // Kept apart so the timeline can tell stirring IN the bed from someone moving around the room.
  at.recordMotion('cam-1', 0.02);
  at.recordMotionOut('cam-1', 0.40);
  drain();
  const r = rowFor('cam-1');
  assert.equal(r.motion_peak, 0.02);
  assert.equal(r.motion_out_peak, 0.4);
});

test('sound is accumulated as dB over ambient', () => {
  for (const d of [2, 11, 0]) at.recordSound('cam-1', d);
  drain();
  const r = rowFor('cam-1');
  assert.equal(r.sound_peak, 11);
  assert.ok(Math.abs(r.sound_level - 13 / 3) < 1e-9);
  assert.equal(r.sound_windows, 3);
});

// ROADMAP §1.4 Phase 1: aggregate the already-rectified recordDb stream. These diagnostics do
// not choose a future sleep threshold or exercise the separately-tested soundBaseline EMA.
for (const { label: name, values, p75, p90, sd } of [
  { label: 'even count, unsorted and spanning two digits', values: [12, 0, 4, 2], p75: 4, p90: 12, sd: Math.sqrt(20.75) },
  { label: 'odd count', values: [12, 0, 4, 2, 7], p75: 7, p90: 12, sd: Math.sqrt(17.6) },
  { label: 'all equal', values: [3, 3, 3, 3], p75: 3, p90: 3, sd: 0 },
  { label: 'single reading', values: [7], p75: 7, p90: 7, sd: 0 },
  { label: 'round-off below zero variance', values: [0.1, 0.1, 0.1], p75: 0.1, p90: 0.1, sd: 0 },
]) {
  test(`sound percentile and population sd: ${name}`, () => {
    for (const value of values) at.recordSound('cam-1', value);
    assert.equal(drain(), 1);
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
  assert.equal(drain(), 1);
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
    assert.equal(drain(), 1);
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
  assert.equal(drain(), 1);
  const r = rowFor('cam-1');
  assert.equal(r.sound_windows, 600);
  assert.equal(r.sound_p75, 2);
  assert.equal(r.sound_p90, 12);
  assert.ok(Math.abs(r.sound_sd - 10 * Math.sqrt(61 * 539) / 600) < 1e-9);
});

test('sound percentile and sd stay isolated between cameras and reset after flushing', () => {
  for (const value of [12, 0, 4, 2]) at.recordSound('cam-1', value);
  for (const value of [1, 3, 5, 7, 9]) at.recordSound('cam-2', value);
  assert.equal(drain(), 2);
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
  assert.equal(drain(), 1);
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
  assert.equal(drain(), 1);
  const r = rowFor('cam-1');
  assert.equal(r.motion_out_level, 0.4);
  assert.equal(r.motion_out_peak, 0.6);
  assert.equal(r.sound_p75, 4);
  assert.equal(r.sound_p90, 12);
  assert.ok(Math.abs(r.sound_sd - Math.sqrt(20.75)) < 1e-9);
});

test('sound percentile and sd are NULL with no sound windows and the motion row survives', () => {
  at.recordMotion('cam-1', 0.3);
  assert.equal(drain(), 1, 'undefined sound bindings would silently drop this whole row');
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
  assert.equal(drain(), 0, 'nothing was recorded, so no row is written');
  at.recordMotion('cam-1', 0);
  drain();
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
    assert.equal(drain(), 1, `${JSON.stringify(v)} was recorded as a real sample`);
    const r = rowFor('cam-1');
    assert.equal(r.motion_frames, 1);
    assert.equal(r.motion_peak, 0, 'it lands as zero motion, i.e. "the room was still"');
    db.prepare('DELETE FROM activity_samples').run();
  }
});

test('KNOWN QUIRK: a numeric string concatenates instead of adding', () => {
  at.recordMotion('cam-1', '5');
  at.recordMotion('cam-1', '5');
  drain();
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 2);
  assert.equal(r.motion_level, 27.5, 'sum was "0"+"5"+"5" = "055", divided by 2 — not 5');
});

// --- flushing ---------------------------------------------------------------------------------

test('a channel with no samples writes NULL, not zero — both directions', () => {
  at.recordMotion('cam-1', 0.3);
  drain();
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
  drain();
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
  drain();
  assert.equal(seen.at(-1).soundPeak, null, 'nothing was heard, and that is not the same as silence');

  at.recordSound('cam-2', 9);
  drain();
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
  assert.equal(drain(), 0, 'no row at all, and the sample is gone');
  assert.equal(rows().length, 0);
});

test('flushActivity writes one row per camera that saw something, and returns the count', () => {
  at.recordMotion('cam-1', 0.1);
  at.recordSound('cam-2', 3);
  assert.equal(drain(), 2);
  assert.deepEqual(rows().map((r) => r.camera_id), ['cam-1', 'cam-2']);
});

test('flushing an empty tracker writes nothing and returns 0', () => {
  assert.equal(drain(), 0);
  assert.equal(rows().length, 0);
});

test('buckets reset after a flush, so a minute is never counted twice', () => {
  at.recordMotion('cam-1', 0.9);
  drain();
  assert.equal(drain(), 0, 'the second flush has nothing left to write');
  assert.equal(rows().length, 1);
});

test('bucket_start is a UTC minute, matching the format sleepAnalysis queries on', () => {
  at.recordMotion('cam-1', 0.1);
  drain();
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
  drain();
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
  drain();
  assert.equal(calls, 1);
  off();
  at.recordMotion('cam-1', 0.1);
  drain();
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
  assert.equal(drain(), 2, 'both rows still written');
  assert.deepEqual(seen.sort(), ['cam-1', 'cam-2'], 'the surviving listener still saw both cameras');
});

// --- #412: the rises in the listener payload ------------------------------------------------------
// The wake watcher anchors a wake clip on the first frame of the minute that was over its threshold. The
// tracker stays threshold-free: it reports, per channel, the samples that RAISED the minute's running peak
// ({ atMs, value } in arrival order), and the watcher applies the thresholds that define `active`. These
// tests pin what the payload carries; wake-watcher.test.js pins what is DONE with it (C1-C2 of the #412 plan).
// Every one reads the payload through the real record*/flushActivity path, with explicit receipt times.
test('#412 C1: the payload keeps its four fields exactly and gains motionRises / soundRises, and nothing else', () => {
  const seen = [];
  listen((e) => seen.push(e));
  at.recordMotion('cam-1', 0.1, null, M + 10_000);
  at.recordMotion('cam-1', 0.3, null, M + 20_000);
  at.recordSound('cam-1', 7, M + 30_000);
  ticks(M, M + MIN + 8000); // past GRACE_MS, so the row is written too
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    cameraId: 'cam-1',
    bucketStart: label(M),
    motionPeak: 0.3,
    soundPeak: 7,
    motionRises: [{ atMs: M + 10_000, value: 0.1 }, { atMs: M + 20_000, value: 0.3 }],
    soundRises: [{ atMs: M + 30_000, value: 7 }],
  });
  // The same peaks the row stores (the old contract, unchanged): the new fields are additive.
  const r = rowFor('cam-1');
  assert.equal(seen[0].motionPeak, r.motion_peak);
  assert.equal(seen[0].soundPeak, r.sound_peak);
});

test('#412 C1: an empty channel is [] (never null or undefined); a sound-only minute keeps motionPeak null', () => {
  const soundOnly = [];
  listen((e) => soundOnly.push(e));
  at.recordSound('cam-1', 9, M + 5000);
  ticks(M, M + MIN + 1000);
  assert.equal(soundOnly.length, 1);
  assert.equal(soundOnly[0].motionPeak, null, 'a channel that saw nothing stays null, exactly as before');
  assert.deepEqual(soundOnly[0].motionRises, []);
  assert.deepEqual(soundOnly[0].soundRises, [{ atMs: M + 5000, value: 9 }]);

  const motionOnly = [];
  listen((e) => motionOnly.push(e));
  at.recordMotion('cam-2', 0.2, null, M + MIN + 5000);
  ticks(M + MIN, M + 2 * MIN + 1000);
  assert.equal(motionOnly.length, 1);
  assert.equal(motionOnly[0].soundPeak, null);
  assert.deepEqual(motionOnly[0].soundRises, []);
  assert.deepEqual(motionOnly[0].motionRises, [{ atMs: M + MIN + 5000, value: 0.2 }]);
});

test('#412 C2: a rise is exactly a sample that raised the running peak: not 0, not an equal value, not a lower one', () => {
  const seen = [];
  listen((e) => seen.push(e));
  // 0 first (the peak starts at 0, 0 is not above it), then 0.2, the same 0.2 again, a lower 0.1, then 0.5.
  [[0, 1], [0.2, 2], [0.2, 3], [0.1, 4], [0.5, 5]].forEach(([v, s]) => at.recordMotion('cam-1', v, null, M + s * 1000));
  [[0, 1], [3, 2], [3, 3], [2, 4], [9, 5]].forEach(([v, s]) => at.recordSound('cam-1', v, M + s * 1000));
  ticks(M, M + MIN + 1000);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].motionRises, [{ atMs: M + 2000, value: 0.2 }, { atMs: M + 5000, value: 0.5 }]);
  assert.deepEqual(seen[0].soundRises, [{ atMs: M + 2000, value: 3 }, { atMs: M + 5000, value: 9 }]);
  assert.equal(seen[0].motionPeak, 0.5);
  assert.equal(seen[0].soundPeak, 9);
});

test('#412 C2: a minute with only zero readings has a peak of 0 and NO rises', () => {
  // The peak is 0, not null (a frame was analysed), and a 0 never "raised" anything.
  const seen = [];
  listen((e) => seen.push(e));
  at.recordMotion('cam-1', 0, null, M + 1000);
  at.recordSound('cam-1', 0, M + 2000);
  ticks(M, M + MIN + 1000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].motionPeak, 0);
  assert.equal(seen[0].soundPeak, 0);
  assert.deepEqual(seen[0].motionRises, []);
  assert.deepEqual(seen[0].soundRises, []);
});

test('#412 C2: recordMotionOut never records a rise (out-of-bed movement cannot start a wake)', () => {
  const seen = [];
  listen((e) => seen.push(e));
  at.recordMotionOut('cam-1', 0.9, null, M + 3000); // before and bigger than the in-bed sample
  at.recordMotion('cam-1', 0.02, null, M + 4000);
  ticks(M, M + MIN + 1000);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].motionRises, [{ atMs: M + 4000, value: 0.02 }], 'the out-of-bed 0.9 is not in the list');
  assert.equal(seen[0].motionPeak, 0.02);
});

test('#412 C2: a non-finite receipt time stores the time actually used for bucketing (Date.now), not NaN', () => {
  // minuteFor falls back to Date.now() for a non-finite atMs; the rise must carry that same time, or the
  // watcher would filter it out of its own minute (NaN) and never see the first frame.
  const seen = [];
  listen((e) => seen.push(e));
  const spy = mock.method(Date, 'now', () => M + 7000);
  try {
    at.recordMotion('cam-1', 0.4, null, NaN);
    at.recordSound('cam-1', 8, Infinity);
  } finally {
    spy.mock.restore();
  }
  ticks(M, M + MIN + 1000);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].motionRises, [{ atMs: M + 7000, value: 0.4 }]);
  assert.deepEqual(seen[0].soundRises, [{ atMs: M + 7000, value: 8 }]);
});

test('#412 C2: the fallback time is read ONCE per sample, so a clock that crosses a minute between two reads cannot split the bucket from the stamp', () => {
  // Each Date.now() call is 1 s later than the one before, starting 0.5 s before the minute's end. Two reads (one
  // to choose the minute, one to stamp the rise) would file the sample under M and stamp it M + 60.5 s, outside
  // its own minute, where wakeWatcher drops it. (Code review, Codex, #412.)
  const seen = [];
  listen((e) => seen.push(e));
  for (const record of [() => at.recordMotion('cam-1', 0.4, null, NaN), () => at.recordSound('cam-1', 8, NaN)]) {
    let n = 0;
    const spy = mock.method(Date, 'now', () => M + 59_500 + 1000 * n++);
    try {
      record();
    } finally {
      spy.mock.restore();
    }
  }
  ticks(M, M + 2 * MIN);
  assert.equal(seen.length, 1, 'both samples were filed under minute M');
  assert.equal(seen[0].bucketStart, label(M));
  assert.deepEqual(seen[0].motionRises, [{ atMs: M + 59_500, value: 0.4 }], 'the stamp is the time the minute was chosen from');
  assert.deepEqual(seen[0].soundRises, [{ atMs: M + 59_500, value: 8 }]);
});

test('#412 C2: a sample clamped into the next minute keeps its own receipt time (the watcher filters by the minute)', () => {
  const seen = [];
  listen((e) => seen.push(e));
  at.recordMotion('cam-1', 0.3, null, M + 10_000);
  ticks(M, M + MIN + 1000); // minute M is told and closed
  at.recordMotion('cam-1', 0.4, null, M + 30_000); // a small backward clock step: filed under the NEXT minute
  at.recordMotion('cam-1', 0.5, null, M + MIN + 20_000);
  assert.equal(at.activityCounters('cam-1').clamped, 1, 'precondition: the first sample was clamped');
  ticks(M + MIN + 2000, M + 2 * MIN + 1000);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].bucketStart, label(M + MIN));
  assert.deepEqual(
    seen[1].motionRises,
    [{ atMs: M + 30_000, value: 0.4 }, { atMs: M + MIN + 20_000, value: 0.5 }],
    'the clamped sample is in the next minute, stamped before it'
  );
});

test('#412 C1: a listener cannot change what another listener (or the slot) sees: the arrays are copies', () => {
  const second = [];
  listen((e) => { e.motionRises.push({ atMs: 0, value: 99 }); e.motionRises[0].value = -1; e.soundRises.length = 0; });
  listen((e) => second.push(e));
  at.recordMotion('cam-1', 0.3, null, M + 10_000);
  at.recordSound('cam-1', 7, M + 11_000);
  ticks(M, M + MIN + 1000);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].motionRises, [{ atMs: M + 10_000, value: 0.3 }]);
  assert.deepEqual(second[0].soundRises, [{ atMs: M + 11_000, value: 7 }]);
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
    // #447 plan, round 2: the flush timer is a REAL 1 s interval here; left running it would tick through
    // the tests after this one, on the real clock, writing their rows behind their backs.
    at.stopActivityTracker();
  }
});

// --- #493: the clone ledger -------------------------------------------------------------------
// ffmpeg's fps=5 fills a camera stall with repeats of the last real frame, and the diff detector reads each
// one as a still room that nobody observed. The observation clock proves which frames were repeats ~5 s
// after the detector counted them; excludeClone takes those back out of the OBSERVED counts. What the
// fixtures below are built to catch, each on purpose:
//   * the peaks, the row-write decision and the minute listener stay on the RAW counts (every fixture
//     that corrects also checks them);
//   * a correction lands once, on the frame and channel it names, and only until its minute's row is written;
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
  assert.equal(drain(), 1);
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
  drain();
  assert.equal(rowFor('cam-1').motion_frames, 2, 'three counted, one repeat, taken out ONCE');
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 0, 'a repeat of a verdict that WAS applied is not "late"');
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
  assert.equal(drain(), 2);
  // created_at is SQLite's own clock: the two inserts can straddle a second.
  const { camera_id: _a, id: _i1, created_at: _c1, ...staged } = rowFor('cam-1');
  const { camera_id: _b, id: _i2, created_at: _c2, ...plain } = rowFor('cam-2');
  assert.deepEqual(staged, plain);
  assert.equal(staged.motion_frames, 4);
});

test('#493: a verdict that arrives after its minute was written changes nothing (and is counted late); the minute takes its staged frames with it', () => {
  at.recordMotion('cam-1', 0, g7(1));
  at.recordMotion('cam-1', 0.5, g7(2)); // it moved: counted, never staged
  assert.equal(at.cloneLedgerSize(), 1, 'only the zero-fraction frame is staged');
  drain();
  assert.equal(at.cloneLedgerSize(), 0, 'the minute was written and took its staged frames with it');
  // The next minute: a frame of the SAME launch.
  at.recordMotion('cam-1', 0, g7(3));
  assert.equal(at.excludeClone('cam-1', 7, 1), false, 'the late verdict for token 1 finds nothing');
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 1, '#447: it was staged, so its lateness is counted');
  assert.equal(at.excludeClone('cam-1', 7, 1), false);
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 1, 'the same late verdict again is counted once');
  assert.equal(at.excludeClone('cam-1', 7, 2), false);
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 1, 'a frame that was never staged is not a late verdict');
  drain();
  const inOrder = db.prepare('SELECT motion_frames FROM activity_samples ORDER BY id').all();
  assert.deepEqual(inOrder.map((r) => r.motion_frames), [2, 1], 'neither the written minute nor the next one moved');
});

test('#493: the ledger holds only open minutes — 300 staged frames, all gone when their minute is written', () => {
  for (let tok = 1; tok <= 300; tok += 1) at.recordMotion('cam-1', 0, g7(tok));
  at.recordMotion('cam-1', 0); // no clock for this one: never staged
  assert.equal(at.cloneLedgerSize(), 300);
  at.excludeClone('cam-1', 7, 150);
  assert.equal(at.cloneLedgerSize(), 299, 'a resolved frame leaves the ledger');
  drain();
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
  drain();
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
  drain();
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
  drain();
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
  drain();
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
    drain();
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
  assert.equal(drain(), 1, 'the row is written: the raw count says frames were analysed');
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

// #447: rows are keyed by the WALL minute each frame was received in (the rig's mono time + WALL0, which puts a
// minute boundary at mono 100_000 + k * 60_000), so a stream that crosses a boundary is stored as two rows. The
// planted accounting, per receipt minute: every counted frame, minus the frames the clock proved were clones
// whose verdict reached the ledger in time (`corrected`, a Set of tokens). Nothing here asks the module.
const minuteOfMono = (mono) => Math.floor((mono + WALL0) / MIN) * MIN;
function plantedRows(w, corrected) {
  const byMinute = new Map();
  for (const c of w.counted) {
    const m = minuteOfMono(c.at);
    if (!byMinute.has(m)) byMinute.set(m, { minuteMs: m, counted: 0, frames: 0, sum: 0, peak: 0, clones: 0 });
    const b = byMinute.get(m);
    b.counted += 1;
    if (corrected.has(c.token)) b.clones += 1;
    else b.frames += 1;
    b.sum += c.fraction;
    if (c.fraction > b.peak) b.peak = c.fraction;
  }
  return [...byMinute.values()].sort((a, b) => a.minuteMs - b.minuteMs);
}
function assertRowsAre(expected, { out = true } = {}) {
  const got = rowsOf('cam-1');
  assert.deepEqual(got.map((r) => r.bucket_start), expected.map((e) => label(e.minuteMs)), 'one row per receipt minute');
  got.forEach((row, i) => {
    const e = expected[i];
    const where = `row ${row.bucket_start}`;
    const mean = (v) => (e.frames ? Math.abs(v - e.sum / e.frames) < 1e-12 : v === null);
    assert.equal(row.motion_frames, e.frames, `${where}: ${e.counted} counted, ${e.clones} proven repeats out`);
    assert.ok(mean(row.motion_level), `${where} level ${row.motion_level}`);
    assert.equal(row.motion_peak, e.peak, `${where}: the peak is the real frames' maximum, untouched`);
    if (out) {
      assert.ok(mean(row.motion_out_level), `${where} out level ${row.motion_out_level}`);
      assert.equal(row.motion_out_peak, e.peak);
    } else {
      assert.equal(row.motion_out_level, null, `${where}: no bed zone, no out-of-bed channel`);
      assert.equal(row.motion_out_peak, null);
    }
  });
}

// Feed `frames`, end the generation, drain once: every verdict has landed before the drain.
function throughClock(frames, opts = {}) {
  const rig = motionRig();
  const w = withLedger(rig, at, { cameraId: 'cam-1', movement, ...opts });
  const s = feedStream(w, frames);
  const last = frames[frames.length - 1].rx;
  s.flush(last + 300);
  w.end(last + 400);
  drain();
  return { rig, w, s, all: new Set(w.verdicts.map((v) => v.token)) };
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

// #447 fix round 1: three minutes of a 3 fps camera (received 30 ms after capture, like steadyFrames) whose input
// pauses ONCE for 1.9 s after input 193 (rig time 164.36 s), so no input arrives between 164.36 s and 166.26 s:
// straddling the 5 s deadline of the last repeat received in the minute that ends at rig time 160 s. Placed by a
// sweep of the gap's start (inputs 192-197) and length (1.5-1.9 s) against the real clock; this one judges that
// repeat at 166.26 s, 6.26 s past its minute's end.
function hiccup3fps() {
  const frames = [];
  let pts = 0;
  for (let i = 0; i < 540; i += 1) {
    if (i === 194) pts += 1900 * 90 - 30_000; // the gap replaces one 1/3 s step
    frames.push({ n: i, pts, rx: 100_000 + pts / 90 + 30 });
    pts += 30_000;
  }
  return frames;
}

test('#493 AC4, the soak-box shape: a 3.06 s stall is a burst of 15 fps clones, and exactly those 15 leave their minute\'s motion_frames and means', () => {
  const r = throughClock(soakStall());
  const clones = truthClones(r.s.truth);
  assert.deepEqual(clones, Array.from({ length: 15 }, (_, i) => 151 + i), 'the planted truth: repeats of frame 150 in slots 151-165');
  // Each output is exactly one stdout sample, in order, so a sample's token IS its output number.
  assert.deepEqual(r.w.verdicts.map((v) => v.token), clones, 'the clock proved exactly those, and nothing else');
  const expected = plantedRows(r.w, r.all);
  // ~63 s of stream from a minute boundary: the burst (~33 s) is in the first minute, the tail in the second.
  assert.deepEqual(expected.map((e) => e.clones), [15, 0], 'all 15 repeats were received in the first minute');
  assertRowsAre(expected);
  const [stall] = rowsOf('cam-1');
  assert.ok(stall.motion_level > expected[0].sum / expected[0].counted, 'taking out zero-valued repeats can only RAISE a mean');
});

for (const fps of [2, 3, 4.5]) {
  test(`#493: a camera genuinely slower than 5 fps (${fps} fps) — fps pads every second with repeats, and exactly those leave the counts`, () => {
    const r = throughClock(steadyFrames({ fps, count: Math.round(fps * 60) }));
    const clones = truthClones(r.s.truth);
    // Planted: at f fps, 5 - f of every 5 output slots per second have no input.
    assert.ok(Math.abs(clones.length / r.s.truth.length - (5 - fps) / 5) < 0.02, `${clones.length} of ${r.s.truth.length}`);
    assert.deepEqual(r.w.verdicts.map((v) => v.token), clones);
    assertRowsAre(plantedRows(r.w, r.all));
  });
}

test('#493: the soak-box stall on a camera with NO bed zone — the repeats leave the in-bed count, and there is still no out-of-bed channel', () => {
  const r = throughClock(soakStall(), { out: false });
  assert.equal(r.w.verdicts.length, 15);
  assertRowsAre(plantedRows(r.w, r.all), { out: false });
});

// ★ #447 FLIPS the #493 "KNOWN LIMIT" test that stood here. Under #493 the minute was written at a flush every
// 60 s, so a repeat counted in a minute's last ~5 s (FINALIZE_MS) got its verdict after the row was stored:
// 8.3% of a steady 3 fps camera's repeats stayed counted, measured on exactly this stream. Now the row waits
// GRACE_MS (7 s) past the minute's end, so on the same stream, ticked every second like the real timer, every
// verdict lands first. The accounting below is the planted rule (a verdict corrects iff it reaches the ledger
// before the tick that writes its minute, at minute end + 7 s); a stream this steady just happens to leave
// nothing late.
// ★ FIX ROUND 1: the first version of this test claimed "any grace under ~5.4 s changes the rows", and the review
// showed that false: on its stream the latest verdict landed only 4.70 s past its minute's end, so a grace of
// 5 s (FINALIZE_MS alone) or 6 s passed it too. The verdict lag is not a guess to be tuned here, it is what the
// real ObservationClock does: a frame is judged at the first input arriving after its 5 s deadline, so the lag
// past receipt is set by the input rate, and the lag past the MINUTE's end also by where in the minute the frame
// arrived. Two streams, each asserting the premise that makes it discriminate (the latest verdict past its
// minute's end, read from the clock's own output), both probed first:
//   * steady 3 fps started 0.5 s later: a repeat received 0.13 s before a minute's end is judged 5.20 s after
//     it. A grace of 5 s writes that row first; kills FINALIZE_MS alone.
//   * the same camera with ONE 1.9 s hiccup in its input, starting 6.26 s after a minute's end: the judgement of
//     that minute's last repeat waits for the video to come back, 6.26 s past the end. Kills a 6 s grace.
for (const { name, frames, beyond } of [
  { name: 'steady 3 fps camera', frames: steadyFrames({ fps: 3, count: 3 * 600, base: 100_500 }), beyond: 5_000 },
  { name: '3 fps camera with one 1.9 s hiccup', frames: hiccup3fps(), beyond: 6_000 },
]) {
  test(`#447: ticked every second, every repeat of a ${name} is corrected — the #493 ~8% miss is gone, and a grace under 7 s would not do it`, () => {
    const rig = motionRig();
    const w = withLedger(rig, at, { cameraId: 'cam-1', movement, flushEveryMs: 1000, flushFrom: 100_000 });
    const s = feedStream(w, frames);
    const last = frames[frames.length - 1].rx;
    s.flush(last + 300);
    w.end(last + 400);
    w.tickTo(last + 70_000); // the timer keeps ticking after the stream: the last minutes close normally
    const counted = new Map(w.counted.map((c) => [c.token, c]));
    // The mono time of the tick that writes a frame's minute: its receipt minute's end + 7 s (planted, a literal).
    const writtenAt = (token) => minuteOfMono(counted.get(token).at) - WALL0 + MIN + 7_000;
    const inTime = new Set(w.verdicts.filter((v) => v.at < writtenAt(v.token)).map((v) => v.token));
    assert.equal(w.verdicts.length, truthClones(s.truth).length, 'every repeat was proven');
    assert.equal(inTime.size, w.verdicts.length, 'every verdict reached the ledger before its minute was written');
    // The premise: some verdict landed more than `beyond` after its minute's end (and, above, all before 7 s).
    const latest = Math.max(...w.verdicts.map((v) => v.at - (writtenAt(v.token) - 7_000)));
    assert.ok(latest > beyond, `latest verdict ${Math.round(latest)} ms past its minute's end, needs > ${beyond}`);
    const expected = plantedRows(w, inTime);
    assert.ok(expected.length >= 3, `minutes of stream: ${expected.length}`);
    assertRowsAre(expected);
    assert.equal(at.activityCounters('cam-1').lateVerdicts, 0);
    // Discrimination, not decoration: under #493's rule (verdict before the minute's END) the steady stream
    // missed 8.3% (5 of every 60 s). Recomputed here from the same verdicts, so the test states what the grace bought.
    const beforeEnd = w.verdicts.filter((v) => v.at < writtenAt(v.token) - 7_000).length;
    const missed = 1 - beforeEnd / w.verdicts.length;
    assert.ok(Math.abs(missed - 5 / 60) < 0.01, `the old rule would have missed ${w.verdicts.length - beforeEnd}`);
  });
}

// The residual #447 does NOT close, pinned as documented (KNOWN-ISSUES.md): a camera that FLAPS. The plan's
// round-1 Opus review: a 3 s stall, 1.5 s of video, then a 20 s stall. The observation clock finalizes a frame
// only when later input arrives, so the first stall's repeats (received ~53 s into the first minute) get their
// verdicts only when video returns ~21 s later, after that minute's row was written at its end + 7 s. They stay
// counted, and lateVerdicts counts them. (Probed first against the real clock: 15 repeats, verdicts 21.4 s
// after receipt.)
function flapping() {
  const frames = [];
  let n = 0;
  const push = (pts) => frames.push({ n: n++, pts, rx: 100_000 + Math.ceil(pts / 90) + 10 });
  let pts = 8000;
  for (let i = 0; i < 251; i += 1) { push(pts); pts += 18000; } // 5 fps to ~50.1 s
  pts += 275_400 - 18000; // a 3.06 s stall
  for (let i = 0; i < 8; i += 1) { push(pts); pts += 18000; } // 1.5 s of video
  pts += 1_800_000 - 18000; // a 20 s stall
  for (let i = 0; i < 150; i += 1) { push(pts); pts += 18000; } // 30 s of video, into the next minute
  return frames;
}

test('#447 KNOWN RESIDUAL: a flapping camera (3 s stall, 1.5 s video, 20 s stall) delivers verdicts after the row — counted as lateVerdicts, left in the row', () => {
  const rig = motionRig();
  const w = withLedger(rig, at, { cameraId: 'cam-1', movement, flushEveryMs: 1000, flushFrom: 100_000 });
  const frames = flapping();
  const s = feedStream(w, frames);
  const last = frames[frames.length - 1].rx;
  s.flush(last + 300);
  w.end(last + 400);
  w.tickTo(last + 70_000);
  const counted = new Map(w.counted.map((c) => [c.token, c]));
  const rowWrittenAt = (token) => minuteOfMono(counted.get(token).at) - WALL0 + MIN + 7_000;
  const late = w.verdicts.filter((v) => v.at >= rowWrittenAt(v.token));
  const inTime = new Set(w.verdicts.filter((v) => v.at < rowWrittenAt(v.token)).map((v) => v.token));
  // The premise, checked: the first stall's burst was proven, received in the first minute, and judged > 20 s later.
  const firstBurst = truthClones(s.truth).filter((k) => counted.get(k).at < 160_000);
  assert.ok(firstBurst.length >= 10, `the first stall made a burst of repeats: ${firstBurst.length}`);
  assert.deepEqual(late.map((v) => v.token), firstBurst, 'exactly the first burst is late');
  assert.ok(late.every((v) => v.at - counted.get(v.token).at > 20_000), 'judged more than 20 s after receipt');
  assert.equal(at.activityCounters('cam-1').lateVerdicts, late.length, 'and every one of them is counted');
  // The second stall's repeats arrive with the video, early in the next minute, and are corrected in time.
  assert.ok(inTime.size > 50, `the second stall's repeats were corrected: ${inTime.size}`);
  assertRowsAre(plantedRows(w, inTime));
});

// --- #447: stamped with the minute a sample was RECEIVED -------------------------------------------------
// Every time below is planted (M = 19:00:00 UTC). The tracker is ticked explicitly with the time a real tick
// would read, never through the wall clock.

test('#447: 19:00:59.9 and 19:01:00.1 land in different rows, whenever and however often the tick runs', () => {
  // Kills the pre-#447 labelling (the flush time) and any tiling that is not the receipt minute.
  for (const tickPlan of [
    () => { at.flushActivity(M + MIN + 7_000); at.flushActivity(M + 2 * MIN + 7_000); }, // on time
    () => { at.flushActivity(M + 10 * MIN); }, // one very late tick
    () => { ticks(M + 60_500, M + 3 * MIN); }, // the 1 s timer's ticks, emulated, phase :.5
  ]) {
    at._resetActivityTrackerForTests();
    db.prepare('DELETE FROM activity_samples').run();
    at.recordMotion('cam-1', 0.1, null, M + 59_900);
    at.recordMotion('cam-1', 0.2, null, M + 60_100);
    tickPlan();
    assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_peak, r.motion_frames]),
      [['2026-09-29 19:00:00', 0.1, 1], ['2026-09-29 19:01:00', 0.2, 1]]);
  }
});

test('#447: a tick three minutes late writes THREE rows, each with its own minute\'s samples, not one blended row', () => {
  at.recordMotion('cam-1', 0.1, null, M + 10_000);
  at.recordMotion('cam-1', 0.2, null, M + 70_000);
  at.recordMotion('cam-1', 0.3, null, M + 130_000);
  assert.equal(at.flushActivity(M + 3 * MIN + 30_000), 3);
  assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_peak]),
    [['2026-09-29 19:00:00', 0.1], ['2026-09-29 19:01:00', 0.2], ['2026-09-29 19:02:00', 0.3]]);
});

test('#447: the same input gives the same rows whatever second the tracker started on', () => {
  // Before #447 the flush phase was the second the process started on, different every boot, and it moved
  // samples between labels. Three phases of the same 1 s timer, the same planted samples: identical rows.
  const samples = [[M + 5_000, 0.1], [M + 59_999, 0.4], [M + 60_000, 0.05], [M + 119_000, 0.2], [M + 121_000, 0.3]];
  const results = [];
  for (const phase of [0, 350, 999]) {
    at._resetActivityTrackerForTests();
    db.prepare('DELETE FROM activity_samples').run();
    let i = 0;
    for (let t = M - 1000 + phase; t <= M + 4 * MIN; t += 1000) {
      while (i < samples.length && samples[i][0] < t) { at.recordMotion('cam-1', samples[i][1], null, samples[i][0]); i += 1; }
      at.flushActivity(t);
    }
    results.push(rowsOf('cam-1').map(({ id: _i, created_at: _c, ...r }) => r));
  }
  assert.equal(results[0].length, 3);
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
});

test('#447: a minute reaches its listener at its END and its row GRACE_MS (7 s) later — not both at once', () => {
  const seen = listenAll();
  at.recordMotion('cam-1', 0.3, null, M + 30_000);
  at.flushActivity(M + 59_999);
  assert.equal(seen.length, 0, 'still receiving: nobody is told yet');
  at.flushActivity(M + 60_000);
  assert.deepEqual(seen.map((e) => [e.bucketStart, e.motionPeak]), [['2026-09-29 19:00:00', 0.3]], 'told at the minute end');
  assert.equal(rows().length, 0, '...before its row exists (the only subscriber reads the payload, never the row)');
  assert.equal(at.flushActivity(M + 66_999), 0, 'not yet: a clone verdict may still be on its way');
  assert.equal(at.flushActivity(M + 67_000), 1, 'written at end + 7 s');
  assert.equal(seen.length, 1, 'and the listener is never called a second time for it');
  assert.equal(rowFor('cam-1').bucket_start, seen[0].bucketStart);
});

test('#447: the running tracker ticks every second — told at the first tick after the minute ends, written at the first one 7 s after', (t) => {
  // The timer itself, not flushActivity: kills a slower FLUSH_TICK_MS. Started on a planted phase (:17.3), so
  // its ticks fall on .3 seconds and neither a 2 s nor a 5 s period lands on the minute's end + 0.3 s.
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: M + 17_300 });
  // ⚠️ Advanced 100 ms at a time: within ONE mock `tick(n)`, every callback it fires reads Date.now() as the
  // END of the whole n (checked with a probe), so one big tick would hand the 19:00:59.3 tick the time 19:01:00.3.
  const advance = (ms) => { for (let done = 0; done < ms; done += 100) t.mock.timers.tick(Math.min(100, ms - done)); };
  const seen = listenAll();
  try {
    at.startActivityTracker();
    advance(10_000);
    at.recordMotion('cam-1', 0.3); // at the (mocked) clock, 19:00:27.3
    advance(59_900 - 27_300 + 300); // to 19:01:00.2: the last tick was 19:00:59.3
    assert.equal(seen.length, 0);
    advance(100); // 19:01:00.3: a tick
    assert.equal(seen.length, 1, 'told within one tick of the minute ending');
    advance(6_000); // 19:01:06.3
    assert.equal(rows().length, 0);
    advance(1_000); // 19:01:07.3
    assert.equal(rows().length, 1, 'written at the first tick 7 s after the minute ended');
  } finally {
    at.stopActivityTracker();
  }
});

test('#447: GRACE is 7 s — a clone verdict 6.5 s after the minute ended still corrects it; one at 7.5 s is late, counted, and changes nothing', () => {
  // Pinned with times either side of 7 s, not 4 s: a grace of 5 s (FINALIZE_MS alone) or 8 s both fail here.
  logger.clear();
  at.recordMotion('cam-1', 0.2, null, M + 30_000);
  at.recordMotion('cam-1', 0, g7(1), M + 59_900);
  at.recordMotion('cam-1', 0, g7(2), M + 59_950);
  ticks(M + 60_000, M + 66_000);
  assert.equal(at.excludeClone('cam-1', 7, 1), true, '19:01:06.5: the row is not written yet, so this corrects it');
  ticks(M + 67_000, M + 67_000);
  assert.equal(rowsOf('cam-1').length, 1, 'written at 19:01:07');
  assert.equal(at.excludeClone('cam-1', 7, 2), false, '19:01:07.5: too late');
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 2, 'three counted, one corrected in the grace, one verdict too late');
  assert.equal(r.motion_level, 0.1);
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 1);
  // Reported once in the `[activity]` line at the next tick, and not again until 15 minutes have passed.
  at.flushActivity(M + 68_000);
  const lines = () => logger.getRecent().filter((l) => l.includes('[activity] cam-1:'));
  assert.equal(lines().length, 1);
  assert.match(lines()[0], /1 clone verdict\(s\) arrived after their minute was stored/);
  at.recordMotion('cam-1', 0, g7(3), M + 70_000);
  ticks(M + 69_000, M + 128_000);
  assert.equal(at.excludeClone('cam-1', 7, 3), false);
  ticks(M + 129_000, M + 60_000 + 15 * MIN - 1_000);
  assert.equal(lines().length, 1, 'rate-limited: at most one line per camera per 15 minutes');
  ticks(M + 68_000 + 15 * MIN, M + 68_000 + 15 * MIN);
  assert.equal(lines().length, 2);
  assert.match(lines()[1], /: 1 clone verdict\(s\)/, 'the new line counts only what is new since the last one');
});

test('#447: staged frames of two minutes live side by side — writing the first prunes ONLY its own; a verdict for the second still corrects it', () => {
  // Kills a whole-ledger clear at a write (the #493 rule, exact only while each camera had one open bucket).
  at.recordMotion('cam-1', 0, g7(1), M + 59_500); // minute 19:00
  at.recordMotion('cam-1', 0, g7(2), M + 60_500); // minute 19:01
  assert.equal(at.cloneLedgerSize(), 2);
  ticks(M + 60_000, M + 67_000);
  assert.equal(rowsOf('cam-1').length, 1, '19:00 is written');
  assert.equal(at.cloneLedgerSize(), 1, '...and took only its own staged frame');
  assert.equal(at.excludeClone('cam-1', 7, 2), true, 'the 19:01 frame is still correctable');
  ticks(M + 68_000, M + 127_000);
  assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_frames]),
    [['2026-09-29 19:00:00', 1], ['2026-09-29 19:01:00', 0]]);
});

test('#447: the late ring is exactly LATE_RING_MINUTES (3) written minutes deep — the 3rd-newest is remembered, the 4th is not', () => {
  // Fix round 1: the bounded-memory test's `ringKeys <= 900` did not bind the depth (its late verdicts drain the
  // ring as they go), so a ring of 4 or 6 minutes survived. One staged frame per minute, 19:00-19:04, all written.
  for (let k = 0; k < 5; k += 1) {
    at.recordMotion('cam-1', 0, g7(k), M + k * MIN + 30_000);
    ticks(M + k * MIN + 31_000, M + (k + 1) * MIN + 30_000);
  }
  ticks(M + 5 * MIN + 31_000, M + 5 * MIN + 31_000);
  assert.equal(rowsOf('cam-1').length, 5);
  assert.equal(at.activityCounters('cam-1').futureClosed, 0, 'an ordinary run of minutes, closed in order');
  assert.equal(at._activityTrackerSizesForTests().ringKeys, 3, 'the keys of 19:02, 19:03 and 19:04');
  assert.equal(at.excludeClone('cam-1', 7, 1), false);
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 0, '19:01 is the 4th-newest written minute: forgotten, not counted');
  assert.equal(at.excludeClone('cam-1', 7, 2), false);
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 1, '19:02 is the 3rd-newest: remembered, counted');
});

test('#447: a verdict applied in the grace, then repeated after the row was written, is not "late" — it was on time the first time', () => {
  // Codex, fix round 1: excludeClone takes a resolved key out of its slot's `keys`; without that the key would be
  // pruned into the late ring with the slot, and the repeat would be counted as a late verdict that never was.
  at.recordMotion('cam-1', 0.2, null, M + 30_000);
  at.recordMotion('cam-1', 0, g7(1), M + 59_000);
  ticks(M + 60_000, M + 62_000);
  assert.equal(at.excludeClone('cam-1', 7, 1), true, 'in the grace: corrected');
  ticks(M + 63_000, M + 67_000);
  assert.equal(rowFor('cam-1').motion_frames, 1, 'written, corrected');
  assert.equal(at.excludeClone('cam-1', 7, 1), false, 'the repeat finds nothing');
  assert.equal(at.activityCounters('cam-1').lateVerdicts, 0);
});

test('#447: a frame\'s two channels given receipt times either side of a boundary — the second is not staged, so no count goes below zero', () => {
  // The detector never does this (one rx.wall per event, detector-observation-wiring.test.js pins it). The
  // tracker still refuses to record a correction against a minute the channel was not counted in.
  at.recordMotion('cam-1', 0, g7(1), M + 59_999);
  at.recordMotionOut('cam-1', 0, g7(1), M + 60_001);
  at.recordMotion('cam-1', 0.3, null, M + 60_002); // so the 19:01 minute has a row to inspect
  assert.equal(at.excludeClone('cam-1', 7, 1), true);
  at.flushActivity(M + 3 * MIN);
  const [first, second] = rowsOf('cam-1');
  assert.equal(first.motion_frames, 0, 'the in-bed count it was staged in is corrected');
  assert.equal(first.motion_out_level, null, 'the 19:00 minute never counted an out-of-bed frame, and still has none');
  assert.equal(first.motion_out_peak, null);
  assert.equal(second.motion_out_level, 0, 'the 19:01 out-of-bed frame stays counted (1 frame, fraction 0)');
});

test('#447: the wall clock steps back 90 s — nothing dropped, no minute written twice, the stragglers counted as clamped', () => {
  logger.clear();
  const seen = listenAll();
  at.recordMotion('cam-1', 0.1, null, M + 30_000);
  ticks(M + 60_000, M + 60_000); // 19:00 closed: told to the listener
  // The clock steps back 90 s (to 18:59:30) and samples keep arriving, stamped with it.
  at.recordMotion('cam-1', 0.2, null, M - 30_000);
  at.recordMotion('cam-1', 0.3, null, M + 20_000);
  assert.equal(at.activityCounters('cam-1').clamped, 2, 'both fell in closed minutes (18:59, 19:00)');
  ticks(M - 29_000, M + 3 * MIN); // the stepped-back clock ticks on
  assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_peak, r.motion_frames]),
    [['2026-09-29 19:00:00', 0.1, 1], ['2026-09-29 19:01:00', 0.3, 2]], 'filed in the next open minute, never re-opening 19:00');
  assert.deepEqual(seen.map((e) => e.bucketStart), ['2026-09-29 19:00:00', '2026-09-29 19:01:00'], 'each minute told once');
  // Neither of the two bigger-step routes ran (fix round 1: with a 1-minute window this step future-closed 19:01
  // and still passed the rows above, because nothing asserted it did not).
  assert.equal(at.activityCounters('cam-1').rebaselined, 0);
  assert.equal(at.activityCounters('cam-1').futureClosed, 0);
  // The `[activity]` line carries the clamped count, not only the late verdicts (fix round 1: dropping `clamped`
  // from reportCounters survived, because every other line-checking test had clamped 0).
  const lines = logger.getRecent().filter((l) => l.includes('[activity] cam-1:'));
  assert.equal(lines.length, 1, `one line: ${lines.join(' | ')}`);
  assert.match(lines[0], /: 0 clone verdict\(s\) .*, 2 sample\(s\) moved to the next minute/);
});

test('#447: the clamp window and the "ahead of the clock" window are each exactly STEP_CLAMP_MS (2 minutes), at both edges', () => {
  // Fix round 1: only a 0 and a 2-hour window were pinned, so 1, 3, 10 and 30 minutes all survived, and so did
  // `<=` -> `<` in minuteFor and `>` -> `>=` in flushActivity. Every time here is planted; nothing is ticked but
  // the calls shown.
  // (1) Backward: 19:02 is told; a sample in 19:00 (2 minutes below it) is clamped, one in 18:59 (3) re-baselines.
  at.recordMotion('cam-1', 0.1, null, M + 2 * MIN + 30_000);
  at.flushActivity(M + 3 * MIN);
  at.recordMotion('cam-1', 0.2, null, M + 59_999);
  assert.deepEqual([at.activityCounters('cam-1').clamped, at.activityCounters('cam-1').rebaselined], [1, 0],
    '19:00 is exactly 120 000 ms below the last closed minute: clamped');
  at.recordMotion('cam-1', 0.3, null, M - 1);
  assert.deepEqual([at.activityCounters('cam-1').clamped, at.activityCounters('cam-1').rebaselined], [1, 1],
    '18:59 is 180 000 ms below: re-baselined');
  // (2) Forward: a minute exactly 120 000 ms ahead of the tick is left alone; 1 ms more and it is closed early.
  at._resetActivityTrackerForTests();
  db.prepare('DELETE FROM activity_samples').run();
  at.recordMotion('cam-1', 0.4, null, M + 2 * MIN + 10_000); // opens 19:02
  at.flushActivity(M);
  assert.equal(at.activityCounters('cam-1').futureClosed, 0, '19:02 is exactly 120 000 ms ahead of 19:00:00: not yet');
  assert.equal(rows().length, 0);
  at.flushActivity(M - 1);
  assert.equal(at.activityCounters('cam-1').futureClosed, 1, '120 001 ms ahead: closed and written at once');
  assert.deepEqual(rowsOf('cam-1').map((r) => r.bucket_start), ['2026-09-29 19:02:00']);
});

test('#447: minutes opened out of order are still closed oldest first, so the last closed minute is the newest', () => {
  // Receipt times normally only move forward, so slots are opened in order; a clock step can open them out of
  // order. Closing in insertion order would leave lastClosed at the OLDER minute, and a sample for the newer one
  // (already told) would then need slot()'s guard to be kept out of it. Pins the sort in flushActivity.
  at.recordMotion('cam-1', 0.2, null, M + MIN + 10_000); // 19:01 opened first
  at.recordMotion('cam-1', 0.1, null, M + 30_000); // then 19:00
  at.flushActivity(M + 2 * MIN); // both end: told, 19:00 then 19:01
  at.recordMotion('cam-1', 0.3, null, M + MIN + 30_000); // a straggler stamped 19:01 (a small step back)
  assert.equal(at.activityCounters('cam-1').clamped, 1, '19:01 is the last closed minute, so this is clamped');
  at.flushActivity(M + 4 * MIN);
  assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_peak]),
    [['2026-09-29 19:00:00', 0.1], ['2026-09-29 19:01:00', 0.2], ['2026-09-29 19:02:00', 0.3]], 'no label twice');
});

test('#447: the wall clock steps back an HOUR — re-baselined, not lumped: each minute keeps its own samples and the watcher is not silenced', () => {
  // Clamping this step would put an hour of samples into one row and tell the wake watcher nothing for the hour
  // (plan review round 2: S = 3600 s). Instead the camera re-baselines, and the repeated hour writes labels that
  // were already written once: duplicate rows, which every reader already OR-merges (sleepAnalysis.test.js "a
  // duplicate activity_samples row for the same minute must not erase real movement", bedTransitionLink.test.js
  // "four duplicate rows for one minute count as one distinct active minute").
  logger.clear();
  const seen = listenAll();
  at.recordMotion('cam-1', 0.1, null, M + 30_000);
  ticks(M + 60_000, M + 60_000);
  const back = M + 60_000 - 3_600_000; // 18:01:00
  at.recordMotion('cam-1', 0.2, null, back + 10_000);
  assert.equal(at.activityCounters('cam-1').rebaselined, 1);
  assert.equal(at.activityCounters('cam-1').clamped, 0);
  assert.ok(logger.getRecent().some((l) => l.includes('[WARN] [activity] cam-1: the wall clock went back 3540s')));
  // Then 5 fps on, with the 1 s tick, from 18:01:10 to the end of 18:02 (fix round 1: one sample per minute let a
  // re-baseline to the step's OWN minute survive; every later sample of that minute would be clamped into the next).
  for (let t = back + 10_200; t < back + 2 * MIN; t += 200) {
    if (t % 1000 === 0) {
      at.flushActivity(t);
      if (t === back + 11_000) {
        // 19:00 was told but still waiting out its grace when the clock stepped: an hour "ahead" of the clock
        // now, so it is written at once rather than an hour from now, and told to nobody a second time.
        assert.deepEqual(rowsOf('cam-1').map((r) => r.bucket_start), ['2026-09-29 19:00:00']);
        assert.equal(at.activityCounters('cam-1').futureClosed, 1);
      }
    }
    at.recordMotion('cam-1', t < back + MIN ? 0.2 : 0.3, null, t);
  }
  ticks(back + 2 * MIN, back + 3 * MIN);
  assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_peak, r.motion_frames]),
    [['2026-09-29 18:01:00', 0.2, 250], ['2026-09-29 18:02:00', 0.3, 300], ['2026-09-29 19:00:00', 0.1, 1]],
    'each minute its own samples (18:01:10-18:01:59.8 = 250, all of 18:02 = 300), none lumped');
  assert.equal(at.activityCounters('cam-1').clamped, 0, 'nothing pushed into a later minute');
  assert.deepEqual(seen.map((e) => e.bucketStart), ['2026-09-29 19:00:00', '2026-09-29 18:01:00', '2026-09-29 18:02:00'],
    'the watcher hears the next minute a minute after the step, not an hour later');
});

// Drive one camera the way production does: a 5 fps sample and a 1 s tick, both reading ONE wall clock, which
// steps back `stepMs` at real time `stepAt`. `phase` = where in each 200 ms the sample falls (ticks are on whole
// seconds, and at the same instant the tick runs first). Planted: `before` is every fraction before the step,
// `after` every fraction after it. Returns how many samples were recorded.
function steppedStream({ from, to, stepAt, stepMs, phase = 0, before = 0.01, after = 0.5 }) {
  let n = 0;
  let clock = from;
  for (let r = from; r <= to; r += 100) {
    clock = r >= stepAt ? r - stepMs : r;
    if (r % 1000 === 0) at.flushActivity(clock);
    if (r % 200 === phase) { at.recordMotion('cam-1', r < stepAt ? before : after, null, clock); n += 1; }
  }
  at.flushActivity(clock + 2 * MIN); // an ordinary late tick: everything left ends, is told, and is written
  return n;
}

// ★ FIX ROUND 1, a real bug found by the #447 adversarial review (Opus, verified by running its probe): a backward
// step of ~125-180 s, landing in the 7 s grace of a minute that had already been TOLD to the listeners, put the
// re-lived minute's samples INTO that told-but-unwritten slot. The row held 600 frames with motion_peak 0.5 while
// the listener had been told motionPeak 0.01 once, so the active re-lived minute never reached the wake watcher.
// Two routes led there, one fixture each: the tick closing a minute found far ahead of the clock (futureClosed)
// and re-baselining BELOW the told minute, and minuteFor re-baselining on a 3-minute step whose next tick
// still sees that told minute less than STEP_CLAMP_MS ahead (so it is not written early). The fixed rule: a
// sample never joins a told minute (slot() writes it out and opens a fresh one). Every oracle below is planted.
for (const { name, stepAt, stepMs, phase, counters } of [
  // 19:04 told at 19:05:00; the step lands at 19:05:00.5, 150 s back: the next samples clamp into 19:05, which is
  // then > 2 min ahead of the tick and closed early, and the camera re-baselined to 19:01 (below 19:04).
  { name: 'via the early close of a minute ahead of the clock', stepAt: M + 5 * MIN + 500, stepMs: 150_000, phase: 0,
    counters: { rebaselined: 0, futureClosed: 1 } },
  // Samples at .1 s: 19:04 told at 19:05:00, the step at 19:05:00.1 reads 19:01:59.9 (180.2 s back, re-baselined),
  // and the next tick reads 19:02:00.8, when 19:04 is 119.2 s ahead: NOT past STEP_CLAMP_MS, so not closed early.
  { name: 'via a re-baseline whose told minute is not far enough ahead to close early', stepAt: M + 5 * MIN + 100,
    stepMs: 180_200, phase: 100, counters: { rebaselined: 1, futureClosed: 0 } },
]) {
  test(`#447 FIX: a backward clock step never adds samples to a minute already told to the listeners — ${name}`, () => {
    const seen = listenAll();
    const n = steppedStream({ from: M + 3 * MIN, to: M + 9 * MIN, stepAt, stepMs, phase });
    const got = rowsOf('cam-1');
    assert.equal(got.reduce((a, r) => a + r.motion_frames, 0), n, 'no sample lost');
    // THE invariant (activityTracker.js, lastClosed): what the listener was told about a minute is what its row holds.
    const key = (b, p) => `${b} ${p}`;
    assert.deepEqual(seen.map((e) => key(e.bucketStart, e.motionPeak)).sort(),
      got.map((r) => key(r.bucket_start, r.motion_peak)).sort(), 'one listener call per row, with that row\'s peak');
    assert.deepEqual(got.filter((r) => r.bucket_start === '2026-09-29 19:04:00').map((r) => [r.motion_peak, r.motion_frames]),
      [[0.01, 300], [0.5, 300]], '19:04 lived twice: two rows of 300, never one of 600');
    assert.ok(seen.some((e) => e.bucketStart === '2026-09-29 19:04:00' && e.motionPeak === 0.5),
      'the active re-lived 19:04 reaches the wake watcher');
    const c = at.activityCounters('cam-1');
    assert.deepEqual({ rebaselined: c.rebaselined, futureClosed: c.futureClosed }, counters, 'the route this fixture takes');
  });
}

test('#447: a forward excursion that comes back cannot strand a minute — it is written at once, and the camera carries on in the present', () => {
  // The clock jumps an hour ahead and back. KNOWN LIMIT (documented): while the clock is ahead, samples ARE
  // filed under the future minutes it reads. What must not happen is a minute opened out there sitting unwritten
  // until the real clock catches up with it, an hour later, holding its staged frames.
  // Two shapes: a future minute still RECEIVING when the clock returns (20:00), and one already told and waiting
  // out its grace (20:30 is told at 20:31:00, ahead; then the clock returns).
  for (const { futureAt, aheadTick, stepsBack } of [
    { futureAt: M + 3_600_000 + 5_000, aheadTick: null, stepsBack: 0 },
    // told at 20:31:00 while ahead, so the first present sample is itself a big backward step (re-baselined)
    { futureAt: M + 5_400_000 + 5_000, aheadTick: M + 5_460_000, stepsBack: 1 },
  ]) {
    at._resetActivityTrackerForTests();
    db.prepare('DELETE FROM activity_samples').run();
    at.recordMotion('cam-1', 0.4, null, futureAt);
    if (aheadTick !== null) at.flushActivity(aheadTick);
    at.recordMotion('cam-1', 0.1, null, M + 20_000); // the clock is back: 19:00:20
    at.flushActivity(M + 21_000);
    const future = label(Math.floor(futureAt / MIN) * MIN);
    assert.equal(at.activityCounters('cam-1').futureClosed, 1, future);
    assert.deepEqual(rowsOf('cam-1').map((r) => r.bucket_start), [future], 'the future minute is written now, not in an hour');
    assert.equal(at._activityTrackerSizesForTests().openSlots, 1, 'only the present minute is still open');
    // Closing the future minute RE-BASELINES the camera to the present, so the next present sample is ordinary:
    // not treated as yet another hour-long backward step (a second warn line, a second re-baseline).
    at.recordMotion('cam-1', 0.05, null, M + 30_000);
    assert.equal(at.activityCounters('cam-1').rebaselined, stepsBack, 'no step is seen that did not happen');
    ticks(M + 22_000, M + 2 * MIN);
    assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_peak, r.motion_frames]),
      [['2026-09-29 19:00:00', 0.1, 2], [future, 0.4, 1]], 'the present minute closes on time, with its own samples');
    assert.equal(at.activityCounters('cam-1').clamped, 0, 'nothing in the present was pushed into a later minute');
  }
});

test('#447: a receipt time that is not a finite number is filed by the clock instead — the minute still closes on a normal tick', () => {
  // A NaN minute would open a slot no tick could ever close (end NaN <= now is false), and label it "NaN-aN".
  for (const bad of [NaN, Infinity, 'x']) {
    at.recordMotion('cam-1', 0.2, null, bad);
  }
  assert.equal(at.flushActivity(Date.now() + 2 * MIN), 1, 'written by an ordinary tick, not only a drain');
  const b = rowFor('cam-1').bucket_start;
  assert.ok(Math.abs(Date.parse(`${b.replace(' ', 'T')}Z`) - Date.now()) < 2 * MIN, `filed near now: ${b}`);
  assert.equal(rowFor('cam-1').motion_frames, 3);
});

test('#447: a receipt time that is not a finite number is filed by the clock for the out-of-bed channel too (minuteFor\'s own fallback)', () => {
  // #412 made recordMotion and recordSound resolve the fallback themselves (once, so the stamp and the minute agree),
  // so minuteFor's `Number.isFinite(atMs) ? atMs : Date.now()` is reached with a bad time only through
  // recordMotionOut, which still passes the raw value. Without that fallback the out-of-bed readings would open a NaN
  // minute no tick can close, and the row's out-of-bed peak would be missing.
  for (const bad of [NaN, Infinity, 'x']) {
    at.recordMotionOut('cam-1', 0.2, null, bad);
  }
  at.recordMotion('cam-1', 0.01); // a finite reading, so the minute has a row to read the out-of-bed columns from
  assert.equal(at.flushActivity(Date.now() + 2 * MIN), 1, 'written by an ordinary tick');
  assert.equal(rowFor('cam-1').motion_out_peak, 0.2, 'the out-of-bed readings were filed under the clock\'s minute');
});

test('#447: a stop writes the minutes that have ENDED (no listener called) and never the one still receiving', () => {
  const seen = listenAll();
  at.recordMotion('cam-1', 0.1, null, M + 30_000); // 19:00, ended by the stop
  at.recordMotion('cam-1', 0.2, null, M + 60_500); // 19:01, still receiving at the stop
  at.flushActivity(M + 60_000); // 19:00 told, waiting out its grace...
  at.stopActivityTracker(M + 62_000); // ...when the process stops (~12% of restarts land in this window)
  assert.deepEqual(rowsOf('cam-1').map((r) => r.bucket_start), ['2026-09-29 19:00:00'], 'the ended minute is not lost');
  // An ended minute the tick had not yet told anyone about: written too, silently (shutdown must not start a capture).
  at._resetActivityTrackerForTests();
  db.prepare('DELETE FROM activity_samples').run();
  at.recordMotion('cam-1', 0.3, null, M + 30_000);
  at.stopActivityTracker(M + 60_400);
  assert.deepEqual(rowsOf('cam-1').map((r) => r.bucket_start), ['2026-09-29 19:00:00']);
  // The exact edge: a stop AT 19:01:00.000 is a stop after 19:00 ended (the same `end <= now` a tick uses), so
  // 19:00 is written. Fix round 1: `>` -> `>=` in the stop's still-receiving test dropped it and survived.
  at._resetActivityTrackerForTests();
  db.prepare('DELETE FROM activity_samples').run();
  at.recordMotion('cam-1', 0.3, null, M + 30_000);
  at.stopActivityTracker(M + 60_000);
  assert.deepEqual(rowsOf('cam-1').map((r) => r.bucket_start), ['2026-09-29 19:00:00'], 'a stop at the minute\'s end writes it');
  assert.equal(seen.length, 1, 'only the first case\'s tick told a listener; the stops told nobody');
});

test('#447: a restart right after a minute ended stores that minute ONCE — the new process cannot write it again', () => {
  // The restart seam the plan's round-2 review corrected: writing ended minutes at stop cannot duplicate, because
  // the next process's first sample is in a later minute by the same clock. (Writing the RECEIVING minute at stop
  // could: a restart inside the same minute would store it twice. The test above pins that it is not written.)
  at.recordMotion('cam-1', 0.1, null, M + 58_000);
  at.stopActivityTracker(M + 61_000);
  at._resetActivityTrackerForTests(); // a new process: nothing in memory
  at.recordMotion('cam-1', 0.2, null, M + 66_000);
  at.flushActivity(M + 2 * MIN + 7_000);
  assert.deepEqual(rowsOf('cam-1').map((r) => [r.bucket_start, r.motion_peak]),
    [['2026-09-29 19:00:00', 0.1], ['2026-09-29 19:01:00', 0.2]], 'no (camera, minute) twice');
});

test('#447: memory stays bounded over three simulated hours of 5 fps staged frames, with verdicts on time, late and never', () => {
  // The ledger holds only unwritten minutes and the late ring only LATE_RING_MINUTES (3) of them per camera.
  // Planted: every frame staged (fraction 0); a quarter are proven 5 s later, a quarter 90 s later and a
  // quarter 150 s later (both after their minute was written: late), a quarter never. A 150 s-late verdict for
  // a frame received after :37 of its minute arrives after its own minute AND the two after it were written, so
  // it is still remembered only by a ring at least 3 minutes deep (a 90 s-late one needs 2).
  const soon = []; // [dueMs, token], due order: each queue is filled in time order
  const late = [];
  const later = [];
  let maxLedger = 0;
  let maxRing = 0;
  let maxOpen = 0;
  let expectedLate = 0;
  let wrongly = 0;
  let token = 0;
  const HOURS = 3;
  for (let t = M; t < M + HOURS * 3_600_000; t += 200) {
    at.recordMotion('cam-1', 0, g7(token), t);
    if (token % 4 === 0) soon.push([t + 5_000, token]);
    if (token % 4 === 1) late.push([t + 90_000, token]);
    if (token % 4 === 2) later.push([t + 150_000, token]);
    token += 1;
    while (soon.length && soon[0][0] <= t) if (!at.excludeClone('cam-1', 7, soon.shift()[1])) wrongly += 1;
    for (const q of [late, later]) {
      while (q.length && q[0][0] <= t) {
        if (at.excludeClone('cam-1', 7, q.shift()[1])) wrongly += 1;
        else expectedLate += 1;
      }
    }
    if (t % 1000 === 0) {
      at.flushActivity(t);
      const sz = at._activityTrackerSizesForTests();
      maxLedger = Math.max(maxLedger, sz.ledger);
      maxRing = Math.max(maxRing, sz.ringKeys);
      maxOpen = Math.max(maxOpen, sz.openSlots);
    }
  }
  assert.equal(wrongly, 0, 'every 5 s verdict corrected its frame, and no 90 s or 150 s verdict did');
  assert.ok(maxOpen <= 2, `open minutes per camera: ${maxOpen}`);
  assert.ok(maxLedger <= 600, `ledger: at most two minutes of 5 fps staged frames, got ${maxLedger}`);
  assert.ok(maxRing <= 3 * 300, `late ring: at most three minutes of keys, got ${maxRing}`);
  assert.ok(expectedLate > 10_000, `the late verdicts were really exercised: ${expectedLate}`);
  assert.equal(at.activityCounters('cam-1').lateVerdicts, expectedLate, 'every one of them was still remembered, and counted');
  assert.equal(rowsOf('cam-1').length, HOURS * 60 - 1, 'one row per minute (the last is still open)');
});
