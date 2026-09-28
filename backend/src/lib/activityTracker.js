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

// camera_id -> per-minute sums/peaks/counts plus sound readings and their sum of squares.
const buckets = new Map();

// Listeners called once per camera per flushed minute, with the same peaks that were just written.
// This is how lib/wakeWatcher.js sees activity LIVE: it needs the identical signal the nightly job
// reads, and re-querying activity_samples every minute would be the same data a second time. Kept as
// a subscription rather than a direct import so activityTracker has no dependency on its consumers.
const minuteListeners = new Set();

/** Subscribe to per-minute activity. cb({ cameraId, bucketStart, motionPeak, soundPeak }). */
export function onMinuteFlushed(cb) {
  minuteListeners.add(cb);
  return () => minuteListeners.delete(cb);
}

// ★ TWO FRAME COUNTS PER CHANNEL (issue #493). `motionFrames` / `motionOutFrames` are RAW: every frame the
// detector analysed, exactly as before #493, and they alone decide whether a row is written at all,
// whether `motion_peak` / `motion_out_peak` is a number or NULL, and the minute listener's `motionPeak`.
// `observedMotionFrames` / `observedMotionOutFrames` start equal to them and lose each frame the
// observation clock later PROVES was a clone (see the clone ledger below); they feed only the stored
// `motion_frames` and the two MEANS, `motion_level` and `motion_out_level`.
// Why not one counter: a bucket corrected all the way to 0 would then skip its row or NULL out a peak that
// real frames earlier in the same minute had set — silently losing a measured value (the #493 plan's second
// review round, Opus). With two, "peaks and the row-write decision are untouched" holds by construction.
// Nothing sleep analysis thresholds read changes either way: every calibrated threshold compares against a
// peak (a MAXIMUM), and a clone, which repeats the frame before it, has a fraction of exactly 0.
function slot(cameraId) {
  let s = buckets.get(cameraId);
  if (!s) {
    s = { motionSum: 0, motionPeak: 0, motionFrames: 0, observedMotionFrames: 0,
      soundSum: 0, soundPeak: 0, soundWindows: 0, soundValues: [], soundSumSq: 0,
      motionOutSum: 0, motionOutPeak: 0, motionOutFrames: 0, observedMotionOutFrames: 0 };
    buckets.set(cameraId, s);
  }
  return s;
}

// --- the clone ledger (issue #493) --------------------------------------------------------------------------
// ffmpeg's `fps=5` fills a camera stall by repeating the last real frame, and the diff detector reads each
// repeat as a perfectly still room that nobody observed. observationClock.js classifies every frame a few
// seconds AFTER the detector has already counted it (FINALIZE_MS, 5 s), so the correction is a LEDGER, not a
// gate: every frame is counted live, exactly as before, and a frame later proven to be a clone is taken back
// out of the observed counts. If no classification ever arrives (no clock, a throwing one, a lost side
// channel that makes everything `unknown`), nothing is taken out and the bucket is exactly what it was
// before #493 — the failure mode is "uncorrected", never "lost data". A first design that instead HELD each
// frame until it was classified was rejected in review: a clock that throws or degrades to `unknown` would
// have silently dropped a whole night of motion.
//
// Key: `${cameraId}:${gen}:${token}` -> { bucket, motion, out }. `gen` is the observation generation (one
// per ffmpeg launch; ids are never reused for the life of the process) and `token` the detector's own frame
// number within that launch, which restarts at 0 on every reconnect. The gen half is what makes a late
// classification from a torn-down launch unable to hit the new launch's frame with the same token (the
// reconnect race the first design's review found). `motion` / `out` record which channels this frame was
// actually counted in, so a correction can only ever undo an increment that really happened: a camera with
// no bed zone never counts an out-of-bed frame, so its out count can never be driven below zero (a negative
// count is truthy, and would have turned its NULL `motion_out_level` into a number).
const cloneLedger = new Map();
const ledgerKey = (cameraId, gen, token) => `${cameraId}:${gen}:${token}`;

// Stage a frame that was just counted into bucket `s`, when the detector knows its (gen, token).
// ★ Only a frame that added EXACTLY 0 to its channel's sum is staged. A true clone always does (it is a
// byte-identical repeat of the frame before it), so this costs no correction; it makes "the ledger never
// touches motionSum / motionOutSum" safe by construction instead of by argument: a frame that registered
// any movement is never taken out, so a mean can never be raised by removing a frame whose motion stays in
// the sum. (Added by the #493 build on top of the plan, which assumed the fraction was 0.)
function stageFrame(cameraId, s, sample, fraction, channel) {
  if (!sample || fraction !== 0) return;
  const key = ledgerKey(cameraId, sample.gen, sample.token);
  let entry = cloneLedger.get(key);
  if (!entry) {
    entry = { bucket: s, motion: false, out: false };
    cloneLedger.set(key, entry);
  }
  entry[channel] = true;
}

