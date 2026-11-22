import db from '../db.js';
import { logger } from './logger.js';
import { onMinuteFlushed } from './activityTracker.js';
import { SLEEP_THRESHOLDS, childTracksSleep, childWindowActiveNow, childWindowKeyNow, currentNightDate, computeNight } from './sleepAnalysis.js';
import { primaryCameraRowFor } from './primaryCamera.js';
import { holdRing, releaseRing, isSegmenterRunning, ringOldestStartMs, ringHasFootageFor, clipCoverStartMs } from './clipRecorder.js';
import { RING_OWNER, wakeCaptureHoldOwner } from './ringHolds.js';
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
// (SLEEP_THRESHOLDS, imported — never copied). Sharing the numbers does NOT make the two decisions
// equal (#358): this is a streaming approximation, so the timeline can show a wake that has no clip.
// What differs, read from sleepAnalysis.js (the nightly rule can use hindsight, this one cannot):
//   * nightly, a minute is also active on motion OUTSIDE the bed (motion_out_peak); here it is not;
//   * nightly scores ONE analysis camera; this tracks every camera assigned to the child;
//   * that analysis camera arms after the current night's onset persists on two consecutive minute
//     computes. Other cameras still need ONSET_QUIET_MIN observed quiet minutes.
// Replayed with the real watcher code over stored minute rows from 60 staging / 62 production
// child-nights: 60/60 and 62/62 armed (old 51/60 and 53/62); arm minus today's onset median
// 16 min (old 36), p90 24 (old 333 / 173). Four nights in each database exceeded 30 min (old
// 28 / 29): three onsets predated the window and one live onset was visible only in hindsight.
// No live-onset arm preceded the owner's onset. Wakes with a clip: 330 to 385 staging, 341 to
// 390 production; clips not near a wake: +53 / +47. Wakes starting before arm or on an unarmed
// night: 171 to 9 / 159 to 9; 3 / 4 counted wakes were underway at arm, missing their opening.
// Replay used today's window/camera settings, one camera per child, minute-end clip anchors,
// no simulated restarts, and saw one cry event. Live clips can start ~57 s earlier. On a
// development PC a compute took 2 ms median, 8 ms p95, ~250 ms worst; server cost unmeasured.
// A live onset can be withdrawn; once armed this latch stays armed until the window key changes (#922).
// Live computation lacks the completed night's
// 150-minute occupancy guard (fails open past now) and microphone discount (#904, until 480
// timeline minutes). Two results reduce, but cannot eliminate, a false early arm.
// What this watcher itself does:
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
// #588: that includes a camera whose VIDEO stalled while its microphone keeps sending. Its minutes arrive flagged
// `videoUnobserved` and are holes for every other purpose, but each one still runs the bridge-end rule
// (endRunIfGapBroken in handleMinute), so its run and ring hold end on the same minute a quiet gap would have ended
// them. A bare early return for those minutes (the first #588 design) left the hold to this sweep: up to 20 minutes
// where the code before #588 released it after 4 (plan review round 1, Codex and Opus, verified by running).
// A BACKWARD clock step is never caught here: `now - lastActiveMs` is negative after it, so a run whose labels went
// back would sit until the clock caught up plus these 20 minutes. The data path ends such a run instead, at the
// ordering guard for an observed payload and, since #588 review round 2, in the unobserved branch for a stalled one.
const STALE_RUN_MS = 20 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// #590: the `settling restarted` line (see the onset gate in handleMinute): at most once per camera per this long,
// measured on the minute LABELS (the clock this function already uses), not on Date.now(). 15 minutes = the
// `[activity]` counters line's cadence (activityTracker REPORT_MS) and the `[obs]` summary's, so the lines read
// side by side and a camera that flaps all through its onset window cannot write a line a minute. Not
// calibrated on any night: it bounds the worst case, and the restarts it suppresses are counted into the next
// line instead of vanishing.
const RESTART_LOG_MS = 15 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// camera_id -> { window, asleep, latched, latchedWindow, pendingClearKey, quietRun, run, lastAt, restartLogAt, restartsUnlogged, restartsLongest }
// run = { startMs, activeCount, lastActiveMs, captured, holding, holdFromMs }
//   startMs = the clip's anchor (#412: first active frame, clamped to the ring); lastActiveMs = the END label of
//   the last active minute (the bridge arithmetic and the stale-run sweep read it, so it is NOT the anchor)
//   holdFromMs (#471) = the point the run's WAKE hold reaches back to, null until the run takes that hold (and left as it was once the hold is released); the capture's
//   own lease reuses it rather than computing it a second time (see the capture in handleMinute)
// lastAt (#448) = the end-of-minute ms of the last payload ACCEPTED for this camera, null = none yet. It is
// what lets handleMinute measure TIME between payloads, because activityTracker sends no payload at all for a
// minute with neither a motion frame nor a sound window (closeMinute: `hasSignal`), so an outage is visible
// only as a jump in the labels. Cleared by reset() and by a new slot(): a window that opens again must not
// measure from the night before.
// ★ A HOLE is a minute the watcher did not SEE: one with no payload at all, or (#588) one whose payload is flagged
// `videoUnobserved` (sound arrived, the camera had video, but no motion frame did: a video stall). An unobserved
// payload is never ACCEPTED, so it leaves lastAt where it was and the next observed payload measures the stall as
// missing minutes, exactly like an outage. That is what "readings N min apart" counts: minutes between OBSERVED
// readings.
// restartLogAt / restartsUnlogged / restartsLongest (#590) are bookkeeping for the `settling restarted` log
// line ONLY: the label (ms) of the last such line (null = none yet), how many restarts since then the rate
// limit held back, and the most quiet minutes any of those had built up. Nothing in handleMinute's decisions
// reads them; cleared by reset() like the rest, so a window that opens again starts a fresh limiter.
const state = new Map();

