import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { shouldHold, HOLD_CAP_MS, _reset, _state: holdState } = await import('../src/lib/alertHold.js');
const { _state } = await import('../src/lib/wakeWatcher.js');
const { childWindowKeyNow, currentNightDate } = await import('../src/lib/sleepAnalysis.js');

const pad = (n) => String(n).padStart(2, '0');
const hm = (date) => `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
const windowAround = () => [hm(new Date(Date.now() - 3 * 60 * 60 * 1000)), hm(new Date(Date.now() + 3 * 60 * 60 * 1000))];
const flag = (id, on) => db.prepare('UPDATE children SET hold_alerts_until_asleep = ? WHERE id = ?').run(on, id);
const track = (id, on) => db.prepare('UPDATE children SET track_sleep = ? WHERE id = ?').run(on, id);

before(() => {
  const [start, end] = windowAround();
  makeChild(db, { id: 'a', start, end });
  makeChild(db, { id: 'b', start, end });
  makeCamera(db, { id: 'ca', childId: 'a' });
  makeCamera(db, { id: 'cb', childId: 'b' });
  makeCamera(db, { id: 'none' });
});
beforeEach(() => { _reset(); _state().clear(); flag('a', 0); flag('b', 0); track('a', 1); track('b', 1); });
after(() => { mock.timers.reset(); db.close(); cleanupTempDataDirs(); });

test('#919 off by default, missing child and deleted child allow alerts', () => {
  assert.equal(shouldHold({ id: 'ca' }), false);
  assert.equal(shouldHold({ id: 'none' }), false);
  assert.equal(shouldHold({}), false);
  assert.equal(shouldHold({ id: 'deleted' }), false);
});

test('#919 outside the gate holds indefinitely without a clock, independently per child', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T10:00:00Z') });
  try {
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run('19:00', '07:00', 'a');
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run('09:00', '15:00', 'b');
    flag('a', 1); flag('b', 1);
    _state().set('cb', { asleep: true }); // the second child is inside its window and asleep
    assert.equal(shouldHold({ id: 'ca' }, 1000), true);
    assert.equal(holdState().has('a'), false, 'outside-window hold has no cap clock');
    assert.equal(shouldHold({ id: 'cb' }, 1000), false, 'asleep child may alert');
    assert.equal(shouldHold({ id: 'none' }, 1000), false, 'unassigned camera may alert');
    assert.equal(holdState().size, 0, 'other cameras do not start a clock for the held child');
    assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 8 * 3600_000), true);
    assert.equal(holdState().has('a'), false, 'hours of attempts cannot start or exhaust a cap');
    flag('a', 0);
    assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 9 * 3600_000), false, 'flag off allows the same child');
    flag('a', 1);
    track('a', 0);
    assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 10 * 3600_000), false, 'Track sleep off allows alerts');
  } finally {
    mock.timers.reset();
    const [start, end] = windowAround();
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, 'a');
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, 'b');
  }
});

test('#919 first held alert starts one per-child clock; cap boundary releases for the night', () => {
  assert.equal(HOLD_CAP_MS, 45 * 60 * 1000, 'the owner chose a 45-minute cap');
  flag('a', 1);
  assert.equal(shouldHold({ id: 'ca' }, 1000), true);
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS - 1000), true);
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS), false);
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 60_000), false);
});

test('#919 clock is shared across cameras of one child, independent across children', () => {
  flag('a', 1); flag('b', 1);
  makeCamera(db, { id: 'ca2', childId: 'a' });
  assert.equal(shouldHold({ id: 'ca' }, 1000), true);
  assert.equal(shouldHold({ id: 'cb' }, 2000), true);
  assert.equal(shouldHold({ id: 'ca2' }, 1000 + HOLD_CAP_MS), false);
  assert.equal(shouldHold({ id: 'cb' }, 1000 + HOLD_CAP_MS), true);
});

test('#919 motion and sound attempts on the same camera share one child clock', () => {
  flag('a', 1);
  assert.equal(shouldHold({ id: 'ca' }, 1000), true); // motion call site
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS - 1), true); // sound call site
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS), false); // sound cannot restart the cap
});

test('#919 reads child assignment fresh without resetting a spent cap', () => {
  flag('a', 1);
  const stale = { id: 'none', child_id: 'a' };
  assert.equal(shouldHold(stale, 1000), false);
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run('a', 'none');
  try { assert.equal(shouldHold(stale, 1000), true); }
  finally { db.prepare('UPDATE cameras SET child_id = NULL WHERE id = ?').run('none'); }
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS), false);
  flag('a', 0);
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 500), false);
  flag('a', 1);
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 750), false);
  track('a', 0);
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 1000), false);
  track('a', 1);
  assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS + 2000), false);
});

test('#919 asleep releases without resetting the clock, and a backwards step fails open', () => {
  flag('a', 1);
  assert.equal(shouldHold({ id: 'ca' }, 1000), true);
  _state().set('ca', { asleep: true });
  assert.equal(shouldHold({ id: 'ca' }, 2000), false);
  _state().clear();
  assert.equal(shouldHold({ id: 'ca' }, 500), false);
  assert.equal(shouldHold({ id: 'ca' }, 2500), false);
});

test('#919 outside the gate has no clock; lead margin and configured window share the first clock', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T18:00:00Z') });
  try {
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run('19:00', '07:00', 'a');
    flag('a', 1);
    assert.equal(shouldHold({ id: 'ca' }, 1000), true, 'outside-window alert is held');
    assert.equal(holdState().has('a'), false, 'outside-window alert does not start the cap');
    mock.timers.setTime(Date.parse('2026-10-31T18:57:00Z'));
    assert.equal(currentNightDate('a'), null);
    const key = childWindowKeyNow('a');
    assert.equal(key, Date.parse('2026-10-31T19:00:00Z'));
    assert.equal(shouldHold({ id: 'ca' }, 1000), true);
    assert.equal(holdState().get('a').firstAt, 1000);
    mock.timers.setTime(Date.parse('2026-10-31T19:02:00Z'));
    assert.equal(childWindowKeyNow('a'), key);
    assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS), false);
  } finally {
    mock.timers.reset();
    const [start, end] = windowAround();
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, 'a');
  }
});

// #602: the same lead margin for a window that opens 00:00-00:04, where the lead falls on the previous calendar day.
// Settings timezone is the default UTC here. 23:57 on 10-31 is 5 minutes before a 00:02 start on 11-01. The hold
// path runs the real wake-watcher gate (isChildAsleep -> childWindowActiveNow) and the real key (childWindowKeyNow),
// so it fails if either call loses tomorrow's night, and the cap check after midnight fails if the key changes at 00:02.
test('#602 a 00:02 window holds from its 5-minute lead before midnight, on one key and one clock across midnight', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T23:56:59.999Z') });
  try {
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run('00:02', '07:00', 'a');
    flag('a', 1);
    assert.equal(shouldHold({ id: 'ca' }, 1000), true, 'one millisecond before the lead: held without a clock');
    assert.equal(holdState().has('a'), false);
    mock.timers.setTime(Date.parse('2026-10-31T23:57:00Z'));
    assert.equal(shouldHold({ id: 'ca' }, 1000), true, 'at the lead edge the watcher gate is open: held');
    assert.equal(holdState().get('a').firstAt, 1000, 'the lead edge starts the clock');
    mock.timers.setTime(Date.parse('2026-11-01T00:03:00Z'));
    assert.equal(childWindowKeyNow('a'), Date.parse('2026-11-01T00:02:00Z'));
    assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS), false, 'same night, same clock: the cap from 23:57 still applies after midnight');
  } finally {
    mock.timers.reset();
    const [start, end] = windowAround();
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, 'a');
  }
});

test('#919 a new watcher window gives a new night clock', () => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-31T19:00:00Z') });
  try {
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run('19:00', '07:00', 'a');
    flag('a', 1);
    assert.equal(shouldHold({ id: 'ca' }, 1000), true);
    assert.equal(shouldHold({ id: 'ca' }, 1000 + HOLD_CAP_MS), false);
    mock.timers.setTime(Date.parse('2026-11-01T19:00:00Z'));
    assert.equal(shouldHold({ id: 'ca' }, 1000 + 24 * 3600_000), true);
  } finally {
    mock.timers.reset();
    const [start, end] = windowAround();
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, 'a');
  }
});

test('#919 an internal database failure allows the alert', () => {
  flag('a', 1);
  const original = db.prepare;
  db.prepare = () => { throw new Error('private detail'); };
  try { assert.equal(shouldHold({ id: 'ca' }), false); }
  finally { db.prepare = original; }
});
