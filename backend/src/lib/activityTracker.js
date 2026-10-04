import db from '../db.js';
import { logger } from './logger.js';
import { FINALIZE_MS } from './observationClock.js';

// Per-minute activity timeline for sleep tracking. The motion and sound detectors call recordMotion /
// recordSound on every analysis frame/window (~5/s each). We accumulate those raw signals in memory
// per camera and per minute, and write one aggregated row per camera per minute into activity_samples.
// This is deliberately independent of the detection-alert cooldown: alerts are throttled (good for
// notifications, useless for inferring sleep), whereas this captures a continuous overnight timeline
// of how much a room moved and how loud it got. Stage-2 phase 3's nightly job reads these rows.
//
// ★ ISSUE #447: A ROW'S `bucket_start` IS THE UTC MINUTE ITS SAMPLES WERE RECEIVED IN. Before #447 there
// was ONE open bucket per camera, written by a plain 60 s setInterval and labelled with the FLUSH time.
// The interval's phase was whatever second the process happened to start on, different on every boot, so a
// row labelled 19:01 held samples from roughly 19:00:35-19:01:35 on one boot and 19:00:10-19:01:10 on the
// next, and a late timer tick blended a longer stretch into one label. Now every sample is keyed by the wall
// minute of the stdout `data` event that delivered it (the detectors pass that event's `rx.wall`, read once
// per event, so a frame's two channels and a chunk's sound windows can never straddle a boundary), and a
// minute is closed in two phases on a 1 s tick (see flushActivity). Stage B, keying by the PTS-derived
// observation time instead, is deferred (#447 plan): it needs samples held for FINALIZE_MS and a sound-leg
// hook that does not exist.
//
// Everything here is UTC epoch minutes: nothing depends on the configured timezone or the host's locale.

const MINUTE_MS = 60 * 1000;
// The tick that closes minutes. 1 s, not the old 60 s: it bounds how late after its end a minute reaches
// its listeners (wakeWatcher) and its row. The #447 plan's first draft used 5 s, which delayed the wake
// watcher by up to 5 s for nothing; a 1 s tick costs a Map walk over a few open slots per camera.
const FLUSH_TICK_MS = 1000;
// How long a minute waits AFTER its end before its row is written, so the observation clock's clone
// verdicts (#493) for the frames it received in its last seconds can still reach it. FINALIZE_MS (5 s) is
// a DEADLINE, not a delivery bound: a frame is finalized only when later input arrives, so on a healthy
// 10-15 fps camera a verdict lands up to one input interval (~100 ms) after it, and a detector read can
// clump several frames (the golden replays 3-frame bursts and 40 kB re-cut reads). The extra 2 s covers that
// with room to spare. It does NOT cover a camera that flaps (stall, brief video, longer stall): its
// finalization waits for the next input, so a verdict can arrive 20 s+ after its frame (the #447 plan's
// round-1 Opus review, 3 s stall / 1.5 s video / 20 s stall). Those are counted, not corrected: see
// lateVerdicts below. Tuned for 10-15 fps camera streams feeding the detector's fps=5; a camera slower than
// ~1 fps finalizes later than this and will show up in the lateVerdicts count.
export const GRACE_MS = FINALIZE_MS + 2000;
// A sample stamped at most this far before the camera's last closed minute (a small backward wall-clock
// step: an NTP slew, a VM resuming) is moved into the minute after it instead of re-opening a closed minute;
// further back re-baselines. See minuteFor(). 2 minutes (the plan's v3 rule, not a measurement): an NTP step
// on a healthy install is well under a second, and a VM pause/resume of the size that matters is minutes,
// so this separates "the clock wobbled" from "the clock moved".
const STEP_CLAMP_MS = 2 * MINUTE_MS;
// How many closed minutes' unresolved clone-ledger keys are remembered per camera, so a verdict that arrives
// after its minute was written is COUNTED (lateVerdicts) instead of silently vanishing. >= 3 minutes because
// the flapping-camera residual above is tens of seconds, not minutes; a verdict later than this is simply
// not counted (it still changes nothing, exactly as before).
const LATE_RING_MINUTES = 3;
// The `[activity]` counters line: at most once per camera per this long, and only when something new was
// counted. 15 minutes = the `[obs]` summary's cadence (observationClock.js OBS_LOG_MS), so the two lines read
// side by side in the log, and a flapping camera cannot write a line a minute.
const REPORT_MS = 15 * MINUTE_MS;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

