import db from '../db.js';
import { logger } from './logger.js';
import { onMinuteFlushed } from './activityTracker.js';
import { SLEEP_THRESHOLDS, childTracksSleep, childWindowActiveNow } from './sleepAnalysis.js';
import { holdRing, releaseRing, isSegmenterRunning } from './clipRecorder.js';
import { RING_OWNER } from './ringHolds.js';
import { captureWakeClip, pruneWakeClips } from './recordings.js';

// Live wake detection, for recording only — it never alerts.
//
// Why this exists: measured over 101 prod wakes, 53% produced NO alert at all, so more than half the
// wakes on the sleep timeline had nothing to look at in the morning. That is not an alerting bug. The
// two systems ask different questions and always will: the sleep tracker counts a minute active on a
// single ~200 ms blip, while an alert deliberately waits for 2-3 seconds SUSTAINED so it doesn't wake a
// parent for a creak. Rather than make alerting noisier, this records the wake and stays silent.
//
// It mirrors the nightly job's wake rule minute by minute, using the SAME thresholds
// (SLEEP_THRESHOLDS, imported — never copied), so a clip exists exactly when the timeline shows a wake:
//   * a minute is ACTIVE if in-bed motion or sound crosses its threshold;
//   * a run of active minutes, bridging quiet gaps up to WAKE_GAP_MIN, is a WAKE once it contains
//     WAKE_ACTIVE_MIN active minutes;
//   * anything shorter is a stir and is deliberately NOT recorded (owner's call, 2026-08-26).
//
// The ring is the reason this can work at all. It is only ~63s deep, but a wake needs several minutes
// to qualify, so the moment we see the FIRST active minute we hold the ring at that point. If the run
// turns out to be a stir we release it and nothing is written. See clipRecorder.holdRing.

const { MOTION_ACTIVE, SOUND_ACTIVE, ONSET_QUIET_MIN, WAKE_ACTIVE_MIN, WAKE_GAP_MIN } = SLEEP_THRESHOLDS;

const MINUTE_MS = 60 * 1000;
// A little before the first active minute, so the hold covers the clip's lead-in too.
const HOLD_LEAD_MS = 15 * 1000;
// A run only survives while an active minute keeps arriving inside the bridging window, so by
// construction an un-qualified run cannot live longer than
// (WAKE_ACTIVE_MIN - 1) active + WAKE_ACTIVE_MIN * WAKE_GAP_MIN quiet minutes — about 17. There is
// therefore no need for a time backstop on the NORMAL path.
//
// What does need one: activityTracker only flushes a camera that saw signal, so a camera that goes
// offline mid-run simply stops calling us. Its run would stay open and its ring hold would never be
// released — the ring then grows without bound for as long as the camera is down. Nothing on the
// per-minute path can notice that, precisely because the per-minute path has stopped, so it is swept
// on a timer instead.
const STALE_RUN_MS = 20 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// camera_id -> { asleep, quietRun, run }
// run = { startMs, activeCount, lastActiveMs, captured, holding }
const state = new Map();

function slot(cameraId) {
  let st = state.get(cameraId);
  if (!st) {
    st = { asleep: false, quietRun: 0, run: null };
    state.set(cameraId, st);
  }
  return st;
}

// Drop any ring hold this camera is holding and forget the in-flight run. Safe to call repeatedly.
function endRun(cameraId, st, why) {
  if (st.run?.holding) {
    releaseRing(cameraId, RING_OWNER.WAKE);
    if (why) logger.info(`[wake] "${cameraId}" run ended (${why}) — ring released, nothing recorded`);
  }
  st.run = null;
}

function reset(cameraId, st) {
  endRun(cameraId, st, null);
  st.asleep = false;
  st.quietRun = 0;
}

const cameraQ = db.prepare('SELECT id, name, child_id, disabled FROM cameras WHERE id = ?');

// 'YYYY-MM-DD HH:MM:00' (UTC, from activityTracker) -> epoch ms.
function bucketMs(bucketStart) {
  return Date.parse(`${bucketStart.replace(' ', 'T')}Z`);
}

