// Pure decision rules for the bed-boundary detector. No imports, deliberately: `motionDetector.js`
// pulls in ffmpeg, MediaMTX and the alert stack, so anything that lives there is unreachable from a
// unit test — which is how the exit rule below stayed unable to see a child climbing out unaided for
// months without a single test going red. Rules that can be stated as a function belong here.

// --- What counts as "the bed moved" / "the outside moved" (#368) ---
//
// The per-frame test the tracker reads: a frame is ACTIVE in a channel when the changed fraction of that
// channel's pixels is at least this. Every window and rule below (the link windows, the confirm quiet times,
// the 120 s pauses, OOB_SLOW_OUT_MIN) was calibrated with the detector classifying frames at THIS number.
//
// WHERE 0.011898989898989899 CAME FROM: it is the value `activeFractionThreshold(90)` in motionDetector.js
// returns (0.002 + 0.098 * 10/99, about 1.19 % of the zone). Before #368 the tracker used whatever the motion
// ALERT sensitivity gave, so the number was whatever the owner had set the slider to. The saved configuration of
// all four cameras in the prod and staging snapshots of 2026-10-03/04 is sensitivity 90, and none of the 4295
// stored `bed_transitions` rows has a peak below 0.012 (the rounding of 1.19 %, stored to 0.001): consistent with
// every transition having been recorded at 1.19 %. Sensitivity HISTORY is not stored, so "ran at 90 throughout"
// is an inference from the current config and the stored peaks, not a proof. It reproduces the pre-#368
// decision bit for bit on those cameras (same double, same `>=`), so nothing this house recorded moves.
//
// WHAT IT IS NOT: not derived from a room (frames are not stored, only per-minute samples, so there is nothing
// to derive from), not validated outside one house, and not the sleep side's MOTION_ACTIVE (0.01) or
// MOTION_OUT_ACTIVE (0.03), which are separate numbers and untouched. A literal on purpose, not a call to
// `activeFractionThreshold(90)`: this issue is about removing the coupling between the alert curve and the
// transition evidence, and a shared function would let a later edit of the alert curve move the transitions
// again without anyone deciding to. motionDetector.test.js pins the literal AND (in a separate assertion that
// says so) the equality with the alert curve at 90; if the curve changes, edit that assertion on purpose,
// never re-couple.
//
// WHO IT CHANGES (stated, not guessed): an install NOT at sensitivity 90 ran the old tracker at its own
// threshold (the default, 50, is 5.15 %). At any sensitivity below 90 this number is LOWER: movements the old
// threshold ignored now count, which can add exits and entries AND can cancel a pending exit (a small stir of
// 1-5 % of the zone, a mattress settling, now cancels it, exactly as in the calibrated house: by design, it is
// bed movement), so the totals can move in either direction (traced: at 50 a 6 % bed burst + 6 % outside burst
// + a later 2 % bed frame used to confirm an exit and now cancels it and opens an entry). Above 90 (up to
// 100 = 0.2 %) it is HIGHER, and transitions can move in either direction (the cancel paths). Whether that is
// better for those installs' reported sleep is NOT known; nobody has measured one. At the default threshold
// OOB_SLOW_OUT_MIN (5 %) was inert (an active outside frame was already >= 5.15 %); at this one it is a real
// filter. A household that quieted a noisy room by lowering the sensitivity loses that lever for transitions
// (it still works for alerts); the remedy is the zone. KNOWN-ISSUES.md says all of this to the person running it.
export const BED_TRANSITION_ACTIVE_FRACTION = 0.011898989898989899;

// --- "Out of bed": how long after the bed last moved may an outside burst still be the same body? ---
//
// TWO windows, because the two ways a body leaves a bed do not look alike:
//
//   - An adult LIFTING a child out is one continuous movement, so the bed and the area beside it are in
//     motion within a few hundred milliseconds of each other. Every confirmed exit in the production
//     logs links in 190-620 ms, comfortably inside the fast window.
//   - A child climbing out HIMSELF shakes the bed, then stands on the floor, and only moves across the
//     room some seconds later. Nothing bridges that pause. Prod, 2026-08-28: Renz was out at 05:52 (bed
//     0.050, outside quiet), moving around the room by 05:53 (outside 0.104, bed quiet) and gone by
//     05:55 — no candidate was ever opened, and with no departure to corroborate the empty-bed gap his
//     wake was reported as 07:14 instead of 05:52.
//
// The slow window is therefore allowed, but only for a substantial outside burst. That floor is what
// keeps it from admitting noise, and it is measured rather than guessed: across 10.7 days of retained
// samples on both cameras the "bed active, then outside-only the next minute" shape occurs four times —
// three at outside 0.010-0.012 with nobody in either room, and one at 0.104, the real exit above. 0.05
// separates those two populations with a wide margin on both sides.
export const OOB_LINK_MS = 8000; // bed active within this long before the outside burst = a lift-out
export const OOB_LINK_SLOW_MS = 60000; // ...or this long, if the outside burst is big enough to be a body
export const OOB_SLOW_OUT_MIN = 0.05; // outside changed-fraction required to use the slow window

