// A Nightlight Camera's heart rate and breathing rate on a night's card and timeline (lib/cameraVitals.js through
// lib/nightVitals.js). DISPLAY ONLY: nothing here may reach a stored night; that is pinned for the existing sources by
// nightVitals.test.js and unchanged.
//
// What is pinned, each with the one-line mutation that makes it fail (run in a scratch copy, named in the PR):
//   - the minute rule: heart rate needs 3 updates, breathing needs 6 (the ESPHome 30, scaled to a 5 s read), the 1.0
//     breathing placeholder, the 1 m distance cut with its "no distance row keeps the minute" choice;
//   - whose rows: this child's cameras only, only the three radar metrics (a hostile fixture plants a recognisable value in
//     every other metric), only the asked range, history kept after the camera's sensors were switched off;
//   - two sources on one child are averaged per minute; a camera adds nothing when it has no valid minute;
//   - `simulated` appears only when a USED minute was flagged, and an answer without a simulated camera has no such key.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { nightVitals, withNightVitals, resetNightVitalsLogForTest } = await import('../src/lib/nightVitals.js');
const { CAMERA_RR_MIN_N } = await import('../src/lib/cameraVitals.js');

const MIN = 60000;
const T0 = Date.UTC(2026, 6, 1, 22, 0);
const NOW = T0 + 24 * 60 * MIN;
const at = (m) => T0 + m * MIN;
const bucket = (m) => Math.floor(at(m) / MIN);
const CHILD = 'cv-child';
const OTHER = 'cv-other';
const CAM = 'cv-cam';

