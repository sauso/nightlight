// #917 (follow-up to #506): the ESPHome radar sensor as a SHADOW second opinion on the morning exit.
//
// What is pinned here, each named in the PR body with the test that fails without it:
//   - the per-minute reading (lib/sleepSensor.js sensorMinutesFor): every threshold at its boundary, the distance unit
//     contract, the tri-state (an all-zero row is false, no row is null), whose rows count (this child's, every epoch,
//     by role, paired per device) with HOSTILE fixtures (another child, an unassigned entity and this child's
//     non-vital entities all carry vital-sign values that must not count), and the replay clock;
//   - the rule (sensorContradictsExit): its window [e+1, e+10] and its 6-of-10 count, edge by edge;
//   - computeNight: the shadow moves only `wake_at_sensor` / `sensor_rejects`. Every other key, at eight clocks, with
//     the timeline and with a stored context, is what the night reads with no sensor at all; the shadow runs once, never
//     on a night in progress or without sensor rows, with the same clock, never counting #700's history reads; a
//     failing read or pass leaves the real night alone and logs a fixed sentence;
//   - the shapes measured on the three labelled nights: a false exit rejected (the shadow takes the real exit), and
//     THE DOCUMENTED SHADOW ERROR (F1): an adult's vital signs right after a real exit reject it, and the shadow wake then
//     moves later with the clock while the real wake does not;
//   - storage: insert and conflict-update round trips, late readings, pruned readings, a locked night, corrections.
//
// DATA_DIR is pointed at a throwaway directory BEFORE anything imports db.js (it opens the database at module load).
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-sensor-shadow-'));
process.env.DATA_DIR = TMP;

const sleep = await import('../src/lib/sleepAnalysis.js');
const {
  computeNight, computeAndStoreNight, sensorShadowPassesForTest, failNextSensorShadowPassForTest,
  priorWakeLeadReadsForTest, SCORING_ALGO,
} = sleep;
const sensor = await import('../src/lib/sleepSensor.js');
const { sensorMinutesFor, sensorContradictsExit, vitalsAfterExit, deviceMinuteHasVitals, distanceCm } = sensor;
const roles = await import('../src/lib/esphomeRoles.js');
const manager = await import('../src/lib/esphomeManager.js');
const { applyCorrection } = await import('../src/lib/sleepReviews.js');
const { logger } = await import('../src/lib/logger.js');
const { default: db } = await import('../src/db.js');

const CHILD = 'ss-child';
const OTHER = 'ss-other';
const CAM = 'ss-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne'; // UTC+10 in July, no DST edge near the fixture night
const TZ_OFF = 10 * 3600 * 1000;
const STILL_OCCUPIED = 0.004; // a still child: under MOTION_ACTIVE, over OCCUPANCY_MIN_PEAK (see sleepAnalysis.test.js)
const STILL_EMPTY = 0.0002;

const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const plus = (d, min) => new Date(d.getTime() + min * 60000);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const hhmm = (u) =>
  u ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' }) : null;
const json = (v) => JSON.parse(JSON.stringify(v));
const NEW_KEYS = ['wake_at_sensor', 'sensor_rejects'];
const withoutNewKeys = (r) => { const c = json(r); for (const k of NEW_KEYS) delete c[k]; return c; };

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTransition = db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)');
const putRow = db.prepare(
  'INSERT OR REPLACE INTO esphome_readings (entity_id, bucket, last, mean, min, max, n, nzero, nmiss) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)'
);

// --- ESPHome fixture -------------------------------------------------------------------------------------------------

let devSeq = 0;
const addEntity = (device, childId, objectId, name, deviceClass, unit, active = 1) => db.prepare(
  `INSERT INTO esphome_entities (device_id, object_id, child_id, kind, name, device_class, unit, active)
   VALUES (?, ?, ?, 'sensor', ?, ?, ?, ?)`
).run(device, objectId, childId, name, deviceClass, unit, active).lastInsertRowid;
// A radar sensor as the measured ones report it: heart rate, breathing rate, distance (cm unless told otherwise) and an
// illuminance entity that writes a row every connected minute (presence).
function addDevice(childId, { unit = 'cm', distance = true } = {}) {
  const device = db.prepare("INSERT INTO esphome_devices (name, host, child_id) VALUES (?, '192.0.2.10', ?)")
    .run(`sensor ${++devSeq}`, childId).lastInsertRowid;
  return {
    device,
    hr: addEntity(device, childId, 'heart_rate', 'Heart Rate', null, 'bpm'),
    rr: addEntity(device, childId, 'respiratory_rate', 'Respiratory Rate', null, null),
    dist: distance ? addEntity(device, childId, 'distance', 'Distance', 'distance', unit) : null,
    lux: addEntity(device, childId, 'illuminance', 'Illuminance', 'illuminance', 'lx'),
  };
}
// One entity's row for the minute containing `ms`: n non-zero updates averaging `mean` (none: a row of zeros).
function row(entity, ms, n, mean = 80, nzero = 0) {
  putRow.run(entity, Math.floor(ms / 60000), n > 0 ? mean : 0, n > 0 ? mean : null, n > 0 ? mean : null, n > 0 ? mean : null, n, nzero);
}
// A whole minute of one device: `vitals` true = a person measured at 60 cm (HR n 10, RR n 40); false = the sensor
// connected and reading zeros (HR and RR rows of zeros) with the distance still a flat 60 cm, which is what an empty bed
// read after the measured real wakes (the 1 m rule cannot tell the two apart; only the update counts can).
function sensorMinute(d, ms, vitals) {
  row(d.lux, ms, 1, 3);
  if (d.dist) row(d.dist, ms, 10, 60);
  if (vitals) { row(d.hr, ms, 10, 80); row(d.rr, ms, 40, 20); } else { row(d.hr, ms, 0, 0, 10); row(d.rr, ms, 0, 0, 40); }
}
// Every minute of the fixture night's span, vital signs where `vitalsAt(minuteStart)` says so.
function laySensor(d, vitalsAt) {
  for (let t = at(19, 0); t < at(12, 0, 1); t = plus(t, 1)) sensorMinute(d, t.getTime(), vitalsAt(t));
}
const inBedUntil = (end, extra = []) => (t) => t < end || extra.some(([a, b]) => t >= a && t < b);

