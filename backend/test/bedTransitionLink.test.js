// The out-of-bed link rule. This is the whole of what decides whether a bed-to-outside movement even
// becomes a candidate exit, and until 2026-08-28 it was a single 8-second window buried in the ffmpeg
// frame loop — untestable, and therefore able to miss every unaided climb-out for months without
// anything going red. `oobLinkKind` is that rule, extracted; these are the cases that matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  oobLinkKind, accumulateOutEvidence, trimOutSamples, evidenceFromSamples, EMPTY_EVIDENCE,
  intoBedRejected, outOfBedRejected, entryNearMissWorthLogging,
} from '../src/lib/bedTransitionRules.js';

test('an adult lifting a child out links instantly', () => {
  // One continuous movement: the bed and the outside area are active within a few hundred ms of each
  // other. Every confirmed exit in the production logs links in 190-620 ms.
  assert.equal(oobLinkKind(192, 0.047), 'fast');
  assert.equal(oobLinkKind(620, 0.019), 'fast');
});

test('a child climbing out himself links on the slow window', () => {
  // The bed shakes, he stands on the floor, and only moves across the room seconds later. Nothing
  // bridges that pause. Prod 2026-08-28: Renz out at 05:52 (bed 0.050), moving around the room at 05:53
  // (outside 0.104) — no candidate was ever opened and his wake was reported 82 minutes late.
  assert.equal(oobLinkKind(45000, 0.104), 'slow');
});

test('a marginal outside reading does not get the slow window', () => {
  // The floor is what stops the wider window admitting noise. Across 10.7 days of samples on both
  // cameras the "bed active, then outside-only" shape occurs four times: three at 0.010-0.012 with
  // nobody in either room, and the one real exit at 0.104.
  assert.equal(oobLinkKind(45000, 0.012), null);
  assert.equal(oobLinkKind(45000, 0.049), null, 'just under the floor is still out');
});

test('a big outside burst long after the bed moved is not an exit', () => {
  // Past the slow window the two events are unrelated — someone walking in an hour later is not the
  // child leaving the bed.
  assert.equal(oobLinkKind(61000, 0.9), null);
});

test('the boundaries are inclusive on both windows', () => {
  assert.equal(oobLinkKind(8000, 0.001), 'fast', 'exactly at the fast window');
  assert.equal(oobLinkKind(8001, 0.001), null, 'one ms past it, with nothing to justify the slow one');
  assert.equal(oobLinkKind(60000, 0.05), 'slow', 'exactly at the slow window and exactly at the floor');
});

// --- accumulateOutEvidence (ROADMAP §1.2 item 2: outside-channel peak + duration) ----------------
//
// Record-only for now — see its own comment in bedTransitionRules.js for why a peak-only floor was
// measured (2026-09-12, 468 owner-reviewed verdicts) and found NOT to separate real transitions from
// false ones on either direction. These tests pin the one thing this primitive has to get right:
// peak tracks the max regardless of `active`, frames counts only active ones.

test('EMPTY_EVIDENCE is the inert starting point', () => {
  assert.deepEqual(EMPTY_EVIDENCE, { peak: 0, frames: 0 });
});

test('peak takes the max across calls, whether or not the frame was active', () => {
  // Mirrors the existing oobPeakOut behavior, which already updates on every pending frame regardless
  // of threshold — a candidate's peak has never been active-gated, only its duration should be.
  let e = accumulateOutEvidence(EMPTY_EVIDENCE, 0.02, false);
  e = accumulateOutEvidence(e, 0.09, true);
  e = accumulateOutEvidence(e, 0.05, true);
  assert.equal(e.peak, 0.09, 'the highest reading wins, from wherever it came');
});

test('peak is genuinely active-INDEPENDENT — an inactive reading can set it', () => {
  // Every other peak test here has the active frames hold the highest reading, so a mutant that
  // secretly gated peak on `active` (`active ? Math.max(...) : prev.peak`) would pass them all
  // anyway — found by adversarial review (2026-09-12). This is the one fixture where the INACTIVE
  // frame is the highest, so gating peak on active would visibly change the answer.
  let e = accumulateOutEvidence(EMPTY_EVIDENCE, 0.9, false); // the highest reading, but not active
  e = accumulateOutEvidence(e, 0.1, true);
  assert.equal(e.peak, 0.9, 'the inactive reading still sets the peak');
  assert.equal(e.frames, 1, 'but it does not count toward duration');
});

test('frames counts only the readings that crossed the active threshold', () => {
  let e = EMPTY_EVIDENCE;
  for (const active of [true, false, true, true, false]) {
    e = accumulateOutEvidence(e, active ? 0.5 : 0.001, active);
  }
  assert.equal(e.frames, 3, 'exactly the active ones, not all five calls');
});

