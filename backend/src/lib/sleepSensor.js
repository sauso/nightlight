// ★ #917 (a follow-up to #506): THE ESPHOME RADAR SENSOR AS A SHADOW SECOND OPINION ON THE MORNING EXIT.
//
// The one place sleep code reads the raw ESPHome tables (esphome-boundaries.test.js enforces that, and that it only
// ever SELECTs). It turns a child's per-minute ESPHome rows into one tri-state value per UTC minute, "were a person's
// vital signs measured at the bed in this minute?", and holds the rule computeNight's SHADOW pass applies with it.
// Nothing here changes a wake, a figure, a push or an alert: computeNight stores the shadow pass's wake beside the real
// one (`sleep_nights.wake_at_sensor`) for comparison, and that is all (see computeNight in sleepAnalysis.js).
//
// WHY A SHADOW AND NOT A RULE (plan review, 2026-10-31, two reviewers, verified by running): the sensor cannot tell a
// child from an adult. Pretending a parent's vital signs appear 2-4 minutes after a REAL exit (six valid minutes, six
// replayed mornings) moved the rule's wake 56, 83, 88 and 91 minutes later on four of them (the other two: the exit was
// not the scan's, or nothing later qualified and it was handed back). That is THE reason it
// only shadows the real wake, and it is pinned as a documented shadow error by the test "F1" in
// sleep-sensor-shadow.test.js. The owner decided to collect evidence first (KNOWN-ISSUES.md, docs/esphome.md).
//
// ⚠️ EVERY NUMBER BELOW WAS MEASURED ON ONE HOUSE: two children, one radar sensor each, three labelled nights
// (2026-10-28 to 2026-10-30, 85 camera exits, 21 of them labelled real, brief or false). Sensor A (one child) was good;
// sensor B (the other) read all zeros for long stretches while the camera said the child was in bed (21 minutes,
// 12 minutes, and 205 minutes on one night). Both wake corrections the rule made were on the same child and sensor A.
// Another sensor model, another placement, another firmware or another bed is a hypothesis these numbers have not
// been tested on. The shadow exists to find out.
import db from '../db.js';
import { guessEsphomeCategory } from './esphomeRoles.js';

const MINUTE_MS = 60000;

// VALID VITAL SIGNS IN A MINUTE (frozen before any exit was compared with it, 2026-10-31): a heart-rate row with at
// least VITALS_HR_MIN_N non-zero updates, OR a breathing-rate row with at least VITALS_RR_MIN_N. `n` counts the
// minute's non-zero updates (esphome_readings; a zero there usually means "no reading", docs/esphome.md). These are
// the definition an earlier look at the same sensors used, not tuned to the exits: variants (the 1.0 placeholder
// counted, a minute with no distance counted invalid, no distance cut at all) changed 0 of 504 exit-and-clock cells.
// ⚠️ They assume the device reports SEVERAL TIMES A MINUTE, as the stock firmware on the measured sensors did. A device
// configured to report less often (a `throttle` filter, a 60 s update interval) never reaches them, every minute reads
// "no vital signs", and the shadow silently rejects nothing: the safe direction, but it says nothing either.
export const VITALS_HR_MIN_N = 3;
export const VITALS_RR_MIN_N = 30;
// Some of these sensors send a breathing rate of 1.0 as a placeholder (docs/esphome.md stores it as sent). A minute
// whose breathing-rate mean is below this is not a measured breath. Heart rate has no such placeholder on record.
export const RR_PLACEHOLDER_BELOW = 2;
// THE OWNER'S 1 m RULE: vital signs measured further than this from the sensor are not the child's. Kept because it
// is the owner's rule and costs nothing, but ⚠️ IT IS WEAK and must not be presented as protection against an adult at
// the bed: after 4 of the 6 labelled real wakes the distance read a flat 57-75 cm over an EMPTY bed, so on the measured
// nights it excluded nothing. Only the update counts above told those minutes apart.
export const MAX_DISTANCE_CM = 100;
// The DISTANCE UNIT CONTRACT. The measured sensors report centimetres (`unit` 'cm', checked against the bed). Metres
// and millimetres are converted. Any other unit, or none, means the distance cannot be read: a minute whose distance
// reading has such a unit is NOT valid vital signs (the safe direction: it can only fail to reject). A minute with no
// distance reading at all (no row, or a row of only zeros) does not fail the cut: measured, and counting it either way
// changed nothing (the variants above), so the frozen definition is kept.
const UNIT_TO_CM = Object.freeze({ cm: 1, m: 100, mm: 0.1 });
// A minute's row is written about this long after the next minute starts (#506: esphomeManager's minute tick). At a
// clock earlier than that the minute is UNKNOWN, never "no vital signs": a replay of a stored database at an earlier
// clock must not read rows that did not exist yet, and a live compute reads the same thing as a replay would.
export const ROW_READABLE_DELAY_MS = 10;

