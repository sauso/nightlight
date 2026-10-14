import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import { CLIPS_DIR } from './clipRecorder.js';
import { transitionSnapshotPath } from './bedTransitions.js';
import { getEventSnapshotFile } from './detectionEvents.js';
import { discardAllTimelapseFrames } from './timelapse.js';

// Deleting a child or a camera deletes EVERYTHING that belongs to it (owner decision, issues #540 and
// #554): rows AND files. Before this, DELETE /api/children/:id removed the child and its nights and
// DELETE /api/cameras/:id removed the camera and nothing else, so a parent's judged bed-transition frames
// (exempt from the age prune by design, see bedTransitions.js) outlived the child indefinitely and stayed
// fetchable by id for any signed-in user.
//
// ORDER, and why. A file and the row that names it must never disagree in the dangerous direction, i.e. a
// row left pointing at a file that is gone (a broken tile, and for a transition snapshot the id IS the
// file name, so the row is the only way left to find the file). So, per file-bearing row:
//     1. remove its file(s)   - a file that is already missing is fine, any OTHER error aborts here
//     2. remove its row       - straight away, in its own implicit transaction
// Each pair is therefore atomic enough in the one direction that matters: if step 1 throws, that row and
// everything not yet visited is still intact and still names its file; if the process dies between 1 and
// 2, the row survives pointing at a missing file (a 404 on one tile, retried by the next delete). What can
// NOT happen is a row gone while its file stays (an orphan nothing can name any more).
//
// These deletes are deliberately NOT wrapped in one big transaction: a rollback would restore rows whose
// files were already unlinked, which is exactly the state this ordering exists to rule out. Only the rows
// with no file behind them (samples, nights, reviews, the entity itself) go in one transaction, LAST, so
// the child/camera row is the final thing to disappear and a failed delete can simply be retried.
//
// ⚠️ Every file removal is jailed. A stored path comes from a database column, and a database can be
// restored from a backup, edited or imported, so it is not trusted: it must resolve to a regular file
// strictly inside the directory it belongs to (the clips dir, or the snapshot dirs via their id-named
// accessors). Anything else is skipped with a warning and the row is still deleted - the row is ours, the
// file it names is not.

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSafeSegment = (s) => typeof s === 'string' && s !== '.' && s !== '..' && SAFE_SEGMENT.test(s);

const inside = (root, abs) => abs.startsWith(root + path.sep);

