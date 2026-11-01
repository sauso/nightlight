import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import { CLIPS_DIR } from './clipRecorder.js';
import { jailedMediaFile, resolveUnder, unlinkMediaFile } from './mediaFiles.js';
import { dataDirFrom, DETECTION_SNAPSHOTS_DIR, resolveSnapshotDir } from './dataPaths.js';

// One JPEG per detection event, named <id>.jpg, kept next to the DB. Stored on disk (not as a
// DB blob) so the SQLite file stays small; pruned in lockstep with the rows below.
// #553 phase 2a: next to the DB means DATA_DIR/private/detection-snapshots once the start-up move has run (it moves the
// folder WITH the database), the top-level one before that. Resolved once here (lib/dataPaths.js, resolveSnapshotDir);
// the app never moves it. Exported for demoSeed.js, which must fill the SAME folder this module serves from. The mkdir
// below never has to make private/ itself: db.js, imported first, already has.
const SNAPSHOT_DIR = resolveSnapshotDir(DETECTION_SNAPSHOTS_DIR, dataDirFrom());
export { SNAPSHOT_DIR as DETECTION_SNAPSHOT_DIR };
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
// The path alone, existing or not, for a delete (lib/entityPurge.js): see transitionSnapshotFile in bedTransitions.js.
export { snapshotFile as eventSnapshotFile };

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
// #932: the six pruning queries must agree so a protected row never loses its MP4 or snapshot.
const pruneByAgeStmt = db.prepare(`DELETE FROM detection_events WHERE protected = 0 AND created_at < datetime('now', ?)`);
const pruneByCountStmt = db.prepare(
  `DELETE FROM detection_events WHERE protected = 0 AND id NOT IN (
     SELECT id FROM detection_events WHERE protected = 0 ORDER BY id DESC LIMIT ?
   )`
);
// The same rows the two prunes above are about to delete, restricted to ones that actually have
// a stored image, so we can remove their JPEGs and not orphan files on disk.
const agedWithSnapshotStmt = db.prepare(
  `SELECT id FROM detection_events WHERE protected = 0 AND created_at < datetime('now', ?) AND snapshot = 1`
);
const overCountWithSnapshotStmt = db.prepare(
  `SELECT id FROM detection_events WHERE protected = 0 AND snapshot = 1 AND id NOT IN (
     SELECT id FROM detection_events WHERE protected = 0 ORDER BY id DESC LIMIT ?
   )`
);
// Same two prunes, restricted to rows that carry a recorded clip, so the (much larger) MP4 files are
// removed alongside the rows and never orphaned on disk.
//
// This is the BACKSTOP, not the user-facing retention. The configurable day and size caps shipped
// (lib/clipStorage.js reads them from settings; routes/settings.js re-runs the sweep on save, but
// only when a retention value actually CHANGED — a tightened cap applies at once instead of waiting
// for the next 15-minute sweep). This comment used to describe the caps as still to come (#317).
// Both mechanisms are wanted: the caps are
// what an admin controls, and this keeps a clip row and its MP4 from outliving each other whatever
// the caps are set to.
const agedWithClipStmt = db.prepare(
  `SELECT clip_path FROM detection_events WHERE protected = 0 AND created_at < datetime('now', ?) AND clip_path IS NOT NULL`
);
const overCountWithClipStmt = db.prepare(
  `SELECT clip_path FROM detection_events WHERE protected = 0 AND clip_path IS NOT NULL AND id NOT IN (
     SELECT id FROM detection_events WHERE protected = 0 ORDER BY id DESC LIMIT ?
   )`
);

function unlinkSnapshot(id) {
  const file = snapshotFile(id);
  if (file) fs.rm(file, { force: true }, () => {}); // app-only: snapshots live in private/
}

// Resolve+delete a clip MP4 (and its sibling thumbnail) from a stored relative clip_path. Guards
// against path escape so a crafted row can't reach outside CLIPS_DIR.
export function unlinkClip(relPath) {
  const abs = resolveUnder(relPath, CLIPS_DIR);
  if (!abs) return;
  // Synchronous: a retention sweep must actually finish deleting before it moves on / the process
  // can exit, otherwise a crash right after would leave the file behind while its row is already
  // cleared (orphaned on disk, uncounted by the size cap). A handful of files per sweep — cheap.
  // unlinkMediaFile: a flat unlink of one name inside a folder the media user writes into (#553 phase 2b).
  try { unlinkMediaFile(abs); } catch { /* ignore */ }
  try { unlinkMediaFile(abs.replace(/\.mp4$/i, '.jpg')); } catch { /* ignore */ }
}

