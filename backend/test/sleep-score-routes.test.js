// The sleep score on the API (sleep score plan, phase 1c): /sleep/live, /sleep?nights=N and every shape of
// /sleep/:date return each night with a `score` key, worked out on read from the exact night returned
// (src/lib/sleepScoreAttach.js, called from src/routes/children.js).
//
// EVERY TEST HAS A PRECONDITION AND A LITERAL EXPECTED VALUE, and each sits where two plausible implementations
// part ways:
//   every shape's score is scoreNight on the night it returned ....... the two "every shape ..." tests, "/sleep/live ..."
//   the score is taken AFTER the correction (and before it for raw) ... "a corrected night ..."
//   a fresh compute is scored with the context it ran with ........... "/sleep/:date fresh ...", "/sleep/live: last night computed fresh ..."
//   a replay is scored with the SAVED context, not today's ........... "a replay ..."
//   expired samples: the score comes from the saved row .............. "raw samples gone ..."
//   in progress: no score, with the reason ........................... "/sleep/live: tonight ..."
//   a failing score never fails the route ............................ "a score that throws ..."
//   #1041 through the route .......................................... "#1041 ..."
//   no existing key changes .......................................... `sameButScore` in every shape test
//
// THE FIXED NIGHT (hand-checkable; `fixedNightFigures` asserts it before anything is scored): 19:00 to 07:00 in
// Europe/Berlin (UTC+2 in July, so a hard-coded UTC cannot pass), put down 19:10, asleep 19:40, one 20-minute wake
// at 01:00, up 06:00. The detector reads it as 600 minutes asleep, 20 awake, 1 wake, longest stretch 320, no stir
// minutes. THE USUAL: seven earlier stored nights of 600 asleep, 60 awake, 2 wakes, longest 330, 20 stir minutes,
// asleep 19:30, up 06:30, put down 19:10. The child is 37 months old on the night.
//
// The score of that night against that usual, by hand from SCORE_CONFIG:
//   duration      600 against a usual 600 ......................................................... 100
//   continuity    efficiency 600/620 = 0.968 -> 100; longest 320/620 = 0.516 -> 75 + 25 * (0.166/0.25) = 92;
//                 1 wake -> 95.  0.5 * 100 + 0.3 * 92 + 0.2 * 95 = 96.6 ............................... 97
//   settling      30 minutes -> 100 - 50 * (10/25) ................................................... 80
//   restlessness  0 an hour, no excess over max(usual 2, floor 2) ................................... 100
//   consistency   asleep 19:40 against 19:30 (10 apart) -> 100; up 06:00 against 06:30 (30 apart) ->
//                 100 - 50 * (15/45) = 83.  (100 + 83) / 2 = 91.5 .................................... 92
//   score         (35*100 + 30*97 + 15*80 + 15*100 + 5*92) / 100 = 95.7 ............................... 96, "great"
//
// ⚠️ Fixture ids, names and the timezone are made up: the repo is public.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  computeNight, computeAndStoreNight, computeNightForDisplay, currentScoringContext, parseScoringContext,
  lastCompletedNightDate, currentNightDate,
} = await import('../src/lib/sleepAnalysis.js');
const { TRANSITION, framesForNight } = await import('../src/lib/bedTransitions.js');
const { saveNightReview, applyCorrection } = await import('../src/lib/sleepReviews.js');
const { scoreNight, toScoringInput, ageMonthsOn } = await import('../src/lib/sleepScore.js');
const { sleepBaseline } = await import('../src/lib/sleepBaseline.js');
const { failNextScoreForTest, resetScoreLogForTest, attachScore } = await import('../src/lib/sleepScoreAttach.js');
const { default: childrenRouter } = await import('../src/routes/children.js');
const { logger } = await import('../src/lib/logger.js');

const CHILD = 'sr-child';
const CAM = 'sr-cam';
const BIRTHDAY = '2023-06-01'; // 37 months on the fixed night; 12 months or more on any night a test's clock can reach
const DATE = '2026-07-01';
const TZ = 'Europe/Berlin';
const MIN = 60000;
const HOUR = 60 * MIN;

let server;
let token;

const json = (v) => JSON.parse(JSON.stringify(v)); // what a client actually receives
const omit = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const comp = (score, key) => score.components.find((c) => c.key === key);
const term = (score, compKey, key) => comp(score, compKey).terms.find((t) => t.key === key);
const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 24 * HOUR).toISOString().slice(0, 10);
const rowOf = (date = DATE) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const get = (path) => call(`${server.url}/api/children/${CHILD}${path}`, { token });