// The observation clock proved frame (gen, token) of this camera was a clone (fps-clone or cfr-clone; the
// caller never passes `unknown`, which also covers healthy real frames whose evidence was lost). Take it
// back out of the observed counts it was staged in. Idempotent: the entry is removed, so a repeat is a
// no-op. A frame whose bucket has already been flushed is no longer in the ledger (pruned in
// flushActivity), so a late classification changes nothing: the accepted residual documented in
// KNOWN-ISSUES.md ("A stalled camera's repeated pictures are left out of the per-minute motion count").
// Returns whether anything was corrected.
export function excludeClone(cameraId, gen, token) {
  const key = ledgerKey(cameraId, gen, token);
  const entry = cloneLedger.get(key);
  if (!entry) return false;
  cloneLedger.delete(key);
  if (entry.motion) entry.bucket.observedMotionFrames--;
  if (entry.out) entry.bucket.observedMotionOutFrames--;
  return true;
}

// How many frames are staged and not yet resolved or pruned. For the bounded-growth test, and for anyone
// debugging: it never exceeds one open minute's worth of frames per camera (~300 at 5 fps).
export function cloneLedgerSize() {
  return cloneLedger.size;
}

// Called by motionDetector for every analysis frame. `fraction` = 0..1 of the bed zone that changed.
// `sample` = { gen, token } when the observation clock will classify this frame (#493), else omitted.
export function recordMotion(cameraId, fraction, sample = null) {
  if (!(fraction >= 0)) return;
  const s = slot(cameraId);
  s.motionSum += fraction;
  if (fraction > s.motionPeak) s.motionPeak = fraction;
  s.motionFrames++;
  s.observedMotionFrames++;
  stageFrame(cameraId, s, sample, fraction, 'motion');
}

// Called by motionDetector for every frame when the camera has a bed zone — `fraction` = 0..1 of the
// area OUTSIDE the bed that changed (someone moving in the room / the child out of bed). Kept separate
// from in-bed motion so the sleep timeline can tell stirring-in-bed from room activity.
export function recordMotionOut(cameraId, fraction, sample = null) {
  if (!(fraction >= 0)) return;
  const s = slot(cameraId);
  s.motionOutSum += fraction;
  if (fraction > s.motionOutPeak) s.motionOutPeak = fraction;
  s.motionOutFrames++;
  s.observedMotionOutFrames++;
  stageFrame(cameraId, s, sample, fraction, 'out');
}

// Called by soundDetector for every loudness window. `overDb` = dB above the rolling ambient baseline
// (already clamped to >= 0 by the caller); a cry pushes this up, a quiet room sits near 0.
export function recordSound(cameraId, overDb) {
  if (!(overDb >= 0)) return;
  const s = slot(cameraId);
  s.soundSum += overDb;
  s.soundSumSq += overDb * overDb;
  s.soundValues.push(overDb);
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
      sound_windows, motion_out_level, motion_out_peak, sound_p75, sound_p90, sound_sd)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Nearest rank uses the actual accepted count, including short minutes and buffered catch-up bursts.
// The clamp is defensive for a future p > 1 caller; it cannot bind for today's p75/p90 (p <= 1).
function soundPercentile(sorted, p) {
  const n = sorted.length;
  return sorted[Math.min(n - 1, Math.ceil(p * n) - 1)];
}

