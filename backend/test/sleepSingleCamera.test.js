// Sleep analysis is scored from ONE camera — the child's main camera — while secondary cameras stay
// fully supported for everything else.
//
// ⚠️ This CANNOT be validated against real data here: both children have exactly one enabled camera, so
// an A/B over every stored night shows zero changed lines and proves nothing. That is precisely why it
// needs tests, and why the important one below makes the SECOND camera noisy: if scoring ever silently
// reverts to merging cameras, that test fails and nothing else would.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-onecam-'));
process.env.DATA_DIR = TMP;

const { computeNight } = await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');

const CHILD = 'onecam-child';
const MAIN = 'cam-main';
const SECOND = 'cam-second';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge to reason about
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;

const insertFull = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows, motion_out_level, motion_out_peak)
   VALUES (?, ?, ?, ?, 0, ?, 1, 1, 0, ?)`
);
const insertTransition = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)`
);
const addCam = (id, name, sortOrder, disabled = 0) =>
  db.prepare(
    `INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
     VALUES (?, ?, 'rtsp://example/x', ?, ?, ?, ?)`
  ).run(id, name, CHILD, id, sortOrder, disabled);

const STILL = 0.004; // quiet, but plainly an occupied bed (see OCCUPANCY_MIN_PEAK)

// One sample per minute for `cam` across [from, to). Ranges in `move`/`noise`/`out` carry real signal.
function lay(cam, from, to, { move = [], noise = [], out = [] } = {}) {
  const within = (t, r) => r.some(([a, b]) => t >= a && t < b);
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    insertFull.run(
      cam, sqlTime(t),
      within(t, move) ? 0.4 : STILL,
      within(t, move) ? 0.4 : STILL,
      within(t, noise) ? 20 : 0.5,
      within(t, out) ? 0.3 : 0.0004
    );
  }
}

