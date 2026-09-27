// The OBSERVATION CLOCK: for every sample the motion and sound detectors analyse, when was it observed,
// how was it produced, and how much of the timeline was actually covered (issue #373 Stage 2, plan v4).
//
// ★ A MEASURING INSTRUMENT ONLY. Nothing downstream reads it yet: detection decisions, activity buckets,
// alerts and every stored number are exactly what they were (the golden test in
// detector-observation-wiring.test.js pins them with a working, a throwing and an absent clock). #447
// (flush-time buckets), #452 (confirmation across an outage), #493 (stop consuming clones), #369 and #448
// will switch over to it one at a time, each with its own A/B. Until then it reports, once per camera per
// leg every 15 minutes, an `[obs]` line (see formatSummaryLine and KNOWN-ISSUES.md for every field).
//
// WHY IT EXISTS. The detectors timestamp each sample with Date.now() when Node happens to read it. Bursts
// compress time and a late batch lands in the wrong minute. Worse, the motion leg's `fps=5` FABRICATES
// frames: when the camera stalls it repeats the last frame to fill the grid, and the rawvideo CFR stage can
// duplicate again, so "a quiet minute" can be a minute nobody observed. This module rebuilds the truth from
// ffmpeg's own per-frame input timestamps (the showinfo/ashowinfo taps, parsed by ffmpegSideChannel.js).
//
// WHAT "PTS" IS HERE (Stage 1, settled). transcoder.js runs `-use_wallclock_as_timestamps 1`, so a
// detector's input PTS is the moment each real camera frame reached THIS SERVER, per reader connection,
// starting near 0. Absolute capture lag is unmeasurable; a camera-side stall shows as a PTS gap followed by
// a clump, never as "late real frames".
//
// THE MODEL, per sample:
//   - a CLASS. Motion: REAL, CLONE-FPS (fps repeated an older frame), CLONE-CFR (the rawvideo muxer
//     duplicated one), or UNKNOWN with a reason. Sound: observed or UNKNOWN. UNKNOWN is a first-class answer
//     (plan C2): a clone or a loss is only ever asserted on POSITIVE evidence, and "loss" never is (R1-F6);
//   - an OBSERVATION TIME, monotonic and UTC, finalized FINALIZE_MS after receipt and never revised (C1);
//   - COVERAGE: sampler coverage (the sampler received real input) and analysis coverage (it was analysed),
//     held per clock as a union of intervals, with gaps and restarts explicit (C5).
//
// ⚠️ EVERY THRESHOLD BELOW WAS MEASURED ON ONE HOUSE: two Thingino cameras (10 fps sub, 15 fps main, G711
// 8 kHz), a soak box with a fakecam, and the Stage 1 night, overnight and day runs (2026-09-24/25). Another
// house's cameras and network may jitter more. The `[obs]` line reports `delayed`, `gaps` and the age
// percentiles precisely so each install can see its own margin; if those look wrong for a camera, these
// numbers are the first suspects.
import { performance } from 'node:perf_hooks';
import { logger } from './logger.js';
import { adler32 } from './ffmpegSideChannel.js';

// --- constants (plan v4 "Constants") ------------------------------------------------------------------------

// A motion input-PTS jump bigger than this is a real observation gap. Largest in-stream jump measured:
// 133 ms at night, 261 ms by day (main stream), so 0.4 s is ~1.5x the worst; 0 false gaps in 6 h
// overnight, and the soak box's 3 s DROPs were all caught. Other networks may clump harder than this.
export const MOTION_GAP_S = 0.4;
// ...unless the camera itself is slow: the gap threshold is max(MOTION_GAP_S, GAP_FACTOR x the median input
// interval around the candidate), so a 15 -> 2 fps switch reads as a rate change, not a run of gaps (R2-O7,
// R3-6). Worst measured jump/median ratio: 3.95 (day main, 261/66 ms), so 5 leaves 1.27x. The factor binds
// below 12.5 fps: at 15 fps the threshold is the 0.4 s floor, at 10 fps (the sub streams) it is 0.5 s.
// (Plan v4 said the floor binds at 10 fps too; 5 x 100 ms says otherwise. Both measured maxima, 133 and
// 261 ms, sit under either figure, so no measured behaviour depends on it.)
export const GAP_FACTOR = 5;
// A host wall-clock step (NTP) moves every leg's PTS, because the transcoder stamps packets with the
// realtime clock. Records received within this window after the step was noticed are the transcoder-lag
// zone, where each record is assigned to the side of the step that best explains it (R3-3'). A PTS jump
// reaches the detector tens of ms after a step, so 2 s is generous.
export const WALL_MATCH_WINDOW_MS = 2000;
// A zone record that NEITHER side explains to within this is flagged timingUncertain. It sits above the
// day run's audio packet deviation p99.9 (208 ms), so ordinary jitter does not trip it.
export const WALL_MATCH_TOL_MS = 250;
// A sound DISCONTINUITY is a sustained rise in the floor of (PTS - sample clock), not a per-packet jump.
// The day run's worst packet deviation was +268 ms, recovered in ~320 ms (8 packets); 0.5 s is ~1.9x it.
// The soak box's 3 s DROPs were caught. A real loss SMALLER than this is absorbed into coverage (a stated
// limit, KNOWN-ISSUES.md).
export const SOUND_GAP_S = 0.5;
// ...and "sustained" means the elevated floor held for this long in RECEIPT time. The day clump recovered
// in ~320 ms, so ~3x margin. A lossless backlog that drains slower than this is reported as UNKNOWN (the
// conservative direction: observed audio reported as unknown, never missing audio as observed).
export const SOUND_RECOVER_MS = 1000;
// A rise above HALF of SOUND_GAP_S that does not become a discontinuity is counted `delayed`, once per
// episode. Not a new measurement: it exists so the `[obs]` line shows each install how close its clumps
// come to the gap threshold. The day run's +268 ms clump (a 263 ms floor rise) is exactly such an episode.
const SOUND_DELAY_REPORT_S = SOUND_GAP_S / 2;
// How long a stdout sample waits for its matching tap record. Record->sample skew measured: max 5.8 ms
// (night), 9.4 ms (day), and a record never arrived after its own sample, so this is ~100x for Node stalls.
export const PENDING_MS = 1000;
// An observation is final this long after receipt, and never revised (C1). It has to outlast the startup
// burst (<= 14 samples, 2.8 s of media, at night; 5-11 by day) so the first anchor sees all of it, and it
// has to be >= SOUND_RECOVER_MS so a discontinuity is decided before the windows around it are final.
export const FINALIZE_MS = 5000;
// The anchor is the lower envelope of (receipt - PTS) over this window. A 60 s window let a sustained
// backlog roll the pre-backlog minimum out and collapse the stamps (R3-1); over 1 h, the measured drift
// (<= 8 ppm) moves it 29 ms, below day jitter p99 (74 ms). Only a backlog lasting more than 1 h can move it.
export const ANCHOR_WINDOW_MS = 3_600_000;
// The reference floor a sound discontinuity is measured against: the minimum over this much media before
// the candidate. It tracks audio-clock drift (12-100 ppm -> <= 6 ms per window), so drift never builds up
// into a phantom discontinuity (R2-O2).
export const SOUND_REF_WINDOW_MS = 60_000;
// The anchor moves toward its target by at most this fraction of elapsed time. A DESIGN CHOICE, not a
// measurement: an 8 s correction converges in 80 s with sample spacing kept within +-10%; normal drift
// (<= 8 ppm) never binds it (R1-F10).
export const ANCHOR_SLEW = 0.1;
// A change of (wall - mono) bigger than this between two receipts opens a new wall epoch. Far above
// Date.now()'s 1 ms quantisation, far below the 900 ms step C4 names.
export const WALL_STEP_MS = 50;
// One `[obs]` line per camera per leg this often: ~400 lines/day for 2 cameras x 2 legs.
export const OBS_LOG_MS = 900_000;
// A clock with no open generation and no activity for this long is evicted by the idle sweep (it leaves a
// tombstone; see forgetObservationClocks). Covers the paths where a stop returns early with no entry
// (R2-O9): a camera inside the #253 restart window, and sound that gave up for having no audio.
export const IDLE_EVICT_MS = 3_600_000;
// `in` records are kept this long for provenance and the gap median (plan: "the last ~10 s"), except the
// current fps source, which is never pruned (R4-4).
export const IN_RING_MS = 10_000;
// How long an `out` record is kept once it has been RELEASED (see pruneRing): once the record AFTER it has
// arrived — or, for an identical-content run, the record after the whole run. NOT since its own arrival.
// The rawvideo CFR stage holds output frame k until frame k+1 exists, so sample k is written when record
// k+1 is logged; during a camera stall with the RTSP session still up, frame k+1 only exists when input
// resumes, so sample k legitimately arrives a WHOLE STALL after its own record. Fix round 1 timed this from
// the record's own arrival and so, on every connected stall over ~31 s, lost the REAL frame held across it
// (and, when the stream ended inside PENDING_MS of the burst, the burst's whole clone evidence): fix round 2,
// H1, found by the Opus review's crafted stalls and motion fuzz. Once released, a sample follows within the
// measured record->sample skew (<= 9.4 ms, day run) plus Node's read of a burst, so 30 s is ~3,000x that.
// It still bounds the leak it was added for (fix round 1, F1): with records flowing and no samples, every
// record is released one frame later and goes 30 s after that. Not a measurement of any house.
const OUT_RETAIN_MS = 30_000;
// A hard cap on the `in` ring, whatever the rule above says, so a pathological stream cannot grow memory
// without bound. Hitting it can only turn an answer into UNKNOWN (provenance()'s 'no-source' check on
// pruned records), never into a guess.
const IN_RING_MAX = 4000;
// The transcoder clamps DTS after a BACKWARD wall step, so for |step| frames arrive with near-equal PTS
// (one tick apart). A raw PTS delta at or under this marks such a frame.
const DTS_CLAMP_MS = 1;
// How many samples a generation finalizes before concluding its side channel is not delivering records.
const SIDE_CHECK_SAMPLES = 10;
// Bounds on per-period bookkeeping, so a period cannot grow memory without bound.
const AGE_SAMPLES_MAX = 20_000;
const WALL_STEP_LOG_MAX = 10;
// Sound positions are sums of nb_samples/rate in floating point; two positions this close are the same.
const POS_EPS = 1e-9;

// --- small utilities ----------------------------------------------------------------------------------------

// fps rounds an input frame onto its output grid with av_rescale_q_rnd(..., AV_ROUND_NEAR_INF): round half
// AWAY from zero. Done in integer arithmetic, never on pts_time: a frame one tick either side of a half-slot
// edge has to land exactly where fps puts it (fixtures/obs/slot-edges-32x18.err pins it: 2.5 -> 3, 8.5 -> 9,
// 1.49994 -> 1, 4.50006 -> 5). Exact while |num| < 2^52, i.e. ~10^10 s of a 90 kHz clock.
export function roundNearInf(num, den) {
  if (num >= 0) return Math.floor((2 * num + den) / (2 * den));
  return -Math.floor((-2 * num + den) / (2 * den));
}

// A sliding-window minimum over a monotonically increasing key: O(1) amortised, and the memory is the
// deque, not the window's records.
//
// ⚠️ BOUNDED, and the bound is not free (fix round 1, F1 audit). A monotonic deque holds every entry that
// is lower than everything after it, so a series that only RISES (a camera clock running slow, a Node
// backlog growing for an hour) keeps the whole window: 1 h at 30 records/s is 108,000 entries. Past its cap,
// adjacent pairs are merged into one entry with the LOWER value and the LATER key. The reported minimum is
// then never higher than the true one — but it CAN be lower: a merged entry keeps its older, lower value
// until its later key expires, so the minimum reads too low by up to the series' RISE across the merged
// pair, for up to the pair's KEY DISTANCE. Fix round 1's comment said "a few seconds"; the Opus review
// (fix round 2, H2, craft-deque-phantom.mjs) showed the distance is what the pairing makes it — 8 s of the
// 60 s sound reference window there, across a 300 ms step — and a reference floor that reads 300 ms too
// low for 8 s produced a phantom 500.9 ms discontinuity that shifted every later window by +500 ms.
//
// So the cap is set where it CANNOT bind on the 60 s windows (the sound reference floor, and rxFloor): the
// densest 60 s these legs see is ~3,000 records (sound 25/s at 8 kHz G711, ~47/s at 48 kHz AAC; motion `in`
// records up to 30/s at 4K30, all measured in the Stage 1 and v4 identity runs), and 8,192 only binds above
// ~136 records/s. On the 1 h anchor envelope a rising series can still reach it (10 records/s for an hour is
// 36,000), so there coarsening stays as the memory backstop, with the bound above: a too-low envelope makes
// stamps early by at most that rise, never after their receipt. Entries also expire on push, not only on
// read, because a window that is pushed to but never read (rxFloor, outside a wall step) would otherwise
// never shed anything.
const DEQUE_MAX = 8192;

