// #355 — a night the detector scored `empty` that a parent CORRECTED becomes a scored night.
//
// Owner decision (2026-10-14): the corrected night is status 'ok', with its figures taken from the corrected
// times and `corrected` still set. Before, the overlay kept `empty` under the parent's times. The decision is
// made in applyCorrection (the overlay) ONLY, so it reaches the child card and the sleep detail page, not
// sleepInsights or the morning push (they read the stored row, which is never rewritten):
//   - the parent's two times are taken as given: asleep = the span, unknown 0, gaps in camera coverage NOT
//     subtracted (fix round 1 of PR #721: the window-wide subtraction was wrong both ways, see the gap test);
//   - what the detector computes for an UNCORRECTED night must not move (the golden test below);
//   - the lock still holds (a corrected night is complete and never recomputed);
//   - "no one was in the bed" still wins and stays unscored.
//
// ⚠️ The golden file pins "unchanged", not "whatever the new code says": its numbers were written by the code
// BEFORE #355 (the merge base of commit 84f0732) and only trimmed since. See the golden test for what is in
// it and what to do when a detector change legitimately moves it.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight, computeNight, nightIsLocked } = await import('../src/lib/sleepAnalysis.js');
const { applyCorrection } = await import('../src/lib/sleepReviews.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'ce-child';
const CAM = 'ce-cam';
const OK_DATE = '2026-07-01';
const EMPTY_DATE = '2026-07-03';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne in July: UTC+10
const GOLDEN = new URL('./fixtures/corrected-empty-golden.json', import.meta.url);

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
// Same two nights as nobody-in-bed.test.js: one plainly occupied (`ok`), one with not a flicker (`empty`).
function layNights() {
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    const moving = (t >= at(19, 30) && t < at(19, 40)) || (t >= at(6, 0, 1) && t < at(7, 0, 1));
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
  for (let t = at(18, 20, 2); t < at(7, 0, 3); t = new Date(t.getTime() + 60000)) insertSample.run(CAM, sqlTime(t), 0.004, 0.004);
}
const storedRow = (date) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const insertReview = (date, cols) => db.prepare(
  `INSERT INTO sleep_reviews (child_id, night_date, ${Object.keys(cols).join(', ')}) VALUES (?, ?, ${Object.keys(cols).map(() => '?').join(', ')})`
).run(CHILD, date, ...Object.values(cols));
const clearReviews = () => db.prepare('DELETE FROM sleep_reviews').run();
// A camera outage: no samples at all in [from, to), which is what computeNight counts as unwatched minutes.
const dropSamples = (from, to) => db.prepare('DELETE FROM activity_samples WHERE camera_id = ? AND bucket_start >= ? AND bucket_start < ?')
  .run(CAM, sqlTime(from), sqlTime(to));
// Naive UTC 'YYYY-MM-DD HH:MM:00', the way sleep_nights and sleep_reviews store an instant.
const sqlAt = (ms) => sqlTime(new Date(ms));
// The figures a promoted night reports, the ones the card and the detail page must agree on.
const FIGURES = ['status', 'onset_at', 'wake_at', 'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes', 'corrected', 'algo_status'];
const figures = (n) => Object.fromEntries(FIGURES.map((k) => [k, n[k]]));
const json = (v) => JSON.parse(JSON.stringify(v));
// computed_at is the wall clock; id is an autoincrement that depends on how many rows earlier cases wrote.
const stripClock = (row) => { const r = { ...row }; delete r.computed_at; delete r.id; return r; };

let server;
let adminToken;
const get = (path) => call(`${server.url}/api/children/${CHILD}${path}`, { token: adminToken });
const put = (body, date = EMPTY_DATE) => call(`${server.url}/api/children/${CHILD}/review/${date}`, { method: 'PUT', token: adminToken, body });

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', 'Australia/Melbourne')
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run();
  const admin = makeUser(db, { id: 'ce-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});
beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Test Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
  layNights();
});
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('an `empty` night with a correction becomes ok, with the minutes of the corrected span', async () => {
  const stored = computeAndStoreNight(CHILD, EMPTY_DATE);
  assert.equal(stored.status, 'empty', 'precondition: the detector scored an empty bed');
  // 19:40 -> 06:00 local = 10h20m = 620 minutes, in a window the cameras watched in full (no unknown minutes).
  assert.equal((await put({ true_onset_local: '19:40', true_wake_local: '06:00' })).status, 200);

  for (const path of ['/sleep?nights=1', `/sleep/${EMPTY_DATE}`, `/sleep/${EMPTY_DATE}?detail=1`]) {
    const raw = (await get(path)).body;
    const n = raw.nights ? raw.nights[0] : raw;
    assert.equal(n.status, 'ok', `${path}: scored`);
    assert.equal(n.corrected, true, `${path}: still marked corrected`);
    assert.equal(n.algo_status, 'empty', `${path}: the detector's verdict is kept alongside`);
    assert.equal(n.onset_at, '2026-07-03 09:40:00');
    assert.equal(n.wake_at, '2026-07-03 20:00:00');
    assert.equal(n.asleep_minutes, 620);
    assert.equal(n.awake_minutes, 0);
    assert.equal(n.unknown_minutes, 0);
    assert.equal(n.wake_count, 0);
    assert.equal(n.longest_stretch_minutes, 620, 'longest stretch never exceeds the total');
    assert.ok(n.longest_stretch_minutes <= n.asleep_minutes);
    // Corrected timestamps alone must not manufacture an observed timeline (#355 acceptance).
    for (const k of ['timeline', 'segments', 'wakes', 'visits', 'transitions']) assert.equal(n[k], undefined, `${path}: no ${k}`);
  }
  assert.equal(storedRow(EMPTY_DATE).status, 'empty', 'sleep_nights is never rewritten: the overlay only');
});

// Fix round 1 of PR #721 (review, verified by running): the first version subtracted the window's unwatched
// minutes from the parent's span, wherever they fell. Both nights below are the reviewer's examples.
test('a camera gap is not subtracted: the parent\'s span is taken as given, and the card and the detail page agree', async () => {
  // A 60-minute outage, 20:00 to 21:00 local. Still an `empty` night: 630 of the window's 690 minutes were
  // watched, over EMPTY_MIN_COVERAGE_FRAC (0.9 x 690 = 621).
  dropSamples(at(20, 0, 2), at(21, 0, 2));
  assert.equal(computeAndStoreNight(CHILD, EMPTY_DATE).status, 'empty', 'precondition: still an empty bed');
  assert.equal(storedRow(EMPTY_DATE).coverage_minutes, 630, 'precondition: 60 window minutes unwatched');
  const cases = [
    // [the parent's times, asleep minutes, what the first version reported instead]
    [{ true_onset_local: '05:30', true_wake_local: '06:00' }, 30, 'a fully watched 30 minutes: the first version said ok with 0 asleep'],
    [{ true_onset_local: '21:00', true_wake_local: '06:00' }, 540, 'the gap is wholly before the span: the first version said 480'],
  ];
  for (const [body, asleep, why] of cases) {
    clearReviews();
    assert.equal((await put(body)).status, 200);
    // The card path lays the overlay over the STORED row (GET /sleep and /sleep/live share applyCorrections);
    // the detail page lays it over a FRESH compute. Neither has a per-minute figure for the parent's span.
    const card = (await get('/sleep?nights=1')).body.nights[0];
    const detail = (await get(`/sleep/${EMPTY_DATE}?detail=1`)).body;
    for (const [where, n] of [['card', card], ['detail', detail]]) {
      assert.equal(n.status, 'ok', `${where}: ${why}`);
      assert.equal(n.asleep_minutes, asleep, `${where}: ${why}`);
      assert.equal(n.longest_stretch_minutes, asleep, `${where}: one stretch, equal to the total`);
      assert.equal(n.unknown_minutes, 0, `${where}: nothing is counted as unwatched inside the parent's span`);
      assert.equal(n.awake_minutes, 0, where);
      assert.equal(n.wake_count, 0, where);
    }
    assert.deepEqual(figures(detail), figures(card), 'the card and the detail page report the same night');
  }
});

test('the boundary is span > 0: a one-minute span is promoted, a zero-length one is not', () => {
  const night = { night_date: EMPTY_DATE, status: 'empty', onset_at: null, wake_at: null, window_start: '2026-07-03 09:30:00', window_end: '2026-07-03 21:00:00', coverage_minutes: 690 };
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 19:59:00', true_wake_at: '2026-07-03 20:00:00' });
  let out = applyCorrection(CHILD, night);
  assert.equal(out.status, 'ok', 'one minute is a span');
  assert.equal(out.asleep_minutes, 1);
  assert.equal(out.longest_stretch_minutes, 1);
  clearReviews();
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 20:00:00', true_wake_at: '2026-07-03 20:00:00' });
  out = applyCorrection(CHILD, night);
  assert.equal(out.status, 'empty', 'zero minutes is not');
  assert.equal(out.wake_count ?? null, null);
});

test('a STORED row whose window has not closed yet is not promoted (its window_end is read, as on the card path)', async () => {
  computeAndStoreNight(CHILD, EMPTY_DATE);
  // A stored row has no in_progress column (an admin ?store=1 of tonight is how a running night gets saved),
  // so nightNotOverYet reads its window_end. Moved an hour past now: the night is still running.
  const setWindowEnd = (v) => db.prepare('UPDATE sleep_nights SET window_end = ? WHERE child_id = ? AND night_date = ?').run(v, CHILD, EMPTY_DATE);
  setWindowEnd(sqlAt(Date.now() + 3600 * 1000));
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 09:40:00', true_wake_at: '2026-07-03 20:00:00' });
  let n = (await get('/sleep?nights=1')).body.nights[0];
  assert.equal('in_progress' in n, false, 'precondition: the stored row carries no in_progress');
  assert.equal(n.status, 'empty', 'a running night keeps showing what the cameras see now');
  assert.equal(n.wake_count, null);
  assert.equal(n.corrected, true);
  // The same row and review, once that window has closed: promoted.
  setWindowEnd('2026-07-03 21:00:00');
  n = (await get('/sleep?nights=1')).body.nights[0];
  assert.equal(n.status, 'ok');
  assert.equal(n.asleep_minutes, 620);
});

test('one-sided, in-bed-only, zero-length and in-progress corrections of an `empty` night stay empty', () => {
  const base = { night_date: EMPTY_DATE, status: 'empty', onset_at: null, wake_at: null, window_start: '2026-07-03 09:30:00', window_end: '2026-07-03 21:00:00', coverage_minutes: 690 };
  const cases = [
    ['onset only', { true_onset_at: '2026-07-03 09:40:00' }, base],
    ['wake only', { true_wake_at: '2026-07-03 20:00:00' }, base],
    ['in bed only', { true_in_bed_at: '2026-07-03 09:35:00' }, base],
    ['wake not after onset', { true_onset_at: '2026-07-03 20:00:00', true_wake_at: '2026-07-03 20:00:00' }, base],
    ['night still in progress', { true_onset_at: '2026-07-03 09:40:00', true_wake_at: '2026-07-03 20:00:00' }, { ...base, in_progress: true }],
  ];
  const expectedAsleep = { 'wake not after onset': 0, 'night still in progress': 620 };
  for (const [label, cols, night] of cases) {
    clearReviews();
    insertReview(EMPTY_DATE, cols);
    const out = applyCorrection(CHILD, night);
    assert.equal(out.status, 'empty', label);
    // The pre-#355 figures are kept as they were (a span-derived asleep total where both times exist, floored
    // at 0), and no wake count is invented: only a PROMOTED night gets one.
    assert.equal(out.asleep_minutes ?? null, expectedAsleep[label] ?? null, label);
    assert.equal(out.wake_count ?? null, null, label);
    assert.equal(out.corrected, true, label);
  }
});

test('only `empty` is promoted: a corrected no_data or no_sleep night keeps its status', () => {
  // The owner decision names `empty` only, and the README and CHANGELOG say so: `no_data` is "we could not
  // see" and `no_sleep` is "no clear sleep", neither of them the detector saying nobody was there.
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 09:40:00', true_wake_at: '2026-07-03 20:00:00' });
  for (const status of ['no_data', 'no_sleep']) {
    const out = applyCorrection(CHILD, {
      night_date: EMPTY_DATE, status, onset_at: null, wake_at: null,
      window_start: '2026-07-03 09:30:00', window_end: '2026-07-03 21:00:00', coverage_minutes: 690,
    });
    assert.equal(out.status, status);
    assert.equal(out.algo_status, undefined, `${status}: not promoted, so no detector verdict kept beside it`);
    assert.equal(out.wake_count ?? null, null, status);
  }
});

test('"no one was in the bed" still wins and stays unscored, even beside times on the row', async () => {
  computeAndStoreNight(CHILD, EMPTY_DATE);
  // Saved through the API (the flag nulls the times)...
  assert.equal((await put({ nobody_in_bed: true })).status, 200);
  let n = (await get('/sleep?nights=1')).body.nights[0];
  assert.equal(n.status, 'empty');
  assert.equal(n.nobody_in_bed, true);
  assert.equal(n.asleep_minutes, null);
  // ...and a row that somehow holds both (inserted directly: the lib refuses it): the flag is checked first.
  clearReviews();
  insertReview(EMPTY_DATE, { nobody_in_bed: 1, true_onset_at: '2026-07-03 09:40:00', true_wake_at: '2026-07-03 20:00:00' });
  n = (await get('/sleep?nights=1')).body.nights[0];
  assert.equal(n.status, 'empty');
  assert.equal(n.nobody_in_bed, true);
  assert.equal(n.wake_count, null);
});

test('the lock still holds: a corrected, promoted night is not recomputed, and un-correcting restores `empty`', async () => {
  computeAndStoreNight(CHILD, EMPTY_DATE);
  await put({ true_onset_local: '19:40', true_wake_local: '06:00' });
  const before = stripClock(storedRow(EMPTY_DATE));
  assert.equal(nightIsLocked(CHILD, EMPTY_DATE), true);
  const r = computeAndStoreNight(CHILD, EMPTY_DATE, { allowDowngrade: false });
  assert.equal(r.stored, false);
  assert.equal(r.refused, 'reviewed');
  assert.deepEqual(stripClock(storedRow(EMPTY_DATE)), before, 'the stored row did not move');
  assert.equal((await get('/sleep?nights=1')).body.nights[0].status, 'ok');

  clearReviews();
  assert.equal(nightIsLocked(CHILD, EMPTY_DATE), false);
  assert.equal((await get('/sleep?nights=1')).body.nights[0].status, 'empty', 'removing the correction restores the detector night');
});

// ★ GOLDEN: the overlay's output on the nights this change must NOT alter, as the code before #355 produced it.
//
// How the numbers were captured: the first version of this test (commit 84f0732) wrote the whole of each
// night, per-minute timeline included, by running it with NIGHTLIGHT_WRITE_GOLDEN=1 on the source as it was
// at that commit's merge base, i.e. before applyCorrection knew about #355. Fix round 1 of PR #721 TRIMMED that
// file without recomputing anything (each night's row and overlay narrowed to OVERLAY_FIELDS below), because
// 92% of it was a timeline no overlay change can move, and deep-equalling it made every future detector or
// threshold change fail a #355 test. What is compared now:
//   - from the golden: the OVERLAY_FIELDS of each night's stored row and of the overlaid night;
//   - live, needing no golden: a night with no review (or a dismissed one) overlays to exactly its stored row;
//     every field outside OVERLAY_FIELDS passes through the overlay untouched; and computeNight's own answer
//     does not change with the review (the overlay never feeds back into the detector).
// Keep it narrow: a field joins OVERLAY_FIELDS only if applyCorrection can set it.
//
// ⚠️ IF A DETECTOR CHANGE LEGITIMATELY MOVES THESE NUMBERS (a threshold, a new stored figure): the old source
// that wrote them is gone, so do not "regenerate on the old source". Check that the diff is the detector's
// alone: the `row` of each night moves, and every `overlaid` moves with it the same way (an uncorrected
// night's overlaid equals its row; a corrected one differs from it only where its review says so). Then
// rewrite the file with NIGHTLIGHT_WRITE_GOLDEN=1 (that run FAILS on purpose, so it can never pass as a check),
// re-run without it, and say in the PR that the golden moved and why.
const OVERLAY_FIELDS = [
  'status', 'onset_at', 'wake_at', 'in_bed_at',
  'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes',
  'onset_at_shadow', 'wake_at_shadow', 'onset_at_algo', 'wake_at_algo',
  'corrected', 'nobody_in_bed', 'in_bed_corrected', 'algo_status', 'algo_onset_at', 'algo_wake_at', 'algo_in_bed_at',
  // #917: applyCorrection nulls the sensor shadow on a corrected night (and asNobodyInBed on a flagged one). Added with
  // the golden re-written: the diff was these two keys, null in every row and overlay (this fixture has no ESPHome rows).
  'wake_at_sensor', 'sensor_rejects',
];
// Only keys the object HAS: a key the overlay newly adds (an `algo_status` on an uncorrected night) shows up.
const pickOverlay = (o) => Object.fromEntries(OVERLAY_FIELDS.filter((k) => k in o).map((k) => [k, o[k]]));

test('★ golden: nothing a correction does not touch has moved (numbers from the pre-#355 code)', () => {
  const out = {};
  let computedBefore;
  const snap = (label, date, { uncorrected = false } = {}) => {
    const row = stripClock(storedRow(date));
    const overlaid = json(applyCorrection(CHILD, row));
    // Live: the overlay touches OVERLAY_FIELDS only; everything else is the stored row's own value.
    for (const k of new Set([...Object.keys(row), ...Object.keys(overlaid)])) {
      if (!OVERLAY_FIELDS.includes(k)) assert.deepEqual(overlaid[k], row[k], `${label}: ${k} passes through`);
    }
    if (uncorrected) assert.deepEqual(overlaid, json(row), `${label}: no correction, so exactly the stored row`);
    if (date === EMPTY_DATE) {
      const computed = json(computeNight(CHILD, EMPTY_DATE));
      if (computedBefore === undefined) computedBefore = computed;
      assert.deepEqual(computed, computedBefore, `${label}: the review does not change what the detector computes`);
    }
    out[label] = { row: pickOverlay(row), overlaid: pickOverlay(overlaid) };
  };
  computeAndStoreNight(CHILD, EMPTY_DATE);
  computeAndStoreNight(CHILD, OK_DATE);
  snap('uncorrected empty', EMPTY_DATE, { uncorrected: true });
  insertReview(EMPTY_DATE, { dismissed: 1, note: 'n' });
  snap('empty, dismissed review', EMPTY_DATE, { uncorrected: true });
  clearReviews();
  insertReview(EMPTY_DATE, { true_in_bed_at: '2026-07-03 09:35:00' });
  snap('empty, in bed only', EMPTY_DATE);
  clearReviews();
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 09:40:00' });
  snap('empty, onset only', EMPTY_DATE);
  clearReviews();
  insertReview(EMPTY_DATE, { nobody_in_bed: 1 });
  snap('empty, nobody in bed', EMPTY_DATE);
  clearReviews();
  snap('ok, uncorrected', OK_DATE, { uncorrected: true });
  insertReview(OK_DATE, { true_onset_at: '2026-07-01 09:45:00', true_wake_at: '2026-07-01 20:10:00' });
  snap('ok, corrected', OK_DATE);

  if (process.env.NIGHTLIGHT_WRITE_GOLDEN) {
    fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
    // Fails on purpose: a run that writes the file has compared nothing, so it must never read as a pass.
    assert.fail(`wrote ${GOLDEN.pathname}; this run checked nothing. Unset NIGHTLIGHT_WRITE_GOLDEN, re-run, and review the fixture's diff.`);
  }
  assert.deepEqual(out, JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});
