// The out-of-bed link rule. This is the whole of what decides whether a bed-to-outside movement even
// becomes a candidate exit, and until 2026-08-28 it was a single 8-second window buried in the ffmpeg
// frame loop — untestable, and therefore able to miss every unaided climb-out for months without
// anything going red. `oobLinkKind` is that rule, extracted; these are the cases that matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  oobLinkKind, accumulateOutEvidence, trimOutSamples, evidenceFromSamples, EMPTY_EVIDENCE,
  intoBedRejected, outOfBedRejected, entryNearMissWorthLogging, findQuickReversals,
  findLingeringBedMotion, LINGERING_MOTION_ACTIVE, LINGERING_WINDOW_MS, LINGERING_MIN_ACTIVE_MINUTES,
  createFrameGapDetector,
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

// --- findQuickReversals (ROADMAP §1.2 item 3: goodnight-kiss / parent-handling gap) -----------------
//
// getQuickReversals (bedTransitions.js) already covers the pairing/boundary/type rules in depth against
// a real DB. What's specific to this pure function, and worth testing here, is the property it exists
// FOR: the morning review hands it a night's transitions ordered by TIME ACROSS ALL CAMERAS (not
// grouped by camera first, unlike getQuickReversals' own SQL query) — so it must group and sort
// per-camera internally, correctly, given input that arrives in an arbitrary order.
const row = (id, camera_id, type, created_at) => ({ id, camera_id, type, created_at });

test('a genuine adjacent pair is found from already-sorted, single-camera input', () => {
  const rows = [
    row(1, 'cam-a', 'into_bed', '2026-03-01 19:51:00'),
    row(2, 'cam-a', 'out_of_bed', '2026-03-01 19:51:14'),
  ];
  const found = findQuickReversals(rows);
  assert.equal(found.length, 1);
  assert.equal(found[0].into_bed.id, 1);
  assert.equal(found[0].out_of_bed.id, 2);
  assert.equal(found[0].gap_ms, 14000);
});

test('input interleaved across cameras and out of time order is still paired correctly', () => {
  // The exact shape transitionsFor() hands this: one query's worth of rows for a child's cameras,
  // ordered by created_at across ALL of them — so camera A and B's events can interleave, and (since
  // nothing guarantees insertion order) are not assumed sorted either. Deliberately fed here in an
  // order that is neither camera-grouped nor time-sorted.
  const rows = [
    row(3, 'cam-b', 'out_of_bed', '2026-03-01 10:00:05'), // cam-b's reversal, second half, listed FIRST
    row(1, 'cam-a', 'into_bed', '2026-03-01 19:51:00'), // cam-a's reversal, first half, listed SECOND
    row(2, 'cam-a', 'out_of_bed', '2026-03-01 19:51:14'),
    row(4, 'cam-b', 'into_bed', '2026-03-01 10:00:00'), // cam-b's reversal, first half, listed LAST
  ];
  const found = findQuickReversals(rows);
  assert.equal(found.length, 2, 'both cameras\' genuine reversals must be found despite the scramble');
  const byCam = Object.fromEntries(found.map((f) => [f.into_bed.camera_id, f]));
  assert.equal(byCam['cam-a'].out_of_bed.id, 2);
  assert.equal(byCam['cam-b'].into_bed.id, 4);
  assert.equal(byCam['cam-b'].out_of_bed.id, 3);
});

test('maxGapMs is honoured and the default is 60s', () => {
  const near = [row(1, 'cam-a', 'into_bed', '2026-03-01 10:00:00'), row(2, 'cam-a', 'out_of_bed', '2026-03-01 10:01:00')];
  const far = [row(1, 'cam-a', 'into_bed', '2026-03-01 10:00:00'), row(2, 'cam-a', 'out_of_bed', '2026-03-01 10:01:01')];
  assert.equal(findQuickReversals(near).length, 1, '60000ms is inclusive');
  assert.equal(findQuickReversals(far).length, 0, '60001ms is not');
  assert.equal(findQuickReversals(far, { maxGapMs: 120000 }).length, 1, 'a wider window catches it');
});

test('no reversal, no false positive: alternating types with nothing quick between them', () => {
  const rows = [
    row(1, 'cam-a', 'into_bed', '2026-03-01 19:00:00'),
    row(2, 'cam-a', 'out_of_bed', '2026-03-01 19:05:00'), // 5 minutes later, not a "quick" reversal
  ];
  assert.deepEqual(findQuickReversals(rows, { maxGapMs: 60000 }), []);
});

