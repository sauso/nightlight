// The live state of a night still in progress (src/lib/nightLiveState.js; sleep score plan, phase 4). PURE: this file
// imports no database, so it can run beside anything. The route and the attach glue are checked in
// sleep-score-routes.test.js; the constant that must match sleepAnalysis.js is checked in night-summary.test.js (it
// has the database loaded).
//
// EVERY TEST HAS A LITERAL EXPECTED VALUE AND SITS ON A BOUNDARY:
//   awake with the last minute's row still missing (a wake that ended 2 minutes ago) ..... "a wake that ended 2 minutes ago ..."
//   the hysteresis edge: 3:59 after the wake ended is awake, 4:00 is asleep ............... "the hysteresis edge ..."
//   no onset ................................................................................ "no onset ..."
//   the staleness edge: 6:00 old is trusted, 6:01 is not ................................... "the staleness edge ..."
//   a night that is not in progress ......................................................... "not in progress ..."
//
// ⚠️ Fixture times are made up: the repo is public.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveState, LIVE_STATE_CONFIG } from '../src/lib/nightLiveState.js';

const MIN = 60 * 1000;
const AS_OF = '2026-03-11 02:30:00';
const AS_OF_MS = Date.UTC(2026, 2, 11, 2, 30, 0);
const night = (over = {}) => ({
  in_progress: true,
  status: 'ok',
  onset_at: '2026-03-10 19:30:00',
  wake_at: null,
  as_of: AS_OF,
  ...over,
});
const factsOf = (wakes) => ({ v: 1, climate: { temp_min: null, temp_max: null }, sleep: { wakes, room_activity_wakes: 0 } });
const wake = (start_at, minutes) => ({ start_at, minutes });
// A wake that ENDED `agoMs` before AS_OF and lasted `minutes`, as { start_at, minutes } plus the strings it should give.
const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const endedAgo = (agoMs, minutes = 5) => {
  const endMs = AS_OF_MS - agoMs;
  return { w: wake(sqlAt(endMs - minutes * MIN), minutes), start: sqlAt(endMs - minutes * MIN), end: sqlAt(endMs) };
};

test('not in progress: null, whatever else the night holds (a finished night has no "right now")', () => {
  const facts = factsOf([wake('2026-03-11 02:00:00', 5)]);
  assert.equal(liveState(night({ in_progress: false }), AS_OF_MS, facts), null);
  // A saved row has no in_progress key at all: not a live night either.
  const { in_progress: _drop, ...row } = night();
  assert.equal(liveState(row, AS_OF_MS, facts), null);
  assert.equal(liveState(night({ in_progress: 'yes' }), AS_OF_MS, facts), null, 'only the boolean true counts');
  assert.equal(liveState(null, AS_OF_MS, facts), null);
  assert.equal(liveState(undefined, AS_OF_MS, facts), null);
  assert.equal(liveState('a night', AS_OF_MS, facts), null);
  // Precondition: the same night IS live when it is in progress.
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([])), { state: 'asleep', since: '2026-03-10 19:30:00' });
});

test('no onset: not asleep yet, with no time; a night with no camera data at all is unknown, not "not asleep yet"', () => {
  assert.deepEqual(liveState(night({ onset_at: null, status: 'no_sleep' }), AS_OF_MS, null), { state: 'not_asleep_yet', since: null });
  assert.deepEqual(liveState(night({ onset_at: null, status: 'empty' }), AS_OF_MS, null), { state: 'not_asleep_yet', since: null });
  // Nothing in the facts can bring a state back when there is no onset.
  assert.deepEqual(liveState(night({ onset_at: null, status: 'no_sleep' }), AS_OF_MS, factsOf([wake('2026-03-11 02:00:00', 5)])), { state: 'not_asleep_yet', since: null });
  assert.deepEqual(liveState(night({ onset_at: null, status: 'no_data' }), AS_OF_MS, null), { state: 'unknown', since: null });
});

test('a wake_at on the night: awake since it, however long ago the last counted wake was', () => {
  const facts = factsOf([wake('2026-03-10 22:00:00', 10)]);
  assert.deepEqual(liveState(night({ wake_at: '2026-03-11 02:24:00' }), AS_OF_MS, facts), { state: 'awake', since: '2026-03-11 02:24:00' });
  // It needs no facts: the wake time alone says it.
  assert.deepEqual(liveState(night({ wake_at: '2026-03-11 02:24:00' }), AS_OF_MS, null), { state: 'awake', since: '2026-03-11 02:24:00' });
});

test('a wake that ended 2 minutes ago still reads AWAKE, since the wake started (the last minute\'s row is missing and reads as quiet)', () => {
  const { w, start, end } = endedAgo(2 * MIN);
  assert.equal(end, '2026-03-11 02:28:00', 'precondition: the fixture wake ended at 02:28, two minutes before as_of');
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([wake('2026-03-10 22:00:00', 10), w])), { state: 'awake', since: start });
  assert.equal(start, '2026-03-11 02:23:00');
  // The row for the minute that just ended (a wake that ended right at as_of) is the case the extra minute exists for.
  const now = endedAgo(0);
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([now.w])), { state: 'awake', since: now.start });
});

