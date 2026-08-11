import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';

// One JPEG per detection event, named <id>.jpg, kept next to the DB. Stored on disk (not as a
// DB blob) so the SQLite file stays small; pruned in lockstep with the rows below.
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const SNAPSHOT_DIR = path.join(DATA_DIR, 'detection-snapshots');
try {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
} catch (err) {
  logger.error('Failed to create detection-snapshots dir:', err.message);
}

function snapshotFile(id) {
  // ids are integer autoincrement — coerce and validate so a request param can't escape the dir.
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return path.join(SNAPSHOT_DIR, `${n}.jpg`);
}

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
// The same rows the two prunes above are about to delete, restricted to ones that actually have
// a stored image, so we can remove their JPEGs and not orphan files on disk.
const agedWithSnapshotStmt = db.prepare(
  `SELECT id FROM detection_events WHERE created_at < datetime('now', ?) AND snapshot = 1`
);
const overCountWithSnapshotStmt = db.prepare(
  `SELECT id FROM detection_events WHERE snapshot = 1 AND id NOT IN (
     SELECT id FROM detection_events ORDER BY id DESC LIMIT ?
   )`
);

function unlinkSnapshot(id) {
  const file = snapshotFile(id);
  if (file) fs.rm(file, { force: true }, () => {});
}

function prune() {
  // Collect the doomed rows' ids before deleting, then delete rows, then remove their files.
  const doomed = [
    ...agedWithSnapshotStmt.all(`-${MAX_AGE_DAYS} days`),
    ...overCountWithSnapshotStmt.all(MAX_ROWS),
  ];
  pruneByAgeStmt.run(`-${MAX_AGE_DAYS} days`);
  pruneByCountStmt.run(MAX_ROWS);
  for (const { id } of doomed) unlinkSnapshot(id);
}

const markSnapshotStmt = db.prepare('UPDATE detection_events SET snapshot = 1 WHERE id = ?');

// Persist the alert-time image for an event and flag the row. Best-effort: any failure is logged
// and swallowed so it can never disturb the detection pipeline (the event row still stands).
export function saveEventSnapshot(id, buffer) {
  const file = snapshotFile(id);
  if (!file || !buffer) return;
  try {
    fs.writeFileSync(file, buffer);
    markSnapshotStmt.run(id);
  } catch (err) {
    logger.error(`Failed to save detection snapshot for event ${id}:`, err.message);
  }
}

// Absolute path to an event's stored JPEG, or null if there isn't one (used by the serving route).
export function getEventSnapshotFile(id) {
  const file = snapshotFile(id);
  return file && fs.existsSync(file) ? file : null;
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

// Wipe the whole "Recent alerts" history (admin action). Returns how many rows were removed.
export function clearDetectionEvents() {
  const changes = db.prepare('DELETE FROM detection_events').run().changes;
  // Best-effort: remove every stored JPEG too, so a cleared history leaves no images behind.
  try {
    for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
      if (name.endsWith('.jpg')) fs.rm(path.join(SNAPSHOT_DIR, name), { force: true }, () => {});
    }
  } catch {
    // Directory missing / unreadable — nothing to clean.
  }
  return changes;
}