export function handleMinute({ cameraId, bucketStart, motionPeak, soundPeak }) {
  const st = slot(cameraId);
  const camera = cameraQ.get(cameraId);

  // Only tracked children, only inside their own sleep window. Outside it there is no "wake" to speak
  // of, and bedtime settling must never be recorded — which is also why nothing is armed until the
  // child has actually gone to sleep (see the onset gate below).
  if (!camera || camera.disabled || !camera.child_id || !childTracksSleep(camera.child_id) || !childWindowActiveNow(camera.child_id)) {
    reset(cameraId, st);
    return null;
  }

  const at = bucketMs(bucketStart);
  if (!Number.isFinite(at)) return null;

  const active =
    (motionPeak != null && motionPeak > MOTION_ACTIVE) || (soundPeak != null && soundPeak > SOUND_ACTIVE);

  // --- onset gate: nothing is recorded until the child is actually asleep ---
  if (!st.asleep) {
    st.quietRun = active ? 0 : st.quietRun + 1;
    if (st.quietRun >= ONSET_QUIET_MIN) {
      st.asleep = true;
      st.quietRun = 0;
      logger.info(`[wake] "${camera.name}" settled — watching for wakes`);
    }
    return null;
  }

  if (active) {
    if (!st.run) {
      st.run = { startMs: at, activeCount: 0, lastActiveMs: at, captured: false, holding: false };
      // Hold from the first active minute so the wake's opening survives the ~63s ring long enough to
      // find out whether this is a wake or just a stir.
      if (isSegmenterRunning(cameraId)) {
        holdRing(cameraId, RING_OWNER.WAKE, at - HOLD_LEAD_MS);
        st.run.holding = true;
      }
    }
    st.run.activeCount++;
    st.run.lastActiveMs = at;

    if (!st.run.captured && st.run.activeCount >= WAKE_ACTIVE_MIN) {
      st.run.captured = true;
      const startMs = st.run.startMs;
      logger.info(
        `[wake] "${camera.name}" awake (${st.run.activeCount} active min) — recording the opening, no alert`
      );
      // Fire and forget: the capture awaits a segment settle, and the watcher must stay responsive to
      // the next minute. The ring hold is released once the cut is done, not before.
      captureWakeClip(camera, startMs)
        .catch((err) => logger.error(`[wake] capture failed for "${camera.name}": ${err.message}`))
        .finally(() => {
          if (st.run?.holding && st.run.startMs === startMs) {
            releaseRing(cameraId, RING_OWNER.WAKE);
            st.run.holding = false;
          }
        });
      return { captured: true, startMs };
    }
    return null;
  }

  // Quiet minute. A wake can be intermittent, so short gaps are bridged; a longer one ends the run.
  if (st.run) {
    const gapMin = Math.round((at - st.run.lastActiveMs) / MINUTE_MS);
    if (gapMin > WAKE_GAP_MIN) {
      endRun(cameraId, st, st.run.captured ? null : 'stir, under the wake threshold');
    }
  }
  return null;
}

/**
 * Release ring holds for runs whose camera has gone quiet on us entirely — see STALE_RUN_MS. Exported
 * so a test can drive it without waiting on a timer. Returns how many runs were abandoned.
 */
export function sweepStaleRuns(now = Date.now()) {
  let swept = 0;
  for (const [cameraId, st] of state) {
    if (st.run && now - st.run.lastActiveMs > STALE_RUN_MS) {
      endRun(cameraId, st, 'camera stopped reporting');
      swept++;
    }
  }
  return swept;
}

let unsubscribe = null;
let pruneTimer = null;
let sweepTimer = null;

/** Start watching. Idempotent. */
export function startWakeWatcher() {
  if (unsubscribe) return;
  unsubscribe = onMinuteFlushed(handleMinute);
  sweepTimer = setInterval(() => {
    try { sweepStaleRuns(); } catch (err) { logger.error(`[wake] stale-run sweep failed: ${err.message}`); }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  pruneTimer = setInterval(() => {
    try { pruneWakeClips(); } catch (err) { logger.error(`[wake] retention sweep failed: ${err.message}`); }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
  try { pruneWakeClips(); } catch { /* first sweep is best-effort */ }
  logger.info(
    `[wake] Recording wakes without alerting (>= ${WAKE_ACTIVE_MIN} active min; stirs ignored).`
  );
}

/** Stop watching and release any ring holds. Used by tests and shutdown. */
export function stopWakeWatcher() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  for (const [cameraId, st] of state) reset(cameraId, st);
  state.clear();
}

/** Test seam: current per-camera watcher state. */
export function _state() {
  return state;
}