// #471: numbers each capture's ring lease (ringHolds.wakeCaptureHoldOwner). Per process, never reset, so two
// captures in flight on one camera, or a late `.finally` from before a stopWakeWatcher(), can never share a key.
let captureSeq = 0;

function slot(cameraId) {
  let st = state.get(cameraId);
  if (!st) {
    st = { window: null, asleep: false, latched: false, latchedWindow: null, pendingClearKey: null, quietRun: 0, onsetWindow: null, onsetLastAt: null, onsetLastComputeAt: null, onsetRun: 0, run: null, lastAt: null, restartLogAt: null, restartsUnlogged: 0, restartsLongest: 0 };
    state.set(cameraId, st);
  }
  return st;
}

// Drop any ring hold this camera is holding and forget the in-flight run. Safe to call repeatedly.
// #471: this releases the RUN's WAKE hold only. A capture this run already started keeps the clip's footage through
// its own lease (taken at the capture in handleMinute, released by the capture's `.finally`), so ending the run here,
// for whatever reason, no longer leaves the janitor free to delete the segments the cut is still reading. Not
// "skip the release when the run captured" (the issue's first idea): with nothing else to release it, that hold
// would stay until the segmenter restarted.
function endRun(cameraId, st, why) {
  if (st.run?.holding) {
    releaseRing(cameraId, RING_OWNER.WAKE);
    if (why) logger.info(`[wake] "${cameraId}" run ended (${why}) — ring released, nothing recorded`);
  }
  st.run = null;
}

function resetMemory(cameraId, st) {
  endRun(cameraId, st, null);
  st.asleep = false;
  // #922: forget the old key with the run, while retaining any failed persisted-row clear for retry.
  st.window = null;
  st.quietRun = 0;
  st.onsetWindow = null;
  st.onsetLastAt = null;
  st.onsetLastComputeAt = null;
  st.onsetRun = 0;
  st.lastAt = null;
  st.restartLogAt = null;
  st.restartsUnlogged = 0;
  st.restartsLongest = 0;
}

// #1037, Opus/Codex plan review: these writes are rare (once per night per camera), and a database
// failure must not change a live alert or wake decision. A failed delete keeps latched true so the
// next payload or sweep retries it. Suppress repeated error lines during a database outage.
const latchRowsQ = db.prepare('SELECT camera_id, child_id, window_start_ms, asleep_at FROM wake_asleep_latch');
const setLatchQ = db.prepare(`INSERT INTO wake_asleep_latch (camera_id, child_id, window_start_ms, asleep_at)
  VALUES (?, ?, ?, ?) ON CONFLICT(camera_id) DO UPDATE SET child_id = excluded.child_id,
  window_start_ms = excluded.window_start_ms, asleep_at = excluded.asleep_at`);
const clearLatchQ = db.prepare('DELETE FROM wake_asleep_latch WHERE camera_id = ?');
// #922: a retry for yesterday must not erase a latch saved under today's key.
const clearLatchByKeyQ = db.prepare('DELETE FROM wake_asleep_latch WHERE camera_id = ? AND window_start_ms = ?');
let lastLatchErrorAt = -Infinity;
const latchWrites = { set: 0, clear: 0 }; // #1037: named test counter; no statement spying.