// --- the camera night -------------------------------------------------------------------------------------------------
//
// Put down 19:30 (moving to 19:40, asleep from then), still in the bed all night, climbing out in the 4 minutes before
// `exitMin` (06:30 unless told otherwise) and a REAL exit logged in that minute, `realSec` seconds past it, then an
// empty bed to 12:00. Options:
//   falseExit      — the 2026-10-28 shape (one child, sensor A): the child turns over at 06:03-06:05 and the camera logs
//                    an `out_of_bed` at 06:05:35 although the child stays in the bed (still from 06:06). The scan takes
//                    it: the reported wake is 06:05, 25 minutes before the real one.
//   earlyFalseExit — the same an hour earlier (05:05:35), far earlier than the child gets up (#700, test S6).
//   reversal       — an `into_bed` at 06:08 with the still child in the bed after it: the 06:05 exit is reversed.
//   laterExit      — the child back in the room later: one active bed minute and an `out_of_bed` at 07:58:38.
//   realExit       — false: the child climbs out but the camera logs no exit for it.
// No sound, and no morning awake run of 5 minutes, so the #509 veto never runs and the wake is the scan's own choice.
function layNight({ falseExit = false, earlyFalseExit = false, reversal = false, laterExit = false, realExit = true,
  exitMin = [6, 30], realSec = 17 } = {}) {
  const exitAt = at(exitMin[0], exitMin[1], 1);
  for (let t = at(19, 30); t < at(12, 0, 1); t = plus(t, 1)) {
    let motion;
    if (t < at(19, 40)) motion = 0.4;
    else if (falseExit && t >= at(6, 3, 1) && t < at(6, 6, 1)) motion = 0.4;
    else if (earlyFalseExit && t >= at(5, 3, 1) && t < at(5, 6, 1)) motion = 0.4;
    else if (t >= plus(exitAt, -4) && t < exitAt) motion = 0.4;
    else if (laterExit && t >= at(7, 58, 1) && t < at(7, 59, 1)) motion = 0.4;
    else motion = t < exitAt ? STILL_OCCUPIED : STILL_EMPTY;
    insertSample.run(CAM, sqlTime(t), motion, motion);
  }
  if (falseExit) insertTransition.run(CAM, 'out_of_bed', 0.05, sqlTime(at(6, 5, 1, 35)));
  if (earlyFalseExit) insertTransition.run(CAM, 'out_of_bed', 0.05, sqlTime(at(5, 5, 1, 35)));
  if (reversal) insertTransition.run(CAM, 'into_bed', 0.05, sqlTime(at(6, 8, 1)));
  if (realExit) insertTransition.run(CAM, 'out_of_bed', 0.05, sqlTime(new Date(exitAt.getTime() + realSec * 1000)));
  if (laterExit) insertTransition.run(CAM, 'out_of_bed', 0.05, sqlTime(at(7, 58, 1, 38)));
}
const nightAt = (t, clock, opts) => {
  t.mock.timers.enable({ apis: ['Date'], now: clock.getTime() });
  try { return computeNight(CHILD, DATE, opts); } finally { t.mock.timers.reset(); }
};
const storeAt = (t, clock, opts) => {
  t.mock.timers.enable({ apis: ['Date'], now: clock.getTime() });
  try { return computeAndStoreNight(CHILD, DATE, opts); } finally { t.mock.timers.reset(); }
};
const storedRow = () => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
const wipeSensors = () => { for (const tb of ['esphome_readings', 'esphome_entities', 'esphome_devices']) db.prepare(`DELETE FROM ${tb}`).run(); };
const NOON = at(12, 0, 1);

