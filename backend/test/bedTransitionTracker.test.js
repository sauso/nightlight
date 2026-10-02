// The out-of-bed / into-bed candidate STATE MACHINE — extracted 2026-09-18 from motionDetector.js's
// `handleFrame` closure, which had no test coverage at all (motionDetector.js isn't in `test:core`,
// and the only tests anywhere covered two unrelated pure helpers). `bedTransitionLink.test.js` tests
// the pure decision RULES this machine calls (`oobLinkKind` etc.); this file is the first time the
// actual open/cancel/confirm BRANCHING itself has ever run under a test.
//
// ★★★ THE PERMANENT REGRESSION FIXTURE, below ("a co-active frame opens neither candidate"), encodes
// ROADMAP §1.2 item 3's known, still-open gap: when the bed-zone and outside-zone channels are BOTH
// active in the same frame, no candidate opens on either side and nothing is logged, not even a
// near-miss. Two rounds of adversarial review (2026-09-18, see
// planning/reviews/simultaneous-activity-gap-plan-2026-09-18.md) both rejected attempted fixes to
// this before any were built — this commit is a PURE extraction, not a fix, and this test exists to
// prove exactly that: the gap must survive unchanged. Do not "fix" this test to expect a candidate to
// open; that would mean the extraction silently became a behavior change.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBedTransitionTracker, OOB_CONFIRM_QUIET_MS, OOB_COOLDOWN_MS, IB_CONFIRM_QUIET_MS, IB_COOLDOWN_MS, CO_ACTIVE_LOG_COOLDOWN_MS } from '../src/lib/bedTransitionTracker.js';

const ACTIVE_GRACE_MS = 1500; // mirrors motionDetector.js's own constant, which the tracker never defines itself
// #452: mirrors motionDetector.js's FRAME_GAP_MS (= ACTIVE_GRACE_MS). Passed as its own option so a test can tell
// the two apart (see "the tracker's gap floor is maxFrameGapMs, not activeGraceMs" below).
const MAX_FRAME_GAP_MS = 1500;

function makeTracker(overrides = {}) {
  return createBedTransitionTracker({ activeGraceMs: ACTIVE_GRACE_MS, maxFrameGapMs: MAX_FRAME_GAP_MS, ...overrides });
}

// #452: frames from `from` to `to` INCLUSIVE, `step` ms apart (200 = the real 5 fps), each carrying `flags`.
// A pending exit/entry now confirms only after a quiet window of RECEIVED frames, so the confirm tests below feed
// every frame the window is made of; before #452 they confirmed on one sparse frame 5.8 s after the last, which is
// exactly the defect (a single quiet frame after a hole "proved" six seconds of quiet).
function dense(from, to, flags = {}, step = 200) {
  const out = [];
  for (let t = from; t <= to; t += step) out.push({ t, cribActive: false, outActive: false, ...flags });
  return out;
}

// Drives a sequence of frames through the tracker, threading `believedOccupied` from call to call the
// same way motionDetector.js's outer `let believedOccupied` does. Returns every event with the frame
// time it fired on, plus the final belief.
//
// Frame `t` values in tests are RELATIVE (0, 200, 400, ...) for readability, offset here by a large
// BASE before reaching the tracker: `cribLastActive`/`outLastActive` use 0 as their own "never
// happened" sentinel, so a test whose first active frame is literally `t: 0` would be indistinguishable
// from "this channel has never been active" the moment a later frame checks `cribLastActive > 0`.
const BASE_T = 1_000_000;

function runFrames(tracker, frames, initialBelieved = null) {
  let believed = initialBelieved;
  const events = [];
  for (const f of frames) {
    const t = BASE_T + f.t;
    const res = tracker.pushFrame(
      { cribActive: f.cribActive, outActive: f.outActive, fraction: f.fraction ?? 0, outFraction: f.outFraction ?? 0 },
      t,
      believed
    );
    believed = res.believedOccupied;
    for (const ev of res.events) events.push({ t, ...ev });
  }
  return { events, believedOccupied: believed };
}

// --- OOB: candidate open ------------------------------------------------------------------------

// OOB and IB are independent watchers of the SAME frames (that's ROADMAP §1.2 item 1's whole point —
// nothing stops both firing on data that's ambiguous to one side and not the other), so a frame
// sequence built to exercise OOB can incidentally satisfy an IB near-miss/open condition too, and vice
// versa. These OOB-focused tests assert only on `oob-` events for that reason; cross-talk is real
// production behavior, not a bug in the extraction, and is covered on its own terms in the "co-active
// diagnostic never affects OOB/IB state" test below.
const oobEvents = (events) => events.filter((e) => e.type.startsWith('oob-'));

test('OOB fast link: bed quiets, outside bursts within 8s -> candidate opens', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.15 }, // bed active, sets cribLastActive
    { t: 200, cribActive: false, outActive: true, outFraction: 0.06 }, // bed quiet NOW, outside bursts
  ]);
  const oob = oobEvents(events);
  assert.equal(oob.length, 1);
  assert.equal(oob[0].type, 'oob-candidate-open');
  assert.equal(oob[0].link, 'fast');
});

test('OOB slow link: a big-enough outside burst up to 60s later still opens', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.05 }, // last bed-active frame — the clock starts HERE
    { t: 200, cribActive: false, outActive: false }, // bed goes quiet
    { t: 59800, cribActive: false, outActive: true, outFraction: 0.104 }, // ~60s since last bed activity, real Renz 08-28 figure
  ]);
  const oob = oobEvents(events);
  assert.equal(oob.length, 1);
  assert.equal(oob[0].type, 'oob-candidate-open');
  assert.equal(oob[0].link, 'slow');
});