test('a concrete multi-frame sequence lands on the exact expected tally', () => {
  const frames = [
    { fraction: 0.01, active: false },
    { fraction: 0.06, active: true },
    { fraction: 0.08, active: true },
    { fraction: 0.03, active: false },
    { fraction: 0.11, active: true },
  ];
  const result = frames.reduce((e, f) => accumulateOutEvidence(e, f.fraction, f.active), EMPTY_EVIDENCE);
  assert.deepEqual(result, { peak: 0.11, frames: 3 });
});

// --- trimOutSamples / evidenceFromSamples ----------------------------------------------------------
//
// The into_bed lead-up evidence is a ROLLING WINDOW over IB_LINK_MS, not an accumulate-until-quiet
// episode. A first draft tried the latter (reset only after a quiet gap longer than IB_LINK_MS) and
// adversarial review (2026-09-12) found it unbounded: ordinary pauses while someone moves around a
// room — adjusting a blanket, stepping back and forward — are routinely under an 8-second gap, so
// bursts would chain into one open-ended episode with no upper bound on how far back it reaches, even
// though the into_bed candidate itself only ever cares about the last IB_LINK_MS. These tests pin the
// window itself, not just the accumulator.

test('trimOutSamples keeps only samples within the window of now', () => {
  const samples = [{ t: 0, fraction: 0.1, active: true }, { t: 5000, fraction: 0.2, active: true }];
  assert.deepEqual(trimOutSamples(samples, 8000, 8000), samples, 'both still within 8s of now=8000');
  assert.deepEqual(trimOutSamples(samples, 8001, 8000), [samples[1]], 'the older one just fell out');
});

test('evidenceFromSamples reduces exactly like accumulateOutEvidence would, over whatever remains', () => {
  const samples = [
    { t: 0, fraction: 0.02, active: false },
    { t: 100, fraction: 0.09, active: true },
    { t: 200, fraction: 0.05, active: true },
  ];
  assert.deepEqual(evidenceFromSamples(samples), { peak: 0.09, frames: 2 });
  assert.deepEqual(evidenceFromSamples([]), EMPTY_EVIDENCE, 'no samples is the inert starting point');
});

// --- end-to-end simulation: the exact sequence motionDetector.js drives these two functions through --
//
// The frame loop itself is untestable directly (welded to a spawned ffmpeg process, same as every
// other integration point in this file) — this simulates it faithfully using only the two exported
// pure functions, the same way this file already treats oobLinkKind as the whole of what the live
// loop decides: trim-then-append every frame, snapshot with evidenceFromSamples whenever a candidate
// would open.
function simulateOutEvidence(frames, windowMs) {
  let samples = [];
  const snapshots = [];
  for (const f of frames) {
    samples = trimOutSamples(samples, f.t, windowMs);
    samples.push({ t: f.t, fraction: f.fraction, active: f.active });
    if (f.snapshot) snapshots.push(evidenceFromSamples(samples));
  }
  return snapshots;
}

// ★ THE REGRESSION TEST for the adversarial-review finding: a chain of bursts each under the link
// window apart must NOT let evidence reach arbitrarily far back. Against the rejected "episode" design
// this would have returned frames covering the ENTIRE 21-second chain; the rolling window must only
// ever see the last 8 seconds of it.
test('a chain of sub-window bursts does not let evidence reach arbitrarily far back', () => {
  const IB_LINK_MS = 8000;
  const frames = [];
  for (let t = 0; t <= 21000; t += 3000) frames.push({ t, fraction: 0.2, active: true }); // every 3s
  frames[frames.length - 1].snapshot = true; // t = 21000
  const [result] = simulateOutEvidence(frames, IB_LINK_MS);
  // Only samples from t=13001..21000 are within 8s of t=21000 — that's t=15000,18000,21000: 3 frames.
  assert.equal(result.frames, 3, 'only the samples inside the last 8s count, not the whole 21s chain');
});

test('a stale burst does not contaminate a later, unrelated one', () => {
  const IB_LINK_MS = 8000;
  const [afterGap] = simulateOutEvidence(
    [
      { t: 1000, fraction: 0.3, active: true }, // an early burst: a parent walks past
      { t: 1200, fraction: 0.25, active: true },
      // 20 seconds of quiet — well past the 8s link window, so this is out of the window by the time...
      { t: 21200, fraction: 0.04, active: true, snapshot: true }, // ...a small, unrelated blip occurs
    ],
    IB_LINK_MS
  );
  assert.deepEqual(afterGap, { peak: 0.04, frames: 1 }, 'only the new blip counts, not the stale burst');
});

test('a genuinely continuous lead-up (gaps under the link window) accumulates within the window', () => {
  const IB_LINK_MS = 8000;
  const [combined] = simulateOutEvidence(
    [
      { t: 1000, fraction: 0.2, active: true },
      { t: 4000, fraction: 0.01, active: false }, // a brief lull, well under the 8s window
      { t: 6000, fraction: 0.3, active: true, snapshot: true }, // resumes — still inside the window
    ],
    IB_LINK_MS
  );
  assert.deepEqual(combined, { peak: 0.3, frames: 2 }, 'both bursts are still inside the 8s window');
});

