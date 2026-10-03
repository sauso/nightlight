import { spawn } from 'child_process';
import db from '../db.js';
import { logger } from './logger.js';
import { forwardProcessLines } from './processOutput.js';
import { subPathName, getPathStatus } from './mediamtx.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';
import { recordMotion, recordMotionOut, excludeClone } from './activityTracker.js';
import { recordBedTransition, TRANSITION } from './bedTransitions.js';
import { OOB_LINK_MS, OOB_LINK_SLOW_MS, OOB_SLOW_OUT_MIN, createFrameGapDetector } from './bedTransitionRules.js';
import {
  createBedTransitionTracker, OOB_CONFIRM_QUIET_MS, IB_CONFIRM_QUIET_MS, IB_LINK_MS,
} from './bedTransitionTracker.js';
import { childSamplingActiveNow } from './sleepAnalysis.js';
import { isDemoModeActive } from '../middleware/demoMode.js';
import { killIfSpawned, detectorHealthOf, killStalledDetector, safeInterval } from './processGuards.js';
import { buildMotionTaps, createStderrRouter, SIDE_CHANNEL_LOG_ARGS } from './ffmpegSideChannel.js';
import { openObservation } from './observationClock.js';

// Server-side motion detection. Per camera with detection enabled, a cheap FFmpeg leg reads
// the already-published MediaMTX stream (the sub-stream when there is one — far cheaper to
// decode; if the sub is not up it falls back to main and returns to the sub once it is, see
// SUB_GRACE_MS below), scaled tiny and grayscale at a low frame rate, and we frame-diff consecutive
// NAMING: user-facing wording is "bed" throughout (see the 0.26.0 changelog). A few identifiers here
// still read `crib*` (cribActive, cribLastActive) and the DB column is still `detect_zone` — those are
// deliberately untouched to keep the rename free of schema and API churn. They mean the same thing.
// frames inside an optional bed zone. Sustained movement past the confirmation delay logs a
// detection_event, at most once per cooldown. This never touches the WebRTC/HLS pipeline —
// it's a separate, low-cost sampler, mirroring transcoder.js's process supervision.

// camera_id -> { proc, stopped, path, spawnedMono, lastDataMono, lastInputRecordMono, watchdogKill }
// The four #369 fields are the detector watchdog's only view of this leg (getMotionDetectorHealth below).
const detectors = new Map();

// Cameras with a relaunch SCHEDULED but no process yet — the 5s gap between an ffmpeg exit and the
// restart. The exit handler removes the camera from `detectors` before arming that timer, so during
// the gap the entry is unreachable and `entry.stopped`, the only brake on the relaunch, cannot be set.
// stop() was therefore a no-op inside the window, and a camera deleted or disabled mid-restart kept
// respawning ffmpeg every 5s for the life of the container — invisible to isDetecting(), so no
// watchdog or reconcile pass could see or heal it, while it went on writing activity_samples outside
// the sleep window. Keeping the timer handle here is what makes the relaunch cancellable. See #253.
const pendingRestarts = new Map(); // cameraId -> timeout handle

// Cancel a scheduled relaunch, if any. Safe to call for a camera that has none.
function cancelPendingRestart(cameraId) {
  const t = pendingRestarts.get(cameraId);
  if (t) {
    clearTimeout(t);
    pendingRestarts.delete(cameraId);
  }
}

// --- #454: the frame-diff motion ALERT cooldown outlives a detector relaunch. ---
// camera id -> wall ms (Date.now()) of the last frame-diff alert that actually FIRED. It used to be a
// `let lastAlert = 0` inside launch(), so every ffmpeg relaunch started with a zero stamp and sustained motion
// could alert again sooner than `detect_cooldown_s` after the previous alert. ONVIF (onvifMotion.js) and MQTT
// (mqttClient.js) already keep theirs in a module-level Map for exactly that reason; this is the same shape.
// WHICH CAUSES MATTER AT WHICH COOLDOWN: an ffmpeg exit (a reconnect, "stream ended") and any re-entry of
// startMotionDetector (below) re-armed the cooldown at ANY setting, the default 60 s included. The #369 watchdog
// kill needs >= 60 s of silence and the #500 return to the sub needs 90 s of quiet, so those two only mattered
// with a cooldown above about 70 s / 95 s.
//
// WHY MODULE LEVEL, not a closure variable beside `believedOccupied` (#424): startMotionDetector is RE-ENTERED
// by a detection-settings save (the frontend autosaves every control through that one endpoint), by any camera
// edit (a rename included), assign/unassign, enable/disable, routes/children.js, and by the 5-minute reconcile
// when it lands in the 5 s relaunch gap (isDetecting() is false there, index.js). Each re-entry builds a NEW
// closure and calls stopMotionDetector first, so anything declared inside startMotionDetector is lost on all of
// them. For the same reason stopMotionDetector and startMotionDetector must NOT clear this: start calls stop
// first, and an unrelated edit or reconcile tick is not a request for a fresh cooldown. Only forgetMotionAlert,
// called from the camera DELETE route, removes an entry. (A frame still draining from the old process after
// `exit` could re-stamp a deleted camera once; a number per camera id, which is a UUID. Not guarded: a `stopped`
// check on the alert would change when alerts fire, which is out of scope here.)
//
// WALL CLOCK, not the observation clock (#373/#447): `now` in handleFrame is Date.now() and the old stamp was
// that too (the comment in handleFrame says "wall time by design"). The observation clock files FRAMES by
// receipt, can be absent or throwing, and a cooldown is the gap between two ALERTS, not between frames.
//
// WHY `Math.min(stored, now)` WITH A WRITE-BACK (alertStampFor below). A stamp can only be ahead of `now` after
// the wall clock stepped BACK (an NTP correction, a manual change). Treating a future stamp as "no previous
// alert" (fail open) was measured in #454's plan review to fire 25 alerts in 25 frames with `detect_confirm_s = 0`
// and a clock that stepped back each frame (the old code: one), and after a one-hour step back it re-alerted 3 s
// later. Clamping the stamp to now and writing the clamp back means a ONE-WAY backward step silences the alert
// for at most ONE cooldown, counted from the first analysed frame after the step (at 5 fps that is immediate; if
// frames stop for ten minutes after the step, it starts at the next frame), where the old code stayed silent for
// the step plus a cooldown. A forward step shortens a cooldown, as it always did.
//
// ⚠️ KNOWN LIMIT, found by code review and verified by running it, NOT desired behaviour: the clamp is written
// BACK, so it is not a "never worse than before" rule. A clock that steps back and is then corrected FORWARD
// leaves the stamp at the stepped-back time, and the first run after the correction can alert INSIDE the cooldown
// (one extra alert; pinned by a test, motion-alert-cooldown.test.js C8). A clock that oscillates by hours between
// frames can alert repeatedly (11-12 alerts in 20 frames were measured; the old code: one). That is not what
// NTP does, so it was left. The fix, if it ever matters, is a monotonic companion stamp (performance.now()) next
// to the wall one; it is a bigger change and the tests steer time only through the Date mock. This covers the
// frame-diff alert only; the bed-transition cooldowns, ONVIF and MQTT keep their old behaviour after a backward
// step (KNOWN-ISSUES, #582).
//
// WHAT IS DELIBERATELY NOT KEPT across a relaunch (decided in the plan, not forgotten): the bed-transition
// tracker, including its 120 s pause after a logged exit or entry and a pending candidate. It gates stored
// `bed_transitions` rows that sleep analysis reads as the authoritative wake time, so moving it moves reported
// numbers and needs its own old-vs-new check on both databases; 120 s is a calibrated number. A relaunch can
// already record a duplicate exit within two minutes (KNOWN-ISSUES, #500): a duplicate, not a lost transition.
// The SOUND alert cooldown (soundDetector.js's analyser) is a different shape and is not touched: it already
// lives outside the per-ffmpeg launch, so it already survives a relaunch (it is lost on a re-entry).
//
// Nothing here persists across a SERVER restart (a container restart starts every stamp at zero). That would
// need the last motion `detection_events` row, told apart from ONVIF/MQTT rows by `detail`, parsed from UTC
// text, plus a DB read at start: a design of its own. The cost is at most one extra alert per camera per
// restart, and only if motion is sustained within `detect_cooldown_s` of it.
const motionAlertStamps = new Map();