const putRow = db.prepare(
  `INSERT OR REPLACE INTO nlcam_readings (camera_id, bucket, metric, n, mean, min, max, last, simulated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
// One camera row for minute offset `m`: `n` samples averaging `mean`.
const row = (camera, m, metric, n, mean, simulated = 0) => putRow.run(camera, bucket(m), metric, n, mean, mean, mean, mean, simulated);
const hr = (m, mean, n = 8, sim = 0, camera = CAM) => row(camera, m, 'heart_rate', n, mean, sim);
const rr = (m, mean, n = 8, sim = 0, camera = CAM) => row(camera, m, 'breathing_rate', n, mean, sim);
const dist = (m, mean, n = 8, camera = CAM) => row(camera, m, 'distance_cm', n, mean);
const run = (over = {}, from = 0, to = 60) => nightVitals(CHILD, at(from), at(to), { nowMs: NOW, ...over });
const addCamera = (id, childId) => db.prepare(
  `INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sensor_source) VALUES (?, ?, 'rtsp://u:p@192.168.3.9/m', ?, ?, 'nightlight-api')`
).run(id, id, childId, `p_${id}`);

before(() => {
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Camera Kid', 1)").run(CHILD);
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(OTHER);
});
beforeEach(() => {
  db.prepare('DELETE FROM nlcam_readings').run();
  db.prepare('DELETE FROM cameras').run();
  for (const t of ['esphome_readings', 'esphome_entities', 'esphome_devices']) db.prepare(`DELETE FROM ${t}`).run();
  addCamera(CAM, CHILD);
  resetNightVitalsLogForTest();
});
after(() => { db.close(); cleanupTempDataDirs(); });

test('heart rate: a minute needs at least 3 samples (2 is excluded, 3 counts); the figures are whole numbers', () => {
  // Kills: the minimum moved to `>` or dropped.
  hr(0, 100, 2);
  hr(1, 80.4, 3);
  hr(2, 90.6, 12);
  assert.deepEqual(run().hr, { avg: 86, min: 80, max: 91, minutes: 2 });
  assert.equal(run().rr, null);
});

test('breathing: a minute needs at least 6 samples, the ESPHome 30 scaled to the camera’s 5 s read (5 is excluded, 6 counts)', () => {
  // Kills: the minimum moved to `>`, dropped, or left at the ESPHome 30 (which a 5 s read can never reach).
  assert.equal(CAMERA_RR_MIN_N, 6);
  rr(0, 20, 5);
  rr(1, 18, 6);
  hr(5, 80);
  assert.deepEqual(run().rr, { avg: 18, min: 18, max: 18, minutes: 1 });
  rr(2, 22, 12); // a full 5 s minute is plainly measured
  assert.equal(run().rr.minutes, 2);
});

test('breathing: the 1.0 placeholder and a zero are not breaths; 2.0 is the first mean that counts', () => {
  rr(0, 1.0);
  rr(1, 0);
  rr(2, 1.99);
  rr(3, 2.0);
  hr(5, 80);
  assert.deepEqual(run().rr, { avg: 2, min: 2, max: 2, minutes: 1 });
});

test('the 1 m distance cut: 100 cm stays, 101 cm goes, for heart rate and breathing alike; no distance row keeps the minute', () => {
  hr(0, 70); dist(0, 100);
  hr(1, 90); dist(1, 101);
  rr(2, 20); dist(2, 101);
  rr(3, 22); dist(3, 100);
  hr(4, 80); // no distance row at all
  const v = run();
  assert.deepEqual([v.hr.minutes, v.hr.avg], [2, 75]);
  assert.deepEqual([v.rr.minutes, v.rr.avg], [1, 22]);
});

test('only heart rate, breathing rate and distance are read: a recognisable value in every other metric never appears', () => {
  // Hostile fixture: a valid-looking row for every metric the poller stores that the rule must NOT read.
  for (const metric of ['presence', 'light_lux', 'pad_occupied', 'pad_level', 'pad_weight_kg', 'temperature', 'humidity']) row(CAM, 3, metric, 12, 4242);
  assert.equal(run(), null, 'no heart or breathing row: nothing to show');
  hr(4, 77);
  const v = run();
  assert.deepEqual(v.hr, { avg: 77, min: 77, max: 77, minutes: 1 });
  assert.equal(JSON.stringify(v).includes('4242'), false);
});

test('a distance row alone is not a vital sign: null', () => {
  dist(0, 50);
  assert.equal(run(), null);
});

test('only this child’s cameras, and only the asked range', () => {
  addCamera('cv-other-cam', OTHER);
  db.prepare("INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES ('cv-free', 'free', 'rtsp://u:p@192.168.3.8/m', NULL, 'p_free')").run();
  hr(1, 999, 8, 0, 'cv-other-cam');
  hr(2, 888, 8, 0, 'cv-free');
  hr(3, 70);
  hr(-5, 777); // before the range
  hr(61, 666); // after it
  assert.deepEqual(run().hr, { avg: 70, min: 70, max: 70, minutes: 1 });
});

test('a camera whose sensors were switched off keeps its history on the night it was recorded for', () => {
  hr(3, 70);
  db.prepare("UPDATE cameras SET sensor_source = NULL WHERE id = ?").run(CAM);
  assert.equal(run().hr.minutes, 1);
});

test('a camera moved to another child takes its rows with it', () => {
  hr(3, 70);
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(OTHER, CAM);
  assert.equal(run(), null);
});

test('two cameras on one child are averaged per minute; a camera without a valid row adds nothing', () => {
  addCamera('cv-cam-2', CHILD);
  hr(3, 60);
  hr(3, 80, 8, 0, 'cv-cam-2');
  hr(4, 70);
  hr(4, 200, 1, 0, 'cv-cam-2'); // too few samples: not counted
  // Minute 3 is (60 + 80) / 2 = 70, minute 4 is 70 (the second camera's one sample does not count): not 60 and 70.
  assert.deepEqual(run().hr, { avg: 70, min: 70, max: 70, minutes: 2 });
});

test('a camera and an ESPHome sensor on the same child are averaged per minute', () => {
  const device = db.prepare("INSERT INTO esphome_devices (name, host, child_id) VALUES ('s', '192.0.2.10', ?)").run(CHILD).lastInsertRowid;
  const entity = db.prepare(
    `INSERT INTO esphome_entities (device_id, object_id, child_id, kind, name, device_class, unit, active)
     VALUES (?, 'heart_rate', ?, 'sensor', 'Heart Rate', NULL, 'bpm', 1)`
  ).run(device, CHILD).lastInsertRowid;
  db.prepare(
    'INSERT INTO esphome_readings (entity_id, bucket, last, mean, min, max, n, nzero, nmiss) VALUES (?, ?, 100, 100, 100, 100, 10, 0, 0)'
  ).run(entity, bucket(3));
  hr(3, 80);
  assert.deepEqual(run().hr, { avg: 90, min: 90, max: 90, minutes: 1 });
  // ESPHome alone is exactly as it was: no `simulated` key.
  db.prepare('DELETE FROM nlcam_readings').run();
  const alone = run();
  assert.deepEqual(alone.hr, { avg: 100, min: 100, max: 100, minutes: 1 });
  assert.equal('simulated' in alone, false);
});

test('simulated appears only when a used minute was flagged; a real camera, a flagged minute that is not used, or no camera adds nothing', () => {
  hr(3, 70);
  assert.equal('simulated' in run(), false, 'a real camera');
  hr(4, 80, 8, 1);
  assert.equal(run().simulated, true, 'a used simulated minute');
  db.prepare('DELETE FROM nlcam_readings').run();
  hr(3, 70);
  hr(4, 90, 1, 1); // simulated but too few samples to be used
  assert.equal('simulated' in run(), false, 'an unused flagged minute does not label the night');
  rr(5, 20, 8, 1);
  assert.equal(run().simulated, true, 'breathing counts too');
});

test('the series and summary come from camera minutes like any other source', () => {
  for (let m = 0; m < 10; m++) { hr(m, 70 + m); rr(m, 20); }
  const v = run({ series: true });
  assert.deepEqual(v.hr, { avg: 75, min: 70, max: 79, minutes: 10 });
  assert.equal(v.series.length, 2, 'two 5-minute buckets on the UTC clock');
  assert.deepEqual(v.series.map((p) => p.rr), [20, 20]);
  const narrow = run({ series: true, summaryFromMs: at(5), summaryToMs: at(10) });
  assert.deepEqual(narrow.hr, { avg: 77, min: 75, max: 79, minutes: 5 });
  assert.equal(narrow.series.length, 2, 'the series still covers the range');
});

test('a minute whose row is not written yet at the clock is not read', () => {
  hr(3, 70);
  assert.equal(run({ nowMs: at(3) }), null, 'the minute has not finished at its own start');
  assert.equal(run({ nowMs: at(4) + 1000 }).hr.minutes, 1);
});

test('withNightVitals attaches a simulated camera’s vitals to an ok night, flagged, and changes nothing else', () => {
  hr(3, 70, 8, 1);
  const night = { status: 'ok', window_start: '2026-07-01 22:00:00', window_end: '2026-07-01 23:00:00', onset_at: '2026-07-01 22:00:00', wake_at: '2026-07-01 23:00:00' };
  const frozen = JSON.stringify(night);
  const out = withNightVitals(CHILD, night, { nowMs: NOW });
  assert.equal(JSON.stringify(night), frozen, 'the input is not mutated');
  assert.equal(out.vitals.simulated, true);
  assert.deepEqual(out.vitals.hr, { avg: 70, min: 70, max: 70, minutes: 1 });
  const { vitals, ...rest } = out;
  assert.deepEqual(rest, night, 'every other key of the night is exactly what it was');
});

test('reads only: no row of any table changes', () => {
  hr(3, 70);
  const before = JSON.stringify(db.prepare('SELECT * FROM nlcam_readings ORDER BY bucket, metric').all());
  run({ series: true });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM nlcam_readings ORDER BY bucket, metric').all()), before);
});
