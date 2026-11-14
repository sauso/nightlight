// lib/nightVitals.js: heart rate and breathing over a night, for display only (owner request 2026-11-14).
//
// What is pinned here, each with the mutation that makes it fail (verified in a scratch copy, named in the build report):
//   - the minute rules are the SAME as the sleep sensor shadow's (lib/sleepSensor.js validHrMinute / validRrMinute): the
//     update-count minimums at their boundary, the breathing placeholder, the 1 m cut and its unit contract;
//   - whose rows count: this child's, every entity ever (retired ones too), devices averaged per minute, a device
//     without a valid row adds nothing, a child with no heart/breathing entity gets null;
//   - the 5-minute series (grid, rounding, a gap is a missing point) and the summary window (narrower than the range);
//   - the replay clock (a minute whose row is not written yet is not read) and the bounds (whole minutes, never throws);
//   - withNightVitals: the same object back when there is nothing to add, never mutated, never throws.
//
// DATA_DIR is pointed at a throwaway directory BEFORE anything imports db.js (it opens the database at module load).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { nightVitals, withNightVitals, resetNightVitalsLogForTest } = await import('../src/lib/nightVitals.js');
const { logger } = await import('../src/lib/logger.js');

const MIN = 60000;
// A whole UTC minute well in the past, so every minute of the fixtures is readable at the default clock.
const T0 = Date.UTC(2026, 6, 1, 22, 0);
const NOW = T0 + 24 * 60 * MIN;
const at = (m) => T0 + m * MIN;
const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const CHILD = 'nv-child';
const OTHER = 'nv-other';

const putRow = db.prepare(
  'INSERT OR REPLACE INTO esphome_readings (entity_id, bucket, last, mean, min, max, n, nzero, nmiss) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)'
);
let devSeq = 0;
const addEntity = (device, childId, objectId, name, deviceClass, unit, active = 1) => db.prepare(
  `INSERT INTO esphome_entities (device_id, object_id, child_id, kind, name, device_class, unit, active)
   VALUES (?, ?, ?, 'sensor', ?, ?, ?, ?)`
).run(device, objectId, childId, name, deviceClass, unit, active).lastInsertRowid;
// A radar sensor as the measured ones report it: heart rate, breathing rate and distance in `unit`.
function addDevice(childId, { unit = 'cm', distance = true, active = 1 } = {}) {
  const device = db.prepare("INSERT INTO esphome_devices (name, host, child_id) VALUES (?, '192.0.2.10', ?)")
    .run(`sensor ${++devSeq}`, childId).lastInsertRowid;
  return {
    device,
    hr: addEntity(device, childId, 'heart_rate', 'Heart Rate', null, 'bpm', active),
    rr: addEntity(device, childId, 'respiratory_rate', 'Respiratory Rate', null, null, active),
    dist: distance ? addEntity(device, childId, 'distance', 'Distance', 'distance', unit, active) : null,
    lux: addEntity(device, childId, 'illuminance', 'Illuminance', 'illuminance', 'lx', active),
  };
}
// One entity's row for minute offset `m` (from T0): `n` non-zero updates averaging `mean` (a zero row: n 0, mean null).
const row = (entity, m, n, mean) => putRow.run(entity, Math.floor(at(m) / MIN), n > 0 ? mean : 0, n > 0 ? mean : null, n > 0 ? mean : null, n > 0 ? mean : null, n);
const hr = (d, m, mean, n = 10) => row(d.hr, m, n, mean);
const rr = (d, m, mean, n = 40) => row(d.rr, m, n, mean);
const dist = (d, m, mean, n = 10) => row(d.dist, m, n, mean);
const run = (over = {}, from = 0, to = 60) => nightVitals(CHILD, at(from), at(to), { nowMs: NOW, ...over });

before(() => {
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Vitals Kid', 1)").run(CHILD);
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(OTHER);
});
beforeEach(() => {
  for (const t of ['esphome_readings', 'esphome_entities', 'esphome_devices']) db.prepare(`DELETE FROM ${t}`).run();
  resetNightVitalsLogForTest();
});
after(() => {
  db.close();
  cleanupTempDataDirs();
});