// --- findLingeringBedMotion (ROADMAP §1.2 item 3 Phase 1) -----------------------------------------

const lingeringExit = (created_at = '2026-03-01 10:00:30', type = 'out_of_bed') =>
  row(90, 'cam-a', type, created_at);
const activity = (bucket_start, motion_peak = LINGERING_MOTION_ACTIVE + 0.01) =>
  ({ bucket_start, motion_peak });
const activeMinutes = (...minutes) => minutes.map((minute) => activity(`2026-03-01 10:${minute}:00`));

test('four qualifying distinct minutes with no recorded return are flagged', () => {
  const found = findLingeringBedMotion(lingeringExit(), null, activeMinutes('01', '02', '03', '04'));
  assert.equal(found.active_minutes, LINGERING_MIN_ACTIVE_MINUTES);
  assert.equal(found.out_of_bed.id, 90);
  assert.equal(found.bucket_start, '2026-03-01 10:01:00', 'the first qualifying minute is the evidence returned');
});

test('fewer than four qualifying minutes never flag even when real activity is present', () => {
  assert.equal(
    findLingeringBedMotion(lingeringExit(), null, activeMinutes('01', '02', '03')),
    null
  );
});

test('four duplicate rows for one minute count as one distinct active minute, not four', () => {
  const duplicateMinute = Array.from({ length: 4 }, () => activity('2026-03-01 10:01:00'));
  assert.equal(findLingeringBedMotion(lingeringExit(), null, duplicateMinute), null, 'one minute is below the default four');
  const counted = findLingeringBedMotion(lingeringExit(), null, duplicateMinute, { minActiveMinutes: 1 });
  assert.equal(counted.active_minutes, 1, 'duplicate rows are OR-merged into one physical minute');

  const mixedDuplicates = [
    activity('2026-03-01 10:01:00', LINGERING_MOTION_ACTIVE + 0.01),
    activity('2026-03-01 10:01:00', LINGERING_MOTION_ACTIVE - 0.001),
  ];
  assert.equal(
    findLingeringBedMotion(lingeringExit(), null, mixedDuplicates, { minActiveMinutes: 1 }).active_minutes,
    1,
    'a later quiet duplicate cannot erase an active row from the same minute'
  );
});

test('a real into_bed before enough active minutes accumulate suppresses the flag', () => {
  const returned = row(91, 'cam-a', 'into_bed', '2026-03-01 10:04:30');
  assert.equal(
    findLingeringBedMotion(lingeringExit(), returned, activeMinutes('01', '02', '03', '04', '05', '06')),
    null,
    'only three qualifying minutes precede the return minute'
  );
});

test('motion at or below the active threshold never flags however many minutes are present', () => {
  const quiet = [
    activity('2026-03-01 10:01:00', LINGERING_MOTION_ACTIVE),
    activity('2026-03-01 10:02:00', LINGERING_MOTION_ACTIVE),
    activity('2026-03-01 10:03:00', LINGERING_MOTION_ACTIVE),
    activity('2026-03-01 10:04:00', LINGERING_MOTION_ACTIVE),
    activity('2026-03-01 10:05:00', LINGERING_MOTION_ACTIVE - 0.001),
    activity('2026-03-01 10:06:00', null),
  ];
  assert.equal(findLingeringBedMotion(lingeringExit(), null, quiet), null);
});

test('the fixed window is inclusive at exactly sixty minutes and excludes one minute past it', () => {
  const onTheMinute = lingeringExit('2026-03-01 10:00:00');
  const found = findLingeringBedMotion(onTheMinute, null, [
    activity('2026-03-01 10:57:00'),
    activity('2026-03-01 10:58:00'),
    activity('2026-03-01 10:59:00'),
    activity('2026-03-01 11:00:00'), // exactly exit + LINGERING_WINDOW_MS
    activity('2026-03-01 11:01:00'), // one minute beyond the inclusive cap
  ]);
  assert.equal(found.active_minutes, 4, 'the exact boundary counts but the minute beyond it does not');
  assert.equal(Date.parse(`${found.bucket_start.replace(' ', 'T')}Z`) - Date.parse('2026-03-01T10:00:00Z') <= LINGERING_WINDOW_MS, true);
});

test('zero activity samples do not flag and do not throw', () => {
  assert.equal(findLingeringBedMotion(lingeringExit(), null, []), null);
});

