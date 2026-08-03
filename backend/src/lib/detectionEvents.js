import db from '../db.js';
import { logger } from './logger.js';

// Persistent "Recent alerts" history — motion (and later sound) detections, surfaced in
// the app as its own list, separate from the camera up/down/restart history in
// cameraEvents.js. Same design: denormalized camera_name (survives rename/delete), no FK,
// pruned so it can't grow unbounded. This is what the detect→push pipeline writes to; the
// in-app list works with or without push wired up.

// Detections are rate-limited per camera by the detector's own cooldown, so this stays
// low-frequency in practice; the caps are a hard backstop.
const MAX_ROWS = 2000;
const MAX_AGE_DAYS = 30;

// Known alert types (kept small/stable so the UI can label/style them).
export const ALERT = {
  MOTION: 'motion',
  SOUND: 'sound', // reserved for the sound-detection slice
};

const insertStmt = db.prepare(
  `INSERT INTO detection_events (camera_id, camera_name, type, detail)
   VALUES (@camera_id, @camera_name, @type, @detail)`
);
const pruneByAgeStmt = db.prepare(`DELETE FROM detection_events WHERE created_at < datetime('now', ?)`);
const pruneByCountStmt = db.prepare(
  `DELETE FROM detection_events WHERE id NOT IN (
     SELECT id FROM detection_events ORDER BY id DESC LIMIT ?
   )`
);

function prune() {
  pruneByAgeStmt.run(`-${MAX_AGE_DAYS} days`);
  pruneByCountStmt.run(MAX_ROWS);
}

// Fire-and-forget: a logging failure must never take down the detector loop. Returns the
// inserted row's id (or null) so callers can hang a push notification off a real event.
export function recordDetectionEvent(cameraId, cameraName, type, detail = null) {
  try {
    const info = insertStmt.run({ camera_id: cameraId, camera_name: cameraName, type, detail });
    prune();
    return info.lastInsertRowid;
  } catch (err) {
    logger.error('Failed to record detection event:', err.message);
    return null;
  }
}

export function getRecentDetectionEvents(limit = 200) {
  return db
    .prepare('SELECT * FROM detection_events ORDER BY id DESC LIMIT ?')
    .all(Math.min(limit, MAX_ROWS));
}