before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?) ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  for (const id of [CHILD, OTHER]) {
    db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end) VALUES (?, 'Kid', 1, '19:30', '07:00')`).run(id);
  }
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'sscam')`).run(CAM, CHILD);
});

beforeEach(() => {
  for (const tb of ['activity_samples', 'bed_transitions', 'sleep_nights', 'sleep_reviews']) db.prepare(`DELETE FROM ${tb}`).run();
  wipeSensors();
});

after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --- 1. the per-minute reading ------------------------------------------------------------------------------------------

describe('#917 sensorMinutesFor: one tri-state value per UTC minute', () => {
  const ORIGIN = Date.UTC(2026, 6, 1, 0, 0);
  const m = (k) => ORIGIN + k * 60000;
  const LATER = ORIGIN + 86400000;
  const read = (childId = CHILD, n = 20, nowMs = LATER) => sensorMinutesFor(childId, ORIGIN, m(n), { nowMs });

  test('each threshold at its boundary: HR n 2/3, RR n 29/30, RR mean 1.9/2.0 (placeholder), distance 100/101 cm', () => {
    const d = addDevice(CHILD);
    const cases = [
      [0, () => row(d.hr, m(0), 2), false],
      [1, () => row(d.hr, m(1), 3), true],
      [2, () => row(d.rr, m(2), 29, 20), false],
      [3, () => row(d.rr, m(3), 30, 20), true],
      [4, () => row(d.rr, m(4), 30, 1.9), false],
      [5, () => row(d.rr, m(5), 30, 2.0), true],
      [6, () => { row(d.hr, m(6), 5); row(d.dist, m(6), 10, 100); }, true],
      [7, () => { row(d.hr, m(7), 5); row(d.dist, m(7), 10, 101); }, false],
      [8, () => { row(d.hr, m(8), 0, 0, 12); row(d.rr, m(8), 0, 0, 40); }, false], // a minute of zeros: connected, no vitals
      [10, () => row(d.lux, m(10), 1, 3), false], // only a non-vital row: the device was there, so false, not null
      [11, () => { row(d.hr, m(11), 5); row(d.dist, m(11), 0, 0, 10); }, true], // vitals, distance only zeros: no cut
    ];
    for (const [, lay] of cases) lay();
    const out = read();
    for (const [k, , want] of cases) assert.equal(out[k], want, `minute ${k}`);
    assert.equal(out[9], null, 'no row at all: unknown, never "no vital signs"');
    assert.equal(out.length, 20);
  });

  test('the distance unit contract: cm as is, m and mm converted, any other unit or none is not valid', () => {
    const cases = [['cm', 95, true], ['m', 0.95, true], ['m', 1.05, false], ['mm', 950, true], ['mm', 1050, false],
      ['CM', 95, true], ['in', 30, false], [null, 50, false], ['', 50, false]];
    cases.forEach(([unit, value, want], i) => {
      wipeSensors();
      const d = addDevice(CHILD, { unit });
      row(d.hr, m(0), 5);
      row(d.dist, m(0), 10, value);
      assert.equal(read()[0], want, `unit ${JSON.stringify(unit)} value ${value} (case ${i})`);
    });
    assert.equal(distanceCm(1.5, ' m '), 150);
    assert.equal(distanceCm(Number.NaN, 'cm'), null);
  });

  test('HOSTILE: another child, an unassigned entity and this child\'s non-vital entities never count as vital signs', () => {
    const mine = addDevice(CHILD, { distance: false });
    row(mine.lux, m(0), 1, 3);
    // This child's own entities whose role is not a vital sign, every one carrying vital-sign-sized counts.
    for (const [obj, name, cls] of [['temp', 'Temperature', 'temperature'], ['pulse', 'Pulse', null], ['targets', 'Target Number', null]]) {
      row(addEntity(mine.device, CHILD, obj, name, cls, null), m(0), 60, 80);
    }
    // Another child's sensor and an entity assigned to nobody, both measuring a person in every minute.
    const theirs = addDevice(OTHER);
    for (let k = 0; k < 20; k++) { row(theirs.hr, m(k), 10); row(theirs.rr, m(k), 40, 20); row(theirs.dist, m(k), 10, 50); }
    const loose = addEntity(theirs.device, null, 'heart_rate_2', 'Heart Rate', null, 'bpm');
    for (let k = 0; k < 20; k++) row(loose, m(k), 10);
    row(mine.hr, m(1), 0, 0, 5); // a vital-sign entity of this child, zeros only: so the child HAS a sensor
    const out = read();
    assert.equal(out[0], false, 'non-vital roles of this child are presence, not vital signs');
    assert.equal(out[1], false);
    for (let k = 2; k < 20; k++) assert.equal(out[k], null, `minute ${k}: only other children's rows`);
    assert.equal(read(OTHER)[5], true, 'control: the other child\'s own minutes do read as vital signs');
  });

  test('a retired entity of this child still counts (an earlier epoch), whatever its active flag', () => {
    const d = addDevice(CHILD);
    const retired = addEntity(d.device, CHILD, 'heart_rate', 'Heart Rate', null, 'bpm', 0);
    row(retired, m(3), 6);
    assert.equal(read()[3], true);
  });

  test('vital signs and distance are paired PER DEVICE: a bedside distance never validates a far device', () => {
    const far = addDevice(CHILD);
    const near = addDevice(CHILD);
    row(far.hr, m(0), 10); row(far.dist, m(0), 10, 150); // a person measured 1.5 m away
    row(near.dist, m(0), 10, 50); row(near.hr, m(0), 0, 0, 10); // the bedside device: close, no vital signs
    row(far.hr, m(1), 10); row(near.dist, m(1), 10, 150); // the far device has no distance this minute: not cut
    const out = read();
    assert.equal(out[0], false, 'paired per child, the bedside 50 cm would have made this true');
    assert.equal(out[1], true, 'paired per child, the other device\'s 150 cm would have made this false');
  });

  test('the replay clock: a minute is unknown until ROW_READABLE_DELAY_MS after the next minute starts; past endMs is cut', () => {
    const d = addDevice(CHILD);
    for (let k = 0; k < 10; k++) row(d.hr, m(k), 10);
    const at5 = sensorMinutesFor(CHILD, ORIGIN, m(10), { nowMs: m(5) + sensor.ROW_READABLE_DELAY_MS - 1 });
    assert.deepEqual(at5.slice(0, 6), [true, true, true, true, null, null], 'minute 4 is not written yet');
    const at5b = sensorMinutesFor(CHILD, ORIGIN, m(10), { nowMs: m(5) + sensor.ROW_READABLE_DELAY_MS });
    assert.equal(at5b[4], true, 'and is, 10 ms after minute 5 starts');
    const cut = sensorMinutesFor(CHILD, ORIGIN, m(3), { nowMs: LATER });
    assert.deepEqual(cut, [true, true, true], 'nothing at or past endMs');
  });

  test('no sensor: null when the child has no heart-rate or breathing-rate row in the range; a bad origin throws', () => {
    assert.equal(read(), null, 'no entity at all');
    const d = addDevice(CHILD);
    row(d.lux, m(2), 1, 3); row(d.dist, m(2), 10, 60);
    assert.equal(read(), null, 'only presence and distance rows: no vital-sign sensor, no shadow');
    row(d.hr, m(25), 10);
    assert.equal(read(), null, 'a heart-rate row outside the range does not count');
    row(d.hr, m(3), 0, 0, 10);
    assert.ok(Array.isArray(read()), 'a heart-rate row of zeros inside it does: the sensor is there');
    assert.equal(sensorMinutesFor(CHILD, ORIGIN, ORIGIN, { nowMs: LATER }), null, 'an empty range');
    assert.throws(() => sensorMinutesFor(CHILD, ORIGIN + 1000, m(5), { nowMs: LATER }), RangeError);
  });

  test('deviceMinuteHasVitals and the role guess: the pure pieces, and the manager re-exports the same function', () => {
    assert.equal(deviceMinuteHasVitals({}), false);
    assert.equal(deviceMinuteHasVitals({ hr: { n: 3 } }), true);
    assert.equal(deviceMinuteHasVitals({ rr: { n: 30, mean: null } }), true, 'a mean of null is not the placeholder');
    assert.equal(manager.guessEsphomeCategory, roles.guessEsphomeCategory);
    assert.equal(roles.guessEsphomeCategory({ name: 'Breath Rate' }), 'respiratory_rate');
    assert.equal(roles.guessEsphomeCategory({ name: 'Breathing rate' }), null, 'documented: this spelling is not recognised');
  });
});