// The stamp to compare against: 0 when this camera has never alerted, otherwise the stored time CLAMPED to
// now (see above). Pure, so the boundaries are testable without a process.
export function alertStampFor(stored, now) {
  return stored == null ? 0 : Math.min(stored, now);
}

// Forget a camera's alert stamp. The ONLY deleter: the camera DELETE route (see the header above).
export function forgetMotionAlert(cameraId) {
  motionAlertStamps.delete(cameraId);
}

// Test-only views of the store, like _returnTimerCountForTests below: nothing else shows what it holds.
export function _motionAlertStampForTests(cameraId) {
  return motionAlertStamps.get(cameraId);
}
export function _setMotionAlertStampForTests(cameraId, ms) {
  motionAlertStamps.set(cameraId, ms);
}
export function _motionAlertStampCountForTests() {
  return motionAlertStamps.size;
}
export function _resetMotionAlertsForTests() {
  motionAlertStamps.clear();
}

const RESTART_DELAY_MS = 5000;
const FORCE_KILL_TIMEOUT_MS = 3000;

// Analysis frame geometry: tiny + grayscale. Aspect is deliberately squashed to a fixed size
// (irrelevant for frame-diff, and fixed dimensions let us slice exact frame-sized chunks off
// ffmpeg's stdout). 320x180 gray8 @ 5fps is a trivial amount of data to diff in JS.
const FW = 320;
const FH = 180;
const FPS = 5;
const FRAME_BYTES = FW * FH; // gray8: 1 byte/pixel

// Issue #373: two showinfo taps around the same fps/scale/format chain, so the observation clock can read
// each real input frame's PTS (`in`) and align every stdout frame with its record by content (`out`). They
// change what ffmpeg PRINTS, never what it WRITES to stdout: the stdout sha256 was identical with and
// without them on real and synthetic inputs (ffmpegSideChannel.js's header), so no decision here moves.
const TAPS = buildMotionTaps({ fps: FPS, width: FW, height: FH });

// A pixel counts as "changed" only if its brightness moved more than this (0..255) — filters
// sensor noise and compression shimmer.
const PIXEL_DELTA = 24;

// A brief dip below the active threshold shouldn't reset a sustained motion run (real motion
// flickers frame to frame); only a gap longer than this ends the run.
const ACTIVE_GRACE_MS = 1500;

// #452: the FLOOR of the frame-arrival gap bound (createFrameGapDetector in bedTransitionRules.js, which
// explains the adaptive part and the honest limits). It IS ACTIVE_GRACE_MS on purpose: the repo already says
// "a motion run has not ended" for gaps up to this long, so a frame that arrives later than this after the
// previous one means the camera (or ffmpeg, or this process) was not delivering video, and neither a motion
// run nor a pending bed transition may be confirmed across it. Reusing the number adds none for a normal
// camera. Chosen, not measured (no per-gap data existed when it was set).
const FRAME_GAP_MS = ACTIVE_GRACE_MS;

// What a frame-gap event's `gapMs` means in a log line: a negative one is a backward wall-clock step (an NTP
// correction, a manual change), which the gap detector deliberately counts as a gap too.
const gapText = (gapMs) => (gapMs < 0 ? `system clock stepped back ${-gapMs}ms` : `no frames for ${gapMs}ms`);

// --- "Out of bed" / "into bed" — bed <-> outside transition classification. ---
// A child climbing out reads as motion in the bed FIRST, then motion OUTSIDE the bed while the bed
// goes and STAYS quiet (the child has left it). A parent entering is the reverse (outside first) or
// leaves the child still stirring in the bed. Confirmed transitions are persisted to `bed_transitions`
// and are AUTHORITATIVE for the reported wake time (see USE_TRANSITION_TIMES in sleepAnalysis.js), so a
// missed exit here is a wrong wake time on the child's night, not just a missing marker.
//
// The candidate-open/cancel/confirm state machine (both directions, all their timing constants) lives
// in `bedTransitionTracker.js` — extracted 2026-09-18 so it can be tested at all; see that file's
// header for why. This file owns only: computing cribActive/outActive per frame, feeding them to the
// tracker, and turning its returned events into the exact log lines and `recordBedTransition` calls
// this used to do inline. `OOB_CONFIRM_QUIET_MS`/`IB_CONFIRM_QUIET_MS` are imported back in below only
// because the confirm log line states the literal constant, not a computed elapsed time.

// When (re)starting a detector, wait up to this long for the preferred sub-stream to start
// publishing before settling for the heavier main stream, polling readiness this often. We
// never spawn ffmpeg against a not-yet-ready path, so there's no 404 churn at startup/after a blip.
const SUB_GRACE_MS = 45000;
const READY_POLL_MS = 2000;