test("the exit's own minute is never counted as lingering evidence", () => {
  const samples = [activity('2026-03-01 10:00:00'), ...activeMinutes('01', '02', '03')];
  assert.equal(findLingeringBedMotion(lingeringExit(), null, samples), null, 'excluding departure motion leaves only three minutes');
});

test("an exit at exactly :00 seconds still excludes its own minute's sample", () => {
  // Same shape as the test above, but with a :00-second exit specifically. Every other fixture in this
  // file uses lingeringExit()'s default nonzero-second timestamp, so a bucket_start (always :00 seconds)
  // can never land exactly ON the exit's own created_at — meaning `s.bucket_start <= exit.created_at`
  // weakened to `<` would silently survive every other test here. Found missing by an adversarial
  // pre-merge review (a Claude subagent), 2026-09-14: that exact mutation passed the full suite before
  // this test existed.
  const exit = lingeringExit('2026-03-01 10:00:00');
  const samples = [activity('2026-03-01 10:00:00'), ...activeMinutes('01', '02', '03')];
  assert.equal(findLingeringBedMotion(exit, null, samples), null, "excluding the exit's own :00 minute leaves only three qualifying minutes");
});

test('a same-minute return with nonzero seconds closes the window at that minute', () => {
  const returned = row(91, 'cam-a', 'into_bed', '2026-03-01 10:01:45');
  assert.equal(
    findLingeringBedMotion(lingeringExit(), returned, activeMinutes('01', '02', '03', '04'), { minActiveMinutes: 1 }),
    null,
    'the 10:01 bucket belongs to the return minute and is not lingering motion'
  );
});

test('a non-out_of_bed exit is rejected defensively', () => {
  assert.equal(findLingeringBedMotion(lingeringExit(undefined, 'into_bed'), null, activeMinutes('01', '02', '03', '04')), null);
});

test("gap_ms is measured from the exit's real timestamp, not its floored minute", () => {
  const found = findLingeringBedMotion(lingeringExit('2026-03-01 10:00:30'), null, activeMinutes('01', '02', '03', '04'));
  assert.equal(found.gap_ms, 30000, '10:01:00 is thirty seconds after the real 10:00:30 exit');
});

test('windowMs is configurable', () => {
  const samples = activeMinutes('01', '02', '03', '04');
  assert.equal(findLingeringBedMotion(lingeringExit('2026-03-01 10:00:00'), null, samples, { windowMs: 3 * 60000 }), null);
  assert.equal(
    findLingeringBedMotion(lingeringExit('2026-03-01 10:00:00'), null, samples, { windowMs: 4 * 60000 }).active_minutes,
    4
  );
});

test('minActiveMinutes is configurable independently of the four-minute default', () => {
  const threeMinutes = activeMinutes('01', '02', '03');
  assert.equal(findLingeringBedMotion(lingeringExit(), null, threeMinutes), null, 'the default still requires four');
  assert.equal(findLingeringBedMotion(lingeringExit(), null, threeMinutes, { minActiveMinutes: 3 }).active_minutes, 3);
});

// --- createFrameGapDetector (#452): "did this frame arrive after a gap?" --------------------------------------
//
// Every number below comes from the helper's own comment: floor 1500 ms (motionDetector.js passes its
// ACTIVE_GRACE_MS), factor 5, a 16-delta window, a 50 ms minimum recorded delta. The tracker-level and
// detector-level consequences are tested in bedTransitionTracker.test.js and motion-frame-gap.test.js.
const FLOOR = 1500;
// Feeds `times` through a fresh detector and returns each call's result.
function observeAll(times, options = {}) {
  const d = createFrameGapDetector({ floorMs: FLOOR, ...options });
  return times.map((t) => d.observe(t));
}
// n frames spaced `step` ms apart, starting at `from` (the first one included).
const spaced = (from, n, step) => Array.from({ length: n }, (_, i) => from + i * step);

test('#452 frame gap: floorMs is required and must be positive', () => {
  assert.throws(() => createFrameGapDetector({}), /floorMs/);
  assert.throws(() => createFrameGapDetector(), /floorMs/);
  assert.throws(() => createFrameGapDetector({ floorMs: 0 }), /floorMs/);
  assert.throws(() => createFrameGapDetector({ floorMs: -5 }), /floorMs/);
});

test('#452 frame gap: the first frame has nothing before it to be late after', () => {
  // Even a first frame at a huge time: there is no previous frame, so there cannot be a gap. Kills a detector
  // that starts with prev = 0 and calls the first frame a 1.7e12 ms gap.
  assert.equal(createFrameGapDetector({ floorMs: FLOOR }).observe(1_700_000_000_000), null);
});