// ---------------------------------------------------------------- the minute rules (the shadow's, one definition)

test('heart rate: a minute needs at least 3 updates (2 is excluded, 3 counts); min, max and avg are whole numbers', () => {
  // Kills: the minimum moved to `>` (the n = 3 minute drops, the count is 0) or dropped (the n = 2 minute counts).
  const d = addDevice(CHILD);
  hr(d, 0, 100, 2); // too few updates: not a measured minute whatever its mean says
  hr(d, 1, 80.4, 3);
  hr(d, 2, 90.6, 10);
  const v = run();
  assert.deepEqual(v.hr, { avg: 86, min: 80, max: 91, minutes: 2 }); // mean 85.5 -> 86
  assert.equal(v.rr, null, 'no breathing rows: that role is null, the other still shown');
});

test('breathing: a minute needs at least 30 updates (29 is excluded, 30 counts)', () => {
  // Kills: the minimum moved to `>` or dropped.
  const d = addDevice(CHILD);
  rr(d, 0, 20, 29);
  rr(d, 1, 18, 30);
  hr(d, 5, 80); // some valid heart rate so the result is not null for the wrong reason
  const v = run();
  assert.deepEqual(v.rr, { avg: 18, min: 18, max: 18, minutes: 1 });
});

test('breathing: the 1.0 placeholder and a zero mean are not measured breaths; 2.0 is the first that counts', () => {
  // Kills: the placeholder cut removed, or moved to `<=` (the 2.0 minute drops).
  const d = addDevice(CHILD);
  rr(d, 0, 1.0); // the placeholder some sensors send
  rr(d, 1, 0, 40); // a mean of zero
  rr(d, 2, 1.9);
  rr(d, 3, 2.0);
  hr(d, 5, 80);
  assert.deepEqual(run().rr, { avg: 2, min: 2, max: 2, minutes: 1 });
});

test('the 1 m distance cut: 100 cm stays, 101 cm goes, for heart rate and for breathing alike', () => {
  // Kills: the cut removed, `<=` moved to `<`, or applied to only one of the two roles.
  const d = addDevice(CHILD);
  hr(d, 0, 70); rr(d, 0, 20); dist(d, 0, 100);
  hr(d, 1, 90); rr(d, 1, 30); dist(d, 1, 101);
  const v = run();
  assert.deepEqual([v.hr.minutes, v.hr.avg, v.rr.minutes, v.rr.avg], [1, 70, 1, 20]);
});

test('the distance unit contract: metres and millimetres are converted, an unreadable unit fails the minute', () => {
  // Kills: no conversion, or an unknown unit treated as "no distance" (which would keep the minute).
  const m = addDevice(CHILD, { unit: 'm' });
  hr(m, 0, 70); dist(m, 0, 1.0); // 100 cm
  hr(m, 1, 90); dist(m, 1, 1.01); // 101 cm
  assert.deepEqual([run().hr.minutes, run().hr.avg], [1, 70]);

  db.prepare('DELETE FROM esphome_readings').run();
  db.prepare('DELETE FROM esphome_entities').run();
  db.prepare('DELETE FROM esphome_devices').run();
  const mm = addDevice(CHILD, { unit: 'mm' });
  hr(mm, 0, 70); dist(mm, 0, 1000); // 100 cm
  hr(mm, 1, 90); dist(mm, 1, 1010); // 101 cm
  assert.deepEqual([run().hr.minutes, run().hr.avg], [1, 70]);

  db.prepare('DELETE FROM esphome_readings').run();
  db.prepare('DELETE FROM esphome_entities').run();
  db.prepare('DELETE FROM esphome_devices').run();
  const ft = addDevice(CHILD, { unit: 'ft' });
  hr(ft, 0, 70); dist(ft, 0, 1.0);
  hr(ft, 5, 80); // no distance row in this minute: kept
  const kept = run();
  assert.deepEqual([kept.hr.minutes, kept.hr.avg], [1, 80], 'an unknown unit cannot be read, so that minute is not valid');
});