// --- #500: RETURNING to the sub after a fallback to main. ---
// The 45 s grace above is decided ONCE, at launch. After an outage longer than it (the camera's scheduled
// reboot, a Wi-Fi drop, a MediaMTX restart) both paths come back within about a second of each other, main
// is usually first, and the detector used to stay on main until its ffmpeg next exited, which can be a day
// or more (seen 2026-09-25: after the daily reboot both staging detectors and one prod detector were on
// main, and nothing said so). The motion thresholds were calibrated on the SUB stream (10 fps there; main
// is 15 fps, a different encoder and noise floor), so a night on main is a different measurement, and it
// costs more CPU, which is what preferring the sub is for.
//
// So a detector that fell back to main WHILE THE CAMERA HAS A SUB polls the sub, and once the sub has been
// seen ready for a stable stretch AND the room has been quiet, it relaunches itself: SIGTERM, then the
// ordinary exit-handler relaunch (RESTART_DELAY_MS, then launch() -> pickReadyPath picks the sub because it
// is ready). One lineage, so stopMotionDetector still cancels it (#253) and closure state that survives a
// relaunch (believedOccupied) survives this too, as does the alert cooldown (#454: module level, so the switch
// does not re-arm a motion alert; before #454 it did, which KNOWN-ISSUES used to document as a side effect).
//
// ⚠️ ALL FOUR NUMBERS ARE CHOSEN, NOT MEASURED. None is a detection threshold and none changes a number
// computed on a given stream; they only decide WHEN to switch. They were set from one house's 64 s reboot
// outage (sub ~0.75 s behind main); for another install they are a hypothesis.
export const SUB_RECHECK_MS = 20 * 1000;
// Consecutive ready SAMPLES (not continuous readiness: a sub that drops and returns between two samples still
// counts) before switching: 3 x 20 s = 40-60 s of ready, so a sub that is ready for a moment, or the 0.75 s
// post-reboot lag, never triggers a relaunch. A not-ready OR UNKNOWN answer (#451: a MediaMTX API timeout is
// not evidence of ready) resets the run.
export const SUB_STABLE_CHECKS = 3;
// ★ DERIVED, NOT TYPED. The relaunch builds a NEW bed-transition tracker, which forgets when the bed last
// moved. oobLinkKind accepts a big outside burst up to OOB_LINK_SLOW_MS after that, and a confirmed exit then
// needs OOB_CONFIRM_QUIET_MS more. A switch in that window loses a real exit that an un-relaunched tracker
// would have confirmed (verified by running the real tracker in #500's plan review: bed active at t=0, a 12%
// outside burst at 45 s, a relaunch at 36 s of quiet -> the exit was gone), and an exit sets the reported wake
// time. So the room must have been quiet for longer than both, plus a margin. If either constant changes
// this follows (motion-return-to-sub.test.js pins the inequality).
// ⚠️ "An exit confirms OOB_CONFIRM_QUIET_MS after it opens" is only true of an uninterrupted stream. Since #452 a
// frame that arrives after a gap restarts that 6 s of quiet (createFrameGapDetector), so on a camera whose main
// stream keeps stalling an exit can take longer than the 24 s margin above, and a return-to-sub relaunch in that
// time could still lose a pending exit. Not handled here (refusing the return while a candidate is pending is a
// follow-up issue). Suspected, not measured.
// ⚠️ What this does NOT prevent: the new tracker also forgets the 120 s pause (OOB_COOLDOWN_MS / IB_COOLDOWN_MS)
// after a logged exit or entry, longer than this quiet period, so a second exit or entry ~100 s after a first
// can be recorded that an uninterrupted tracker would have suppressed (verified by running the real tracker in
// #500's code review). A duplicate, not a lost transition; documented in KNOWN-ISSUES.
export const SUB_QUIET_MS = OOB_LINK_SLOW_MS + OOB_CONFIRM_QUIET_MS + 24 * 1000;
// A sub that flaps ready/not-ready must not cost a relaunch per outage blip: at most one switch per this long
// per startMotionDetector call (a fresh start, e.g. a settings save, forgets it: a small accepted hole).
export const SUB_SWITCH_MIN_GAP_MS = 10 * 60 * 1000;

// Every timing above in one object so a test can shrink them (the 45 s grace and the 5 s relaunch delay make
// a real-time test of this impractical). Production never calls the setter, so `timing` IS the constants.
const PRODUCTION_TIMING = Object.freeze({
  subGraceMs: SUB_GRACE_MS,
  readyPollMs: READY_POLL_MS,
  restartDelayMs: RESTART_DELAY_MS,
  recheckMs: SUB_RECHECK_MS,
  stableChecks: SUB_STABLE_CHECKS,
  quietMs: SUB_QUIET_MS,
  minGapMs: SUB_SWITCH_MIN_GAP_MS,
});
let timing = PRODUCTION_TIMING;
export function _setReturnTimingForTests(overrides) {
  timing = Object.freeze({ ...PRODUCTION_TIMING, ...overrides });
}
export function _resetReturnTimingForTests() {
  timing = PRODUCTION_TIMING;
}
// What production runs with, for a test that pins every value (the behavioural tests all shrink them).
export function _productionTimingForTests() {
  return PRODUCTION_TIMING;
}

// Every live return-check timer. Only so a test can see that none survives stop / exit / error / a replaced
// entry: a leaked interval sends no request (its own guard returns first), so nothing else can show it.
const returnTimers = new Set();
export function _returnTimerCountForTests() {
  return returnTimers.size;
}
function disarmReturnCheck(entry) {
  if (!entry.returnTimer) return;
  clearInterval(entry.returnTimer);
  returnTimers.delete(entry.returnTimer);
  entry.returnTimer = null;
}

// The sub path's name, or null when the camera has no sub-stream configured.
function subPathOf(camera) {
  return camera.sub_rtsp_url && String(camera.sub_rtsp_url).trim() ? subPathName(camera.mediamtx_path) : null;
}

// The run of consecutive ready samples after one more answer from MediaMTX. ONLY a confirmed `ready === true`
// extends it: not ready, an unknown (an API timeout, #451) and no answer at all all break it.
export function nextReadyRun(run, status) {
  return status && status.ready === true ? run + 1 : 0;
}

// Should a detector reading main go back to the sub now? Pure, so the boundaries are testable without a
// process. `sinceLastSwitchMs` is null when this start has never switched (NOT 0: a 0 would block the first
// return for 10 minutes after boot, which is when a power cut boots the server and the cameras together).
export function shouldReturnToSub({ readyRun, quietMs, sinceLastSwitchMs }) {
  return readyRun >= timing.stableChecks
    && quietMs >= timing.quietMs
    && (sinceLastSwitchMs == null || sinceLastSwitchMs >= timing.minGapMs);
}

// Map 1..100 sensitivity to the fraction of zone pixels that must change for a frame to count
// as "active". Higher sensitivity => smaller fraction => easier to trigger.
// Exported for tests only — it and buildZoneMask below are the two pure functions on this path, and
// everything else here is welded to a spawned ffmpeg process.
export function activeFractionThreshold(sensitivity) {
  const s = Math.min(100, Math.max(1, sensitivity || 50));
  // Linear in sensitivity: 10% of the zone at 1, ~5.2% at 50, ~1.2% at 90, 0.2% at 100.
  // (This line previously said "~2.5% at 50", which the formula has never produced.)
  return 0.002 + (0.1 - 0.002) * ((100 - s) / 99);
}

