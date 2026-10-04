import db from '../db.js';
import { logger } from './logger.js';
import { onMinuteFlushed } from './activityTracker.js';
import { SLEEP_THRESHOLDS, childTracksSleep, childWindowActiveNow } from './sleepAnalysis.js';
import { holdRing, releaseRing, isSegmenterRunning, ringOldestStartMs, clipCoverStartMs } from './clipRecorder.js';
import { RING_OWNER } from './ringHolds.js';
import { captureWakeClip, pruneWakeClips, getWakeClipSettings, WAKE_CLIP_LEAD_SEC } from './recordings.js';

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
// The ring is the reason this can work at all. It is only 23-63 s deep (depending on the clip settings,
// see handleMinute), but a wake needs several minutes to qualify, so the moment we see the FIRST active
// minute we hold the ring at that point. If the run turns out to be a stir we release it and nothing is
// written. See clipRecorder.holdRing.

const { MOTION_ACTIVE, SOUND_ACTIVE, ONSET_QUIET_MIN, WAKE_ACTIVE_MIN, WAKE_GAP_MIN } = SLEEP_THRESHOLDS;

const MINUTE_MS = 60 * 1000;
// ★ WHO ENFORCES THE BRIDGE LIMIT (#448). handleMinute does, on the data path, in MINUTES ELAPSED between
// payloads, for an active sample and a quiet one alike (see "One bridge rule" in handleMinute). Until #448 this
// comment claimed that an un-qualified run "cannot live longer than about 17 minutes" and that no time
// backstop was needed on the normal path. That was FALSE: only the quiet branch checked elapsed time, an
// active sample after a hole just did activeCount++, so a camera whose minutes arrived sparsely (active at
// +0/+10/+20/+30/+40 minutes, nothing in between) kept ONE run alive, and recorded it as a wake, for as long
// as it kept sending. The nightly job (sleepAnalysis.js markWakeRuns) splits that into five one-minute runs.
// The cause was one thing seen three ways: the watcher counted CALLBACKS, not minutes.
//
// What the sweep below is for, and not for: activityTracker only flushes a camera that saw signal, so a
// camera that goes offline mid-run simply stops calling us. Its run would stay open and its ring hold would
// never be released — the ring then grows without bound for as long as the camera is down. Nothing on the
// per-minute path can notice that, precisely because the per-minute path has stopped, so it is swept on a
// timer instead. It is a HYGIENE BACKSTOP for a silent camera, not what decides where a run ends: 20 minutes
// is not calibrated against anything (no night set it) and is deliberately far longer than the bridge, so a
// healthy run is never cut by one late tick. After #448 the data path already ends a run the first time a
// payload shows a hole longer than WAKE_GAP_MIN, so only a camera that sends NOTHING more reaches the sweep.
const STALE_RUN_MS = 20 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// camera_id -> { asleep, quietRun, run, lastAt }
// run = { startMs, activeCount, lastActiveMs, captured, holding }
//   startMs = the clip's anchor (#412: first active frame, clamped to the ring); lastActiveMs = the END label of
//   the last active minute (the bridge arithmetic and the stale-run sweep read it, so it is NOT the anchor)
// lastAt (#448) = the end-of-minute ms of the last payload ACCEPTED for this camera, null = none yet. It is
// what lets handleMinute measure TIME between payloads, because activityTracker sends no payload at all for a
// minute with neither a motion frame nor a sound window (closeMinute: `hasSignal`), so an outage is visible
// only as a jump in the labels. Cleared by reset() and by a new slot(): a window that opens again must not
// measure from the night before.
const state = new Map();