// THE RULE (R2 in the plan): a camera `out_of_bed` is contradicted when valid vital signs are present in at least
// SENSOR_REJECT_MIN_VITALS of the SENSOR_REJECT_WINDOW_MIN minutes after the exit's own minute, [e+1, e+10]. The exit's
// own minute is left out: the child is still climbing out in it.
// Measured on the three labelled nights, at 15 clocks each: the real wakes had 0, 1, 1, 1, 2 and 2 such minutes; the
// false exits (the child moved but stayed in bed) 9 or 10, all twelve of them; the three brief exits that returned
// 1, 8 and 9. 6 sits 4 above the highest real wake and 3 below the lowest false exit. 10 minutes, not 5: at 5 the
// margin was one minute. 103 variants of the rule made no computed result worse and rejected no real wake, and the
// rule as written changed two wakes, both to the owner's true time (25 and 38 minutes early before). What it did NOT
// see: an adult at the bed right after a real exit (the reason it is a shadow, above), a second sleeper in the bed,
// a pet, or a sensor placed differently.
export const SENSOR_REJECT_WINDOW_MIN = 10;
export const SENSOR_REJECT_MIN_VITALS = 6;

// A distance in centimetres, or null when the unit is not one of the contract's (see UNIT_TO_CM).
export function distanceCm(value, unit) {
  const factor = UNIT_TO_CM[String(unit ?? '').trim().toLowerCase()];
  return factor == null || !Number.isFinite(value) ? null : value * factor;
}

// Did ONE device measure valid vital signs in one minute? `hr`, `rr` and `dist` are that device's rows for the minute
// ({ n, mean, unit }), each possibly absent. Per DEVICE, never per child (plan review): two devices on one child never
// lend each other a distance, so a sensor across the room cannot borrow the bedside one's 50 cm.
export function deviceMinuteHasVitals({ hr, rr, dist } = {}) {
  const hrOk = !!hr && hr.n >= VITALS_HR_MIN_N;
  const rrOk = !!rr && rr.n >= VITALS_RR_MIN_N && !(rr.mean != null && rr.mean < RR_PLACEHOLDER_BELOW);
  if (!hrOk && !rrOk) return false;
  if (!dist || !(dist.n > 0) || dist.mean == null) return true; // no distance this minute: see UNIT_TO_CM
  const cm = distanceCm(dist.mean, dist.unit);
  return cm != null && cm <= MAX_DISTANCE_CM;
}

// SELECT ONLY. Every entity that was ever this child's, retired ones included: a device moved to another child is
// retired and cloned with new ids (esphomeManager's acceptEntities), so the earlier rows stay under the earlier ids and
// belong to the child they were recorded for. The `active` flag is deliberately not read.
const entitiesStmt = db.prepare(
  'SELECT id, device_id, name, object_id, device_class, unit FROM esphome_entities WHERE child_id = ?'
);
// One entity's rows over a minute range, by the primary key (entity_id, bucket).
const readingsStmt = db.prepare(
  'SELECT bucket, mean, n FROM esphome_readings WHERE entity_id = ? AND bucket >= ? AND bucket < ?'
);
const ROLE_KEY = Object.freeze({ heart_rate: 'hr', respiratory_rate: 'rr', distance: 'dist' });

