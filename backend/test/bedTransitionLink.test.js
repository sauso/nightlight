// The out-of-bed link rule. This is the whole of what decides whether a bed-to-outside movement even
// becomes a candidate exit, and until 2026-08-28 it was a single 8-second window buried in the ffmpeg
// frame loop — untestable, and therefore able to miss every unaided climb-out for months without
// anything going red. `oobLinkKind` is that rule, extracted; these are the cases that matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { oobLinkKind } from '../src/lib/motionDetector.js';

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