test('#452 frame gap: the floor is exact, 1500 ms is not a gap and 1501 ms is', () => {
  // ACTIVE_GRACE_MS's own convention: a gap "no longer than" the grace has not ended a run. Fresh detectors,
  // so the window is empty and the floor alone governs.
  assert.deepEqual(observeAll([10_000, 11_500]), [null, null], '1500 ms: not a gap');
  assert.deepEqual(observeAll([10_000, 11_501]), [null, { gapMs: 1501 }], '1501 ms: a gap, reporting its length');
});

test('#452 frame gap: a steady 5 fps stream, and one jittering inside the floor, never reports a gap', () => {
  assert.ok(observeAll(spaced(0, 200, 200)).every((r) => r === null));
  const jitter = [0];
  for (let i = 0; i < 200; i += 1) jitter.push(jitter[jitter.length - 1] + [200, 120, 900, 1400, 40, 200][i % 6]);
  assert.ok(observeAll(jitter).every((r) => r === null), 'every delta is at or under 1500 ms');
});

test('#452 frame gap: a backward wall-clock step ALWAYS counts as a gap, with a negative gapMs', () => {
  const [, , back, after] = observeAll([1000, 1200, 1199, 1399]);
  assert.deepEqual(back, { gapMs: -1 }, 'even one millisecond backwards: conservative, it only restarts a confirmation');
  assert.equal(after, null, 'the next frame is measured from the stepped-back time, not from before the step');
  // A big step back, on a detector whose bound has grown wide: still a gap (a negative delta is under any bound).
  assert.deepEqual(observeAll([...spaced(0, 20, 2000), 1000]).at(-1), { gapMs: -(38_000 - 1000) });
});

test('#452 frame gap: frames sharing one receipt time (a clump) are not gaps and do not drag the bound to nothing', () => {
  // 3 frames delivered at once every 600 ms, as a bursty read does. If the in-clump deltas (0) were recorded the
  // median would be 0 and the bound would fall back to the 1500 ms floor; ignoring them keeps the 600 ms cadence
  // in the median (bound 5 x 600 = 3000), so a 2000 ms hole is NOT a gap on this camera.
  const clumped = [];
  for (let i = 0; i < 30; i += 1) clumped.push(i * 600, i * 600, i * 600);
  const out = observeAll([...clumped, 29 * 600 + 2000]);
  assert.ok(out.every((r) => r === null), 'no gap anywhere, including the 2000 ms hole');
});

test('#452 frame gap: a delta of exactly minDeltaMs (50) is clump noise, 51 is a real interval', () => {
  // Clumps of 3 frames 50 ms apart, 920 ms between clumps. With 50 ms deltas ignored the median is 920 (bound 4600),
  // so a 3000 ms hole is not a gap; recording them (>= instead of >) makes the median 50 and the bound the floor.
  const stream = [];
  for (let i = 0; i < 30; i += 1) stream.push(i * 1020, i * 1020 + 50, i * 1020 + 100);
  const last = stream[stream.length - 1];
  assert.equal(observeAll([...stream, last + 3000]).at(-1), null, '50 ms deltas are not recorded');
  // The same shape at 51 ms: now the in-clump delta IS an interval (and the median), the bound is the floor.
  const stream51 = [];
  for (let i = 0; i < 30; i += 1) stream51.push(i * 1020, i * 1020 + 51, i * 1020 + 102);
  const last51 = stream51[stream51.length - 1];
  assert.deepEqual(observeAll([...stream51, last51 + 3000]).at(-1), { gapMs: 3000 }, '51 ms deltas are recorded');
});

test('#452 frame gap: one 20 s stall does not widen the bound for the frame after it', () => {
  // A stall must not inflate its own bound. 10 normal 200 ms frames, a 20 s stall, then a frame 1600 ms later:
  // still a gap (the bound is the 1500 ms floor). With the stall's delta averaged in (a mean, not a median) the
  // bound would be ~10 s and this frame would pass.
  const out = observeAll([...spaced(0, 10, 200), 1800 + 20_000, 1800 + 20_000 + 1600]);
  assert.deepEqual(out.slice(-2), [{ gapMs: 20_000 }, { gapMs: 1600 }]);
});

test('#452 frame gap: a stall met right after the second frame cannot lift the bound either (too few deltas held)', () => {
  // Window of one 200 ms delta, then a 20 s stall: two held, fewer than the 9 needed, so the floor alone governs and
  // the frame 1600 ms later is still a gap. (A mean of the two, 10.1 s, would have made the bound 50 s.)
  assert.deepEqual(observeAll([0, 200, 20_200, 21_800]).slice(-2), [{ gapMs: 20_000 }, { gapMs: 1600 }]);
});