// --- 2. the rule ---------------------------------------------------------------------------------------------------------

describe('#917 sensorContradictsExit: 6 of the 10 minutes [e+1, e+10]', () => {
  const E = 50;
  const minutes = (trueAt, fill = false) => { const a = new Array(80).fill(fill); for (const k of trueAt) a[E + k] = true; return a; };
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  test('the window edges and the count, one boundary at a time', () => {
    assert.equal(sensorContradictsExit(minutes(range(1, 6)), E), true, 'e+1..e+6');
    assert.equal(sensorContradictsExit(minutes(range(5, 10)), E), true, 'e+5..e+10');
    assert.equal(sensorContradictsExit(minutes(range(1, 5)), E), false, 'five is one short');
    assert.equal(sensorContradictsExit(minutes(range(0, 5)), E), false, 'the exit\'s own minute does not count');
    assert.equal(sensorContradictsExit(minutes(range(6, 11)), E), false, 'e+11 does not count');
    assert.equal(sensorContradictsExit(minutes(range(1, 5), null), E), false, 'unknown minutes never count');
    assert.equal(vitalsAfterExit(minutes(range(-3, 13)), E), 10);
    assert.equal(sensorContradictsExit(minutes(range(1, 6)).slice(0, E + 4), E), false, 'past the array end is unknown');
  });
});

