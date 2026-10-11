// GET /children/:id/sleep/live, scope 'last' (#683): "Last night" must mean the last COMPLETED night.
//
// The bug: the card said "Last night · <date>" but showed the newest SAVED row, and the row for the night
// that just ended is only written by the nightly job, a 30-minute timer. Until it ran (or for as long as its
// store was refused: a locked night, a `would_downgrade`), the card and the detail page it opens, which takes
// its starting night from this same answer, showed the night BEFORE last.
//
// The fix serves the saved row when it is for the last completed night (card and morning push keep
// agreeing), and otherwise computes that night fresh, read-only, with corrections laid over it.
//
// ⚠️ CLOCK-INDEPENDENT ON PURPOSE. /sleep/live answers "tonight so far" whenever the real clock is inside
// the child's window, so each test would otherwise depend on the time of day it runs. The window is
// therefore placed RELATIVE TO NOW (opens two hours from now, ten hours long, UTC so no DST edge exists):
// "now" is never inside it, and the last completed night is whatever lastCompletedNightDate says, which is
// the very function the route uses. The samples are laid against that same date.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight, lastCompletedNightDate, currentNightDate } = await import('../src/lib/sleepAnalysis.js');
const { saveNightReview } = await import('../src/lib/sleepReviews.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'live-child';
const CAM = 'live-cam';
const WINDOW_HOURS = 10;
const MIN = 60000;
const HOUR = 60 * MIN;

let server;
let token;
let windowStartHour; // UTC hour the child's window opens, set per test in beforeEach

const sqlMinute = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ':00';
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 24 * HOUR).toISOString().slice(0, 10);
const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);