class MinDeque {
  constructor(windowMs) {
    this.w = windowMs;
    this.keys = [];
    this.vals = [];
    this.head = 0;
  }

  push(key, value) {
    while (this.keys.length > this.head && this.vals[this.vals.length - 1] >= value) {
      this.keys.pop();
      this.vals.pop();
    }
    this.keys.push(key);
    this.vals.push(value);
    this.expire(key);
    if (this.keys.length - this.head > DEQUE_MAX) this.coarsen();
  }

  expire(nowKey) {
    while (this.head < this.keys.length && this.keys[this.head] < nowKey - this.w) this.head += 1;
    if (this.head > 256 && this.head * 2 > this.keys.length) {
      this.keys = this.keys.slice(this.head);
      this.vals = this.vals.slice(this.head);
      this.head = 0;
    }
  }

  coarsen() {
    const keys = [];
    const vals = [];
    const n = this.keys.length;
    let i = this.head;
    for (; i + 1 < n; i += 2) {
      keys.push(this.keys[i + 1]);
      vals.push(this.vals[i]); // values rise front to back, so vals[i] is the pair's minimum
    }
    if (i < n) {
      keys.push(this.keys[i]);
      vals.push(this.vals[i]);
    }
    this.keys = keys;
    this.vals = vals;
    this.head = 0;
  }

  size() {
    return this.keys.length - this.head;
  }

  min(nowKey) {
    this.expire(nowKey);
    return this.head < this.keys.length ? this.vals[this.head] : null;
  }
}

// A union of half-open intervals [lo, hi), kept sorted and merged (C5: coverage is a UNION). Touching or
// overlapping intervals merge, so a continuously covered stream is ONE entry; entries ending before the
// current `[obs]` period are pruned by resetPeriod(). BOUNDED regardless (F1 audit): if the period timer
// is not running, only the newest INTERVALS_MAX disjoint intervals are kept — more than one gap per 0.1 s
// for a whole 15-minute period, which no stream here comes near. At the cap the earliest interval goes only
// if the new one did not merge into what is there (fix round 2, G3, Codex review: fix round 1 evicted
// BEFORE merging, so an interval inside the newest one cost the earliest one for nothing).
//
// Coverage is exact to within INTERVAL_JOIN_EPS_MS per JOIN, not exact: two intervals up to 1e-6 ms (one
// nanosecond) apart are joined, so the measured union can exceed the truth by at most 1e-6 ms for each gap
// that small it closed — immaterial next to the 0.1% the `[obs]` line prints, and the price of not
// splitting coverage on floating-point window edges (below). The Opus review's brute-force comparison over
// 3,000 randomised sets measured at most 8.5e-6 ms of over-statement, and never an under-statement.
const INTERVALS_MAX = 10_000;
const INTERVAL_JOIN_EPS_MS = 1e-6;
// Generations a clock keeps before its backstop drops closed ones that never observed (see pruneEmptyGens):
// normally 0-2 (closed ones fold). It never drops an open generation, so it is a target, not a hard cap.
const GENS_MAX = 16;
// Identical-content runs open at once (see onOut): normally 0, briefly 1.
const OPEN_RUNS_MAX = 64;
// `holes` and `reorderedSpans` kept at most (see pruneRing): a backstop, normally a handful (they live
// IN_RING_MS past the oldest slot still to classify). Added in fix round 2 (H1): once `out` records are
// kept until RELEASED, an identical-content run that never ends while no sample resolves anything (a
// frozen scene with stdout stalled) pins that oldest slot, and only a count bounds these two lists. A
// dropped entry leaves a floor behind (holesFloor / spansFloor): every slot at or below it reads UNKNOWN,
// so hitting the cap can turn an answer into UNKNOWN, never into a guess.
const HOLES_MAX = 256;
const SPANS_MAX = 256;
// Sound discontinuities kept unfolded at most (see foldDisc): normally 0-2 (they fold as the windows before
// them finalize). Only a leg whose stdout stalls while its records keep flowing reaches it (fix round 2, H4 —
// Astra review: ~8,600 a day at 25 records/s). Past it the oldest folds early and leaves a floor
// (discCapPos): a window starting before it reads UNKNOWN('disc-capped'), never a wrong time.
const DISC_MAX = 256;

class IntervalSet {
  constructor() {
    this.iv = [];
  }

  add(lo, hi) {
    if (!(hi > lo)) return;
    const iv = this.iv;
    let i = iv.length;
    while (i > 0 && iv[i - 1][0] > lo) i -= 1;
    iv.splice(i, 0, [lo, hi]);
    // Merge around the insertion point (appends are the common case, so this stays short).
    let j = Math.max(0, i - 1);
    while (j < iv.length - 1) {
      // Touching intervals are ONE: consecutive sound windows meet exactly in theory, but their edges are
      // sums of floating-point media positions, and a join off by 1e-12 ms used to leave ~900 separate
      // intervals per 15 minutes at the real window rate (found by the bounded-growth test).
      if (iv[j][1] + INTERVAL_JOIN_EPS_MS >= iv[j + 1][0]) {
        iv[j][1] = Math.max(iv[j][1], iv[j + 1][1]);
        iv.splice(j + 1, 1);
      } else if (j > i) break;
      else j += 1;
    }
    // Only now, if the union really needs one more interval than the cap allows, the earliest goes (G3).
    if (iv.length > INTERVALS_MAX) iv.shift();
  }

  measure(lo, hi) {
    let sum = 0;
    for (const [a, b] of this.iv) {
      const x = Math.max(a, lo);
      const y = Math.min(b, hi);
      if (y > x) sum += y - x;
    }
    return sum;
  }

  prune(before) {
    while (this.iv.length && this.iv[0][1] <= before) this.iv.shift();
  }
}

// Sorted, overlap-merged [lo, hi] pairs of a list of {lo, hi} (inclusive), and a membership test on them:
// the same yes/no as "t is inside any of them", by binary search (provenanceMany).
function mergedIntervals(list) {
  const iv = list.map((x) => [x.lo, x.hi]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of iv) {
    const last = out[out.length - 1];
    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function inIntervals(iv, t) {
  let lo = 0;
  let hi = iv.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (iv[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t <= iv[lo - 1][1];
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1)))];
}

function newPeriod() {
  return {
    samples: 0, real: 0, fpsClone: 0, cfrDup: 0, cfrDrop: 0, runsCapped: 0, unknown: 0, ambiguous: 0, reordered: 0,
    observed: 0, silent: 0, gaps: 0, gapMs: 0, delayed: 0, restarts: 0, restartMs: 0,
    compressed: 0, clamps: 0, uncertain: 0, wallSteps: 0, warn: 0, late: 0, ages: [],
    wallStepLogs: 0, active: false,
  };
}

// --- the registry -------------------------------------------------------------------------------------------
// ★ MODULE-LEVEL, NOT per detector closure (R1-F13). soundDetector.js documents a reconcile race that
// re-creates startSoundDetector's closure after ~1.7% of exits; a clock living there would silently reset
// and lose cross-restart continuity. Keyed by camera and leg, created on first use.
const registry = new Map(); // `${cameraId}:${leg}` -> ObservationClock
// Continuity tombstones (R3-5): what an evicted clock leaves behind, so a camera that comes back after a
// 70-minute outage (or a settings stop left idle past the sweep) still yields its RESTART discontinuity.
// A few numbers per (camera, leg); dropped only on camera delete.
const tombstones = new Map();
// Generation numbers are per LEG for the backend's lifetime, never per clock, so numbering never restarts
// when a clock is evicted and re-created.
const generationCounters = { motion: 0, sound: 0 };
let testFactory = null;
let logTimer = null;
// Throws caught by openObservation's handle: the second layer of the fail-safe. A real clock guards and
// counts its own failures (`warn`), so a non-zero count here means a clock-shaped object misbehaved.
let handleFailures = 0;
export const observationHandleFailures = () => handleFailures;

const keyOf = (cameraId, leg) => `${cameraId}:${leg}`;

export function getObservationClock(cameraId, leg, { clocks, label, log, onObservation } = {}) {
  const key = keyOf(cameraId, leg);
  let clock = registry.get(key);
  if (!clock) {
    clock = new ObservationClock(cameraId, leg, { clocks, label, log, onObservation, tombstone: tombstones.get(key) });
    registry.set(key, clock);
  } else if (label) {
    clock.label = label;
  }
  return clock;
}

// Camera delete: the clocks AND their tombstones go. (A stopped or disabled camera keeps its clock until
// the idle sweep, which leaves a tombstone, so its next start still reports the restart.)
export function forgetObservationClocks(cameraId) {
  for (const leg of ['motion', 'sound']) {
    registry.delete(keyOf(cameraId, leg));
    tombstones.delete(keyOf(cameraId, leg));
  }
}

// The idle sweep, run on the [obs] timer. Exported so a test can drive it with its own clock.
export function sweepIdleClocks() {
  for (const [key, clock] of registry) {
    if (clock.isIdle()) {
      tombstones.set(key, clock.tombstone());
      registry.delete(key);
    }
  }
}

// The [obs] timer body: one line per active clock, then the sweep. Exported for tests.
export function logObservationSummaries() {
  for (const clock of registry.values()) {
    try {
      if (clock.hasSomethingToReport()) clock.log(formatSummaryLine(clock.summary()));
      clock.resetPeriod();
    } catch {
      // A reporting bug must never take down the timer that every other camera's line depends on.
    }
  }
  sweepIdleClocks();
}

// One module-level interval, `unref()`d so it can never hold the process open (issue #278), with an
// exported stop that shutdown() calls and suite-exits-cleanly.test.js asserts (the #286 pattern).
export function startObservationLog() {
  if (logTimer) return;
  logTimer = setInterval(logObservationSummaries, OBS_LOG_MS);
  logTimer.unref?.();
}

export function stopObservationLog() {
  if (logTimer) clearInterval(logTimer);
  logTimer = null;
}

// ⚠️ TEST SEAM, not an API. The golden test must run the REAL detectors with a working, a throwing and no
// clock, and mocking this module would corrupt coverage for the whole suite (it is in test:core's include
// list). So the detectors ask openObservation() for their clock, and a test can substitute the factory.
// `fn(cameraId, leg)` returns a clock-shaped object, or null for "no clock". null restores the default.
export function _setObservationClockFactoryForTests(fn) {
  testFactory = fn;
}

// Test-only: forget everything, including tombstones and the generation counters.
export function _resetObservationClocksForTests() {
  registry.clear();
  tombstones.clear();
  generationCounters.motion = 0;
  generationCounters.sound = 0;
  testFactory = null;
}

// --- the detectors' handle ----------------------------------------------------------------------------------
// ★ THE FAIL-SAFE (R2-O5, C6). The detectors never touch a clock directly: they get this handle, whose every
// method is wrapped, so a clock that throws (or does not exist) can never reach a detection decision. The
// clock's own entry points are guarded too; this is the second layer, and the one that makes a substituted
// or broken clock safe. It also carries the receipt clock, so a detector reads `rx` once per 'data' event
// from the SAME time source the clock uses.
export function openObservation(cameraId, leg, { label, path, fps, windowSeconds } = {}) {
  let gen = null;
  let clockRef = null;
  try {
    clockRef = testFactory ? testFactory(cameraId, leg) : getObservationClock(cameraId, leg, { label });
    gen = clockRef ? clockRef.beginGeneration({ path, fps, windowSeconds }) : null;
  } catch {
    handleFailures += 1;
    gen = null;
  }
  const guard = (fn) => (...args) => {
    if (!gen) return;
    try {
      fn(...args);
    } catch {
      handleFailures += 1;
    }
  };
  return {
    active: () => gen !== null,
    receipt() {
      try {
        if (clockRef && typeof clockRef.receipt === 'function') return clockRef.receipt();
      } catch {
        // fall through to the process clocks
      }
      return { mono: performance.now(), wall: Date.now() };
    },
    onRecord: guard((rec) => gen.onRecord(rec)),
    onConfig: guard((cfg) => gen.onConfig(cfg)),
    onParseError: guard((tap) => gen.onParseError(tap)),
    onSample: guard((bytes, rxMono, rxWall, opts) => gen.onSample(bytes, rxMono, rxWall, opts)),
    end: guard((reason, info) => gen.end(reason, info)),
  };
}