test('OOB near-miss: outside burst too small for the slow window logs a near-miss, not a candidate', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.05 },
    { t: 200, cribActive: false, outActive: false },
    { t: 59800, cribActive: false, outActive: true, outFraction: 0.012 }, // within the window, below OOB_SLOW_OUT_MIN (0.05)
  ]);
  const oob = oobEvents(events);
  assert.equal(oob.length, 1);
  assert.equal(oob[0].type, 'oob-near-miss');
});

test('OOB near-miss: past OOB_NEARMISS_MS, nothing logs at all — not even a near-miss', () => {
  // Without this bound the "link rejected" diagnostic would re-fire every oobNearMissLogMs forever
  // after the bed last moved, at any elapsed distance — a log flood on a publicly distributed image.
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.05 },
    { t: 200, cribActive: false, outActive: false },
    { t: 180200, cribActive: false, outActive: true, outFraction: 0.9 }, // just past OOB_NEARMISS_MS (180000)
  ]);
  assert.equal(oobEvents(events).length, 0, 'too long since the bed last moved to be worth logging at all');
});

test('OOB near-miss rate limit: a second near-miss inside the log window is suppressed', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.05 },
    { t: 200, cribActive: false, outActive: false },
    { t: 59800, cribActive: false, outActive: true, outFraction: 0.012 },
    { t: 60000, cribActive: false, outActive: true, outFraction: 0.012 }, // 200ms later, well under the 30s log window
  ]);
  assert.equal(oobEvents(events).filter((e) => e.type === 'oob-near-miss').length, 1);
});

// --- OOB: cancel / confirm -----------------------------------------------------------------------

test('OOB cancel: bed re-activates while a candidate is pending', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 200, cribActive: false, outActive: true, outFraction: 0.06 }, // opens
    { t: 400, cribActive: true, outActive: false, fraction: 0.1 }, // bed moves again — still in it
  ]);
  const types = oobEvents(events).map((e) => e.type);
  assert.deepEqual(types, ['oob-candidate-open', 'oob-cancelled']);
});

test('OOB confirm: bed stays quiet for the whole confirm window, and the evidence payload is exact', () => {
  const tracker = makeTracker();
  const { events, believedOccupied } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 200, cribActive: false, outActive: true, outFraction: 0.06 }, // opens; oobEvidence: peak=0.06 frames=1
    { t: 400, cribActive: false, outActive: true, outFraction: 0.09 }, // still pending; peak=0.09 frames=2
    ...dense(600, 200 + OOB_CONFIRM_QUIET_MS), // quiet 5 fps frames up to exactly the boundary (#452: every frame of the window)
  ], true /* believed in bed going in */);
  const confirmed = events.find((e) => e.type === 'oob-confirmed');
  assert.ok(confirmed, 'expected an oob-confirmed event');
  assert.equal(confirmed.t, BASE_T + 200 + OOB_CONFIRM_QUIET_MS, 'on the boundary frame, not before');
  // For out_of_bed, peak and outPeak are the SAME quantity by design (db.js: "peak for out_of_bed IS
  // the outside peak") — pinned separately anyway so a future change to that equivalence goes red here.
  assert.equal(confirmed.peak, 0.09);
  assert.equal(confirmed.outPeak, 0.09);
  assert.equal(confirmed.outFrames, 2, 'only the two ACTIVE outside frames count, not the quiet ones');
  assert.equal(believedOccupied, false, 'a confirmed exit flips belief to out-of-bed');
  assert.equal(events.some((e) => e.type === 'oob-impossible-flag'), false, 'was correctly believed in bed, no flag');
});

test('OOB impossible-flag: confirms anyway (log-only), per item 1\'s own rejected-suppression finding', () => {
  const tracker = makeTracker();
  const { events, believedOccupied } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 200, cribActive: false, outActive: true, outFraction: 0.06 },
    ...dense(400, 200 + OOB_CONFIRM_QUIET_MS),
  ], false /* already believed OUT of bed — an exit now is "impossible" */);
  assert.ok(events.some((e) => e.type === 'oob-impossible-flag'));
  assert.ok(events.some((e) => e.type === 'oob-confirmed'), 'must still confirm — log-only means it flags, never suppresses');
  assert.equal(believedOccupied, false);
});

test('OOB cooldown: a suppressed confirm still resets the pending state (a third candidate can open right after it)', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 200, cribActive: false, outActive: true, outFraction: 0.06 },
    ...dense(400, 200 + OOB_CONFIRM_QUIET_MS), // cycle 1: confirms on its last frame
    // cycle 2, still inside OOB_COOLDOWN_MS (120s) of cycle 1 — its confirm is SUPPRESSED
    { t: 10000, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 10200, cribActive: false, outActive: true, outFraction: 0.06 },
    ...dense(10400, 10200 + OOB_CONFIRM_QUIET_MS),
    // cycle 3, right after cycle 2's SUPPRESSED confirm — this can only open at all if the suppressed
    // confirm still reset oobPendingAt/oobEvidence; if the reset were moved inside the cooldown-gated
    // branch, oobPendingAt would stay set forever and this candidate would never open.
    { t: 20000, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 20200, cribActive: false, outActive: true, outFraction: 0.06 },
  ]);
  const confirms = events.filter((e) => e.type === 'oob-confirmed');
  assert.equal(confirms.length, 1, 'cycles 2 AND 3 are both still inside cycle 1\'s cooldown');
  const opens = events.filter((e) => e.type === 'oob-candidate-open');
  assert.equal(opens.length, 3, 'all three candidates opened — cycle 2\'s SUPPRESSED confirm still reset the pending state for cycle 3');
});