// Which link window (if any) lets this outside burst be read as motion that LEFT the bed.
// Returns 'fast' | 'slow' | null.
export function oobLinkKind(sinceMs, outFraction) {
  if (sinceMs <= OOB_LINK_MS) return 'fast';
  if (sinceMs <= OOB_LINK_SLOW_MS && outFraction >= OOB_SLOW_OUT_MIN) return 'slow';
  return null;
}

// --- Believed occupancy, ROADMAP §1.2 item 1 ---
//
// Measured 2026-08-29: 147 of 238 stored transitions (62%) are the SAME type twice in a row for one
// camera with nothing between — two `into_bed`, or two `out_of_bed`. You cannot get into a bed you
// are already in, or leave one you are already out of, so at least one of every such pair is wrong.
//
// The obvious fix — refuse to RECORD a transition that contradicts believed occupancy — looked like
// the cheapest win in the whole classifier, but a retrospective check against real owner-verdicted
// transitions (2026-09-12, both environments) found it is NOT SAFE to actually gate on yet: a same-
// direction repeat only proves at least one of the pair is wrong, never which one, and this rule
// always kept whichever confirmed FIRST. When a false transition slips through — which the item 2
// peak/verdict measurement the same day showed happens on the clear majority of out_of_bed events —
// it poisons belief and silently drops every REAL same-direction event after it, until an opposite-
// direction transition happens to reset it. Confirmed happening for real: on Renz's actual
// 2026-09-11 night, a false 04:26 exit would have caused the genuine 06:34 wake to be the one
// discarded, not the false one. 22 owner-verdicted-CORRECT transitions across both environments would
// have been wrongly dropped by an unconditional version of this rule.
//
// So for now these two functions are used to FLAG a same-direction repeat in the live log trace, not
// to suppress it — every transition is still recorded exactly as it was before item 1 existed. See
// motionDetector.js's call sites. Revisit gating once item 2's evidence-based threshold reduces the
// false-transition rate, or once a rule exists for which of a same-direction pair to trust (a "keep
// the last, not the first" retrospective check fixed 19 of the 22 cases found above, but requires
// either deleting an already-recorded — sometimes human-labelled — row, or not actually reducing the
// impossible-pair count at all; not attempted here).
//
// `believed` is `true` (in bed) / `false` (out of bed) / `null` (not yet known — this detector
// hasn't confirmed a transition since it started, so there is nothing yet to contradict). `null`
// NEVER flags: it would be worse to invent a starting belief than to flag the first transition
// unchecked, and — deliberately — this does NOT try to seed belief from the last row already stored
// in `bed_transitions` at startup either. A detector restart happens far less often than a real
// transition (deploys, per-camera settings changes), so the STORED occupancy is already what item 1
// exists to be skeptical of — simpler and safer to start genuinely blank each run.
export function intoBedRejected(believed) {
  return believed === true;
}
export function outOfBedRejected(believed) {
  return believed === false;
}

// --- Unexplained bed activity, found 2026-09-13 while reviewing a real night ---
//
// The exit side has always logged a "near miss" when the bed goes active but no outside burst links
// closely enough to call it a departure (see OOB_NEARMISS_MS in motionDetector.js). The entry side had
// no equivalent: when the bed goes active with nothing linkable on the outside channel, NOTHING is
// logged at all. That is exactly what happened to Renz's real 2026-09-12 bedtime on staging — the
// whole ~50-minute settling window produced zero `into_bed` and zero trace of why, because a missed
// entry has always been completely silent.
//
// A time bound like OOB_NEARMISS_MS doesn't fit here: unlike an exit (a one-off event), a child who IS
// believed to be in bed keeps moving in it all night, and that ordinary stirring would re-trigger this
// diagnostic every rate-limit interval for hours for no reason. `believedOccupied` (item 1, above)
// already distinguishes "we don't currently think anyone's in this bed" from "the child everyone
// already knows is there just rolled over" — so gate on that instead of a clock.
export function entryNearMissWorthLogging(believed) {
  return believed !== true;
}

