import db from '../db.js';
import { logger } from './logger.js';
import {
  startSegmenter,
  stopSegmenter,
  stopAllSegmenters,
  isSegmenterRunning,
  extractClip,
} from './clipRecorder.js';
import { markClipPending, setClipReady, setClipFailed } from './detectionEvents.js';
import { clipStorageReady, hasMinFreeSpace } from './clipStorage.js';

// Stage 1 recording — the glue between the capture core (clipRecorder.js) and the app:
//   * lifecycle: start/stop a camera's segmenter to match its `detect_record_clips` opt-in,
//     driven from the same places the motion/sound detectors are (routes + reconcile + startup).
//   * job queue: when a detection fires on a recording-enabled camera, fireDetectionAlert calls
//     enqueueClip(), which cuts the [pre, post] clip and writes clip_* onto the event row.
// See planning/recording-and-sleep-tracking-scope.md.

// Small in-process queue so a burst of triggers across cameras can't spawn unbounded ffmpeg. Each job
// occupies a worker for roughly the post-roll (extractClip waits it out) plus a quick concat.
const QUEUE_CONCURRENCY = 2;
let running = 0;
const queue = [];
// Cameras with a clip window currently open — a second trigger while one is in flight is folded into
// it rather than starting an overlapping capture (the detector cooldown already suppresses most).
const busyCameras = new Set();

// Global pre/post-roll (admin-configurable in Settings; bounds enforced in routes/settings.js).
function getClipSettings() {
  const s = db.prepare('SELECT clip_pre_roll_s, clip_post_roll_s FROM settings WHERE id = ?').get('app') || {};
  const pre = Number(s.clip_pre_roll_s);
  const post = Number(s.clip_post_roll_s);
  return {
    preRollSec: Number.isFinite(pre) ? pre : 5,
    postRollSec: Number.isFinite(post) ? post : 15,
  };
}

function pump() {
  while (running < QUEUE_CONCURRENCY && queue.length) {
    const job = queue.shift();
    running++;
    Promise.resolve()
      .then(job)
      .finally(() => {
        running--;
        pump();
      });
  }
}

// Start (idempotently) a camera's segmenter if it opts into clip recording. No-op if already running
// so a reconcile tick never drops the ring. Mirrors startMotionDetector's guard.
export function startClipCapture(camera) {
  if (!camera.detect_record_clips || camera.disabled) return;
  // Storage unusable (unmapped/unwritable CLIPS_DIR) — don't run a segmenter that can't produce clips.
  if (!clipStorageReady()) return;
  if (isSegmenterRunning(camera.id)) return;
  const { preRollSec, postRollSec } = getClipSettings();
  startSegmenter(camera.id, camera.mediamtx_path, { preRollSec, postRollSec });
}

export function stopClipCapture(cameraId) {
  stopSegmenter(cameraId);
}

// Force the segmenter to pick up new pre/post-roll (which change the ring depth): stop, then start
// fresh if still opted in. Used when the global clip settings change.
export function restartClipCapture(camera) {
  stopSegmenter(camera.id);
  startClipCapture(camera);
}

export const isClipCapturing = isSegmenterRunning;

export function stopAllClipCapture() {
  stopAllSegmenters();
}

// Enqueue a clip for a just-fired detection event. Best-effort and fully guarded — a recording failure
// must never disturb the detection/alert pipeline. `at` is the trigger time the clip centres on.
export function enqueueClip(camera, eventId, at = Date.now()) {
  if (!camera.detect_record_clips || !eventId) return;
  if (!isSegmenterRunning(camera.id)) {
    // Segmenter should be up whenever recording is on; if it isn't (just enabled / mid-restart), the
    // ring has nothing to cut, so skip rather than produce an empty clip.
    logger.info(`[clip] no segmenter for "${camera.name}" yet — skipping clip for event ${eventId}`);
    return;
  }
  if (busyCameras.has(camera.id)) {
    logger.info(`[clip] "${camera.name}" already capturing — event ${eventId} folded into the active clip`);
    return;
  }
  if (!hasMinFreeSpace()) {
    // Disk nearly full — never let recording be what fills it. Skip this clip (alert row still stands).
    logger.error(`[clip] low free space — skipping clip for "${camera.name}" event ${eventId}`);
    return;
  }

  busyCameras.add(camera.id);
  markClipPending(eventId);
  const { preRollSec, postRollSec } = getClipSettings();

  queue.push(async () => {
    try {
      const res = await extractClip(camera.id, {
        preRollSec,
        postRollSec,
        at,
        outBase: String(eventId),
      });
      // Stored relative to CLIPS_DIR (posix separator; getEventClipFile resolves it safely).
      const relPath = `${camera.id}/${eventId}.mp4`;
      setClipReady(eventId, relPath, res.probe.durationSec, res.probe.bytes);
      logger.info(
        `[clip] ready for "${camera.name}" event ${eventId}: ${res.probe.durationSec?.toFixed(1)}s, ` +
          `${res.probe.bytes ? (res.probe.bytes / 1e6).toFixed(2) : '?'}MB, ${res.segments} segs`
      );
    } catch (e) {
      setClipFailed(eventId);
      logger.error(`[clip] capture failed for "${camera.name}" event ${eventId}: ${e.message}`);
    } finally {
      busyCameras.delete(camera.id);
    }
  });
  pump();
}
