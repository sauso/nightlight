// The out-of-bed link rule. This is the whole of what decides whether a bed-to-outside movement even
// becomes a candidate exit, and until 2026-08-28 it was a single 8-second window buried in the ffmpeg
// frame loop — untestable, and therefore able to miss every unaided climb-out for months without
// anything going red. `oobLinkKind` is that rule, extracted; these are the cases that matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  oobLinkKind, accumulateOutEvidence, outEvidenceExpired, EMPTY_EVIDENCE,
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

// --- outEvidenceExpired ---------------------------------------------------------------------------
//
// This is the piece motionDetector.js's into_bed lead-up evidence resets on. A first draft used
// ACTIVE_GRACE_MS (1.5s — meant for bridging a brief flicker WITHIN one continuous run) here instead
// of the link window itself, which would have cleared a real episode long before an 8-second-old one
// could ever reach a candidate. Extracted as a named rule specifically so that mistake is a red test,
// not a silent behavior change nobody notices for months (the exact failure mode this file's header
// comment already names for oobLinkKind).

test('never active yet is not expired — nothing to expire', () => {
  assert.equal(outEvidenceExpired(0, 100000, 8000), false);
});

test('the boundary is inclusive: exactly the window old is not yet expired, one ms past it is', () => {
  assert.equal(outEvidenceExpired(1000, 1000 + 8000, 8000), false, 'exactly at the window');
  assert.equal(outEvidenceExpired(1000, 1000 + 8001, 8000), true, 'one ms past it');
});

test('an episode this session nearly shipped wrong: a 3s-old episode must survive an 8s link window', () => {
  // ACTIVE_GRACE_MS is 1500ms. If that were used here instead of the real link window, a 3-second-old
  // episode would already read as expired — this is the exact regression a wrong constant would cause.
  assert.equal(outEvidenceExpired(1000, 1000 + 3000, 8000), false);
});

// --- end-to-end simulation: the exact sequence motionDetector.js drives these two functions through --
//
// The frame loop itself is untestable directly (welded to a spawned ffmpeg process, same as every
// other integration point in this file) — this simulates it faithfully using only the two exported
// pure functions, the same way this file already treats oobLinkKind as the whole of what the live
// loop decides.
// Mirrors motionDetector.js's exact statement order: staleness is checked against the PRIOR
// lastActive BEFORE it is overwritten. Checking it after (or accumulating first) compares `now`
// against itself on the very reactivating frame — gap always 0 — so a long-stale episode would never
// actually clear. This is a real bug the first draft of the production code had; see its comment.
function simulateOutEvidence(frames, windowMs) {
  let evidence = EMPTY_EVIDENCE;
  let lastActive = 0; // 0 = never active, matching motionDetector.js's own sentinel convention
  const snapshots = [];
  for (const f of frames) {
    if (outEvidenceExpired(lastActive, f.t, windowMs)) evidence = EMPTY_EVIDENCE;
    if (f.active) {
      lastActive = f.t;
      evidence = accumulateOutEvidence(evidence, f.fraction, true);
    }
    if (f.snapshot) snapshots.push(evidence);
  }
  return snapshots;
}

test('a stale episode does not contaminate a later, unrelated one', () => {
  const IB_LINK_MS = 8000;
  const [afterGap] = simulateOutEvidence(
    [
      { t: 1000, fraction: 0.3, active: true }, // an early episode: a parent walks past
      { t: 1200, fraction: 0.25, active: true },
      // 20 seconds of quiet — well past the 8s link window, so this episode is stale by the time...
      { t: 21200, fraction: 0.04, active: true, snapshot: true }, // ...a small, unrelated blip occurs
    ],
    IB_LINK_MS
  );
  assert.deepEqual(afterGap, { peak: 0.04, frames: 1 }, 'only the new blip counts, not the stale episode');
});

test('a genuinely continuous lead-up (gaps under the link window) accumulates as one episode', () => {
  const IB_LINK_MS = 8000;
  const [combined] = simulateOutEvidence(
    [
      { t: 1000, fraction: 0.2, active: true },
      { t: 4000, fraction: 0.01, active: false }, // a brief lull, well under the 8s window
      { t: 6000, fraction: 0.3, active: true, snapshot: true }, // resumes — same episode
    ],
    IB_LINK_MS
  );
  assert.deepEqual(combined, { peak: 0.3, frames: 2 }, 'the lull does not reset — both bursts count');
});