function prune() {
  // Collect the doomed rows' files before deleting the rows, then delete rows, then remove files.
  const doomedSnaps = [
    ...agedWithSnapshotStmt.all(`-${MAX_AGE_DAYS} days`),
    ...overCountWithSnapshotStmt.all(MAX_ROWS),
  ];
  const doomedClips = [
    ...agedWithClipStmt.all(`-${MAX_AGE_DAYS} days`),
    ...overCountWithClipStmt.all(MAX_ROWS),
  ];
  pruneByAgeStmt.run(`-${MAX_AGE_DAYS} days`);
  pruneByCountStmt.run(MAX_ROWS);
  for (const { id } of doomedSnaps) unlinkSnapshot(id);
  for (const { clip_path } of doomedClips) unlinkClip(clip_path);
}

const markSnapshotStmt = db.prepare('UPDATE detection_events SET snapshot = 1 WHERE id = ?');

// Persist the alert-time image for an event and flag the row. Best-effort: any failure is logged
// and swallowed so it can never disturb the detection pipeline (the event row still stands).
export function saveEventSnapshot(id, buffer) {
  const file = snapshotFile(id);
  if (!file || !buffer) return;
  try {
    fs.writeFileSync(file, buffer);
    // The alert row can be gone by now: the caller awaits the snapshot grab first, and removing the camera in
    // that window deletes the row (#719 review). A file no row names is an orphan nothing can reach to delete,
    // so remove it.
    if (markSnapshotStmt.run(id).changes === 0) fs.rmSync(file, { force: true }); // app-only: snapshots live in private/
  } catch (err) {
    logger.error(`Failed to save detection snapshot for event ${id}:`, err.message);
  }
}

// A jailed { root, path } for an event's stored JPEG, or null if there isn't one (used by the
// serving route). Returning the dir + a bare filename lets the route hand res.sendFile a `root`
// option so Express itself enforces containment, on top of the integer-only id validation.
export function getEventSnapshotFile(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const file = path.join(SNAPSHOT_DIR, `${n}.jpg`);
  return fs.existsSync(file) ? { root: SNAPSHOT_DIR, path: `${n}.jpg` } : null; // app-only: snapshots live in private/
}

// --- Clip status (Stage 1 recording). The clip lives on the same detection_events row; these just
// move it through pending -> ready/failed as lib/clipCapture.js works the job. ---
const markClipPendingStmt = db.prepare("UPDATE detection_events SET clip_status = 'pending' WHERE id = ?");
const setClipReadyStmt = db.prepare(
  "UPDATE detection_events SET clip_status = 'ready', clip_path = @clip_path, clip_duration_s = @dur, clip_bytes = @bytes WHERE id = ?"
);
const setClipFailedStmt = db.prepare("UPDATE detection_events SET clip_status = 'failed' WHERE id = ?");

export function markClipPending(id) {
  try { markClipPendingStmt.run(id); } catch (e) { logger.error(`clip pending mark failed (${id}):`, e.message); }
}
export function setClipReady(id, relPath, durationS, bytes) {
  try {
    const { changes } = setClipReadyStmt.run({ clip_path: relPath, dur: Math.round(durationS) || null, bytes: bytes || null }, id);
    // Same as saveEventSnapshot: a clip cut after its camera was removed has no row left to name it (#719 review).
    if (changes === 0) unlinkClip(relPath);
  } catch (e) {
    logger.error(`clip ready mark failed (${id}):`, e.message);
  }
}
export function setClipFailed(id) {
  try { setClipFailedStmt.run(id); } catch (e) { logger.error(`clip failed mark failed (${id}):`, e.message); }
}

// A jailed { root, path } for an event's ready clip MP4, or null (used by the serving route).
// Validates the stored relative path stays under CLIPS_DIR, then returns CLIPS_DIR + that relative
// path; the route serves it with serveMediaFile (mediaFiles.js), which opens it once and re-checks it.
export function getEventClipFile(id) {
  const row = db.prepare('SELECT clip_path, clip_status FROM detection_events WHERE id = ?').get(id);
  if (!row || row.clip_status !== 'ready' || !row.clip_path) return null;
  // Contained under CLIPS_DIR, and a plain one-name file (mediaFiles.js): the route serves it with serveMediaFile.
  return jailedMediaFile(row.clip_path, CLIPS_DIR);
}

export function isProtectedEvent(id) {
  // #932: sweep SQL keeps every nonzero flag, so direct deletion must make the same decision.
  return !!db.prepare('SELECT protected FROM detection_events WHERE id = ?').get(id)?.protected;
}

// The playback lookup also checks that the path names an existing, safe file.
export function setEventProtected(id, value) {
  // An absent MP4 must not trap an already protected row forever (#932).
  if (value && !getEventClipFile(id)) return false;
  return db.prepare("UPDATE detection_events SET protected = ? WHERE id = ? AND clip_status = 'ready'")
    .run(Number(value), id).changes > 0;
}

