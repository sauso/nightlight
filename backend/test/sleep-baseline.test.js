// The sleep score's baseline (src/lib/sleepBaseline.js; sleep score plan, phase 1b): what "usual" is for one child
// on one night, read from stored nights with corrections laid over them. Nothing calls it yet.
//
// Each test states its nights and a literal expected median or count, and sits on a boundary or separates two
// plausible implementations:
//   a median, not a mean; never the night itself or a later one ..... "a median of the earlier nights ..."
//   ready at 7 usable values, not 6 .................................. "ready at seven ..."
//   readiness is per METRIC, not per night ........................... "readiness is per metric ..."
//   28 days back, not 29; the newest 14, counted after the filters ... "no older than 28 days", "the newest 14 ..."
//   80% of the window watched ........................................ "a night watched for less than 80% ..."
//   same camera AND same window; NULL or unreadable context is out ... "another camera, another window ..."
//   no confirmed wake / > 15 unwatched: out of the usual DURATION only  "the usual duration leaves out ..."
//   "no one was in the bed" and promoted-from-empty nights are out ... "a night a parent emptied ..."
//   a figure the scorer refuses cannot become usual .................. "a corrected span ..."
//   clock times in each night's own stored timezone .................. "clock times are read in each night's own ..."
//
// ⚠️ Fixture ids are made up: the repo is public. Dates are in 2025 so no test clock can put them in the future.

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { sleepBaseline } = await import('../src/lib/sleepBaseline.js');
const { scoreNight, toScoringInput } = await import('../src/lib/sleepScore.js');
const { applyCorrection } = await import('../src/lib/sleepReviews.js');

after(() => {
  try { db.close(); } catch { /* already closed */ }
  cleanupTempDataDirs();
});

const CHILD = 'bl-child';
const TARGET = '2025-03-20';
const context = (over = {}) => JSON.stringify({ v: 1, camera_id: 'bl-cam', tz: 'UTC', window: { start: '19:00', end: '07:00' }, algo: '6', ...over });
const day = (date, shift) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + shift)).toISOString().slice(0, 10);
};
const back = (n) => day(TARGET, -n); // the night n days before the target

// One stored night: 19:00 to 07:00 UTC, asleep 19:30, up 06:30, put down 19:10, fully watched, 10 hours asleep.
const COLUMNS = ['child_id', 'night_date', 'window_start', 'window_end', 'status', 'onset_at', 'wake_at', 'in_bed_at',
  'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes', 'coverage_minutes',
  'stir_minutes', 'wake_unconfirmed_at', 'scoring_context', 'computed_at'];