// --- IB: candidate open / near-miss ---------------------------------------------------------------

test('IB: outside quiets, bed bursts within 8s -> entry candidate opens', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 200, cribActive: true, outActive: false, fraction: 0.06 },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ib-candidate-open');
});

test('IB near-miss: bed goes active from idle with no outside link and belief != true', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    // bed idle long enough (> ACTIVE_GRACE_MS) with nothing recently on either channel, then bed moves
    { t: 0, cribActive: true, outActive: false, fraction: 0.05 },
  ], false /* believed out of bed */);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ib-near-miss');
});

test('IB near-miss does NOT fire when already believed in bed (ordinary stirring)', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.05 },
  ], true);
  assert.equal(events.length, 0, 'stirring by an already-believed-occupied child must not re-log');
});

test('IB link boundary: exactly IB_LINK_MS opens, one ms later does not', () => {
  // IB has no slow window (deliberately, unlike OOB — "a child cannot put himself to bed, so an entry
  // is always someone carrying him"), so this one boundary is the whole of its timing rule.
  const atBoundary = makeTracker();
  const onTime = runFrames(atBoundary, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 8000, cribActive: true, outActive: false, fraction: 0.06 }, // exactly IB_LINK_MS later
  ]);
  assert.equal(onTime.events.filter((e) => e.type === 'ib-candidate-open').length, 1, 'boundary is inclusive');

  const pastBoundary = makeTracker();
  const late = runFrames(pastBoundary, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 8001, cribActive: true, outActive: false, fraction: 0.06 }, // one ms past IB_LINK_MS
  ]);
  assert.equal(late.events.filter((e) => e.type === 'ib-candidate-open').length, 0, 'one ms past the link window, no candidate — IB has no slow window to fall back on');
});

test('IB near-miss rate limit: a genuinely NEW idle episode within the 30s log window is still suppressed', () => {
  // Isolates the rate limiter from cribWasIdle: the bed goes properly idle between the two frames
  // (gap > ACTIVE_GRACE_MS, so cribWasIdle is TRUE both times, and would allow a second near-miss on
  // its own merits) — only ibNearMissLogMs stands between them here.
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.05 }, // near-miss #1
    { t: 2000, cribActive: false, outActive: false }, // bed goes quiet — a real gap opens
    { t: 5000, cribActive: true, outActive: false, fraction: 0.05 }, // idle 5000ms > ACTIVE_GRACE_MS, but well under 30s
  ], false);
  assert.equal(events.filter((e) => e.type === 'ib-near-miss').length, 1, 'the 30s log window, not cribWasIdle, must suppress this one');
});

test('IB near-miss cribWasIdle: does NOT fire on a continuing run, even once the 30s rate-limit window has long passed', () => {
  // Isolates cribWasIdle from the rate limiter: every frame is within ACTIVE_GRACE_MS of the last (a
  // single unbroken motion run — the bed never actually goes idle), spanning well past ibNearMissLogMs
  // (30s). If cribWasIdle's own guard were deleted, only the rate limiter would be left standing, and
  // by t=31000 that limiter has long since expired — a second near-miss would wrongly fire.
  const tracker = makeTracker();
  const frames = [{ t: 0, cribActive: true, outActive: false, fraction: 0.05 }]; // near-miss #1
  for (let t = 1000; t <= 31000; t += 1000) {
    frames.push({ t, cribActive: true, outActive: false, fraction: 0.05 }); // gaps of 1000ms < ACTIVE_GRACE_MS
  }
  const { events } = runFrames(tracker, frames, false);
  assert.equal(events.filter((e) => e.type === 'ib-near-miss').length, 1, 'cribWasIdle alone must suppress this, 31s into one unbroken run');
});

// --- IB: cancel / confirm --------------------------------------------------------------------------

test('IB cancel: outside re-activates while a candidate is pending', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 200, cribActive: true, outActive: false, fraction: 0.06 }, // opens
    { t: 400, cribActive: true, outActive: true, fraction: 0.06, outFraction: 0.1 }, // parent still there
  ]);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['ib-candidate-open', 'ib-cancelled']);
});

test('IB confirm: outside stays quiet for the whole confirm window, and peak/outPeak are NOT interchangeable', () => {
  const tracker = makeTracker();
  // Deliberately distinct bed-channel vs outside-lead-up-channel values throughout, so a swap between
  // `peak` (bed) and `outPeak` (outside lead-up) — the exact asymmetric-field corruption db.js's own
  // comment warns a refactor can introduce — fails this test instead of passing it silently.
  const { events, believedOccupied } = runFrames(tracker, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 }, // lead-up sample: outside peak 0.2
    { t: 200, cribActive: true, outActive: false, fraction: 0.06 }, // opens; ibPeakCrib=0.06
    { t: 400, cribActive: true, outActive: false, fraction: 0.09 }, // still pending; ibPeakCrib rises to 0.09
    ...dense(600, 200 + IB_CONFIRM_QUIET_MS, { cribActive: true, fraction: 0.02 }), // outside quiet 5 fps frames to the boundary (#452)
  ], false);
  const confirmed = events.find((e) => e.type === 'ib-confirmed');
  assert.ok(confirmed, 'expected an ib-confirmed event');
  assert.equal(confirmed.t, BASE_T + 200 + IB_CONFIRM_QUIET_MS, 'on the boundary frame, not before');
  assert.equal(confirmed.peak, 0.09, 'bed-channel peak — the highest fraction seen while pending');
  assert.equal(confirmed.outPeak, 0.2, 'outside-channel LEAD-UP peak, frozen at open time — NOT the bed value');
  assert.equal(confirmed.outFrames, 1, 'exactly one active outside sample in the frozen lead-up window');
  assert.equal(believedOccupied, true);
});

