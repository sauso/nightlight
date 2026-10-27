// The "up between X and Y" rule (lib/wakeRange.js), pure. Every case here is one reason the app shows ONE
// wake time instead of two, or the boundary where it starts showing two. The routes, the push line and the
// screens that consume it are pinned in wake-range-routes.test.js, sleepReportNotify.test.js and the frontend.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeRange, RANGE_MIN_MIN } from '../src/lib/wakeRange.js';

// A scored, finished, uncorrected night with the two estimates 40 minutes apart; each case changes one thing.
const NIGHT = { status: 'ok', wake_at_algo: '2026-07-01 20:10:00', wake_at: '2026-07-01 20:50:00' };
const night = (over) => ({ ...NIGHT, ...over });

test('the threshold is the scoreboard\'s 10 minutes', () => {
  assert.equal(RANGE_MIN_MIN, 10);
});

test('★ two estimates 40 minutes apart give a range, earlier time first, with the original strings', () => {
  assert.deepEqual(wakeRange(NIGHT), { from: '2026-07-01 20:10:00', to: '2026-07-01 20:50:00' });
});

test('★ the order never matters: the movement-only wake may be the later one (swapped)', () => {
  assert.deepEqual(
    wakeRange(night({ wake_at_algo: '2026-07-01 20:50:00', wake_at: '2026-07-01 20:10:00' })),
    { from: '2026-07-01 20:10:00', to: '2026-07-01 20:50:00' },
  );
});

test('★ the 10-minute edge: 9 min 59 s is no range, exactly 10 min is, 10 min 1 s is', () => {
  const base = '2026-07-01 20:00:00';
  assert.equal(wakeRange(night({ wake_at_algo: base, wake_at: '2026-07-01 20:09:59' })), null, '9 min 59 s');
  assert.deepEqual(wakeRange(night({ wake_at_algo: base, wake_at: '2026-07-01 20:10:00' })), { from: base, to: '2026-07-01 20:10:00' }, 'exactly 10 min');
  assert.deepEqual(wakeRange(night({ wake_at_algo: base, wake_at: '2026-07-01 20:10:01' })), { from: base, to: '2026-07-01 20:10:01' }, '10 min 1 s');
  // The same edges with the order swapped, so an asymmetric comparison (a - b >= limit) cannot pass.
  assert.equal(wakeRange(night({ wake_at_algo: '2026-07-01 20:09:59', wake_at: base })), null, '9 min 59 s, swapped');
  assert.ok(wakeRange(night({ wake_at_algo: '2026-07-01 20:10:00', wake_at: base })), 'exactly 10 min, swapped');
});

test('the same value, and a difference of seconds, is no range', () => {
  assert.equal(wakeRange(night({ wake_at_algo: NIGHT.wake_at })), null);
  assert.equal(wakeRange(night({ wake_at_algo: '2026-07-01 20:49:30' })), null);
});

test('★ no movement-only estimate (a still child) is no range: the worst nights show one time', () => {
  assert.equal(wakeRange(night({ wake_at_algo: null })), null);
  assert.equal(wakeRange(night({ wake_at_algo: undefined })), null);
  assert.equal(wakeRange(night({ wake_at_algo: '' })), null);
});

test('no reported wake is no range', () => {
  assert.equal(wakeRange(night({ wake_at: null })), null);
  assert.equal(wakeRange(night({ wake_at: undefined })), null);
  assert.equal(wakeRange(night({ wake_at: '' })), null);
});

test('an unparsable time on either side is no range, never a range with a bad end', () => {
  assert.equal(wakeRange(night({ wake_at_algo: 'MARK:wake_at_algo' })), null);
  assert.equal(wakeRange(night({ wake_at: 'not a time' })), null);
  assert.equal(wakeRange(night({ wake_at_algo: 12345 })), null, 'a number is not the SQL shape');
});

test('★ only a scored night has a range', () => {
  for (const status of ['empty', 'no_data', 'no_sleep', 'off', undefined, null]) {
    assert.equal(wakeRange(night({ status })), null, `status ${status}`);
  }
});

test('★ a night the parent corrected shows their single time: no range', () => {
  assert.equal(wakeRange(night({ corrected: true })), null);
});

test('★ a night still in progress has no range: its wake is not final', () => {
  assert.equal(wakeRange(night({ in_progress: true })), null);
  assert.ok(wakeRange(night({ in_progress: false })), 'a finished fresh compute carries in_progress: false');
});

test('★ "no one was in the bed" has no range, even if the detector\'s times are still on it', () => {
  assert.equal(wakeRange(night({ nobody_in_bed: true })), null);
});

test('a missing night is no range', () => {
  assert.equal(wakeRange(null), null);
  assert.equal(wakeRange(undefined), null);
  assert.equal(wakeRange({}), null);
});

test('the night is not changed', () => {
  const n = night({});
  const copy = structuredClone(n);
  wakeRange(n);
  assert.deepEqual(n, copy);
});