test('a minute with no distance row, or a distance row of only zeros, is kept (the shadow\'s frozen rule)', () => {
  // Kills: "no distance" treated as invalid.
  const d = addDevice(CHILD);
  hr(d, 0, 70); // no distance row at all
  hr(d, 1, 80); dist(d, 1, 0, 0); // a distance row of zeros
  assert.deepEqual(run().hr, { avg: 75, min: 70, max: 80, minutes: 2 });
});

test('a device with no distance entity at all keeps its minutes', () => {
  const d = addDevice(CHILD, { distance: false });
  hr(d, 0, 70);
  assert.equal(run().hr.minutes, 1);
});

// ---------------------------------------------------------------- whose rows count

test('two devices on one child are averaged per minute; a device without a valid row adds nothing', () => {
  // Kills: summing instead of averaging, or letting an invalid row (n = 1, mean 200) into the mean.
  const a = addDevice(CHILD);
  const b = addDevice(CHILD);
  hr(a, 0, 80); hr(b, 0, 100); // both valid: 90
  hr(a, 1, 60); hr(b, 1, 200, 1); // b has too few updates: 60 alone
  const v = run();
  assert.deepEqual(v.hr, { avg: 75, min: 60, max: 90, minutes: 2 });
});

test('a distance from one device never rescues or rejects another device\'s heart rate', () => {
  // Per device, as the shadow does: the far device's 300 cm must not reject the bedside device's reading.
  const bed = addDevice(CHILD);
  const far = addDevice(CHILD);
  hr(bed, 0, 70); dist(bed, 0, 50);
  hr(far, 0, 110); dist(far, 0, 300);
  assert.deepEqual(run().hr, { avg: 70, min: 70, max: 70, minutes: 1 });
});

test('heart rate and breathing are independent: a minute can have one without the other', () => {
  const d = addDevice(CHILD);
  hr(d, 0, 80); // no breathing row this minute
  rr(d, 1, 20); // no heart-rate row this minute
  const v = run();
  assert.deepEqual([v.hr.minutes, v.rr.minutes], [1, 1]);
});

test('an entity retired from the child (active 0) still counts: its rows were recorded for this child', () => {
  // Kills: reading only active entities (a device moved to another child is retired and cloned with new ids).
  const old = addDevice(CHILD, { active: 0 });
  hr(old, 0, 70);
  assert.equal(run().hr.minutes, 1);
});

test('another child\'s rows are never read, whatever they hold', () => {
  // Hostile fixture: the other child's sensor carries valid, very different values in the same minutes.
  const mine = addDevice(CHILD);
  const theirs = addDevice(OTHER);
  hr(mine, 0, 70);
  hr(theirs, 0, 130); rr(theirs, 0, 40); hr(theirs, 1, 130);
  const v = run();
  assert.deepEqual([v.hr, v.rr], [{ avg: 70, min: 70, max: 70, minutes: 1 }, null]);
  assert.equal(nightVitals(OTHER, at(0), at(60), { nowMs: NOW }).hr.max, 130, 'precondition: the other child does have data');
});

test('no heart-rate or breathing entity: null (distance and light alone are not vital signs)', () => {
  assert.equal(run(), null, 'no entities at all');
  const d = addDevice(CHILD);
  db.prepare('DELETE FROM esphome_entities WHERE id IN (?, ?)').run(d.hr, d.rr);
  dist(d, 0, 50); row(d.lux, 0, 1, 3);
  assert.equal(run(), null);
});

test('entities but no valid minute in the range: null, never zeros', () => {
  const d = addDevice(CHILD);
  hr(d, 0, 80, 2); rr(d, 1, 1.0); // too few updates; the placeholder
  hr(d, 70, 80); // valid, but outside the range asked for (0..60)
  assert.equal(run(), null);
});

// ---------------------------------------------------------------- the series and the summary window