// detect_zone JSON -> a per-pixel mask over the analysis frame. The zone is a LIST of rectangles
// ({x,y,w,h} in 0..1 frame fractions); a pixel counts if it falls in ANY of them (so overlapping or
// diagonal boxes are handled correctly, each pixel counted once). Returns { mask, zonePixels }: mask
// is a Uint8Array(FW*FH) of 0/1, or null when the whole frame is used (no/degenerate zone), in which
// case zonePixels is the full frame. A legacy single-object zone still works (treated as one rect).
export function buildZoneMask(camera) {
  let rects = null;
  if (camera.detect_zone) {
    try {
      const z = JSON.parse(camera.detect_zone);
      rects = Array.isArray(z) ? z : [z];
    } catch {
      rects = null;
    }
  }
  rects = (rects || []).filter((r) => r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number'));
  if (rects.length === 0) return { mask: null, zonePixels: FW * FH };

  const clamp = (v) => Math.min(1, Math.max(0, v));
  const mask = new Uint8Array(FW * FH);
  let count = 0;
  for (const z of rects) {
    // Round to the NEAREST pixel edge, not outward (floor/ceil). The zone picker paints on a 32x18
    // grid whose cells are exactly 10x10 pixels here, but its fractions are stored rounded, so an
    // edge arrives as 10.0008 rather than 10 — rounding outward turned that into a whole extra row
    // of pixels per rect. Nearest-edge absorbs the rounding and makes a painted zone pixel-exact.
    // For an older hand-drawn box this shifts an edge by at most half a pixel.
    const x0 = Math.round(clamp(z.x) * FW);
    const y0 = Math.round(clamp(z.y) * FH);
    const x1 = Math.min(FW, Math.round(clamp(z.x + z.w) * FW));
    const y1 = Math.min(FH, Math.round(clamp(z.y + z.h) * FH));
    for (let y = y0; y < y1; y++) {
      let idx = y * FW + x0;
      for (let x = x0; x < x1; x++, idx++) {
        if (!mask[idx]) { mask[idx] = 1; count++; }
      }
    }
  }
  if (count < 4) return { mask: null, zonePixels: FW * FH };
  return { mask, zonePixels: count };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve to the path to analyse once one is actually publishing, preferring the sub-stream
// (cheap to decode). Polls MediaMTX readiness rather than spawning ffmpeg speculatively, so we
// never hit a 404 (at startup, or after a blip took both streams down): it waits up to
// SUB_GRACE_MS for the sub, then settles for the main path if the sub still isn't up.
// ⚠️ This choice is made ONCE per launch. It used to be described here as "the detector also returns to the
// sub after a blip", which was true only if something relaunched it: nothing did while its ffmpeg kept
// running, so a detector that settled for main stayed there (#500). launch() now arms a return check for
// exactly that case (see SUB_RECHECK_MS). Resolves null if the detector was stopped meanwhile.
async function pickReadyPath(camera, entry) {
  const sub = subPathOf(camera);
  const main = camera.mediamtx_path;
  const deadline = Date.now() + timing.subGraceMs;
  for (;;) {
    if (entry.stopped) return null;
    if (sub) {
      const st = await getPathStatus(sub).catch(() => null);
      if (st && st.ready) return sub;
    }
    // No sub, or the sub grace has elapsed: take the main path as soon as it's ready.
    if (!sub || Date.now() > deadline) {
      const st = await getPathStatus(main).catch(() => null);
      if (st && st.ready) return main;
    }
    await sleep(timing.readyPollMs);
  }
}

export function isDetecting(cameraId) {
  return detectors.has(cameraId);
}

// #369: this leg's freshness for the detector watchdog, as AGES (see detectorHealthOf in processGuards.js for
// the shape). isDetecting() alone cannot see the failure #369 is about: an ffmpeg that is alive, connected and
// delivering nothing keeps its entry, so reconcile skipped it as healthy for 285 and 523 minutes on staging.
// Test the result with `!= null`, never truthiness.
export function getMotionDetectorHealth(cameraId) {
  return detectorHealthOf(detectors.get(cameraId));
}

// #369: the watchdog's L1 lever. `expect` = the { spawnedMono, lastDataMono } tokens from the health it judged,
// as { expectSpawn, expectLastData }. Restarts through the exit handler below; see killStalledDetector.
export function restartMotionDetector(cameraId, expect) {
  return killStalledDetector(detectors.get(cameraId), expect, FORCE_KILL_TIMEOUT_MS);
}

// Does this camera run the frame-diff leg to ALERT? Only a 'framediff'-source camera with motion
// detection on. A camera on the 'mqtt' source detects motion itself (mqttClient.js) and one on the
// 'onvif' source subscribes to camera events (onvifMotion.js) — both alert elsewhere, so this leg
// must be explicit ('=== framediff'), not "anything but mqtt", or an ONVIF camera would double-alert.
export function motionAlerting(camera) {
  return !!camera?.detect_motion_enabled && camera.detect_source === 'framediff' && !camera.disabled;
}

// Should the pixel-diff leg run RIGHT NOW? Either to alert (above) OR "activity-only" for sleep tracking:
// a child-assigned camera whose motion alerts come from MQTT (or has motion alerting off) still runs
// the cheap leg to feed a continuous motion timeline (activityTracker) — but fires NO alerts, so it
// doesn't reintroduce the false positives the MQTT source avoids. The activity-only leg runs only when
// the child has sleep tracking ON *and* their sleep window is currently open (childSamplingActiveNow), so
// it samples overnight instead of burning CPU all day; the 5-min reconcile starts it at bedtime and
// stops it after wake. A camera with no child (or one outside its window) that isn't a framediff alerter
// runs no leg. Frame-diff ALERT legs above are NOT window-gated — alerts run 24/7.
export function motionLegWanted(camera) {
  // Detection switches do not stop the activity-only sleep sampler. The public demo plays a looped
  // fake camera, so sampling it would mix synthetic live motion into the deterministic seeded night.
  // Demo sleep remains enabled for analysis; only its live pixel-diff input is suppressed here.
  if (isDemoModeActive()) return false;
  if (!camera || camera.disabled) return false;
  if (motionAlerting(camera)) return true;
  // childSamplingActiveNow, not childWindowActiveNow: sampling opens a few hours BEFORE the configured
  // bedtime so an early night is captured (bedtime is never a rigid time). See its comment.
  return !!camera.child_id && childSamplingActiveNow(camera.child_id);
}

export async function startMotionDetector(camera) {
  await stopMotionDetector(camera.id);
  if (!motionLegWanted(camera)) return;
  // Activity-only when we want the leg but it isn't the alerting one (MQTT-source or motion-off, but
  // child-assigned). In that mode we record the movement signal and skip all alert bookkeeping.
  const activityOnly = !motionAlerting(camera);
  if (activityOnly) {
    logger.info(`[detect] activity-only motion leg for "${camera.name}" (sleep tracking; no alerts)`);
  }

  const { mask, zonePixels } = buildZoneMask(camera);
  const threshold = activeFractionThreshold(camera.detect_sensitivity);
  const confirmMs = Math.max(0, (camera.detect_confirm_s ?? 3) * 1000);
  const cooldownMs = Math.max(1, camera.detect_cooldown_s ?? 60) * 1000;

  // Believed occupancy (ROADMAP §1.2 item 1) — true = in bed, false = out of bed, null = not yet
  // known since this detector started. Deliberately declared OUTSIDE launch(), not inside it: an
  // ffmpeg blip triggers an automatic reconnect via launch() again (see the exit handler below), and
  // every OTHER piece of pending-candidate state already resets on that path — but a belief flag has
  // no "in-flight" data to lose, so there's no reason to also lose it, and losing it would silently
  // undercount exactly the same-direction repeats this diagnostic exists to surface (found by
  // adversarial review, 2026-09-12: a real reconnect between two into_bed events would otherwise mean
  // neither is ever flagged). Still resets to null on a genuinely fresh startMotionDetector call
  // (settings change, camera reassignment, app restart) — see its own comment on why that's correct.
  let believedOccupied = null;

  // #500: when this detector last relaunched itself from main back to the sub (performance.now(); null = never
  // since this start). Outside launch() for the same reason as believedOccupied: it has to outlive the relaunch
  // it triggers, or a sub that flaps would be switched back to every time. A fresh startMotionDetector call
  // forgets it (a settings save, or the 5-minute reconcile finding a detector in its relaunch gap): a small
  // accepted hole in the 10-minute bound, documented in KNOWN-ISSUES.
  let lastSwitchMono = null;

  async function launch() {
    // Claim the slot before the async gap below, so a concurrent start/reconcile can't
    // double-run this camera's detector.
    const entry = { proc: null, stopped: false };
    detectors.set(camera.id, entry);
    const path = await pickReadyPath(camera, entry);
    if (!path || entry.stopped) {
      if (detectors.get(camera.id) === entry) detectors.delete(camera.id);
      return;
    }
    const args = [
      '-nostdin',
      // `+level+info -nostats` (was `-loglevel error`): the taps log at INFO. The stderr router below
      // drops everything under ERROR again, so the log sees what it always saw. See ffmpegSideChannel.js
      // for why the RELATIVE spelling and -nostats are both load-bearing.
      ...SIDE_CHANNEL_LOG_ARGS,
      '-rtsp_transport', 'tcp',
      '-i', `rtsp://127.0.0.1:8554/${path}`,
      '-an',
      '-vf', TAPS.filter,
      '-f', 'rawvideo',
      '-',
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    entry.proc = proc;
    // #369: freshness stamps for the detector watchdog, all from performance.now() (monotonic: a wall-clock
    // step must never make a live leg look stale or a dead one fresh). Per ENTRY, i.e. per ffmpeg process, so a
    // replacement starts with no data and its own spawn time, and the watchdog can tell generations apart. (Every
    // launch builds a fresh entry, so lastDataMono/lastInputRecordMono start unset: "nothing yet".)
    entry.path = path;
    entry.spawnedMono = performance.now();
    // #500: this launch settled for the MAIN stream although the camera has a sub. Say so (nothing did before),
    // and watch for the sub coming back. `returnTimer` is armed AFTER the spawn so a failed spawn never has one
    // (its 'error' handler disarms anyway).
    const subPath = subPathOf(camera);
    if (subPath && path === camera.mediamtx_path) {
      logger.warn(
        `[detect:${path}] "${camera.name}": sub stream ${subPath} not ready, reading the MAIN stream (more CPU; the motion thresholds were calibrated on the sub); will return to the sub once it is ready`
      );
      armReturnCheck(subPath);
    }
    // One observation GENERATION per ffmpeg process (#373, C3): the stdout and stderr handlers below close
    // over this launch's own handle, so a late 'close' or late bytes from an old process can never touch a
    // newer one. The handle is fail-safe: whatever the clock does, it cannot throw into this file.
    //
    // #493: the clock's verdicts arrive ~5 s after each frame was counted (FINALIZE_MS), so a frame it
    // PROVES was a clone ffmpeg made up during a stall is taken back out of activity_samples' observed
    // counts (activityTracker.js's clone ledger). ONLY fps-clone / cfr-clone: `unknown` is never corrected,
    // because one lost stderr line, or a genuinely still and noiseless real room, finalizes real frames as
    // `unknown` too (the #493 plan's second review round). The listener keys by the observation's OWN `gen`,
    // not this launch's, so a verdict landing after a reconnect still corrects the frame it is about (the
    // clock keeps one listener per camera, refreshed on every launch). Nothing here feeds a decision: bed
    // transitions, alerts and every peak are what they were. (Not to be confused with #452, which stops a
    // confirmation spanning a sampling outage: that is decided in handleFrame, synchronously, from frame ARRIVAL
    // times by createFrameGapDetector, and neither waits for nor reads this clock's verdicts, which land ~5 s
    // after a frame.)
    const obs = openObservation(camera.id, 'motion', {
      label: camera.name,
      path,
      fps: FPS,
      onObservation: (o) => {
        if (o.cls === 'fps-clone' || o.cls === 'cfr-clone') excludeClone(camera.id, o.gen, o.token);
      },
    });
    // This launch's generation id, read once: null when there is no working clock, and then no frame is
    // staged at all, so the counts are exactly what they were before #493. `frameSeq` numbers this launch's
    // stdout frames; it is the `token` both the ledger and the clock carry for each one.
    const obsGen = obs.gen;
    let frameSeq = 0;

    proc.on('error', (err) => {
      // A spawn that never started. Node emits 'error' INSTEAD OF 'exit' here, so nothing downstream
      // runs — and with no listener on it an EventEmitter 'error' THROWS, taking the whole backend down.
      // On a baby monitor that is an outage. ENOENT (no ffmpeg on PATH — a broken image layer, a bad
      // volume mount) is the obvious trigger; EACCES, and EMFILE/EAGAIN under file-descriptor or fork
      // pressure, arrive the same way. See issue #257.
      //
      // Deliberately NOT scheduling the 5s relaunch the exit path uses: a binary that cannot be executed
      // fails identically every time, so that would be a hot loop writing a log line every five seconds
      // forever. Clearing the map entry instead lets the reconcile pass (every 5 minutes) retry at a
      // sane cadence, and isDetecting() reports the truth in the meantime — without this the leg would be
      // left claimed by a process that never existed, and reconcile would skip it as healthy.
      logger.error(`[detect:${path}] could not start ffmpeg: ${err.code || err.message}`);
      disarmReturnCheck(entry); // #500: a failed spawn never emits 'exit', which is the other place this is cleared
      if (detectors.get(camera.id) === entry) detectors.delete(camera.id);
    });

    let prev = null;
    let buf = Buffer.alloc(0);
    let activeSince = 0; // start of the current sustained-motion run (0 = not currently active)
    let lastActive = 0; // last frame that was above the active threshold
    // (#454: the alert stamp is no longer declared here, per launch. It is `motionAlertStamps` at module level, so
    // a relaunch keeps it; see the header above that Map. `prev`, `buf`, `activeSince`, `lastActive`, `frameGap` and
    // the tracker below stay per launch ON PURPOSE: a frame diff across two processes is meaningless, #452 ends a
    // run across any gap and a relaunch is the biggest gap, and the tracker's reasons are in that header.)
    // Out-of-bed / into-bed candidate state machine — see bedTransitionTracker.js. One instance per
    // launch() (i.e. per ffmpeg connection), matching where this state used to be declared; unlike
    // believedOccupied (declared above, outside launch()) this has nothing "in flight" worth keeping
    // across a reconnect.
    const bedTransitionTracker = createBedTransitionTracker({ activeGraceMs: ACTIVE_GRACE_MS, maxFrameGapMs: FRAME_GAP_MS });
    // #452: arrival-gap detector for the motion ALERT's run (the tracker owns its own for the bed transitions;
    // both read the same stream, so they agree). One per launch, like the tracker: a relaunch starts with no
    // history and its first frame is never a gap.
    const frameGap = createFrameGapDetector({ floorMs: FRAME_GAP_MS });

    const outPixels = mask ? FRAME_BYTES - zonePixels : 0; // area outside the bed zone (0 = whole frame)

    // `atMs` = the wall time the stdout event that COMPLETED this frame was received (`rx.wall`): the minute
    // activityTracker files the frame under (#447). One value per frame, passed to BOTH channels, so a frame
    // can never be split across two minutes (a clone verdict for it would then undo a count in the wrong one).
    function handleFrame(frame, token, atMs) {
      if (prev) {
        let changed = 0;
        let changedOut = 0;
        // Count changed pixels inside the bed mask (any of its rectangles), or the whole frame when
        // there's no zone. The mask counts each pixel once, so overlapping/diagonal boxes are fine.
        // With a bed zone, also count changes OUTSIDE it (parent/child-out-of-bed) as a separate channel.
        if (mask) {
          for (let i = 0; i < FRAME_BYTES; i++) {
            const d = frame[i] - prev[i];
            if (d > PIXEL_DELTA || d < -PIXEL_DELTA) { if (mask[i]) changed++; else changedOut++; }
          }
        } else {
          for (let i = 0; i < FRAME_BYTES; i++) {
            const d = frame[i] - prev[i];
            if (d > PIXEL_DELTA || d < -PIXEL_DELTA) changed++;
          }
        }
        const fraction = changed / zonePixels;
        const now = Date.now();
        // #452: did this frame arrive after a gap? Once per analysed frame, ahead of both the bed-transition
        // block and the alert block (and outside the `!activityOnly` branch, so the detector's picture of the
        // stream's spacing has no holes on any leg).
        const gap = frameGap.observe(now);
        // #500: when the room last moved, in EITHER channel, for the return-to-sub quiet gate. Set here, ahead of
        // the `!activityOnly` branch below: a sleep-tracking-only leg is exactly the one whose bed transitions
        // a relaunch could lose. Monotonic, like the other #369 stamps on the entry.
        let anyActive = fraction >= threshold;
        // #493: what the clone ledger needs to find this frame again, or null (no working clock).
        const sample = obsGen === null ? null : { gen: obsGen, token };
        // Feed the raw per-frame movement into the per-minute activity timeline (independent of the
        // alert threshold/cooldown below), so sleep tracking sees continuous motion, not just alerts.
        // Still counted HERE, synchronously, whatever the clock later says: see openObservation above.
        // Filed under the RECEIPT minute (#447), not `now`: `now` is this handler's own Date.now(), which the
        // decisions below keep using exactly as before, but a per-call clock read would let the two channels
        // of one frame, or the frames of one read, land either side of a minute boundary.
        recordMotion(camera.id, fraction, sample, atMs);
        // Outside-bed movement (only meaningful when a bed zone carves out an "outside") — a separate
        // channel so sleep tracking can flag someone in the room vs stirring in the bed.
        if (outPixels > 0) {
          const outFraction = changedOut / outPixels;
          if (outFraction >= threshold) anyActive = true;
          recordMotionOut(camera.id, outFraction, sample, atMs);
          // --- "Out of bed" / "into bed" classification. Runs whether the leg is alerting or
          // activity-only (a distinct, low-rate signal, not raw motion). The candidate state machine
          // itself lives in bedTransitionTracker.js (extracted 2026-09-18, see its header); this block
          // just feeds it per frame and turns its returned events into the exact log lines / DB writes
          // this used to produce inline — the extraction changed WHERE this logic lives, not WHAT it
          // does (see planning/reviews/simultaneous-activity-gap-plan-2026-09-18.md for why a live
          // behavior change wasn't safe to bundle with it).
          const cribActive = fraction >= threshold;
          const outActive = outFraction >= threshold;
          const { events, believedOccupied: nextBelievedOccupied } = bedTransitionTracker.pushFrame(
            { cribActive, outActive, fraction, outFraction },
            now,
            believedOccupied
          );
          believedOccupied = nextBelievedOccupied;
          for (const ev of events) {
            switch (ev.type) {
              case 'oob-candidate-open':
                logger.info(
                  `[oob] "${camera.name}" exit candidate (${ev.link}) — bed active ${ev.sinceMs}ms ago, outside now ${(ev.outFraction * 100).toFixed(1)}%`
                );
                break;
              case 'oob-near-miss':
                logger.info(
                  `[oob] "${camera.name}" link rejected — bed active ${ev.sinceMs}ms ago, outside ${(ev.outFraction * 100).toFixed(1)}% (need <=${OOB_LINK_MS}ms, or <=${OOB_LINK_SLOW_MS}ms at >=${(OOB_SLOW_OUT_MIN * 100).toFixed(0)}%)`
                );
                break;
              case 'oob-cancelled':
                logger.info(`[oob] "${camera.name}" candidate cancelled — bed re-active after ${ev.pendingForMs}ms`);
                break;
              case 'oob-confirm-restarted':
                // #452: info, and only emitted when a candidate was actually pending, so a healthy camera
                // at its normal rate gains no noise (a cold slow camera logs a few while its window warms up). These lines are also the staging evidence for how often the rule fires.
                logger.info(
                  `[oob] "${camera.name}" confirmation restarted — ${gapText(ev.gapMs)} (needs ${OOB_CONFIRM_QUIET_MS}ms of received quiet from here)`
                );
                break;
              case 'oob-impossible-flag':
                // ROADMAP §1.2 item 1, LOG-ONLY (2026-09-12: a retrospective check against real
                // owner-verdicted transitions found that unconditionally SUPPRESSING a repeat is
                // unsafe — see outOfBedRejected's comment in bedTransitionRules.js).
                logger.info(
                  `[oob] "${camera.name}" OUT OF BED would be flagged impossible — already believed out of bed (§1.2 item 1, log-only)`
                );
                break;
              case 'oob-confirmed':
                logger.info(
                  `[oob] "${camera.name}" OUT OF BED — motion left the bed, quiet ${OOB_CONFIRM_QUIET_MS}ms since, outside peak ${(ev.peak * 100).toFixed(1)}%`
                );
                recordBedTransition(camera.id, TRANSITION.OUT_OF_BED, ev.peak, {
                  outPeak: ev.outPeak,
                  outFrames: ev.outFrames,
                });
                break;
              case 'ib-candidate-open':
                logger.info(
                  `[intobed] "${camera.name}" entry candidate — outside active ${ev.sinceMs}ms ago, bed now ${(ev.fraction * 100).toFixed(1)}%`
                );
                break;
              case 'ib-near-miss': {
                const since = ev.sinceMs != null ? `${ev.sinceMs}ms ago` : 'never (this run)';
                logger.info(
                  `[intobed] "${camera.name}" bed active with no entry link — outside last active ${since} (need <=${IB_LINK_MS}ms), believed ${ev.believedOccupied === false ? 'out of bed' : 'unknown'}`
                );
                break;
              }
              case 'ib-cancelled':
                logger.info(`[intobed] "${camera.name}" candidate cancelled — outside re-active after ${ev.pendingForMs}ms`);
                break;
              case 'ib-confirm-restarted':
                logger.info(
                  `[intobed] "${camera.name}" confirmation restarted — ${gapText(ev.gapMs)} (needs ${IB_CONFIRM_QUIET_MS}ms of received quiet from here)`
                );
                break;
              case 'ib-impossible-flag':
                // ROADMAP §1.2 item 1, LOG-ONLY — see the OOB side's comment for why this flags rather
                // than suppresses.
                logger.info(
                  `[intobed] "${camera.name}" INTO BED would be flagged impossible — already believed in bed (§1.2 item 1, log-only)`
                );
                break;
              case 'ib-confirmed':
                logger.info(
                  `[intobed] "${camera.name}" INTO BED — motion entered the bed, outside quiet ${IB_CONFIRM_QUIET_MS}ms since, bed peak ${(ev.peak * 100).toFixed(1)}%`
                );
                recordBedTransition(camera.id, TRANSITION.INTO_BED, ev.peak, {
                  outPeak: ev.outPeak,
                  outFrames: ev.outFrames,
                });
                break;
              case 'co-active-episode':
                // ROADMAP §1.2 item 3, purely observational (see bedTransitionTracker.js's header and
                // planning/reviews/simultaneous-activity-gap-plan-2026-09-18.md) — gathers real
                // duration/quiet-side data for a future candidate-open design; never influences
                // detection, never touches bed_transitions.
                logger.info(
                  `[coactive] "${camera.name}" bed+outside both active ${ev.durationMs}ms, then ${ev.quietSide} quiet — bed peak ${(ev.cribPeak * 100).toFixed(1)}%, outside peak ${(ev.outPeak * 100).toFixed(1)}%`
                );
                break;
              default:
                break;
            }
          }
        }
        if (anyActive) entry.lastActiveMono = performance.now();
        // Activity-only legs (MQTT-source / motion-off child cameras) stop here — no alert bookkeeping.
        if (!activityOnly) {
          // ★ #452: a frame that arrives after a gap ends the current run, so an active frame, a long silence
          // and another active frame can no longer satisfy `confirmMs` on the spot (acceptance criterion (a)).
          // The measure is the gap between CONSECUTIVE FRAMES (what the detector sees), not `now - lastActive`:
          // the two are not byte-identical in steady state (a quiet stretch under ACTIVE_GRACE_MS followed by an
          // active frame is a continuing run and must stay one). An active post-gap frame then starts a fresh run
          // at `now`. No camera path in the line: the #493 stall tests give each clock variant its own path and
          // require identical logs across variants. The alert cooldown is wall time by design and #452 does not
          // touch it (#454 keeps it across a relaunch, below). `detect_confirm_s = 0` is a legal setting
          // (routes/cameras.js): the post-gap active frame starts a run and `0 >= 0` alerts at once, which is kept
          // on purpose; "a gap frame cannot confirm" means a POSITIVE confirmation time. After a relaunch that
          // first active frame alerts at once only if the cooldown since the last alert has elapsed (#454).
          //
          // #454: the cooldown stamp, read ONCE per analysed frame, ahead of the run logic. Read on EVERY frame (not
          // only an active one) so a stamp left ahead of `now` by a backward wall-clock step is clamped to now on the
          // first frame after the step and the one-cooldown-of-silence bound starts there; see alertStampFor and the
          // header above the Map. `stampKey` is one named seam so the key is one thing, read and written alike.
          // Only this branch ever touches the Map: an activity-only leg fires no alerts and never stamps.
          const stampKey = camera.id;
          const storedStamp = motionAlertStamps.get(stampKey);
          const lastAlert = alertStampFor(storedStamp, now);
          if (storedStamp != null && lastAlert !== storedStamp) motionAlertStamps.set(stampKey, lastAlert);
          if (gap && activeSince) {
            activeSince = 0;
            logger.info(`[detect] "${camera.name}" motion run restarted — ${gapText(gap.gapMs)}`);
          }
          if (fraction >= threshold) {
            if (!activeSince) activeSince = now;
            lastActive = now;
            if (now - activeSince >= confirmMs && now - lastAlert >= cooldownMs && inActiveWindow(camera)) {
              // inActiveWindow gates the WHOLE alert: outside a camera's schedule, motion produces no
              // in-app event and no push, and the stamp is left untouched so an alert can fire promptly
              // the moment the window opens (also across a relaunch: the stamp is only written when an alert FIRES).
              motionAlertStamps.set(stampKey, now); // cooldown gates re-fire; a continuing run alerts once per cooldown
              const pct = (fraction * 100).toFixed(1);
              // Shared downstream (record event + push both channels); pass the exact path we're
              // analysing so a stream-grab snapshot uses the same (cheap) sub-stream. Fire-and-forget.
              fireDetectionAlert(camera, ALERT.MOTION, `${pct}% of zone`, { snapshotPath: path }).catch(() => {});
            }
          } else if (activeSince && now - lastActive > ACTIVE_GRACE_MS) {
            activeSince = 0; // the run ended (gap exceeded the grace window)
          }
        }
      }
      prev = frame;
    }

    // #500: the return check for a detector that fell back to main (armed by launch() above). One tick every
    // timing.recheckMs; see SUB_RECHECK_MS for what it waits for and why.
    function armReturnCheck(subPath) {
      let readyRun = 0; // consecutive ready SAMPLES of the sub
      let checking = false; // a getPathStatus is awaiting
      let skipped = false; // a tick was skipped while one was awaiting: that answer no longer ends an unbroken run

      // True while this entry is still the live, tracked, un-stopped one that nobody is already killing.
      const live = () =>
        detectors.get(camera.id) === entry && !entry.stopped && !entry.returning && !entry.watchdogKill;

      async function tick() {
        // Guard FIRST, and disarm on failure: a timer that outlived its generation sends no request (this
        // returns before any), so only this self-clear and the clears at exit/error/stop keep it from leaking
        // the old launch's whole closure (the previous frame buffer among it) once per fallback.
        if (!live()) { disarmReturnCheck(entry); return; }
        // A tick that starts while the previous one is still awaiting is a SKIPPED OBSERVATION (#451's rule):
        // the previous one's answer is stale by the time it lands, so it must not extend the run. Production
        // cannot overlap (20 s between ticks vs the 5 s MediaMTX deadline) but nothing else pins that.
        if (checking) { skipped = true; return; }
        checking = true;
        let status = null;
        try {
          status = await getPathStatus(subPath).catch(() => null);
        } finally {
          checking = false;
        }
        // Re-check after the await: the entry may have been stopped, replaced or killed while we waited.
        if (!live()) { disarmReturnCheck(entry); return; }
        readyRun = skipped ? 0 : nextReadyRun(readyRun, status);
        skipped = false;
        const nowMono = performance.now();
        // Quiet = since the last frame that was active in EITHER channel (inside or outside the bed zone), or
        // since this process started if none was. See SUB_QUIET_MS for why this must outlast the slow link.
        const quietMs = nowMono - Math.max(entry.lastActiveMono ?? 0, entry.spawnedMono);
        const sinceLastSwitchMs = lastSwitchMono == null ? null : nowMono - lastSwitchMono;
        if (!shouldReturnToSub({ readyRun, quietMs, sinceLastSwitchMs })) return;

        // Mark first so a second tick, or the #369 watchdog (killStalledDetector refuses a `returning` entry),
        // cannot arm a second kill while this one is in flight.
        entry.returning = true;
        if (!killIfSpawned(proc, 'SIGTERM')) {
          entry.returning = false; // nothing was signalled (no process, or already reaped): try again next tick
          return;
        }
        disarmReturnCheck(entry);
        lastSwitchMono = nowMono;
        logger.info(
          `[detect:${path}] "${camera.name}": sub stream ${subPath} ready again (${readyRun} checks, quiet ${Math.round(quietMs / 1000)}s), returning the motion detector from main to sub (a relaunch: ~${Math.round(timing.restartDelayMs / 1000)}s gap; the bed-transition state resets, the alert cooldown carries over)`
        );
        // The same SIGKILL fallback stopMotionDetector and killStalledDetector use, cleared when SIGTERM works.
        const force = setTimeout(() => killIfSpawned(proc, 'SIGKILL'), FORCE_KILL_TIMEOUT_MS);
        force.unref?.();
        proc.once('exit', () => clearTimeout(force));
      }

      entry.returnTimer = safeInterval(`detect-return:${camera.name}`, timing.recheckMs, tick);
      entry.returnTimer.unref?.();
      returnTimers.add(entry.returnTimer);
    }

    proc.stdout.on('data', (chunk) => {
      // #369: the leg's freshness signal is "a stdout byte arrived", read straight from performance.now(), once
      // per event. Deliberately NOT rx.mono: the observation clock can be absent, throwing or test-planted
      // (openObservation is fail-safe by design), and a watchdog must not go blind when it does. Bytes, not
      // activity: a still room still delivers frames, so a quiet night never looks stale. Placed before the
      // receipt so the #373 one-receipt-per-event contract (R1-F8) and its lines are untouched.
      entry.lastDataMono = performance.now();
      // #373: the receipt time, read ONCE per 'data' event, so a frame split across two reads carries the
      // completing read's time. Two clock reads per event; nothing else of the observation runs before a
      // frame's own decision.
      // #447: `rx.wall` is also the minute activity_samples files every frame of this event under. The
      // handle's receipt() never throws and falls back to Date.now() (read once, here) without a working
      // clock, so an absent or broken clock still files frames by when they arrived.
      const rx = obs.receipt();
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= FRAME_BYTES) {
        const frame = Buffer.from(buf.subarray(0, FRAME_BYTES));
        const token = frameSeq++;
        handleFrame(frame, token, rx.wall);
        // #373: exactly one observation per frame, AFTER its decision handler has returned (plan §D,
        // R1-F8): the handler's inputs are the same bytes in the same order, and its own Date.now() is
        // read before any observation work for this frame. The clock only reads the frame.
        // #493: the same token, so the verdict on this frame finds the counts handleFrame just staged.
        obs.onSample(frame, rx.mono, rx.wall, { token });
        buf = buf.subarray(FRAME_BYTES);
      }
    });

    // #373: stderr now carries the taps' per-frame records as well as ffmpeg's errors. The router sends
    // records to the observation clock and the errors to the log exactly as `-loglevel error` printed them
    // (see ffmpegSideChannel.js for the rules, the rate limits and the repeat collapse).
    const router = createStderrRouter({
      taps: TAPS.taps,
      forward: (line) => logger.raw(`detect:${path}`, line),
      // #369, DIAGNOSIS ONLY: when the INPUT tap (`in`, before fps/scale) last printed a record, so the watchdog's
      // log line can say whether decoded input frames were still arriving while stdout was silent. Its absence
      // proves nothing (Astra R2): a SIGSTOPped or decoder-stalled ffmpeg prints no records either, so the
      // watchdog reports a missing stamp as inconclusive and never acts on it.
      onRecord: (rec) => {
        if (rec?.tap === 'in') entry.lastInputRecordMono = performance.now();
        obs.onRecord(rec);
      },
      onConfig: obs.onConfig,
      onParseError: obs.onParseError,
    });
    forwardProcessLines(proc, proc.stderr, (line) => {
      if (line.trim()) router.line(line);
    });
    // The generation ends on 'close', NEVER 'exit' (R1-F7): stdout can still drain after 'exit'
    // (processOutput.js), and those frames are real and analysed. Registered after forwardProcessLines,
    // whose own 'close' listener flushes the last partial stderr line first (listeners run in order).
    proc.once('close', (code, signal) => {
      router.end();
      obs.end(entry.stopped ? 'stop' : 'exit', { code, signal });
    });

    proc.on('exit', (code) => {
      disarmReturnCheck(entry); // #500: the timer belongs to this process
      const wasTracked = detectors.get(camera.id) === entry;
      if (wasTracked) detectors.delete(camera.id);
      if (!entry.stopped && wasTracked) {
        // code 0 = the upstream stream ended (a camera/transcoder blip), not an error — just
        // reconnect quietly, re-picking sub vs main. Only a real failure is logged loudly.
        // #369: a kill by the detector watchdog is a recovery, not a failure, so INFO; it already logged its own
        // diagnosis line. The phrase "restarting in 5s" is kept on purpose: restart-cancellation.test.js counts
        // relaunches by it, and a watchdog kill goes through this very relaunch.
        // #500: our own return to the sub is a deliberate kill too, and is tested BEFORE the code branches: an
        // ffmpeg that gets SIGTERM exits non-zero (or with a signal and a null code), so an unordered check
        // would log an ERROR for every switch. (The 5s in the text is the real RESTART_DELAY_MS in production.)
        if (entry.watchdogKill) logger.info(`[detect:${path}] stopped by the detector watchdog (no frames), restarting in 5s`);
        else if (entry.returning) logger.info(`[detect:${path}] returning to the sub stream, restarting in 5s`);
        else if (code === 0) logger.raw(`detect:${path}`, 'stream ended, reconnecting');
        else logger.error(`[detect:${path}] exited (code ${code}), restarting in 5s`);
        pendingRestarts.set(camera.id, setTimeout(() => {
          pendingRestarts.delete(camera.id);
          if (!entry.stopped && !detectors.has(camera.id)) launch().catch(() => {});
        }, timing.restartDelayMs));
      }
    });
  }

  launch().catch(() => {});
}

export function stopMotionDetector(cameraId) {
  // FIRST, before the early return: a camera in the 5s restart gap has no entry but does have a
  // relaunch armed, and stop() used to return without cancelling it (#253).
  cancelPendingRestart(cameraId);

  const entry = detectors.get(cameraId);
  if (!entry) return Promise.resolve();
  entry.stopped = true;
  detectors.delete(cameraId);
  disarmReturnCheck(entry); // #500: synchronously, before the kill, so no tick can race the stop
  // Caught during launch()'s async path-selection gap (no process spawned yet) — the launch
  // will see `stopped` and abort itself, so there's nothing to kill.
  if (!entry.proc) return Promise.resolve();
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    // See stopTranscoder for the full reasoning: a process that never spawned must not be killed
    // directly (on Linux that signals the whole process group — see killIfSpawned in processGuards.js),
    // and it emits 'error'/'close' but never 'exit', so waiting on 'exit' alone stalls for the whole timeout.
    const kill = (sig) => killIfSpawned(entry.proc, sig);
    entry.proc.once('exit', done);
    entry.proc.once('error', done);
    kill('SIGTERM');
    setTimeout(() => {
      if (!resolved) {
        kill('SIGKILL');
        done();
      }
    }, FORCE_KILL_TIMEOUT_MS);
  });
}

export async function stopAllMotionDetectors() {
  // Union of both maps: a camera in its restart gap is in pendingRestarts only, and iterating
  // detectors alone would leave its relaunch armed through shutdown.
  const ids = new Set([...detectors.keys(), ...pendingRestarts.keys()]);
  await Promise.all([...ids].map(stopMotionDetector));
}