// Remove one regular file, named by `rel` under `root`. Returns true if a file was removed.
// - anywhere but strictly inside root (an absolute path, `..`, root itself via `.` or an empty string, or a
//   symlinked directory component that leads out): skipped, warned. ONE check does all of it, on the REAL
//   path of the parent directory. path.resolve alone does not look through symlinks, so a lexical test would
//   let `clips/link/x` reach outside; and the real-path test already rejects every lexical escape (the
//   mutation run showed a lexical pre-check was fully redundant behind it, so it was removed rather than kept
//   as a second opinion nothing could disagree with).
// - missing: not an error (a prior partial delete, or a sweep, already took it).
// - a directory or other non-file: skipped. Never recursive: a stored path must not be able to remove a tree.
// - any other failure (EACCES, EBUSY, EIO): thrown, so the caller stops before deleting the row.
function removeFileUnder(root, rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const abs = path.resolve(root, rel);
  let realRoot;
  let realParent;
  try {
    realRoot = fs.realpathSync(root);
    realParent = fs.realpathSync(path.dirname(abs));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
  if (realParent !== realRoot && !inside(realRoot, realParent)) {
    logger.warn(`[purge] ignoring stored path outside ${root}: ${JSON.stringify(rel)}`);
    return false;
  }
  const target = path.join(realParent, path.basename(abs));
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (!st.isFile() && !st.isSymbolicLink()) {
    logger.warn(`[purge] ignoring stored path that is not a file: ${JSON.stringify(rel)}`);
    return false;
  }
  try {
    fs.unlinkSync(target); // a symlink is unlinked itself, never followed
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  return true;
}

const removeClipFile = (rel) => removeFileUnder(CLIPS_DIR, rel);

// A snapshot JPEG named by its row id. The accessors validate the id (positive integer) and return the
// file only if it exists, so a row with no image costs nothing and the name cannot be steered.
function removeTransitionSnapshot(id) {
  const file = transitionSnapshotPath(id);
  if (!file) return;
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function removeEventSnapshot(id) {
  const f = getEventSnapshotFile(id);
  if (!f) return;
  try { fs.unlinkSync(path.join(f.root, f.path)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// A whole directory named by an id, under CLIPS_DIR: the per-camera clip dir, the per-camera ring and a
// child's finished timelapses. Run AFTER the rows are gone, so it only ever removes files nothing references
// any more (strays from an earlier orphaning, ring segments). The name is validated as one safe segment and
// a link is unlinked rather than followed.
function removeDirUnderClips(...parts) {
  if (!parts.every(isSafeSegment)) return;
  const dir = path.join(CLIPS_DIR, ...parts);
  if (!inside(CLIPS_DIR, dir)) return;
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
  if (st.isSymbolicLink()) { fs.unlinkSync(dir); return; }
  fs.rmSync(dir, { recursive: true, force: true });
}

// file(s) first, then the row, one row at a time (see the header for why not one transaction).
function purgeRows(selectSql, param, removeFiles, deleteSql) {
  const del = db.prepare(deleteSql);
  for (const row of db.prepare(selectSql).all(param)) {
    removeFiles(row);
    del.run(row.id);
  }
}

const clipSiblingJpg = (rel) => (typeof rel === 'string' && /\.mp4$/i.test(rel) ? rel.replace(/\.mp4$/i, '.jpg') : null);

function purgeRecordingsWhere(column, id) {
  purgeRows(
    `SELECT id, path, thumb_path FROM recordings WHERE ${column} = ?`, id,
    (r) => { removeClipFile(r.path); removeClipFile(r.thumb_path); },
    'DELETE FROM recordings WHERE id = ?'
  );
}

function purgeTransitionsOfCameras(cameraIds) {
  for (const camId of cameraIds) {
    purgeRows(
      'SELECT id FROM bed_transitions WHERE camera_id = ?', camId,
      (r) => removeTransitionSnapshot(r.id),
      'DELETE FROM bed_transitions WHERE id = ?'
    );
  }
}

// Everything that belongs to a camera, then the camera. Throws (leaving the camera in place, so the admin
// can retry) if a file cannot be removed. The caller has already stopped every process that writes for it.
export function purgeCamera(cameraId) {
  purgeRows(
    'SELECT id, clip_path FROM detection_events WHERE camera_id = ?', cameraId,
    (r) => {
      removeEventSnapshot(r.id);
      removeClipFile(r.clip_path);
      removeClipFile(clipSiblingJpg(r.clip_path));
    },
    'DELETE FROM detection_events WHERE id = ?'
  );
  purgeRecordingsWhere('camera_id', cameraId);
  purgeTransitionsOfCameras([cameraId]);
  // Per-camera clip output (extractClip writes CLIPS_DIR/<cameraId>/...) and the segment ring
  // (CLIPS_DIR/.ring/<cameraId>), swept now that no row names anything in them.
  removeDirUnderClips(cameraId);
  removeDirUnderClips('.ring', cameraId);

  // camera_events and sensor_readings were kept on purpose when a camera was removed ("history survives
  // hardware replacement", db.js). The owner decided otherwise for #554: deleting a camera deletes
  // everything for it. camera_silences goes with the camera row (ON DELETE CASCADE).
  db.transaction(() => {
    db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(cameraId);
    db.prepare('DELETE FROM camera_events WHERE camera_id = ?').run(cameraId);
    db.prepare('DELETE FROM sensor_readings WHERE camera_id = ?').run(cameraId);
    // A child's "primary camera" pointer has no foreign key. Left alone it would name a camera that no
    // longer exists (and the id never comes back, so it could not even revive).
    db.prepare('UPDATE children SET primary_camera_id = NULL WHERE primary_camera_id = ?').run(cameraId);
    db.prepare('DELETE FROM cameras WHERE id = ?').run(cameraId);
  })();
}

// Everything that belongs to a child, then the child. The child's cameras are hardware and stay: they are
// unassigned (as before), and the bed transitions and activity samples recorded by them are deleted,
// because those are the readings of the bed the child was in. Returns the ids of the cameras that were
// unassigned, so the caller can reconcile their clip rings.
//
// Known limit: those rows carry a camera, not a child. A camera that was moved from one child to another
// has history from both, and it cannot be told apart, so deleting the CURRENT child clears the camera's
// whole history. Said in docs/ so nobody meets it as a surprise.
export function purgeChild(childId) {
  const cameraIds = db.prepare('SELECT id FROM cameras WHERE child_id = ?').all(childId).map((r) => r.id);
  purgeRecordingsWhere('child_id', childId);
  purgeRows(
    'SELECT id, path, thumb_path FROM timelapses WHERE child_id = ?', childId,
    (r) => { removeClipFile(r.path); removeClipFile(r.thumb_path); },
    'DELETE FROM timelapses WHERE id = ?'
  );
  purgeTransitionsOfCameras(cameraIds);
  // Frames of a night still in progress have no timelapses row, so the loops above cannot see them.
  // (Skipped for an id that is not one safe path segment: the id names a directory, and it is the row's own
  // id so it is ours to delete, but never a path we will follow. The row is still removed below.)
  if (isSafeSegment(childId)) discardAllTimelapseFrames(childId);
  removeDirUnderClips('timelapse', childId);

  db.transaction(() => {
    for (const camId of cameraIds) db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(camId);
    db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(childId);
    db.prepare('DELETE FROM sleep_reviews WHERE child_id = ?').run(childId);
    db.prepare('UPDATE cameras SET child_id = NULL WHERE child_id = ?').run(childId);
    // These cameras now belong to nobody, so no OTHER child may keep naming one as its primary (#655).
    for (const camId of cameraIds) {
      db.prepare(
        `UPDATE children SET primary_camera_id = NULL
          WHERE primary_camera_id = ? AND id IS NOT (SELECT child_id FROM cameras WHERE id = ?)`
      ).run(camId, camId);
    }
    db.prepare('DELETE FROM children WHERE id = ?').run(childId);
  })();
  return cameraIds;
}