// --- the per-camera, per-leg clock --------------------------------------------------------------------------
export class ObservationClock {
  constructor(cameraId, leg, { clocks = {}, label, log, onObservation, tombstone } = {}) {
    this.cameraId = cameraId;
    this.leg = leg;
    this.label = label || String(cameraId);
    this.monoNow = clocks.monoNow || (() => performance.now());
    this.wallNow = clocks.wallNow || (() => Date.now());
    this.log = log || ((line) => logger.info(line));
    this.onObservation = onObservation || null;
    const mono = this.monoNow();
    this.createdMono = mono;
    this.lastActivityMono = mono;
    this.lastOffset = this.wallNow() - mono;
    // Wall epochs (C4): UTC for a stamp comes from the epoch that CONTAINS it (R3-7), not the one in force
    // when it was delivered.
    this.epochs = [{ startMono: mono, offset: this.lastOffset }];
    this.gens = [];
    // Continuity across generations and evictions (R1-F1, R3-5).
    this.prevLastObsMono = tombstone ? tombstone.lastObsMono : null;
    this.prevCloseReason = tombstone ? tombstone.lastReason : null;
    this.prevCloseCode = tombstone ? tombstone.lastCode : null;
    this.sampler = new IntervalSet();
    this.analysis = new IntervalSet();
    this.periodStart = mono;
    this.period = newPeriod();
    this.lastGen = null;
  }

  receipt() {
    return { mono: this.monoNow(), wall: this.wallNow() };
  }

  beginGeneration({ path, fps, windowSeconds } = {}) {
    try {
      generationCounters[this.leg] = (generationCounters[this.leg] || 0) + 1;
      const id = generationCounters[this.leg];
      const gen = this.leg === 'sound'
        ? new SoundGeneration(this, id, { path, windowSeconds })
        : new MotionGeneration(this, id, { path, fps });
      this.gens.push(gen);
      this.lastGen = gen;
      this.touch();
      return gen;
    } catch {
      this.period.warn += 1;
      return null;
    }
  }

  touch() {
    this.lastActivityMono = this.monoNow();
    this.period.active = true;
  }

  // Every receipt samples wall - mono (R1-F5). A jump over WALL_STEP_MS opens a new epoch and is handed to
  // every open generation, which subtracts it from the PTS it has yet to see (R2-O3). Smaller movement is
  // NTP slewing and is tracked in place.
  noteReceipt(mono, wall) {
    const offset = wall - mono;
    const step = offset - this.lastOffset;
    this.lastOffset = offset;
    if (Math.abs(step) > WALL_STEP_MS) {
      this.epochs.push({ startMono: mono, offset });
      if (this.epochs.length > 64) this.epochs.shift();
      this.period.wallSteps += 1;
      for (const g of this.gens) if (g.open) g.addWallStep(mono, step);
      if (this.period.wallStepLogs < WALL_STEP_LOG_MAX) {
        this.period.wallStepLogs += 1;
        // A WALL-STEP, never a gap: the host clock moved, the camera did not stop.
        this.log(`[obs] "${this.label}" ${this.leg} WALL-STEP ${step > 0 ? '+' : ''}${Math.round(step)}ms (host clock stepped; not a gap)`);
      }
    } else {
      this.epochs[this.epochs.length - 1].offset = offset;
    }
  }

  offsetAt(mono) {
    for (let i = this.epochs.length - 1; i >= 0; i -= 1) {
      if (this.epochs[i].startMono <= mono) return this.epochs[i].offset;
    }
    return this.epochs[0].offset;
  }

  // RESTART discontinuities (R1-F1). The interval (N's last observation, N+1's first) is UNKNOWN. It is
  // PROVISIONAL until every earlier generation has closed (R3-4): a stop resolves on 'exit', so N can still
  // deliver samples after N+1 has started, and a late N sample must move the start of the interval, not be
  // lost. Committed once all earlier generations are closed and N+1 has finalized its first observation.
  tryCommitRestarts() {
    for (let i = 0; i < this.gens.length; i += 1) {
      const g = this.gens[i];
      if (g.restartCommitted || g.firstObsMono === null) continue;
      const priors = this.gens.slice(0, i);
      if (!priors.every((p) => p.closed)) continue;
      let lo = this.prevLastObsMono;
      let reason = this.prevCloseReason;
      let code = this.prevCloseCode;
      for (const p of priors) {
        if (p.lastObsMono !== null && (lo === null || p.lastObsMono > lo)) lo = p.lastObsMono;
        reason = p.closeReason;
        code = p.closeCode;
      }
      g.restartCommitted = true;
      if (lo !== null && g.firstObsMono > lo) {
        this.period.restarts += 1;
        this.period.restartMs += g.firstObsMono - lo;
        g.restartInfo = { lo, hi: g.firstObsMono, reason, code };
      }
    }
    // ★ A CLOSED generation at the front of the list is folded into the continuity state and dropped (fix
    // round 1, F2). This is exact, not an approximation: a closed generation's lastObsMono and close reason
    // are final (end() finalizes everything first); every later commit takes the MAX of prev* and its priors'
    // last observations, and the reason of the LAST prior (or prev* when none are left), so folding the front
    // in list order gives the same interval and reason as keeping it; and it is already committed or never
    // observed (the loop above just committed every generation whose priors are all closed). Phase A folded
    // only once gens[1] had committed, and a generation that never observes never commits — so ONE failed
    // launch between two good ones stopped all folding, and the list climbed to GENS_MAX before the cap
    // cleared it (found by the surviving mutant M-R1-18 in this round; pinned by the F2 "one failed launch
    // between two good ones" test). Only the FRONT folds, because a closed generation behind an open one
    // must keep its place: the reason passed on is the last one in launch order.
    while (this.gens.length && this.gens[0].closed) this.foldGen(this.gens.shift());
    this.pruneEmptyGens();
  }

  foldGen(p) {
    if (p.lastObsMono !== null && (this.prevLastObsMono === null || p.lastObsMono > this.prevLastObsMono)) {
      this.prevLastObsMono = p.lastObsMono;
    }
    this.prevCloseReason = p.closeReason;
    this.prevCloseCode = p.closeCode;
  }

  // ★ BOUNDED (fix round 1, F2 — Codex review). Closed generations at the FRONT already fold (above). What
  // is left is an OPEN generation that never exits (a hung process) with launches failing behind it: those
  // cannot fold past it. A closed generation that never observed anything adds no time to any RESTART
  // interval; the only thing it can pass on is its close reason, and only if it is the LAST generation
  // before the next one that observes. So one directly followed by another closed, empty generation is
  // dropped (the later one carries the newer reason) — exact. Without this, a camera that is offline and
  // relaunches every ~5 s behind a hung generation grows the list by ~17,000 a day, and every commit scans
  // all of it.
  //
  // ★ The GENS_MAX backstop NEVER folds or drops an OPEN generation (fix round 2, G1 — Codex and Opus
  // reviews). Fix round 1's backstop folded whatever was at the front, which past 16 generations is the
  // open one: its last observation was frozen where it stood (its later ones lost), its null close reason
  // overwrote the continuity reason, it stopped receiving wall steps (noteReceipt hands them only to
  // generations in the list), and it vanished from isIdle(), so the clock could be idle-evicted with a
  // process still running — and every interval behind it committed at once, dropping R3-4's rule that an
  // interval stays provisional while an earlier generation is open. Now, past the cap, the oldest CLOSED
  // generation that never observed is dropped: it adds no time to any interval, and the only thing lost is
  // its close reason, which only the next generation's RESTART would have named (a backstop's stated
  // inexactness). If none is left, nothing is dropped: what remains are open generations (bounded by how
  // many processes really run at once) and observing ones behind an open one, which R3-4 needs until it
  // closes. No real path to more than a handful is known: Node emits 'close' after every 'exit', even
  // after a spawn error (checked by the Opus review on Node 24).
  pruneEmptyGens() {
    const empty = (g) => g.closed && g.firstObsMono === null && g.lastObsMono === null;
    for (let i = this.gens.length - 2; i >= 0; i -= 1) {
      if (empty(this.gens[i]) && empty(this.gens[i + 1])) this.gens.splice(i, 1);
    }
    while (this.gens.length > GENS_MAX) {
      const i = this.gens.findIndex(empty);
      if (i < 0) break;
      this.gens.splice(i, 1);
    }
  }

  addCoverage(kind, lo, hi) {
    (kind === 'analysis' ? this.analysis : this.sampler).add(lo, hi);
  }

  isIdle(now = this.monoNow()) {
    return !this.gens.some((g) => g.open) && now - this.lastActivityMono >= IDLE_EVICT_MS;
  }

  // Taken only by the idle sweep, i.e. with no generation open (isIdle) — and every closed generation has
  // already folded into prev* as it closed (tryCommitRestarts, fix round 1 F2), so the continuity state IS
  // the tombstone. Phase A walked the generation list here; after F2 that walk could no longer run with
  // anything in the list (test:core showed its lines newly uncovered), so it was removed rather than kept as
  // dead code. Pinned by R3-5 (the interval AND the close reason carried across an eviction).
  tombstone() {
    return { lastObsMono: this.prevLastObsMono, lastReason: this.prevCloseReason, lastCode: this.prevCloseCode };
  }

  // Every memory-bearing structure's size, for the bounded-growth test (observation-clock-growth.test.js)
  // and for anyone debugging a long-running install. Cheap: counts only. TOTALS over every generation the
  // clock still holds — the list, plus the last one begun, which `lastGen` keeps (for the `[obs]` line's
  // gen/path/side) after it has folded out of the list. Fix round 1 reported the per-generation maximum and
  // missed that one (fix round 2, G1, Codex review), so memory held by several generations read as one's.
  sizes() {
    const held = this.lastGen && !this.gens.includes(this.lastGen) ? [...this.gens, this.lastGen] : this.gens;
    const out = {
      gens: held.length, epochs: this.epochs.length, sampler: this.sampler.iv.length,
      analysis: this.analysis.iv.length, ages: this.period.ages.length,
    };
    for (const g of held) {
      for (const [k, v] of Object.entries(g.sizes())) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  }

  hasSomethingToReport() {
    return this.period.active || this.gens.some((g) => g.open);
  }

  // The current period's figures. Coverage is measured over [periodStart, now - FINALIZE_MS]: nothing
  // younger than FINALIZE_MS can be final yet, so counting it would read as a coverage loss that is not one.
  summary(now = this.monoNow()) {
    const p = this.period;
    const end = now - FINALIZE_MS;
    const span = end - this.periodStart;
    const cover = (set) => (span > 0 ? Math.min(1, set.measure(this.periodStart, end) / span) : null);
    const ages = [...p.ages].sort((a, b) => a - b);
    const g = this.lastGen;
    return {
      label: this.label,
      leg: this.leg,
      gen: g ? g.id : null,
      path: g ? g.path : null,
      samples: p.samples,
      real: p.real,
      fpsClone: p.fpsClone,
      cfrDup: p.cfrDup,
      cfrDrop: p.cfrDrop,
      runsCapped: p.runsCapped,
      unknown: p.unknown,
      ambiguous: p.ambiguous,
      reordered: p.reordered,
      observed: p.observed,
      silent: p.silent,
      gaps: p.gaps,
      gapMs: p.gapMs,
      delayed: p.delayed,
      restarts: p.restarts,
      restartMs: p.restartMs,
      coverSampler: cover(this.sampler),
      coverAnalysis: cover(this.analysis),
      ageP50: quantile(ages, 0.5),
      ageP99: quantile(ages, 0.99),
      compressed: p.compressed,
      clamps: p.clamps,
      uncertain: p.uncertain,
      wallSteps: p.wallSteps,
      side: g ? g.sideState() : 'none',
      warn: p.warn,
      late: p.late,
    };
  }

  resetPeriod(now = this.monoNow()) {
    this.periodStart = Math.max(this.periodStart, now - FINALIZE_MS);
    this.period = newPeriod();
    this.sampler.prune(this.periodStart);
    this.analysis.prune(this.periodStart);
  }

  // Bookkeeping for one finalized observation.
  record(obs) {
    const p = this.period;
    p.samples += 1;
    if (obs.cls === 'real') p.real += 1;
    else if (obs.cls === 'fps-clone') p.fpsClone += 1;
    else if (obs.cls === 'cfr-clone') p.cfrDup += 1;
    else if (obs.cls === 'observed') {
      p.observed += 1;
      if (!obs.analysed) p.silent += 1;
    } else {
      p.unknown += 1;
      if (obs.reason === 'ambiguous') p.ambiguous += 1;
      if (obs.reason === 'reordered') p.reordered += 1;
    }
    if (obs.compressed) p.compressed += 1;
    if (obs.uncertain) p.uncertain += 1;
    if (obs.obsMono !== null && p.ages.length < AGE_SAMPLES_MAX) p.ages.push(obs.rxMono - obs.obsMono);
    if (this.onObservation) {
      try {
        this.onObservation(obs);
      } catch {
        p.warn += 1;
      }
    }
  }
}

// --- generation base ----------------------------------------------------------------------------------------
// One per ffmpeg launch (C3). PTS restarts at 0 on every connection, so the anchor is per generation
// (R2-O9); the clock owns only continuity, coverage and counters. The stdout and stderr handlers of a
// launch close over their OWN generation, so a late 'close' from an old process, or its late bytes, can
// never touch a newer one.
class Generation {
  constructor(clock, id, { path }) {
    this.clock = clock;
    this.id = id;
    this.path = path || null;
    this.open = true;
    this.closed = false;
    this.closeReason = null;
    this.closeCode = null;
    this.A = null;
    this.lastSrcMs = null;
    this.envelope = new MinDeque(ANCHOR_WINDOW_MS);
    // A short floor of (receipt - normalised PTS), for deciding which side of a wall step a record is on.
    this.rxFloor = new MinDeque(SOUND_REF_WINDOW_MS);
    this.steps = [];
    this.stepShift = 0; // the sum of every step already folded out of `steps` (see normalise)
    this.lastStamp = null;
    this.lastWall = null;
    this.firstObsMono = null;
    this.lastObsMono = null;
    this.restartCommitted = false;
    this.restartInfo = null;
    this.pending = [];
    this.sampleCount = 0;
    this.finalizedCount = 0;
    this.recordsSeen = 0;
    this.sideReported = false;
    this.ending = false;
  }