test('IB cooldown: a second confirm inside the cooldown window is suppressed', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 200, cribActive: true, outActive: false, fraction: 0.06 },
    ...dense(400, 200 + IB_CONFIRM_QUIET_MS, { cribActive: true, fraction: 0.02 }),
    { t: 10000, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 10200, cribActive: true, outActive: false, fraction: 0.06 },
    ...dense(10400, 10200 + IB_CONFIRM_QUIET_MS, { cribActive: true, fraction: 0.02 }),
  ]);
  assert.equal(events.filter((e) => e.type === 'ib-confirmed').length, 1);
});

// --- ★★★ THE PERMANENT REGRESSION FIXTURE — ROADMAP §1.2 item 3's known gap, unchanged by this extraction ---

test('a co-active frame opens NEITHER candidate, and logs nothing on either side (the known gap)', () => {
  const tracker = makeTracker();
  // Mirrors the real Raffa 2026-09-15 incident's activity_samples shape: bed and outside both active
  // together for several frames, then both drop to quiet together — no clean sequencing on either side.
  const frames = [];
  for (let i = 0; i < 20; i++) {
    frames.push({ t: i * 200, cribActive: true, outActive: true, fraction: 0.18, outFraction: 0.05 });
  }
  const { events } = runFrames(tracker, frames, true);
  assert.equal(events.filter((e) => e.type.startsWith('oob-')).length, 0, 'no OOB event of any kind, including near-miss');
  assert.equal(events.filter((e) => e.type.startsWith('ib-')).length, 0, 'no IB event of any kind, including near-miss');
});

// --- Co-active diagnostic (purely observational, added alongside the extraction) -------------------

test('co-active episode: both channels quiet together -> quietSide "both"', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: true, fraction: 0.18, outFraction: 0.05 },
    { t: 200, cribActive: true, outActive: true, fraction: 0.2, outFraction: 0.06 },
    { t: 400, cribActive: false, outActive: false }, // both drop together
  ]);
  const ep = events.find((e) => e.type === 'co-active-episode');
  assert.ok(ep);
  assert.equal(ep.quietSide, 'both');
  assert.equal(ep.durationMs, 400); // from first co-active frame (t=0) to the resolving frame (t=400)
  assert.ok(Math.abs(ep.cribPeak - 0.2) < 1e-9);
  assert.ok(Math.abs(ep.outPeak - 0.06) < 1e-9);
});

test('co-active episode: bed quiets first, outside still active -> quietSide "bed"', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: true, fraction: 0.15, outFraction: 0.05 },
    { t: 200, cribActive: false, outActive: true, outFraction: 0.05 },
  ]);
  const ep = events.find((e) => e.type === 'co-active-episode');
  assert.ok(ep);
  assert.equal(ep.quietSide, 'bed');
});

test('co-active episode: outside quiets first, bed still active -> quietSide "outside"', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: true, fraction: 0.15, outFraction: 0.05 },
    { t: 200, cribActive: true, outActive: false, fraction: 0.15 },
  ]);
  const ep = events.find((e) => e.type === 'co-active-episode');
  assert.ok(ep);
  assert.equal(ep.quietSide, 'outside');
});

test('co-active episode rate limit: a second resolved episode inside the cooldown is not logged', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: true, fraction: 0.15, outFraction: 0.05 },
    { t: 200, cribActive: false, outActive: false }, // first episode resolves, logs
    { t: 400, cribActive: true, outActive: true, fraction: 0.15, outFraction: 0.05 }, // a second, brief episode
    { t: 600, cribActive: false, outActive: false }, // resolves well within CO_ACTIVE_LOG_COOLDOWN_MS
  ]);
  assert.equal(events.filter((e) => e.type === 'co-active-episode').length, 1);
});

test('co-active episode logs again once the cooldown has elapsed', () => {
  const tracker = makeTracker();
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: true, fraction: 0.15, outFraction: 0.05 },
    { t: 200, cribActive: false, outActive: false },
    { t: 200 + CO_ACTIVE_LOG_COOLDOWN_MS, cribActive: true, outActive: true, fraction: 0.15, outFraction: 0.05 },
    { t: 400 + CO_ACTIVE_LOG_COOLDOWN_MS, cribActive: false, outActive: false },
  ]);
  assert.equal(events.filter((e) => e.type === 'co-active-episode').length, 2);
});

test('the co-active diagnostic never affects OOB/IB state even when interleaved with real candidates', () => {
  const tracker = makeTracker();
  // A co-active blip, THEN a clean OOB sequence — the blip must not leave any state that changes the
  // clean sequence's outcome.
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: true, fraction: 0.15, outFraction: 0.05 },
    { t: 200, cribActive: false, outActive: false }, // co-active episode resolves
    { t: 2000, cribActive: true, outActive: false, fraction: 0.15 }, // clean sequence begins
    { t: 2200, cribActive: false, outActive: true, outFraction: 0.06 }, // opens
  ]);
  const opens = events.filter((e) => e.type === 'oob-candidate-open');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].link, 'fast');
});

