// "Up between X and Y" on the wire (lib/wakeRange.js wired into routes/children.js). The rule's own edges are
// in wake-range.test.js; this file pins what only a route can show:
//   - `wake_range` is on GET /review/:date, the morning review screen's data, and NOWHERE else: the hold-out
//     check put a range on 33% of the nights that were right (over the 25% bar), so the child card, the history
//     list, the detail page and the review card carry no such field (a range there would be noise);
//   - it is computed AFTER the parent's correction, so a corrected night, and "no one was in the bed", read null;
//   - it is additive: the review response keeps every field it had, byte-identical.
//
// One REAL night is laid minute by minute (the "exit earlier than the movement-only wake" shape of #509 C3 in
// sleepAnalysis.test.js), so the two estimates come out of the real detector rather than out of a fixture that
// agrees with the code by construction. Melbourne is the fixture zone because a real, non-UTC zone is what
// catches a hard-coded offset.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight } = await import('../src/lib/sleepAnalysis.js');
const { getNightReview } = await import('../src/lib/sleepReviews.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'wr-child';
const CAM = 'wr-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne in July: UTC+10, no DST edge anywhere near
const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const plus = (d, n) => new Date(d.getTime() + n * 60000);
const hhmm = (u) => (u
  ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' })
  : null);
// The clock for every request: an hour after the 07:00 window closed, so the night is finished and is "last night".
const MORNING = () => at(8, 0, 1).getTime();

const STILL_OCCUPIED = 0.004;
const STILL_EMPTY = 0.0002;
const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTrace = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak,
     motion_out_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, ?, ?, 1, 0)`
);
const insertTransition = db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)');

// The #509 C3 shape: movement stops at 05:30, the bed reads empty-still from 05:31 while the room stays
// audible until 06:25, and the child is logged leaving the bed at 05:31. The reported wake (the exit) is
// 05:31 and the movement-only wake is 06:25: 54 minutes apart, so a range.
function layRangeNight() {
  for (let t = at(19, 30); t < at(5, 25, 1); t = plus(t, 1)) {
    const moving = t >= at(19, 30) && t < at(19, 40);
    insertSample.run(CAM, sql(t), moving ? 0.4 : STILL_OCCUPIED, moving ? 0.6 : STILL_OCCUPIED);
  }
  for (let t = at(5, 25, 1); t < at(5, 31, 1); t = plus(t, 1)) insertTrace.run(CAM, sql(t), 0.15, 0.15, 0, 0);
  for (let t = at(5, 31, 1); t < at(6, 25, 1); t = plus(t, 1)) insertTrace.run(CAM, sql(t), STILL_EMPTY, STILL_EMPTY, 0, 0);
  for (let t = at(6, 25, 1); t < at(8, 0, 1); t = plus(t, 1)) insertTrace.run(CAM, sql(t), STILL_EMPTY, STILL_EMPTY, 10, 0);
  insertTransition.run(CAM, 'out_of_bed', 0.05, sql(at(5, 31, 1, 10)));
}

let server;
let adminToken;
const get = (path) => call(`${server.url}/api/children/${CHILD}${path}`, { token: adminToken });
const put = (path, body) => call(`${server.url}/api/children/${CHILD}${path}`, { method: 'PUT', token: adminToken, body });

// Every other response that carries this night beside `wake_at`, and how to reach the night inside the body.
const OTHER_SURFACES = [
  ['/sleep/live (the child card)', () => get('/sleep/live'), (b) => b.night],
  ['/sleep (the history list)', () => get('/sleep?nights=60'), (b) => b.nights.find((n) => n.night_date === DATE)],
  ['/sleep/:date (the detail page)', () => get(`/sleep/${DATE}`), (b) => b],
  ['/sleep/:date?context=auto (what the detail page sends)', () => get(`/sleep/${DATE}?context=auto`), (b) => b],
  ['/sleep/:date?stored=1', () => get(`/sleep/${DATE}?stored=1`), (b) => b.night],
  ['/review/pending (the review card)', () => get('/review/pending'), (b) => b],
];

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Range Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Range Cam', 'rtsp://example/stream', ?, 'rangecam')`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('★ the review screen\'s data carries the range from a REAL night with two different estimates, earlier time first', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(summary.status, 'ok', 'precondition');
  assert.equal(hhmm(summary.wake_at), '05:31', 'precondition: the reported wake is the exit');
  assert.equal(hhmm(summary.wake_at_algo), '06:25', 'precondition: the movement-only wake is the later one');

  const res = await get(`/review/${DATE}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.wake_range, { from: summary.wake_at, to: summary.wake_at_algo });
  // Additive: with the field removed the response is exactly what the review helper returns, `computed.wake_at`
  // included (the screen shows both, so they must come from the same night).
  const { wake_range: range, ...rest } = res.body;
  assert.ok(range);
  assert.deepEqual(rest, JSON.parse(JSON.stringify(getNightReview(CHILD, DATE))));
  assert.equal(res.body.computed.wake_at, summary.wake_at);
});

test('★ the range is on the review screen ONLY: the card, history, detail, raw reads and review card carry no such field', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.ok((await get(`/review/${DATE}`)).body.wake_range, 'precondition: this night really has a range');
  for (const [label, fetch, nightOf] of OTHER_SURFACES) {
    const res = await fetch();
    assert.equal(res.status, 200, label);
    const night = nightOf(res.body);
    assert.ok(night, `${label}: the night is there`);
    assert.equal('wake_range' in night, false, `${label}: no wake_range (false alarms on right nights were over the bar)`);
  }
  // The review card also repeats the card's fields inside `pending`.
  const card = (await get('/review/pending')).body;
  assert.equal(card.state, 'ask');
  assert.equal('wake_range' in card.pending, false);
});

test('★ a night the parent corrected shows their single time: the review GET reads null afterwards', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  // The wake-only save the review screen sends: the answer, the two echoes of what was on screen, the settings key.
  const shown = (await get(`/review/${DATE}`)).body;
  assert.ok(shown.wake_range, 'precondition: the screen was offered a range');
  const saved = await put(`/review/${DATE}`, {
    true_wake_local: '06:40', computed_onset_at: shown.computed.onset_at, computed_wake_at: shown.computed.wake_at,
    settings_key: shown.settings.key,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = (await get(`/review/${DATE}`)).body;
  assert.equal(after.wake_range, null, 'the field is present and null, not a range beside the parent\'s time');
  assert.equal(hhmm(after.review.true_wake_at), '06:40');
});

test('"no one was in the bed" has no range: the detector\'s times it keeps as algo_* are not a wake', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal((await put(`/review/${DATE}`, { nobody_in_bed: true })).status, 200);
  const res = await get(`/review/${DATE}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.wake_range, null);
  assert.equal(res.body.review.nobody_in_bed, 1, 'precondition: the night really reads as flagged');
});

