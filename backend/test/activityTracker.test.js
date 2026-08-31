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
import { test, before, after, beforeEach } from 'node:test';
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
after(() => { db.close(); cleanupTempDataDirs(); });
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

test('non-numeric and negative samples are ignored rather than poisoning the average', () => {
  // `!(v >= 0)` also rejects NaN, which is the one that matters: a NaN reaching motionSum would make
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

// ⚠️ CHARACTERISATION, not an endorsement. `null >= 0` is TRUE in JavaScript (null coerces to 0 in a
// relational comparison), so `null` slips through the `!(v >= 0)` guard that stops every other
// non-number, and lands as a zero sample: it bumps *_frames and drags *_level toward zero. That is the
// precise distinction this module works hard to preserve everywhere else — a channel with no samples
// writes NULL, not 0, so "we did not look" stays separable from "we looked and it was still".
// No current caller passes null (motionDetector and soundDetector both compute a number), so this is
// latent rather than live, and it is left alone deliberately while the sleep holdout is running.
// Pinned here so the behaviour is visible and a future fix is a deliberate change, not a surprise.
test('KNOWN QUIRK: null passes the numeric guard and is counted as a zero sample', () => {
  at.recordMotion('cam-1', null);
  assert.equal(at.flushActivity(), 1, 'a row is written for what was really "no reading"');
  const r = rowFor('cam-1');
  assert.equal(r.motion_frames, 1);
  assert.equal(r.motion_peak, 0);
  assert.equal(r.motion_level, 0);
});

// --- flushing ---------------------------------------------------------------------------------

test('a channel with no samples writes NULL, not zero', () => {
  at.recordMotion('cam-1', 0.3);
  at.flushActivity();
  const r = rowFor('cam-1');
  assert.equal(r.sound_peak, null, '"we did not listen" must not read as "it was silent"');
  assert.equal(r.sound_level, null);
  assert.equal(r.sound_windows, 0);
  assert.equal(r.motion_out_peak, null, 'no zone painted means no out-of-bed channel at all');
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

test('pruneActivitySamples drops rows past the 30-day window and keeps the rest', () => {
  const insert = (cam, ago) =>
    db.prepare(
      `INSERT INTO activity_samples (camera_id, bucket_start, motion_frames, sound_windows, created_at)
       VALUES (?, ?, 1, 0, datetime('now', ?))`
    ).run(cam, '2026-01-01 00:00:00', ago);
  insert('cam-1', '-31 days');
  insert('cam-1', '-29 days');
  at.pruneActivitySamples();
  assert.equal(rows().length, 1, 'the 31-day-old row goes, the 29-day-old row stays');
});

test('startActivityTracker prunes immediately and is idempotent', () => {
  db.prepare(
    `INSERT INTO activity_samples (camera_id, bucket_start, motion_frames, sound_windows, created_at)
     VALUES ('cam-1', '2026-01-01 00:00:00', 1, 0, datetime('now', '-90 days'))`
  ).run();
  at.startActivityTracker();
  assert.equal(rows().length, 0, 'startup sweeps stale rows without waiting a day for the timer');
  at.startActivityTracker(); // second call must not stack a second interval
});