// --- Config knobs really are wired to the side they're named for -------------------------------
//
// Every override defaults to the SAME value on both sides in production (both confirm windows are
// 6000ms, both cooldowns 120000ms, both near-miss log windows 30000ms) — which means a bug that reads
// `ibConfirmQuietMs` inside the OOB branch (or any other same-direction swap) is invisible unless a
// test actually injects DISTINCT values per side and confirms each fires on ITS OWN timer.

test('config: oobConfirmQuietMs and ibConfirmQuietMs are not interchangeable', () => {
  const tracker = makeTracker({ oobConfirmQuietMs: 3000, ibConfirmQuietMs: 9000 });
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 200, cribActive: false, outActive: true, outFraction: 0.06 }, // OOB opens
    ...dense(400, 200 + 3000), // OOB's OWN (shorter) window has elapsed (#452: as a run of received frames)
  ]);
  assert.equal(events.filter((e) => e.type === 'oob-confirmed').length, 1, 'OOB must confirm on its own 3000ms window, not IB\'s 9000ms one');
});

test('config: an IB candidate does NOT confirm early on OOB\'s (shorter) window', () => {
  const tracker = makeTracker({ oobConfirmQuietMs: 3000, ibConfirmQuietMs: 9000 });
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 200, cribActive: true, outActive: false, fraction: 0.06 }, // IB opens
    // #452: dense frames, so this is a real 3 s of received quiet. (Before #452 a single sparse frame at 3200
    // stood in for it; that frame would now be a GAP and restart the window, which would make the assertion
    // below pass for the wrong reason, so the stream is made continuous to keep it testing the window itself.)
    ...dense(400, 200 + 3000, { cribActive: true, fraction: 0.02 }), // only OOB's window has elapsed, not IB's
  ]);
  assert.equal(events.filter((e) => e.type === 'ib-confirmed').length, 0, 'IB must wait for its OWN 9000ms window');
  // ...and it does confirm on that window, so the assertion above is not vacuous.
  const later = runFrames(makeTracker({ oobConfirmQuietMs: 3000, ibConfirmQuietMs: 9000 }), [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 200, cribActive: true, outActive: false, fraction: 0.06 },
    ...dense(400, 200 + 9000, { cribActive: true, fraction: 0.02 }),
  ]);
  assert.equal(later.events.find((e) => e.type === 'ib-confirmed')?.t, BASE_T + 200 + 9000);
});

// --- Config validation -------------------------------------------------------------------------

test('createBedTransitionTracker requires activeGraceMs', () => {
  assert.throws(() => createBedTransitionTracker({}), /activeGraceMs/);
  assert.throws(() => createBedTransitionTracker(), /activeGraceMs/);
});

test('#452: createBedTransitionTracker requires maxFrameGapMs (an omitted value is a caller bug, not a disabled fix)', () => {
  assert.throws(() => createBedTransitionTracker({ activeGraceMs: ACTIVE_GRACE_MS }), /maxFrameGapMs/);
  assert.throws(() => createBedTransitionTracker({ activeGraceMs: ACTIVE_GRACE_MS, maxFrameGapMs: 0 }), /maxFrameGapMs/);
});

// --- #452: a pending exit/entry does not confirm across a sampling outage ---------------------------------------
//
// Acceptance criterion (b): a single quiet frame right after a long gap cannot by itself prove several seconds of
// observed quiet. The rule under test: a frame that arrives after a gap (createFrameGapDetector, bedTransitionRules.js)
// RESTARTS a pending candidate's quiet clock ("reset", not suspend, not cancel), and a candidate confirms only after
// the full confirm window of frames RECEIVED since. Candidate OPENING and the links are deliberately unchanged.
// Everything runs once per side, because the two sides are separate branches with separate state (oobQuietFrom /
// ibQuietFrom) and a fix to one is invisible from the other.
const quietFrame = (t) => ({ t, cribActive: false, outActive: false });
const ofType = (events, type) => events.filter((e) => e.type === type);
const SIDES = [
  {
    name: 'OOB', pre: 'oob', ms: OOB_CONFIRM_QUIET_MS, option: 'oobConfirmQuietMs',
    // the bed moves (t 0), then the outside bursts (t 200): the candidate opens at 200
    open: [{ t: 0, cribActive: true, outActive: false, fraction: 0.15 }, { t: 200, cribActive: false, outActive: true, outFraction: 0.06 }],
    cancel: (t) => ({ t, cribActive: true, outActive: false, fraction: 0.1 }), // the bed moves again: OOB's cancel
    reopen: (t) => ({ t, cribActive: false, outActive: true, outFraction: 0.06 }),
    reopenAt: 31_600, // 10.2 s after the cancel: OOB's SLOW link (60 s) at 6%
  },
  {
    name: 'IB', pre: 'ib', ms: IB_CONFIRM_QUIET_MS, option: 'ibConfirmQuietMs',
    // the outside moves (t 0), then the bed (t 200): the candidate opens at 200
    open: [{ t: 0, cribActive: false, outActive: true, outFraction: 0.2 }, { t: 200, cribActive: true, outActive: false, fraction: 0.06 }],
    cancel: (t) => ({ t, cribActive: false, outActive: true, outFraction: 0.1 }), // the outside moves again: IB's cancel
    reopen: (t) => ({ t, cribActive: true, outActive: false, fraction: 0.06 }),
    reopenAt: 27_200, // 5.8 s after the cancel: inside IB's only (8 s) link
  },
];

