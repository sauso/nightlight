import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import {
  CLIPS_DIR,
  isSegmenterRunning,
  extractClip,
  holdRing,
  releaseRing,
} from './clipRecorder.js';
import { hasMinFreeSpace } from './clipStorage.js';

// On-demand recording: the tile's Record button. This is the SAME capture machinery as detection
// clips — one continuous `-c copy` segmenter per camera writing a rolling ring, then a short re-encode
// of the requested window (see clipRecorder.js). The only differences are the trigger (a person, not a
// detector) and the end (Stop, or the safety cap, rather than a fixed post-roll).
//
// The pre-roll is what the feature is really about: because the ring is always buffering, pressing
// Record reaches BACKWARD in time, so you can catch the moment after it already happened. The ring is
// nominally sized for a ~20s alert clip though, so while a recording runs we HOLD its segments from
// pruning (holdRing) — otherwise a 2-minute capture would lose its own opening. The hold is bounded by
// the max-duration cap and always released, including on failure.
//
// Recordings live in their OWN table, not detection_events: they're deliberate keepsakes, and putting
// them in the alert feed would bury them among motion/sound events and hand them to the clip retention
// sweeper, which would delete the very moments someone chose to keep.

// A couple of seconds past Stop so the ending isn't cut off mid-moment.
const TAIL_SEC = 2;
// After Stop we only need the final segment to close — the recorded span is already in the past — so
// extractClip gets this short settle instead of waiting out a post-roll it has no reason to wait for.
const SEGMENT_SETTLE_MS = 5000;
const MAX_ACTIVE_MS = 15 * 60 * 1000; // absolute backstop if a stop timer were ever lost

// cameraId -> { id, startMs, timer, userId }
const active = new Map();

export function getOndemandSettings() {
  const s =
    db.prepare('SELECT ondemand_enabled, ondemand_pre_roll_s, ondemand_max_duration_s FROM settings WHERE id = ?').get('app') || {};
  const pre = Number(s.ondemand_pre_roll_s);
  const max = Number(s.ondemand_max_duration_s);
  return {
    enabled: s.ondemand_enabled == null ? true : !!s.ondemand_enabled,
    preRollSec: Number.isFinite(pre) ? pre : 30,
    maxDurationSec: Number.isFinite(max) ? max : 120,
  };
}

export function isRecording(cameraId) {
  return active.has(cameraId);
}

// What the UI needs to render the button: whether this camera is recording and for how long.
export function recordingState(cameraId) {
  const a = active.get(cameraId);
  if (!a) return { recording: false };
  return { recording: true, id: a.id, started_at_ms: a.startMs, elapsed_s: Math.round((Date.now() - a.startMs) / 1000) };
}

/**
 * Begin an on-demand recording. Idempotent: a second Start on an already-recording camera returns the
 * in-progress state rather than erroring, so a double-tap can't spawn two captures. Throws (with a
 * user-facing message) when the camera can't currently be recorded.
 */
export function startRecording(camera, userId = null) {
  const { enabled, preRollSec, maxDurationSec } = getOndemandSettings();
  if (!enabled) throw new Error('On-demand recording is turned off in Settings.');
  if (active.has(camera.id)) return recordingState(camera.id);
  if (camera.disabled) throw new Error('This camera is disabled.');
  // No ring means nothing to cut — the camera is offline or its segmenter hasn't come up yet.
  if (!isSegmenterRunning(camera.id)) {
    throw new Error('This camera isn’t buffering yet — it may be offline. Try again in a moment.');
  }
  if (!hasMinFreeSpace()) throw new Error('Not enough free disk space to record.');

  const startMs = Date.now();
  // Reach back over the pre-roll, and protect those segments for as long as we're recording.
  holdRing(camera.id, startMs - preRollSec * 1000 - 5000);

  const info = db
    .prepare(
      `INSERT INTO recordings (camera_id, child_id, status, started_at, triggered_by)
       VALUES (@camera_id, @child_id, 'recording', @started_at, @triggered_by)`
    )
    .run({
      camera_id: camera.id,
      child_id: camera.child_id || null,
      // The true first frame of the finished video, pre-roll included.
      started_at: new Date(startMs - preRollSec * 1000).toISOString().replace('T', ' ').slice(0, 19),
      triggered_by: userId,
    });

  const timer = setTimeout(() => {
    logger.info(`[rec] auto-stopping "${camera.name}" at the ${maxDurationSec}s cap`);
    stopRecording(camera.id).catch(() => {});
  }, Math.min(maxDurationSec, MAX_ACTIVE_MS / 1000) * 1000);
  timer.unref?.();

  active.set(camera.id, { id: info.lastInsertRowid, startMs, timer, userId });
  logger.info(`[rec] recording started for "${camera.name}" (id ${info.lastInsertRowid}, pre-roll ${preRollSec}s)`);
  return recordingState(camera.id);
}

