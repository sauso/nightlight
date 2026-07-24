import db from '../db.js';
import { logger } from './logger.js';

// Persistent camera up/down/restart history, surfaced in the app's "Camera history"
// panel (Settings, admin-only). This exists so the everyday question - "was that camera
// drop the camera itself, the server, or just my phone?" - can be answered from the app
// after the fact, instead of only by reading `docker logs`. A wedged client-side WebRTC
// connection (see KNOWN-ISSUES.md) leaves NO event here, because from the server's point
// of view nothing happened - that absence is itself the diagnostic signal.
//
// Unlike the in-memory log ring buffer (logger.js), this is persisted to SQLite so it
// survives restarts - but it's aggressively pruned (below) so it stays a recent history,
// not an unbounded audit log that could grow the data volume without limit.

// Keep at most this many rows, and nothing older than this many days - whichever is
// tighter. Camera events are low-frequency (a healthy camera produces none for hours),
// so this is generous in practice while still hard-capping worst-case growth if a camera
// is flapping badly.
const MAX_ROWS = 2000;
const MAX_AGE_DAYS = 30;

// Known event types (kept small and stable so the UI can label/style them). Emitters
// should use these rather than inventing new strings ad hoc.
export const EVENT = {
  OFFLINE: 'offline', // stopped delivering frames (sustained, seen by the watchdog)
  ONLINE: 'online', //  resumed delivering frames after having been offline
  RESTART: 'restart', // the camera's transcoder was restarted (crash, glitch, or watchdog)
};

const insertStmt = db.prepare(
  `INSERT INTO camera_events (camera_id, camera_name, type, detail)
   VALUES (@camera_id, @camera_name, @type, @detail)`
);

// Prune is cheap and runs after each insert, but only actually deletes when there's
// something to delete. Age-based and count-based caps are applied together.
const pruneByAgeStmt = db.prepare(
  `DELETE FROM camera_events WHERE created_at < datetime('now', ?)`
);
const pruneByCountStmt = db.prepare(
  `DELETE FROM camera_events WHERE id NOT IN (
     SELECT id FROM camera_events ORDER BY id DESC LIMIT ?
   )`
);

function prune() {
  pruneByAgeStmt.run(`-${MAX_AGE_DAYS} days`);
  pruneByCountStmt.run(MAX_ROWS);
}

/**
 * Record a camera event. Fire-and-forget: never throws into the caller (a logging
 * failure must not take down a transcoder restart or the watchdog loop).
 */
export function recordCameraEvent(cameraId, cameraName, type, detail = null) {
  try {
    insertStmt.run({ camera_id: cameraId, camera_name: cameraName, type, detail });
    prune();
  } catch (err) {
    logger.error('Failed to record camera event:', err.message);
  }
}

/**
 * Most recent events first, capped. Shape matches the DB row (snake_case) - the frontend
 * consumes these directly.
 */
export function getRecentEvents(limit = 200) {
  return db
    .prepare('SELECT * FROM camera_events ORDER BY id DESC LIMIT ?')
    .all(Math.min(limit, MAX_ROWS));
}
