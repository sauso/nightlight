// #355 — a night the detector scored `empty` that a parent CORRECTED becomes a scored night.
//
// Owner decision (2026-10-14): the corrected night is status 'ok', with asleep/awake/wakes derived from the
// corrected times and `corrected` still set, so it reaches the child card, reports and trends. Today the
// overlay kept `empty` under the parent's times. The decision is made in applyCorrection (the overlay) ONLY:
//   - what the detector computes for an UNCORRECTED night must not move (the golden test below);
//   - the lock still holds (a corrected night is complete and never recomputed);
//   - "no one was in the bed" still wins and stays unscored.
//
// ⚠️ The golden file was written by the code BEFORE this change (NIGHTLIGHT_WRITE_GOLDEN=1, run on the old
// source) so it pins "unchanged", not "whatever the new code says". Everything in it is a case the change
// must NOT alter: uncorrected empty and ok nights, a dismissal, in-bed-only and one-sided corrections.

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

test('window minutes the cameras did not watch are subtracted, like on any corrected night', () => {
  const night = {
    night_date: EMPTY_DATE, status: 'empty', onset_at: null, wake_at: null, awake_minutes: null, unknown_minutes: null,
    window_start: '2026-07-03 09:30:00', window_end: '2026-07-03 21:00:00', coverage_minutes: 630,
  };
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 09:40:00', true_wake_at: '2026-07-03 20:00:00' });
  const out = applyCorrection(CHILD, night);
  assert.equal(out.status, 'ok');
  assert.equal(out.unknown_minutes, 60, '690 window minutes - 630 watched');
  assert.equal(out.asleep_minutes, 560, '620 span - 60 unwatched');
  assert.equal(out.longest_stretch_minutes, 560);
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

test('only `empty` is promoted: a corrected no_data night keeps its status', () => {
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 09:40:00', true_wake_at: '2026-07-03 20:00:00' });
  const out = applyCorrection(CHILD, { night_date: EMPTY_DATE, status: 'no_data', onset_at: null, wake_at: null });
  assert.equal(out.status, 'no_data');
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

test('★ golden: nothing a correction does not touch has moved (written by the pre-#355 code)', () => {
  const out = {};
  const snap = (label) => {
    out[label] = {
      row: stripClock(storedRow(EMPTY_DATE) || {}),
      computed: json(computeNight(CHILD, EMPTY_DATE, { includeTimeline: true })),
      overlaid: json(applyCorrection(CHILD, stripClock(storedRow(EMPTY_DATE)))),
    };
  };
  computeAndStoreNight(CHILD, EMPTY_DATE);
  computeAndStoreNight(CHILD, OK_DATE);
  snap('uncorrected empty');
  insertReview(EMPTY_DATE, { dismissed: 1, note: 'n' });
  snap('empty, dismissed review');
  clearReviews();
  insertReview(EMPTY_DATE, { true_in_bed_at: '2026-07-03 09:35:00' });
  snap('empty, in bed only');
  clearReviews();
  insertReview(EMPTY_DATE, { true_onset_at: '2026-07-03 09:40:00' });
  snap('empty, onset only');
  clearReviews();
  insertReview(EMPTY_DATE, { nobody_in_bed: 1 });
  snap('empty, nobody in bed');
  clearReviews();
  out['ok, uncorrected'] = json(applyCorrection(CHILD, stripClock(storedRow(OK_DATE))));
  insertReview(OK_DATE, { true_onset_at: '2026-07-01 09:45:00', true_wake_at: '2026-07-01 20:10:00' });
  out['ok, corrected'] = json(applyCorrection(CHILD, stripClock(storedRow(OK_DATE))));
  out['ok, computed'] = stripClock(json(computeNight(CHILD, OK_DATE, { includeTimeline: true })));

  if (process.env.NIGHTLIGHT_WRITE_GOLDEN) { fs.writeFileSync(GOLDEN, `${JSON.stringify(out, null, 2)}\n`); return; }
  assert.deepEqual(json(out), JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});