/**
 * End an on-demand recording and cut the video. Resolves the finished row id, or null when nothing was
 * recording (a Stop with no active recording is a no-op, not an error). Never throws: a capture failure
 * marks the row 'failed' and is logged, it doesn't surface as a request error the user can't act on.
 */
export async function stopRecording(cameraId) {
  const a = active.get(cameraId);
  if (!a) return null;
  clearTimeout(a.timer);
  active.delete(cameraId);

  const cam = db.prepare('SELECT id, name FROM cameras WHERE id = ?').get(cameraId) || { name: cameraId };
  const stopMs = Date.now();
  const { preRollSec } = getOndemandSettings();
  // extractClip cuts [at - pre, at + post]; anchor at the button press so `post` is the live span.
  const postRollSec = Math.max(1, Math.round((stopMs - a.startMs) / 1000) + TAIL_SEC);

  db.prepare("UPDATE recordings SET status='pending', ended_at=datetime('now'), duration_s=@d WHERE id=@id")
    .run({ id: a.id, d: preRollSec + postRollSec });

  try {
    const res = await extractClip(cameraId, {
      preRollSec,
      postRollSec,
      at: a.startMs,
      outBase: `rec-${a.id}`,
      settleMs: SEGMENT_SETTLE_MS,
    });
    // extractClip writes under CLIPS_DIR/<cameraId>/<outBase>.{mp4,jpg}; store paths relative to
    // CLIPS_DIR (posix separators) so the serving route can re-jail them.
    const rel = (abs) => (abs ? path.relative(CLIPS_DIR, abs).split(path.sep).join('/') : null);
    db.prepare(
      `UPDATE recordings SET status='ready', path=@path, thumb_path=@thumb_path, bytes=@bytes,
         duration_s=@duration_s WHERE id=@id`
    ).run({
      id: a.id,
      path: rel(res.file),
      thumb_path: rel(res.thumb),
      bytes: res.probe?.bytes ?? null,
      duration_s: res.probe?.durationSec != null ? Math.round(res.probe.durationSec) : preRollSec + postRollSec,
    });
    logger.info(
      `[rec] recording ${a.id} ready for "${cam.name}": ${res.probe?.durationSec?.toFixed(1) ?? '?'}s, ` +
        `${res.probe?.bytes ? (res.probe.bytes / 1e6).toFixed(2) : '?'}MB, ${res.segments} segs`
    );
    return a.id;
  } catch (err) {
    db.prepare("UPDATE recordings SET status='failed' WHERE id=?").run(a.id);
    logger.error(`[rec] recording ${a.id} failed for "${cam.name}": ${err.message}`);
    return a.id;
  } finally {
    releaseRing(cameraId);
  }
}

// Stop every in-flight recording (shutdown). Best-effort: we still try to save what was captured.
export async function stopAllRecordings() {
  await Promise.allSettled([...active.keys()].map((id) => stopRecording(id)));
}

export function listChildRecordings(childId, limit = 50) {
  return db
    .prepare(
      `SELECT r.id, r.camera_id, r.child_id, r.status, r.started_at, r.ended_at, r.duration_s, r.bytes,
              r.created_at, c.name AS camera_name
         FROM recordings r LEFT JOIN cameras c ON c.id = r.camera_id
        WHERE r.child_id = ? AND r.status = 'ready'
        ORDER BY r.created_at DESC LIMIT ?`
    )
    .all(childId, Math.min(200, Math.max(1, limit)));
}

// A jailed { root, path } for a ready recording's MP4 (or thumbnail), or null — same containment guard
// as clips and timelapses (resolve under CLIPS_DIR, reject any escape).
function jailedFile(relPath) {
  if (!relPath) return null;
  const abs = path.resolve(CLIPS_DIR, relPath);
  if (abs !== CLIPS_DIR && !abs.startsWith(CLIPS_DIR + path.sep)) return null;
  return fs.existsSync(abs) ? { root: CLIPS_DIR, path: path.relative(CLIPS_DIR, abs) } : null;
}

export function getRecordingVideoFile(id) {
  const row = db.prepare("SELECT path, status FROM recordings WHERE id = ?").get(id);
  if (!row || row.status !== 'ready') return null;
  return jailedFile(row.path);
}

export function getRecordingThumbFile(id) {
  const row = db.prepare("SELECT thumb_path, status FROM recordings WHERE id = ?").get(id);
  if (!row || row.status !== 'ready') return null;
  return jailedFile(row.thumb_path);
}

// Delete a recording and its files. These are keepsakes with no automatic retention, so removing one is
// always an explicit user action.
export function deleteRecording(id) {
  const row = db.prepare('SELECT path, thumb_path FROM recordings WHERE id = ?').get(id);
  if (!row) return false;
  for (const rel of [row.path, row.thumb_path]) {
    const f = jailedFile(rel);
    if (f) { try { fs.rmSync(path.resolve(f.root, f.path), { force: true }); } catch { /* ignore */ } }
  }
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
  return true;
}