// --- Quick reversals (into_bed immediately undone by out_of_bed), ROADMAP §1.2 item 3 -------------
//
// Measured 2026-09-13: 86 of 1053 stored transitions (~8%) are an into_bed immediately followed (same
// camera) by an out_of_bed. Checked against real data two independent ways before this was built: a
// visual snapshot sample (parent visible leaving via the door in every case anyone was visible at all,
// child lying still in every case) and the bed zone's own subsequent motion (60% of all 86 kept
// showing normal stirring in the following hour — essentially impossible if the child had left).
// Matches the owner's own theory: a goodnight kiss reads as bed-active-then-outside-quiet, exactly
// this shape, with no child movement involved. See bedTransitions.js's getQuickReversals and
// bed-transition-classifier-flaws.md for the full evidence.
//
// Shared by two callers with different needs — getQuickReversals (the whole-table diagnostic, wants a
// cross-camera newest-first order and a limit) and the morning review (wants only "does THIS night
// have one, and which transitions", no ordering opinion) — so the pairing rule itself lives here,
// pure and tested, and each caller does its own presentation on top.
//
// Takes rows in ANY order (not necessarily pre-sorted or single-camera) since a night's transitions
// come back ordered by time across ALL of a child's cameras, not grouped by camera first — grouping
// and sorting within each camera happens here, not at each call site.
export function findQuickReversals(transitions, { maxGapMs = 60000 } = {}) {
  const byCamera = new Map();
  for (const t of transitions) {
    if (!byCamera.has(t.camera_id)) byCamera.set(t.camera_id, []);
    byCamera.get(t.camera_id).push(t);
  }
  const out = [];
  for (const rows of byCamera.values()) {
    rows.sort((x, y) => (x.created_at === y.created_at ? x.id - y.id : x.created_at < y.created_at ? -1 : 1));
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i];
      const b = rows[i + 1];
      if (a.type !== 'into_bed' || b.type !== 'out_of_bed') continue;
      const gapMs = Date.parse(`${b.created_at.replace(' ', 'T')}Z`) - Date.parse(`${a.created_at.replace(' ', 'T')}Z`);
      if (gapMs > maxGapMs) continue;
      out.push({ into_bed: a, out_of_bed: b, gap_ms: gapMs });
    }
  }
  return out;
}

// --- Lingering bed motion after ANY out_of_bed, generalized from findQuickReversals above ----------
//
// findQuickReversals' own comment documents the SECOND, independent check that validated it (measured
// 2026-09-13): the bed zone's own motion_peak in activity_samples in the hour AFTER a quick reversal's
// trailing out_of_bed kept showing normal stirring (motion_peak > MOTION_ACTIVE, sleepAnalysis.js's own
// calibrated per-minute test) in 60% of all 86 cases — essentially impossible if the bed were actually
// empty. Only 9/86 went fully silent, the one signature consistent with a real departure (the exact
// figures live in planning/ROADMAP.md's item-3 history, not repeated in bedTransitions.js's own code
// comment — cite the ROADMAP, not this file, if re-checking them). That check never actually depended
// on the quick-reversal SHAPE (an into_bed right before the out_of_bed) — it only used the out_of_bed's
// own trailing hour — so it generalizes MECHANICALLY to every out_of_bed on record, not just the ~8%
// that happen to be quick reversals. Whether it generalizes STATISTICALLY (the quick-reversal work also
// leaned on an independent visual sample this broader population doesn't have) is exactly what this is
// Phase 1 to find out — see getLingeringBedMotion's own comment and the mandatory measurement step in
// the plan this shipped from before trusting any flag-rate claim about the general population.
//
// Duplicated from sleepAnalysis.js's MOTION_ACTIVE (0.01) rather than imported: this file takes no
// imports, deliberately (see the top of file), and importing sleepAnalysis.js here would also create an
// import cycle — sleepAnalysis.js already imports bedTransitions.js, which imports this file. (The
// REVERSE direction — moving MOTION_ACTIVE's definition into this file and having sleepAnalysis.js
// import it from here — would be cycle-free and would remove the duplication, but that touches
// sleepAnalysis.js, out of scope for a diagnostic-only change; considered and deliberately deferred.)
// A test asserts these two stay equal, so a future re-measurement of one without the other is caught
// rather than silently drifting.
export const LINGERING_MOTION_ACTIVE = 0.01;

// The "hour after" from the 2026-09-13 measurement above, not a new guess — named the same way maxGapMs
// is above, so a future re-measurement moves one constant instead of a scattered literal.
export const LINGERING_WINDOW_MS = 60 * 60 * 1000;