test('a night with no data answers with the field present and null', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  const res = await get(`/review/${DATE}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.computed.status, 'no_data');
  assert.equal(res.body.wake_range, null);
});

test('a night with ONE wake estimate (no movement-only wake) has no range: the still child shows a single time', async (t) => {
  // Same shape as the real night, but the room goes silent at 05:31, so there is no movement-only wake
  // (#509 C5 in sleepAnalysis.test.js): only the logged exit remains.
  for (let t2 = at(19, 30); t2 < at(5, 25, 1); t2 = plus(t2, 1)) insertSample.run(CAM, sql(t2), STILL_OCCUPIED, STILL_OCCUPIED);
  for (let t2 = at(5, 25, 1); t2 < at(5, 31, 1); t2 = plus(t2, 1)) insertTrace.run(CAM, sql(t2), 0.15, 0.15, 0, 0);
  for (let t2 = at(5, 31, 1); t2 < at(8, 0, 1); t2 = plus(t2, 1)) insertTrace.run(CAM, sql(t2), STILL_EMPTY, STILL_EMPTY, 0, 0);
  insertTransition.run(CAM, 'out_of_bed', 0.05, sql(at(5, 31, 1, 10)));
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(summary.status, 'ok', 'precondition');
  assert.equal(hhmm(summary.wake_at), '05:31', 'precondition');
  assert.ok(!summary.wake_at_algo || hhmm(summary.wake_at_algo) === '05:31', 'precondition: no LATER movement-only wake');
  assert.equal((await get(`/review/${DATE}`)).body.wake_range, null);
});
