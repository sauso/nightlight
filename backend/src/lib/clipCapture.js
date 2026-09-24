import db from '../db.js';
import { logger } from './logger.js';
import { getOndemandSettings, getWakeClipSettings } from './recordings.js';
import { childTracksSleep } from './sleepAnalysis.js';
import {
  startSegmenter,
  stopSegmenter,
  stopAllSegmenters,
  isSegmenterRunning,
  setRingDepth,
  extractClip,
  clipCoverStartMs,
  holdRing,
  releaseRing,
} from './clipRecorder.js';
import { effectiveHold, clipHoldOwner } from './ringHolds.js';
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

// The ring's required depth: sized for the deeper of the two pre-rolls, so whichever trigger fires can
// reach back far enough. (A long on-demand recording additionally HOLDS its segments from pruning while
// it runs — see holdRing — so the ring doesn't need to be sized for the max recording length, only for
// the pre-roll.) Factored out of startClipCapture (#446) so reconcileClipRing's resize branch can call
// the SAME formula on a running ring — one sizing decision, not two copies that can drift.
function ringSizing() {
  const { preRollSec, postRollSec } = getClipSettings();
  const ond = getOndemandSettings();
  return { preRollSec: Math.max(preRollSec, ond.enabled ? ond.preRollSec : 0), postRollSec };
}

// Start (idempotently) a camera's segmenter if either feature wants the ring. No-op if already running
// so a reconcile tick never drops it. Mirrors startMotionDetector's guard.
export function startClipCapture(camera) {
  if (!clipRingWanted(camera)) return;
  // Storage unusable (unmapped/unwritable CLIPS_DIR) — don't run a segmenter that can't produce clips.
  if (!clipStorageReady()) return;
  if (isSegmenterRunning(camera.id)) return;
  startSegmenter(camera.id, camera.mediamtx_path, ringSizing());
}

export function stopClipCapture(cameraId) {
  deferredStops.delete(cameraId); // whatever deferred it is moot once it's actually stopped
  stopSegmenter(cameraId);
}

export const isClipCapturing = isSegmenterRunning;

export function stopAllClipCapture() {
  stopAllSegmenters();
}

// Cameras whose stop is currently deferred because something still holds the ring (see reconcileClipRing
// below). Logged once, on the tick that ADDS a camera here, not on every later tick that still finds it
// held — #446, Codex F5: an on-demand recording can hold for up to its ≤600s cap and a wake run for up
// to its 20-min stale-run window (wakeWatcher.js), so without this the same line would repeat every 5
// minutes (index.js's reconcile interval) for a good while. Cleared once the ring actually stops, or if
// the camera starts wanting the ring again before that happens.
const deferredStops = new Set();

// Reconcile one camera's ring against clipRingWanted: start if wanted and not running, resize in place
// if wanted and already running, defer-then-stop if running and no longer wanted. Used by index.js's
// periodic reconcileCameraPaths, which previously had only the start half (issue #387 adversarial
// review) — every OTHER leg reconciled there (motion, ONVIF motion) already had both directions, so a
// missed call site anywhere else self-healed within 5 minutes; the ring's missing stop half meant a
// camera that stopped wanting it kept its segmenter (and so its ffmpeg process) running forever.
// Exported here, not left inline in index.js, because index.js has import-time side effects (it spawns
// MediaMTX/transcoders) that every existing test deliberately avoids triggering — this lets the stop
// half be tested directly instead.
export function reconcileClipRing(camera) {
  // Evaluated once, not per branch — clipRingWanted can run 1-3 DB queries and this runs over every
  // camera on every 5-minute reconcile tick. (startClipCapture still re-checks it internally on the
  // start path; that copy stays, per "CALL THIS AT EVERY CALL SITE" above — it's what makes
  // startClipCapture itself safe to call from anywhere, not just from here.)
  const wanted = clipRingWanted(camera);
  const running = isSegmenterRunning(camera.id);

  if (wanted && running) {
    deferredStops.delete(camera.id);
    // #446: idempotent (a field write inside setRingDepth) and cheap, so safe to call on every 5-minute
    // reconcile tick too, not just a settings save — this is what lets a settings save resize the ring
    // WITHOUT a restart: see setRingDepth's own comment for why that's safe.
    setRingDepth(camera.id, ringSizing());
  } else if (wanted && !running) {
    deferredStops.delete(camera.id);
    startClipCapture(camera);
  } else if (!wanted && running) {
    // #446: not wanted any more, but a capture still in flight (a detection clip mid-extraction, an
    // on-demand recording, a wake capture) has its own hold on these segments — stopping now would
    // delete them out from under it, exactly what the old restart-based settings.js loop used to do.
    // Leave the ring running and let a LATER reconcile — index.js's periodic tick, every 5 minutes —
    // do the stop once the last hold clears. Bounded: an on-demand recording holds for at most its
    // ≤600s cap, and a wake run for at most its 20-minute stale-run window.
    if (effectiveHold(camera.id) != null) {
      if (!deferredStops.has(camera.id)) {
        logger.info(
          `[clip] "${camera.name}" no longer wants its ring, but an in-flight capture still holds it — deferring the stop`
        );
        deferredStops.add(camera.id);
      }
      return;
    }
    deferredStops.delete(camera.id);
    stopClipCapture(camera.id);
  }
}

// Re-evaluate every enabled camera's ring against the CURRENT settings — the resize/defer/start/stop
// decision reconcileClipRing already makes, run once per camera. Moved out of routes/settings.js (#446)
// so it is a plain synchronous function a test can call directly against a real (PATH-emptied) ring; a
// route-level test can't drive that (see clip-capture.test.js's file header on why PATH is emptied) and
// couldn't observe the synchronous resize before a later tick deleted the segmenter entry either.
export function applyRecordingSettingsChange() {
  for (const cam of db.prepare('SELECT * FROM cameras WHERE disabled = 0').all()) {
    reconcileClipRing(cam);
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
  // #446: hold the ring for this clip's own pre-roll, not just depth-based pruning — a settings save
  // that shrinks the ring mid-capture must not prune what this clip still needs (the old restart-based
  // settings.js used to wipe the ring outright, which was strictly worse). clipCoverStartMs is the SAME
  // formula extractClip uses to select segments, so this lease is never shallower than what the
  // extraction will actually read. Taken LAST, directly before the job is queued — after markClipPending
  // above, which writes the database and can throw — so a throw there can never leave a lease behind
  // with nothing left to release it (Codex F4). Released in the job's own `finally` below; a side
  // benefit of holding from here rather than from inside the job is that a clip still waiting in the
  // concurrency-2 queue is protected too, not only one that has started running.
  const holdOwner = clipHoldOwner(eventId);
  holdRing(camera.id, holdOwner, clipCoverStartMs(at, preRollSec));

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
      releaseRing(camera.id, holdOwner);
    }
  });
  pump();
}