// --- 3. computeNight -----------------------------------------------------------------------------------------------------

describe('#917 computeNight: the shadow moves wake_at_sensor and sensor_rejects and nothing else', () => {
  test('S1 the 2026-10-28 shape: the false exit is rejected, the shadow takes the real exit, the real wake stays', (t) => {
    layNight({ falseExit: true });
    const d = addDevice(CHILD);
    laySensor(d, inBedUntil(at(6, 30, 1))); // the child in bed (vital signs) to 06:29, an empty bed after
    const night = nightAt(t, NOON);
    assert.equal(night.status, 'ok');
    assert.equal(hhmm(night.wake_at), '06:05', 'the reported wake is the camera\'s, as before #917');
    assert.equal(hhmm(night.wake_at_sensor), '06:30', 'the shadow: the false exit rejected, the real exit taken');
    // The scan asks about the 06:05:35 exit for three gaps (the night-long one from 19:40, its own from 06:06, and the
    // real exit's from 06:30); it is ONE row, so one reject (#917 plan review).
    assert.equal(night.sensor_rejects, 1);
  });

  test('S2 the real night is untouched: every older key, at eight clocks, plain, with the timeline and a stored context', (t) => {
    layNight({ falseExit: true, laterExit: true });
    const d = addDevice(CHILD);
    laySensor(d, inBedUntil(at(6, 30, 1)));
    const ctx = storeAt(t, at(7, 1, 1)) && storedRow().scoring_context;
    assert.ok(ctx && JSON.parse(ctx).algo === SCORING_ALGO, 'precondition: a stored context to replay');
    const CLOCKS = [1, 31, 61, 121, 181, 241, 301, 600].map((k) => plus(at(7, 0, 1), k));
    const variants = [{}, { includeTimeline: true }, { context: ctx }, { includeTimeline: true, context: ctx }];
    const withSensor = CLOCKS.map((c) => variants.map((o) => json(nightAt(t, c, o))));
    wipeSensors();
    const without = CLOCKS.map((c) => variants.map((o) => json(nightAt(t, c, o))));
    let shadows = 0;
    CLOCKS.forEach((c, i) => variants.forEach((o, j) => {
      const a = withSensor[i][j], b = without[i][j];
      assert.deepEqual(Object.keys(withoutNewKeys(a)), Object.keys(withoutNewKeys(b)), `key order ${i}/${j}`);
      assert.deepEqual(withoutNewKeys(a), withoutNewKeys(b), `clock ${c.toISOString()} ${JSON.stringify(Object.keys(o))}`);
      assert.deepEqual([b.wake_at_sensor, b.sensor_rejects], [null, null], 'no sensor: both null');
      if (a.sensor_rejects != null) shadows++;
    }));
    assert.equal(shadows, CLOCKS.length * variants.length, 'not vacuous: the shadow ran on every one of them');
    assert.notEqual(withSensor[0][0].wake_at_sensor, withSensor[0][0].wake_at, 'and it disagreed with the real wake');
  });

  test('S3 F1, THE DOCUMENTED SHADOW ERROR: an adult\'s vital signs right after a real exit reject it, and the shadow wake moves later with the clock', (t) => {
    // The plan review's probe: a real exit at 06:30:17 with nothing in the bed after it, and a person at the bed for six
    // minutes from 3 minutes later (06:33-06:38). The sensor cannot tell that adult from the child, so the real exit is
    // rejected. With no later exit the guard's hand-back returns it (the shadow is never the reason for no wake); once
    // the child's later exit (07:58:38) has its own 20 quiet minutes, the shadow takes THAT, 88 minutes late. The real
    // wake never moves. This is why the rule only shadows (KNOWN-ISSUES.md); if this test starts failing because the
    // shadow got it right, the promotion bar in docs/esphome.md is what decides whether that is progress.
    layNight({ laterExit: true });
    const d = addDevice(CHILD);
    laySensor(d, inBedUntil(at(6, 30, 1), [[at(6, 33, 1), at(6, 39, 1)]]));
    const seen = [[7, 1], [8, 0], [8, 30], [10, 0], [12, 0]].map(([h, mi]) => nightAt(t, at(h, mi, 1)));
    assert.deepEqual(seen.map((n) => hhmm(n.wake_at)), ['06:30', '06:30', '06:30', '06:30', '06:30'], 'the real wake');
    assert.deepEqual(seen.map((n) => hhmm(n.wake_at_sensor)), ['06:30', '06:30', '07:58', '07:58', '07:58'],
      'the shadow: handed back while nothing later qualifies, then the later exit');
    assert.deepEqual(seen.map((n) => n.sensor_rejects), [1, 1, 1, 1, 1]);
  });

  test('S4 the rule\'s window at the call site: the exit\'s minute by txIdx (a floor), [e+1, e+10], 6 of 10', (t) => {
    // The real exit at 06:30:45: its minute is 06:30 by txIdx, 06:31 by Math.round. Each case lays the person's vital
    // signs on a different run of minutes after it and reads whether the shadow rejected the exit.
    const cases = [
      [[6, 31], [6, 37], 1, 'e+1..e+6'],
      [[6, 35], [6, 41], 1, 'e+5..e+10'],
      [[6, 31], [6, 36], 0, 'e+1..e+5: one short'],
      [[6, 30], [6, 36], 0, 'e..e+5: the exit\'s own minute does not count'],
      [[6, 36], [6, 42], 0, 'e+6..e+11: e+11 does not count (and under Math.round this would be e+5..e+10)'],
    ];
    for (const [[h1, m1], [h2, m2], want, label] of cases) {
      for (const tb of ['activity_samples', 'bed_transitions']) db.prepare(`DELETE FROM ${tb}`).run();
      wipeSensors();
      layNight({ realSec: 45 });
      laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1), [[at(h1, m1, 1), at(h2, m2, 1)]]));
      const night = nightAt(t, NOON);
      assert.equal(night.sensor_rejects, want, label);
      assert.equal(hhmm(night.wake_at), '06:30', `${label}: the real wake`);
    }
  });

  test('S5 a reversed exit is never asked: the reversal guard comes first, so it is neither counted nor handed back', (t) => {
    layNight({ falseExit: true, reversal: true });
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    const night = nightAt(t, NOON);
    assert.equal(hhmm(night.wake_at), '06:30', 'precondition: the reversal guard already sets the 06:05 exit aside');
    assert.equal(hhmm(night.wake_at_sensor), '06:30');
    assert.equal(night.sensor_rejects, 0, 'asked before the reversal guard, the rule would count the 06:05 exit');
  });

  test('S6 a far-early exit the rule rejects is not handed back (#700 applies), and the shadow never counts #700\'s history reads', (t) => {
    // Fourteen earlier nights up 5-55 minutes before the window end: p75 40, threshold 80 minutes. A false exit at
    // 05:05:35 (115 minutes before 07:00, far early) with the child still in the bed, and NO logged exit when the child
    // really climbs out at 06:30: so nothing later can win, and only the hand-back could give the shadow a wake. The
    // real night has none (the lead test skipped the only exit); the shadow must not hand that exit back either.
    const insertNight = db.prepare(`INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, wake_at)
                                    VALUES (?, ?, ?, ?, 'ok', ?)`);
    [5, 10, 15, 20, 20, 25, 30, 30, 35, 40, 40, 45, 50, 55].forEach((lead, i) => {
      const dd = -(i + 1);
      const end = at(7, 0, dd + 1);
      insertNight.run(CHILD, new Date(Date.UTC(2026, 6, 1 + dd)).toISOString().slice(0, 10), sqlTime(at(19, 30, dd)), sqlTime(end),
        sqlTime(new Date(end.getTime() - lead * 60000)));
    });
    layNight({ earlyFalseExit: true, realExit: false });
    const before0 = priorWakeLeadReadsForTest();
    const noSensor = nightAt(t, NOON);
    const readsWithout = priorWakeLeadReadsForTest() - before0;
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    const before1 = priorWakeLeadReadsForTest();
    const night = nightAt(t, NOON);
    assert.equal(readsWithout, 1, 'precondition: the real night reads the history once (the 05:05 exit)');
    assert.equal(priorWakeLeadReadsForTest() - before1, 1, 'the shadow pass reads it again, but its read is never counted');
    assert.equal(hhmm(night.wake_unconfirmed?.at), '05:05', 'precondition: #700 skipped it');
    assert.equal(night.status, 'ok');
    assert.equal(night.wake_at, null, 'precondition: the real night has no wake');
    assert.equal(night.sensor_rejects, 1, 'the shadow rejected the 05:05 exit...');
    assert.equal(night.wake_at_sensor, null, '...and did not hand it back: the lead test applies to a rejected exit too');
    assert.deepEqual(withoutNewKeys(night), withoutNewKeys(noSensor));
  });

  test('S7 the only exit rejected: the hand-back keeps a wake, the shadow is never the reason for none', (t) => {
    layNight();
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1), [[at(6, 31, 1), at(6, 41, 1)]]));
    const night = nightAt(t, NOON);
    assert.equal(night.sensor_rejects, 1);
    assert.equal(hhmm(night.wake_at_sensor), '06:30', 'the rejected exit comes back: nothing later qualified');
  });

  test('S8 once: one shadow pass per completed night with sensor rows, the timeline asked or not; none in progress, off or without rows', (t) => {
    layNight({ falseExit: true });
    let p = sensorShadowPassesForTest();
    nightAt(t, NOON);
    assert.equal(sensorShadowPassesForTest() - p, 0, 'no sensor rows: no pass');
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    p = sensorShadowPassesForTest();
    nightAt(t, NOON);
    nightAt(t, NOON, { includeTimeline: true });
    assert.equal(sensorShadowPassesForTest() - p, 2, 'exactly one each');
    p = sensorShadowPassesForTest();
    const tonight = nightAt(t, at(6, 50, 1));
    assert.equal(tonight.in_progress, true);
    assert.deepEqual([tonight.wake_at_sensor, tonight.sensor_rejects], [null, null]);
    db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
    try {
      assert.equal(nightAt(t, NOON).status, 'off');
    } finally {
      db.prepare('UPDATE children SET track_sleep = 1 WHERE id = ?').run(CHILD);
    }
    assert.equal(sensorShadowPassesForTest() - p, 0, 'never on a night in progress or with tracking off');
  });

  test('S9 the shadow reads only what was written by the compute\'s own clock (window end + 1 minute)', (t) => {
    // An exit at 06:50:45, and a person measured at 06:51 and 06:56-07:00: six minutes of its ten, the sixth being 07:00,
    // the last minute before the 07:01 clock. That minute's row is written 10 ms after 07:01:00, so at 07:01:00.000 the
    // exit has five (not rejected) and at 07:01:00.010 six (rejected). A shadow that read past the clock it was given
    // (rows a replayed database holds but a live one did not yet) would reject it at both.
    layNight({ exitMin: [6, 50], realSec: 45 });
    laySensor(addDevice(CHILD), inBedUntil(at(6, 50, 1), [[at(6, 51, 1), at(6, 52, 1)], [at(6, 56, 1), at(7, 1, 1)]]));
    const clock = plus(at(7, 0, 1), 1);
    assert.equal(nightAt(t, clock).sensor_rejects, 0, 'at 07:01:00.000 the 07:00 row is not written yet');
    assert.equal(nightAt(t, new Date(clock.getTime() + sensor.ROW_READABLE_DELAY_MS)).sensor_rejects, 1, 'at 07:01:00.010 it is');
  });

  test('S10 a failing sensor read or second pass leaves the real night exactly as it is and logs one fixed sentence', (t) => {
    layNight({ falseExit: true });
    const expected = json(nightAt(t, NOON)); // no sensor rows yet: the night as it reads without a sensor
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    const lastWarn = () => logger.getRecent().filter((l) => l.includes('[WARN]')).at(-1) || '';

    db.exec('ALTER TABLE esphome_entities RENAME TO esphome_entities_away');
    let night;
    try { night = json(nightAt(t, NOON)); } finally { db.exec('ALTER TABLE esphome_entities_away RENAME TO esphome_entities'); }
    assert.deepEqual(night, expected, 'read error: the real night, both keys null');
    assert.match(lastWarn(), /\[sleep\] sensor shadow skipped: the sensor readings could not be read$/);
    assert.doesNotMatch(lastWarn(), /esphome_entities|no such table|ss-child/, 'no raw error text, table or child id');

    failNextSensorShadowPassForTest();
    assert.deepEqual(json(nightAt(t, NOON)), expected, 'pass error: the real night, both keys null');
    assert.match(lastWarn(), /\[sleep\] sensor shadow skipped: the second pass failed$/);
    assert.doesNotMatch(lastWarn(), /test fault/);

    failNextSensorShadowPassForTest();
    const stored = storeAt(t, NOON);
    assert.equal(stored.stored, true, 'computeAndStoreNight still stores the night');
    assert.equal(hhmm(storedRow().wake_at), '06:05');
    assert.deepEqual([storedRow().wake_at_sensor, storedRow().sensor_rejects], [null, null]);
    assert.equal(hhmm(nightAt(t, NOON).wake_at_sensor), '06:30', 'control: without the fault the shadow is there');
  });

  test('S12 a stored-context replay runs its shadow with the SAME stored context, not today\'s settings', (t) => {
    layNight({ falseExit: true });
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    storeAt(t, NOON);
    const ctx = storedRow().scoring_context;
    // Today's timezone changed after the night was stored: today's settings now describe a different night (in UTC the
    // window is still open at this clock), while the stored context replays the night as it was scored.
    db.prepare("UPDATE settings SET timezone = 'UTC' WHERE id = 'app'").run();
    try {
      const replay = nightAt(t, NOON, { context: ctx });
      assert.equal(hhmm(replay.wake_at), '06:05', 'precondition: the real night replays with the stored settings');
      assert.equal(hhmm(replay.wake_at_sensor), '06:30', 'and so does its shadow');
      assert.notEqual(nightAt(t, NOON).wake_at_sensor, replay.wake_at_sensor, 'precondition: today\'s settings answer differently');
    } finally {
      db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(TZ);
    }
  });

  test('S11 computeNight and computeAndStoreNight never write the ESPHome tables', (t) => {
    layNight({ falseExit: true });
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    const dump = () => ['esphome_devices', 'esphome_entities', 'esphome_readings']
      .map((tb) => db.prepare(`SELECT * FROM ${tb} ORDER BY 1, 2`).all());
    const before0 = json(dump());
    nightAt(t, NOON, { includeTimeline: true });
    storeAt(t, NOON);
    assert.deepEqual(json(dump()), before0);
  });
});

