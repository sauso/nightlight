import db from '../db.js';
import { logger } from './logger.js';
import { getOndemandSettings, getWakeClipSettings } from './recordings.js';
import { childTracksSleep } from './sleepAnalysis.js';
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
//   * lifecycle: start/stop a camera's segmenter to match whether anything wants a ring
//     (clipRingWanted — the per-camera `detect_record_clips` opt-in, global on-demand recording, or
//     wake clips for a sleep-tracked child), driven from the same places the motion/sound detectors
//     are (routes + reconcile + startup).
//   * job queue: when a detection fires on a recording-enabled camera, fireDetectionAlert calls
//     enqueueClip(), which cuts the [pre, post] clip and writes clip_* onto the event row.
// Shipped in 0.17.0. Wake-clip eligibility added later (issue #387) — see the comment on
// clipRingWanted below for why it was missing.

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

// Should this camera be buffering at all? The ring feeds THREE features and any one of them is reason
// enough to run it: detection clips reach back over the pre-roll when something fires, on-demand
// recording reaches back when someone presses Record, and a wake clip reaches back over
// WAKE_CLIP_LEAD_SEC when the sleep tracker's wake watcher calls captureWakeClip (recordings.js). On-
// demand's pre-roll is the whole point of that feature, so `ondemand_enabled` is what turns its
// buffering off — exactly as docs/recording.md says ("Switching this off also stops the per-camera
// buffering").
//
// ⚠️ CALL THIS AT EVERY CALL SITE — never re-derive the condition. It exists because the condition WAS
// duplicated, and the copies drifted: startClipCapture had the rule right, but reconcile
// (index.js), re-enabling a camera and saving detection settings all pre-gated on
// `detect_record_clips` alone, and adding a camera never started the ring at all. Since
// `detect_record_clips` DEFAULTS TO 0, the on-demand half was unreachable from every one of those
// paths, so on a default install the Record button never appeared — the tile hides it when
// `can_record` is false. Measured 2026-09-01 on the e2e stack: a freshly added camera reported
// `can_record: false` indefinitely; a no-op PUT (the one call site with the rule right) flipped it to
// true; a container restart put it back to false. Invisible in this house because both cameras have
// detection clips switched on, which armed the ring for the other reason.
// This is the same class of defect as an early-bedtime path that shipped inert: a correct no-op and a
// dead branch look identical from outside.
//
// ⚠️ THE SAME BUG RECURRED FOR WAKE CLIPS (issue #387, flagged by the 2026-09-11 Codex review). Wake
// clips shipped as a third consumer of the ring but were never added to this predicate, so a household
// that turned OFF detection clips and on-demand recording while leaving "Record wake-ups" on got a
// silent no-op: `captureWakeClipInner` (recordings.js) requires `isSegmenterRunning`, found nothing,
// logged, and returned null every single night. The Recording page's three sections read as
// independent choices, so nothing in the UI hinted that the third one depended on the other two ever
// having been on.
//
// ⚠️ `!!camera.child_id &&` is a fast-path, not a correctness requirement — a Claude adversarial review
// confirmed `childTracksSleep(null|undefined|'')` already returns false on its own, so the guard changes
// no observable output. It stays because it skips a DB query for every unassigned camera on every
// reconcile pass, which is most cameras in most reconcile ticks. Do not "simplify" it away expecting a
// behavior change — there isn't one, and mutation-testing this line will correctly find it equivalent.
//
// ⚠️ THIS PREDICATE NOW DEPENDS ON child_id, WHICH CHANGES AT RUNTIME (assign/unassign, child delete) —
// unlike detect_record_clips and ondemand_enabled, which only change via a settings save. The same
// review found the two places that change it had NOT been updated to re-evaluate the ring:
// routes/cameras.js's PUT /:id/assign and routes/children.js's DELETE /:id (see their comments) — both
// fixed alongside this one. index.js's periodic reconcile also gained the STOP half it was missing, as
// the backstop for the next caller that forgets.
export function clipRingWanted(camera) {
  if (!camera || camera.disabled) return false;
  if (camera.detect_record_clips || getOndemandSettings().enabled) return true;
  return !!camera.child_id && childTracksSleep(camera.child_id) && getWakeClipSettings().enabled;
}

// Start (idempotently) a camera's segmenter if either feature wants the ring. No-op if already running
// so a reconcile tick never drops it. Mirrors startMotionDetector's guard.
export function startClipCapture(camera) {
  if (!clipRingWanted(camera)) return;
  const ond = getOndemandSettings();
  // Storage unusable (unmapped/unwritable CLIPS_DIR) — don't run a segmenter that can't produce clips.
  if (!clipStorageReady()) return;
  if (isSegmenterRunning(camera.id)) return;
  const { preRollSec, postRollSec } = getClipSettings();
  // Size the ring for the deeper of the two pre-rolls, so whichever trigger fires can reach back far
  // enough. (A long on-demand recording additionally HOLDS its segments from pruning while it runs —
  // see holdRing — so the ring doesn't need to be sized for the max recording length.)
  const deepestPreRoll = Math.max(preRollSec, ond.enabled ? ond.preRollSec : 0);
  startSegmenter(camera.id, camera.mediamtx_path, { preRollSec: deepestPreRoll, postRollSec });
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

// Reconcile one camera's ring against clipRingWanted: start if wanted and not running, stop if running
// and no longer wanted. Used by index.js's periodic reconcileCameraPaths, which previously had only the
// start half (issue #387 adversarial review) — every OTHER leg reconciled there (motion, ONVIF motion)
// already had both directions, so a missed call site anywhere else self-healed within 5 minutes; the
// ring's missing stop half meant a camera that stopped wanting it kept its segmenter (and so its ffmpeg
// process) running forever. Exported here, not left inline in index.js, because index.js has import-time
// side effects (it spawns MediaMTX/transcoders) that every existing test deliberately avoids triggering
// — this lets the stop half be tested directly instead.
export function reconcileClipRing(camera) {
  if (clipRingWanted(camera) && !isSegmenterRunning(camera.id)) {
    startClipCapture(camera);
  } else if (!clipRingWanted(camera) && isSegmenterRunning(camera.id)) {
    stopClipCapture(camera.id);
  }
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