// camera_id -> Map(minuteMs -> slot). A camera normally has at most two slots open: the minute that is
// still receiving, and the one that has ended and is waiting out GRACE_MS before its row is written.
const buckets = new Map();

// camera_id -> the minuteMs of the last minute CLOSED for that camera, i.e. whose listeners have been
// notified. ★ It advances at NOTIFY, not at the row write, and that is what makes the listener's payload
// equal to the row: once a minute has been handed to wakeWatcher, no later sample can be added to it
// (minuteFor redirects it), so its peaks — the only thing the payload carries — cannot move before the row
// is written. Clone verdicts can still arrive in the grace, but they only touch the OBSERVED counts, never
// a peak or the raw counts that decide whether a row exists. lastClosed is the normal guard, not the only
// one: when it is deliberately moved BACK (a clock step), slot() is what keeps a told minute closed.
const lastClosed = new Map();

// Listeners called once per camera per closed minute, with that minute's peaks. This is how
// lib/wakeWatcher.js sees activity LIVE: it needs the identical signal the nightly job reads, and
// re-querying activity_samples every minute would be the same data a second time. Kept as a subscription
// rather than a direct import so activityTracker has no dependency on its consumers.
// ⚠️ #447 CHANGED THE ORDER: listeners are now called at the minute's END and its row is written GRACE_MS
// LATER, where before the row was written first. Nothing depends on the old order: the only subscriber,
// wakeWatcher.handleMinute, reads the payload and the cameras/children tables, never activity_samples
// (checked when this changed; a new subscriber must not assume the row exists yet).
const minuteListeners = new Set();

/**
 * Subscribe to per-minute activity.
 * cb({ cameraId, bucketStart, motionPeak, soundPeak, motionRises, soundRises }).
 * `motionRises` / `soundRises` (#412) are the samples that raised the minute's running peak, as
 * { atMs, value } in arrival order ([] for an empty channel, always arrays); the first four fields are
 * unchanged. `atMs` is the receipt time the detector passed, which can lie before `bucketStart` after a small
 * backward clock step (the sample was clamped into this minute), so a consumer filters by the minute's bounds.
 */
export function onMinuteFlushed(cb) {
  minuteListeners.add(cb);
  return () => minuteListeners.delete(cb);
}

// Counters, per camera, for the `[activity]` line and for tests:
//   clamped      samples received with a wall time inside an already-closed minute (a small backward clock
//                step), moved into the next open minute rather than re-opening a closed one;
//   rebaselined  backward steps bigger than STEP_CLAMP_MS, after which the minute is taken as given (and may
//                repeat a label that was already written — consumers already merge duplicates);
//   futureClosed slots more than STEP_CLAMP_MS ahead of the tick's clock, closed at once (a forward
//                excursion that came back, or a backward step whose first samples were clamped into the open
//                minute) so they can never be stranded. It too re-baselines the camera, so the minutes the
//                clock walks through again are stored a second time.
// ⚠️ So a duplicate (camera, minute) row has TWO possible sources, not one, and each logs its own warn when it
// happens: `the wall clock went back …` (rebaselined) or `activity was filed under minutes ahead of the clock`
// (futureClosed). The staging A/B's "any duplicate row is a bug unless explained" rule accepts either line.
//   lateVerdicts clone verdicts for a frame whose minute had ALREADY been written (the #493 residual that
//                GRACE_MS does not cover: see its comment). Only keys that were staged and pruned count.
const counters = new Map();
const reported = new Map(); // camera_id -> { at, clamped, lateVerdicts } as of the last `[activity]` line
const COUNTER_NAMES = ['clamped', 'rebaselined', 'futureClosed', 'lateVerdicts'];

function bump(cameraId, name) {
  let c = counters.get(cameraId);
  if (!c) {
    c = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
    counters.set(cameraId, c);
  }
  c[name] += 1;
}

/** This camera's #447 counters since start (all zero for a camera never seen). Diagnostics and tests. */
export function activityCounters(cameraId) {
  const c = counters.get(cameraId);
  return Object.fromEntries(COUNTER_NAMES.map((n) => [n, c ? c[n] : 0]));
}