test('series: 5-minute buckets on the UTC clock, the mean of the bucket\'s valid minutes, whole numbers, a gap is a missing point', () => {
  // Kills: a different bucket size or origin; averaging over the wrong set; a null/placeholder point emitted for the
  // empty bucket (the chart would draw a line through the hole); `t` in another format than the climate series'.
  // Each point is stamped at the MEAN TIME of its valid minutes (see the next tests), here: bucket 0 minutes 0..4 -> :02.
  const d = addDevice(CHILD);
  hr(d, 0, 80); hr(d, 1, 81); hr(d, 4, 83); // bucket 0: (80 + 81 + 83) / 3 = 81.33, whole numbers on the screen: 81
  rr(d, 2, 20.4); rr(d, 3, 21); // bucket 0 breathing: 20.7 -> 21
  hr(d, 5, 90); // bucket 1: heart rate only
  // minutes 10..14: no valid row at all: no point for this bucket
  rr(d, 17, 30); // bucket 3: breathing only
  const v = run({ series: true });
  assert.deepEqual(v.series, [
    { t: sql(at(2)), hr: 81, rr: 21 },
    { t: sql(at(5)), hr: 90, rr: null },
    { t: sql(at(17)), hr: null, rr: 30 },
  ]);
  assert.match(v.series[0].t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/);
  assert.equal(at(0) % (5 * MIN), 0, 'precondition: the fixture starts on the 5-minute grid');
  assert.equal('series' in run(), false, 'no series unless asked');
});

test('series: the buckets are the clock\'s, not the range\'s: a range starting mid-bucket still groups minutes 3 and 4 together', () => {
  const d = addDevice(CHILD);
  hr(d, 3, 80); hr(d, 4, 82);
  hr(d, 5, 90); // the next bucket: a range-anchored grid (3..7) would merge it with minutes 3 and 4
  const v = nightVitals(CHILD, at(3), at(10), { nowMs: NOW, series: true });
  assert.deepEqual(v.series, [{ t: sql(at(4)), hr: 81, rr: null }, { t: sql(at(5)), hr: 90, rr: null }]); // minutes 3 and 4: mean 3.5 -> :04
});

test('series: a point is stamped at the mean time of its valid minutes, not at the bucket start (a lone reading at :04 is :04)', () => {
  // Kills: stamping the bucket start. One valid reading at 12:04 published as 12:00 was shown by the hover lookup (nearest
  // point within 5 minutes) at 11:55, nine minutes before the only measurement.
  const lone = addDevice(CHILD);
  hr(lone, 4, 80);
  assert.deepEqual(run({ series: true }).series, [{ t: sql(at(4)), hr: 80, rr: null }]);
  db.prepare('DELETE FROM esphome_readings').run();
  hr(lone, 0, 80); hr(lone, 1, 80); hr(lone, 2, 80); hr(lone, 3, 80); hr(lone, 4, 80);
  assert.deepEqual(run({ series: true }).series.map((p) => p.t), [sql(at(2))], 'minutes :00-:04 -> :02');
});

test('series: the stamp counts the minutes of either role, rounds to a whole minute, and the points stay sorted', () => {
  // Kills: averaging only the heart-rate minutes; flooring instead of rounding; an unsorted series.
  const d = addDevice(CHILD);
  hr(d, 6, 70); rr(d, 9, 20); // bucket 1: minutes 6 and 9 -> 7.5 -> :08 (heart rate at 6, breathing at 9, one point)
  hr(d, 0, 80); // bucket 0 inserted later than bucket 1 in the table, must still come first
  hr(d, 11, 90); hr(d, 12, 90); hr(d, 13, 90); // bucket 2: 12
  const s = run({ series: true }).series;
  assert.deepEqual(s.map((p) => p.t), [sql(at(0)), sql(at(8)), sql(at(12))]);
  assert.deepEqual(s.map((p) => p.t), [...s.map((p) => p.t)].sort());
});