// --- intoBedRejected / outOfBedRejected (ROADMAP §1.2 item 1: believed occupancy) ------------------
//
// Measured 2026-08-29: 147 of 238 stored transitions (62%) are the SAME type twice in a row with
// nothing between — physically impossible (you cannot get into a bed you are already in, or leave one
// you are already out of). `believed` tracks what the data itself already implies.
//
// ⚠️ LOG-ONLY, deliberately (see the big comment on these functions in bedTransitionRules.js): a
// retrospective check against real owner-verdicted transitions found that actually SUPPRESSING a
// same-direction repeat drops real transitions too, because a false one slipping through poisons
// belief until an opposite-direction event resets it. So these two functions are used ONLY to flag a
// repeat in the log — motionDetector.js still records every transition unconditionally, and `believed`
// updates on every recorded transition regardless of whether it was flagged.

test('null (not yet known) never flags either direction', () => {
  // There is nothing yet to contradict — the first transition since this detector started must be
  // allowed through unflagged, whichever direction it is.
  assert.equal(intoBedRejected(null), false);
  assert.equal(outOfBedRejected(null), false);
});

test('an into_bed while already believed in bed is flagged; while out, it is not', () => {
  assert.equal(intoBedRejected(true), true, 'already in bed — a second arrival is impossible');
  assert.equal(intoBedRejected(false), false, 'out of bed — an arrival is exactly what is expected');
});

test('an out_of_bed while already believed out of bed is flagged; while in, it is not', () => {
  assert.equal(outOfBedRejected(false), true, 'already out — a second departure is impossible');
  assert.equal(outOfBedRejected(true), false, 'in bed — a departure is exactly what is expected');
});

// --- end-to-end simulation: the exact sequence motionDetector.js drives believedOccupied through ----
//
// Mirrors the real wiring exactly: EVERY transition is recorded, `believed` updates unconditionally
// after each one, and the flag is purely informational — never gates storage.
function simulateOccupancy(transitions) {
  let believed = null;
  const flags = [];
  for (const type of transitions) {
    const flagged = type === 'into_bed' ? intoBedRejected(believed) : outOfBedRejected(believed);
    flags.push(flagged ? 'flagged' : 'ok');
    believed = type === 'into_bed';
  }
  return flags;
}

test('alternating types are never flagged — this is the ordinary, healthy case', () => {
  assert.deepEqual(
    simulateOccupancy(['into_bed', 'out_of_bed', 'into_bed', 'out_of_bed']),
    ['ok', 'ok', 'ok', 'ok']
  );
});

// --- entryNearMissWorthLogging (unexplained bed activity, found 2026-09-13) --------------------------
//
// Renz's real 2026-09-12 bedtime: staging never recorded a single into_bed for the whole ~50-minute
// settling window, and there was nothing in the logs to say why — a missed entry has always been
// completely silent. This predicate decides when "the bed moved with no valid link" is worth a log
// line: NOT a time bound (like the exit side's OOB_NEARMISS_MS), because a child already believed to be
// in bed keeps moving in it all night, and that ordinary stirring must not re-trigger this forever.

test('worth logging when nobody is believed in bed — a real bedtime could be going unrecorded', () => {
  assert.equal(entryNearMissWorthLogging(false), true, 'believed out — bed activity with no link is unexplained');
  assert.equal(entryNearMissWorthLogging(null), true, 'not yet known — same reasoning as null never flagging a repeat');
});

test('NOT worth logging once the child is already believed in bed — ordinary stirring, not a missed entry', () => {
  assert.equal(entryNearMissWorthLogging(true), false);
});

test('★ THE 62% CASE: consecutive same-direction transitions are flagged from the second one on', () => {
  // Renz, measured 2026-08-29: 4 consecutive into_bed with NO out_of_bed between them
  // (bed-transition-classifier-flaws.md). This is exactly the pattern item 1 exists to surface.
  assert.deepEqual(
    simulateOccupancy(['into_bed', 'into_bed', 'into_bed', 'into_bed']),
    ['ok', 'flagged', 'flagged', 'flagged']
  );
});

test('a real pair either side of a flagged repeat is itself unflagged', () => {
  assert.deepEqual(
    simulateOccupancy(['into_bed', 'into_bed', 'out_of_bed']),
    ['ok', 'flagged', 'ok'],
    'the spurious middle event is flagged; the real departure after it is not'
  );
});

// ★ THE REGRESSION THIS PHASE EXISTS TO AVOID — proof that gating on this flag would be unsafe today.
// Reproduces the exact real 2026-09-11 Renz mechanism (see bedTransitionRules.js's comment): a false
// out_of_bed slips through, and the REAL wake after it would read as an impossible repeat of the false
// one, not of the real departure it actually is.
test('a false transition would poison a naive gate into dropping the REAL one after it', () => {
  const flags = simulateOccupancy(['into_bed', 'out_of_bed', /* false exit */ 'out_of_bed' /* the real wake */]);
  assert.deepEqual(flags, ['ok', 'ok', 'flagged'], 'the REAL wake is flagged too — a gate would drop it');
});