// planning/ROADMAP.md reports "4+ active minutes" (60% of 86) and "fully silent" (9/86) — it does NOT
// report a distribution across 1/2/3/4+, so 4 is the bucket that measurement happened to report, not a
// threshold independently shown to separate two populations the way OOB_SLOW_OUT_MIN was. Reusing it
// anyway because it's the only real number on record, and because a single-minute threshold is worse
// for a documented, independent reason: a departure's own motion spills into the bucket immediately
// AFTER the exit's own minute for a large share of exits, which would defeat the "exclude the exit's own
// minute" guard below by itself. When this was written the cause was activityTracker.js's flush phase (a
// plain 60 s setInterval from process start, not aligned to wall-clock minutes), which moved a
// departure's motion into the next bucket for roughly HALF of all exits. Since #447 a bucket is the
// minute its samples were RECEIVED, so that lottery is gone, but the spill is not: an exit confirmed late
// in its minute still has its departure movement (the seconds after the confirming frame) in the next
// one. Requiring 4+ DISTINCT minutes (see findLingeringBedMotion's own de-duplication comment —
// activity_samples has no uniqueness constraint on camera_id+bucket_start, so "distinct" matters, not
// just "4+ rows") means neither one spilled bucket, nor several duplicate rows for it, can ever trigger
// a flag alone. If this number is ever re-measured (e.g. via the yield/false-positive measurement this
// ships needing — see bedTransitions.js), move it here, not a new literal.
export const LINGERING_MIN_ACTIVE_MINUTES = 4;

// activity_samples.bucket_start is always the exact minute (activityTracker.js's minuteBucketUtc; since #447
// the minute the samples were received in), but bed_transitions.created_at carries the real second. Floor a transition's timestamp to its own minute
// before comparing it to a bucket, or a same-minute bucket can misread relative to the transition
// depending on the transition's own seconds — see findLingeringBedMotion's own comment for exactly where
// this matters and where it doesn't.
function minuteFloor(sqlDateTime) {
  return sqlDateTime.slice(0, 17) + '00';
}

// Is there SUSTAINED bed-zone motion, after ONE out_of_bed transition, that the classifier itself still
// believes happened in an EMPTY bed? "Still believes empty" means: no into_bed recorded on the same
// camera between the exit and the qualifying minutes — an ordinary, already-corroborated return (exactly
// what detectMidnightEpisodes treats as a real short awakening) is never flagged, no matter how much
// motion follows it. "Sustained" means LINGERING_MIN_ACTIVE_MINUTES or more qualifying minutes, not one
// — see this file's own comment on that constant for why one is not enough.
//
// `exit` — one out_of_bed transition, at least { type, created_at }.
// `nextIntoBed` — the next into_bed transition ON THE SAME CAMERA after `exit`, or null/undefined if
//   none is recorded (yet). Resolved ONCE PER CAMERA by the caller (getLingeringBedMotion) — this
//   function does not search for it and does not re-check camera_id, the same trust-the-caller contract
//   as oobLinkKind/intoBedRejected above.
// `samples` — that camera's activity_samples rows, PRE-SORTED ASCENDING by bucket_start (the caller's
//   responsibility — getLingeringBedMotion's own SQL already selects in this order), each at least
//   { bucket_start, motion_peak }. Duplicate rows for the same bucket_start ARE expected (no uniqueness
//   constraint on camera_id+bucket_start — see the de-duplication comment in the loop below) and are
//   handled there, not rejected. NOT defensively re-sorted here, unlike findQuickReversals above: that
//   function sorts once per whole table; this one is called once per candidate in a loop, so a per-call
//   sort would be real, avoidable, repeated cost at this table's realistic size — trusting the caller's
//   already-correct order avoids that (a linear scan still costs something, just far less than a sort).
// `windowMs` — how far past `exit` to look; defaults to LINGERING_WINDOW_MS, the measured "hour after".
// `minActiveMinutes` — how many DISTINCT qualifying minutes are required; defaults to
//   LINGERING_MIN_ACTIVE_MINUTES.
//
// Returns null when fewer than minActiveMinutes DISTINCT minutes qualify — no samples, nothing exceeds
// the threshold enough times, or a real into_bed already closes the gap before enough accumulate —
// deliberately failing toward NOT flagging: this is a diagnostic surfacing suspicion, not a safety
// guard, so missing data must never manufacture one. Otherwise returns { out_of_bed: exit,
// active_minutes, bucket_start, motion_peak, gap_ms } — the count, and the FIRST qualifying minute's own
// detail as the earliest evidence the gap didn't close when the classifier believed it did.
export function findLingeringBedMotion(
  exit,
  nextIntoBed,
  samples,
  { windowMs = LINGERING_WINDOW_MS, minActiveMinutes = LINGERING_MIN_ACTIVE_MINUTES } = {}
) {
  if (!exit || exit.type !== 'out_of_bed') return null;
  const exitMs = Date.parse(`${exit.created_at.replace(' ', 'T')}Z`);
  // Floored: see the file-level comment on minuteFloor. NOT needed on the exit side below — a bucket in
  // exit's own minute always has bucket_start <= exit.created_at as a plain string compare, since its
  // seconds are forced to ':00'.
  const boundary = nextIntoBed ? minuteFloor(nextIntoBed.created_at) : null;

  let count = 0;
  let first = null;
  // Collapse consecutive same-bucket_start rows into ONE minute, OR-merged (qualifies if ANY row for
  // that minute does) — the same convention sleepAnalysis.js itself already uses for duplicate buckets
  // (state[i] = state[i] === null ? active : state[i] || active), not a new rule invented here. Without
  // this, several duplicate rows for a single spilled minute would satisfy the 4-minute threshold
  // alone — silently defeating the exact guarantee that threshold exists to provide (found in review,
  // 2026-09-14, citing sleepAnalysis.test.js's own "a duplicate activity_samples row for the same
  // minute must not erase real movement" fixture as proof duplicates are real, not hypothetical).
  let curBucket = null;
  let curQualifies = false;
  let curFirst = null;
  const closeBucket = () => {
    if (curBucket !== null && curQualifies) {
      count++;
      if (!first) first = curFirst;
    }
  };
  for (const s of samples || []) {
    if (s.bucket_start <= exit.created_at) continue; // the exit's own minute — its own departure movement
    if (boundary !== null && s.bucket_start >= boundary) break; // a real return is already recorded
    const bucketMs = Date.parse(`${s.bucket_start.replace(' ', 'T')}Z`);
    if (bucketMs - exitMs > windowMs) break; // past the fixed lookahead; samples ascend, nothing later qualifies
    if (s.bucket_start !== curBucket) {
      closeBucket();
      curBucket = s.bucket_start;
      curQualifies = false;
      curFirst = null;
    }
    if (!curQualifies && s.motion_peak != null && s.motion_peak > LINGERING_MOTION_ACTIVE) {
      curQualifies = true;
      curFirst = { bucket_start: s.bucket_start, motion_peak: s.motion_peak, gap_ms: bucketMs - exitMs };
    }
  }
  closeBucket(); // the last minute in range never got a chance to close inside the loop
  if (count < minActiveMinutes) return null;
  return { out_of_bed: exit, active_minutes: count, ...first };
}

