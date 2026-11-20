// A Nightlight Camera's heart rate and breathing rate, as minutes the night's display can use (lib/nightVitals.js).
//
// ⚠️ DISPLAY ONLY, like nightVitals itself: SELECT only, nothing here reaches a night's stored row, its score, summary,
// push or the sleep shadow (lib/sleepSensor.js reads ESPHome rows only and still does). Radar vitals from the camera
// were deliberately kept out of the sleep maths (owner, 2026-11-20); this is only what the card and timeline draw.
//
// WHAT COUNTS AS A MEASURED MINUTE is the same shape of rule as the sleep sensor's, with ONE number scaled to how the
// camera is read. ESPHome's stock radar reports about once a second and a minute needs 30 breathing updates (half of
// them); Nightlight asks the camera every 5 seconds (lib/cameraSensors.js), so a minute holds at most 12 samples and 30
// could never be reached. The breathing minimum is therefore scaled by the same half: CAMERA_RR_MIN_N = 6 of 12. The heart-rate
// minimum (3) already fits 12 and is kept, as are the 1.0 breathing placeholder and the 1 m distance cut. The number 6
// is a SCALING, not a measurement: nothing was recorded from a real nursery with this camera, and the radar's own
// accuracy is unvalidated (docs/esphome.md). A camera that later reports per-minute summaries should replace it.
//
// Rows flagged `simulated` (a bench camera's invented data) are READ and flagged, not hidden: the owner builds against
// them. The caller labels the display "Simulated sensors". They never reach a night's figures because nothing here does.
import db from '../db.js';
import { MAX_DISTANCE_CM, RR_PLACEHOLDER_BELOW, VITALS_HR_MIN_N } from './sleepSensor.js';

export const CAMERA_RR_MIN_N = 6;

// This child's cameras' rows over a minute range, by the table's primary key (camera, minute, metric). A camera that was
// switched off keeps its history; a camera moved to another child takes its earlier rows with it (rows follow the camera,
// as activity does). Only the three metrics the rule reads.
const readingsStmt = db.prepare(
  `SELECT r.camera_id AS camera, r.bucket, r.metric, r.n, r.mean, r.simulated
     FROM nlcam_readings r JOIN cameras c ON c.id = r.camera_id
    WHERE c.child_id = ? AND r.metric IN ('heart_rate', 'breathing_rate', 'distance_cm') AND r.bucket >= ? AND r.bucket < ?`
);
const ROLE = Object.freeze({ heart_rate: 'hr', breathing_rate: 'rr', distance_cm: 'dist' });

// The 1 m cut on the camera's own distance row for the minute; no distance that minute lets the vital sign stand (the
// ESPHome rule's frozen choice).
function distanceAllows(dist) {
  if (!dist || !(dist.n > 0) || !Number.isFinite(dist.mean)) return true;
  return dist.mean <= MAX_DISTANCE_CM;
}

export function validCameraHr(hr, dist) {
  return !!hr && hr.n >= VITALS_HR_MIN_N && Number.isFinite(hr.mean) && distanceAllows(dist);
}

export function validCameraRr(rr, dist) {
  return !!rr && rr.n >= CAMERA_RR_MIN_N && Number.isFinite(rr.mean) && rr.mean >= RR_PLACEHOLDER_BELOW && distanceAllows(dist);
}

// { perMinute: minute -> Map(camera id -> { hr, rr, dist, simulated }), vitalsSeen } over [startMin, endMin). `vitalsSeen`
// is true when a heart-rate or breathing-rate row exists in the range (a distance row alone does not count).
export function readCameraMinutes(childId, startMin, endMin) {
  const perMinute = new Map();
  let vitalsSeen = false;
  for (const r of readingsStmt.iterate(childId, startMin, endMin)) {
    const role = ROLE[r.metric];
    if (!role) continue;
    if (role !== 'dist') vitalsSeen = true;
    let cameras = perMinute.get(r.bucket);
    if (!cameras) perMinute.set(r.bucket, (cameras = new Map()));
    let c = cameras.get(r.camera);
    if (!c) cameras.set(r.camera, (c = { simulated: false }));
    c[role] = { n: r.n, mean: r.mean };
    if (r.simulated) c.simulated = true;
  }
  return { perMinute, vitalsSeen };
}