  // Every entry point goes through here: a throw is caught and counted, never propagated (plan §B Guards).
  guarded(fn) {
    try {
      fn();
    } catch {
      this.clock.period.warn += 1;
    }
  }

  late() {
    // A call after end() — a draining pipe, a late 'close' — is dropped and counted, and can never touch
    // another generation (C3).
    this.clock.period.late += 1;
  }

  addWallStep(T, s) {
    this.steps.push({ T, s, latched: false });
  }

  // Remove the host's KNOWN wall steps from a record's PTS (R3-3'), so a real gap that coincides with a
  // step is still judged by the normal rules: +900 step + 900 ms loss reads as 0.9 s, not 1.8 s, and a
  // -900 step + 900 ms loss (whose PTS effects cancel) still reads as 0.9 s. Inside the transcoder-lag
  // zone each record takes the side that keeps (receipt - PTS) closest to the running floor; once a
  // record is past a step, every later one is too (the transcoder stamps in order).
  //
  // ★ BOUNDED (fix round 1, F7 — Codex review). Once a record arrives past a step's lag zone AND past the
  // DTS-clamp span that follows a backward step, every later record is past it too (receipt times only
  // grow), so the step is folded into `stepShift` and leaves the list: exactly the shift the loop would
  // have added. A host clock flapping all day used to grow the list without end and make every record scan
  // all of it. The list is bounded by REAL TIME, not a count: it holds only steps noticed in the last
  // WALL_MATCH_WINDOW_MS (plus |s| for a backward step), at most one per receipt. Fix round 1 also had a
  // 64-step count backstop that folded the oldest step even inside its zone; the Codex review's 65 steps
  // noticed within one lag zone made it fold a step a record was still BEFORE, and that record came out
  // 900 ms early (fix round 2, G4). A clock stepping backward by hours at every receipt could hold hours'
  // worth of steps: no real host does, and folding one early is the wrong answer, so none is.
  normalise(rawMs, rx, prevRawMs) {
    while (this.steps.length && rx >= this.steps[0].T + WALL_MATCH_WINDOW_MS + Math.max(0, -this.steps[0].s)) {
      this.stepShift += this.steps.shift().s;
    }
    let shift = this.stepShift;
    let uncertain = false;
    for (const st of this.steps) {
      if (rx < st.T) break;
      let after = st.latched || rx >= st.T + WALL_MATCH_WINDOW_MS;
      if (!after) {
        const F = this.rxFloor.min(rx);
        if (F === null) after = true;
        else {
          const eBefore = rx - (rawMs - shift);
          const eAfter = eBefore + st.s;
          const dBefore = Math.abs(eBefore - F);
          const dAfter = Math.abs(eAfter - F);
          after = dAfter <= dBefore;
          if (Math.min(dAfter, dBefore) > WALL_MATCH_TOL_MS) uncertain = true;
        }
      }
      if (!after) break;
      st.latched = true;
      shift += st.s;
      // After a BACKWARD step the transcoder clamps DTS: near-equal PTS for |step|. Those frames' times are
      // not trustworthy, so they fall back to receipt order (plan §B, R2-O3).
      if (st.s < 0 && prevRawMs !== null && rawMs - prevRawMs <= DTS_CLAMP_MS && rx < st.T - st.s + WALL_MATCH_WINDOW_MS) {
        uncertain = true;
      }
    }
    return { ms: rawMs - shift, uncertain };
  }

  // The slewed anchor (R1-F10). Set once, at the first finalization, from the envelope that by then has
  // seen the whole startup burst; afterwards, at each stamp, it moves toward the envelope by at most
  // ANCHOR_SLEW x the SOURCE time elapsed since the previous stamp. Measuring "elapsed" in source time
  // rather than in when finalization happened to run is what makes the promise exact: two consecutive
  // stamps are spaced within +-10% of their sources' spacing, however the calls are timed.
  slewToward(now, srcMs) {
    const target = this.envelope.min(now);
    if (target !== null && this.lastSrcMs !== null) {
      const maxStep = ANCHOR_SLEW * Math.max(0, srcMs - this.lastSrcMs);
      const d = target - this.A;
      this.A += Math.max(-maxStep, Math.min(maxStep, d));
    }
    if (this.lastSrcMs === null || srcMs > this.lastSrcMs) this.lastSrcMs = srcMs;
  }

  ensureAnchor(now) {
    if (this.A !== null) return true;
    const target = this.envelope.min(now);
    if (target === null) return false;
    this.A = target;
    return true;
  }

  // obsMono = A + the source's PTS, clamped to <= receipt (causality: nothing is observed after it was
  // received) and >= the previous stamp (C4: no reorder). Both clamps are counted; the first one binding
  // is what `compressed` reports (the forced residual after a backlog longer than ANCHOR_WINDOW_MS).
  stamp(srcMs, rx, now) {
    this.slewToward(now, srcMs);
    let mono = this.A + srcMs;
    let compressed = false;
    if (mono > rx) {
      mono = rx;
      compressed = true;
    }
    if (this.lastStamp !== null && mono < this.lastStamp) {
      mono = this.lastStamp;
      this.clock.period.clamps += 1;
    }
    this.lastStamp = mono;
    // UTC from the epoch that CONTAINS the observation (R3-7), held non-decreasing within the generation:
    // after a backward step UTC waits for real time to catch up, it never goes back (R1-F5, C4).
    let wall = mono + this.clock.offsetAt(mono);
    if (this.lastWall !== null && wall < this.lastWall) wall = this.lastWall;
    this.lastWall = wall;
    return { mono, wall, compressed };
  }

  noteStamp(mono) {
    if (this.firstObsMono === null) {
      this.firstObsMono = mono;
      this.clock.tryCommitRestarts();
    }
    this.lastObsMono = mono;
  }

  finalizeDue(now, all) {
    while (this.pending.length && (all || this.pending[0].deadline <= now)) {
      const s = this.pending.shift();
      this.finalize(s, now);
      this.finalizedCount += 1;
    }
    this.checkSide();
  }

  // Side channel health (plan §A): if records stop parsing, samples are UNKNOWN, ONE line says so per
  // generation, and detection carries on untouched.
  //
  // F6 (fix round 1): "healthy" means records the clock can USE, not records that arrived. A motion `in`
  // record without its tap's `config in` time base cannot be placed in a slot, so a stream whose config
  // line was lost used to report side=ok while every sample was UNKNOWN, and never said why.
  checkSide() {
    if (this.sideReported || this.finalizedCount < SIDE_CHECK_SAMPLES || this.usable()) return;
    this.sideReported = true;
    const why = this.recordsSeen > 0 ? 'tap records arrive but cannot be used' : 'no tap records';
    this.clock.log(`[obs] "${this.clock.label}" ${this.clock.leg} gen=${this.id} side-channel unavailable (${why}); samples are reported UNKNOWN, detection is unaffected`);
  }

  usable() {
    return this.recordsSeen > 0;
  }

  sizes() {
    return {
      pending: this.pending.length, envelope: this.envelope.size(), rxFloor: this.rxFloor.size(), steps: this.steps.length,
    };
  }

  sideState() {
    if (this.usable()) return 'ok';
    return this.finalizedCount > 0 ? 'unavailable' : 'pending';
  }

  end(reason, info = {}) {
    this.guarded(() => {
      if (!this.open) return this.late();
      const now = this.clock.monoNow();
      // From here on "no later record will come" is a fact, not a guess: rules that wait for later
      // evidence decide with what they have (or say UNKNOWN).
      this.ending = true;
      this.beforeEnd(now);
      this.finalizeDue(now, true);
      this.afterEnd(now);
      this.open = false;
      this.closed = true;
      this.closeReason = reason || 'exit';
      this.closeCode = info.code ?? null;
      this.clock.touch();
      this.clock.tryCommitRestarts();
    });
  }

  beforeEnd() {}

  afterEnd() {}

  emit(obs) {
    this.clock.record(obs);
  }
}

// --- motion -------------------------------------------------------------------------------------------------
class MotionGeneration extends Generation {
  constructor(clock, id, { path, fps = 5 }) {
    super(clock, id, { path });
    this.fps = fps;
    this.tbIn = null;
    this.tbOut = null;
    this.ring = []; // `in` records, n order
    this.holes = []; // {fromN, toN, lo, hi, rx}: slots a lost `in` frame could have occupied
    this.reorderedSpans = []; // {lo, hi, rx} (R4-2)
    this.holesFloor = -Infinity; // every slot <= this is UNKNOWN('hole'): holes dropped by HOLES_MAX
    this.spansFloor = -Infinity; // every slot <= this is UNKNOWN('reordered'): spans dropped by SPANS_MAX
    // Bumped by every `in` record — the only thing that changes provenance()'s inputs (the ring, the holes,
    // the spans, their floors, the pruned-record marks). A run's cached verdict is valid while it is unchanged.
    this.provEpoch = 0;
    this.intervals = []; // consecutive `in` pairs, for gaps and the centred median
    this.lastIn = null;
    this.maxRawPts = null;
    this.maxSlotSeen = null;
    this.inTaint = false;
    this.outTaint = false;
    this.prunedMaxN = -1;
    this.prunedMaxSlot = -Infinity;
    this.outs = new Map(); // n -> out record
    this.lastOut = null;
    this.lastMatchedN = -1;
    this.resolvedN = -1; // every out record <= this is resolved (sample finalized, or passed over)
    this.prevSample = null;
    this.prevFinal = null; // the previous FINALIZED sample (for CFR-dup attribution)
    this.lastRealStamp = null;
    this.openRuns = new Set();
    this.stampBySrc = new Map(); // `in` record -> its stamp, so a clone of it repeats that stamp
    this.usableIn = 0;
    this.usableOut = 0;
  }

  slotOfIn(pts) {
    return roundNearInf(pts * this.tbIn.num * this.fps, this.tbIn.den);
  }

  slotOfOut(pts) {
    return this.tbOut ? roundNearInf(pts * this.tbOut.num * this.fps, this.tbOut.den) : pts;
  }

  onConfig({ tap, dir, tbNum, tbDen }) {
    this.guarded(() => {
      if (!this.open) return this.late();
      if (dir !== 'in' || !(tbNum > 0) || !(tbDen > 0)) return;
      if (tap === 'in') this.tbIn = { num: tbNum, den: tbDen };
      else if (tap === 'out') this.tbOut = { num: tbNum, den: tbDen };
    });
  }

  // A tap line that looked like a record and failed the grammar: its record is lost. The interval around
  // it is tainted exactly like an n-hole (plan: "an n-hole or parse error inside the interval -> UNKNOWN").
  onParseError(tap) {
    this.guarded(() => {
      if (!this.open) return this.late();
      if (tap === 'in') this.inTaint = true;
      else if (tap === 'out') this.outTaint = true;
    });
  }

  onRecord(rec) {
    this.guarded(() => {
      if (!this.open) return this.late();
      const rx = this.clock.monoNow();
      const wall = this.clock.wallNow();
      this.clock.noteReceipt(rx, wall);
      this.clock.touch();
      this.advance(rx);
      this.recordsSeen += 1;
      if (rec.tap === 'in') this.onIn(rec, rx);
      else if (rec.tap === 'out') this.onOut(rec, rx);
      this.tryMatch(rx);
    });
  }

  // Motion needs BOTH taps: `in` for provenance and time, `out` for alignment.
  usable() {
    return this.usableIn > 0 && this.usableOut > 0;
  }

