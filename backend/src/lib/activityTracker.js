import db from '../db.js';
import { logger } from './logger.js';

// Per-minute activity timeline for sleep tracking. The motion and sound detectors call recordMotion /
// recordSound on every analysis frame/window (~5/s each). We accumulate those raw signals in memory
// per camera and, once a minute, flush one aggregated row per active camera into activity_samples.
// This is deliberately independent of the detection-alert cooldown: alerts are throttled (good for
// notifications, useless for inferring sleep), whereas this captures a continuous overnight timeline
// of how much a room moved and how loud it got. Stage-2 phase 3's nightly job reads these rows.

const FLUSH_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

// camera_id -> { motionSum, motionPeak, motionFrames, soundSum, soundPeak, soundWindows }
const buckets = new Map();

function slot(cameraId) {
  let s = buckets.get(cameraId);
  if (!s) {
    s = { motionSum: 0, motionPeak: 0, motionFrames: 0, soundSum: 0, soundPeak: 0, soundWindows: 0,
      motionOutSum: 0, motionOutPeak: 0, motionOutFrames: 0 };
    buckets.set(cameraId, s);
  }
  return s;
}

// Called by motionDetector for every analysis frame. `fraction` = 0..1 of the crib zone that changed.
export function recordMotion(cameraId, fraction) {
  if (!(fraction >= 0)) return;
  const s = slot(cameraId);
  s.motionSum += fraction;
  if (fraction > s.motionPeak) s.motionPeak = fraction;
  s.motionFrames++;
}

// Called by motionDetector for every frame when the camera has a crib zone — `fraction` = 0..1 of the
// area OUTSIDE the crib that changed (someone moving in the room / the child out of bed). Kept separate
// from in-crib motion so the sleep timeline can tell stirring-in-bed from room activity.
export function recordMotionOut(cameraId, fraction) {
  if (!(fraction >= 0)) return;
  const s = slot(cameraId);
  s.motionOutSum += fraction;
  if (fraction > s.motionOutPeak) s.motionOutPeak = fraction;
  s.motionOutFrames++;
}

// Called by soundDetector for every loudness window. `overDb` = dB above the rolling ambient baseline
// (already clamped to >= 0 by the caller); a cry pushes this up, a quiet room sits near 0.
export function recordSound(cameraId, overDb) {
  if (!(overDb >= 0)) return;
  const s = slot(cameraId);
  s.soundSum += overDb;
  if (overDb > s.soundPeak) s.soundPeak = overDb;
  s.soundWindows++;
}

// 'YYYY-MM-DD HH:MM:00' in UTC (matches datetime('now') so it lines up with sensor_readings etc.).
function minuteBucketUtc(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
}

const insertSample = db.prepare(
  `INSERT INTO activity_samples
     (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak, motion_frames,
      sound_windows, motion_out_level, motion_out_peak)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Write one row per camera that saw any signal in the last minute, then reset. Exported for tests /
// forced flushes; normally driven by the interval below.
export function flushActivity() {
  if (buckets.size === 0) return 0;
  const bucket = minuteBucketUtc();
  const pending = buckets;
  // Swap the map out first so signals arriving mid-flush accumulate into the next minute, not this one.
  const snapshot = [...pending.entries()];
  buckets.clear();
  let written = 0;
  for (const [cameraId, s] of snapshot) {
    if (s.motionFrames === 0 && s.soundWindows === 0) continue;
    try {
      insertSample.run(
        cameraId,
        bucket,
        s.motionFrames ? s.motionSum / s.motionFrames : null,
        s.motionFrames ? s.motionPeak : null,
        s.soundWindows ? s.soundSum / s.soundWindows : null,
        s.soundWindows ? s.soundPeak : null,
        s.motionFrames,
        s.soundWindows,
        s.motionOutFrames ? s.motionOutSum / s.motionOutFrames : null,
        s.motionOutFrames ? s.motionOutPeak : null
      );
      written++;
    } catch {
      /* a single bad insert shouldn't drop the rest of the minute */
    }
  }
  return written;
}

export function pruneActivitySamples() {
  try {
    const { changes } = db
      .prepare("DELETE FROM activity_samples WHERE created_at < datetime('now', ?)")
      .run(`-${RETENTION_DAYS} days`);
    if (changes > 0) logger.info(`[activity] Pruned ${changes} sample(s) older than ${RETENTION_DAYS} days.`);
  } catch {
    /* ignore */
  }
}

let flushTimer = null;
let pruneTimer = null;

// Start the per-minute flusher + daily prune. Idempotent.
export function startActivityTracker() {
  if (flushTimer) return;
  flushTimer = setInterval(flushActivity, FLUSH_INTERVAL_MS);
  pruneTimer = setInterval(pruneActivitySamples, PRUNE_INTERVAL_MS);
  pruneActivitySamples();
  logger.info(`[activity] Bucketing motion/sound activity per minute, keeping ${RETENTION_DAYS} days.`);
}