function slot(cameraId) {
  let st = state.get(cameraId);
  if (!st) {
    st = { asleep: false, quietRun: 0, run: null, lastAt: null };
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
  st.lastAt = null;
}

const cameraQ = db.prepare('SELECT id, name, child_id, disabled FROM cameras WHERE id = ?');

// 'YYYY-MM-DD HH:MM:00' (UTC, from activityTracker) -> epoch ms of the minute's START.
function bucketMs(bucketStart) {
  return Date.parse(`${bucketStart.replace(' ', 'T')}Z`);
}

// #412: the wall time of the first frame of this minute that was over its channel's active threshold, or null
// when the payload cannot say. `payload.motionRises` / `soundRises` are the samples that RAISED the minute's
// running peak (activityTracker); the first sample above any threshold is necessarily one of them, so the
// first rise over MOTION_ACTIVE / SOUND_ACTIVE is the first active frame. The thresholds are the SAME imported
// ones that define `active` in handleMinute, so "the frame that made the minute active" is exact by
// construction; there is no new threshold here. Strict `>`, like `active`: a value exactly AT the threshold
// does not make a minute active, so it is not an active frame either.
// Rises are FILTERED to the minute [minuteStartMs, minuteStartMs + 60 s) BEFORE the minimum is taken: a
// sample stamped before its minute (activityTracker moves a sample from a small backward clock step into the
// next minute, keeping its original receipt time) must not pull the anchor out of the minute, and a stamp at
// or past the minute's end cannot come from the real tracker at all (only a hand-built payload). When
// nothing is left, or the payload carries no arrays (a legacy payload), the answer is null and the caller
// keeps its old anchor.
export function firstActiveFrameMs(payload, minuteStartMs) {
  let first = null;
  const scan = (rises, threshold) => {
    if (!Array.isArray(rises)) return;
    for (const r of rises) {
      if (!r || !(r.value > threshold)) continue;
      if (!Number.isFinite(r.atMs) || r.atMs < minuteStartMs || r.atMs >= minuteStartMs + MINUTE_MS) continue;
      if (first === null || r.atMs < first) first = r.atMs;
    }
  };
  scan(payload?.motionRises, MOTION_ACTIVE);
  scan(payload?.soundRises, SOUND_ACTIVE);
  return first;
}

// #412: where a wake clip is anchored. `at` is the END of the wake's first active minute (the anchor the
// watcher used since #447), `frameMs` its first active frame (firstActiveFrameMs), `oldestStartMs` the start
// of the oldest footage the ring holds (clipRecorder.ringOldestStartMs), `leadMs` the clip's lead-in (the clip
// starts at anchor - leadMs).
//   * No frame, or no footage to measure: `at`, exactly what the watcher did before #412.
//   * Else the first frame, but never so early that the CLIP (anchor - leadMs) would open before the oldest
//     footage: extractClip's selection would then be EMPTY and the row would fail ("no ring segments
//     covered the requested window"), which is worse than a late start. Hence the max with oldest + lead.
//   * And never later than `at`: the old anchor is the ceiling, so this can only make a clip start EARLIER
//     than it did, whatever the ring holds.
export function wakeClipAnchor({ at, frameMs, oldestStartMs, leadMs }) {
  if (frameMs == null || oldestStartMs == null) return at;
  return Math.min(at, Math.max(frameMs, oldestStartMs + leadMs));
}

export function handleMinute(payload) {
  const { cameraId, bucketStart, motionPeak, soundPeak } = payload;
  const st = slot(cameraId);
  const camera = cameraQ.get(cameraId);

  // Only tracked children, only inside their own sleep window. Outside it there is no "wake" to speak
  // of, and bedtime settling must never be recorded — which is also why nothing is armed until the
  // child has actually gone to sleep (see the onset gate below).
  if (!camera || camera.disabled || !camera.child_id || !childTracksSleep(camera.child_id) || !childWindowActiveNow(camera.child_id)) {
    reset(cameraId, st);
    return null;
  }

  // ★ THE MINUTE IS HEARD AT ITS END (#447, resolved for the clip by #412). activityTracker labels a minute
  // by when its samples arrived and hands it over at that minute's END, within ~1 s (its flush tick). So
  // `at` (the label's end) is the moment of the call, and the wake's first active frame is somewhere in the
  // 60 s BEFORE it. #447 anchored the clip at `at` itself because the true minute start would have moved the
  // hold point a full minute back from the moment it is taken, and the ring may not reach it: the ring is 63 s
  // deep only with on-demand Record on, 38 s with it off and 23 s at the smallest clip settings
  // (clipRecorder.ringDepthMsFor; nothing sizes it for wake clips). Plan review round 2 measured the true
  // start losing the lead-in of 100% of wake clips on a 38 s ring and failing 96% on a 23 s one. The price
  // was a deterministic late start: the clip began at the END of the first active minute, up to 57 s after
  // the first active frame (~27 s on average).
  // #412 resolves that trade-off: when a run starts, anchor on the first active FRAME (firstActiveFrameMs)
  // and CLAMP it to the oldest footage the ring actually holds (wakeClipAnchor, ringOldestStartMs reads the
  // real segment files), so a shallow ring still cuts a clip, just later, and never fails one the old code
  // cut. The old anchor `at` stays the ceiling and the label (`lastActiveMs`).
  const at = bucketMs(bucketStart) + MINUTE_MS;
  if (!Number.isFinite(at)) return null;

  const active =
    (motionPeak != null && motionPeak > MOTION_ACTIVE) || (soundPeak != null && soundPeak > SOUND_ACTIVE);

  // --- ordering guard (#448): labels are the only clock this function has, so check they move forward ---
  // activityTracker normally hands over one payload per camera per minute, oldest first, but it has two
  // deliberate ways to repeat or rewind a label (a clock step re-baselines the camera, or closes minutes
  // that were filed ahead of the clock), and a payload that skips minutes is how an outage shows up at all
  // (see lastAt in the state comment). Both of the next two branches protect the arithmetic below, which
  // subtracts labels and would otherwise go negative or double-count.
  //   * The SAME label again: counted once and ignored. DEFENSIVE ONLY: 660 clock-step scenarios through the
  //     real tracker (plan review, #448) never produced two equal labels back to back, a re-lived minute
  //     follows a BACKWARD label ("19:05 19:02 19:03"), so this is a cheap guard for a path nobody has seen,
  //     which keeps "deduplicate repeated buckets" (the issue's wording) true rather than assumed. Where the
  //     nightly job OR-merges duplicate rows of one minute, this branch keeps the FIRST payload and drops the
  //     rest (unreachable from the real tracker, so the difference cannot show).
  //   * An OLDER label: time went backwards. That one IS reachable. Whether the minutes either side of the
  //     step are continuous is unknowable and label arithmetic across it means nothing, so the run is ended,
  //     the settling progress is dropped, and this sample becomes the new baseline and is processed normally.
  //     Conservative on purpose: the nightly job merges the re-lived minutes into one timeline, so it would not
  //     split here, and we lose at most one run. Dropping older labels instead (the obvious alternative) would
  //     deafen the watcher for as long as the step: a one-hour step is an hour of missed wakes.
  if (st.lastAt != null) {
    if (at === st.lastAt) return null;
    if (at < st.lastAt) {
      // Same as the bridge case below: a run that already captured is not "nothing recorded", so it logs nothing.
      // ⚠️ KNOWN LIMIT, not fixed here (#471): endRun releases the WAKE hold of a run whose capture may still be
      // extracting its clip, and an ACTIVE label that jumps far forward replaces the captured run the same way
      // (the new run's hold then takes the single WAKE slot). Both need a clock step of more than about 2 minutes
      // (activityTracker absorbs smaller ones) within about a minute of the 5th active minute. Protecting a clip
      // that is still being cut needs a per-capture lease, which is #471's job. This change adds one more trigger
      // for that release; a hole is far past an extraction (wake clips are at most 120 s), a clock step is not.
      endRun(cameraId, st, st.run?.captured ? null : 'the clock went back');
      st.quietRun = 0;
    }
  }
  // Whole minutes since the last accepted payload: 1 = the very next minute, 2 = one minute had no payload.
  // Math.round, not floor: labels are minute-aligned so the division is already exact; round only keeps a
  // stray sub-minute label from truncating a real gap down by one.
  const elapsedMin = st.lastAt == null || at < st.lastAt ? 1 : Math.round((at - st.lastAt) / MINUTE_MS);
  const missingMin = elapsedMin - 1; // minutes with NO payload between the last one and this one
  st.lastAt = at;

  // --- onset gate: nothing is recorded until the child is actually asleep ---
  if (!st.asleep) {
    // ★ Settling needs ONSET_QUIET_MIN CONSECUTIVE OBSERVED quiet minutes (#448, acceptance criterion 3 of the
    // issue: "time spent in a gap cannot count toward the 15 minutes"). Before, quietRun counted CALLBACKS, so
    // 14 quiet minutes, a 40-minute outage and 1 more quiet minute read as "15 quiet minutes" and armed the
    // watcher on a child whose last 40 minutes nobody saw. A hole restarts the count.
    // ⚠️ Deliberately STRICTER than the nightly onset rule (sleepAnalysis.js), which accepts a 15-minute window
    // with no active minute and >= ONSET_QUIET_MIN * MIN_COVERAGE_FRAC (8) confirmed-quiet minutes, because
    // requiring a fully observed window regressed flaky cameras to `no_sleep` (#442). The live gate's only job
    // is to keep bedtime settling OUT of the recorder, so the safe error here is arming LATE (a missed clip,
    // never an alert). The price, stated: a camera that drops a minute more often than about every 15 minutes
    // never arms. ANY hole restarts the count, even one missing minute (most holes are single minutes): on the
    // saved 30-day snapshots of two cameras in one house that is roughly 20-25 holes per camera per month on one
    // database and 45-50 on the other. What shows a night is rarely delayed is the old-vs-new replay of those 30
    // days (#448 review): arming differed on exactly one night in four camera-months, 8 minutes later. Unknown on
    // any other install. KNOWN-ISSUES.md says the same. If that is too strict, the nightly 8-of-15 rule is one
    // function away; no new number needed.
    if (missingMin > 0) st.quietRun = 0;
    st.quietRun = active ? 0 : st.quietRun + 1;
    if (st.quietRun >= ONSET_QUIET_MIN) {
      st.asleep = true;
      st.quietRun = 0;
      logger.info(`[wake] "${camera.name}" settled — watching for wakes`);
    }
    return null;
  }

  // --- ONE bridge rule for the active branch and the quiet branch (#448) ---
  // The nightly job's rule (markWakeRuns) is: two active minutes belong to one run when the NON-ACTIVE
  // minutes between them number <= WAKE_GAP_MIN, whether those minutes were observed-quiet or had no reading
  // at all (an unobserved minute is non-active there). Here, `nonActive` is the count of such minutes so
  // far: a quiet sample d minutes after the last active one has d of them; an ACTIVE sample d minutes after
  // has d - 1 BETWEEN them (this sample is the next active minute, it is not in the gap). That "- 1" is the
  // whole off-by-one: the quiet branch ends a run at d >= 4 (as it always did), the active branch at d >= 5,
  // exactly the nightly `g - k <= WAKE_GAP_MIN`. Before #448 only the quiet branch checked, so an active
  // sample after a hole topped the old run up however long the hole was.
  // Measured from the last ACTIVE minute, not from the last payload: quiet payloads inside the gap are
  // part of the gap, and a hole after them extends it (a rule that restarts the clock at every payload would
  // bridge "4 active, 2 quiet, 2 missing, active", which the nightly job splits).
  // The same constant as the nightly job, by reference: a retune of WAKE_GAP_MIN moves both together.
  // An ARMED watcher stays armed across a hole (only the settling progress above is reset): disarming would
  // drop a real wake that follows a reconnect, and the arming gate exists only to keep bedtime settling out.
  if (st.run) {
    const sinceActiveMin = Math.round((at - st.run.lastActiveMs) / MINUTE_MS);
    const nonActive = active ? sinceActiveMin - 1 : sinceActiveMin;
    if (nonActive > WAKE_GAP_MIN) {
      // "readings N min apart" and not "no readings for N min": a forward clock jump looks identical to a
      // hole in the labels, and the log must not claim an outage it cannot see.
      const why = missingMin > 0 ? `readings ${elapsedMin} min apart` : 'stir, under the wake threshold';
      endRun(cameraId, st, st.run.captured ? null : why);
    }
  }

  if (active) {
    if (!st.run) {
      // #412: `startMs` is the clip's ANCHOR (first active frame, clamped to the ring), and ONLY startMs.
      // `lastActiveMs` stays `at`, the label: the bridge arithmetic below and sweepStaleRuns measure whole
      // minutes from it, and copying the anchor in would shorten the gap to the next minute by up to 57 s
      // (round(297/60) = 5 instead of 4 changes whether "4 active, 3 quiet, active" bridges).
      const leadMs = WAKE_CLIP_LEAD_SEC * 1000;
      const f = firstActiveFrameMs(payload, at - MINUTE_MS);
      const oldest = ringOldestStartMs(cameraId);
      const anchor = wakeClipAnchor({ at, frameMs: f, oldestStartMs: oldest, leadMs });
      st.run = { startMs: anchor, activeCount: 0, lastActiveMs: at, captured: false, holding: false };
      // Hold from the clip's cover start so the wake's opening survives the ~63s ring long enough to
      // find out whether this is a wake or just a stir. clipCoverStartMs is the SAME formula extractClip
      // reads back with (#446), so the hold can never be shallower than the cut. (Before #412 the hold was
      // a separate `at - 15 s`; for a legacy payload with no rises it is now `at - 7 s`, deliberately: one
      // formula, and the cut needs nothing older.)
      //
      // #446: only take the hold when wake clips are actually enabled. captureWakeClip already returns
      // null when they're off (recordings.js), so a hold taken anyway protects nothing — it just sits
      // there. clipCapture.js's reconcileClipRing defers stopping a ring that's no longer wanted while
      // ANY hold exists, so a restless child kept creating pointless WAKE holds after an admin switched
      // wake clips off, and the ring's stop kept getting deferred until the sleep window ended. The run
      // itself, its capture attempt and endRun's release are unchanged — only whether THIS run ever
      // takes a hold does; `st.run.holding` stays false when it doesn't, and the existing
      // `if (st.run?.holding)` guards below already treat that as "nothing to release".
      if (isSegmenterRunning(cameraId) && getWakeClipSettings().enabled) {
        holdRing(cameraId, RING_OWNER.WAKE, clipCoverStartMs(anchor, WAKE_CLIP_LEAD_SEC));
        st.run.holding = true;
        // The clamp cost the opening: the ring's oldest footage starts after the first frame's lead-in. This
        // line is the evidence for whether a deeper ring is worth building (#412 follow-up); nothing else
        // logs it. Not logged when the clip still opens before or at the movement (a 0-3 s clamp is hidden
        // by the lead-in), nor when there was no frame to compare against, nor when the ring had no closed
        // segment to measure (`oldest` null: the anchor is then `at` for lack of information, and the line
        // would claim a buffer depth nobody measured).
        if (f != null && oldest != null && anchor - leadMs > f) {
          logger.info(
            `[wake] "${camera.name}" the buffer reaches back only to ${Math.round((anchor - leadMs - f) / 1000)} s ` +
              `after the first movement: the clip starts there`
          );
        }
      }
    }
    st.run.activeCount++;
    st.run.lastActiveMs = at;

    if (!st.run.captured && st.run.activeCount >= WAKE_ACTIVE_MIN) {
      st.run.captured = true;
      const startMs = st.run.startMs;
      // The run THIS capture belongs to, by identity (#448). The `.finally` below used to ask "is the current
      // run's startMs still mine?", but a backward clock step re-baselines the watcher and can start a NEW run
      // whose first label equals this run's startMs while this capture is still extracting; the old guard then
      // released the NEW run's hold (one WAKE owner key per camera). Found by plan review, verified by running.
      const run = st.run;
      logger.info(
        `[wake] "${camera.name}" awake (${st.run.activeCount} active min) — recording the opening, no alert`
      );
      // Fire and forget: the capture awaits a segment settle, and the watcher must stay responsive to
      // the next minute. The ring hold is released once the cut is done, not before.
      captureWakeClip(camera, startMs)
        // Belt and braces: captureWakeClip is now guaranteed not to reject (issue #309 moved its
        // pre-flight work inside the try), so this branch should be unreachable. Kept because THIS
        // `.catch()` is the only reason the old gap never bit — a rejection here silently ends wake
        // detection for every camera for the rest of the night, and that is too expensive a thing to
        // guard with an assumption about another module.
        .catch((err) => logger.error(`[wake] capture failed for "${camera.name}": ${err.message}`))
        .finally(() => {
          if (st.run === run && run.holding) {
            releaseRing(cameraId, RING_OWNER.WAKE);
            run.holding = false;
          }
        });
      return { captured: true, startMs };
    }
    return null;
  }

  // Quiet minute: a wake can be intermittent, so short gaps are bridged and a longer one ended the run in
  // the bridge rule above. Nothing more to do.
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