test('the hysteresis edge: 3:59 after a wake ended is awake, 4:00 is asleep, since the END of that wake; 5 minutes is asleep', () => {
  assert.equal(LIVE_STATE_CONFIG.wake_gap_min + LIVE_STATE_CONFIG.hysteresis_extra_min, 4, 'precondition: the edge is 4 minutes');
  const justInside = endedAgo(4 * MIN - 1000);
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([justInside.w])), { state: 'awake', since: justInside.start });
  const onTheEdge = endedAgo(4 * MIN);
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([onTheEdge.w])), { state: 'asleep', since: onTheEdge.end });
  const five = endedAgo(5 * MIN);
  assert.equal(five.end, '2026-03-11 02:25:00');
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([five.w])), { state: 'asleep', since: '2026-03-11 02:25:00' });
});

test('asleep: since the end of the LATEST counted wake (whatever order the list is in), else since the onset', () => {
  const early = wake('2026-03-10 21:00:00', 12); // ended 21:12
  const late = wake('2026-03-11 00:40:00', 8); // ended 00:48, long before as_of
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([early, late])), { state: 'asleep', since: '2026-03-11 00:48:00' });
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([late, early])), { state: 'asleep', since: '2026-03-11 00:48:00' }, 'the order of the list does not matter');
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([])), { state: 'asleep', since: '2026-03-10 19:30:00' });
  // A fractional length is kept to the second.
  assert.deepEqual(liveState(night(), AS_OF_MS, factsOf([wake('2026-03-11 00:40:00', 8.5)])), { state: 'asleep', since: '2026-03-11 00:48:30' });
});

test('the staleness edge: an as_of 6:00 behind the clock is trusted, 6:01 is unknown; so is one nobody can read', () => {
  assert.equal(LIVE_STATE_CONFIG.stale_after_min, 6, 'precondition: the bound is six minutes');
  const facts = factsOf([]);
  assert.deepEqual(liveState(night(), AS_OF_MS + 6 * MIN, facts), { state: 'asleep', since: '2026-03-10 19:30:00' });
  assert.deepEqual(liveState(night(), AS_OF_MS + 6 * MIN + 1000, facts), { state: 'unknown', since: null });
  // A clock BEHIND as_of is not stale.
  assert.deepEqual(liveState(night(), AS_OF_MS - 5 * MIN, facts), { state: 'asleep', since: '2026-03-10 19:30:00' });
  // Unknown outranks every other state, awake and not asleep yet included.
  assert.deepEqual(liveState(night({ wake_at: '2026-03-11 02:29:00' }), AS_OF_MS + 20 * MIN, facts), { state: 'unknown', since: null });
  assert.deepEqual(liveState(night({ onset_at: null, status: 'no_sleep' }), AS_OF_MS + 20 * MIN, null), { state: 'unknown', since: null });
  for (const as_of of [null, undefined, '', 'not a time', 12345]) {
    assert.deepEqual(liveState(night({ as_of }), AS_OF_MS, facts), { state: 'unknown', since: null }, `as_of ${String(as_of)}`);
  }
  for (const now of [NaN, undefined, null, Infinity, 'now']) {
    assert.deepEqual(liveState(night(), now, facts), { state: 'unknown', since: null }, `now ${String(now)}`);
  }
});

test('no readable wakes list: unknown (never "asleep since the onset" on a guess); a wake_at still says awake', () => {
  const bad = [
    null,
    {},
    { sleep: null },
    { sleep: { wakes: 'x' } },
    factsOf([{ start_at: 'soon', minutes: 5 }]),
    factsOf([{ start_at: '2026-03-11 02:00:00', minutes: 'five' }]),
    factsOf([{ start_at: '2026-03-11 02:00:00', minutes: NaN }]),
    factsOf([null]),
    // One bad entry spoils the list: the last wake cannot be trusted to be the one that was read.
    factsOf([wake('2026-03-11 01:00:00', 5), { start_at: null, minutes: 5 }]),
  ];
  for (const f of bad) assert.deepEqual(liveState(night(), AS_OF_MS, f), { state: 'unknown', since: null }, JSON.stringify(f));
  assert.deepEqual(liveState(night({ wake_at: '2026-03-11 02:29:00' }), AS_OF_MS, null), { state: 'awake', since: '2026-03-11 02:29:00' });
});

test('the answer is exactly { state, since } and never carries a score or a verdict', () => {
  const r = liveState(night(), AS_OF_MS, factsOf([]));
  assert.deepEqual(Object.keys(r).sort(), ['since', 'state']);
  assert.ok(Object.isFrozen(LIVE_STATE_CONFIG), 'the config cannot be changed at run time');
});