  onIn(rec, rx) {
    if (!this.tbIn) return; // no `config in` line: no slot arithmetic is possible, samples stay UNKNOWN
    this.usableIn += 1;
    this.provEpoch += 1;
    const rawMs = (rec.pts * this.tbIn.num * 1000) / this.tbIn.den;
    const prev = this.lastIn;
    const { ms, uncertain } = this.normalise(rawMs, rx, prev ? prev.rawMs : null);
    // ★ The slot is computed from the RAW pts, because that is what fps sees. Normalisation is for time.
    const r = { n: rec.n, pts: rec.pts, rawMs, ms, slot: this.slotOfIn(rec.pts), rx, uncertain };

    if (prev === null) {
      // Records lost before the first one we saw could have occupied any slot up to its own.
      if (r.n > 0 || this.inTaint) this.holes.push({ fromN: -1, toN: r.n, lo: -Infinity, hi: this.slotOfIn(r.pts - 1), rx });
    } else {
      const contiguous = r.n === prev.n + 1 && !this.inTaint;
      if (!contiguous) {
        // The lost frames had pts strictly between their neighbours, so the slots they could have landed
        // in are exactly slot(prev+1 tick) .. slot(next-1 tick). A non-increasing pair is out of order
        // anyway, so take the whole span between them.
        const lo = r.pts - 1 >= prev.pts + 1 ? this.slotOfIn(prev.pts + 1) : Math.min(prev.slot, r.slot);
        const hi = r.pts - 1 >= prev.pts + 1 ? this.slotOfIn(r.pts - 1) : Math.max(prev.slot, r.slot);
        this.holes.push({ fromN: prev.n, toN: r.n, lo, hi, rx });
      } else if (!r.uncertain && !prev.uncertain) {
        this.intervals.push({ rx, deltaMs: r.ms - prev.ms, prev, next: r, evaluated: false });
      }
      // ★ R4-2 (run C): a backwards input pts makes slot membership lie about what fps emitted — fps drops
      // the frame that already claimed the later slot and re-uses the backwards frame there. No REAL/CLONE
      // claim survives from this record's slot up to the highest slot seen before it, plus one.
      if (r.pts < this.maxRawPts) this.addReorderedSpan(r.slot, this.maxSlotSeen + 1, rx);
    }
    this.inTaint = false;
    if (this.maxRawPts === null || r.pts > this.maxRawPts) this.maxRawPts = r.pts;
    if (this.maxSlotSeen === null || r.slot > this.maxSlotSeen) this.maxSlotSeen = r.slot;
    if (!r.uncertain) {
      this.envelope.push(rx, rx - r.ms);
      this.rxFloor.push(rx, rx - r.ms);
    }
    this.ring.push(r);
    this.lastIn = r;
    this.pruneRing(rx);
  }

  // Overlapping or touching spans are merged, which is exact for the only question asked of them (is slot t
  // inside any?). BOUNDED (F1 audit): one pts spike far ahead makes EVERY later record "backwards" with the
  // same upper end, and unmerged that was one new span per record that no slot ever passed.
  addReorderedSpan(lo, hi, rx) {
    const last = this.reorderedSpans[this.reorderedSpans.length - 1];
    if (last && lo <= last.hi + 1 && hi >= last.lo - 1) {
      last.lo = Math.min(last.lo, lo);
      last.hi = Math.max(last.hi, hi);
      last.rx = rx;
    } else {
      this.reorderedSpans.push({ lo, hi, rx });
    }
  }

  // The lowest output slot that can still need an `in` record: the oldest unresolved `out` record's slot,
  // or the slot after the newest `out` record (a record not received yet always has a later slot).
  minNeededSlot() {
    // No `out` record yet: nothing can be classified, and the first one normally arrives within a second.
    // Only the ring's age limit applies (F1 audit: -Infinity here kept every `in` record up to the hard
    // cap on a stream whose `out` tap never parses, and every record then scanned all of them). A first
    // `out` record arriving more than IN_RING_MS late finds its inputs gone and reads UNKNOWN, never a guess.
    if (!this.lastOut) return Infinity;
    let t = this.lastOut.slot + 1;
    for (const o of this.outs.values()) if (o.n > this.resolvedN && o.slot < t) t = o.slot;
    return t;
  }

  // ★ R4-4: the ring never prunes the CURRENT fps SOURCE — the newest record whose slot is below every slot
  // still to be classified. fps emits a stall's whole clone run only when the next input arrives, all from
  // the frame before the gap (run D), so after a stall longer than the ring, that frame is exactly the one
  // the burst needs. Anything else older than IN_RING_MS goes.
  pruneRing(now) {
    // `out` records nothing can match any more go first (F1 audit): resolved ones are pruned as samples
    // finalize, but with no samples at all (stdout stalled, or never aligning) they would stay, and every
    // unresolved one holds tMin — and with it the ring, the holes and the spans — at its slot forever.
    // ★ Timed from the record's RELEASE, not its arrival (fix round 2, H1; see OUT_RETAIN_MS): a sample is
    // written when the record AFTER it exists, which during a connected camera stall is a whole stall later.
    // A run's records share the run's release, because runClass needs every one of them until the run's
    // last sample. Release times rise in map (arrival) order — a record's successor arrives no earlier than
    // the successor of any record before it, and only the newest record or growing run is unreleased — so
    // the first one still inside its retention ends the walk.
    for (const [n, o] of this.outs) {
      const released = o.run ? o.run.releasedRx : o.releasedRx;
      if (released === null || released >= now - OUT_RETAIN_MS) break;
      this.outs.delete(n);
    }
    const tMin = this.minNeededSlot();
    let keepN = -1;
    for (let i = this.ring.length - 1; i >= 0; i -= 1) {
      if (this.ring[i].slot < tMin) {
        keepN = this.ring[i].n;
        break;
      }
    }
    const kept = [];
    for (const r of this.ring) {
      const expired = r.rx < now - IN_RING_MS && r.slot < tMin && r.n !== keepN;
      if (expired) this.notePruned(r);
      else kept.push(r);
    }
    while (kept.length > IN_RING_MAX) this.notePruned(kept.shift());
    this.ring = kept;
    this.holes = this.holes.filter((h) => h.hi >= tMin || h.rx >= now - IN_RING_MS);
    this.reorderedSpans = this.reorderedSpans.filter((s) => s.hi >= tMin || s.rx >= now - IN_RING_MS);
    // BOUNDED (fix round 2, H1): see HOLES_MAX. The oldest goes, and its upper slot becomes a floor that
    // provenance() treats as still inside it, so the answer can only get more conservative.
    while (this.holes.length > HOLES_MAX) this.holesFloor = Math.max(this.holesFloor, this.holes.shift().hi);
    while (this.reorderedSpans.length > SPANS_MAX) this.spansFloor = Math.max(this.spansFloor, this.reorderedSpans.shift().hi);
    const cutoff = now - 2 * FINALIZE_MS - IN_RING_MS;
    while (this.intervals.length && this.intervals[0].evaluated && this.intervals[0].rx < cutoff) this.intervals.shift();
  }

  notePruned(r) {
    if (r.n > this.prunedMaxN) this.prunedMaxN = r.n;
    if (r.slot > this.prunedMaxSlot) this.prunedMaxSlot = r.slot;
  }

  onOut(rec, rx) {
    if (typeof rec.checksum !== 'number') return;
    this.usableOut += 1;
    const prev = this.lastOut;
    const o = {
      n: rec.n, slot: this.slotOfOut(rec.pts), checksum: rec.checksum, rx,
      // A first record with n > 0 means the ones before it were lost, exactly as for `in` records (fix round
      // 2, H5: the ground-truth fuzzer's seed 526 lost out record 0 of a static pair, and its sample was
      // claimed REAL of the wrong source, the next one a CFR repeat).
      holeBefore: this.outTaint || (prev === null ? rec.n > 0 : rec.n !== prev.n + 1),
      matched: null, passed: false, run: null,
      releasedRx: null, // when the record after it arrived (see OUT_RETAIN_MS)
    };
    this.outTaint = false;
    // ★ Identical-content runs are conservative from the start (R1-F2, R3-2): whenever consecutive `out`
    // records share a checksum, content alignment cannot say which sample is which record, and a
    // balancing dup+drop is invisible. Every sample attributed into the run is UNKNOWN (ambiguous), and the
    // run reports only NET dup/drop. Measured cost: identical scaled frames ~1 in 9,000 (Q5, day and night).
    if (prev && !o.holeBefore && prev.checksum === o.checksum) {
      // holeBefore / holeAfter: an `out` record was lost just before the run's first record / just before the
      // record after its last (fix round 2, H5; see runClass).
      o.run = prev.run || {
        records: 1, samples: 0, labelledDups: 0, ambiguous: false, closed: false, firstN: prev.n, lastN: prev.n, releasedRx: null,
        holeBefore: prev.holeBefore, holeAfter: false, verdict: null, // verdict: runClass's cached answer (H3)
      };
      if (!prev.run) {
        prev.run = o.run;
        this.openRuns.add(o.run);
        // BOUNDED (fix round 1, F3): a run closes when a sample lands after it, so while alignment is
        // failing (samples that never match) runs only ever open. Past the cap the oldest is closed now —
        // WITHOUT a net dup/drop: its samples have usually not arrived yet, so "samples - records" would read
        // every record as a drop and nothing would revise it (fix round 2, G2, Codex review: fix round 1
        // counted it, and its own F3 test asserted the fabricated 1,999). It is counted in `runsCapped`.
        if (this.openRuns.size > OPEN_RUNS_MAX) this.closeRun(this.openRuns.values().next().value, { capped: true });
      }
      o.run.records += 1;
      o.run.lastN = o.n;
    }
    // This record RELEASES the one before it (the CFR stage now writes that one's frame), and, if it did not
    // extend the previous record's run, that whole run (fix round 2, H1; see OUT_RETAIN_MS).
    if (prev) {
      prev.releasedRx = rx;
      if (prev.run && prev.run !== o.run) {
        prev.run.releasedRx = rx;
        prev.run.holeAfter = o.holeBefore;
      }
    }
    this.outs.set(o.n, o);
    this.lastOut = o;
    // Resolved records are pruned as samples finalize; this cap only binds if samples stop while records
    // keep coming, and dropping the oldest can only turn an answer into UNKNOWN, never into a wrong one.
    if (this.outs.size > IN_RING_MAX) this.outs.delete(this.outs.keys().next().value);
  }

  onSample(bytes, rxMono, rxWall) {
    this.guarded(() => {
      if (!this.open) return this.late();
      this.clock.noteReceipt(rxMono, rxWall);
      this.clock.touch();
      this.advance(rxMono);
      const s = {
        idx: this.sampleCount,
        adler: adler32(bytes),
        bytes,
        rx: rxMono,
        rxWall,
        deadline: rxMono + FINALIZE_MS,
        // A byte-identical repeat of the previous sample: a CFR dup, or the next record of an
        // identical-content run. Never matched by content; decided at finalization (R3-3).
        equalPrev: this.prevSample !== null && this.prevSample.bytes.length === bytes.length && this.prevSample.bytes.equals(bytes),
        matched: null,
        gaveUp: false,
      };
      this.sampleCount += 1;
      if (this.prevSample) this.prevSample.bytes = null; // only the newest sample's bytes are ever compared
      this.prevSample = s;
      this.pending.push(s);
      this.tryMatch(rxMono);
    });
  }

  advance(now) {
    this.evaluateGaps(now);
    this.finalizeDue(now, false);
  }

  // Content alignment (plan §B step 4): each sample matches the OLDEST unmatched `out` record with its
  // checksum, in n order. Receipt order cannot do this: the CFR stage holds frame k until k+1 arrives, so
  // a CFR dup early in a generation shifts an ordinal mapping by one for the rest of it (measured in 5 of
  // 6 day runs). A record that arrives after its sample counts only within PENDING_MS (R1-F3).
  tryMatch(now) {
    for (const s of this.pending) {
      if (s.matched || s.gaveUp || s.equalPrev) continue;
      let found = null;
      for (const o of this.outs.values()) {
        if (o.n <= this.lastMatchedN || o.matched || o.passed || o.checksum !== s.adler) continue;
        if (o.rx > s.rx + PENDING_MS) continue;
        if (!found || o.n < found.n) found = o;
      }
      if (found) {
        s.matched = found;
        found.matched = s;
        // Records passed over by this match were produced by fps and never written: CFR drops. Inside an
        // identical-content run they are the run's business (net counts); across an n-hole, unknowable.
        // (Walked over the map, not over the n range: after a long spell with no matches the range can be
        // hundreds of thousands of numbers wide while the map holds a few seconds' records.)
        for (const o of this.outs.values()) {
          if (o.n >= found.n) break;
          if (o.n <= this.lastMatchedN) continue;
          o.passed = true;
          if (!o.run && !o.holeBefore && !found.holeBefore) this.clock.period.cfrDrop += 1;
        }
        this.lastMatchedN = found.n;
      } else if (now > s.rx + PENDING_MS) {
        s.gaveUp = true; // its record never came: UNKNOWN at finalization, and it no longer blocks the queue
      } else {
        break; // FIFO: a later sample may not jump ahead of one still waiting for its record
      }
    }
  }