// Shared by the full-table diagnostic and the morning review's bounded per-night query.
// Samples must already ascend by bucket_start within each camera. Return unsorted flags;
// ordering and limits belong to the caller, just as they do for findQuickReversals.
// boundaryTypeByCamera is optional: a bounded caller supplies the last type before its fetch
// boundary so an incomplete leading run cannot be evaluated against the wrong oldest exit.
export function findAllLingeringBedMotion(
  transitions,
  samplesByCamera,
  { windowMs, minActiveMinutes, boundaryTypeByCamera } = {}
) {
  const transitionsByCamera = new Map();
  for (const t of transitions) {
    if (!transitionsByCamera.has(t.camera_id)) transitionsByCamera.set(t.camera_id, []);
    transitionsByCamera.get(t.camera_id).push(t);
  }

  const out = [];
  for (const [cameraId, rows] of transitionsByCamera) {
    const sorted = rows.slice().sort((a, b) => (a.created_at === b.created_at ? a.id - b.id : a.created_at < b.created_at ? -1 : 1));
    // Already ascending by bucket_start from the caller — findLingeringBedMotion trusts this and
    // does not re-sort per call (plan-review finding 3: a per-call sort measured ~1.35s at realistic
    // data volumes since this runs once per out_of_bed candidate, not once per table).
    const camSamples = samplesByCamera.get(cameraId) || [];

    let nextIntoBed = null;
    // The NEWEST out_of_bed seen so far in the run we're currently scanning backward through — this is
    // what gets REPORTED (the transition id a human/UI would actually look up), even though evaluation
    // below is anchored at the run's OLDEST member. Reset to null on every into_bed and after every
    // evaluated run.
    let newestInRun = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const row = sorted[i];
      if (row.type === 'into_bed') { nextIntoBed = row; newestInRun = null; continue; }
      if (row.type === 'out_of_bed') {
        const isRunEnd = i === sorted.length - 1 || sorted[i + 1].type !== 'out_of_bed';
        if (isRunEnd) newestInRun = row;
        // Evaluate once we reach the run's OLDEST member, not its newest. A same-direction repeat
        // doesn't represent a new departure (see nextIntoBed's own reasoning above) — the bed has been
        // believed-unoccupied since the OLDEST exit in the run, so that is the real "own minute" to
        // exclude and the real point the lookahead window should start from. Anchoring at the newest
        // member instead (the original version of this code) made findLingeringBedMotion's window start
        // AFTER the newest exit's own timestamp, so any qualifying motion between an earlier run member
        // and the next one was never in range of ANY evaluated call — not deduplicated, silently LOST.
        // Found by an adversarial pre-merge review (Codex + a parallel Claude subagent, both
        // independently reproduced it), 2026-09-14, before this PR merged.
        const isRunStart = i === 0 || sorted[i - 1].type !== 'out_of_bed';
        // A bounded fetch can cut through a run whose true oldest exit is unknown. Treating
        // its first visible exit as a fresh anchor can FABRICATE a flag (10:00 exit, 18:00
        // repeat, motion only at 18:01-18:04). Suppress that leading run; the whole-table
        // caller omits this map and keeps its original behavior. Plan review, 2026-09-14.
        const continuesBoundaryRun = i === 0 && boundaryTypeByCamera?.get(cameraId) === 'out_of_bed';
        if (continuesBoundaryRun) continue;
        if (isRunStart) {
          const flagged = findLingeringBedMotion(row, nextIntoBed, camSamples, { windowMs, minActiveMinutes });
          if (flagged) out.push({ ...flagged, out_of_bed: newestInRun });
          newestInRun = null;
        }
      }
    }
  }

  return out;
}

