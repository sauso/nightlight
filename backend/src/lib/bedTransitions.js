import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import { captureSnapshot, fetchHttpSnapshot } from './snapshot.js';

// Persisted bed-boundary transitions from the frame-diff detector — a child leaving the bed
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

// The frame each transition fired on, kept on disk rather than in the DB (the same split
// detection_events uses) so the SQLite file stays small and a prune is a file delete.
//
// Why capture at all: the detector says WHEN it thinks the bed changed, and until now there was no way
// to see what it was looking at when it decided. Measured 2026-08-29 across 238 stored transitions,
// 147 of them — 62% — are physically impossible on sequence alone: two `into_bed` in a row, or two
// `out_of_bed`, with nothing in between. At least one of every such pair is wrong, so the database can
// already point at its own mistakes; what was missing was the evidence to diagnose them. That evidence
// is also what any occupancy classifier has to be measured against, because the question that decides
// whether such a thing is worth shipping is not "how accurate is it on random frames" but "is it right
// on the frames the detector got wrong".
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const SNAPSHOT_DIR = path.join(DATA_DIR, 'transition-snapshots');
try {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
} catch (err) {
  logger.error('Failed to create transition-snapshots dir:', err.message);
}

// ids are integer autoincrement — coerce and validate so nothing can escape the directory.
function snapshotFile(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return path.join(SNAPSHOT_DIR, `${n}.jpg`);
}

export function transitionSnapshotPath(id) {
  const file = snapshotFile(id);
  return file && fs.existsSync(file) ? file : null;
}

const insertStmt = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak) VALUES (@camera_id, @type, @peak)`
);
const markSnapshotStmt = db.prepare('UPDATE bed_transitions SET snapshot = 1 WHERE id = ?');
const camForSnapshotStmt = db.prepare(
  'SELECT id, name, snapshot_url, mediamtx_path FROM cameras WHERE id = ?'
);
// Rows about to age out that carry an image, so the JPEGs go with them and never orphan on disk.
//
// A transition somebody has JUDGED is exempt from the sweep, deliberately. The 45-day window exists to
// stop an unbounded table of machine-generated guesses; a frame a person has labelled is the opposite
// of that — it is the scarce thing, the ground truth an occupancy check would have to be measured
// against, and it accrues at a handful a night. Dropping those on a timer would defeat the point of
// collecting them. Unreviewed rows still age out normally, so the table stays bounded in practice.
const AGED_UNJUDGED = `created_at < datetime('now', ?) AND verdict IS NULL`;
const agedWithSnapshotStmt = db.prepare(
  `SELECT id FROM bed_transitions WHERE ${AGED_UNJUDGED} AND snapshot = 1`
);
const pruneByAgeStmt = db.prepare(`DELETE FROM bed_transitions WHERE ${AGED_UNJUDGED}`);

// Grab the frame and attach it. Deliberately fire-and-forget and fully swallowed: the detector runs
// several times a second and a camera that is slow to answer must never delay it, and a transition
// with no picture is still a perfectly good transition. Same source preference as an alert snapshot —
// the camera's own HTTP endpoint when it has one (instant, full frame), else a one-shot ffmpeg grab
// off the already-published local stream (no extra hit on the camera).
async function attachSnapshot(id, cameraId) {
  try {
    const cam = camForSnapshotStmt.get(cameraId);
    if (!cam) return;
    let buf = null;
    if (cam.snapshot_url) buf = await fetchHttpSnapshot(cam.snapshot_url).catch(() => null);
    if (!buf && cam.mediamtx_path) buf = await captureSnapshot(cam.mediamtx_path).catch(() => null);
    if (!buf || !buf.length) return;
    const file = snapshotFile(id);
    if (!file) return;
    await fs.promises.writeFile(file, buf);
    markSnapshotStmt.run(id);
  } catch (err) {
    logger.info(`[bedtx] snapshot for transition ${id} failed: ${err.message}`);
  }
}

// Prune runs rarely (a transition is a once-per-couple-minutes-at-most event), so an age sweep on each
// insert is negligible and keeps the table bounded without a separate scheduler.
export function recordBedTransition(cameraId, type, peak = null) {
  try {
    const info = insertStmt.run({
      camera_id: cameraId,
      type,
      peak: peak == null ? null : Math.round(peak * 1000) / 1000,
    });
    // Delete the images BEFORE the rows, or the ids that name them are gone and the files orphan.
    //
    // Synchronously, and deliberately: an async fire-and-forget unlink makes "the row is gone, so the
    // image is gone" only eventually true, and a failure has nowhere to be noticed — the orphan just
    // sits there forever with nothing left in the database able to name it. This runs at most once per
    // transition (minutes apart at worst) over a handful of files a day, so the cost is nil.
    for (const row of agedWithSnapshotStmt.all(`-${MAX_AGE_DAYS} days`)) {
      const file = snapshotFile(row.id);
      if (!file) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch (e) {
        logger.info(`[bedtx] could not remove aged snapshot ${row.id}: ${e.message}`);
      }
    }
    pruneByAgeStmt.run(`-${MAX_AGE_DAYS} days`);
    // Not awaited: see attachSnapshot.
    attachSnapshot(info.lastInsertRowid, cameraId);
    return info.lastInsertRowid;
  } catch (err) {
    logger.error('Failed to record bed transition:', err.message);
    return null;
  }
}

// All transitions for the given cameras within [startSql, endSql) (UTC 'YYYY-MM-DD HH:MM:SS' strings),
// ascending by time. Returns [{ id, camera_id, type, created_at, peak, snapshot, verdict }]. Empty for no
// cameras.
export function getBedTransitions(cameraIds, startSql, endSql) {
  if (!cameraIds || cameraIds.length === 0) return [];
  const ph = cameraIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, camera_id, type, created_at, peak, snapshot, verdict FROM bed_transitions
         WHERE camera_id IN (${ph}) AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC`
    )
    .all(...cameraIds, startSql, endSql);
}

// Transitions that are provably wrong: the same type twice in a row for one camera, with nothing
// between. You cannot get into a bed you are already in. Returns the SECOND of each such pair along
// with the one it contradicts, newest first — the working set for diagnosing the classifier, and the
// measure of how much a believed-occupancy state machine (ROADMAP 1.2) would clean up.
export function getImpossibleTransitions({ limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT t.id, t.camera_id, c.name AS camera_name, t.type, t.created_at, t.peak, t.snapshot
         FROM bed_transitions t JOIN cameras c ON c.id = t.camera_id
        ORDER BY t.camera_id, t.created_at ASC`
    )
    .all();
  const out = [];
  const prev = new Map();
  for (const r of rows) {
    const before = prev.get(r.camera_id);
    if (before && before.type === r.type) out.push({ ...r, contradicts: before.id, contradicts_at: before.created_at });
    prev.set(r.camera_id, r);
  }
  return out.reverse().slice(0, Math.min(500, Math.max(1, limit)));
}

// Record what a person said about one transition: 'correct', 'wrong', or 'unclear' — or null to clear
// it again. Anything else is rejected rather than stored, because these values are the labels a future
// occupancy check gets measured against and a typo'd one is worse than a missing one. Returns whether
// a row was actually updated.
const VERDICTS = new Set(['correct', 'wrong', 'unclear']);
const setVerdictStmt = db.prepare('UPDATE bed_transitions SET verdict = ? WHERE id = ?');

export function setTransitionVerdict(id, verdict) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (verdict != null && !VERDICTS.has(verdict)) return false;
  return setVerdictStmt.run(verdict ?? null, n).changes > 0;
}
