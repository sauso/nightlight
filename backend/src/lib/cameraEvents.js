import db from '../db.js';
import { logger } from './logger.js';

// Persistent camera up/down/restart history, surfaced in the app's "Camera history"
// panel (Settings, admin-only). This exists so the everyday question - "was that camera
// drop the camera itself, the server, or just my phone?" - can be answered from the app
// after the fact, instead of only by reading `docker logs`. A wedged client-side WebRTC
// connection (see KNOWN-ISSUES.md) leaves NO event here, because from the server's point
// of view nothing happened - that absence is itself the diagnostic signal.
//
// Since #552 it also says WHO, for the events a person causes from a camera tile: a silence of its
// alerts, a stream restart, a camera reboot (including one that failed). The history is admin-only
// (routes/events.js); the support bundle reduces the person to "person"/"system" (routes/diagnostics.js).
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
  RESTART: 'restart', // the camera's transcoder was restarted (crash, glitch, watchdog, or a person)
  // A person silenced (or un-silenced) every alert from one camera from its tile (#552). One type for
  // both directions; the detail says which ("muted for N min" / "un-muted").
  SNOOZE: 'snooze',
};

// `actor` (#552) is who did it: `{ user_id, username }` from lib/actor.js, or null for the system (a
// watchdog, a crashed stream). Copied into the row, not joined, for the same reason camera_name is.
const insertStmt = db.prepare(
  `INSERT INTO camera_events (camera_id, camera_name, type, detail, actor_user_id, actor_username)
   VALUES (@camera_id, @camera_name, @type, @detail, @actor_user_id, @actor_username)`
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
 * Write one camera event and THROW if it cannot be written (#552, review finding B10). For a caller
 * whose action must not happen without its history row, inside a `db.transaction`: a silence is applied
 * only together with the row saying who applied it, so a failed write rolls the silence back too. Does
 * not prune (that is a second write the action must not depend on); call pruneCameraEvents() after the
 * transaction commits.
 */
export function insertCameraEvent(cameraId, cameraName, type, detail = null, actor = null) {
  insertStmt.run({
    camera_id: cameraId,
    camera_name: cameraName,
    type,
    detail,
    actor_user_id: actor?.user_id ?? null,
    actor_username: actor?.username ?? null,
  });
}

/** The pruning recordCameraEvent does after each insert, best-effort, for a caller of insertCameraEvent. */
export function pruneCameraEvents() {
  try {
    prune();
  } catch (err) {
    logger.error('Failed to prune camera events:', err.message);
  }
}

/**
 * Record a camera event. Fire-and-forget: never throws into the caller (a logging
 * failure must not take down a transcoder restart or the watchdog loop). Also the path for a
 * person's restart or reboot (#552): the camera has already acted by the time this runs, and a
 * restart cannot be undone, so a failed history write must not turn a done restart into an error.
 * Compare insertCameraEvent, which a silence uses because a silence CAN be not applied.
 */
export function recordCameraEvent(cameraId, cameraName, type, detail = null, actor = null) {
  try {
    insertCameraEvent(cameraId, cameraName, type, detail, actor);
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

// Wipe the whole camera up/down/restart history (admin action). Returns how many rows were removed.
export function clearCameraEvents() {
  return db.prepare('DELETE FROM camera_events').run().changes;
}
