// The out-of-bed / into-bed candidate state machine, extracted from motionDetector.js so it can be
// tested at all. It is pure in the sense that matters: it holds no timers, spawns nothing, and takes
// `now` as an argument, so a whole night's frame sequence can be replayed through it synchronously.
//
// ★ WHY THIS EXISTS AS ITS OWN FILE (2026-09-18): this logic shipped inside a closure in
// `startMotionDetector`'s `launch()`, unexported and therefore untestable — `motionDetector.js` is
// not in `test:core`'s include list, and the only tests that existed anywhere covered two unrelated
// pure helpers (`activeFractionThreshold`, `buildZoneMask`), never the OOB/IB branching itself. Two
// rounds of adversarial review (2026-09-18, see planning/reviews/simultaneous-activity-gap-plan-
// 2026-09-18.md) both rejected an attempted fix to ROADMAP §1.2 item 3's simultaneous-activity gap,
// and both reviews independently said the same thing: no design attempt here can be trusted without
// a real test seam. This file is that seam. It is the same shape as `soundBaseline.js`'s
// `createSoundAnalyser` — a stateful, closure-based, injectable-clock factory — not
// `bedTransitionRules.js`'s shape, because what's being extracted is inherently a per-frame state
// machine, not a set of independent pure predicates. It imports `bedTransitionRules.js`'s pure
// functions (motionDetector.js already did) but never `logger`, `db`, or anything IO-shaped — all
// logging text and `recordBedTransition`/`believedOccupied` mutation stay the caller's job.
//
// THIS COMMIT IS A PURE EXTRACTION. The OOB/IB branching below is moved VERBATIM from
// motionDetector.js — same conditions, same order, same constants, same known gap (a co-active frame
// opens no candidate on either side, and logs nothing). Do not fix that gap here; that is deliberate,
// see the file header above. A regression fixture in bedTransitionTracker.test.js proves the gap
// survives this move untouched.
//
// ★ ISSUE #452 (the one deliberate behaviour change since the extraction): a pending exit/entry used to
// confirm when `now - pendingAt >= 6000`, i.e. after 6 s of WALL-CLOCK time, so one quiet frame arriving
// after a long sampling outage "proved" 6 s of quiet that nobody observed. It now confirms after 6 s of
// quiet that was RECEIVED: a frame that arrives after a gap (see createFrameGapDetector in
// bedTransitionRules.js for what a gap is and why its bound is adaptive) restarts the quiet clock instead
// of being credited with the hole. In steady state (frames within the bound) the quiet clock starts when
// the candidate opens, exactly where it always did, so nothing changes for a healthy stream.

import {
  oobLinkKind, OOB_LINK_MS, OOB_LINK_SLOW_MS, OOB_SLOW_OUT_MIN,
  accumulateOutEvidence, trimOutSamples, evidenceFromSamples, EMPTY_EVIDENCE,
  intoBedRejected, outOfBedRejected, entryNearMissWorthLogging, createFrameGapDetector,
} from './bedTransitionRules.js';

// A rejected link is logged (rate-limited) up to this far back, so the real gap distribution stays
// measurable from the logs rather than being invisible the way the 05:52 miss was.
export const OOB_NEARMISS_MS = 180000;
export const OOB_NEARMISS_LOG_MS = 30000;
export const OOB_CONFIRM_QUIET_MS = 6000; // ...and the bed must stay quiet this long after, to count as "left"
export const OOB_COOLDOWN_MS = 120000; // don't re-log an exit more than once per this

// --- "Into bed" twin (outside -> bed transition) ---
// NOT given the slow window its twin has. The asymmetry is the point: the slow link exists for a child
// climbing out unaided, and there is no matching event on the way in — a child cannot put himself to
// bed, so an entry is always someone carrying him, which is continuous motion. Widening this side would
// only admit more of the false arrivals this detector is already prone to (see ROADMAP §1.2).
export const IB_LINK_MS = 8000; // outside must have been active within this long before the bed burst
export const IB_CONFIRM_QUIET_MS = 6000; // ...and the outside must stay quiet this long after, to count as "placed in"
export const IB_COOLDOWN_MS = 120000; // don't re-log an entry more than once per this

// Unlike OOB, the bed going active with no valid link logged NOTHING at all until now (2026-09-13) — a
// missed entry was completely silent, with no trace to diagnose it from (Child A's 2026-09-12 bedtime:
// staging never recorded an into_bed for the whole ~50min settling window, and there was nothing in the
// logs to say why — see ROADMAP §1.2 item 3). Gated on believedOccupied rather than a time bound like
// OOB_NEARMISS_MS: ordinary stirring by an already-settled, believed-in-bed child would otherwise
// re-log every rate-limit interval all night for no reason — the interesting case is specifically "the
// bed just moved and we don't think anyone's in it", which believedOccupied already tracks.
export const IB_NEARMISS_LOG_MS = 30000;