  // Motion gaps (R2-O7, R3-6): consecutive `in` records (n contiguous) further apart than
  // max(MOTION_GAP_S, GAP_FACTOR x the CENTRED median input interval). Decided FINALIZE_MS after the later
  // record, so the median sees both sides and a rate change reads as a rate change.
  //
  // ★ "Centred" means BOTH SIDES, each on its own: the threshold uses the larger of the median interval in
  // the FINALIZE_MS before the candidate and the median in the FINALIZE_MS after it. A median pooled over
  // both sides is decided by COUNT, and a fast stream has many more intervals: 5 s at 15 fps (75) outvotes
  // 5 s at 2 fps (10), so the first ~3.8 s of a 15 -> 2 fps switch would read as a run of gaps — the exact
  // case R3-6 exists to prevent (observation-clock.test.js pins it). A real outage inside a steady stream
  // has the same rate on both sides, so it is judged against that rate either way.
  gapThreshold(rx) {
    const before = [];
    const after = [];
    for (const iv of this.intervals) {
      if (iv.rx >= rx - FINALIZE_MS && iv.rx < rx) before.push(iv.deltaMs);
      else if (iv.rx > rx && iv.rx <= rx + FINALIZE_MS) after.push(iv.deltaMs);
    }
    const med = Math.max(median(before) ?? 0, median(after) ?? 0);
    return Math.max(MOTION_GAP_S * 1000, GAP_FACTOR * med);
  }

  evaluateGaps(now) {
    for (const iv of this.intervals) {
      if (iv.evaluated) continue;
      if (iv.rx + FINALIZE_MS > now && !this.ending) break;
      iv.evaluated = true;
      iv.next.threshold = this.gapThreshold(iv.rx);
      if (iv.deltaMs > iv.next.threshold) {
        this.clock.period.gaps += 1;
        this.clock.period.gapMs += iv.deltaMs;
      }
    }
  }

  beforeEnd(now) {
    this.evaluateGaps(now);
  }

  // ★ SLOT-ONLY PROVENANCE (plan v4 decision A, revised by Round 3 R4-1..R4-4; the oracle is
  // fixtures/obs/fps-slot-*.err, real ffmpeg 8.1.2). For output slot t, checked in this order:
  //   reordered (R4-2) -> a hole could have held slot t (R1-F12) -> REAL, from the LATEST `in` frame whose
  //   own slot is t (R4-1: fps replaces an earlier frame in a slot with a later one; it does NOT prefer the
  //   nearest, run E) -> CLONE-FPS from the newest earlier frame, but only with POSITIVE evidence that slot
  //   t had no input: a later record with slot > t, n contiguous (R4-3; without it — the stream ended, or
  //   the final record was lost — UNKNOWN, because fps DOES emit the last frame at EOF, run B).
  provenance(t) {
    if (t <= this.spansFloor) return { cls: 'unknown', reason: 'reordered' };
    for (const sp of this.reorderedSpans) if (t >= sp.lo && t <= sp.hi) return { cls: 'unknown', reason: 'reordered' };
    if (t <= this.holesFloor) return { cls: 'unknown', reason: 'hole' };
    for (const h of this.holes) if (t >= h.lo && t <= h.hi) return { cls: 'unknown', reason: 'hole' };
    let real = null;
    let src = null;
    for (let i = this.ring.length - 1; i >= 0; i -= 1) {
      const r = this.ring[i];
      if (real === null && r.slot === t) real = r;
      if (src === null && r.slot < t) src = r;
      if (real && src) break;
    }
    const cand = real || src;
    // R4-4 defensive: a pruned record newer than the candidate, in a slot at or below t, would have been
    // the real source. Never guess.
    if (!cand || (this.prunedMaxN > cand.n && this.prunedMaxSlot <= t)) return { cls: 'unknown', reason: 'no-source' };
    // ★ POSITIVE EVIDENCE (R4-3). fps emits slot t from the latest frame with slot <= t, and only a LATER
    // record (slot > t, n contiguous) proves nothing else arrived for slot t. Without it — the stream
    // ended, or its last records were lost — a CLONE-FPS claim could be a real frame we never saw, and a
    // REAL claim could name the wrong frame of the slot (run B: n5 and n6 BOTH round into slot 3, so a
    // lost n6 record would leave "REAL from n5" when the output was n6). Both are UNKNOWN. In a live stream
    // the later record is always there (it is what made fps emit slot t), so this costs the one sample fps
    // flushes at the end of a generation.
    // "n contiguous between them" is already enforced above, and precisely: a hole between the candidate
    // and that later record could only matter if its lost frames could have landed in slot t, and every
    // hole whose slot range reaches t has returned UNKNOWN before this point.
    const after = this.ring.find((r) => r.n > cand.n && r.slot > t);
    if (!after) return { cls: 'unknown', reason: real ? 'source-unproven' : 'clone-unproven' };
    return real ? { cls: 'real', src: real } : { cls: 'fps-clone', src };
  }