const insertNight = db.prepare(`INSERT INTO sleep_nights (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`);
function put(date, over = {}) {
  const row = {
    child_id: CHILD,
    night_date: date,
    window_start: `${date} 19:00:00`,
    window_end: `${day(date, 1)} 07:00:00`,
    status: 'ok',
    onset_at: `${date} 19:30:00`,
    wake_at: `${day(date, 1)} 06:30:00`,
    in_bed_at: `${date} 19:10:00`,
    asleep_minutes: 600,
    awake_minutes: 60,
    unknown_minutes: 0,
    wake_count: 2,
    longest_stretch_minutes: 330,
    coverage_minutes: 720,
    stir_minutes: 20,
    wake_unconfirmed_at: null,
    scoring_context: context(),
    computed_at: `${day(date, 1)} 10:00:00`,
    ...over,
  };
  insertNight.run(row);
  return row;
}
const review = (date, cols) => {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO sleep_reviews (child_id, night_date, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(CHILD, date, ...keys.map((k) => cols[k]));
};
const baseline = (targetOver = {}) => sleepBaseline(CHILD, { ...put(TARGET, targetOver) });

beforeEach(() => {
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM sleep_reviews').run();
});

describe('which nights make the usual', () => {
  test('a median of the earlier nights: not a mean, and never the night itself or a later one', () => {
    for (let n = 1; n <= 6; n++) put(back(n));
    put(back(7), { asleep_minutes: 30 }); // one freak night: the mean would be 518.6
    put(day(TARGET, 1), { asleep_minutes: 100 }); // a LATER night
    const b = baseline({ asleep_minutes: 100 }); // the night itself, stored
    assert.deepEqual(b.metrics.asleep, { median: 600, n: 7, ready: true });
    assert.equal(b.nights, 7);
  });

  test('ready at seven usable values, not at six', () => {
    for (let n = 1; n <= 6; n++) put(back(n));
    const six = sleepBaseline(CHILD, put(TARGET));
    assert.deepEqual([six.metrics.asleep.n, six.metrics.asleep.ready, six.metrics.wake_count.ready], [6, false, false]);
    put(back(7));
    const seven = sleepBaseline(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get(TARGET));
    assert.deepEqual([seven.metrics.asleep.n, seven.metrics.asleep.ready, seven.metrics.wake_count.ready], [7, true, true]);
  });

  test('readiness is per metric: seven nights, six with a stir count and one with a put-down', () => {
    put(back(1)); // the only night with both
    for (let n = 2; n <= 6; n++) put(back(n), { in_bed_at: null });
    put(back(7), { in_bed_at: null, stir_minutes: null }); // stored before the stir count existed
    const b = baseline();
    assert.deepEqual(b.metrics.asleep, { median: 600, n: 7, ready: true });
    assert.deepEqual(b.metrics.stir_rate, { median: 2, n: 6, ready: false }); // 20 minutes in 10 hours
    assert.deepEqual(b.metrics.settle_minutes, { median: 20, n: 1, ready: false });
  });

  test('no older than 28 days', () => {
    put(back(28), { wake_count: 9 });
    put(back(29), { wake_count: 9 });
    assert.equal(baseline().metrics.wake_count.n, 1);
  });

  test('the newest 14 that qualify: older ones are left out, and a night that does not qualify uses no place', () => {
    // Newest first: 7 nights of 600, one from another camera (must not take a place), 7 of 400, then 2 of 200.
    for (let n = 1; n <= 7; n++) put(back(n), { asleep_minutes: 600 });
    put(back(8), { scoring_context: context({ camera_id: 'other-cam' }), asleep_minutes: 999 });
    for (let n = 9; n <= 15; n++) put(back(n), { asleep_minutes: 400 });
    put(back(16), { asleep_minutes: 200 });
    put(back(17), { asleep_minutes: 200 });
    const b = baseline();
    assert.equal(b.nights, 14);
    // The newest 14 are 7 x 600 and 7 x 400: median 500. All 16 would give 400; 13 (the other camera's night
    // taking a place) would give 600.
    assert.deepEqual(b.metrics.asleep, { median: 500, n: 14, ready: true });
  });

  test('a night watched for less than 80% of its window is out', () => {
    put(back(1), { coverage_minutes: 576 }); // exactly 80% of 720
    put(back(2), { coverage_minutes: 575 });
    assert.equal(baseline().nights, 1);
  });

  test('another camera, another window, or no readable context: out. Another timezone alone: in', () => {
    put(back(1), { scoring_context: context({ camera_id: 'other-cam' }) });
    put(back(2), { scoring_context: context({ window: { start: '19:30', end: '07:00' } }) });
    put(back(3), { scoring_context: context({ window: { start: '19:00', end: '06:30' } }) });
    put(back(4), { scoring_context: null }); // stored before the column
    put(back(5), { scoring_context: '{"v":1,"camera_id":"bl-cam"}' }); // not a context this code wrote
    assert.equal(baseline().nights, 0);
    put(back(6), { scoring_context: context({ tz: 'Europe/Paris' }) });
    assert.equal(sleepBaseline(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get(TARGET)).nights, 1);
  });

  test('a night with no context of its own has no baseline, whatever is stored', () => {
    for (let n = 1; n <= 8; n++) put(back(n));
    const b = baseline({ scoring_context: null });
    assert.deepEqual([b.nights, b.metrics.asleep.n, b.metrics.asleep.ready, b.metrics.asleep.median], [0, 0, false, null]);
  });
});

describe('which figures of a qualifying night count', () => {
  test('the usual duration leaves out a night with no confirmed wake or more than 15 unwatched minutes; its other figures stay', () => {
    for (let n = 1; n <= 4; n++) put(back(n));
    put(back(5), { unknown_minutes: 15, asleep_minutes: 580 }); // in
    put(back(6), { unknown_minutes: 16, asleep_minutes: 100 }); // under-counted sleep
    put(back(7), { wake_unconfirmed_at: `${back(6)} 04:00:00`, asleep_minutes: 700 }); // an exit the detector skipped
    put(back(8), { wake_at: null, asleep_minutes: 700 }); // still "asleep" when the window closed
    const b = baseline();
    assert.equal(b.nights, 8);
    assert.deepEqual(b.metrics.asleep, { median: 600, n: 5, ready: false });
    assert.deepEqual([b.metrics.wake_count.n, b.metrics.wake_count.ready], [8, true]);
    // The wake clock needs a real wake too: 6 of the 8.
    assert.equal(b.metrics.wake_clock.n, 6);
  });

  test('a night a parent emptied, and one they filled in from empty, are both out; neither is scored', () => {
    for (let n = 1; n <= 7; n++) put(back(n));
    review(back(1), { nobody_in_bed: 1 });
    // The detector saw an empty bed; the parent typed an asleep and a wake time (asScoredFromEmpty makes it `ok`).
    put(back(8), {
      status: 'empty', onset_at: null, wake_at: null, in_bed_at: null, asleep_minutes: null, awake_minutes: null,
      unknown_minutes: null, wake_count: null, longest_stretch_minutes: null, stir_minutes: null,
    });
    review(back(8), { true_onset_at: `${back(8)} 19:30:00`, true_wake_at: `${back(7)} 06:30:00` });
    const promoted = applyCorrection(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get(back(8)));
    assert.deepEqual([promoted.status, promoted.wake_count, promoted.asleep_minutes], ['ok', 0, 660]); // the overlay did promote it
    assert.equal(scoreNight(toScoringInput(promoted), null, 36).reason, 'promoted_from_empty');

    const b = baseline();
    assert.equal(b.nights, 6); // 8 stored, the emptied one and the promoted one out
    assert.deepEqual([b.metrics.wake_count.median, b.metrics.wake_count.n], [2, 6]); // the promoted night's 0 wakes are not in it
    // Without the correction rows both nights' stored figures would be read as they are.
    db.prepare('DELETE FROM sleep_reviews').run();
    assert.equal(sleepBaseline(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get(TARGET)).nights, 7);
  });

  test('a corrected span: the re-derived sleep counts as usual, the detector\'s longest stretch and stir count do not', () => {
    for (let n = 1; n <= 7; n++) put(back(n));
    // The parent moved one night's wake from 06:30 to 05:30: asleep becomes 600 (19:30 to 05:30) - 60 awake = 540.
    review(back(1), { true_wake_at: `${TARGET} 05:30:00` });
    // And only the put-down on another: nothing about the sleep changed, so everything of it still counts.
    review(back(2), { true_in_bed_at: `${back(2)} 19:00:00` });
    const b = baseline();
    assert.equal(b.nights, 7);
    assert.equal(b.metrics.asleep.n, 7);
    assert.equal(b.metrics.longest_stretch.n, 6);
    assert.equal(b.metrics.longest_share.n, 6);
    assert.equal(b.metrics.stir_rate.n, 6);
    // The wake clock takes the parent's 05:30 (1050): six nights at 1110 and one at 1050.
    assert.deepEqual([b.metrics.wake_clock.n, b.metrics.wake_clock.median], [7, 1110]);
    // The settle times: six of 20 minutes and the corrected put-down's 30.
    assert.deepEqual([b.metrics.settle_minutes.n, b.metrics.settle_minutes.median], [7, 20]);
    // Asleep: six of 600 and one of 540 -> the median stays 600, with all seven behind it.
    assert.equal(b.metrics.asleep.median, 600);
  });

  test('clock times are read in each night\'s own stored timezone', () => {
    // Four nights stored under Asia/Tokyo (UTC+9, no clock changes): asleep 19:30 local is 10:30 UTC, up 07:00
    // local is 22:00 UTC the same UTC day. Three stored under UTC: asleep 19:30, up 07:00.
    for (let n = 1; n <= 4; n++) {
      put(back(n), { scoring_context: context({ tz: 'Asia/Tokyo' }), onset_at: `${back(n)} 10:30:00`, wake_at: `${back(n)} 22:00:00` });
    }
    for (let n = 5; n <= 7; n++) put(back(n), { wake_at: `${back(n - 1)} 07:00:00` });
    const b = baseline();
    // 19:30 is 450 minutes after noon and 07:00 is 1140, in both zones. Read in one zone for all (the target's
    // UTC), the four Tokyo nights would say 10:30 = 1350 and 22:00 = 600, and both medians would move.
    assert.deepEqual(b.metrics.onset_clock, { median: 450, n: 7, ready: true });
    assert.deepEqual(b.metrics.wake_clock, { median: 1140, n: 7, ready: true });
  });
});