// --- Co-active diagnostic (ROADMAP §1.2 item 3, added 2026-09-18) ---
// How long to wait before logging another RESOLVED co-active episode on the same camera — purely to
// avoid flooding on a badly-drawn zone (the documented real case: a zone that includes a moving
// curtain turns co-active frames from the exception into the norm). Not calibrated against real data
// yet; a starting value in the same rate-limiting spirit as OOB_NEARMISS_LOG_MS.
// ⚠️ This CENSORS the distribution it exists to measure, and censors hardest in exactly the population
// most worth measuring: on a camera producing many short co-active episodes in a burst (the curtain
// case, or a loud pre-bedtime routine), only the first in each ~10s window is ever logged — the sample
// skews toward isolated blips. Acceptable for a first pass; a future reader of these logs should not
// assume the logged episodes are a representative sample of episode FREQUENCY, only of episode SHAPE
// (duration/quietSide/peaks) when one does get through.
export const CO_ACTIVE_LOG_COOLDOWN_MS = 10000;

/**
 * Create the per-camera bed-transition tracker.
 *
 * `pushFrame({ cribActive, outActive, fraction, outFraction }, now)` returns
 * `{ events, believedOccupied }` — `events` is a plain-data array (no logging, no side effects) of
 * everything worth telling a caller about from this one frame; `believedOccupied` is the (possibly
 * updated) belief the caller should pass back in on the NEXT call. Deliberately NOT owned by the
 * tracker itself: it must survive an ffmpeg reconnect (a new tracker instance per launch()) the way
 * every other piece of this state does NOT — see motionDetector.js's own comment on why
 * `believedOccupied` is declared outside `launch()`. The tracker treats it as a read-only input that
 * it may compute a new value for, never as something it persists across calls on its own.
 *
 * Event shapes (all plain objects, `type` plus whatever the caller needs to reproduce today's exact
 * log lines):
 *   { type: 'oob-candidate-open', link, sinceMs, outFraction }
 *   { type: 'oob-near-miss', sinceMs, outFraction }
 *   { type: 'oob-cancelled', pendingForMs }
 *   { type: 'oob-confirm-restarted', gapMs }      // #452: a frame arrived after a gap while pending; the 6 s
 *                                                 // quiet clock restarted (gapMs < 0 = the wall clock stepped back)
 *   { type: 'oob-impossible-flag' }               // ROADMAP §1.2 item 1, log-only
 *   { type: 'oob-confirmed', peak, outPeak, outFrames }
 *   { type: 'ib-candidate-open', sinceMs, fraction }
 *   { type: 'ib-near-miss', sinceMs, believedOccupied }
 *   { type: 'ib-cancelled', pendingForMs }
 *   { type: 'ib-confirm-restarted', gapMs }        // #452, the IB twin of oob-confirm-restarted
 *   { type: 'ib-impossible-flag' }                 // ROADMAP §1.2 item 1, log-only
 *   { type: 'ib-confirmed', peak, outPeak, outFrames }
 *   { type: 'co-active-episode', durationMs, quietSide, cribPeak, outPeak }   // diagnostic only
 *     `durationMs` is time from the episode's first co-active frame to the frame where AT LEAST ONE
 *     channel first reads quiet (i.e. time-to-first-quiet on whichever side resolves first) — NOT
 *     "how long both channels stayed active" in any other sense, and never less than one frame period
 *     (~200ms at 5fps) even for a single-frame blip. `quietSide` says which: 'bed', 'outside', or
 *     'both' if they happened to resolve on the same frame.
 */