// A settled night on `cam`: someone in the room until 19:40, quiet after, up at 06:00.
function quietNightOn(cam) {
  lay(cam, at(18, 20), at(7, 0, 1), { move: [[at(19, 30), at(19, 40)], [at(6, 0, 1), at(6, 20, 1)]] });
  insertTransition.run(cam, 'into_bed', 0.12, sqlTime(at(19, 38)));
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'One Cam Kid', 1, '19:30', '07:00')`).run(CHILD);
});

beforeEach(() => {
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM bed_transitions').run();
  db.prepare('DELETE FROM cameras').run();
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('the night is scored from the main camera and says which one that was', () => {
  addCam(MAIN, 'Cot cam', 0);
  quietNightOn(MAIN);
  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(night.analysis_camera_id, MAIN);
  assert.equal(night.analysis_camera_name, 'Cot cam', 'the detail view needs to name the camera it used');
  assert.equal(hhmm(night.onset_at), '19:40');
});

test('a noisy second camera cannot change the reported night', () => {
  // THE test this file exists for. The second camera is awake all night — pointed at a doorway, or with
  // a zone covering half the room. Under the old cross-camera OR, every one of those minutes counted as
  // activity and the child would be shown thrashing until 03:00 with a wrecked bedtime.
  addCam(MAIN, 'Cot cam', 0);
  addCam(SECOND, 'Doorway cam', 1);
  quietNightOn(MAIN);
  lay(SECOND, at(18, 20), at(7, 0, 1), { move: [[at(20, 0), at(3, 0, 1)]], noise: [[at(20, 0), at(3, 0, 1)]] });

  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'ok');
  assert.equal(night.analysis_camera_id, MAIN);
  assert.equal(hhmm(night.onset_at), '19:40', 'the second camera must not move bedtime');
  // One wake: the child's own 06:00 rise on the MAIN camera. The point is what is absent — the seven
  // hours the second camera spent awake contribute nothing. Merged, those 420 minutes would land as
  // awake time and split the night into a string of wake-ups.
  assert.equal(night.wake_count, 1, 'only the real morning rise, not the second camera');
  assert.ok(night.awake_minutes < 60, `awake_minutes ${night.awake_minutes} — the second camera leaked in`);
});

test('the same night scores identically with the second camera removed', () => {
  // The acceptance condition from ROADMAP 2.6, stated directly: adding a camera must be a no-op for
  // the numbers. Comparing two runs is stronger than asserting fixed values, because it stays true
  // if the thresholds are ever retuned.
  addCam(MAIN, 'Cot cam', 0);
  quietNightOn(MAIN);
  const alone = computeNight(CHILD, DATE);

  addCam(SECOND, 'Doorway cam', 1);
  lay(SECOND, at(18, 20), at(7, 0, 1), { move: [[at(20, 0), at(3, 0, 1)]] });
  const withSecond = computeNight(CHILD, DATE);

  for (const k of ['status', 'onset_at', 'wake_at', 'asleep_minutes', 'awake_minutes', 'wake_count',
    'longest_stretch_minutes']) {
    assert.deepEqual(withSecond[k], alone[k], `${k} changed when a second camera was added`);
  }
});

test('the main camera is the lowest sort_order, not whichever was added first', () => {
  // sort_order is the order the user arranged in the UI, so it is their statement of which camera is
  // the important one. Insert the secondary FIRST so an id/rowid-ordered query would pick the wrong one.
  addCam(SECOND, 'Doorway cam', 5);
  addCam(MAIN, 'Cot cam', 1);
  quietNightOn(MAIN);
  lay(SECOND, at(18, 20), at(7, 0, 1), { move: [[at(20, 0), at(3, 0, 1)]] });

  const night = computeNight(CHILD, DATE);
  assert.equal(night.analysis_camera_name, 'Cot cam');
  assert.equal(hhmm(night.onset_at), '19:40');
});

test('a disabled camera is never scored from, even if it sorts first', () => {
  // Regression for a quieter bug the old code had: it selected the child's cameras with no `disabled`
  // filter at all, so a disabled camera's historical samples were still merged into the analysis.
  addCam(SECOND, 'Old cam', 0, 1); // disabled, but sorts ahead of the main one
  addCam(MAIN, 'Cot cam', 1);
  quietNightOn(MAIN);
  lay(SECOND, at(18, 20), at(7, 0, 1), { move: [[at(20, 0), at(3, 0, 1)]] });

  const night = computeNight(CHILD, DATE);
  assert.equal(night.analysis_camera_name, 'Cot cam', 'a disabled camera must not be the main one');
  assert.equal(hhmm(night.onset_at), '19:40', 'nor contribute its samples');
});

test('bed transitions come from the main camera only', () => {
  // Transitions are per-camera and the detector's state is per-camera, so two cameras can emit
  // contradictory pairs for one event. A put-down the secondary camera thinks it saw at 22:00 must not
  // become the night's bedtime.
  addCam(MAIN, 'Cot cam', 0);
  addCam(SECOND, 'Doorway cam', 1);
  quietNightOn(MAIN);
  lay(SECOND, at(18, 20), at(7, 0, 1));
  insertTransition.run(SECOND, 'into_bed', 0.5, sqlTime(at(22, 0)));
  insertTransition.run(SECOND, 'out_of_bed', 0.5, sqlTime(at(23, 0)));

  const night = computeNight(CHILD, DATE);
  assert.equal(hhmm(night.onset_at), '19:40', 'the secondary camera’s transitions must be ignored');
});

test('a child whose only camera is disabled reports no_data, not a night', () => {
  addCam(MAIN, 'Cot cam', 0, 1);
  quietNightOn(MAIN);
  const night = computeNight(CHILD, DATE);
  assert.equal(night.status, 'no_data');
  assert.equal(night.analysis_camera_id, null);
});

test('room climate still reads every camera, including the secondary', () => {
  // The deliberate exception. Climate AVERAGES its sensors, and an average cannot be dragged the way an
  // OR can — so two sensors in one room is better information, not a hazard. 18C and 22C must give 20C.
  addCam(MAIN, 'Cot cam', 0);
  addCam(SECOND, 'Doorway cam', 1);
  quietNightOn(MAIN);
  lay(SECOND, at(18, 20), at(7, 0, 1));
  const insertReading = db.prepare(
    `INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, ?, ?, ?)`);
  insertReading.run(MAIN, 18, 40, sqlTime(at(22, 0)));
  insertReading.run(SECOND, 22, 60, sqlTime(at(22, 1)));

  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.equal(night.climate.temp_avg, 20, 'both sensors must be averaged');
  assert.equal(night.climate.temp_samples, 2);
});