// THE ORACLE: scoreNight on the night a response carried, with the baseline read for it and the child's age. It
// goes through none of the code under test (no attachScore), so "the route's score equals this" is a real check.
// `context` is what a fresh compute must be scored with; a stored row ignores it.
const expected = (night, context = null) => {
  const input = toScoringInput(omit(night, 'score', 'score_source'), { context });
  return json(scoreNight(input, sleepBaseline(CHILD, input), ageMonthsOn(BIRTHDAY, input.night_date)));
};

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
// One sample a minute over [from, to) in ms: moving (0.4) inside any `moving` span, else still (0.004).
function layMinutes(moving, from, to) {
  db.exec('BEGIN');
  for (let t = from; t < to; t += MIN) {
    const m = moving.some(([a, b]) => t >= a && t < b);
    insertSample.run(CAM, sqlAt(t), m ? 0.4 : 0.004, m ? 0.4 : 0.004);
  }
  db.exec('COMMIT');
}
const layTransition = (type, ms) =>
  db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)').run(CAM, type, sqlAt(ms));

// One stored night of THE USUAL, written directly: `startMs` is its window's start, `windowHours` its length.
const NIGHT_COLUMNS = ['child_id', 'night_date', 'window_start', 'window_end', 'status', 'onset_at', 'wake_at', 'in_bed_at',
  'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes', 'coverage_minutes',
  'stir_minutes', 'wake_unconfirmed_at', 'scoring_context', 'computed_at'];
const insertNight = db.prepare(
  `INSERT INTO sleep_nights (${NIGHT_COLUMNS.join(', ')}) VALUES (${NIGHT_COLUMNS.map((c) => `@${c}`).join(', ')})`
);
function putUsualNight(date, startMs, windowHours, contextRaw, over = {}) {
  const endMs = startMs + windowHours * HOUR;
  insertNight.run({
    child_id: CHILD,
    night_date: date,
    window_start: sqlAt(startMs),
    window_end: sqlAt(endMs),
    status: 'ok',
    onset_at: sqlAt(startMs + 30 * MIN),
    wake_at: sqlAt(endMs - 30 * MIN),
    in_bed_at: sqlAt(startMs + 10 * MIN),
    asleep_minutes: 600,
    awake_minutes: 60,
    unknown_minutes: 0,
    wake_count: 2,
    longest_stretch_minutes: 330,
    coverage_minutes: windowHours * 60,
    stir_minutes: 20,
    wake_unconfirmed_at: null,
    scoring_context: contextRaw,
    computed_at: sqlAt(endMs + 3 * HOUR), // final
    ...over,
  });
}

// --- the fixed night, in Europe/Berlin ----------------------------------------------------------------------

const BERLIN_OFF = 2 * HOUR; // UTC+2 for the whole fixture (late June and early July)
const local = (h, m, dayShift = 0, date = DATE) => Date.parse(`${addDays(date, dayShift)}T00:00:00Z`) + h * HOUR + m * MIN - BERLIN_OFF;