export function createBedTransitionTracker({
  oobNearMissMs = OOB_NEARMISS_MS,
  oobNearMissLogMs = OOB_NEARMISS_LOG_MS,
  oobConfirmQuietMs = OOB_CONFIRM_QUIET_MS,
  oobCooldownMs = OOB_COOLDOWN_MS,
  ibLinkMs = IB_LINK_MS,
  ibConfirmQuietMs = IB_CONFIRM_QUIET_MS,
  ibCooldownMs = IB_COOLDOWN_MS,
  ibNearMissLogMs = IB_NEARMISS_LOG_MS,
  // Must match motionDetector.js's own ACTIVE_GRACE_MS — deliberately not re-declared with its own
  // default here (that constant is shared with the unrelated motion-alert confirm logic, so it stays
  // defined once, there, and is passed in). No default: an omitted value is a caller bug, not a
  // reasonable "use 1500ms" guess.
  activeGraceMs,
  // #452: the FLOOR of the frame-arrival gap bound (createFrameGapDetector in bedTransitionRules.js).
  // motionDetector.js passes its FRAME_GAP_MS (= ACTIVE_GRACE_MS, 1500). Required like activeGraceMs, and for
  // the same reason: an omitted value is a caller bug, and a default here would silently turn the fix off
  // (or tune it) for a caller that never meant to. Deliberately a separate option from activeGraceMs, which
  // answers a different question (has a motion run ended?); they are equal today by choice, not by identity.
  maxFrameGapMs,
  coActiveLogCooldownMs = CO_ACTIVE_LOG_COOLDOWN_MS,
} = {}) {
  if (!(activeGraceMs > 0)) {
    throw new Error('createBedTransitionTracker requires activeGraceMs (shared with motionDetector.js\'s ACTIVE_GRACE_MS)');
  }
  if (!(maxFrameGapMs > 0)) {
    throw new Error('createBedTransitionTracker requires maxFrameGapMs (the #452 frame-gap floor; motionDetector.js\'s FRAME_GAP_MS)');
  }
  // Owned by the tracker and fed on EVERY pushFrame (not only while a candidate is pending): the window of
  // intervals that makes the bound adaptive needs the stream's normal spacing, and a gap that happens just before a
  // candidate opens must already be known to the detector, not discovered one frame late.
  const gapDetector = createFrameGapDetector({ floorMs: maxFrameGapMs });

  // --- Out-of-bed prototype state (mirrors motionDetector.js's OOB_* constants above). ---
  let cribLastActive = 0; // last frame the bed zone itself moved
  let oobPendingAt = 0; // when a bed->outside exit candidate opened (0 = none pending)
  // #452: where the CURRENT run of received quiet starts. Equals oobPendingAt until a gap restarts it. Kept
  // apart from oobPendingAt on purpose: `oob-cancelled`'s pendingForMs must stay real wall time since the
  // candidate opened (what the log line and anyone reading it expect), and only the confirm test moves.
  let oobQuietFrom = 0;
  // Outside-channel evidence (peak + duration) accumulated across the pending candidate's life —
  // ROADMAP §1.2 item 2. Record-only for now; see accumulateOutEvidence's comment for why.
  let oobEvidence = EMPTY_EVIDENCE;
  let oobLastLog = 0;
  let oobLastNearMiss = 0; // rate-limit for the rejected-link diagnostic

  // --- Into-bed twin state (mirror of OOB with the channels swapped). ---
  let outLastActive = 0; // last frame the outside-bed area moved
  let ibPendingAt = 0; // when an outside->bed entry candidate opened (0 = none pending)
  let ibQuietFrom = 0; // #452: the IB twin of oobQuietFrom, same reasoning
  let ibPeakCrib = 0; // peak bed-fraction seen during the pending candidate
  let ibLastLog = 0;
  // Rolling buffer of recent outside-channel samples, for the into_bed lead-up evidence — the
  // "thrown away at capture time" evidence bed-transition-classifier-flaws.md's flaw #2 describes: by
  // the time an into_bed candidate opens the outside channel is already quiet (that's the open
  // condition), so its recent history has to be tracked continuously, not reconstructed afterward.
  // Trimmed to IB_LINK_MS every frame — the same window that already decides whether a candidate could
  // even link to it — so the evidence can never reach further back than what's actually relevant.
  let outSamples = [];
  let ibLeadEvidence = EMPTY_EVIDENCE; // snapshot taken from outSamples at the moment a candidate opened
  let ibLastNearMiss = 0; // rate-limit for the unexplained-bed-activity diagnostic

  // --- Co-active diagnostic state — see the constant's comment above. PURELY OBSERVATIONAL: never
  // reads or writes any of the OOB/IB state above, never influences an event's type or a candidate's
  // outcome. Exists only to measure the real distribution a future design attempt would need. ---
  let coActiveSince = 0; // 0 = no co-active episode in progress
  let coActiveCribPeak = 0;
  let coActiveOutPeak = 0;
  let coActiveLastLog = 0;

  function pushFrame({ cribActive, outActive, fraction, outFraction }, now, believedOccupied) {
    const events = [];
    let occupied = believedOccupied;

    // #452: did THIS frame arrive after a gap (null = no)? Observed first, once per frame, whether or not
    // anything is pending, so the detector's picture of the stream's spacing never has holes of its own.
    // It decides only what a pending candidate does with the frame below; it never touches candidate
    // OPENING or the links (a real exit during an outage is the case worth keeping: see KNOWN-ISSUES.md).
    const gap = gapDetector.observe(now);

    // Captured BEFORE cribLastActive updates below, for the unexplained-bed-activity diagnostic
    // further down — it needs to know whether the bed was quiet a moment ago (a fresh episode
    // starting) vs. already ongoing (the SAME episode's next frame), and reading cribLastActive after
    // the update would compare "now" against itself. Same activeGraceMs used to decide a sustained
    // motion run hasn't ended (motionDetector.js's own alert-confirm logic) — reused, not a new
    // threshold.
    const cribWasIdle = cribLastActive === 0 || now - cribLastActive > activeGraceMs;
    if (cribActive) cribLastActive = now;
    if (outActive) outLastActive = now;

    // Trim first, then append — so the buffer never holds more than IB_LINK_MS of history.
    outSamples = trimOutSamples(outSamples, now, ibLinkMs);
    outSamples.push({ t: now, fraction: outFraction, active: outActive });

    // --- OOB ---
    if (!oobPendingAt) {
      // Candidate: outside just moved, the bed moved recently but is quiet NOW → motion left the bed.
      if (outActive && !cribActive && cribLastActive > 0) {
        const sinceMs = now - cribLastActive;
        const link = oobLinkKind(sinceMs, outFraction);
        if (link) {
          oobPendingAt = now;
          oobQuietFrom = now; // #452: set at every open, so a restart in an earlier candidate can never leak into this one
          oobEvidence = accumulateOutEvidence(EMPTY_EVIDENCE, outFraction, outActive);
          events.push({ type: 'oob-candidate-open', link, sinceMs, outFraction });
        } else if (sinceMs <= oobNearMissMs && now - oobLastNearMiss >= oobNearMissLogMs) {
          oobLastNearMiss = now;
          events.push({ type: 'oob-near-miss', sinceMs, outFraction });
        }
      }
    } else {
      oobEvidence = accumulateOutEvidence(oobEvidence, outFraction, outActive);
      if (cribActive) {
        // Bed moved again inside the confirm window — child's still in it (or a parent reached in).
        // Checked BEFORE the gap branch below: activity still cancels on a frame that arrived after a gap.
        // A cancel needs no continuity (the bed visibly moved), only a confirm does.
        events.push({ type: 'oob-cancelled', pendingForMs: now - oobPendingAt });
        oobPendingAt = 0;
        oobQuietFrom = 0;
        oobEvidence = EMPTY_EVIDENCE;
      } else if (gap) {
        // ★ #452: this quiet frame arrived after a gap, so it proves nothing about the hole before it.
        // RESET, not suspend and not cancel (plan review round 1, Codex and Opus agreed):
        //   - cancel would lose a real exit whose outside motion ended during the outage (a quiet frame
        //     cannot reopen a candidate, so the exit would never be recorded);
        //   - suspend (keep the quiet already banked, resume after) would credit pre-gap quiet: 5.8 s quiet,
        //     a 60 s hole and one quiet frame would confirm;
        //   - reset needs the full oobConfirmQuietMs of frames RECEIVED after the gap. A same-millisecond
        //     clump (the repeats an outage leaves behind) credits 0, because every frame in it has the same
        //     `now`.
        // This frame is NOT allowed to confirm, however long ago the candidate opened.
        oobQuietFrom = now;
        events.push({ type: 'oob-confirm-restarted', gapMs: gap.gapMs });
      } else if (now - oobQuietFrom >= oobConfirmQuietMs) {
        // Bed stayed quiet after the motion left it → treat as the child having climbed out.
        if (now - oobLastLog >= oobCooldownMs) {
          oobLastLog = now;
          // ROADMAP §1.2 item 1, LOG-ONLY: flags but never suppresses (see outOfBedRejected's comment
          // in bedTransitionRules.js for why an unconditional gate was found unsafe).
          if (outOfBedRejected(occupied)) events.push({ type: 'oob-impossible-flag' });
          events.push({ type: 'oob-confirmed', peak: oobEvidence.peak, outPeak: oobEvidence.peak, outFrames: oobEvidence.frames });
          occupied = false;
        }
        oobPendingAt = 0;
        oobQuietFrom = 0;
        oobEvidence = EMPTY_EVIDENCE;
      }
    }

    // --- IB (mirror of OOB) ---
    if (!ibPendingAt) {
      // Candidate: bed just moved, the outside moved recently but is quiet NOW → motion entered the bed.
      if (cribActive && !outActive && outLastActive > 0 && now - outLastActive <= ibLinkMs) {
        ibPendingAt = now;
        ibQuietFrom = now; // #452: see oobQuietFrom
        ibPeakCrib = fraction;
        ibLeadEvidence = evidenceFromSamples(outSamples); // freeze the lead-up window's evidence
        events.push({ type: 'ib-candidate-open', sinceMs: now - outLastActive, fraction });
      } else if (cribActive && !outActive && cribWasIdle && entryNearMissWorthLogging(occupied) && now - ibLastNearMiss >= ibNearMissLogMs) {
        // The bed just started moving after being quiet, we don't currently believe anyone's in it,
        // and there's no valid outside-channel link to explain it as an entry — previously silent.
        //
        // cribWasIdle matters: without it, `believed !== true` alone stays true for the entire rest of
        // a night after any restart (container recreate, settings change) that happens while the child
        // is already asleep — belief starts at null and nothing here ever sets it true if no entry ever
        // gets confirmed, so ordinary mid-sleep stirring would re-log every ibNearMissLogMs for hours
        // (both real containers restarted mid-sleep on 2026-09-12, ~02:03 local — this is not a
        // hypothetical). Requiring a fresh episode (bed was quiet, per the SAME grace period the
        // confirm logic already uses) bounds this to "how often does the child change position", not a
        // rigid clock.
        ibLastNearMiss = now;
        events.push({ type: 'ib-near-miss', sinceMs: outLastActive > 0 ? now - outLastActive : null, believedOccupied: occupied });
      }
    } else {
      if (fraction > ibPeakCrib) ibPeakCrib = fraction;
      if (outActive) {
        // Outside moved again inside the confirm window — parent still at the bed / child not settled alone.
        // Before the gap branch, as on the OOB side: activity still cancels on a frame that follows a gap.
        events.push({ type: 'ib-cancelled', pendingForMs: now - ibPendingAt });
        ibPendingAt = 0;
        ibQuietFrom = 0;
        ibPeakCrib = 0;
        ibLeadEvidence = EMPTY_EVIDENCE;
      } else if (gap) {
        // #452, mirror of the OOB side (reset, not suspend, not cancel: see the reasoning there).
        ibQuietFrom = now;
        events.push({ type: 'ib-confirm-restarted', gapMs: gap.gapMs });
      } else if (now - ibQuietFrom >= ibConfirmQuietMs) {
        // Outside stayed quiet after motion entered the bed → child placed in and the parent stepped back.
        if (now - ibLastLog >= ibCooldownMs) {
          ibLastLog = now;
          // ROADMAP §1.2 item 1, LOG-ONLY — see the OOB side's comment for why this flags rather than
          // suppresses.
          if (intoBedRejected(occupied)) events.push({ type: 'ib-impossible-flag' });
          events.push({ type: 'ib-confirmed', peak: ibPeakCrib, outPeak: ibLeadEvidence.peak, outFrames: ibLeadEvidence.frames });
          occupied = true;
        }
        ibPendingAt = 0;
        ibQuietFrom = 0;
        ibPeakCrib = 0;
        ibLeadEvidence = EMPTY_EVIDENCE;
      }
    }

    // --- Co-active diagnostic. Independent of everything above — see the state's own comment. ---
    if (cribActive && outActive) {
      if (!coActiveSince) {
        coActiveSince = now;
        coActiveCribPeak = fraction;
        coActiveOutPeak = outFraction;
      } else {
        if (fraction > coActiveCribPeak) coActiveCribPeak = fraction;
        if (outFraction > coActiveOutPeak) coActiveOutPeak = outFraction;
      }
    } else if (coActiveSince) {
      // Episode just resolved this frame — at least one channel went quiet. Which one(s) is exactly
      // the question round 2 of the 2026-09-18 review found unanswered for the 09-15 incident before
      // it was checked directly against real activity_samples (both channels quiet together, see the
      // plan doc) — recording it going forward removes the need to infer it from per-minute data.
      if (now - coActiveLastLog >= coActiveLogCooldownMs) {
        coActiveLastLog = now;
        events.push({
          type: 'co-active-episode',
          durationMs: now - coActiveSince,
          quietSide: !cribActive && !outActive ? 'both' : (!cribActive ? 'bed' : 'outside'),
          cribPeak: coActiveCribPeak,
          outPeak: coActiveOutPeak,
        });
      }
      coActiveSince = 0;
      coActiveCribPeak = 0;
      coActiveOutPeak = 0;
    }

    return { events, believedOccupied: occupied };
  }

  return { pushFrame };
}