test('summary: over the summary window only; the series still covers the whole range', () => {
  // Kills: the summary taking the whole range, or an off-by-one at either end ([from, to) in minutes).
  const d = addDevice(CHILD);
  for (let m = 0; m < 10; m++) hr(d, m, 60 + m * 10); // 60, 70, ... 150
  const whole = run({ series: true }, 0, 10);
  assert.deepEqual(whole.hr, { avg: 105, min: 60, max: 150, minutes: 10 });
  const narrow = run({ series: true, summaryFromMs: at(3), summaryToMs: at(7) }, 0, 10);
  assert.deepEqual(narrow.hr, { avg: 105, min: 90, max: 120, minutes: 4 }, 'minutes 3, 4, 5, 6: 90, 100, 110, 120');
  assert.equal(narrow.series.length, 2, 'the series is the whole range (two 5-minute buckets)');
  assert.deepEqual(run({ summaryFromMs: at(3), summaryToMs: at(4) }, 0, 10).hr.minutes, 1, 'the end is exclusive, the start inclusive');
});

test('summary: a bound off the minute rounds UP at both ends (the minute that starts before the onset is not counted)', () => {
  // Kills: Math.ceil -> Math.floor on the summary start (survived every minute-aligned fixture) or on the end.
  const d = addDevice(CHILD);
  for (let m = 0; m < 10; m++) hr(d, m, 60 + m * 10); // minute m = 60 + 10 m
  // Onset 00:03:30: minute 3 STARTED before it and is out, minute 4 is the first counted. Wake 00:07:30: minute 7 starts
  // before the wake, so it counts (and minute 8 does not): a minute counts when it STARTS inside [onset, wake).
  const v = run({ summaryFromMs: at(3) + 30000, summaryToMs: at(7) + 30000 }, 0, 10);
  assert.deepEqual(v.hr, { avg: 115, min: 100, max: 130, minutes: 4 }, 'minutes 4, 5, 6, 7 = 100, 110, 120, 130');
  // Each end alone, so a fault at one cannot hide behind the other.
  assert.deepEqual(run({ summaryFromMs: at(3) + 30000 }, 0, 10).hr.minutes, 6, 'start only: minutes 4..9');
  assert.deepEqual(run({ summaryToMs: at(7) + 30000 }, 0, 10).hr.minutes, 8, 'end only: minutes 0..7');
});

test('summary: a window with no valid minute in it gives null summaries, the series (when asked) is still there', () => {
  const d = addDevice(CHILD);
  hr(d, 0, 80);
  const v = run({ series: true, summaryFromMs: at(30), summaryToMs: at(40) });
  assert.deepEqual([v.hr, v.rr, v.series.length], [null, null, 1]);
});

// ---------------------------------------------------------------- the clock and the bounds

test('a minute whose row is not written yet at nowMs is not read (the shadow\'s replay clock)', () => {
  // Minute m is readable from (m + 1) minutes + 10 ms. Kills: ignoring the delay.
  const d = addDevice(CHILD);
  hr(d, 0, 70); hr(d, 1, 80); hr(d, 2, 90);
  assert.equal(run({ nowMs: at(3) + 9 }).hr.minutes, 2, 'minute 2 is not readable 9 ms after it ends');
  assert.equal(run({ nowMs: at(3) + 10 }).hr.minutes, 3, 'and is at 10 ms');
  assert.equal(run({ nowMs: at(0) }), null, 'nothing is readable before the range starts');
});

test('the bounds are whole minutes: start rounds down, end rounds up, and nothing throws', () => {
  const d = addDevice(CHILD);
  hr(d, 0, 70); hr(d, 1, 80); hr(d, 2, 90);
  // 00:00:30 rounds down to minute 0, and 00:01:30 up to minute 2 (exclusive): minutes 0 and 1.
  assert.equal(nightVitals(CHILD, at(0) + 30000, at(1) + 30000, { nowMs: NOW }).hr.minutes, 2);
  for (const bad of [NaN, undefined, null, Infinity, 'x']) {
    assert.equal(nightVitals(CHILD, bad, at(5), { nowMs: NOW }), null, `start ${String(bad)}`);
    assert.equal(nightVitals(CHILD, at(0), bad, { nowMs: NOW }), null, `end ${String(bad)}`);
  }
  assert.equal(nightVitals(CHILD, at(5), at(0), { nowMs: NOW }), null, 'an empty or inverted range');
});