  // provenance() for many slots at once — answer for answer the same as slots.map((t) => this.provenance(t))
  // (observation-clock.test.js pins the equivalence over varied states) — in one pass over the ring instead
  // of one per slot: O(R log R + S log R) for R ring records and S slots, where one-by-one is O(R x S). Fix
  // round 2, H3 (Astra review): runClass asks about EVERY member of a run for every sample attributed to it,
  // and since H1 keeps a run's records until it ends, a frozen picture holds up to 4,000 of each.
  //   REAL   = the LATEST record whose slot is t: the last index per slot;
  //   source = the LATEST record whose slot is below t: the highest index among the records sorted by slot
  //            below t (a prefix maximum, found by binary search);
  //   after  = any record with a higher n and a slot above t. The ring is in `n` order (records are pushed
  //            as they arrive, and showinfo numbers frames in order), so "higher n" is "later index", and
  //            the question is whether the largest slot after the candidate's index exceeds t.
  provenanceMany(slots) {
    const ring = this.ring;
    const R = ring.length;
    const lastAt = new Map();
    for (let i = 0; i < R; i += 1) lastAt.set(ring[i].slot, i);
    const bySlot = Array.from({ length: R }, (_, i) => i).sort((a, b) => ring[a].slot - ring[b].slot);
    const prefMax = new Array(R);
    let best = -1;
    for (let k = 0; k < R; k += 1) {
      if (bySlot[k] > best) best = bySlot[k];
      prefMax[k] = best;
    }
    const sufMax = new Array(R + 1);
    sufMax[R] = -Infinity;
    for (let i = R - 1; i >= 0; i -= 1) sufMax[i] = Math.max(sufMax[i + 1], ring[i].slot);
    const spans = mergedIntervals(this.reorderedSpans);
    const holes = mergedIntervals(this.holes);
    return slots.map((t) => {
      if (t <= this.spansFloor || inIntervals(spans, t)) return { cls: 'unknown', reason: 'reordered' };
      if (t <= this.holesFloor || inIntervals(holes, t)) return { cls: 'unknown', reason: 'hole' };
      const ri = lastAt.get(t);
      let lo = 0;
      let hi = R;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ring[bySlot[mid]].slot < t) lo = mid + 1;
        else hi = mid;
      }
      const si = lo > 0 ? prefMax[lo - 1] : -1;
      const real = ri === undefined ? null : ring[ri];
      const src = si < 0 ? null : ring[si];
      const cand = real || src;
      if (!cand || (this.prunedMaxN > cand.n && this.prunedMaxSlot <= t)) return { cls: 'unknown', reason: 'no-source' };
      if (!(sufMax[(real ? ri : si) + 1] > t)) return { cls: 'unknown', reason: real ? 'source-unproven' : 'clone-unproven' };
      return real ? { cls: 'real', src: real } : { cls: 'fps-clone', src };
    });
  }

  // ★ IDENTICAL-CONTENT RUNS (R1-F2, R3-2), and the one narrowing this build made to them. A run whose
  // records have DIFFERENT (or unknown) sources — a static scene, where distinct frames scale to the same
  // bytes — is ambiguous: which sample is which record decides WHEN it was observed, and a balancing
  // dup+drop is invisible. But fps clones are byte-identical repeats of their source, so EVERY clone run is
  // an identical-content run; read literally, R3-2 would make every clone UNKNOWN and CLONE-FPS unreachable.
  // When every record of the run has the SAME source (a REAL frame and fps's repeats of it), no sample's
  // observed content or time is in doubt, only the repeats' labels: the first sample of the run observed
  // the source, later ones are fps repeats up to the run's record count and CFR repeats beyond it. What a
  // balancing dup+drop can still hide is the fps/CFR split of the repeats, never a REAL claim or a stamp —
  // PROVIDED no `out` record was lost beside the run (below).
  //
  // ★ A LOST RECORD BESIDE THE RUN (fix round 2, H5). A run is contiguous inside (it only grows across
  // records with no hole before them), but the Phase A rule never looked just OUTSIDE it, and the record
  // count is only the truth if nothing identical was lost at either end. The Opus review's ground-truth
  // fuzzer (the generator records each sample's true record, source and class) found 141 WRONG-SOURCE and
  // 28 CLONE-for-REAL claims in 1,229 streams, every one next to an out-record hole: record 397 lost after a
  // run of source 157, its successors identical in a static scene, so every later sample was labelled a CFR
  // repeat of 157 — two of them REAL frames of 158 and 159, stamped 0.5 s and 1.0 s before they reached the
  // server (seed 39); and a REAL frame whose own record was lost, matched by content into the following
  // clone run and labelled an fps clone (seed 135). So, as neighbourState() already does for a single record:
  //   - a hole before the run's first record, or before the record after its last: the samples in it may be
  //     the lost records' own, so nothing is labelled from the record count: UNKNOWN('out-hole');
  //   - a sample BEYOND the record count while the record after the run is not known yet (and the stream
  //     has not ended): it may be that next record's own identical content, not a CFR repeat:
  //     UNKNOWN('pending'), the reason neighbourState() gives a single record in the same position.
  // Only same-source runs are affected (a distinct-source run is already UNKNOWN, reason unchanged), and a
  // run with clean records on both sides is classified exactly as before — which includes a stall's clone
  // burst: it has a real record on both sides.
  //
  // ★ BOUNDED WORK (fix round 2, H3 — Astra review). Phase A built an array over the whole run and asked
  // provenance() about every member for EVERY sample attributed to it: after a day of a frozen picture (an
  // encoder wedged on one frame) that was ~432,000 entries per sample, quadratic overall, synchronously in the
  // detector's callback. Now, with every answer unchanged:
  //   - if the run's FIRST record is gone, some member is, and Phase A answered 'ambiguous': decided in O(1).
  //     Exact because `outs` only ever loses its oldest records (the retention walk, the count cap and
  //     pruneOuts all delete from the front) and a run's records arrived one after another;
  //   - the members' provenance comes from one pass over the ring (provenanceMany), not one per member;
  //   - the verdict is kept on the run and reused while no `in` record has arrived (provEpoch) and the run
  //     has not grown — a stall's burst finalizes its samples in one batch, so it is computed once, not once
  //     per sample.
  // What it can still cost: one recomputation per sample while `in` records keep arriving, bounded by the
  // 4,000-record caps on the run's records and on the ring.
  runClass(run) {
    if (!this.outs.has(run.firstN)) return { cls: 'unknown', reason: 'ambiguous' };
    let v = run.verdict;
    if (!v || v.epoch !== this.provEpoch || v.lastN !== run.lastN) {
      const slots = [];
      for (let n = run.firstN; n <= run.lastN; n += 1) slots.push(this.outs.get(n).slot);
      const provs = this.provenanceMany(slots);
      const src = provs[0].src;
      const same = !!src && provs.every((p, i) => p.src === src && (i === 0 || p.cls === 'fps-clone'));
      // If a member's own provenance is already UNKNOWN (reordered, a hole, no proof), that is the real
      // reason nothing in the run can be attributed, and the one `[obs]` should count.
      const unknown = same ? null : provs.find((p) => p.cls === 'unknown');
      v = { epoch: this.provEpoch, lastN: run.lastN, same, src, cls0: provs[0].cls, reason: unknown ? unknown.reason : 'ambiguous' };
      run.verdict = v;
    }
    if (!v.same) {
      run.ambiguous = true;
      return { cls: 'unknown', reason: v.reason };
    }
    const src = v.src;
    if (run.holeBefore || run.holeAfter) return { cls: 'unknown', reason: 'out-hole' };
    const pos = run.samples;
    if (pos === 0) return { cls: v.cls0, src };
    if (pos < run.lastN - run.firstN + 1) return { cls: 'fps-clone', src };
    if (run.releasedRx === null && !this.ending) return { cls: 'unknown', reason: 'pending' };
    run.labelledDups += 1;
    return { cls: 'cfr-clone', src };
  }

  // Is this record part of, or next to, content it cannot be told apart from?
  neighbourState(o) {
    if (o.run) return 'ambiguous';
    if (o.holeBefore) return 'out-hole';
    const next = this.outs.get(o.n + 1);
    // The CFR stage holds frame k until k+1 has passed it, so record k+1 is essentially always here
    // before sample k. Without it, an identical k+1 cannot be ruled out — unless the stream has ended.
    if (!next) return this.ending ? 'ok' : 'pending';
    if (next.holeBefore) return 'out-hole';
    return 'ok';
  }

  finalize(s, now) {
    const obs = {
      leg: 'motion', gen: this.id, idx: s.idx, baseline: s.idx === 0, cls: 'unknown', reason: null, src: null,
      obsMono: null, obsWall: null, bounds: null, rxMono: s.rx, rxWall: s.rxWall, compressed: false,
      uncertain: false, analysed: s.idx !== 0,
    };
    let attributed = null; // the out record whose CONTENT this sample carries
    const fromRun = (run) => {
      const rc = this.runClass(run);
      run.samples += 1;
      obs.cls = rc.cls;
      obs.reason = rc.reason || null;
      obs.src = rc.src || null;
    };
    if (s.equalPrev) {
      const P = this.prevFinal ? this.prevFinal.attributed : null;
      attributed = P;
      if (!P) obs.reason = 'unmatched';
      else if (P.run) fromRun(P.run);
      else {
        // ★ CLONE-CFR needs POSITIVE evidence, never just a timeout (R3-3): a LATER sample has already
        // matched the NEXT out record, with no hole between them. Only then can this repeat not be the
        // next record's own (identical) content.
        const next = this.outs.get(P.n + 1);
        if (next && !next.holeBefore && next.matched && next.matched !== s) {
          const pv = this.prevFinal.prov;
          if (pv && pv.src) {
            obs.cls = 'cfr-clone';
            obs.src = pv.src;
          } else obs.reason = pv ? pv.reason : 'unmatched';
        } else obs.reason = 'cfr-unproven';
      }
    } else if (s.matched) {
      attributed = s.matched;
      const ns = this.neighbourState(s.matched);
      if (ns === 'ambiguous') fromRun(s.matched.run);
      else if (ns !== 'ok') obs.reason = ns;
      else {
        const pv = this.provenance(s.matched.slot);
        obs.cls = pv.cls;
        obs.reason = pv.reason || null;
        obs.src = pv.src || null;
      }
    } else obs.reason = 'unmatched';

    // A run is closed once a sample attributed to a record AFTER it is finalized, or at generation end.
    for (const run of this.openRuns) {
      if (attributed && attributed.n > run.lastN) this.closeRun(run);
    }
    if (attributed && attributed.n > this.resolvedN) this.resolvedN = attributed.n;

    if (obs.src && this.ensureAnchor(now)) {
      obs.uncertain = obs.src.uncertain;
      const again = obs.cls !== 'real' ? this.stampBySrc.get(obs.src) : undefined;
      if (again) {
        // A clone repeats a frame that was already observed: it gets THAT observation's stamp. Re-stamping
        // it with an anchor that has slewed since would read as a reorder and be clamped, which is noise.
        obs.obsMono = again.mono;
        obs.obsWall = again.wall;
      } else {
        // A timing-uncertain source (the DTS clamp after a backward wall step) falls back to receipt order.
        const srcMs = obs.src.uncertain ? obs.src.rx - this.A : obs.src.ms;
        const st = this.stamp(srcMs, s.rx, now);
        obs.obsMono = st.mono;
        obs.obsWall = st.wall;
        obs.compressed = st.compressed;
        this.stampBySrc.set(obs.src, st);
        if (this.stampBySrc.size > 64) this.stampBySrc.delete(this.stampBySrc.keys().next().value);
      }
      obs.bounds = [obs.obsMono, obs.obsMono];
      this.noteStamp(obs.obsMono);
      if (obs.cls === 'real') this.cover(obs, obs.src);
    } else {
      if (obs.src) {
        obs.cls = 'unknown';
        obs.reason = 'no-anchor';
        obs.src = null;
      }
      // No point estimate: the honest statement is the interval it must lie in (C1, C2).
      obs.bounds = [this.lastStamp === null ? -Infinity : this.lastStamp, s.rx];
      if (obs.reason === 'ambiguous' && attributed && this.A !== null) obs.bounds = this.runBounds(attributed.run, s.rx);
    }
    if (obs.cls === 'unknown' && !obs.reason) obs.reason = 'unmatched';
    this.prevFinal = { attributed, prov: obs.src ? { src: obs.src } : { reason: obs.reason } };
    this.pruneOuts();
    this.emit(obs);
  }

  // Stamps for an ambiguous run are the bounds [first record's source time, last record's source time]
  // (R3-2): which record a sample is cannot be known, but the run's extent can.
  runBounds(run, rx) {
    const at = (n) => {
      const o = this.outs.get(n);
      const pv = o ? this.provenance(o.slot) : null;
      return pv && pv.src ? this.A + pv.src.ms : null;
    };
    const lo = at(run.firstN) ?? (this.lastStamp === null ? -Infinity : this.lastStamp);
    const hi = Math.min(rx, at(run.lastN) ?? rx);
    return [Math.min(lo, hi), hi];
  }

  // Resolved `out` records are dropped once nothing can still ask about them (a neighbour check reaches
  // one record either side; a CFR dup looks one record ahead).
  sizes() {
    return {
      ...super.sizes(), ring: this.ring.length, holes: this.holes.length, reorderedSpans: this.reorderedSpans.length,
      intervals: this.intervals.length, outs: this.outs.size, openRuns: this.openRuns.size, stampBySrc: this.stampBySrc.size,
    };
  }

  pruneOuts() {
    const keepFrom = Math.min(this.resolvedN, this.lastMatchedN) - 2;
    for (const n of this.outs.keys()) {
      if (n >= keepFrom) break;
      const o = this.outs.get(n);
      if (o.run && !o.run.closed) break;
      this.outs.delete(n);
    }
  }

  // A run reports NET dup/drop only (R3-2): a dup and a drop inside it cancel invisibly. Repeats that a
  // same-source run already labelled CLONE-CFR one by one were counted as they were finalized.
  closeRun(run, { capped = false } = {}) {
    if (run.closed) return;
    run.closed = true;
    this.openRuns.delete(run);
    // Closed early by OPEN_RUNS_MAX (G2): its true net is unknown, so it is counted as capped, not as dups or
    // drops. Samples that still arrive for it are classified as usual (a labelled CFR repeat counts as one).
    if (capped) {
      this.clock.period.runsCapped += 1;
      return;
    }
    // A lost record beside the run (H5) makes its net unknowable — some of its samples may be the lost
    // record's — so, like a drop across an n-hole (tryMatch), it is not counted either way.
    if (run.holeBefore || run.holeAfter) return;
    const net = run.samples - run.records;
    if (net > 0) this.clock.period.cfrDup += Math.max(0, net - run.labelledDups);
    else if (net < 0) this.clock.period.cfrDrop += -net;
  }

  // Sampler/analysis coverage (C5): (previous REAL source, this REAL source] when the pair is within the
  // gap threshold. The baseline adds no interval (there is nothing before it to diff against), which is
  // what "analysis excludes the baseline" amounts to for motion.
  cover(obs, src) {
    if (this.lastRealStamp !== null) {
      const threshold = src.threshold ?? this.gapThreshold(src.rx);
      if (obs.obsMono - this.lastRealStamp <= threshold) {
        this.clock.addCoverage('sampler', this.lastRealStamp, obs.obsMono);
        if (obs.analysed) this.clock.addCoverage('analysis', this.lastRealStamp, obs.obsMono);
      }
    }
    this.lastRealStamp = obs.obsMono;
  }

  afterEnd() {
    // At generation end every open identical-content run is closed. The final `out` record, if it never
    // got a sample, is the stream ending before its frame was written — NOT a CFR drop (plan v4
    // refinement 3). Trailing unmatched records are never "passed over", so they are never counted.
    //
    // ★ "Never got a sample" is judged by the run's COUNT, not by `matched` alone (fix round 3, finding (a)
    // of the fix-round-2 build, reproduced with scratch quirk-end.mjs and on the fix-round-1 module too).
    // Inside a run only the first sample is matched by content; the rest are byte repeats of it (equalPrev)
    // and never set `matched` on the record they stand for. So the final record always looked unwritten,
    // and a stream that ended inside a FULLY delivered run was docked one record: three samples for three
    // records reported one CFR dup that never happened, four reported two. The final record lacks its
    // sample only if the run has fewer samples than records; then the shortfall of one is the unwritten
    // final frame (refinement 3), and any further shortfall is a real drop. A run beside a lost record or
    // closed by the cap still counts nothing (closeRun).
    for (const run of [...this.openRuns]) {
      if (run.lastN === (this.lastOut && this.lastOut.n) && !this.lastOut.matched && run.samples < run.records) run.records -= 1;
      this.closeRun(run);
    }
  }
}

// --- sound --------------------------------------------------------------------------------------------------
// Audio carries its own SAMPLE CLOCK; its PTS is a noisy, re-stamped arrival time (the day run proves it).
// Each output window w (1,600 samples at 8 kHz) is input media [0.2w, 0.2w + 0.2) s. Its time is
// mediaTime = sampleTime + every discontinuity positioned AT OR BEFORE it (R2-O1: by position, never by
// when it was found, so a window before a gap that is still waiting to finalize does not pick it up).
class SoundGeneration extends Generation {
  constructor(clock, id, { path, windowSeconds = 0.2 }) {
    super(clock, id, { path });
    this.windowS = windowSeconds;
    // ★ BOUNDED (fix round 1, F1 — Codex review): only records from the next one to judge (`k`, or an open
    // candidate's index) onward are ever read again, so everything before is dropped. `recBase` is the
    // absolute index of records[0], so `k` and `candidate.i` stay absolute. It used to keep every record
    // of the generation: 25/s, ~2.2 million objects a day for a camera that never restarts.
    this.records = [];
    this.recBase = 0;
    this.holeRx = null; // receipt time of the first record past a hole (none of those are stored)
    this.cum = 0; // seconds of input media seen
    this.segBase = 0;
    this.segRate = null;
    this.segSamples = 0;
    this.lastRec = null;
    this.pts0Ms = null;
    this.tbFallback = false;
    this.holeAt = null; // media position of the first n-hole: every later window is UNKNOWN (R1-F11)
    this.taint = false;
    this.k = 0; // next record to process
    this.processedEnd = 0; // media seconds processed (all discontinuity decisions made up to here)
    this.cumD = 0; // ms of committed discontinuity so far
    // {pos (s), sizeMs}. BOUNDED (F1): a discontinuity positioned before every position still to be asked
    // about (the oldest unfinalized window, the next record to accept) is folded into `discFoldedMs`, which
    // every later mediaAt/mediaBefore includes in full, exactly as the list entry would have been.
    this.disc = [];
    this.discFoldedMs = 0;
    this.discCapPos = -Infinity; // media position (s) of the last discontinuity folded early by DISC_MAX (H4)
    this.candidate = null;
    this.quietUntilRx = -Infinity;
    this.refFloor = new MinDeque(SOUND_REF_WINDOW_MS);
  }

  onConfig() {}

  onParseError(tap) {
    this.guarded(() => {
      if (!this.open) return this.late();
      if (tap === 'audio') this.taint = true;
    });
  }

  // PTS in ms. fftools gives an audio filter a 1/sample_rate time base (fixtures/obs/sound-*.err: pts 1024
  // at 48 kHz = 0.0213333 s), so pts/rate is exact where pts_time ("%.6g") loses a digit per decade after
  // ~2.8 hours. Checked against pts_time on every record; a mismatch falls back to pts_time.
  ptsMs(rec) {
    const exact = (rec.pts / rec.rate) * 1000;
    const shown = rec.ptsTime * 1000;
    if (Number.isFinite(shown) && Math.abs(exact - shown) > Math.max(1, Math.abs(shown) * 1e-5)) {
      this.tbFallback = true;
      return shown;
    }
    return exact;
  }