// --- 4. storage and the readers ------------------------------------------------------------------------------------------

describe('#917 sleep_nights.wake_at_sensor / sensor_rejects: stored beside the night', () => {
  test('insert and conflict-update round trips: late readings arrive, readings are pruned', (t) => {
    layNight({ falseExit: true });
    storeAt(t, plus(at(7, 0, 1), 31)); // provisional, before any sensor row exists
    assert.deepEqual([storedRow().wake_at_sensor, storedRow().sensor_rejects], [null, null], 'insert: no sensor, NULL');
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    const summary = storeAt(t, plus(at(7, 0, 1), 61));
    assert.equal(summary.stored, true);
    assert.equal(storedRow().wake_at_sensor, summary.wake_at_sensor, 'conflict update: the late readings are stored');
    assert.equal(hhmm(storedRow().wake_at_sensor), '06:30');
    assert.equal(storedRow().sensor_rejects, 1);
    assert.equal(hhmm(storedRow().wake_at), '06:05', 'beside the real wake, which is unchanged');
    // The raw readings pruned (esphome_retention_days): the stored row keeps the shadow; a fresh replay no longer has it.
    db.prepare('DELETE FROM esphome_readings').run();
    assert.equal(hhmm(storedRow().wake_at_sensor), '06:30', 'the stored value outlives the raw readings');
    assert.deepEqual([nightAt(t, NOON).wake_at_sensor, nightAt(t, NOON).sensor_rejects], [null, null], 'a fresh replay has none');
    // ...and a re-store (a provisional night re-stored by the job, or the admin Recompute) writes what it saw: NULL.
    storeAt(t, plus(at(7, 0, 1), 121));
    assert.deepEqual([storedRow().wake_at_sensor, storedRow().sensor_rejects], [null, null]);
  });

  test('a locked (reviewed) night is never re-stored, so it keeps the shadow it had', (t) => {
    layNight({ falseExit: true });
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    storeAt(t, plus(at(7, 0, 1), 61));
    db.prepare(`INSERT INTO sleep_reviews (child_id, night_date, true_wake_at) VALUES (?, ?, ?)`).run(CHILD, DATE, sqlTime(at(6, 30, 1)));
    db.prepare('DELETE FROM esphome_readings').run();
    const refused = storeAt(t, plus(at(7, 0, 1), 121), { allowDowngrade: false });
    assert.equal(refused.refused, 'reviewed');
    assert.equal(hhmm(storedRow().wake_at_sensor), '06:30');
  });

  test('a corrected WAKE and a "no one was in the bed" night show no sensor shadow; other corrections keep it; the stored row keeps it', (t) => {
    layNight({ falseExit: true });
    laySensor(addDevice(CHILD), inBedUntil(at(6, 30, 1)));
    storeAt(t, NOON);
    const fresh = nightAt(t, NOON);
    assert.equal(hhmm(fresh.wake_at_sensor), '06:30', 'precondition: there is a shadow to hide');
    assert.equal(hhmm(fresh.wake_at), '06:05', 'precondition: the detector\'s wake');
    const keysOf = (o) => Object.keys(o).filter((k) => NEW_KEYS.includes(k));
    // [review, is the shadow hidden?]. Hidden only where the wake SHOWN is no longer the detector's: a changed wake,
    // or "nobody was in the bed". An in-bed or onset correction, or the detector's own wake saved unchanged (what the
    // edit card sends), still shows the detector's wake, so the shadow beside it keeps its meaning.
    const cases = [
      [{ true_wake_at: sqlTime(at(6, 30, 1)) }, true],
      [{ nobody_in_bed: 1 }, true],
      [{ true_in_bed_at: sqlTime(at(19, 30)) }, false],
      [{ true_onset_at: sqlTime(at(19, 50)) }, false],
      [{ true_wake_at: fresh.wake_at }, false],
    ];
    for (const [review, hidden] of cases) {
      db.prepare('DELETE FROM sleep_reviews').run();
      const cols = Object.keys(review);
      db.prepare(`INSERT INTO sleep_reviews (child_id, night_date, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})`)
        .run(CHILD, DATE, ...Object.values(review));
      for (const [label, night] of [['fresh', fresh], ['stored', storedRow()]]) {
        const shown = applyCorrection(CHILD, night);
        assert.equal(shown.corrected, true, `${label} ${JSON.stringify(review)}: precondition, corrected`);
        assert.deepEqual(keysOf(shown), NEW_KEYS, `${label} ${JSON.stringify(review)}: the keys stay (an additive shape)`);
        assert.deepEqual([shown.wake_at_sensor, shown.sensor_rejects], hidden ? [null, null] : [night.wake_at_sensor, 1],
          `${label} ${JSON.stringify(review)}`);
      }
    }
    assert.equal(hhmm(storedRow().wake_at_sensor), '06:30', 'the stored row itself is never touched');
    db.prepare('DELETE FROM sleep_reviews').run();
    assert.equal(hhmm(applyCorrection(CHILD, fresh).wake_at_sensor), '06:30', 'no review: shown as computed');
  });
});
