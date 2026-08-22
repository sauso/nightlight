import db from '../db.js';
import { logger } from './logger.js';

// Persisted crib-boundary transitions from the frame-diff detector — a child leaving the crib
// ('out_of_bed') or being placed into it ('into_bed'). These are the durable form of the [oob]/[intobed]
// log lines: a low-rate, meaningful signal (not raw motion), kept in their own table so they never
// pollute the cooldown-throttled detection_events alert feed. sleepAnalysis.js reads them to correct the
// sleep onset and morning wake (see its shadow computation). LOG-ONLY at the alert layer still — nothing
// here pushes or records a clip.

export const TRANSITION = {
  OUT_OF_BED: 'out_of_bed',
  INTO_BED: 'into_bed',
};

// Retained a bit longer than the 30-day activity_samples window so a recompute of any browsable night
// still has its transitions. Cheap rows, so this is generous.
const MAX_AGE_DAYS = 45;

const insertStmt = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak) VALUES (@camera_id, @type, @peak)`
);
const pruneByAgeStmt = db.prepare(`DELETE FROM bed_transitions WHERE created_at < datetime('now', ?)`);

// Prune runs rarely (a transition is a once-per-couple-minutes-at-most event), so an age sweep on each
// insert is negligible and keeps the table bounded without a separate scheduler.
export function recordBedTransition(cameraId, type, peak = null) {
  try {
    insertStmt.run({ camera_id: cameraId, type, peak: peak == null ? null : Math.round(peak * 1000) / 1000 });
    pruneByAgeStmt.run(`-${MAX_AGE_DAYS} days`);
  } catch (err) {
    logger.error('Failed to record bed transition:', err.message);
  }
}

// All transitions for the given cameras within [startSql, endSql) (UTC 'YYYY-MM-DD HH:MM:SS' strings),
// ascending by time. Returns [{ camera_id, type, created_at, peak }]. Empty array for no cameras.
export function getBedTransitions(cameraIds, startSql, endSql) {
  if (!cameraIds || cameraIds.length === 0) return [];
  const ph = cameraIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT camera_id, type, created_at, peak FROM bed_transitions
         WHERE camera_id IN (${ph}) AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC`
    )
    .all(...cameraIds, startSql, endSql);
}
