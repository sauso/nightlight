// Pure decision rules for the bed-boundary detector. No imports, deliberately: `motionDetector.js`
// pulls in ffmpeg, MediaMTX and the alert stack, so anything that lives there is unreachable from a
// unit test — which is how the exit rule below stayed unable to see a child climbing out unaided for
// months without a single test going red. Rules that can be stated as a function belong here.

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