function setUpFixed({ window = ['19:00', '07:00'] } = {}) {
  db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(TZ);
  db.prepare(`INSERT INTO children (id, name, birthday, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Score Kid', ?, 1, ?, ?)`).run(CHILD, BIRTHDAY, window[0], window[1]);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Score cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
  // Moving until 19:40 (settling), a 20-minute wake at 01:00, moving from 06:00 (up); put down 19:10, out 06:02.
  layMinutes([[local(18, 0), local(19, 40)], [local(1, 0, 1), local(1, 20, 1)], [local(6, 0, 1), local(7, 0, 1)]], local(18, 0), local(7, 0, 1));
  layTransition(TRANSITION.INTO_BED, local(19, 10));
  layTransition(TRANSITION.OUT_OF_BED, local(6, 2, 1));
}
// The seven nights before DATE, saved with `contextRaw`.
function seedUsualBefore(contextRaw) {
  for (let n = 1; n <= 7; n++) {
    const d = addDays(DATE, -n);
    putUsualNight(d, local(19, 0, 0, d), 12, contextRaw);
  }
}
// The context a plain compute of the fixed night runs with, as it is stored.
const FIXED_CONTEXT = { v: 1, camera_id: CAM, tz: TZ, window: { start: '19:00', end: '07:00' }, algo: '6' };
// Precondition for every literal below: the detector still reads the fixed night as the header says. If this
// fails, the detector moved, not the score.
function fixedNightFigures(night) {
  assert.deepEqual(
    [night.status, night.onset_at, night.wake_at, night.in_bed_at, night.asleep_minutes, night.awake_minutes, night.wake_count,
      night.longest_stretch_minutes, night.stir_minutes, night.unknown_minutes, night.coverage_minutes],
    ['ok', sqlAt(local(19, 40)), sqlAt(local(6, 0, 1)), sqlAt(local(19, 10)), 600, 20, 1, 320, 0, 0, 720],
    'precondition: the fixed night reads as the file header says'
  );
}
// Store the fixed night as the nightly job would, with its seven usual nights behind it. Returns the saved row.
function storeFixedWithUsual() {
  const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(summary.stored, true, 'precondition: the night was stored');
  fixedNightFigures(rowOf());
  assert.deepEqual(parseScoringContext(rowOf().scoring_context), { ...FIXED_CONTEXT, algo: currentScoringContext(CHILD).algo });
  seedUsualBefore(rowOf().scoring_context);
  return rowOf();
}
const GREAT_96 = [96, 'great', [['duration', 100], ['continuity', 97], ['settling', 80], ['restlessness', 100], ['consistency', 92]]];
const headline = (score) => [score.score, score.band, score.components.map((c) => [c.key, c.score])];

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', 'UTC')
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run();
  const admin = makeUser(db, { id: 'u-sr', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  resetScoreLogForTest();
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// ================================ /sleep/:date and /sleep?nights=N, the fixed night ================================

test('/sleep/:date fresh, every read shape: the score is scoreNight on the night returned, 96, and no other key moved', async () => {
  setUpFixed();
  seedUsualBefore(JSON.stringify(FIXED_CONTEXT));
  assert.equal(rowOf(), undefined, 'precondition: the night itself is not saved, so every answer is a fresh compute');
  const plain = json(computeNight(CHILD, DATE));
  fixedNightFigures(plain);

  for (const query of ['', '?context=current', '?context=auto', '?context=current&raw=1']) {
    const r = await get(`/sleep/${DATE}${query}`);
    assert.equal(r.status, 200, query);
    assert.deepEqual(omit(r.body, 'score'), plain, `${query}: every key the night had, unchanged, and only score added`);
    assert.deepEqual(headline(r.body.score), GREAT_96, query);
    // Found its usual: so the compute's own context reached the score (without it there is no baseline, and the
    // score is an early estimate against the age figure, 683 minutes at 37 months).
    assert.deepEqual([r.body.score.early_estimate, comp(r.body.score, 'duration').basis, comp(r.body.score, 'duration').usual],
      [false, 'asleep_vs_usual', 600], query);
    assert.deepEqual(r.body.score, expected(r.body, FIXED_CONTEXT), query);
    assert.deepEqual([r.body.score.version, r.body.score.provisional, r.body.score.low_confidence], [2, false, false], query);
  }

  // detail=1: the same night with a timeline (and the frames list), so the same score.
  const detail = await get(`/sleep/${DATE}?detail=1`);
  const withTimeline = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.deepEqual(omit(detail.body, 'score'), json({ ...withTimeline, transition_frames: framesForNight(withTimeline) }));
  assert.ok(detail.body.segments.length > 0, 'precondition: this is the timeline shape');
  assert.deepEqual(headline(detail.body.score), GREAT_96);
});

test('/sleep?nights=N and ?stored=1: the saved row is scored on its own context, 96, and no other key moved', async () => {
  setUpFixed();
  const row = storeFixedWithUsual();

  const list = await get('/sleep?nights=60');
  assert.equal(list.body.nights.length, 8, 'precondition: the night and its seven usual nights');
  const night = list.body.nights.find((n) => n.night_date === DATE);
  assert.deepEqual(omit(night, 'score'), json(row), 'the stored row, every column as stored');
  assert.deepEqual(headline(night.score), GREAT_96);
  assert.deepEqual(night.score, expected(night));
  // Each usual night is scored too, against the ones before it: the oldest has none, so with no baseline it is an
  // early estimate (its 660-minute span against the age figure, 684 minutes at 36 months: 24 under ->
  // 100 - 50 * 24/90 = 87).
  const oldest = list.body.nights.at(-1);
  assert.deepEqual([oldest.night_date, oldest.score.early_estimate, oldest.score.band, comp(oldest.score, 'duration').score],
    [addDays(DATE, -7), true, null, 87]);

  const stored = await get(`/sleep/${DATE}?stored=1`);
  assert.deepEqual(Object.keys(stored.body).sort(), ['contexts', 'locked', 'night']);
  assert.deepEqual(omit(stored.body.night, 'score'), json(row));
  assert.deepEqual(headline(stored.body.night.score), GREAT_96);

  // No saved row: `night` stays null, as before; there is nothing to hang a score on.
  const none = await get(`/sleep/${addDays(DATE, 5)}?stored=1`);
  assert.equal(none.body.night, null);
});

test('a corrected night: the score is of the corrected figures; raw=1 and ?stored=1 keep the detector\'s', async () => {
  setUpFixed();
  storeFixedWithUsual();
  // The parent moved the wake an hour earlier, 06:00 to 05:00. The overlay re-derives asleep: 19:40 to 05:00 is
  // 560 minutes, less 20 awake = 540. By hand:
  //   duration     540 against 600, 60 under -> 100 - 50 * (60/90) = 66.7 ............ 67
  //   continuity   efficiency 540/560 -> 100; longest stretch dropped (the span moved 60 minutes);
  //                1 wake -> 95.  (0.5 * 100 + 0.2 * 95) / 0.7 = 98.6 ................. 99
  //   settling     unchanged ........................................................ 80
  //   restlessness dropped with the span ............................................ none
  //   consistency  asleep 100; up 05:00 against 06:30, 90 apart -> 50 - 50 * (30/90) = 33.  66.5 -> 67
  //   score        (35*67 + 30*99 + 15*80 + 5*67) / 85 = 80.6 ....................... 81, "good"
  saveNightReview(CHILD, DATE, { trueWakeAt: sqlAt(local(5, 0, 1)) }, { storeFirst: false });
  const CORRECTED = [81, 'good', [['duration', 67], ['continuity', 99], ['settling', 80], ['restlessness', null], ['consistency', 67]]];

  for (const path of [`/sleep/${DATE}`, `/sleep/${DATE}?context=auto&detail=1`]) {
    const r = await get(path);
    assert.deepEqual([r.body.corrected, r.body.wake_at, r.body.asleep_minutes], [true, sqlAt(local(5, 0, 1)), 540], `precondition: ${path} returns the corrected night`);
    assert.deepEqual(headline(r.body.score), CORRECTED, path);
    assert.deepEqual([comp(r.body.score, 'duration').value, comp(r.body.score, 'restlessness').reason], [540, 'span_corrected'], path);
    assert.deepEqual(r.body.score, expected(r.body, FIXED_CONTEXT), path);
  }
  const listed = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  assert.deepEqual([listed.asleep_minutes, headline(listed.score)], [540, CORRECTED]);

  // The two shapes that return the detector's own night score that night.
  const raw = await get(`/sleep/${DATE}?context=current&raw=1`);
  assert.deepEqual([raw.body.corrected, raw.body.asleep_minutes, headline(raw.body.score)], [undefined, 600, GREAT_96]);
  const stored = await get(`/sleep/${DATE}?stored=1`);
  assert.deepEqual([stored.body.night.corrected, stored.body.night.asleep_minutes, headline(stored.body.night.score)], [undefined, 600, GREAT_96]);
});

test('a replay is scored with the context the night was SAVED with, not today\'s; today\'s settings get today\'s', async () => {
  setUpFixed();
  const row = storeFixedWithUsual();
  // The sleep window is changed after the night was saved. Every earlier night was measured 19:00 to 07:00.
  db.prepare("UPDATE children SET sleep_window_start = '20:00' WHERE id = ?").run(CHILD);
  assert.equal(currentScoringContext(CHILD).window.start, '20:00', 'precondition: today\'s window differs from the saved one');
  const saved = parseScoringContext(row.scoring_context);

  // The detail page's read (auto) and the forced replay both work the night out with the saved window, so the
  // score is against the usual of that window: found, ready, 96.
  for (const query of ['?context=auto', '?context=stored', '?context=stored&raw=1', '?context=auto&detail=1']) {
    const r = await get(`/sleep/${DATE}${query}`);
    assert.equal(r.status, 200, query);
    fixedNightFigures(r.body);
    if (query.includes('auto')) assert.equal(r.body.scoring_view.applied, 'stored', `precondition: ${query} replayed the saved settings`);
    assert.deepEqual(headline(r.body.score), GREAT_96, query);
    assert.deepEqual([r.body.score.early_estimate, comp(r.body.score, 'duration').usual], [false, 600], query);
    assert.deepEqual(r.body.score, expected(r.body, saved), query);
  }

  // "Show with today's settings" (and any older client: no param) is a compute with the 20:00 window. No stored
  // night was measured with that window, so there is no usual: an early estimate against the age figure
  // (683 minutes at 37 months; the 620-minute span is 63 under -> 100 - 50 * 63/90 = 65), with no band word.
  for (const query of ['', '?context=current']) {
    const r = await get(`/sleep/${DATE}${query}`);
    assert.deepEqual([r.body.status, r.body.scoring_view.applied], ['ok', 'current'], `precondition: ${query || 'no param'} used today's settings`);
    const duration = comp(r.body.score, 'duration');
    assert.deepEqual([r.body.score.early_estimate, r.body.score.band, duration.basis, duration.value, duration.usual, duration.score],
      [true, null, 'span_vs_age', 620, 683, 65], query);
    assert.deepEqual(r.body.score, expected(r.body, currentScoringContext(CHILD)), query);
  }

  // An admin's Recompute with the saved settings returns the summary it stored, scored on those settings too.
  const store = await get(`/sleep/${DATE}?store=1&context=stored`);
  assert.deepEqual([store.status, store.body.stored], [200, true]);
  assert.deepEqual([headline(store.body.score), store.body.score.early_estimate], [GREAT_96, false]);
});

test('raw samples gone, saved row kept: the detail read is no_data and its score is the saved night\'s', async () => {
  setUpFixed();
  storeFixedWithUsual();
  const listed = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  // Retention deleted the minute-by-minute data (kept 30 days); the saved row is kept.
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM bed_transitions').run();
  const before = json(computeNightForDisplay(CHILD, DATE, { includeTimeline: true, mode: 'auto' }));
  assert.equal(before.status, 'no_data', 'precondition: the night can no longer be worked out');

  const r = await get(`/sleep/${DATE}?context=auto&detail=1`);
  assert.equal(r.status, 200);
  assert.deepEqual(omit(r.body, 'score', 'score_source'), { ...before, transition_frames: [] }, 'the no_data night exactly as before');
  assert.equal(r.body.score_source, 'stored');
  assert.deepEqual(headline(r.body.score), GREAT_96);
  assert.deepEqual(r.body.score, listed.score, 'the same score the list gives the saved row');

  // With the parent's correction over the saved row (the wake an hour earlier: 81, see the corrected-night test).
  saveNightReview(CHILD, DATE, { trueWakeAt: sqlAt(local(5, 0, 1)) }, { storeFirst: false });
  const corrected = await get(`/sleep/${DATE}?context=auto`);
  assert.deepEqual([corrected.body.status, corrected.body.score_source, corrected.body.score.score, comp(corrected.body.score, 'duration').value],
    ['no_data', 'stored', 81, 540]);
  // raw=1 returns the night without the correction, so the saved row is scored without it too.
  const raw = await get(`/sleep/${DATE}?context=current&raw=1`);
  assert.deepEqual([raw.body.score_source, raw.body.score.score], ['stored', 96]);

  // A saved row that is not a scored night (here: the detector saw an empty bed) has no score to lend: the answer
  // is about the night returned, and does not claim a saved score.
  db.prepare("UPDATE sleep_nights SET status = 'empty' WHERE child_id = ? AND night_date = ?").run(CHILD, DATE);
  const emptyRow = await get(`/sleep/${DATE}?context=current&raw=1`);
  assert.deepEqual([emptyRow.body.score, 'score_source' in emptyRow.body],
    [{ score: null, reason: 'not_ok', version: 2, status: 'no_data' }, false]);

  // No saved row either: nothing to score, and no claim that the score came from one.
  db.prepare('DELETE FROM sleep_nights WHERE child_id = ? AND night_date = ?').run(CHILD, DATE);
  const none = await get(`/sleep/${DATE}?context=auto`);
  assert.deepEqual(none.body.score, { score: null, reason: 'not_ok', version: 2, status: 'no_data' });
  assert.equal('score_source' in none.body, false);
});

test('a night still in progress never borrows a saved row\'s score, even when it reads no_data', () => {
  // The fresh night: no data yet, window still open. A saved `ok` row of the same date exists (the window was
  // extended after it was stored). The saved row must not even be read.
  const fresh = { night_date: '2026-03-10', status: 'no_data', in_progress: true };
  let asked = 0;
  const out = attachScore({ id: 'kid-x', birthday: null }, fresh, { storedNight: () => { asked += 1; return { status: 'ok' }; } });
  assert.deepEqual([out.score.score, out.score.reason, 'score_source' in out, asked], [null, 'in_progress', false, 0]);
});

test('a score that throws never fails the route: 200, score null, the night untouched, one log line', async (t) => {
  setUpFixed();
  storeFixedWithUsual();
  const warn = t.mock.method(logger, 'warn', () => {});
  const plain = json(computeNight(CHILD, DATE));

  failNextScoreForTest();
  const detail = await get(`/sleep/${DATE}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body, { ...plain, score: null });

  // In the list only the night whose score failed loses it (the first scored: the newest). The seven usual nights
  // keep theirs: each has fewer than seven nights before it, so an early estimate. By hand: duration 87 (660
  // against 684); continuity 0.5 * 94 + 0.3 * 90 + 0.2 * 90 = 92; settling 100; the other two need a usual.
  // (35*87 + 30*92 + 15*100) / 80 = 91.3 -> 91.
  failNextScoreForTest();
  const list = await get('/sleep?nights=60');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.nights.map((n) => n.score && n.score.score), [null, 91, 91, 91, 91, 91, 91, 91]);

  // A fixed sentence, once: no error text (it can carry an id), and no flood from a fault that hits every read.
  assert.deepEqual(warn.mock.calls.map((c) => c.arguments), [['[sleep] sleep score skipped: scoring a night failed']]);

  // The seam is one-shot: the next read is scored again.
  assert.equal((await get(`/sleep/${DATE}`)).body.score.score, 96);
});

test('#1041 through the route: a doubted wake the parent saved at the SAME time is confirmed; a put-down alone is not', async () => {
  setUpFixed();
  const row = storeFixedWithUsual();
  // The detector skipped an exit at 04:10 as too early and so doubts its own 06:00 wake.
  db.prepare('UPDATE sleep_nights SET wake_unconfirmed_at = ? WHERE child_id = ? AND night_date = ?').run(sqlAt(local(4, 10, 1)), CHILD, DATE);
  const read = async () => (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  const wakeTerm = (night) => term(night.score, 'consistency', 'wake').available;

  const doubted = await read();
  assert.deepEqual([doubted.score.low_confidence, doubted.score.low_confidence_reasons, wakeTerm(doubted)], [true, ['wake_unconfirmed'], false]);

  // Only the put-down given (19:05): corrected, but nobody has said anything about the wake.
  saveNightReview(CHILD, DATE, { trueInBedAt: sqlAt(local(19, 5)) }, { storeFirst: false });
  const putDownOnly = await read();
  assert.deepEqual([putDownOnly.corrected, 'wake_given' in putDownOnly, putDownOnly.score.low_confidence_reasons, wakeTerm(putDownOnly)],
    [true, false, ['wake_unconfirmed'], false]);

  // The wake saved exactly as the detector had it: confirmed, and nothing else about the night moved.
  saveNightReview(CHILD, DATE, { trueInBedAt: null, trueWakeAt: row.wake_at }, { storeFirst: false });
  const confirmed = await read();
  assert.deepEqual([confirmed.wake_at, confirmed.asleep_minutes, confirmed.wake_given], [row.wake_at, 600, true]);
  assert.deepEqual([confirmed.score.low_confidence, confirmed.score.low_confidence_reasons, wakeTerm(confirmed)], [false, [], true]);
  assert.deepEqual(headline(confirmed.score), GREAT_96);
});

// ================================ /sleep/live, placed relative to the real clock ================================
//
// ⚠️ CLOCK-INDEPENDENT ON PURPOSE, as sleep-live-last-night.test.js is: /sleep/live answers "tonight so far" whenever
// the real clock is inside the child's window, so the window is placed RELATIVE TO NOW (UTC, so no clock change
// exists): it opens two hours from now and is twelve hours long, so "now" is never inside it and the last completed
// night ended about ten hours ago. Every night is laid against lastCompletedNightDate, the function the route uses.

const LIVE_HOURS = 12;
let liveStartHour;
const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
const liveStart = (date) => Date.parse(`${date}T00:00:00Z`) + liveStartHour * HOUR;

function setUpLive(startHour = new Date().getUTCHours() + 2) {
  liveStartHour = ((startHour % 24) + 24) % 24;
  db.prepare("UPDATE settings SET timezone = 'UTC' WHERE id = 'app'").run();
  db.prepare(`INSERT INTO children (id, name, birthday, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Score Kid', '2020-01-01', 1, ?, ?)`).run(CHILD, hh(liveStartHour), hh(liveStartHour + LIVE_HOURS));
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Score cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
}
// The seven nights before `date`, saved with today's context (the window just set).
function seedLiveUsualBefore(date, over = {}) {
  const raw = JSON.stringify(currentScoringContext(CHILD));
  for (let n = 1; n <= 7; n++) putUsualNight(addDays(date, -n), liveStart(addDays(date, -n)), LIVE_HOURS, raw, over);
}
const expectedLive = (night, context = null) => {
  const input = toScoringInput(omit(night, 'score'), { context });
  return json(scoreNight(input, sleepBaseline(CHILD, input), ageMonthsOn('2020-01-01', input.night_date)));
};

test('/sleep/live: the saved last night is scored from its row, 93, and no other key moved', async () => {
  setUpLive();
  const last = lastCompletedNightDate(CHILD);
  assert.equal(currentNightDate(CHILD), null, 'precondition: no night in progress');
  // Eight nights alike, the last one included: 600 asleep, 150 awake, 4 wakes, longest stretch 300, 20 stir
  // minutes, a 20-minute settle. Against a usual that is itself (sleep-score.test.js, "a full night", by hand):
  // duration 100; continuity 0.5 * 73 + 0.3 * 80 + 0.2 * 80 = 77; settling 100; restlessness 100; consistency 100.
  // (3500 + 2310 + 1500 + 1500 + 500) / 100 = 93.1 -> 93, "great".
  const figures = { awake_minutes: 150, wake_count: 4, longest_stretch_minutes: 300 };
  seedLiveUsualBefore(last, figures);
  putUsualNight(last, liveStart(last), LIVE_HOURS, JSON.stringify(currentScoringContext(CHILD)), figures);

  const r = await get('/sleep/live');
  assert.equal(r.body.scope, 'last');
  assert.deepEqual(omit(r.body.night, 'score'), json(rowOf(last)), 'the stored row, every column as stored');
  assert.deepEqual(headline(r.body.night.score),
    [93, 'great', [['duration', 100], ['continuity', 77], ['settling', 100], ['restlessness', 100], ['consistency', 100]]]);
  assert.deepEqual(r.body.night.score, expectedLive(r.body.night));

  // The correction is under the score here too. The wake an hour earlier: the span is 600 minutes (30 minutes in,
  // to 90 before the end), less 150 awake = 450 asleep, 150 under the usual -> 50 - 50 * (60/150) = 30.
  saveNightReview(CHILD, last, { trueWakeAt: sqlAt(liveStart(last) + LIVE_HOURS * HOUR - 90 * MIN) }, { storeFirst: false });
  const corrected = (await get('/sleep/live')).body.night;
  const duration = comp(corrected.score, 'duration');
  assert.deepEqual([corrected.corrected, corrected.asleep_minutes, duration.value, duration.score], [true, 450, 450, 30]);
});

test('/sleep/live: last night computed fresh is scored with the context that compute ran with, so it has its usual', async () => {
  setUpLive();
  const last = lastCompletedNightDate(CHILD);
  seedLiveUsualBefore(last);
  // The night just ended, not saved yet: settling for the first ten minutes, still after, up for the last hour.
  const start = liveStart(last);
  const end = start + LIVE_HOURS * HOUR;
  layMinutes([[start, start + 10 * MIN], [end - HOUR, end]], start - 70 * MIN, end);
  assert.equal(rowOf(last), undefined, 'precondition: no saved row for last night');

  const r = await get('/sleep/live');
  const night = r.body.night;
  assert.deepEqual([r.body.scope, night.night_date, night.in_progress], ['last', last, false]);
  assert.deepEqual(omit(night, 'score'), json(computeNight(CHILD, last)), 'the fresh night exactly as before');
  // Precondition for the literals: the detector reads this night as asleep ten minutes in and up an hour before
  // the window's end, 650 minutes, unbroken. If this fails the detector moved, not the score.
  assert.deepEqual([night.status, night.onset_at, night.wake_at, night.asleep_minutes, night.awake_minutes, night.wake_count, night.in_bed_at],
    ['ok', sqlAt(start + 10 * MIN), sqlAt(end - HOUR), 650, 0, 0, null]);
  // The usual was found (seven saved nights with today's camera and window), so the score is not an early
  // estimate: duration 650 against a usual 600 -> 100. Without the context the compute ran with there is no
  // usual, and the score would be an early estimate against the age figure.
  const duration = comp(night.score, 'duration');
  assert.deepEqual([night.score.early_estimate, duration.basis, duration.value, duration.usual, duration.score],
    [false, 'asleep_vs_usual', 650, 600, 100]);
  // Consistency, by hand: asleep 10 minutes into the window against a usual 30 (20 apart) -> 100 - 50 * 5/45 =
  // 94; up 60 minutes before its end against a usual 30 (30 apart) -> 83. (94 + 83) / 2 = 88.5 -> 89.
  assert.deepEqual([comp(night.score, 'consistency').score, comp(night.score, 'settling').reason], [89, 'no_in_bed']);
  assert.deepEqual(night.score, expectedLive(night, currentScoringContext(CHILD)));
});

test('/sleep/live: tonight, in progress, has no score and says why', async () => {
  setUpLive(new Date().getUTCHours() - 1); // the window opened an hour ago
  const current = currentNightDate(CHILD);
  assert.ok(current, 'precondition: a night is in progress');
  seedLiveUsualBefore(current); // a ready usual changes nothing: the night is not over
  const r = await get('/sleep/live');
  assert.deepEqual([r.body.scope, r.body.night.night_date, r.body.night.in_progress], ['tonight', current, true]);
  assert.deepEqual(r.body.night.score, { score: null, reason: 'in_progress', version: 2 });
});

test('/sleep/live: sleep tracking off is unchanged, no night and so no score', async () => {
  setUpLive();
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  assert.deepEqual((await get('/sleep/live')).body, { scope: 'off', night: null });
});

// ================================ the per-child "Show sleep score" switch (phase 2) ================================
//
// With `children.show_sleep_score = 0` every sleep route returns the night as it was before the score existed: no
// `score` key and no `score_source`, every other key unchanged. Each test first proves the score IS there with the
// switch on (the precondition: without it "absent" could mean the fixture never scored), then turns it off.

const showScore = (on) => db.prepare('UPDATE children SET show_sleep_score = ? WHERE id = ?').run(on, CHILD);

test('switch off, /sleep/:date: no score key on any read shape, every other key unchanged; back on, 96 again', async () => {
  setUpFixed();
  seedUsualBefore(JSON.stringify(FIXED_CONTEXT));
  assert.equal(db.prepare('SELECT show_sleep_score FROM children WHERE id = ?').get(CHILD).show_sleep_score, 1,
    'precondition: a new child has the switch on');
  const plain = json(computeNight(CHILD, DATE));
  const on = await get(`/sleep/${DATE}`);
  assert.equal(on.body.score.score, 96, 'precondition: with the switch on this night has a score');

  showScore(0);
  for (const query of ['', '?context=current', '?context=auto', '?context=current&raw=1']) {
    const r = await get(`/sleep/${DATE}${query}`);
    assert.equal(r.status, 200, query);
    assert.deepEqual(r.body, plain, `${query}: the night exactly as computed, nothing added`);
    assert.equal('score' in r.body, false, query);
  }
  const detail = await get(`/sleep/${DATE}?detail=1`);
  const withTimeline = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.deepEqual(detail.body, json({ ...withTimeline, transition_frames: framesForNight(withTimeline) }));

  // An admin's store answers with a night too.
  const stored = await get(`/sleep/${DATE}?store=1`);
  assert.deepEqual([stored.status, stored.body.stored, 'score' in stored.body], [200, true, false]);

  showScore(1);
  assert.equal((await get(`/sleep/${DATE}`)).body.score.score, 96, 'read on every request: back on, the score is back');
});

test('switch off, /sleep?nights=N and ?stored=1: the saved rows as stored, no score key', async () => {
  setUpFixed();
  const row = storeFixedWithUsual();
  const on = (await get('/sleep?nights=60')).body.nights;
  assert.deepEqual(on.map((n) => typeof n.score.score), Array(8).fill('number'), 'precondition: all eight nights score with the switch on');

  showScore(0);
  const list = await get('/sleep?nights=60');
  assert.equal(list.body.nights.length, 8);
  assert.deepEqual(list.body.nights.map((n) => 'score' in n), Array(8).fill(false));
  assert.deepEqual(list.body.nights.find((n) => n.night_date === DATE), json(row), 'the stored row, every column as stored');

  const stored = await get(`/sleep/${DATE}?stored=1`);
  assert.deepEqual(Object.keys(stored.body).sort(), ['contexts', 'locked', 'night']);
  assert.deepEqual(stored.body.night, json(row));
});

test('switch off, raw samples gone: the no_data night carries neither the saved score nor score_source', async () => {
  setUpFixed();
  storeFixedWithUsual();
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM bed_transitions').run();
  const before = json(computeNightForDisplay(CHILD, DATE, { includeTimeline: false, mode: 'auto' }));
  const on = await get(`/sleep/${DATE}?context=auto`);
  assert.deepEqual([on.body.status, on.body.score_source, on.body.score.score], ['no_data', 'stored', 96],
    'precondition: with the switch on the saved score is lent to this night');

  showScore(0);
  const r = await get(`/sleep/${DATE}?context=auto`);
  assert.deepEqual(r.body, before);
  assert.deepEqual(['score' in r.body, 'score_source' in r.body], [false, false]);
});

test('switch off, /sleep/live: last night and tonight carry no score key', async () => {
  setUpLive();
  const last = lastCompletedNightDate(CHILD);
  seedLiveUsualBefore(last);
  putUsualNight(last, liveStart(last), LIVE_HOURS, JSON.stringify(currentScoringContext(CHILD)));
  const on = await get('/sleep/live');
  assert.deepEqual([on.body.scope, typeof on.body.night.score.score], ['last', 'number'], 'precondition: scored with the switch on');

  showScore(0);
  const r = await get('/sleep/live');
  assert.deepEqual(r.body, { scope: 'last', night: json(rowOf(last)) });

  // Tonight, in progress: with the switch on it says `in_progress`; off, it says nothing at all.
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM children').run();
  setUpLive(new Date().getUTCHours() - 1);
  assert.equal((await get('/sleep/live')).body.night.score.reason, 'in_progress', 'precondition');
  showScore(0);
  const tonight = await get('/sleep/live');
  assert.deepEqual([tonight.body.scope, tonight.body.night.in_progress, 'score' in tonight.body.night], ['tonight', true, false]);
});