function latchError(message) {
  const now = Date.now();
  if (now - lastLatchErrorAt >= MINUTE_MS) {
    logger.error(`[wake] asleep latch ${message}`);
    lastLatchErrorAt = now;
  }
}

function clearLatch(cameraId, key = state.get(cameraId)?.latchedWindow) {
  try {
    if (key == null) clearLatchQ.run(cameraId);
    else clearLatchByKeyQ.run(cameraId, key);
    latchWrites.clear++;
    return true;
  } catch (err) {
    latchError(`clear failed: ${err.message}`);
    return false;
  }
}

function reset(cameraId, st) {
  const latchedKey = st.latchedWindow;
  resetMemory(cameraId, st);
  // #1037: only a successful clear forgets the persisted latch; repeated resets retry failures.
  if (st.latched && clearLatch(cameraId)) st.latched = false;
  if (!st.latched) {
    st.latchedWindow = null;
    if (st.pendingClearKey === latchedKey) st.pendingClearKey = null;
  } else st.pendingClearKey = latchedKey;
}

function retryPendingClear(cameraId, st) {
  if (st.pendingClearKey == null) return;
  const key = st.pendingClearKey;
  // #922: retry the old row without resetting this window's quiet/onset progress.
  if (clearLatch(cameraId, key)) {
    st.pendingClearKey = null;
    if (st.latchedWindow === key) { st.latched = false; st.latchedWindow = null; }
  }
}

const cameraQ = db.prepare('SELECT id, name, child_id, disabled FROM cameras WHERE id = ?');
const childCamerasQ = db.prepare('SELECT id FROM cameras WHERE child_id = ? AND disabled = 0');

// One result per child, latch-window key and payload minute. Only the sleep camera asks for it;
// a repeated label can reuse it, while a clock step or #922 window change cannot.
const liveNightCache = new Map();
const liveNightErrors = new Map();
let liveNightProviderForTest = null;
let failNextLiveNight = false;
export function _setLiveNightProviderForTest(fn) { liveNightProviderForTest = fn; liveNightCache.clear(); }
export function failNextLiveNightForTest() { failNextLiveNight = true; }

function liveNightFor(childId, windowStart, at) {
  const cached = liveNightCache.get(childId);
  if (cached?.windowStart === windowStart && cached.at === at) return cached.night;
  let night = null;
  try {
    const date = currentNightDate(childId);
    if (date !== null) {
      if (failNextLiveNight) { failNextLiveNight = false; throw new Error('test fault'); }
      night = liveNightProviderForTest ? liveNightProviderForTest(childId, date, at) : computeNight(childId, date);
    }
  } catch {
    if (liveNightErrors.get(childId) !== windowStart) {
      logger.error(`[wake] live night unavailable for window starting ${new Date(windowStart).toISOString()}; using quiet rule`);
      liveNightErrors.set(childId, windowStart);
    }
  }
  liveNightCache.set(childId, { windowStart, at, night });
  return night;
}

// #919/#922: consult today's gate and key, since a stale latch can survive a closure or a silent key flip.
export function isChildAsleep(childId) {
  if (!childTracksSleep(childId) || !childWindowActiveNow(childId)) return undefined;
  const key = childWindowKeyNow(childId);
  // #922: a silent camera can keep memory until the next sweep, but cannot release this night's hold.
  return childCamerasQ.all(childId).some(({ id }) => state.get(id)?.asleep === true && state.get(id)?.window === key);
}

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
//     than it did, whatever the ring holds. Known edge (code review): when the oldest footage starts less
//     than `leadMs` before `at` (an almost empty ring), the ceiling wins over the clamp, the anchor is `at`
//     (today's anchor) and the clip's PLANNED start, at - leadMs, precedes the footage by up to `leadMs`.
//     extractClip still cuts from the footage (its selection is non-empty because the hold reaches back 7 s
//     before the anchor) and `started_at` is then up to `leadMs` early: the old code had the same edge.
export function wakeClipAnchor({ at, frameMs, oldestStartMs, leadMs }) {
  if (frameMs == null || oldestStartMs == null) return at;
  return Math.min(at, Math.max(frameMs, oldestStartMs + leadMs));
}

// Only tracked children, only inside their own sleep window. Outside it there is no "wake" to speak
// of, and bedtime settling must never be recorded — which is also why nothing is armed until the
// child has actually gone to sleep (see the onset gate in handleMinute).
// #589: ONE gate for the two callers that decide "does this camera still belong to the watcher": handleMinute (when a
// payload arrives) and sweepStaleRuns (when none does), so the two cannot drift apart. `camera` is the cameras row,
// or undefined for one that was deleted.
function watchedNow(camera) {
  return !!camera && !camera.disabled && !!camera.child_id && childTracksSleep(camera.child_id) && childWindowActiveNow(camera.child_id);
}