// The child's sensor minutes over [startMs, endMs): one value per UTC minute, index i = the minute starting at
// startMs + i minutes. computeNight passes its own minute origin (window start minus the 3 h lookbehind), so an index
// here is the same index as its per-minute arrays and `txIdx`. `startMs` must be a whole UTC minute (that origin always
// is); anything else THROWS, because a shifted array would silently score the wrong minutes.
//   true  — at least one of the child's devices measured valid vital signs (deviceMinuteHasVitals);
//   false — rows exist for the child's entities in that minute (any entity: an illuminance or distance row says the
//           device was connected), none with valid vital signs; a row of only zeros is false, not null;
//   null  — no row at all for any of the child's entities: a gap, a disconnect (about two minutes around a restart),
//           a minute past `endMs`, or one not yet readable at `nowMs` (ROW_READABLE_DELAY_MS).
// Returns null (no sensor) when the child has no heart-rate or breathing-rate row in the range at all: no entity, or
// only other kinds. computeNight then runs no shadow pass and stores NULL, exactly as before this file existed.
export function sensorMinutesFor(childId, startMs, endMs, { nowMs = Date.now() } = {}) {
  if (!Number.isInteger(startMs / MINUTE_MS)) throw new RangeError('sensorMinutesFor: startMs must be a whole UTC minute');
  const startMin = startMs / MINUTE_MS;
  const length = Math.max(0, Math.ceil((endMs - startMs) / MINUTE_MS));
  // Minute m is readable when (m + 1) * 60000 + ROW_READABLE_DELAY_MS <= nowMs, i.e. m < floor((nowMs - delay) / 60000).
  const endMin = Math.min(startMin + length, Math.floor((nowMs - ROW_READABLE_DELAY_MS) / MINUTE_MS));
  if (!(endMin > startMin)) return null;
  const perMinute = new Map(); // minute -> Map(device id -> { hr, rr, dist })
  let vitalsSeen = false;
  for (const e of entitiesStmt.all(childId)) {
    const key = ROLE_KEY[guessEsphomeCategory(e)] || null;
    for (const r of readingsStmt.iterate(e.id, startMin, endMin)) {
      let devices = perMinute.get(r.bucket);
      if (!devices) perMinute.set(r.bucket, (devices = new Map())); // presence: ANY entity's row
      if (!key) continue;
      if (key !== 'dist') vitalsSeen = true;
      let d = devices.get(e.device_id);
      if (!d) devices.set(e.device_id, (d = {}));
      // Two entities of one role on one device in one minute (a retired entity and its clone, in the minute of the
      // move): the row with more updates, as the measurement did.
      if (!d[key] || r.n > d[key].n) d[key] = { n: r.n, mean: r.mean, unit: e.unit };
    }
  }
  if (!vitalsSeen) return null;
  const minutes = new Array(length).fill(null);
  for (const [bucket, devices] of perMinute) {
    let valid = false;
    for (const d of devices.values()) if (deviceMinuteHasVitals(d)) { valid = true; break; }
    minutes[bucket - startMin] = valid;
  }
  return minutes;
}

// How many minutes of [exitIdx + 1, exitIdx + SENSOR_REJECT_WINDOW_MIN] read valid vital signs. Strictly `=== true`:
// an unknown minute (null, or past the array's end) never counts, so a gap can only fail to reject.
export function vitalsAfterExit(minutes, exitIdx) {
  let n = 0;
  for (let k = 1; k <= SENSOR_REJECT_WINDOW_MIN; k++) if (minutes[exitIdx + k] === true) n++;
  return n;
}

// THE RULE: is the exit in minute `exitIdx` contradicted by the sensor? See SENSOR_REJECT_MIN_VITALS.
export function sensorContradictsExit(minutes, exitIdx) {
  return vitalsAfterExit(minutes, exitIdx) >= SENSOR_REJECT_MIN_VITALS;
}