// Write one row per camera that saw any signal in the last minute, then reset. Exported for tests /
// forced flushes; normally driven by the interval below.
export function flushActivity() {
  if (buckets.size === 0) return 0;
  const bucket = minuteBucketUtc();
  const pending = buckets;
  // Swap the map out first so signals arriving mid-flush accumulate into the next minute, not this one.
  const snapshot = [...pending.entries()];
  buckets.clear();
  // #493: the minute is closing, so every staged frame goes with it, in one sweep. A classification that
  // arrives after this is a documented miss, never retried as a later UPDATE (the plan considered and
  // declined that write path; owner decision 2026-09-28). The miss is the clones counted in a minute's last
  // FINALIZE_MS: measured by the plan's Opus review on a fuzzed 3 fps camera as ~8.3% of clones, i.e. 5 s of
  // every 60 s, and pinned by activityTracker.test.js's "KNOWN LIMIT" test. #447's observation-time buckets
  // supersede it. Clearing the WHOLE ledger is exact, not a shortcut: a frame is staged only into its
  // camera's currently open bucket, and every open bucket is rotated at once, just above. This is also what
  // bounds the ledger's memory to one open minute of frames.
  cloneLedger.clear();
  let written = 0;
  for (const [cameraId, s] of snapshot) {
    if (s.motionFrames === 0 && s.soundWindows === 0) continue;
    try {
      // ROADMAP §1.4 Phase 1: record diagnostics from the same rectified excursion stream.
      // About 300 readings per camera/minute, discarded with the bucket. Sort one copy for both
      // candidates: p75 needs a longer burst (76/300) than p90 (31/300). No live threshold changes.
      const sortedSound = [...s.soundValues].sort((a, b) => a - b);
      const soundMean = s.soundWindows ? s.soundSum / s.soundWindows : null;
      // Empty sound buckets MUST bind NULL: an undefined percentile can cost the entire motion row.
      const soundP75 = s.soundWindows ? soundPercentile(sortedSound, 0.75) : null;
      const soundP90 = s.soundWindows ? soundPercentile(sortedSound, 0.90) : null;
      // Population sd measures this minute's spread; clamp tiny negative variance from round-off.
      const soundSd = s.soundWindows
        ? Math.sqrt(Math.max(0, s.soundSumSq / s.soundWindows - soundMean * soundMean)) : null;
      // #493: the stored frame count and the two means use the OBSERVED counts (proven clones taken out);
      // the peaks, and the row-write test above, stay on the RAW counts (see slot()). A minute whose every
      // frame was a proven clone therefore stores motion_frames 0 and a NULL motion_level ("nothing was
      // observed") beside the same motion_peak the raw count gives, 0 — a clone never moved anything.
      insertSample.run(
        cameraId,
        bucket,
        s.observedMotionFrames ? s.motionSum / s.observedMotionFrames : null,
        s.motionFrames ? s.motionPeak : null,
        soundMean,
        s.soundWindows ? s.soundPeak : null,
        s.observedMotionFrames,
        s.soundWindows,
        s.observedMotionOutFrames ? s.motionOutSum / s.observedMotionOutFrames : null,
        s.motionOutFrames ? s.motionOutPeak : null,
        soundP75,
        soundP90,
        soundSd
      );
      written++;
    } catch {
      /* a single bad insert shouldn't drop the rest of the minute */
    }
    // Notify AFTER the row is safely written, and never let a listener's failure cost us the rest of
    // the flush — this runs on a timer with nothing to catch what escapes.
    for (const cb of minuteListeners) {
      try {
        cb({
          cameraId,
          bucketStart: bucket,
          motionPeak: s.motionFrames ? s.motionPeak : null,
          soundPeak: s.soundWindows ? s.soundPeak : null,
        });
      } catch (err) {
        logger.error(`[activity] minute listener failed for ${cameraId}: ${err.message}`);
      }
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

// Stop both timers. Idempotent, and safe to call when it was never started.
//
// ⚠️ THIS WAS MISSING AND IT COST US THE TEST SUITE (issue #278). Two intervals with no way to clear
// them keep the event loop alive forever, so `node --test` could never exit — which was papered over
// with `--test-force-exit` in all three npm scripts rather than fixed here. That flag then became the
// actual bug: under CPU contention on a 2-core CI runner the parent runner force-exited ~6s in, while
// 14 of 34 files were still queued, and reported them as failures with `fail 0, cancelled 14`. A
// suite that reports a third of itself as red without a single failing assertion is worse than a slow
// one, and the coverage gate then read the modules that never ran as a regression that did not exist.
//
// Deliberately NOT `unref()` instead: unref would let the process exit while leaving the timers
// running, which fixes the symptom by making the tracker's lifetime invisible. An explicit stop is
// what shutdown() actually needs, and it is the thing a test can assert.
export function stopActivityTracker() {
  clearInterval(flushTimer);
  clearInterval(pruneTimer);
  // ⚠️ ONLY `flushTimer = null` IS LOAD-BEARING, and saying "nulls the handles" plural was an
  // overstatement caught by adversarial review of this PR: `startActivityTracker` guards on
  // `if (flushTimer) return` and nothing anywhere reads `pruneTimer`'s truthiness, so dropping the
  // second line survives every test in the suite — verified by mutation. Without the first line a
  // restart after a stop is a silent no-op.
  // `pruneTimer` is still nulled, deliberately: releasing the handle for GC and keeping the two in
  // the same state costs nothing, and a future guard that reads either one then cannot be wrong.
  flushTimer = null;
  pruneTimer = null;
}