for (const side of SIDES) {
  const type = (name) => `${side.pre}-${name}`;

  test(`#452 ${side.name} (b): ONE quiet frame after a 20 s gap cannot confirm a pending candidate, and the restart is reported with its length`, () => {
    const { events } = runFrames(makeTracker(), [...side.open, ...dense(400, 1200), quietFrame(21_200)]);
    assert.equal(ofType(events, type('confirmed')).length, 0, '21 s since it opened, but only one frame received after the hole');
    const restarts = ofType(events, type('confirm-restarted'));
    assert.equal(restarts.length, 1);
    assert.equal(restarts[0].gapMs, 20_000);
    assert.equal(restarts[0].t, BASE_T + 21_200);
  });

  test(`#452 ${side.name}: the restart needs the FULL window of frames received AFTER the gap (reset, not cancel: it then confirms)`, () => {
    const { events } = runFrames(makeTracker(), [...side.open, ...dense(400, 1200), ...dense(21_200, 21_200 + side.ms)]);
    // Exactly one confirm, on the frame `ms` after the gap frame: not at +ms-200 (a suspend or a gap that credits
    // itself), and not never (a restart that cancels the candidate, which would lose a real exit).
    assert.deepEqual(ofType(events, type('confirmed')).map((e) => e.t), [BASE_T + 21_200 + side.ms]);
  });

  test(`#452 ${side.name}: a clump of frames sharing the gap frame's receipt time credits nothing`, () => {
    // After an outage ffmpeg releases a clump of frames in ONE read, all with the same receipt time. 50 of them
    // are still only the gap frame's instant: the window starts there and needs `ms` of RECEIVED time.
    const clump = Array.from({ length: 50 }, () => quietFrame(21_200));
    const { events } = runFrames(makeTracker(), [...side.open, ...dense(400, 1200), ...clump, ...dense(21_400, 21_200 + side.ms)]);
    assert.equal(ofType(events, type('confirm-restarted')).length, 1, 'only the first frame of the clump is late; the rest are the same instant');
    assert.deepEqual(ofType(events, type('confirmed')).map((e) => e.t), [BASE_T + 21_200 + side.ms]);
  });

  test(`#452 ${side.name}: NOT suspend. Almost a full window of quiet, a hole, one quiet frame: no confirm`, () => {
    // 5.8 s of quiet banked, then a 60 s hole. A suspend (keep the 5.8 s, resume after) would confirm on the next
    // frame; a reset credits none of it.
    const { events } = runFrames(makeTracker(), [...side.open, ...dense(400, side.ms), quietFrame(66_000)]);
    assert.equal(ofType(events, type('confirmed')).length, 0);
    assert.equal(ofType(events, type('confirm-restarted')).length, 1);
  });

  test(`#452 ${side.name}: the gap floor is exact. A 1500 ms spacing is continuous (confirms on time), 1501 ms is a gap`, () => {
    const onTime = runFrames(makeTracker(), [...side.open, quietFrame(200 + 1500), quietFrame(1800), ...dense(2000, 200 + side.ms)]);
    assert.equal(ofType(onTime.events, type('confirm-restarted')).length, 0, '1500 ms: not a gap');
    assert.deepEqual(ofType(onTime.events, type('confirmed')).map((e) => e.t), [BASE_T + 200 + side.ms], 'confirmed on its own window');
    const late = runFrames(makeTracker(), [...side.open, quietFrame(200 + 1501)]);
    assert.deepEqual(ofType(late.events, type('confirm-restarted')).map((e) => e.gapMs), [1501], '1501 ms: a gap');
  });

  test(`#452 ${side.name}: activity still cancels on a frame that arrives after a gap (and pendingForMs stays wall time)`, () => {
    // The gap frame ITSELF is the active one: a cancel needs no continuity, so it must not become a restart.
    const onGap = runFrames(makeTracker(), [...side.open, ...dense(400, 1200), side.cancel(21_200)]);
    assert.deepEqual(onGap.events.filter((e) => e.type.startsWith(`${side.pre}-`)).map((e) => e.type), [type('candidate-open'), type('cancelled')]);
    assert.equal(ofType(onGap.events, type('cancelled'))[0].pendingForMs, 21_000, 'wall time since it opened');
    // A restart first, a cancel after it: pendingForMs is still counted from the OPEN, not from the restart.
    const after = runFrames(makeTracker(), [...side.open, ...dense(400, 1200), quietFrame(21_200), side.cancel(21_400)]);
    assert.equal(ofType(after.events, type('confirm-restarted')).length, 1);
    assert.equal(ofType(after.events, type('cancelled'))[0].pendingForMs, 21_400 - 200);
  });

  test(`#452 ${side.name}: a restart does not leak into the NEXT candidate, which confirms at exactly its own open + window`, () => {
    // Candidate 1 restarts at 21200 and is cancelled at 21400; the stream then idles (quiet, continuous) until
    // candidate 2 opens. Candidate 2 has to confirm `ms` after ITS open: not early (a stale quiet clock from
    // candidate 1) and not late (a gap detector that only sees frames while something is pending would call the
    // idle stretch since the last pending frame a gap and restart candidate 2 on its first frame).
    const { events } = runFrames(makeTracker(), [
      ...side.open, ...dense(400, 1200), quietFrame(21_200), side.cancel(21_400),
      ...dense(21_600, side.reopenAt - 200),
      side.reopen(side.reopenAt),
      ...dense(side.reopenAt + 200, side.reopenAt + side.ms),
    ]);
    assert.equal(ofType(events, type('candidate-open')).length, 2);
    assert.equal(ofType(events, type('confirm-restarted')).length, 1, 'only candidate 1 restarted');
    assert.deepEqual(ofType(events, type('confirmed')).map((e) => e.t), [BASE_T + side.reopenAt + side.ms]);
  });

  test(`#452 ${side.name}: a backward wall-clock step while pending is a gap (negative gapMs): it restarts once, never confirms early`, () => {
    const { events } = runFrames(makeTracker(), [...side.open, ...dense(400, 1200), quietFrame(800), ...dense(1000, 800 + side.ms)]);
    assert.deepEqual(ofType(events, type('confirm-restarted')).map((e) => e.gapMs), [-400]);
    assert.deepEqual(ofType(events, type('confirmed')).map((e) => e.t), [BASE_T + 800 + side.ms], 'a window counted from the stepped-back time');
  });

  test(`#452 ${side.name}: candidate OPENING across a gap is unchanged (the gap frame opens it, and it confirms at exactly open + window)`, () => {
    // Deliberately NOT changed: a real exit/entry during an outage is the case worth keeping. The bed (or outside)
    // moves at 0, the stream is quiet and continuous to 1000, then a 2 s hole (a gap), and the OTHER channel moves on
    // the first frame back. Also kills a gap detector that is only updated while something is pending.
    const gapFrame = { ...side.open[1], t: 3000 };
    const { events } = runFrames(makeTracker(), [side.open[0], ...dense(200, 1000), gapFrame, ...dense(3200, 3000 + side.ms)]);
    assert.deepEqual(ofType(events, type('candidate-open')).map((e) => e.t), [BASE_T + 3000]);
    assert.equal(ofType(events, type('confirm-restarted')).length, 0, 'the frame that OPENED it is not also a restart');
    assert.deepEqual(ofType(events, type('confirmed')).map((e) => e.t), [BASE_T + 3000 + side.ms]);
  });

  test(`#452 ${side.name}: a gap while NOTHING is pending produces no event at all`, () => {
    const { events } = runFrames(makeTracker(), [quietFrame(0), quietFrame(200), quietFrame(60_000), quietFrame(60_200)]);
    assert.deepEqual(events, [], 'a healthy or idle stream gains no noise');
  });

  test(`#452 ${side.name}: steady-state is unchanged: continuous and jittery (under 1.5 s) streams confirm at the first frame at or after open + window, with no restart`, () => {
    // 200 ms steps; and a jittery cadence whose every delta is at or under the floor.
    for (const deltas of [[200], [200, 120, 900, 1400, 40, 200, 700]]) {
      const frames = [...side.open];
      let t = 200;
      let expected = null;
      for (let i = 0; expected === null; i += 1) {
        t += deltas[i % deltas.length];
        frames.push(quietFrame(t));
        if (t >= 200 + side.ms) expected = t;
      }
      const { events } = runFrames(makeTracker(), frames);
      assert.equal(ofType(events, type('confirm-restarted')).length, 0, `deltas ${deltas}`);
      assert.deepEqual(ofType(events, type('confirmed')).map((e) => e.t), [BASE_T + expected], `deltas ${deltas}`);
    }
  });

  test(`#452 ${side.name}: the tracker's gap floor is maxFrameGapMs, NOT activeGraceMs`, () => {
    // The two answer different questions and only happen to be equal today. A 3000 ms hole is a gap on a floor of
    // 1500 but not on 5000; a 1200 ms one is a gap on a floor of 1000 but not on the default 1500.
    const wide = runFrames(makeTracker({ activeGraceMs: 1500, maxFrameGapMs: 5000 }), [...side.open, ...dense(400, 1000), quietFrame(4000), ...dense(4200, 200 + side.ms)]);
    assert.equal(ofType(wide.events, type('confirm-restarted')).length, 0, 'under maxFrameGapMs 5000 a 3 s hole is continuous');
    assert.deepEqual(ofType(wide.events, type('confirmed')).map((e) => e.t), [BASE_T + 200 + side.ms]);
    const narrow = runFrames(makeTracker({ activeGraceMs: 1500, maxFrameGapMs: 1000 }), [...side.open, ...dense(400, 1000), quietFrame(2200)]);
    assert.deepEqual(ofType(narrow.events, type('confirm-restarted')).map((e) => e.gapMs), [1200], 'over maxFrameGapMs 1000 a 1.2 s hole is a gap');
  });

  test(`#452 ${side.name}: a slow camera (2 s bursts) still confirms, after ~9 warm-up restarts: the bound adapts, a real stall in it is still a gap`, () => {
    // Bursts of 5 frames sharing one receipt time, one burst every 2 s (0.5 fps). Against the 1500 ms floor alone
    // EVERY burst would be a gap and nothing could ever confirm. The detector reads nothing until its window holds 9
    // deltas (round-1 fix: one stall right after a launch must not be "typical"), so the first 9 intervals are judged
    // against the floor and each RESTARTS the pending confirmation; after that the bound is 5 x 2 s.
    // The candidate opens at 200 (the open frames contribute one 200 ms delta to the window), then bursts arrive at
    // 2200, 4200, ... Burst j (1-based) is judged with j deltas held. Bursts 1 to 8 are gaps (fewer than 9 held);
    // burst 9 is a gap too: 9 are held ([200, 2000 x 8]) but only 8 are long, so the 9th largest is the 200 ms
    // delta and the bound is still the floor; from burst 10 ([200, 2000 x 9]) the 9th largest is 2000: no gap.
    // So 9 restarts, the last at 18200, and an exit confirms at 18200 + 6000 = 24200 = open + 24 s (the plain median
    // of what the window held used to cost 2 restarts, which is exactly the defect, see the next test).
    const burstsTo = (end) => {
      const out = [];
      for (let t = 2200; t <= end; t += 2000) for (let i = 0; i < 5; i += 1) out.push(quietFrame(t));
      return out;
    };
    const warmup = Array.from({ length: 9 }, (_, i) => BASE_T + 2200 + i * 2000); // 2200, 4200, ... 18200
    const ok = runFrames(makeTracker(), [...side.open, ...burstsTo(40_200)]);
    assert.deepEqual(ofType(ok.events, type('confirm-restarted')).map((e) => e.t), warmup, 'only the 9 learning bursts restart');
    // The last restart was at 18200, so it confirms on the first burst at or after 18200 + window: it DOES confirm.
    const firstBurstAfter = 18_200 + Math.ceil(side.ms / 2000) * 2000;
    assert.deepEqual(ofType(ok.events, type('confirmed')).map((e) => e.t), [BASE_T + firstBurstAfter]);
    // A 6 s hole in that cadence is not a gap (inside the learnt 10 s bound); a 20 s stall is. Both after burst 10.
    const hole = runFrames(makeTracker(), [...side.open, ...burstsTo(20_200), quietFrame(26_200)]);
    assert.equal(ofType(hole.events, type('confirm-restarted')).length, 9, 'no new restart: only the nine learning bursts');
    const stall = runFrames(makeTracker(), [...side.open, ...burstsTo(20_200), quietFrame(40_200)]);
    assert.equal(ofType(stall.events, type('confirm-restarted')).length, 10, 'a 20 s stall is a gap even at 0.5 fps');
    assert.equal(ofType(stall.events, type('confirmed')).length, 0, 'and one frame after it still confirms nothing');
  });

  // ★ REGRESSION (#452 code review round 1, verified by running): the first stall after a launch used to BE the median
  // and widen the bound for the next frame, so one quiet frame after a 30 s outage confirmed a candidate. The
  // candidate opens on a frame that follows a wide spacing (OOB's 60 s slow link, IB's 8 s link), the stream then has
  // ONE long delta in its window, and a 30 s hole follows.
  test(`#452 ${side.name}: a lone stall after a launch does not widen the bound, so ONE quiet frame after a 30 s outage cannot confirm`, () => {
    const openAt = side.name === 'OOB' ? 20_000 : 7_000; // the delta into the open frame is the window's only entry
    const frames = [{ ...side.open[0], t: 0 }, { ...side.open[1], t: openAt }, quietFrame(openAt + 30_000)];
    const { events } = runFrames(makeTracker(), frames);
    assert.deepEqual(ofType(events, type('candidate-open')).map((e) => e.t), [BASE_T + openAt], 'it opened across the first wide spacing');
    assert.equal(ofType(events, type('confirmed')).length, 0, '30 s since it opened, one frame received after the hole');
    assert.deepEqual(ofType(events, type('confirm-restarted')).map((e) => e.gapMs), [30_000], 'a restart, judged against the floor');
  });

  // Kills a QuietFrom offset of 1 to 199 ms at the restart AND at the open (a confirm test of `now - quietFrom >= ms`
  // with `quietFrom = now - d` confirms d ms early; the other tests feed 200 ms steps, which hide any d under 200
  // because the first frame at or after the earlier time is the same one). Frames at +5800, +5801, +5900, +5999 are
  // all received and must credit nothing; the frame at exactly +ms confirms.
  test(`#452 ${side.name}: the quiet clock credits EXACTLY 0 ms at the open and at a restart (no confirm at +${side.ms - 1}, confirm at +${side.ms})`, () => {
    const fine = (g) => [
      ...dense(g + 200, g + side.ms - 200),
      quietFrame(g + side.ms - 199), quietFrame(g + side.ms - 100), quietFrame(g + side.ms - 1),
    ];
    // (1) at the open: the candidate opens at 200, then a continuous stream with the probe frames.
    const atOpen = runFrames(makeTracker(), [...side.open, ...fine(200), quietFrame(200 + side.ms)]);
    assert.equal(ofType(atOpen.events, type('confirm-restarted')).length, 0, 'continuous: no restart');
    assert.deepEqual(ofType(atOpen.events, type('confirmed')).map((e) => e.t), [BASE_T + 200 + side.ms], 'exactly open + window');
    // (2) at a restart: a 20 s hole, the gap frame at 21200, then the same probes from there.
    const atRestart = runFrames(makeTracker(), [...side.open, ...dense(400, 1200), quietFrame(21_200), ...fine(21_200), quietFrame(21_200 + side.ms)]);
    assert.equal(ofType(atRestart.events, type('confirm-restarted')).length, 1, 'only the hole restarts it');
    assert.deepEqual(ofType(atRestart.events, type('confirmed')).map((e) => e.t), [BASE_T + 21_200 + side.ms], 'exactly gap frame + window');
  });
}
