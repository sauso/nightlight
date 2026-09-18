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

function makeTracker(overrides = {}) {
  return createBedTransitionTracker({ activeGraceMs: ACTIVE_GRACE_MS, ...overrides });
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
    { t: 200 + OOB_CONFIRM_QUIET_MS, cribActive: false, outActive: false }, // quiet, exactly at the boundary
  ], true /* believed in bed going in */);
  const confirmed = events.find((e) => e.type === 'oob-confirmed');
  assert.ok(confirmed, 'expected an oob-confirmed event');
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
    { t: 200 + OOB_CONFIRM_QUIET_MS, cribActive: false, outActive: false },
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
    { t: 200 + OOB_CONFIRM_QUIET_MS, cribActive: false, outActive: false }, // cycle 1: confirms
    // cycle 2, still inside OOB_COOLDOWN_MS (120s) of cycle 1 — its confirm is SUPPRESSED
    { t: 10000, cribActive: true, outActive: false, fraction: 0.15 },
    { t: 10200, cribActive: false, outActive: true, outFraction: 0.06 },
    { t: 10200 + OOB_CONFIRM_QUIET_MS, cribActive: false, outActive: false },
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
    { t: 200 + IB_CONFIRM_QUIET_MS, cribActive: true, outActive: false, fraction: 0.02 }, // confirm boundary
  ], false);
  const confirmed = events.find((e) => e.type === 'ib-confirmed');
  assert.ok(confirmed, 'expected an ib-confirmed event');
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
    { t: 200 + IB_CONFIRM_QUIET_MS, cribActive: true, outActive: false, fraction: 0.02 },
    { t: 10000, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 10200, cribActive: true, outActive: false, fraction: 0.06 },
    { t: 10200 + IB_CONFIRM_QUIET_MS, cribActive: true, outActive: false, fraction: 0.02 },
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
    { t: 200 + 3000, cribActive: false, outActive: false }, // OOB's OWN (shorter) window has elapsed
  ]);
  assert.equal(events.filter((e) => e.type === 'oob-confirmed').length, 1, 'OOB must confirm on its own 3000ms window, not IB\'s 9000ms one');
});

test('config: an IB candidate does NOT confirm early on OOB\'s (shorter) window', () => {
  const tracker = makeTracker({ oobConfirmQuietMs: 3000, ibConfirmQuietMs: 9000 });
  const { events } = runFrames(tracker, [
    { t: 0, cribActive: false, outActive: true, outFraction: 0.2 },
    { t: 200, cribActive: true, outActive: false, fraction: 0.06 }, // IB opens
    { t: 200 + 3000, cribActive: true, outActive: false, fraction: 0.02 }, // only OOB's window has elapsed, not IB's
  ]);
  assert.equal(events.filter((e) => e.type === 'ib-confirmed').length, 0, 'IB must wait for its OWN 9000ms window');
});

// --- Config validation -------------------------------------------------------------------------

test('createBedTransitionTracker requires activeGraceMs', () => {
  assert.throws(() => createBedTransitionTracker({}), /activeGraceMs/);
  assert.throws(() => createBedTransitionTracker(), /activeGraceMs/);
});