// Which minute a sample received at `atMs` belongs to, for this camera.
//   * Normally floor(atMs) to the minute.
//   * Never a minute that has already been CLOSED (see lastClosed): if the clock stepped back by up to
//     STEP_CLAMP_MS, the sample goes into the minute after the last closed one and is counted as `clamped`.
//     Dropping it instead was rejected in plan review round 1: that turns an NTP step or a VM resume into
//     silent data loss on a healthy install, where the code before #447 merely repeated a label. The cost is
//     bounded but not tiny: the clamped minute holds everything until the clock reaches its end. The bound,
//     worked through and then measured by the fix-round-1 review's sweep (step 5-300 s, 0.5-55.5 s into the
//     open minute): a step back of S made φ seconds into the open minute O stays clamped only while
//     S <= 2 min + φ. Up to that, O holds its own φ s plus everything until the stepped clock reaches O's
//     end, 60 + S s of samples in all: at most ~4 minutes (φ near 60 s); the sweep's densest row was 1175
//     frames at 5 fps, 3.9 minutes. From 2 min + φ to 3 min + φ, this clamp still takes the first samples,
//     but O is then more than STEP_CLAMP_MS ahead of the next tick, so flushActivity closes it early and
//     re-baselines (futureClosed): the step costs duplicate labels, like a bigger step, not a lumped row.
//     Beyond 3 min + φ the re-baseline below happens directly. KNOWN-ISSUES.md states this.
//   * A bigger backward step RE-BASELINES the camera (logged once, at warn) and the sample keeps its own
//     minute. Clamping an hour-long step would lump an hour of samples into one row and silence the wake
//     watcher for the hour (round-2 review: S = 3600 s gives one ~18,300-frame row). The price is that the
//     repeated hour's labels were already written once: duplicate (camera, minute) rows, which every reader
//     already OR-merges, exactly as the old flush-time labels could repeat after a step.
//   * A non-finite `atMs` (a clock-shaped test object, a broken receipt) falls back to Date.now(): a NaN
//     minute would open a slot that no tick could ever close.
function minuteFor(cameraId, atMs) {
  const at = Number.isFinite(atMs) ? atMs : Date.now();
  const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  const last = lastClosed.get(cameraId);
  if (last === undefined || minute > last) return minute;
  if (last - minute <= STEP_CLAMP_MS) {
    bump(cameraId, 'clamped');
    return last + MINUTE_MS;
  }
  lastClosed.set(cameraId, minute - MINUTE_MS);
  bump(cameraId, 'rebaselined');
  logger.warn(
    `[activity] ${cameraId}: the wall clock went back ${Math.round((last - minute) / 1000)}s; ` +
      `activity is filed under the minute it now reads, so some minutes may be stored twice`
  );
  return minute;
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
// #447: a slot is one camera's one minute. `keys` are the clone-ledger keys staged into it (pruned with it),
// `notified` whether its listeners have been called (phase one of the close).
// ★ A SAMPLE NEVER JOINS A NOTIFIED SLOT. minuteFor normally makes that impossible (every notified minute is at
// or below lastClosed), but the two deliberate moves of lastClosed BACK (minuteFor's re-baseline, and
// flushActivity's after closing a minute found far ahead of the clock) can leave a notified minute that is
// still waiting out its grace ABOVE the new lastClosed. The clock then walks into it again and, before this
// guard, its re-lived samples were added to the slot the listener had already been told about: the row and the
// payload disagreed. Found by the #447 adversarial review (Opus): a 150 s step at 19:05:00.5 stored 600 frames
// with motion_peak 0.5 under 19:04, whose listener had been told 0.01 once, so the active re-lived minute never
// reached the wake watcher; the fix round found the same through minuteFor on a ~3 minute step.
// Fixed HERE, at the one place a sample enters a slot, rather than in the two callers that move lastClosed back,
// so a third such move added later cannot reopen it. The told minute is written now, as it stands (its grace is
// cut short: a clone verdict for its last seconds may then be counted late), and the sample opens a fresh slot
// for the same minute, which is told and written normally. The price is a second row with the same label, the
// same thing a big backward step already costs; the warn line of whichever move caused it says so.
function slot(cameraId, atMs) {
  const minuteMs = minuteFor(cameraId, atMs);
  const told = buckets.get(cameraId)?.get(minuteMs);
  if (told?.notified) writeMinute(cameraId, told);
  let slots = buckets.get(cameraId);
  if (!slots) {
    slots = new Map();
    buckets.set(cameraId, slots);
  }
  let s = slots.get(minuteMs);
  if (!s) {
    s = { minuteMs, notified: false, keys: new Set(),
      motionSum: 0, motionPeak: 0, motionFrames: 0, observedMotionFrames: 0,
      soundSum: 0, soundPeak: 0, soundWindows: 0, soundValues: [], soundSumSq: 0,
      motionOutSum: 0, motionOutPeak: 0, motionOutFrames: 0, observedMotionOutFrames: 0,
      // #412: the samples that RAISED this minute's running peak, per channel, as { atMs, value } in
      // arrival order. See recordMotion for why this is enough to find "the first frame over a threshold".
      motionRises: [], soundRises: [] };
    slots.set(minuteMs, s);
  }
  return s;
}

// Whether a minute has anything to store (and so anything to tell a listener). RAW counts only (#493). A
// minute of out-of-bed motion alone is dropped: see activityTracker.test.js's "KNOWN GAP".
function hasSignal(s) {
  return s.motionFrames > 0 || s.soundWindows > 0;
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

// #447: camera_id -> the unresolved keys of its last LATE_RING_MINUTES written minutes, oldest first (one Set
// per minute). Only for COUNTING a verdict that arrived too late (lateVerdicts); nothing is corrected from
// here, because the row is already written and a stored minute is never updated (owner decision 2026-09-28).
// Bounded by construction: at most LATE_RING_MINUTES minutes of staged frames per camera.
const recentlyClosed = new Map();

// Stage a frame that was just counted into slot `s`, when the detector knows its (gen, token).
// ★ Only a frame that added EXACTLY 0 to its channel's sum is staged. A true clone always does (it is a
// byte-identical repeat of the frame before it), so this costs no correction; it makes "the ledger never
// touches motionSum / motionOutSum" safe by construction instead of by argument: a frame that registered
// any movement is never taken out, so a mean can never be raised by removing a frame whose motion stays in
// the sum. (Added by the #493 build on top of the plan, which assumed the fraction was 0.)
// ★ #447: one entry, ONE slot. The detector passes the same receipt time for a frame's two channels, so they
// always land in the same slot; if a caller ever passed two different times that straddled a minute, the
// second channel is simply not staged, rather than recorded against a slot it was not counted in (whose
// count a correction would then drive below zero).
function stageFrame(cameraId, s, sample, fraction, channel) {
  if (!sample || fraction !== 0) return;
  const key = ledgerKey(cameraId, sample.gen, sample.token);
  let entry = cloneLedger.get(key);
  if (!entry) {
    entry = { bucket: s, motion: false, out: false };
    cloneLedger.set(key, entry);
    s.keys.add(key);
  }
  if (entry.bucket !== s) return;
  entry[channel] = true;
}

// The observation clock proved frame (gen, token) of this camera was a clone (fps-clone or cfr-clone; the
// caller never passes `unknown`, which also covers healthy real frames whose evidence was lost). Take it
// back out of the observed counts it was staged in. Idempotent: the entry is removed, so a repeat is a
// no-op. #447: a verdict can land until its minute's row is WRITTEN (minute end + GRACE_MS), not only while
// the minute is open, which is what closes most of the #493 residual. A verdict for a frame whose row was
// already written changes nothing (a stored minute is never corrected afterwards) but is counted as
// `lateVerdicts` when the frame was staged recently enough to be remembered (LATE_RING_MINUTES). Documented
// in KNOWN-ISSUES.md ("A stalled camera's repeated pictures are left out of the per-minute motion count").
// Returns whether anything was corrected.
export function excludeClone(cameraId, gen, token) {
  const key = ledgerKey(cameraId, gen, token);
  const entry = cloneLedger.get(key);
  if (!entry) {
    for (const keys of recentlyClosed.get(cameraId) || []) {
      // delete() both finds it and makes a repeated late verdict count once.
      if (keys.delete(key)) {
        bump(cameraId, 'lateVerdicts');
        break;
      }
    }
    return false;
  }
  cloneLedger.delete(key);
  entry.bucket.keys.delete(key);
  if (entry.motion) entry.bucket.observedMotionFrames--;
  if (entry.out) entry.bucket.observedMotionOutFrames--;
  return true;
}

// How many frames are staged and not yet resolved or pruned. For the bounded-growth test, and for anyone
// debugging: it never exceeds the staged frames of a camera's open slots (~2 minutes, ~600 at 5 fps).
export function cloneLedgerSize() {
  return cloneLedger.size;
}

// Called by motionDetector for every analysis frame. `fraction` = 0..1 of the bed zone that changed.
// `sample` = { gen, token } when the observation clock will classify this frame (#493), else null.
// `atMs` = the wall time the frame was RECEIVED (#447: the stdout event's `rx.wall`). The default exists for
// tests and for any caller with no receipt; the detectors always pass it.
export function recordMotion(cameraId, fraction, sample = null, atMs = Date.now()) {
  if (!(fraction >= 0)) return;
  const s = slot(cameraId, atMs);
  s.motionSum += fraction;
  if (fraction > s.motionPeak) {
    s.motionPeak = fraction;
    // #412: remember WHEN each new running peak was reached (the time actually used for bucketing, the
    // same fallback as minuteFor, so a non-finite `atMs` stores a real time). The first sample above ANY
    // threshold is necessarily one that raised the running peak (every earlier sample was at or below that
    // threshold, so the peak was still at or below it), so a consumer can find "the first frame over my
    // threshold" from this list without the tracker knowing any threshold: the tracker stays
    // threshold-free and wakeWatcher applies the SAME MOTION_ACTIVE that defines `active`. The list is
    // short (one entry per new maximum, not per frame). recordMotionOut records nothing: out-of-bed
    // movement does not make a minute active, so it cannot start a wake.
    s.motionRises.push({ atMs: Number.isFinite(atMs) ? atMs : Date.now(), value: fraction });
  }
  s.motionFrames++;
  s.observedMotionFrames++;
  stageFrame(cameraId, s, sample, fraction, 'motion');
}

// Called by motionDetector for every frame when the camera has a bed zone — `fraction` = 0..1 of the
// area OUTSIDE the bed that changed (someone moving in the room / the child out of bed). Kept separate
// from in-bed motion so the sleep timeline can tell stirring-in-bed from room activity. `atMs` must be the
// SAME receipt time the frame's recordMotion call got, so both channels land in one minute.
export function recordMotionOut(cameraId, fraction, sample = null, atMs = Date.now()) {
  if (!(fraction >= 0)) return;
  const s = slot(cameraId, atMs);
  s.motionOutSum += fraction;
  if (fraction > s.motionOutPeak) s.motionOutPeak = fraction;
  s.motionOutFrames++;
  s.observedMotionOutFrames++;
  stageFrame(cameraId, s, sample, fraction, 'out');
}

// Called by soundDetector for every loudness window. `overDb` = dB above the rolling ambient baseline
// (already clamped to >= 0 by the caller); a cry pushes this up, a quiet room sits near 0. `atMs` = the
// receipt time of the stdout event that delivered the window (every window of one event shares it).
export function recordSound(cameraId, overDb, atMs = Date.now()) {
  if (!(overDb >= 0)) return;
  const s = slot(cameraId, atMs);
  s.soundSum += overDb;
  s.soundSumSq += overDb * overDb;
  s.soundValues.push(overDb);
  if (overDb > s.soundPeak) {
    s.soundPeak = overDb;
    // #412: same idea as recordMotion's motionRises (peak-raising samples only, time actually used).
    s.soundRises.push({ atMs: Number.isFinite(atMs) ? atMs : Date.now(), value: overDb });
  }
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

// Phase one of closing a minute: it is over, so hand its peaks to the listeners, and from now on no sample
// may join it (lastClosed). `notify` false = close it without calling anyone (shutdown: see
// stopActivityTracker).
// Both callers close a camera's minutes oldest first, and a sample never opens a minute at or below the last
// closed one (minuteFor), so this only ever moves lastClosed FORWARD; the two deliberate moves back (a big
// backward clock step, a future minute closed early) are made by minuteFor and flushActivity themselves, and
// slot() stops either from reopening a minute this already told the listeners about.
function closeMinute(cameraId, s, notify = true) {
  s.notified = true;
  lastClosed.set(cameraId, s.minuteMs);
  if (!notify || !hasSignal(s)) return;
  const bucketStart = minuteBucketUtc(new Date(s.minuteMs));
  // Never let a listener's failure cost us the rest of the tick — this runs on a timer with nothing to
  // catch what escapes.
  for (const cb of minuteListeners) {
    try {
      cb({
        cameraId,
        bucketStart,
        motionPeak: s.motionFrames ? s.motionPeak : null,
        soundPeak: s.soundWindows ? s.soundPeak : null,
        // #412: additive. Copies, so a listener cannot change the slot, which is still written to the row
        // afterwards. `[]` for an empty channel; wakeWatcher derives the wake's first active frame from these.
        motionRises: s.motionRises.map((r) => ({ ...r })),
        soundRises: s.soundRises.map((r) => ({ ...r })),
      });
    } catch (err) {
      logger.error(`[activity] minute listener failed for ${cameraId}: ${err.message}`);
    }
  }
}

// Phase two: write the row (if the minute saw anything) and forget the slot. Its still-staged ledger keys
// go with it — #447 prunes per SLOT; the #493 code cleared the whole ledger at every flush, which was exact
// only while every camera had exactly one open bucket, rotated at once. The pruned keys move to the
// recently-closed ring so a verdict that arrives after this can be counted. Returns 1 if a row was written.
function writeMinute(cameraId, s) {
  const slots = buckets.get(cameraId); // always there: both callers found `s` in it
  slots.delete(s.minuteMs);
  if (slots.size === 0) buckets.delete(cameraId);
  for (const key of s.keys) cloneLedger.delete(key);
  let ring = recentlyClosed.get(cameraId);
  if (!ring) {
    ring = [];
    recentlyClosed.set(cameraId, ring);
  }
  ring.push(s.keys);
  while (ring.length > LATE_RING_MINUTES) ring.shift();
  if (!hasSignal(s)) return 0;
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
    // the peaks, and the row-write test (hasSignal), stay on the RAW counts (see slot()). A minute whose every
    // frame was a proven clone therefore stores motion_frames 0 and a NULL motion_level ("nothing was
    // observed") beside the same motion_peak the raw count gives, 0 — a clone never moved anything.
    insertSample.run(
      cameraId,
      minuteBucketUtc(new Date(s.minuteMs)),
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
    return 1;
  } catch {
    /* a single bad insert shouldn't drop the rest of the minute */
    return 0;
  }
}

// One tick. For every camera's open minutes, oldest first:
//   * at the minute's END (minuteMs + 60 s): close it and call the listeners with its peaks. This is what
//     keeps wake clips whole: the wake watcher's ring hold is taken the moment it hears the minute, and every
//     second of delay ages the hold point against a ring that may be only 23 s deep (plan review round 2).
//   * GRACE_MS after the end: write its row and forget it (the clone verdicts for its last seconds are in).
//   * a minute more than STEP_CLAMP_MS AHEAD of this tick's clock (the wall clock jumped forward and came
//     back, or stepped back 2-3 minutes: see minuteFor) is closed and written at once, and the camera
//     re-baselined to the current minute: otherwise it would sit unclosed until the clock caught up with it,
//     an hour for an hour-long excursion, holding its ledger keys and silencing the wake watcher for the
//     camera. The re-baseline can leave an already-told minute above lastClosed; slot() keeps it closed.
// `all` closes and writes EVERY open minute now, including the one still receiving: for tests that mean
// "drain", and for nothing else (a forced flush in production would close a minute early and push its
// later samples into the next one, by the clamp). Returns how many rows were written.
export function flushActivity(now = Date.now(), { all = false } = {}) {
  let written = 0;
  for (const [cameraId, slots] of [...buckets]) {
    let jumpedBack = false;
    for (const s of [...slots.values()].sort((a, b) => a.minuteMs - b.minuteMs)) {
      const end = s.minuteMs + MINUTE_MS;
      const future = s.minuteMs - now > STEP_CLAMP_MS;
      if (future) jumpedBack = true;
      if (!s.notified && (all || future || end <= now)) closeMinute(cameraId, s);
      if (s.notified && (all || future || end + GRACE_MS <= now)) written += writeMinute(cameraId, s);
    }
    if (jumpedBack) {
      bump(cameraId, 'futureClosed');
      lastClosed.set(cameraId, Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS);
      logger.warn(`[activity] ${cameraId}: activity was filed under minutes ahead of the clock (the wall clock went back); closed them now`);
    }
  }
  reportCounters(now);
  return written;
}

// The `[activity]` line: per camera, what was counted since its last line (see REPORT_MS for the cadence).
// Only the two counters that are expected to be non-zero on some real installs: a clock step and a
// forward excursion already logged their own warn line when they happened.
function reportCounters(now) {
  for (const [cameraId, c] of counters) {
    const r = reported.get(cameraId) || { at: -Infinity, clamped: 0, lateVerdicts: 0 };
    const late = c.lateVerdicts - r.lateVerdicts;
    const clamped = c.clamped - r.clamped;
    if ((late === 0 && clamped === 0) || now - r.at < REPORT_MS) continue;
    logger.info(
      `[activity] ${cameraId}: ${late} clone verdict(s) arrived after their minute was stored (left counted), ` +
        `${clamped} sample(s) moved to the next minute after a small clock step`
    );
    reported.set(cameraId, { at: now, clamped: c.clamped, lateVerdicts: c.lateVerdicts });
  }
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

// Start the minute closer + daily prune. Idempotent.
export function startActivityTracker() {
  if (flushTimer) return;
  // Wrapped, so a timer that passes arguments to its callback can never be read as `nowMs` / `all`.
  flushTimer = setInterval(() => flushActivity(), FLUSH_TICK_MS);
  pruneTimer = setInterval(pruneActivitySamples, PRUNE_INTERVAL_MS);
  pruneActivitySamples();
  logger.info(`[activity] Bucketing motion/sound activity per minute, keeping ${RETENTION_DAYS} days.`);
}

// Stop both timers. Idempotent, and safe to call when it was never started.
//
// #447: FIRST it writes every minute that has already ENDED (its listeners notified, or ended in the <= 1 s
// before the next tick would have notified them), without calling any listener: this runs at shutdown, and
// the wake watcher must not start a capture on the way out. Those minutes are complete, and no later process
// can write them again (its first sample is in a later minute, by the same clock), so this cannot make a
// duplicate. Without it, a stop in the GRACE_MS after a minute ended dropped that whole minute (~12% of
// restarts, plan review round 2). The minute still RECEIVING is never written: a restart inside the same
// minute would then store it twice. So a stop loses at most the open minute, as before #447.
// `nowMs` is for tests; shutdown calls this with no argument. The DB is still open when index.js calls it.
//
// ⚠️ THE TIMERS WERE MISSING AND IT COST US THE TEST SUITE (issue #278). Two intervals with no way to clear
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
export function stopActivityTracker(nowMs = Date.now()) {
  for (const [cameraId, slots] of [...buckets]) {
    for (const s of [...slots.values()].sort((a, b) => a.minuteMs - b.minuteMs)) {
      if (!s.notified && s.minuteMs + MINUTE_MS > nowMs) continue; // still receiving: never written here
      if (!s.notified) closeMinute(cameraId, s, false);
      writeMinute(cameraId, s);
    }
  }
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

// ⚠️ TEST SEAM, not an API (#447 plan, round 2). Every piece of module state a test could inherit from the
// test before it: the open minutes, the ledger, the last-closed minutes (without this, a test that drained
// with `{ all: true }` would push the next test's samples for the same minute into the minute after), the
// late ring, the counters, and the timers. Listeners are NOT touched: each test file owns its subscriptions.
export function _resetActivityTrackerForTests() {
  clearInterval(flushTimer);
  clearInterval(pruneTimer);
  flushTimer = null;
  pruneTimer = null;
  buckets.clear();
  cloneLedger.clear();
  lastClosed.clear();
  recentlyClosed.clear();
  counters.clear();
  reported.clear();
}

// Test-only: how much the tracker is holding in memory, for the boundedness test.
export function _activityTrackerSizesForTests() {
  let openSlots = 0;
  for (const slots of buckets.values()) openSlots += slots.size;
  let ringKeys = 0;
  for (const ring of recentlyClosed.values()) for (const keys of ring) ringKeys += keys.size;
  return { openSlots, ledger: cloneLedger.size, ringKeys };
}