// A night that scores `ok`: settling in the first ten minutes of the window, plainly still after that,
// up for the last hour. nobody-in-bed.test.js's layOkNight, re-expressed against a window opening at
// `windowStartHour` UTC on `date` (a night's date is the date its window OPENS).
function layOkNight(date) {
  const start = Date.parse(`${date}T00:00:00Z`) + windowStartHour * HOUR;
  const end = start + WINDOW_HOURS * HOUR;
  db.exec('BEGIN');
  for (let t = start - 70 * MIN; t < end; t += MIN) {
    const moving = (t >= start && t < start + 10 * MIN) || t >= end - HOUR;
    insertSample.run(CAM, sqlMinute(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
  db.exec('COMMIT');
}

const live = () => call(`${server.url}/api/children/${CHILD}/sleep/live`, { token });
const rowFor = (date) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const rowCount = () => db.prepare('SELECT COUNT(*) AS n FROM sleep_nights WHERE child_id = ?').get(CHILD).n;

function setWindow(startHour) {
  windowStartHour = ((startHour % 24) + 24) % 24;
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?')
    .run(hh(windowStartHour), hh(windowStartHour + WINDOW_HOURS), CHILD);
}

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', 'UTC')
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run();
  const admin = makeUser(db, { id: 'u-live', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Live Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Live cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
  // The window opens two hours from now: it cannot contain "now", and the previous night's window ended
  // hours ago (a 10 h window, 24 h period), so there is always a completed night to ask about.
  setWindow(new Date().getUTCHours() + 2);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// Lay and store a completed night two nights before the last one: the "older saved row" the bug served.
function storeOlderNight() {
  const last = lastCompletedNightDate(CHILD);
  const older = addDays(last, -2);
  layOkNight(older);
  const stored = computeAndStoreNight(CHILD, older);
  assert.equal(stored.status, 'ok', 'precondition: the older night scored ok and is saved');
  return older;
}

test('no saved row for the last completed night, an older one exists: the card gets last night, computed fresh', async () => {
  // Fails without the fix: the route returned getStoredNights(child, 1)[0], the older night.
  const older = storeOlderNight();
  const last = lastCompletedNightDate(CHILD);
  layOkNight(last);
  assert.equal(currentNightDate(CHILD), null, 'precondition: no night in progress');
  assert.equal(rowFor(last), undefined, 'precondition: the nightly job has not saved last night yet');

  const r = await live();
  assert.equal(r.status, 200);
  assert.equal(r.body.scope, 'last');
  assert.equal(r.body.night.night_date, last, 'the last COMPLETED night, not the newest saved row');
  assert.notEqual(r.body.night.night_date, older);
  assert.equal(r.body.night.status, 'ok', 'a real, scored result, not a placeholder');
  assert.ok(r.body.night.asleep_minutes > 0, 'with real numbers behind it');
  assert.equal(r.body.night.in_progress, false);

  // Read-only, like the `tonight` branch: storing stays the nightly job's business (its lock and
  // would_downgrade guards), so a GET that wrote would bypass them.
  assert.equal(rowFor(last), undefined, 'nothing was stored by reading the card');
  assert.equal(rowCount(), 1, 'and the older row is untouched');
});

test('the saved row for the last completed night exists: it is served as it is stored (unchanged behaviour)', async () => {
  // Passes with and without the branch, so it pins the other half of the contract: the card and the
  // morning push read the same row. A marker no computation could produce proves the SAVED row is what
  // came back, not a fresh result that happens to look the same. Fails if the route always computes.
  const last = lastCompletedNightDate(CHILD);
  layOkNight(last);
  assert.equal(computeAndStoreNight(CHILD, last).status, 'ok', 'precondition: last night is saved');
  db.prepare('UPDATE sleep_nights SET asleep_minutes = 1234 WHERE child_id = ? AND night_date = ?').run(CHILD, last);

  const r = await live();
  assert.equal(r.body.scope, 'last');
  assert.equal(r.body.night.night_date, last);
  assert.equal(r.body.night.asleep_minutes, 1234, 'the saved row, not a recompute');
});

test('a corrected night with a saved row still has the correction laid over it', async () => {
  // The pre-existing behaviour of this route (nobody-in-bed.test.js pins the same through its own
  // fixture); pinned here too because the branch now has two ways to build the answer.
  const last = lastCompletedNightDate(CHILD);
  layOkNight(last);
  assert.equal(computeAndStoreNight(CHILD, last).status, 'ok');
  saveNightReview(CHILD, last, { nobodyInBed: true });

  const night = (await live()).body.night;
  assert.equal(night.night_date, last);
  assert.equal(night.status, 'empty');
  assert.equal(night.corrected, true);
  assert.equal(night.algo_status, 'ok', 'the detector verdict kept alongside');
});

test('a fresh no_data result is returned as it is, never the older saved night', async () => {
  // Fails without the fix (the older night came back, with its own status and date). No samples are laid
  // for the last night, so the fresh compute is no_data: the card has wording for that, and falling back
  // to an older night is the very bug.
  const older = storeOlderNight();
  const last = lastCompletedNightDate(CHILD);

  const r = await live();
  assert.equal(r.body.scope, 'last');
  assert.equal(r.body.night.night_date, last);
  assert.notEqual(r.body.night.night_date, older);
  assert.equal(r.body.night.status, 'no_data');
  assert.equal(rowFor(last), undefined, 'and a no_data result is not stored by a read either');
});

test('a child with no saved night at all gets last night computed fresh (was: night null)', async () => {
  // Fails without the fix: `night` was null, so a brand-new install showed nothing until the first job
  // tick even when the night had been watched.
  const last = lastCompletedNightDate(CHILD);
  layOkNight(last);
  assert.equal(rowCount(), 0, 'precondition: nothing saved');

  const r = await live();
  assert.equal(r.body.scope, 'last');
  assert.equal(r.body.night.night_date, last);
  assert.equal(r.body.night.status, 'ok');
  assert.equal(rowCount(), 0, 'and still nothing saved');
});

test('a corrected (locked) last night with no saved row: the correction is laid over the fresh night', async () => {
  // Fails without the fix (no row, so `night` was null). saveNightReview skips the store-first step for a
  // night with no row (storeNightBeforeCorrection: 'unscored'), which is exactly the state under test: a
  // correction exists, the saved row does not.
  const last = lastCompletedNightDate(CHILD);
  layOkNight(last);
  saveNightReview(CHILD, last, { nobodyInBed: true });
  assert.equal(rowFor(last), undefined, 'precondition: a correction exists and no saved row does');

  const night = (await live()).body.night;
  assert.equal(night.night_date, last);
  assert.equal(night.status, 'empty', 'the parent\'s answer, not the detector\'s');
  assert.equal(night.corrected, true);
  assert.equal(night.nobody_in_bed, true);
  assert.equal(night.algo_status, 'ok', 'with the detector verdict kept alongside');
  assert.equal(rowFor(last), undefined, 'and still nothing saved');
});

test('sleep tracking off: unchanged, scope off and no night', async () => {
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  layOkNight(lastCompletedNightDate(CHILD));
  const r = await live();
  assert.deepEqual(r.body, { scope: 'off', night: null });
});

test('a window that is open now: unchanged, "tonight so far" for the night in progress', async () => {
  // The window opened an hour ago, so the real clock is inside it.
  setWindow(new Date().getUTCHours() - 1);
  const current = currentNightDate(CHILD);
  assert.ok(current, 'precondition: a night is in progress');
  const r = await live();
  assert.equal(r.body.scope, 'tonight');
  assert.equal(r.body.night.night_date, current);
  assert.equal(r.body.night.in_progress, true);
});