test('reads only: no row of any table changes', () => {
  const d = addDevice(CHILD);
  hr(d, 0, 70); rr(d, 1, 20);
  const snap = () => JSON.stringify(['esphome_readings', 'esphome_entities', 'esphome_devices']
    .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
  const before = snap();
  run({ series: true });
  assert.equal(snap(), before);
});

// ---------------------------------------------------------------- withNightVitals

const NIGHT = {
  status: 'ok', in_progress: false, night_date: '2026-07-01', window_start: sql(at(0)), window_end: sql(at(60)),
  onset_at: sql(at(10)), wake_at: sql(at(50)), as_of: sql(at(60)),
};

test('withNightVitals: a copy with `vitals` for an ok night; the argument is not mutated; summary onset..wake', () => {
  const d = addDevice(CHILD);
  hr(d, 5, 140); // before the onset
  hr(d, 20, 70); hr(d, 30, 80);
  hr(d, 55, 150); // after the wake
  const frozen = Object.freeze({ ...NIGHT });
  const out = withNightVitals(CHILD, frozen, { nowMs: NOW });
  assert.notEqual(out, frozen);
  assert.equal('vitals' in frozen, false);
  assert.deepEqual(out.vitals.hr, { avg: 75, min: 70, max: 80, minutes: 2 });
  assert.equal('series' in out.vitals, false);
  const withSeries = withNightVitals(CHILD, NIGHT, { nowMs: NOW, series: true });
  assert.ok(withSeries.vitals.series.length >= 3, 'the series covers the whole window, not the onset..wake span');
});

test('withNightVitals: the SAME object comes back when there is nothing to add', () => {
  // The no-sensor response must be byte-identical to before. Kills: always returning a copy with `vitals: null`.
  assert.equal(withNightVitals(CHILD, NIGHT, { nowMs: NOW }), NIGHT, 'a child without a sensor');
  const d = addDevice(CHILD);
  hr(d, 20, 70);
  const notOk = { ...NIGHT, status: 'no_sleep' };
  assert.equal(withNightVitals(CHILD, notOk, { nowMs: NOW }), notOk, 'not an ok night');
  const live = { ...NIGHT, status: 'no_data', in_progress: true };
  assert.equal(withNightVitals(CHILD, live, { nowMs: NOW }), live, 'in progress but not ok: only the detail view draws it');
  assert.ok(withNightVitals(CHILD, live, { nowMs: NOW, inProgressToo: true }).vitals, 'the detail view does');
  assert.equal(withNightVitals(CHILD, null), null);
  assert.equal(withNightVitals(CHILD, 'x'), 'x');
});

test('withNightVitals: onset before the window and wake after it still count: the summary is the same on every read', () => {
  // The card reads the window, the detail page the display span: a child asleep before window_start (onset may be 3 h
  // before it), or awake after window_end (the wake look-ahead), or a parent's corrected time, must not change the summary
  // with the range asked for. Kills: clipping the summary to the range ([window_start, window_end) or the display span).
  const d = addDevice(CHILD);
  hr(d, -100, 70); // asleep, before the window opened
  hr(d, 30, 80);
  hr(d, 90, 100); // asleep, after the window closed
  hr(d, -200, 150); // before the onset
  hr(d, 130, 150); // after the wake
  const night = { ...NIGHT, onset_at: sql(at(-120)), wake_at: sql(at(120)), display_start: sql(at(10)), display_end: sql(at(50)) };
  const want = { avg: 83, min: 70, max: 100, minutes: 3 };
  assert.deepEqual(withNightVitals(CHILD, night, { nowMs: NOW }).vitals.hr, want, 'the card (window)');
  assert.deepEqual(withNightVitals(CHILD, night, { nowMs: NOW, series: true }).vitals.hr, want, 'detail without display');
  const detail = withNightVitals(CHILD, night, { nowMs: NOW, series: true, display: true }).vitals;
  assert.deepEqual(detail.hr, want, 'the detail page (display span 10..50)');
  // The series is still only the display span, so the tracks line up with the timeline bar: minute 30 alone.
  assert.deepEqual(detail.series, [{ t: sql(at(30)), hr: 80, rr: null }]);
  const windowSeries = withNightVitals(CHILD, night, { nowMs: NOW, series: true }).vitals.series;
  assert.deepEqual(windowSeries.map((p) => p.hr), [80], 'the window 0..60 holds minute 30 only');
});

test('withNightVitals: the summary stays inside the replay clock when it reaches past the range', () => {
  // A wake after the window is read only up to what is readable at nowMs.
  const d = addDevice(CHILD);
  hr(d, 30, 80); hr(d, 90, 100);
  const night = { ...NIGHT, wake_at: sql(at(120)) };
  assert.deepEqual(withNightVitals(CHILD, night, { nowMs: at(91) + 9 }).vitals.hr.minutes, 1, 'minute 90 is not readable yet');
  assert.deepEqual(withNightVitals(CHILD, night, { nowMs: at(91) + 10 }).vitals.hr.minutes, 2);
});

test('withNightVitals: a summary-only read whose valid minutes are all outside onset..wake adds nothing (the same object)', () => {
  // Kills: returning `vitals: { hr: null, rr: null }` (truthy) for it. With a series asked for there IS something to draw.
  const d = addDevice(CHILD);
  hr(d, 5, 70); hr(d, 55, 90); // inside the window, before the onset (10) and after the wake (50)
  assert.equal(withNightVitals(CHILD, NIGHT, { nowMs: NOW }), NIGHT);
  const detail = withNightVitals(CHILD, NIGHT, { nowMs: NOW, series: true });
  assert.notEqual(detail, NIGHT);
  assert.equal(detail.vitals.hr, null);
  assert.equal(detail.vitals.rr, null);
  assert.deepEqual(detail.vitals.series.map((p) => p.hr), [70, 90]);
});

test('withNightVitals: a night in progress ends at as_of, with no onset the summary starts at the range start', () => {
  const d = addDevice(CHILD);
  hr(d, 5, 70); hr(d, 25, 90); hr(d, 40, 200);
  const live = { ...NIGHT, in_progress: true, onset_at: null, wake_at: null, as_of: sql(at(30)), window_end: sql(at(600)) };
  const v = withNightVitals(CHILD, live, { nowMs: NOW }).vitals;
  assert.deepEqual(v.hr, { avg: 80, min: 70, max: 90, minutes: 2 }, 'minute 40 is after as_of; minute 5 is in (no onset)');
  // The SERIES range stops at as_of too (kills: reading to the window's end, which is hours in the future for a live night).
  const withSeries = withNightVitals(CHILD, live, { nowMs: NOW, series: true }).vitals;
  assert.deepEqual(withSeries.series.map((p) => p.hr), [70, 90], 'no point for minute 40 (200)');
});

test('withNightVitals: the detail view uses the timeline\'s display span for the series', () => {
  const d = addDevice(CHILD);
  hr(d, 2, 70); hr(d, 12, 80);
  const night = { ...NIGHT, display_start: sql(at(10)), display_end: sql(at(20)), onset_at: null, wake_at: null };
  const v = withNightVitals(CHILD, night, { nowMs: NOW, series: true, display: true }).vitals;
  assert.deepEqual(v.series, [{ t: sql(at(12)), hr: 80, rr: null }]); // the lone minute 12 (display minutes 10..19)
  const plain = withNightVitals(CHILD, night, { nowMs: NOW, series: true }).vitals;
  assert.equal(plain.series.length, 2, 'without `display` the window is used');
});

test('withNightVitals never throws: a night that cannot be read is returned as it is, and one fixed line is logged', (t) => {
  const warn = t.mock.method(logger, 'warn', () => {});
  const broken = { get status() { throw new Error('secret child id 123'); } };
  assert.equal(withNightVitals(CHILD, broken), broken);
  assert.equal(withNightVitals(CHILD, broken), broken);
  assert.equal(warn.mock.callCount(), 1, 'at most one line an hour');
  assert.doesNotMatch(String(warn.mock.calls[0].arguments[0]), /secret|123/, 'never the error\'s own text');
});
