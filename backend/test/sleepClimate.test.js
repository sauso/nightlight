// Overnight room climate: the summary that lands on every stored night, and the 5-minute series behind
// the chart on the night detail view. Reached only through computeNight, since nightClimate is internal.
//
// Worth testing rather than trusting: the series is a downsample that averages ACROSS cameras, so a bug
// here doesn't throw or blank the chart — it draws a plausible-looking line that is simply wrong, and
// the stored avg_temperature it sits beside is what sleepInsights later correlates against.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-climate-'));
process.env.DATA_DIR = TMP;

const { computeNight } = await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');

const CHILD = 'climate-child';
const CAM = 'climate-cam';
const CAM2 = 'climate-cam-2';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge to reason about
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, 0.004, 0.004, 0, 0, 1, 0)`
);
const insertReading = db.prepare(
  `INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, ?, ?, ?)`
);

// Enough of a night for computeNight to return 'ok' rather than 'no_data'.
function layQuietNight(cams = [CAM]) {
  for (let t = at(19, 0); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    for (const c of cams) insertSample.run(c, sqlTime(t));
  }
}

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Climate Kid', 1, '19:00', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Cam', 'rtsp://example/a', ?, 'a')`).run(CAM, CHILD);
});

beforeEach(() => {
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM sensor_readings').run();
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM2);
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a night with no sensor at all simply has no climate', () => {
  layQuietNight();
  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  // nightClimate returns null outright rather than a summary full of zeroes — a made-up 0C would be
  // stored as avg_temperature and then correlated against by sleepInsights as if it were measured.
  assert.equal(night.climate, null, 'a child without a sensor must have no climate at all');
});

test('temperature is summarised as average, min and max over the night', () => {
  layQuietNight();
  for (const [h, temp, hum] of [[20, 18, 50], [23, 22, 60], [3, 20, 55]]) {
    insertReading.run(CAM, temp, hum, sqlTime(at(h, 0, h < 12 ? 1 : 0)));
  }
  const night = computeNight(CHILD, DATE, { includeTimeline: true });
  const c = night.climate;
  assert.ok(c, 'climate must be present once a sensor has reported');
  assert.equal(c.temp_min, 18);
  assert.equal(c.temp_max, 22);
  assert.equal(c.temp_avg, 20, '(18 + 22 + 20) / 3');
  assert.equal(c.temp_samples, 3);
  assert.equal(c.humidity_avg, 55, 'humidity is rounded to a whole percent');
});

test('readings outside the night window are not counted', () => {
  layQuietNight();
  insertReading.run(CAM, 20, 50, sqlTime(at(23, 0)));      // inside
  insertReading.run(CAM, 40, 90, sqlTime(at(12, 0)));      // midday before the window opened
  insertReading.run(CAM, 40, 90, sqlTime(at(12, 0, 1)));   // midday after it closed
  const c = computeNight(CHILD, DATE, { includeTimeline: true }).climate;
  assert.equal(c.temp_samples, 1, 'only the in-window reading counts');
  assert.equal(c.temp_max, 20, 'the daytime 40C must not become the night maximum');
});

test('a sensor reporting temperature but not humidity gives one without the other', () => {
  // Real hardware does this. Humidity must come back as absent, not as zero — a stored 0% would then be
  // averaged into sleepInsights as a real reading.
  layQuietNight();
  insertReading.run(CAM, 21, null, sqlTime(at(22, 0)));
  const c = computeNight(CHILD, DATE, { includeTimeline: true }).climate;
  assert.equal(c.temp_avg, 21);
  assert.equal(c.humidity_avg, null, 'no humidity readings must give null, never 0');
  assert.equal(c.humidity_samples, 0);
});

test('the chart series is bucketed to five minutes, not one point per reading', () => {
  // Six readings inside one 5-minute bucket must collapse to a single averaged point, or a chatty
  // sensor draws a denser, noisier line than a quiet one for no reason.
  layQuietNight();
  for (let i = 0; i < 6; i++) insertReading.run(CAM, 20 + i, 50, sqlTime(new Date(at(22, 0).getTime() + i * 30000)));
  const s = computeNight(CHILD, DATE, { includeTimeline: true }).climate.series;
  assert.equal(s.length, 1, 'six readings in one bucket is one point');
  assert.equal(s[0].temperature, 22.5, 'and it is their average: (20+21+22+23+24+25)/6');
});

test('the series is ordered in time regardless of insert order', () => {
  layQuietNight();
  for (const h of [3, 21, 23]) insertReading.run(CAM, 20, 50, sqlTime(at(h, 0, h < 12 ? 1 : 0)));
  const s = computeNight(CHILD, DATE, { includeTimeline: true }).climate.series;
  assert.equal(s.length, 3);
  assert.deepEqual([...s].map((p) => p.t).sort(), s.map((p) => p.t), 'series must already be sorted');
});

test('two sensors in one room average into a single line', () => {
  // The reason the series averages across cameras rather than concatenating: two sensors would
  // otherwise draw a line zig-zagging between the two rooms' temperatures.
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Cam2', 'rtsp://example/b', ?, 'b')`).run(CAM2, CHILD);
  layQuietNight([CAM, CAM2]);
  insertReading.run(CAM, 18, 40, sqlTime(at(22, 0)));
  insertReading.run(CAM2, 22, 60, sqlTime(at(22, 1))); // same 5-min bucket
  const s = computeNight(CHILD, DATE, { includeTimeline: true }).climate.series;
  assert.equal(s.length, 1, 'both sensors land in one bucket');
  assert.equal(s[0].temperature, 20, 'averaged, not zig-zagged');
  assert.equal(s[0].humidity, 50);
});

test('the series is only built when the timeline is asked for', () => {
  // The nightly job stores the summary for every child every night; building and discarding a series
  // there would be pure work. The summary must still be present either way.
  layQuietNight();
  insertReading.run(CAM, 20, 50, sqlTime(at(22, 0)));
  const stored = computeNight(CHILD, DATE);
  assert.equal(stored.climate.series, undefined, 'no series without includeTimeline');
  assert.equal(stored.climate.temp_avg, 20, 'but the summary is always there');
});
