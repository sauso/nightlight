import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { reconcileEsphomeChildDeletion } from './esphomeManager.js';
import { logger } from './logger.js';
import { CLIPS_DIR } from './clipRecorder.js';
import { removeLeafDir, unlinkMediaFile } from './mediaFiles.js';
import { transitionSnapshotFile } from './bedTransitions.js';
import { eventSnapshotFile } from './detectionEvents.js';

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
//
// The whole-directory sweeps (below) are jailed harder, because a recursive removal is the one thing here that
// can take a tree: every parent of the swept folder must resolve INSIDE the real clips folder, and if one
// does not the purge REFUSES (throws) before it deletes anything (#719 review: `clips/timelapse` or
// `clips/.ring` made a link to a folder elsewhere had that folder's contents deleted).

const inside = (root, abs) => abs.startsWith(root + path.sep);

// The real path, or null when it (or a parent) does not exist: a missing folder has nothing in it to remove.
// Any OTHER failure (EACCES, ELOOP, EIO) is thrown, never read as "missing": a path that cannot be resolved
// cannot be shown to be inside the jail, and calling it missing would let its row be deleted while the file
// stays (#719 review: the old catch-all was a surviving mutant).
function realOrNull(p) {
  try {
    return fs.realpathSync(p); // fence-ok: resolves a folder to jail a delete under it; reads no file
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

// Remove one regular file, named by `rel` under `root`. Returns true if a file was removed.
// - anywhere but strictly inside root (an absolute path, `..`, root itself via `.` or an empty string, or a
//   symlinked directory component that leads out): skipped, warned. ONE check does all of it, on the REAL
//   path of the parent directory. path.resolve alone does not look through symlinks, so a lexical test would
//   let `clips/link/x` reach outside; and the real-path test already rejects every lexical escape (the
//   mutation run showed a lexical pre-check was fully redundant behind it, so it was removed rather than kept
//   as a second opinion nothing could disagree with).
// - missing: not an error (a prior partial delete, or a sweep, already took it).
// - a directory or other non-file: skipped. Never recursive: a stored path must not be able to remove a tree.
// - any other failure (EACCES, EBUSY, EIO), including one resolving the path: thrown, so the caller stops
//   before deleting the row.
function removeFileUnder(root, rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  const abs = path.resolve(root, rel);
  const realRoot = realOrNull(root);
  const realParent = realRoot && realOrNull(path.dirname(abs));
  if (!realParent) return false;
  if (realParent !== realRoot && !inside(realRoot, realParent)) {
    logger.warn(`[purge] ignoring stored path outside ${root}: ${JSON.stringify(rel)}`);
    return false;
  }
  const target = path.join(realParent, path.basename(abs));
  let st;
  try {
    st = fs.lstatSync(target); // fence-ok: lstat only tells a file or link (removed) from a folder (skipped)
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (!st.isFile() && !st.isSymbolicLink()) {
    logger.warn(`[purge] ignoring stored path that is not a file: ${JSON.stringify(rel)}`);
    return false;
  }
  // unlinkMediaFile (#553 phase 2b): a flat unlink that re-checks the folder chain and never follows a link, so a
  // symlink is removed itself. It returns false for "already gone" and THROWS for anything else, as this did.
  return unlinkMediaFile(target, { root: realRoot });
}

const removeClipFile = (rel) => removeFileUnder(CLIPS_DIR, rel);

// A snapshot JPEG named by its row id. The path builders validate the id (positive integer), so the name
// cannot be steered. Unlinked STRAIGHT AWAY, with no existence check first (#719 re-review): the old check was
// fs.existsSync, which answers false for a file it cannot stat (EACCES on its folder, EIO), so such a photo
// counted as missing, its row was deleted and the file stayed. The unlink itself tells the truth: only
// ENOENT / ENOTDIR mean "not there" (the same rule as realOrNull above); anything else stops the purge.
function unlinkUnlessMissing(file) {
  try {
    fs.unlinkSync(file); // app-only: a snapshot JPEG in private/, which the media user cannot reach
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
}
function removeTransitionSnapshot(id) {
  const file = transitionSnapshotFile(id);
  if (file) unlinkUnlessMissing(file);
}
function removeEventSnapshot(id) {
  const file = eventSnapshotFile(id);
  if (file) unlinkUnlessMissing(file);
}

// --- per-id folders ---------------------------------------------------------------------------------------
//
// A folder named by an entity id, swept whole: CLIPS_DIR/<cameraId> (alert clips, recordings),
// CLIPS_DIR/.ring/<cameraId> (the segment ring), CLIPS_DIR/.concat/<cameraId> (concat lists a killed cut left),
// CLIPS_DIR/timelapse/<childId> (finished timelapses) and
// CLIPS_DIR/.timelapse-frames/<childId> (frames of a night not yet assembled, which have no row at all).
//
// ONLY FOR A UUID-SHAPED ID (#719 review). Every id the app mints is a v4 UUID (routes/cameras.js and
// routes/children.js, `uuid()`), but a database can be restored, edited or seeded, and the clips folder holds
// SHARED folders under ordinary names: a camera with the id `timelapse` deleted every child's finished
// timelapses, `.ring` every camera's ring, and `demo-seed` (lib/demoSeed.js) or a future folder would go the
// same way. A deny-list of reserved names misses the next shared folder; an allow-list of the one shape the app
// produces cannot. For any other id the sweep is skipped with a warning: its rows (and every file a row names)
// are still deleted, only unreferenced strays in its folder stay. Known limit, stated in docs/recording.md.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID.test(s);

// The per-id folders of one entity, as path parts under CLIPS_DIR. Empty for an id that is not UUID-shaped.
function idFolders(kind, id) {
  if (!isUuid(id)) {
    logger.warn(`[purge] ${kind} id ${JSON.stringify(id)} is not a UUID: its folders under the clips folder are not swept`);
    return [];
  }
  return kind === 'camera' ? [[id], ['.ring', id], ['.concat', id]] : [['timelapse', id], ['.timelapse-frames', id]];
}

// Where `parts` really is: the REAL path of its parent joined with its own name, or null when the parent does not
// exist. The final component is deliberately NOT resolved, so a link there is removed itself, never followed.
// THROWS when the parent resolves outside the real clips folder: realpath resolves every component of the
// chain, so a link at ANY level (clips/.ring -> /elsewhere) is caught, which the old lstat of the final folder
// alone was not. Throwing rather than skipping stops the purge before the entity's row goes, so the admin is
// told and can retry once the link is gone (the error is code EPURGEJAIL, see purgeFailureReason).
function jailedUnderClips(parts) {
  const realRoot = realOrNull(CLIPS_DIR);
  if (!realRoot) return null;
  const dir = path.join(CLIPS_DIR, ...parts);
  const realParent = realOrNull(path.dirname(dir));
  if (!realParent) return null;
  if (realParent !== realRoot && !inside(realRoot, realParent)) {
    throw Object.assign(new Error(`refusing to sweep ${parts.join('/')}: its parent folder resolves outside the clips folder`), { code: 'EPURGEJAIL' });
  }
  return path.join(realParent, path.basename(dir));
}

// Sweep one per-id folder. Throws on any failure but "already gone" (rmSync's `force` covers only ENOENT), so a
// folder that cannot be removed stops the purge before the entity's row goes (#719 review: the timelapse
// helper used before swallowed every error, so with an unremovable frames folder the child was deleted, a photo
// of the bed every 2 minutes stayed on disk, and the log said the frames were discarded).
//
// FLAT for a folder the media user writes into (#553 phase 2b): .ring/<camera>, <camera> and timelapse/<child> are
// swept by removeLeafDir, one unlink per file, because a recursive walk of a folder another user can write into can be
// raced into deleting something outside it. The frame and concat folders are the app's alone (the media user can read
// them, not write them), so they keep the recursive removal.
const APP_ONLY_ROOTS = new Set(['.timelapse-frames', '.concat']);
function removeDirUnderClips(parts) {
  const dir = jailedUnderClips(parts);
  if (!dir) return;
  let st;
  try { st = fs.lstatSync(dir /* fence-ok: decides link, folder or absent */); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return; throw e; }
  if (st.isSymbolicLink()) { fs.unlinkSync(dir /* fence-ok: a link is removed itself */); return; }
  if (APP_ONLY_ROOTS.has(parts[0])) fs.rmSync(dir, { recursive: true, force: true /* app-only */ });
  else {
    try { removeLeafDir(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; } // gone since the lstat: nothing to sweep
  }
}

// A purge that throws is answered 409 with this in the body (the Remove dialog shows it). Plain words, and the
// error code rather than the message, which carries server paths.
export function purgeFailureReason(e) {
  if (e?.code === 'EPURGEJAIL') return 'a folder inside the clips folder is a link to somewhere outside it';
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return 'the server was not allowed to delete a file (permission denied)';
  if (e?.code === 'EBUSY') return 'a file was in use';
  return e?.code ? `a file could not be deleted (${e.code})` : 'a file could not be deleted';
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

// Every per-id folder is jail-checked BEFORE anything is deleted (and again when it is swept, in case it changed),
// so a link leading out refuses the whole purge up front instead of after half the history is gone.
function preflightFolders(folders) {
  for (const parts of folders) jailedUnderClips(parts);
}

// The same folder check on its own, for the camera DELETE route to run BEFORE it stops the camera (#719
// re-review). It is pure (it deletes nothing), and a refusal found only inside purgeCamera came after every leg
// was stopped, so the camera stayed dark (no stream, no alerts, no activity) until the 5-minute reconcile, and
// every retry restarted the gap. purgeCamera still runs it again itself. Throws as purgeCamera would.
export function preflightCameraPurge(cameraId) {
  preflightFolders(idFolders('camera', cameraId));
}

// Everything that belongs to a camera, then the camera. Throws (leaving the camera in place, so the admin
// can retry) if a file cannot be removed. The caller has already stopped every process that writes for it.
export function purgeCamera(cameraId) {
  const folders = idFolders('camera', cameraId);
  preflightFolders(folders);
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
  for (const parts of folders) removeDirUnderClips(parts);

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
  const folders = idFolders('child', childId);
  preflightFolders(folders);
  const cameraIds = db.prepare('SELECT id FROM cameras WHERE child_id = ?').all(childId).map((r) => r.id);
  purgeRecordingsWhere('child_id', childId);
  purgeRows(
    'SELECT id, path, thumb_path FROM timelapses WHERE child_id = ?', childId,
    (r) => { removeClipFile(r.path); removeClipFile(r.thumb_path); },
    'DELETE FROM timelapses WHERE id = ?'
  );
  purgeTransitionsOfCameras(cameraIds);
  // The finished-timelapse folder, and the frames of a night still in progress: those have no timelapses row,
  // so the loops above cannot see them. (Skipped for an id that is not UUID-shaped, see idFolders. The row is
  // still removed below.)
  for (const parts of folders) removeDirUnderClips(parts);

  db.transaction(() => {
    // #506: entity rows hold the child at recording time, even after a device is reassigned.
    const removeEspHome = db.prepare(`DELETE FROM esphome_readings WHERE (entity_id, bucket) IN
      (SELECT r.entity_id, r.bucket FROM esphome_readings r JOIN esphome_entities e ON e.id = r.entity_id
       WHERE e.child_id = ? LIMIT 1000)`);
    while (removeEspHome.run(childId).changes) { /* bounded statement */ }
    db.prepare('DELETE FROM esphome_entities WHERE child_id = ?').run(childId);
    db.prepare('UPDATE esphome_devices SET child_id = NULL WHERE child_id = ?').run(childId);
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
  reconcileEsphomeChildDeletion(childId);
  return cameraIds;
}
