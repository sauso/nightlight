// Sleep-analysis tests. Run with `npm test` in backend/ — Node's built-in runner, no dependencies.
//
// These cover the paths that REAL DATA CANNOT REACH. Every stored night can be replayed against the
// live database, but no night on record has an early bedtime or an empty bed, so those branches would
// otherwise ship unverified — which is exactly how the first early-bedtime implementation went out
// silently inert (it searched the lookbehind for "the first quiet run", and since an unsampled minute
// counts as quiet, it always matched the start of the data gap instead of a real bedtime).
//
// DATA_DIR is pointed at a throwaway directory BEFORE sleepAnalysis is imported, because db.js opens
// the database at module load. Hence the dynamic import below.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-'));
process.env.DATA_DIR = TMP;

const { computeNight } = await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');

const CHILD = 'test-child';
const CAM = 'test-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge to reason about
const TZ_OFF = 10 * 3600 * 1000;

// A local wall-clock time on the night of DATE (dayShift 1 = the following morning) as a UTC Date.
const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTransition = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)`
);

// One sample per minute across [from, to). Minutes inside an `active` range carry real movement; the
// rest are the near-zero readings a quiet room produces.
function laySamples(from, to, activeRanges = []) {
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    const moving = activeRanges.some(([a, b]) => t >= a && t < b);
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.0002, moving ? 0.6 : 0.0004);
  }
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Test', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Test Cam', 'rtsp://example/stream', ?, 'testcam')`).run(CAM, CHILD);
});

beforeEach(() => {
  db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(CAM);
  db.prepare('DELETE FROM bed_transitions WHERE camera_id = ?').run(CAM);
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('early bedtime: sleep starting before the window is measured from when it started', () => {
  // Put down at 18:38, 52 minutes before the 19:30 window opens; sleeps through, stirs once at 02:00.
  laySamples(at(18, 20), at(7, 0, 1), [[at(2, 0, 1), at(2, 8, 1)]]);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 38)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  // The room is already quiet when the put-down lands, so the settle IS the put-down minute.
  assert.equal(hhmm(night.onset_at), '18:38');
  assert.ok(night.onset_at < night.window_start, 'onset must precede the configured window start');
  // The counted night runs from the real onset to the window end — longer than the 690-minute window.
  const expected = Math.round((at(7, 0, 1).getTime() - new Date(night.onset_at.replace(' ', 'T') + 'Z').getTime()) / 60000);
  assert.equal(night.asleep_minutes + night.awake_minutes, expected);
  assert.ok(expected > 690, 'an early night must count MORE minutes than the window itself');
});

test('early bedtime is ignored without a put-down: a quiet room is not a sleeping child', () => {
  // Identical to the night above, minus the into_bed. Quiet alone must never move onset earlier —
  // this is the guard that stops an empty room reading as an early bedtime.
  laySamples(at(18, 20), at(7, 0, 1), [[at(2, 0, 1), at(2, 8, 1)]]);

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.onset_at), '19:30', 'onset should clamp to the window start');
});

test('a nap the child woke from is not mistaken for the start of the night', () => {
  // Down at 16:45 — deliberately INSIDE the 3h lookbehind, so the nap is a real candidate that guard 2
  // has to reject, rather than one that falls out of range and passes for the wrong reason. Up again at
  // 17:30 (a qualifying awakening before the window), then the real bedtime inside the window. The
  // 02:00 stirring keeps this an ordinary occupied night — without some in-window movement the whole
  // night reads as an empty bed and onset is null, which would fail this assertion for an unrelated reason.
  laySamples(at(16, 0), at(7, 0, 1), [
    [at(17, 30), at(17, 45)],
    [at(19, 0), at(19, 25)],
    [at(2, 0, 1), at(2, 9, 1)],
  ]);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(16, 45)));

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.ok(night.onset_at >= night.window_start, 'the nap must not be adopted as onset');
});

test('early bedtime is ignored when those minutes were never observed', () => {
  // A put-down before the window, but sampling only starts once the window opens — so the "sleep"
  // before it is a data gap, not an observation. Unsampled minutes read as quiet, so without this
  // guard the gap itself would be claimed as sleep.
  laySamples(at(19, 30), at(7, 0, 1), [[at(19, 35), at(19, 42)], [at(2, 0, 1), at(2, 9, 1)]]);
  insertTransition.run(CAM, 'into_bed', 0.5, sqlTime(at(18, 30)));

  const night = computeNight(CHILD, DATE);
  assert.ok(night.onset_at >= night.window_start, 'must not claim sleep across an unsampled stretch');
});

test('empty bed: a night nobody slept in is reported as empty, not as perfect sleep', () => {
  // The regression this exists for: with a child away, this night scored `ok` with 11h06m asleep and
  // zero wake-ups, because an empty room is quiet and quiet reads as sleep.
  laySamples(at(19, 30), at(7, 0, 1), []);

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'empty');
  assert.equal(night.asleep_minutes, null, 'an empty bed must not report a duration');
  assert.equal(night.onset_at, null);
  assert.equal(night.wake_at, null);
  // Distinct from no_data: we DID watch. Coverage proves it, and drives the wording in the UI.
  assert.ok(night.coverage_minutes > 600, 'coverage must survive so empty reads differently from no_data');
});

test('empty bed does not fire for an occupied night', () => {
  // A real child stirs. The quietest occupied night on record still peaked at 0.2883 with one
  // awakening and 10 awake minutes; all three empty-bed conditions must fail here.
  laySamples(at(19, 30), at(7, 0, 1), [
    [at(19, 35), at(19, 42)],
    [at(1, 0, 1), at(1, 9, 1)],
    [at(6, 30, 1), at(7, 0, 1)],
  ]);

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.ok(night.wake_count > 0);
  assert.ok(night.asleep_minutes > 0);
});

test('a night with too few samples is no_data, not empty', () => {
  // Coverage gates confidence and is checked first: "we could not see" must never be reported as
  // "nobody was in the bed".
  laySamples(at(19, 30), at(21, 0), []);

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'no_data');
});