export function handleMinute(payload) {
  const { cameraId, bucketStart, motionPeak, soundPeak } = payload;
  const st = slot(cameraId);
  const camera = cameraQ.get(cameraId);

  if (!watchedNow(camera)) {
    reset(cameraId, st);
    return null;
  }

  const key = childWindowKeyNow(camera.child_id);
  const changedWindow = st.window != null && st.window !== key;
  if (changedWindow) {
    // #922: the gate can remain open across nights; its key, not gate closure, ends the latch.
    reset(cameraId, st);
  }
  st.window = key;
  if (!changedWindow) retryPendingClear(cameraId, st);

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
  // real segment files), so a shallow ring still cuts a clip, just later. An earlier anchor is kept only
  // when extractClip's own selection finds footage for it (a ring with a hole after its oldest segment would
  // otherwise fail a clip the old code cut), so no clip the old code cut is failed by this. The old anchor
  // `at` stays the ceiling and the label (`lastActiveMs`).
  const at = bucketMs(bucketStart) + MINUTE_MS;
  if (!Number.isFinite(at)) return null;

  const active =
    (motionPeak != null && motionPeak > MOTION_ACTIVE) || (soundPeak != null && soundPeak > SOUND_ACTIVE);

  // ★ #588: THE BRIDGE-END RULE, written once for its two callers: the ONE bridge rule below (a payload that was
  // read) and the unobserved branch right after this (a minute whose video nobody saw). It ends the run when the
  // non-active minutes since the run's last ACTIVE label exceed WAKE_GAP_MIN (the nightly job's constant, by
  // reference); see "ONE bridge rule" below for the arithmetic and its off-by-one. `active` here is the argument,
  // the caller's verdict on THIS minute (always false for an unobserved one), and `why` the reason logged for a run
  // that took a ring hold and captured nothing (a run that captured logs nothing, as before).
  // A closure, not a module function: it reads this call's `at`, `cameraId` and `st`, so a caller cannot hand it
  // another minute's label, and the #448 arithmetic keeps its text and its scope (its mutation-test anchors in
  // scripts/mutants.json, `#448 M3/M4/M5/M10/M14/W3`, still find and mean what they did).
  // No separate `at > st.run.lastActiveMs` guard: `nonActive > WAKE_GAP_MIN` already implies it (a label at or before
  // the last active one gives sinceActiveMin <= 0), so this rule never ends a run on an older label; a backward clock
  // step is handled where it is seen (the ordering guard, and the unobserved branch's own check below).
  const endRunIfGapBroken = (active, why) => {
    if (!st.run) return;
    const sinceActiveMin = Math.round((at - st.run.lastActiveMs) / MINUTE_MS);
    const nonActive = active ? sinceActiveMin - 1 : sinceActiveMin;
    if (nonActive > WAKE_GAP_MIN) {
      endRun(cameraId, st, st.run.captured ? null : why);
    }
  };

  // ★ #588: A MINUTE WHOSE VIDEO NOBODY SAW IS A HOLE. activityTracker flags `videoUnobserved` when this camera had
  // delivered video and the minute holds no motion frame: a video stall with the microphone still working (#369).
  // The nightly job calls that minute unknown and non-active (#508, `motion_frames > 0`) and does not use its sound,
  // even a loud minute (a bedroom microphone hears the whole house), so the watcher handles it as if no payload had
  // arrived: lastAt, quietRun and asleep are left alone, so it is no settling progress and the next observed payload
  // sees the hole (restarting the count; #590 logs that), and a loud one is not active (it starts no run, tops none
  // up, captures nothing). Before #588 it was read as a watched minute: quiet toward the 15, or active if loud.
  // What it still does is END a run, in two cases, both as an observed payload would have ended it:
  //  * its label is OLDER than the last observed one (the wall clock went back during the stall): the run ends with
  //    the ordering guard's own reason, "the clock went back". Code review round 2 (Opus, verified by running): with
  //    only the gap rule below, whose label arithmetic is negative across a backward step, a stir's ring hold stayed
  //    for about the depth of the step, and the 20-minute sweep cannot end it either (`now - lastActiveMs` is negative
  //    too); the code before #588, reading the minute as watched, ended the run at the ordering guard (R588-W9). Only
  //    the run: quietRun, lastAt and asleep stay as they are, and the next observed payload, older than lastAt too,
  //    re-baselines them at the ordering guard as before. A label EQUAL to the last observed one is not older and
  //    ends nothing, as the ordering guard ignores it (R588-W6).
  //  * the gap it adds breaks the run's bridge, on the same minute a quiet gap would have (endRunIfGapBroken; see
  //    STALE_RUN_MS). Its log reason is "video not observed; readings N min apart", N = the label distance in minutes
  //    since the last OBSERVED payload (lastAt). Not "no video for N min" (the first wording): a forward clock jump
  //    looks the same in the labels, and the log must not claim an outage it cannot see (the #448 rule in the bridge
  //    comment below; code review round 2, Opus: a forward excursion logged "no video for 61 min").
  // With a run open, lastAt is never null (a run needs an accepted payload, and reset() clears the two together).
  // Placed AFTER the window gate on purpose: above it, an armed watcher would stay armed through an unobserved minute
  // outside its window and record the next evening's settling as a wake (plan review, Opus, verified by running;
  // R588-W8). Placed BEFORE the ordering guard and the lastAt update: a stale label must not reset settling or move
  // lastAt (R588-W6), and the stall must stay visible to the next payload (R588-W1).
  // `=== true`, not truthiness: a payload without the field (a legacy or hand-built one, or a camera that never had
  // video, whose payloads carry `false`) is handled exactly as before #588 (R588-W5's golden trace).
  if (payload.videoUnobserved === true) {
    if (st.run && st.lastAt != null && at < st.lastAt) endRun(cameraId, st, st.run.captured ? null : 'the clock went back');
    const sinceObservedMs = at - st.lastAt;
    endRunIfGapBroken(false, `video not observed; readings ${Math.round(sinceObservedMs / MINUTE_MS)} min apart`);
    return null;
  }

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
      // A clock step can end (here) or replace (an ACTIVE label far ahead: the new run takes the single WAKE slot)
      // a run whose clip is still being cut. #448 found that this released the cut's footage, because the run's
      // WAKE hold was the only thing protecting it; a hole is far past an extraction, a clock step of more than
      // about 2 minutes (activityTracker absorbs smaller ones) within about a minute of the 5th active minute is
      // not. Fixed by #471: the capture holds its own lease, so ending the run here is safe.
      endRun(cameraId, st, st.run?.captured ? null : 'the clock went back');
      st.quietRun = 0;
    }
  }
  // (#588: an unobserved minute returned above without being accepted, so it counts as missing here.)
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
    // The quiet rule remains a fallback for null or failed live computes, margins and secondary
    // cameras. A hole restarts this count, and also breaks the live-onset streak below.
    // #590: what this hole is about to cost, read BEFORE the count is reset. Only a hole that took real progress
    // away counts: with no quiet minutes yet there was nothing to lose, and an ACTIVE minute zeroes the count
    // on its own, so the hole is not what cost the progress then.
    const lostMin = missingMin > 0 && !active ? st.quietRun : 0;
    if (missingMin > 0) st.quietRun = 0;
    st.quietRun = active ? 0 : st.quietRun + 1;
    // ★ #590: the restart is announced AFTER the count changed (the order the `settled` line below uses), and
    // writes nothing the decisions read, so when the watcher arms is exactly what it was without this line.
    // Why it exists: holes can prevent the quiet fallback from arming, especially on a secondary camera.
    // This line, repeating without a `settled` after it, is evidence for that limit (KNOWN-ISSUES.md).
    // Worded "readings N min apart" like the
    // `run ended` line: a forward clock jump is indistinguishable from a hole in the labels.
    // Rate limit (RESTART_LOG_MS) on the labels; `at < restartLogAt` lets a backward clock step through, or the
    // line would stay silent for as long as the step is deep. A label EQUAL to the last line's is held back
    // (`<`, not `<=`): re-living exactly that minute is not a new restart worth a line (pinned by R590-8b).
    // What the limit holds back is not dropped: the
    // next line carries how many and the longest quiet run among them, because the restart that matters most is
    // the one that came 14 minutes after the last line, after 13 quiet minutes. A count still pending when the
    // watcher arms or its window closes is never printed (documented).
    if (lostMin > 0) {
      if (st.restartLogAt == null || at - st.restartLogAt >= RESTART_LOG_MS || at < st.restartLogAt) {
        const held =
          st.restartsUnlogged > 0
            ? `; ${st.restartsUnlogged} more since the last such line, the longest after ` +
              `${st.restartsLongest} quiet minute(s)`
            : '';
        logger.info(
          `[wake] "${camera.name}" settling restarted: readings ${elapsedMin} min apart ` +
            `after ${lostMin} quiet minute(s)${held}`
        );
        st.restartLogAt = at;
        st.restartsUnlogged = 0;
        st.restartsLongest = 0;
      } else {
        st.restartsUnlogged++;
        st.restartsLongest = Math.max(st.restartsLongest, lostMin);
      }
    }
    const windowStart = key;
    if (st.onsetWindow !== windowStart) {
      st.onsetWindow = windowStart;
      st.onsetLastAt = null;
      st.onsetLastComputeAt = null;
      st.onsetRun = 0;
    }
    let liveOnset = false;
    let computedAt = null;
    // The scoring camera is resolved by the same helper as computeNight. Secondary cameras
    // keep the quiet rule without paying for a full live night every minute.
    if (windowStart !== null && st.quietRun < ONSET_QUIET_MIN &&
        primaryCameraRowFor(camera.child_id, { tieBreak: 'id' })?.id === cameraId) {
      const night = liveNightFor(camera.child_id, windowStart, at);
      // #922: a 24-hour window's new lead still computes the previous night until its start.
      const nightStart = night?.window_start == null ? NaN : Date.parse(
        night.window_start.includes('T') ? night.window_start : `${night.window_start.replace(' ', 'T')}Z`);
      liveOnset = night?.in_progress === true && night.analysis_camera_id === cameraId &&
        night.onset_at != null && nightStart === st.window;
      // The minute labels can be delivered in one event-loop tick after a stall. Require
      // the live calculation's own clock to advance too; as_of is UTC SQL time.
      const asOfMs = night?.as_of == null ? Date.now() : Date.parse(
        night.as_of.includes('T') ? night.as_of : `${night.as_of.replace(' ', 'T')}Z`);
      computedAt = Number.isFinite(asOfMs) ? asOfMs : Date.now();
    }
    st.onsetRun = liveOnset ? (st.onsetLastAt === at - MINUTE_MS && elapsedMin === 1 &&
      computedAt - (st.onsetLastComputeAt ?? -Infinity) >= MINUTE_MS - 1000 ? st.onsetRun + 1 : 1) : 0;
    st.onsetLastAt = at;
    st.onsetLastComputeAt = liveOnset ? computedAt : null;
    if (st.quietRun >= ONSET_QUIET_MIN || st.onsetRun >= 2) {
      const liveRule = st.onsetRun >= 2;
      st.asleep = true;
      st.quietRun = 0;
      // #1037: the window start is the latch's identity. Keep the in-memory decision even if
      // the window changes at this instant or SQLite fails; only a successful write arms clearing.
      try {
        if (windowStart === null) latchError('save skipped: no open window');
        else {
          setLatchQ.run(cameraId, camera.child_id, windowStart, Date.now());
          latchWrites.set++;
          st.latched = true;
          st.latchedWindow = windowStart;
        }
      } catch (err) { latchError(`save failed: ${err.message}`); }
      logger.info(`[wake] "${camera.name}" settled — watching for wakes${liveRule ? " (night's onset)" : ''}`);
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
  // #588: the rule itself is endRunIfGapBroken (above), shared with the unobserved branch, so a minute whose video
  // nobody saw ends a run on exactly the minute this rule would. Only the log reason is decided here.
  // "readings N min apart" and not "no readings for N min": a forward clock jump looks identical to a
  // hole in the labels, and the log must not claim an outage it cannot see.
  const why = missingMin > 0 ? `readings ${elapsedMin} min apart` : 'stir, under the wake threshold';
  endRunIfGapBroken(active, why);

  if (active) {
    if (!st.run) {
      // #412: `startMs` is the clip's ANCHOR (first active frame, clamped to the ring), and ONLY startMs.
      // `lastActiveMs` stays `at`, the label: the bridge arithmetic below and sweepStaleRuns measure whole
      // minutes from it, and copying the anchor in (up to a minute EARLIER than `at`) would LENGTHEN the gap to
      // the next active minute by up to that much: "1 active, 3 quiet, active" measures round(297/60) = 5
      // minutes instead of 4 and a run that must bridge (WAKE_GAP_MIN = 3) would split.
      const leadMs = WAKE_CLIP_LEAD_SEC * 1000;
      const f = firstActiveFrameMs(payload, at - MINUTE_MS);
      const oldest = ringOldestStartMs(cameraId);
      let anchor = wakeClipAnchor({ at, frameMs: f, oldestStartMs: oldest, leadMs });
      // The clamp above reads only the OLDEST segment, which assumes the ring is continuous from there to now.
      // It may not be (the detector can read the camera's sub stream while the ring records the main one, and a
      // relaunch keeps the old segments), and then an earlier anchor can have NOTHING covering its window:
      // extractClip's selection is empty and the row fails, where today's anchor (`at`) would have been cut. So
      // an anchor earlier than `at` is kept only when the same selection extractClip will make (shared
      // function, clipRecorder.selectRingSegments) finds footage for it now; otherwise today's anchor stands.
      // What this proves, and what it does not (Codex, round 1): the WINDOW holds some footage, not that footage
      // exists AT the first frame (footage resuming later in the window keeps the early anchor and the cut begins
      // where the footage does). And it is evaluated now with today's wake_clip_seconds: an admin changing that
      // setting before the capture, on a ring with such a hole, can leave the early anchor with an empty window.
      if (anchor < at) {
        const { clipSeconds } = getWakeClipSettings();
        if (!ringHasFootageFor(cameraId, { at: anchor, preRollSec: WAKE_CLIP_LEAD_SEC, postRollSec: clipSeconds })) {
          anchor = at;
        }
      }
      st.run = { startMs: anchor, activeCount: 0, lastActiveMs: at, captured: false, holding: false, holdFromMs: null };
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
        // #471: the point is computed ONCE and kept on the run, so the capture's lease below reaches back exactly as
        // far as this hold (and as the cut reads), with no second copy of the formula to drift.
        st.run.holdFromMs = clipCoverStartMs(anchor, WAKE_CLIP_LEAD_SEC);
        holdRing(cameraId, RING_OWNER.WAKE, st.run.holdFromMs);
        st.run.holding = true;
        // The clamp cost the opening: the ring's oldest footage starts after the first frame's lead-in. This
        // line is the evidence for whether a deeper ring is worth building (#412 follow-up); nothing else
        // logs it. Not logged when the clip still opens before or at the movement (a 0-3 s clamp is hidden
        // by the lead-in), nor when there was no frame to compare against, nor when the ring had no closed
        // segment to measure (`oldest` null: the anchor is then `at` for lack of information, and the line
        // would claim a buffer depth nobody measured).
        if (f != null && oldest != null) {
          // Whole seconds, and no line for a loss that rounds to 0 s or below (a clip that still opens at or
          // before the movement has lost nothing; a 0 s line would read "reaches back only to 0 s after the
          // first movement", which says nothing a person can act on).
          const lostSec = Math.round((anchor - leadMs - f) / 1000);
          if (lostSec >= 1) {
            logger.info(
              `[wake] "${camera.name}" the buffer reaches back only to ${lostSec} s ` +
                `after the first movement: the clip starts there`
            );
          }
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
      // ★ #471: THE CUT HOLDS ITS OWN LEASE, separate from the run's WAKE hold. The run's hold goes when the run
      // ends, and a run ends while its capture is still extracting in six ways: the window closing or the camera
      // being disabled (reset), a quiet gap, the stale-run sweep, stopWakeWatcher, and the two #448 clock steps
      // (an older label ends it; an active label far ahead ends it and the NEW run's holdRing takes over the one
      // WAKE slot). Each left the janitor free to delete the segments the cut was about to read. Same shape as the
      // on-demand and detection-clip leases (ringHolds.ondemandHoldOwner, clipHoldOwner; #445, #446): a clip in
      // flight holds its footage itself instead of borrowing a hold that something else can release.
      //   * Taken SYNCHRONOUSLY, before captureWakeClip is called: nothing can run in between, so there is no
      //     moment when the capture exists and its footage is unheld.
      //   * From run.holdFromMs, the run's own hold point, which is clipCoverStartMs: the formula extractClip
      //     selects with, so the lease reaches exactly as far back as the cut reads. That is the 0.33.1 review's
      //     finding F2 on #446 (a lease that exists but is too shallow still fails the case it exists for).
      //   * Only if the run held the ring. A run that never held (wake clips were off, or no segmenter, when it
      //     began) has nothing a lease could add: captureWakeClip returns null with clips off, and the footage
      //     from before the ring existed is not there to protect. `run.holding` can be STALE (stopSegmenter clears
      //     every hold without the watcher knowing); holdRing then returns false and records nothing, and the
      //     watcher relies on nothing it did not get: the release below of a lease never recorded is a no-op
      //     (ringHolds.removeHold: an unknown owner is never a clear-all).
      const leaseOwner = wakeCaptureHoldOwner(++captureSeq);
      if (run.holding) holdRing(cameraId, leaseOwner, run.holdFromMs);
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
          // #471: the lease goes with the CAPTURE, unconditionally: whether the run is still st.run, ended, or was
          // replaced, this cut is over and nothing else will ever release its key. Guarding it like the WAKE release
          // below would leak it in exactly the cases it exists for (the run has ended, so st.run !== run), and the
          // ring would then grow until the segmenter next restarts.
          releaseRing(cameraId, leaseOwner);
          // The run's WAKE hold keeps its guard: release it only while this run is still the current one. A NEW run
          // (a clock step, #448) holds the same single WAKE key, and this capture must not take that away.
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
    // ★ #589: A SILENT CAMERA IS DISARMED WHEN ITS WINDOW CLOSES. handleMinute clears a camera's state only when a
    // payload arrives outside the window (its gate above), and a camera that sends nothing from before the window closes
    // until the next evening never triggers that: it kept `asleep`, so the next bedtime's settling was not gated and
    // five active minutes could record a wake clip before the child had settled (a wasted clip, never an alert; it
    // needs a day-long silence, an unplugged camera or an outage). This timer runs whether or not payloads do, so it
    // applies the same gate (watchedNow, with childWindowActiveNow's own 5-minute margin) and resets. It reads the
    // wall clock, not `now`: `now` is only the stale-run age, and the window is a wall-clock notion everywhere else.
    // Not counted in the return value, which stays "runs abandoned as stale". Deliberately NOT "disarm after a hole of
    // N minutes": an armed watcher still stays armed across a hole INSIDE the window (a reconnect must not drop a real
    // wake, see the bridge rule in handleMinute) and a new N would have no data behind it. Known limit: a silent camera
    // is disarmed up to about 6 minutes after its window closes (the 5-minute margin plus up to one sweep interval).
    // #1037, Opus/Codex plan review: no "is the slot dirty" pre-check. A hydrated latch can have
    // lastAt == null before its first payload, yet closing the window must still delete its row.
    if (!watchedNow(cameraQ.get(cameraId))) {
      reset(cameraId, st);
    }
    const camera = cameraQ.get(cameraId);
    const watched = watchedNow(camera);
    const changedWindow = watched && st.window != null && st.window !== childWindowKeyNow(camera.child_id);
    if (changedWindow) {
      // #922: a silent camera needs the same new-night reset as a reporting camera.
      reset(cameraId, st);
      st.window = childWindowKeyNow(camera.child_id);
    }
    if (watched && !changedWindow) retryPendingClear(cameraId, st);
  }
  return swept;
}

let unsubscribe = null;
let pruneTimer = null;
let sweepTimer = null;

/** Start watching. Idempotent. */
export function startWakeWatcher() {
  if (unsubscribe) return;
  // #1037, Opus/Codex plan review: nothing before index.js starts this watcher awaits, so
  // neither MQTT (which connects just before it) nor a detector can check an alert between
  // hydration and subscription. Keep the slot object: capture .finally compares st.run by identity.
  try {
    for (const row of latchRowsQ.all()) {
      const camera = cameraQ.get(row.camera_id);
      let reason = null;
      if (!camera) reason = 'camera missing';
      else if (camera.disabled) reason = 'camera disabled';
      else if (camera.child_id !== row.child_id) reason = 'child changed';
      else if (!childTracksSleep(row.child_id)) reason = 'tracking off';
      else if (!Number.isSafeInteger(row.window_start_ms)) reason = 'invalid window start';
      else if (childWindowKeyNow(row.child_id) !== row.window_start_ms) reason = 'window changed or closed';
      if (reason) {
        clearLatch(row.camera_id);
        logger.info(`[wake] discarded asleep latch for "${row.camera_id}" (${reason})`);
        continue;
      }
      const st = slot(row.camera_id);
      st.asleep = true;
      st.latched = true;
      st.window = row.window_start_ms;
      st.latchedWindow = row.window_start_ms;
      const iso = (value) => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())
        ? new Date(value).toISOString() : 'invalid time';
      logger.info(`[wake] resumed asleep latch for "${camera.name}" (window starting ${iso(row.window_start_ms)}, saved ${iso(row.asleep_at)})`);
    }
  } catch (err) {
    // #1037: a corrupt stored row must not crash-loop boot or partially arm cameras.
    state.clear();
    latchError(`hydrate failed: ${err.message}`);
  }
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
  // #1037: stopping is a restart path; clearing the database here would recreate the alert hold.
  for (const [cameraId, st] of state) resetMemory(cameraId, st);
  state.clear();
  liveNightCache.clear();
  liveNightErrors.clear();
  liveNightProviderForTest = null;
  failNextLiveNight = false;
}

/** Test seam: current per-camera watcher state. */
export function _state() {
  return state;
}

/** Test seam: count successful latch writes without inspecting SQLite statement internals. */
export function _latchWritesForTest() { return { ...latchWrites }; }