// --- Outside-channel EVIDENCE (peak + duration), ROADMAP §1.2 item 2 ---
//
// The fast link above accepts a single frame over threshold with no minimum magnitude at all
// (Renz, 2026-09-11: a 5.7% one-frame burst during ordinary boundary jitter, followed by 6s of bed
// quiet, was enough — see bed-transition-classifier-flaws.md). The obvious fix is a magnitude floor,
// but it doesn't work: querying every owner-reviewed transition against its stored `peak`
// (2026-09-12, 468 verdicted rows) shows the peak of a REAL exit/entry and a FALSE one occupy almost
// the same range on both directions (out_of_bed correct 1.3-16.4%, wrong 1.2-31.1%; into_bed correct
// 1.4-17.5%, wrong 1.2-33.4% — "wrong" has the higher ceiling on both). No peak threshold, however
// chosen, would meaningfully separate them.
//
// Duration is the piece nobody has ever recorded, so it can't be evaluated retroactively the way
// peak just was above — this primitive exists to start recording it. It is intentionally NOT used to
// reject anything yet: picking a duration floor today would be exactly the guess this file's own
// calibrated constants (OOB_SLOW_OUT_MIN, OOB_LINK_SLOW_MS) were built to avoid. See ROADMAP §1.2
// item 2 for the plan to pick one once real data exists.
//
// One accumulator serves both directions: out_of_bed needs the outside channel's peak+duration
// DURING the exit candidate (forward-looking from candidate-open); into_bed needs the outside
// channel's peak+duration in the LEAD-UP before the bed moved (the outside channel is expected to be
// quiet by the time an into_bed candidate is even open, so that evidence has to be captured live, as
// it happens, not reconstructed afterward). Both are the same shape: accumulate a peak (every frame,
// matching the existing oobPeakOut behavior) and a count of frames that crossed the active threshold
// (the duration signal), across some span, reset when the channel goes quiet for a grace period.
export const EMPTY_EVIDENCE = Object.freeze({ peak: 0, frames: 0 });

export function accumulateOutEvidence(prev, fraction, active) {
  return { peak: Math.max(prev.peak, fraction), frames: prev.frames + (active ? 1 : 0) };
}

// The into_bed lead-up evidence is a ROLLING WINDOW, not an accumulate-until-quiet episode — a first
// draft tried the latter (reset only after a quiet gap longer than IB_LINK_MS) and adversarial review
// (2026-09-12) found it unbounded in practice: ordinary pauses while someone moves around a room —
// adjusting a blanket, stepping back and forward — are routinely UNDER an 8-second gap, so bursts
// chain into one open-ended episode with no upper bound on how far back it reaches. The into_bed
// candidate itself only ever cares whether the outside channel was active within IB_LINK_MS of now
// (see its own open condition) — so the evidence should reflect exactly that same window, no more.
//
// `trimOutSamples` keeps only the samples still inside `windowMs` of `now`; `evidenceFromSamples`
// reduces whatever remains with the same accumulator used everywhere else. At the fixed 5fps sampling
// rate an 8-second window is at most ~40 samples — trivial to keep live per camera.
export function trimOutSamples(samples, nowMs, windowMs) {
  return samples.filter((s) => nowMs - s.t <= windowMs);
}

export function evidenceFromSamples(samples) {
  return samples.reduce((e, s) => accumulateOutEvidence(e, s.fraction, s.active), EMPTY_EVIDENCE);
}