// ★ REGRESSION (#452 code review round 1, found by Codex and Opus by running it): with the typical interval taken as
// the median of WHATEVER the window held, the first stall after a launch WAS the median and widened the bound for the
// next frame. Each test below fails on that code and passes on the K-th-largest rule (K = floor(windowN / 2) + 1).
test('#452 frame gap: a lone stall right after a launch cannot widen the bound (frames at 0 / 20 s / 50 s)', () => {
  // The 20 s delta is the only one held. Judged as the median it made the bound 100 s, so the 30 s delta passed
  // and a single quiet frame after a 30 s outage confirmed an exit. Held-count 1 < 9: the floor governs, a gap.
  assert.deepEqual(observeAll([0, 20_000, 50_000]), [null, { gapMs: 20_000 }, { gapMs: 30_000 }]);
  // Same shape with the motion alert's cadence: active at 200, 2200, 9200 (a 2 s then a 7 s delta, 2 held).
  assert.deepEqual(observeAll([200, 2200, 9200]).slice(1), [{ gapMs: 2000 }, { gapMs: 7000 }]);
});

test('#452 frame gap: the held-count threshold is derived from windowN (K = floor(windowN / 2) + 1), not a literal 9', () => {
  // windowN 2 -> K 2: ONE held delta says nothing, so 0 / 20 s / 50 s is still two gaps.
  assert.deepEqual(observeAll([0, 20_000, 50_000], { windowN: 2 }).slice(1), [{ gapMs: 20_000 }, { gapMs: 30_000 }]);
  // windowN 4 -> K 3, on a 2 s cadence: with 2 deltas held a 6 s hole is a gap, with 3 held it is not (bound 10 s).
  // A literal 9 would call both of them gaps, a K of floor(windowN / 2) would let the first one through.
  assert.deepEqual(observeAll([0, 2000, 4000, 10_000], { windowN: 4 }).at(-1), { gapMs: 6000 }, '2 deltas held: not enough');
  assert.equal(observeAll([0, 2000, 4000, 6000, 12_000], { windowN: 4 }).at(-1), null, '3 deltas held: the bound is 5 x 2000');
});

test('#452 frame gap: the bound widens at exactly 9 held deltas, not 8 (windowN 16)', () => {
  // A 2 s cadence, then a 6 s hole. 8 recorded 2 s deltas: still only the floor (a gap). 9: bound 5 x 2 s = 10 s.
  const eight = spaced(0, 9, 2000); // 9 frames = 8 deltas, the last frame at 16000
  assert.deepEqual(observeAll([...eight, 16_000 + 6000]).at(-1), { gapMs: 6000 }, '8 deltas held: the floor alone');
  const nine = spaced(0, 10, 2000); // 10 frames = 9 deltas, the last frame at 18000
  assert.equal(observeAll([...nine, 18_000 + 6000]).at(-1), null, '9 deltas held: the bound is 10 s');
});

test('#452 frame gap: the factor is exactly 5 (a 9.5 s hole and a 10 s hole in a 2 s cadence are not gaps, 10.001 s is)', () => {
  // 9 deltas of 2 s held: bound 5 x 2000 = 10000. Factor 4 (bound 8 s) would call 9.5 s and 10 s gaps, factor 6
  // (12 s) would let 10.001 s through, and `>=` instead of `>` would call 10 s a gap.
  const nine = spaced(0, 10, 2000); // the last frame at 18000
  assert.equal(observeAll([...nine, 18_000 + 9500]).at(-1), null, '9.5 s: inside 5 x 2 s');
  assert.equal(observeAll([...nine, 18_000 + 10_000]).at(-1), null, '10 s: exactly the bound is not a gap');
  assert.deepEqual(observeAll([...nine, 18_000 + 10_001]).at(-1), { gapMs: 10_001 }, '10.001 s: a gap');
});

test('#452 frame gap: fewer than 9 LONG deltas can never lift the bound, even with 9 held (the K-th largest, not the median of the held)', () => {
  // One normal 200 ms delta then eight 2 s deltas: 9 held, 8 of them long. The 9th largest is the 200 ms one, so the
  // bound stays at the floor and a 6 s hole is a gap. The lower median of the 9 held would be 2 s (bound 10 s).
  const stream = [0, 200, ...spaced(2200, 8, 2000)]; // the last frame at 2200 + 7 x 2000 = 16200
  assert.deepEqual(observeAll([...stream, 16_200 + 6000]).at(-1), { gapMs: 6000 });
  // A ninth long delta makes 9 long ones: now the 9th largest is 2 s and the bound is 10 s.
  assert.equal(observeAll([...stream, 18_200, 18_200 + 6000]).at(-1), null);
});