// --- Retention accounting (lib/clipStorage.js sweeps against these). Deleting a clip clears its
// clip_* columns but KEEPS the alert row + snapshot — the event history is preserved, only the video
// goes. ---
const clearClipRowStmt = db.prepare(
  'UPDATE detection_events SET clip_status = NULL, clip_path = NULL, clip_duration_s = NULL, clip_bytes = NULL WHERE id = ?'
);
const expiredClipsStmt = db.prepare(
  "SELECT id, clip_path FROM detection_events WHERE protected = 0 AND clip_path IS NOT NULL AND created_at < datetime('now', ?)"
);
const readyClipsOldestFirstStmt = db.prepare(
  "SELECT id, clip_path, clip_bytes FROM detection_events WHERE protected = 0 AND clip_status = 'ready' AND clip_path IS NOT NULL ORDER BY id ASC"
);
const clipTotalsStmt = db.prepare(
  "SELECT COUNT(*) AS count, COALESCE(SUM(clip_bytes), 0) AS bytes FROM detection_events WHERE protected = 0 AND clip_status = 'ready' AND clip_path IS NOT NULL"
);
// #932: protected bytes must be visible, but excluded from the cap shared with the preview.
export function getProtectedAlertTotals() {
  return db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(clip_bytes), 0) AS bytes FROM detection_events WHERE protected <> 0 AND clip_status = 'ready' AND clip_path IS NOT NULL").get();
}

// #932: every automatic selector below excludes protected clips; the preview imports these same queries.
// Clips whose event is older than `days`, for age-based retention. Returns [{id, clip_path}].
export function getExpiredClips(days) {
  return expiredClipsStmt.all(`-${days} days`);
}
// Every ready clip, oldest first — for size-cap retention (delete oldest until under). [{id, clip_path, clip_bytes}].
export function getReadyClipsOldestFirst() {
  return readyClipsOldestFirstStmt.all();
}
// { count, bytes } of unprotected ready clips — for the cap and used-storage display.
export function getClipStorageTotals() {
  return clipTotalsStmt.get();
}
// Delete a clip's file(s) and clear its clip_* columns (keeps the alert row + snapshot).
export function deleteClip(id, relPath) {
  unlinkClip(relPath);
  try { clearClipRowStmt.run(id); } catch (e) { logger.error(`clear clip row failed (${id}):`, e.message); }
}

// Delete the clip belonging to a single event (looks up its path). Returns true if there was one.
// Used by the per-clip delete button and bulk clip management.
export function deleteClipForEvent(id) {
  const row = db.prepare('SELECT clip_path FROM detection_events WHERE id = ? AND clip_path IS NOT NULL').get(id);
  if (!row) return false;
  deleteClip(id, row.clip_path);
  return true;
}

// All events that currently have a playable clip, newest first — for the Clip Management screen.
// Metadata only (the clip itself streams from the serving route); capped so it can't balloon.
export function getClips(limit = 2000) {
  return db
    .prepare(
      `SELECT id, camera_id, camera_name, type, detail, created_at, snapshot, clip_duration_s, clip_bytes, protected
       FROM detection_events
       WHERE clip_status = 'ready' AND clip_path IS NOT NULL
       ORDER BY id DESC LIMIT ?`
    )
    .all(Math.min(limit, 5000));
}

// Protection outlives the recent-list limits; keep every protected alert reachable.
export function getProtectedClips() {
  return db.prepare(`SELECT id, camera_id, camera_name, type, detail, created_at, snapshot,
                            clip_duration_s, clip_bytes, protected
                       FROM detection_events
                      WHERE protected <> 0 AND clip_status = 'ready' AND clip_path IS NOT NULL
                      ORDER BY id DESC`).all();
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
  // #932: only unprotected rows are cleared. Their JPEGs and old orphan JPEGs can go; a
  // protected alert's snapshot must survive even though it shares this directory.
  const doomed = db.prepare('SELECT id FROM detection_events WHERE protected = 0').all();
  const changes = db.prepare('DELETE FROM detection_events WHERE protected = 0').run().changes;
  for (const { id } of doomed) unlinkSnapshot(id);
  try {
    for (const name of fs.readdirSync(SNAPSHOT_DIR)) {
      if (!name.endsWith('.jpg')) continue;
      const id = /^\d+\.jpg$/.test(name) ? Number(name.slice(0, -4)) : null;
      if (!id || !db.prepare('SELECT 1 FROM detection_events WHERE id = ? AND protected <> 0').get(id)) {
        fs.rm(path.join(SNAPSHOT_DIR, name), { force: true }, () => {}); // app-only: snapshots live in private/
      }
    }
  } catch {
    // Directory missing / unreadable — nothing to clean.
  }
  return changes;
}