// --- Frame-arrival gaps: a confirmation must not span a sampling outage (issue #452) -----------------
//
// Both confirmations (a motion ALERT after `detect_confirm_s`, and a bed transition after its 6 s of
// quiet) used to measure ELAPSED WALL-CLOCK TIME since a candidate began, never how much video was
// actually received in that time. Two acceptance criteria came out of that:
//   (a) active frame, long pause, active frame is NOT proof of motion sustained through the pause;
//   (b) one quiet frame right after a long gap cannot by itself prove several seconds of quiet.
// Verified by running the tracker before the fix: 5.8 s of quiet, a 60 s hole, then ONE quiet frame
// confirmed an exit.
//
// What a stall looks like to the detector (KNOWN-ISSUES.md, "A stalled camera's repeated pictures"): the
// motion leg's `fps=5` repeats the last picture to fill a stall, and ffmpeg only writes a picture once
// the NEXT one exists, so Node sees NO stdout frames for N seconds and then a CLUMP of frames that share
// one receipt time. The clump's first frame is the held pre-stall picture; the next new picture is the
// one that differs across the outage. This helper tells the caller "the frame you just got arrived after
// a gap", and the caller restarts whatever it was timing. It is a pure, stateful, synchronous closure
// (the same shape as soundBaseline.js's analyser) and does not read the observation clock: that clock
// proves clones ~5 s after the frame (inside the 6 s bed window) and is documented as absent or
// throwing-safe, so a decision that must hold for everyone cannot wait on it.
//
// ★ THE BOUND IS ADAPTIVE WITH A FLOOR: gapBoundMs = max(floorMs, factor x typicalIntervalMs).
//   - `floorMs` (the caller passes ACTIVE_GRACE_MS, 1500 ms): the repo already defines "a motion run has
//     not ended" as gaps no longer than that, so a normal camera gets no new number.
//   - Why not the floor alone (plan review round 1, Opus, HIGH): a camera slower than ~0.67 fps delivers
//     its frames in bursts more than 1.5 s apart, so EVERY burst would count as a gap and a motion alert
//     (confirm > 0) or a bed transition could never confirm at all, a regression from the code before this
//     one, where such a stream works. At 5 fps (200 ms) the bound stays at the 1500 ms floor
//     (5 x 200 = 1000), so this house is unchanged; at 0.5 fps (2 s) it is 10 s, so a real 20 s stall still
//     counts and a 6 s hole does not.
//   - `typicalIntervalMs` is taken from the last `windowN` (16) inter-frame deltas that exceed `minDeltaMs`
//     (50). Deltas inside a clump are ~0 and would drag the typical interval to nothing (and the bound
//     back to the floor on exactly the camera that needs the wider one), so they are not recorded.
//     ★ It is 0 (so the floor ALONE governs) until the window holds K = floor(windowN / 2) + 1 = 9 recorded
//     deltas, and from then on it is the K-th LARGEST recorded delta. For a full window of 16 that IS the
//     lower median (sorted[7]); for 9 to 15 held it is sorted[n - 9], i.e. at least 9 recorded deltas must
//     be at least that long, so FEWER THAN 9 LONG DELTAS (a stall, or a few) CAN NEVER LIFT THE BOUND.
//     K is derived from windowN, not typed in. Why not simply the median of whatever the window holds
//     (code review round 1, Codex and Opus, VERIFIED BY RUNNING): right after a launch the window holds one
//     or two deltas, so ONE stall IS the median and widens the bound for the very next frame. Frames at
//     0 / 20 s / 50 s: the 20 s delta became the median, the 30 s delta was judged against a 100 s bound, and
//     a single quiet frame after a 30 s outage confirmed an exit; a motion alert run active at 200 ms,
//     2200 ms and 9200 ms alerted once. Reading nothing until K deltas are held closes that.
//     ★ A delta that WAS a gap IS recorded (a build-time deviation from plan v2, which excluded it so that
//     "a stall cannot inflate its own bound"): excluded, the window could never learn a slow camera. A
//     camera that starts at 2 s per burst, or slows from 15 fps to 2 fps, has every one of its deltas flagged
//     as a gap against the 1500 ms floor, so none would ever be recorded and every burst would restart every
//     confirmation for the life of the stream, the starvation this adaptive bound exists to prevent. The
//     protection against a stall inflating its own bound is the K threshold above instead.
//     COST, reasoned and NOT measured (simulated with realistic clumps in review round 2): a cold slow camera
//     (2 s cadence from the first frame of a detector launch) needs ~9 slow intervals before the bound widens,
//     so its first ~9 bursts each restart a pending confirmation or motion run. A candidate pending in the
//     first ~18 s after the (re)launch therefore confirms at about LAUNCH + 24 s whatever its own open time
//     (open at 4 s: 20 s later, 7 restarts; 10 s: 14 s, 4; 16 s: 8 s, 1; 20 s or later: 6 s, none), and
//     sustained motion on such a camera alerts at ~24 s instead of 6 s. It still confirms eventually, and
//     once the window has learned the camera it behaves as before.
//     ★ THE MIRROR IMAGE (known limit, pinned by a test, reasoned not measured, an owner design call): after a
//     slow phase (>= 9 recorded long deltas of S) the bound stays ~5 x S until 8 fast frames have arrived
//     (~1.6 s at 5 fps), because 9 of the last 16 deltas must be long. A stall up to 5 x S in that window is
//     NOT seen as a gap, and a quiet frame after it can confirm (13 x 5 s, 3 fast frames, a 20 s stall passes).
//     Shortening it would re-open the starvation of a slow camera. It applies equally to the motion alert.
//   - `factor` 5 mirrors observationClock.js GAP_FACTOR ("a rate change is not a run of gaps"; measured
//     worst ratio there 3.95).
// ⚠️ HONEST LIMITS: the floor, the factor, the 16-sample window and the 50 ms minimum are CHOSEN, NOT
// MEASURED. No per-gap data exists: `[obs]` measures input-PTS jumps, not Node receipt gaps. The only
// evidence is staging `[obs]` lines (428 of ~455 motion periods had no gap over 0.5 s; the bad periods had
// 7-49 gaps per 15 minutes averaging 0.6-2.1 s, in one camera's wake window), which says the rule WILL fire
// in production exactly when exits are pending. It makes a confirmation slower on a gappy camera, never
// earlier PER CANDIDATE (per stored row it can differ: a delayed confirmation can escape the wall-clock
// cooldown that would have suppressed the next one; 2 of 12,000 simulated gappy comparisons confirmed a
// second exit earlier than before, and the new rule never confirmed MORE transitions). ⚠️ It CAN make one
// impossible in practice: gaps that recur more often than once per ~6 s of received video mean a pending
// candidate rarely gets a full quiet window, and NO restart cap exists (a design decision, filed as a
// follow-up issue). For random gaps of 2-3 s arriving at lambda per second of received video the expected
// wait is (e^(6 lambda) - 1) / lambda SECONDS OF RECEIVED VIDEO: about 7 s at 3.3 gaps a minute, 38 s at 30
// a minute, 400 s at 60 a minute (wall time, which also holds the gaps: ~8 s, ~75-90 s, ~1100-1400 s). For
// another install these are a hypothesis (KNOWN-ISSUES.md).
//
// ★ A stall that ffmpeg fills with repeats AS THEY HAPPEN (arrival continuous) is NOT caught here; that
// needs the observation clock's proven clones (a separate follow-up). And this leans on #369: a clump of
// repeats drains in well under 6 s only because the detector watchdog caps a connected stall at about 75 s
// (60 s stale + a 15 s check, roughly 375 repeats).
export const FRAME_GAP_FACTOR = 5;
export const FRAME_DELTA_MIN_MS = 50;
export const FRAME_GAP_WINDOW_N = 16;