  onRecord(rec) {
    this.guarded(() => {
      if (!this.open) return this.late();
      if (rec.tap !== 'audio' || !(rec.rate > 0) || !(rec.nbSamples > 0)) return;
      const rx = this.clock.monoNow();
      this.clock.noteReceipt(rx, this.clock.wallNow());
      this.clock.touch();
      this.advance(rx);
      this.recordsSeen += 1;
      const rawMs = this.ptsMs(rec);
      const prev = this.lastRec;
      const { ms, uncertain } = this.normalise(rawMs, rx, prev ? prev.rawMs : null);
      // ★ An ashowinfo n-hole makes the cumulative sample index unknowable (the lost record's sample count
      // is gone; AAC frames are 1,024 samples), so EVERY later window in this generation is UNKNOWN. No
      // resync heuristic (R1-F11). Measured hole rate with -nostats: 0 in 250k+ records.
      if (this.holeAt === null && ((prev === null && rec.n > 0) || (prev !== null && rec.n !== prev.n + 1) || this.taint)) {
        this.holeAt = this.cum;
      }
      this.taint = false;
      // Media position from INTEGER sample counts, not a running sum of nb/rate: adding 0.04 s five hundred
      // times is not 20 s in floating point, and the test that pins "exactly SOUND_GAP_S is not a gap"
      // caught the drift crossing the threshold. A rate change starts a new exact segment.
      if (rec.rate !== this.segRate) {
        this.segBase = this.cum;
        this.segRate = rec.rate;
        this.segSamples = 0;
      }
      const start = this.segBase + this.segSamples / rec.rate;
      this.segSamples += rec.nbSamples;
      const r = { n: rec.n, rawMs, ms, rx, start, dur: rec.nbSamples / rec.rate, uncertain };
      if (this.pts0Ms === null) this.pts0Ms = ms;
      this.cum = this.segBase + this.segSamples / rec.rate;
      this.lastRec = r;
      // A record past a hole is never judged (see process()), so it is not kept: only the receipt time
      // of the first one matters, to know whether an open candidate's recover window reached the hole.
      if (this.pastHole(r)) {
        if (this.holeRx === null) this.holeRx = rx;
      } else {
        this.records.push(r);
      }
      this.process(rx);
      this.trimRecords();
      this.foldDisc();
    });
  }

  sizes() {
    return { ...super.sizes(), records: this.records.length, disc: this.disc.length, refFloor: this.refFloor.size() };
  }

  recCount() {
    return this.recBase + this.records.length;
  }

  recAt(i) {
    return this.records[i - this.recBase];
  }

  // Drop records no rule can read again: everything before `k`. (An open candidate always sits AT `k`: `k`
  // does not move while one is open.) Sliced in batches so the cost is amortised O(1) per record.
  trimRecords() {
    const drop = this.k - this.recBase;
    if (drop >= 256 || (drop > 0 && drop * 2 >= this.records.length)) {
      this.records = this.records.slice(drop);
      this.recBase = this.k;
    }
  }

  // The oldest position anyone can still ask mediaAt/mediaBefore about: the oldest window not yet
  // finalized (windows are finalized in order and later ones start later), or the next record to accept.
  foldDisc() {
    if (!this.disc.length) return;
    const oldestWindow = (this.pending.length ? this.pending[0].idx : this.sampleCount) * this.windowS;
    const nextRecord = this.k < this.recCount() ? this.recAt(this.k).start : this.cum;
    const limit = Math.min(oldestWindow, nextRecord) - POS_EPS;
    while (this.disc.length && this.disc[0].pos < limit) this.discFoldedMs += this.disc.shift().sizeMs;
    // BOUNDED (fix round 2, H4): with no samples arriving, `oldestWindow` never moves, so nothing above folds
    // and the list grew by one per discontinuity for the generation's life. Past DISC_MAX the oldest folds now.
    // That is still exact for RECORDS (every folded one lies before the next record to judge) but not for a
    // window that starts before it — its end time would include it, or its span would lose the cut — so the
    // position is remembered and such a window is reported UNKNOWN (finalize).
    while (this.disc.length > DISC_MAX) {
      const d = this.disc.shift();
      this.discFoldedMs += d.sizeMs;
      if (d.pos > this.discCapPos) this.discCapPos = d.pos;
    }
  }

  // Media time, ms, of the sample AT input position `pos` (s): every discontinuity positioned at or before
  // it has already happened (R2-O1). A discontinuity sits at the start of the record that showed it.
  mediaAt(pos) {
    let d = this.discFoldedMs;
    for (const x of this.disc) if (x.pos <= pos + POS_EPS) d += x.sizeMs;
    return pos * 1000 + d;
  }

  // ...and of the instant JUST BEFORE `pos`: the end of a window or record that stops exactly where a
  // discontinuity starts does not include it.
  mediaBefore(pos) {
    let d = this.discFoldedMs;
    for (const x of this.disc) if (x.pos < pos - POS_EPS) d += x.sizeMs;
    return pos * 1000 + d;
  }

  excess(r) {
    return r.ms - (this.pts0Ms + r.start * 1000 + this.cumD);
  }

  // ★ DISCONTINUITIES (plan §B Sound). excess = PTS - (genStartPts + mediaTime). A candidate is a record
  // whose excess sits more than SOUND_GAP_S above the REFERENCE floor (the minimum over the
  // SOUND_REF_WINDOW_MS of media before it, R2-O2); it becomes a discontinuity only if the minimum over the
  // following SOUND_RECOVER_MS of receipt time is STILL that high. The day run's +268 ms clump came back to
  // ~0 in 8 packets: `delayed`, not a gap. A real loss and a sustained lossless backlog produce identical
  // records (the transcoder's wall-clock re-stamp erases the camera's media clock), so a discontinuity is
  // UNKNOWN, "lost or held" — never asserted as a loss (R1-F6).
  //
  // ★ After an n-hole NOTHING past it is judged (R1-F11). Every record after a lost one sits a whole lost
  // record's worth of samples too EARLY on the sample clock, so its excess reads high and the floor rule
  // would report a phantom discontinuity for every hole. Found by replaying the Stage 1 soak run
  // (fixtures/obs/soak-drop-hold.json, recorded before -nostats, 98 holes in 685 records): 22 phantom
  // "gaps" before this guard, 0 after. A candidate whose recover window reaches past a hole cannot be
  // judged either; it stays undecided and its windows are UNKNOWN.
  process(now) {
    for (;;) {
      if (this.candidate) {
        const c = this.candidate;
        // The recover window is complete once time has passed its end: any record still to come was
        // received after it. At generation end an undecided candidate stays undecided (its windows are
        // reported UNKNOWN) rather than being forced either way.
        if (!(now > c.rec.rx + SOUND_RECOVER_MS)) return;
        let floorAfter = Infinity;
        let complete = false;
        for (let j = c.i; j < this.recCount(); j += 1) {
          const r = this.recAt(j);
          if (r.rx > c.rec.rx + SOUND_RECOVER_MS) {
            complete = true;
            break;
          }
          floorAfter = Math.min(floorAfter, this.excess(r));
        }
        // Records past a hole are not kept; if the first of them arrived inside this recover window, the
        // window reaches the hole and cannot be judged.
        if (!complete && this.holeRx !== null && this.holeRx <= c.rec.rx + SOUND_RECOVER_MS) return;
        if (floorAfter - c.ref > SOUND_GAP_S * 1000) {
          const sizeMs = floorAfter - c.ref;
          this.disc.push({ pos: c.rec.start, sizeMs });
          this.cumD += sizeMs;
          this.clock.period.gaps += 1;
          this.clock.period.gapMs += sizeMs;
        } else {
          this.clock.period.delayed += 1;
          // One episode, one count: the rest of this recover window belongs to the clump just judged, and
          // must not be re-judged record by record against the same reference.
          this.quietUntilRx = c.rec.rx + SOUND_RECOVER_MS;
        }
        this.candidate = null;
        this.k = c.i;
        this.accept(c.rec);
        this.k = c.i + 1;
        continue;
      }
      if (this.k >= this.recCount()) return;
      const r = this.recAt(this.k);
      const ref = this.refFloor.min(r.start * 1000);
      const quiet = r.rx <= this.quietUntilRx;
      if (ref !== null && !r.uncertain && !quiet && this.excess(r) - ref > SOUND_DELAY_REPORT_S * 1000) {
        this.candidate = { i: this.k, rec: r, ref };
        continue;
      }
      this.accept(r);
      this.k += 1;
    }
  }

  pastHole(r) {
    return this.holeAt !== null && r.start >= this.holeAt - POS_EPS;
  }

  accept(r) {
    const e = this.excess(r);
    this.refFloor.push(r.start * 1000, e);
    if (!r.uncertain) {
      // The anchor: receipt minus the media time of the record's END (R1-F4: mediaTime already includes
      // discontinuities, so a gap is never counted twice).
      this.envelope.push(r.rx, r.rx - (this.pts0Ms + this.mediaBefore(r.start + r.dur)));
      this.rxFloor.push(r.rx, r.rx - r.ms);
    }
    this.processedEnd = r.start + r.dur;
  }

  onSample(bytes, rxMono, rxWall, { analysed = true } = {}) {
    this.guarded(() => {
      if (!this.open) return this.late();
      this.clock.noteReceipt(rxMono, rxWall);
      this.clock.touch();
      this.advance(rxMono);
      this.pending.push({ idx: this.sampleCount, rx: rxMono, rxWall, deadline: rxMono + FINALIZE_MS, analysed: !!analysed });
      this.sampleCount += 1;
      this.foldDisc();
    });
  }

  advance(now) {
    if (this.recCount()) this.process(now);
    this.finalizeDue(now, false);
  }

  beforeEnd(now) {
    if (this.recCount()) this.process(now);
  }

  finalize(s, now) {
    const start = s.idx * this.windowS;
    const end = start + this.windowS;
    const obs = {
      leg: 'sound', gen: this.id, idx: s.idx, cls: 'unknown', reason: null, obsMono: null, obsWall: null,
      bounds: null, spans: null, rxMono: s.rx, rxWall: s.rxWall, analysed: s.analysed, compressed: false,
      uncertain: false,
    };
    if (this.holeAt !== null && end > this.holeAt + POS_EPS) obs.reason = 'hole';
    else if (this.candidate && this.candidate.rec.start < end - POS_EPS) obs.reason = 'undecided';
    else if (this.processedEnd < end - POS_EPS || this.pts0Ms === null) obs.reason = 'no-record';
    else if (start < this.discCapPos - POS_EPS) obs.reason = 'disc-capped';
    else if (!this.ensureAnchor(now)) obs.reason = 'no-anchor';
    else {
      // The window is stamped at its END, the newest sound it contains.
      const endMs = this.pts0Ms + this.mediaBefore(end);
      const st = this.stamp(endMs, s.rx, now);
      obs.cls = 'observed';
      obs.obsMono = st.mono;
      obs.obsWall = st.wall;
      obs.compressed = st.compressed;
      obs.bounds = [st.mono, st.mono];
      // ★ A window straddling a discontinuity carries TWO spans (C5), not one fake contiguous interval:
      // its samples on either side are real, the time between them is not.
      const cuts = this.disc.filter((d) => d.pos > start + POS_EPS && d.pos < end - POS_EPS).map((d) => d.pos);
      const points = [start, ...cuts, end];
      const shift = st.mono - endMs; // the anchor plus any clamp, applied to the whole window
      obs.spans = [];
      for (let i = 0; i < points.length - 1; i += 1) {
        const lo = this.pts0Ms + this.mediaAt(points[i]) + shift;
        const hi = this.pts0Ms + this.mediaBefore(points[i + 1]) + shift;
        obs.spans.push([lo, hi]);
        this.clock.addCoverage('sampler', lo, hi);
        // Sampler vs analysis coverage (C5): a digitally silent window was SAMPLED but never analysed
        // (soundDetector.js ignores a non-finite level), so it counts only for the first.
        if (s.analysed) this.clock.addCoverage('analysis', lo, hi);
      }
      this.noteStamp(st.mono);
    }
    if (obs.obsMono === null) obs.bounds = [this.lastStamp === null ? -Infinity : this.lastStamp, s.rx];
    this.emit(obs);
  }
}

// --- the [obs] line -----------------------------------------------------------------------------------------
const pct = (v) => (v === null ? '?' : `${(v * 100).toFixed(1)}%`);
const ms = (v) => (v === null ? '?' : `${Math.round(v)}`);
const secs = (v) => `${(v / 1000).toFixed(1)}s`;

// Every field is documented in KNOWN-ISSUES.md ("The `[obs]` line"). Pure, so the test can pin the format.
export function formatSummaryLine(s) {
  const head = `[obs] "${s.label}" ${s.leg} gen=${s.gen ?? '-'} path=${s.path ?? '-'} samples=${s.samples}`;
  const legPart = s.leg === 'sound'
    ? `observed=${s.observed} silent=${s.silent} unknown=${s.unknown} gaps=${s.gaps}/${secs(s.gapMs)} delayed=${s.delayed}`
    : `real=${s.real} fpsClone=${s.fpsClone} cfrDup=${s.cfrDup} cfrDrop=${s.cfrDrop} runsCapped=${s.runsCapped} unknown=${s.unknown} ` +
      `ambiguous=${s.ambiguous} reordered=${s.reordered} gaps=${s.gaps}/${secs(s.gapMs)}`;
  return `${head} ${legPart} restarts=${s.restarts}/${secs(s.restartMs)} ` +
    `cover=${pct(s.coverSampler)}/${pct(s.coverAnalysis)} age p50/p99=${ms(s.ageP50)}/${ms(s.ageP99)}ms ` +
    `compressed=${s.compressed} clamps=${s.clamps} uncertain=${s.uncertain} wallSteps=${s.wallSteps} ` +
    `side=${s.side} warn=${s.warn} late=${s.late}`;
}