test('#452 frame gap: a slow camera (a 2 s burst cadence) learns its own bound after ~9 slow intervals; a real 20 s stall in it is still a gap', () => {
  // 0.5 fps delivered in 5-frame bursts, one burst every 2 s: slower than 1/1.5 s, so against the floor alone EVERY
  // burst would be a gap and nothing could ever confirm. Cold start: the window must hold 9 deltas before it says
  // anything, so the first 9 burst intervals are all judged against the floor (9 gaps, at the first frame of bursts 1
  // to 9, i.e. indexes 5, 10, ..., 45) and are recorded; from the 10th the typical interval is 2000 ms and the bound
  // 10 s. (Before the round-1 fix the bound widened after the second burst: that is the defect, not the goal.)
  const bursts = [];
  for (let i = 0; i < 20; i += 1) for (let k = 0; k < 5; k += 1) bursts.push(i * 2000);
  const out = observeAll(bursts);
  const gaps = out.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(gaps, [5, 10, 15, 20, 25, 30, 35, 40, 45], 'nine gaps while the window learns, none after');
  // After learning: a 6 s hole is not a gap, a 20 s stall is.
  const d = createFrameGapDetector({ floorMs: FLOOR });
  for (const t of bursts) d.observe(t);
  assert.equal(d.observe(38_000 + 6000), null, 'a 6 s hole in a 2 s cadence: not a gap');
  assert.deepEqual(d.observe(44_000 + 20_000), { gapMs: 20_000 }, 'a 20 s stall: a gap');
});

test('#452 frame gap: a camera that slows from 15 fps to 2 s per burst is starved only until the window has learned it', () => {
  // 16 deltas of 67 ms fill the window; then 2000 ms deltas. The lower median of 16 flips once 9 of them are
  // 2000 ms, so the first 9 slow intervals are gaps (each judged against the old bound) and the 10th is not.
  const d = createFrameGapDetector({ floorMs: FLOOR });
  let t = 0;
  for (let i = 0; i < 17; i += 1) { d.observe(t); t += 67; }
  const results = [];
  for (let i = 0; i < 12; i += 1) { t += 2000 - 67; results.push(d.observe(t)); t += 67; }
  assert.deepEqual(results.map((r) => (r ? 1 : 0)), [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
});

test('#452 frame gap: the bound relaxes again when the camera speeds up (the window is trimmed to its last 16 deltas)', () => {
  // A slow phase (bound 10 s), then a fast one: after 9 fast deltas the median is back to 200 ms, so a 3000 ms
  // hole is a gap again. Without trimming the window keeps the slow samples and the bound stays wide.
  const d = createFrameGapDetector({ floorMs: FLOOR });
  let t = 0;
  for (let i = 0; i < 20; i += 1) { d.observe(t); t += 2000; }
  for (let i = 0; i < 12; i += 1) { d.observe(t); t += 200; }
  assert.deepEqual(d.observe(t + 3000 - 200), { gapMs: 3000 });
});

test('#452 frame gap: factor and windowN are injectable (minDeltaMs is pinned by its own boundary test above)', () => {
  // factor 1 makes the bound the median itself (floor aside), so a 2x hole (4000 ms) is a gap on a 2 s cadence;
  // the default factor 5 (bound 10 s) lets the same hole through.
  const slow = spaced(0, 12, 2000); // the last frame is at 22000
  assert.deepEqual(observeAll([...slow, 22_000 + 4000], { floorMs: 100, factor: 1 }).at(-1), { gapMs: 4000 });
  assert.equal(observeAll([...slow, 22_000 + 4000], { floorMs: 100, factor: 5 }).at(-1), null);
  // windowN 1: only the LAST delta is the typical interval, so one 200 ms delta after a slow phase relaxes it.
  const fastAfterSlow = [...spaced(0, 10, 2000), 18_200];
  assert.deepEqual(observeAll([...fastAfterSlow, 18_200 + 3000], { windowN: 1 }).at(-1), { gapMs: 3000 });
  assert.equal(observeAll([...fastAfterSlow, 18_200 + 3000]).at(-1), null, 'default window: the slow median still holds');
});