/**
 * `observe(now)` returns `null` when the frame arrived in time (or is the first one seen), otherwise
 * `{ gapMs: now - previous }`. A BACKWARD wall-clock step (`now < previous`) ALWAYS counts as a gap and
 * `gapMs` is then negative: that is conservative (the caller restarts a confirmation once and never
 * confirms early), and a caller can say "clock stepped back" from the sign. Throws if `floorMs` is not > 0,
 * so an omitted value is a caller bug and not a silently disabled fix.
 */
export function createFrameGapDetector({
  floorMs,
  factor = FRAME_GAP_FACTOR,
  minDeltaMs = FRAME_DELTA_MIN_MS,
  windowN = FRAME_GAP_WINDOW_N,
} = {}) {
  if (!(floorMs > 0)) {
    throw new Error('createFrameGapDetector requires floorMs > 0 (motionDetector.js passes its ACTIVE_GRACE_MS)');
  }
  let prev = null;
  const deltas = []; // the last windowN inter-frame deltas above minDeltaMs (clump noise left out, gaps IN)
  // How many recorded deltas must be held before they say anything about the camera's normal spacing: a strict
  // majority of the window (9 of 16). See the comment above: fewer than this and one stall would be "typical".
  const minHeld = Math.floor(windowN / 2) + 1;

  function typicalIntervalMs() {
    if (deltas.length < minHeld) return 0; // too few to trust: the floor alone governs
    const sorted = deltas.slice().sort((a, b) => a - b);
    // The minHeld-th LARGEST. A full window gives the lower median; a part-full one needs minHeld deltas at
    // least this long, so fewer long deltas than that can never lift the bound.
    return sorted[sorted.length - minHeld];
  }

  function observe(now) {
    if (prev === null) { // the first frame has nothing before it to be late after
      prev = now;
      return null;
    }
    const delta = now - prev;
    prev = now;
    const bound = Math.max(floorMs, factor * typicalIntervalMs());
    // Judged against the bound as it stood BEFORE this delta joins the window, then recorded either way.
    const isGap = delta < 0 || delta > bound;
    if (delta > minDeltaMs) {
      deltas.push(delta);
      if (deltas.length > windowN) deltas.shift();
    }
    return isGap ? { gapMs: delta } : null;
  }

  return { observe };
}
