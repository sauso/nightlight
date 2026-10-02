// The morning review, 2026-09-30: "in bed" separate from "asleep", and a corrected night is locked.
//
// Two things the owner hit on staging, correcting the night of 2026-09-29:
//   1. A bedtime story. The detector had the child asleep at 19:13, which was right. They had been put down at 18:49 for a
//      bedtime story. The review's only frame button, "Put down here", filled the ASLEEP time, so marking
//      the put-down overwrote a correct 19:13 with 18:49. Now "Put down here" records IN BED only
//      (sleep_reviews.true_in_bed_at) and never touches asleep, and an in-bed-only correction must leave
//      every sleep figure exactly as the detector stored it.
//   2. A recalculated night. A wake corrected to 06:10 "recalculated" hours later, after the bed was changed: the nightly
//      job kept re-storing the night for ~3h after its window closed and never read sleep_reviews. The
//      owner's rule: once a parent has corrected a night it is complete and must not be overridden.
//      Now a corrected, scored night is LOCKED against both the job and the admin Recompute.
//
// Both are per child and per night; nothing here assumes one house, one timezone or two cameras. The
// fixture uses Melbourne only because a real, non-UTC zone is what catches a hard-coded offset.
//
// ⚠️ The fixtures are hostile on purpose (workspace CLAUDE.md). Shape tests read the schema with PRAGMA
// and plant a marker in every column, and the in-bed-only overlay test stores an asleep_minutes that
// DIFFERS from span - awake - unknown, because a re-derivation that happened to reproduce the stored value
// would make "byte-identical" prove nothing.

import { test, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight, runNightlySleepJob, nightIsLocked, storeNightBeforeCorrection, isEvidenceFinal,
  lastCompletedNightDate, reportableSpanMs, childSamplingActiveNow } = await import('../src/lib/sleepAnalysis.js');
const { saveNightReview, applyCorrection, reviewCardState, reviewCorrectsNight, localHmToUtcSql } = await import('../src/lib/sleepReviews.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { logger } = await import('../src/lib/logger.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'lk-child';
const OTHER_CHILD = 'lk-other';
const CAM = 'lk-cam';
const OTHER_CAM = 'lk-other-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne in July: UTC+10, no DST edge anywhere near

// Local wall-clock time on the night of DATE (dayShift 1 = the morning after) -> Date.
const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const minuteSql = (d) => sql(d).replace(/:\d\d$/, ':00');
// The window in the fixture below is 19:00-07:00, so window_end is 07:00 local the next morning.
const WINDOW_START = sql(at(19, 0));
const WINDOW_END = sql(at(7, 0, 1));

let server;
let adminToken;
let caregiverToken;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);

// One sample per minute from 19:00 to `to`; minutes inside an `active` range carry real movement. The same
// shape sleepReportNotify.test.js uses: with a departure after the window closes, the FIRST pass (just
// after 07:00) has no wake yet, and a later pass confirms it at 07:20. That is exactly the provisional
// first row the morning card is offered on.
function layNight(activeRanges, to) {
  for (let t = at(19, 0); t < to; t = new Date(t.getTime() + 60000)) {
    const moving = activeRanges.some(([a, b]) => t >= a && t < b);
    insertSample.run(CAM, minuteSql(t), moving ? 0.4 : 0.0002, moving ? 0.6 : 0.0002);
  }
}
const layLateWakeNight = () => {
  layNight([[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  layTransition(TRANSITION.OUT_OF_BED, sql(at(7, 20, 1, 30)));
};
// An ordinary night that scores `ok` with a wake already on its first pass.
const layPlainNight = () => layNight([[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(1, 0, 1), at(1, 9, 1)]], at(7, 0, 1));

// Inserted directly: recordBedTransition sweeps rows older than 45 days, and this night is months old.
function layTransition(type, when, cam = CAM) {
  return Number(db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run(cam, type, when).lastInsertRowid);
}

const reviewUrl = (date = DATE) => `${server.url}/api/children/${CHILD}/review/${date}`;
const put = (body, { token = adminToken, date = DATE } = {}) => call(reviewUrl(date), { method: 'PUT', token, body });
const get = (path, token = adminToken) => call(`${server.url}/api/children/${CHILD}${path}`, { token });
const reviewRow = (date = DATE) => db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const storedRow = (date = DATE) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const nightsCols = () => db.prepare("PRAGMA table_info('sleep_nights')").all();
const reviewCols = () => db.prepare("PRAGMA table_info('sleep_reviews')").all();

// A stored row written directly, every column from PRAGMA: `values` wins, everything else gets a
// recognisable marker of the column's REAL type, so a column that leaks or moves shows up by name.
function plantNight(values) {
  const cols = nightsCols();
  const row = {};
  cols.forEach((c, i) => {
    if (c.name === 'id') return;
    if (c.name in values) row[c.name] = values[c.name];
    else if (/INT/i.test(c.type)) row[c.name] = 900000 + i;
    else if (/REAL/i.test(c.type)) row[c.name] = 1000.25 + i;
    else row[c.name] = `MARK:${c.name}`;
  });
  const names = Object.keys(row);
  db.prepare(`INSERT INTO sleep_nights (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`).run(row);
  return storedRow();
}

// A scored, FINISHED and evidence-FINAL row (computed four hours after the window closed): the lock can
// hold on it, and storeNightBeforeCorrection leaves it alone.
const FINAL_AT = sql(at(11, 0, 1));
const finishedNight = (extra = {}) => ({
  child_id: CHILD, night_date: DATE, status: 'ok', window_start: WINDOW_START, window_end: WINDOW_END,
  computed_at: FINAL_AT, notified_at: null, notified_wake_at: null, ...extra,
});

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  const carer = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  caregiverToken = signToken({ sub: carer.id, sid: makeSession(db, carer.id), role: 'caregiver', username: 'nanny' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Lock Kid', 1, '19:00', '07:00'), (?, 'Other Kid', 1, '19:00', '07:00')`).run(CHILD, OTHER_CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p', 0, 0), (?, 'Other cam', 'rtsp://example/y', ?, 'q', 0, 0)`)
    .run(CAM, CHILD, OTHER_CAM, OTHER_CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// ================================ Part A: in bed is not asleep ================================

test('★ the put-down night: "in bed" 18:49 lands on in_bed_at ONLY — asleep 19:13 and every sleep figure stay byte-identical', async () => {
  // The detector's own night, stored, with an asleep_minutes that is NOT span - awake - unknown (19:13 to
  // 06:37 is 684 minutes; minus 30 awake and 7 unknown would be 647). If the in-bed-only path fell through
  // to the span derivation, 647 would replace 600 and this test says so by name.
  const row = plantNight(finishedNight({
    onset_at: sql(at(19, 13)), wake_at: sql(at(6, 37, 1)), in_bed_at: sql(at(19, 11, 0, 30)),
    asleep_minutes: 600, awake_minutes: 30, unknown_minutes: 7,
  }));
  const span = (Date.parse(`${row.wake_at.replace(' ', 'T')}Z`) - Date.parse(`${row.onset_at.replace(' ', 'T')}Z`)) / 60000;
  assert.notEqual(span - row.awake_minutes - row.unknown_minutes, row.asleep_minutes,
    'precondition: a re-derivation would visibly change asleep_minutes');

  // The put-down frame, second-accurate: 18:49:20.
  const putDown = layTransition(TRANSITION.INTO_BED, sql(at(18, 49, 0, 20)));
  const res = await put({ true_in_bed_transition_id: putDown });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.review.true_in_bed_at, sql(at(18, 49, 0, 20)), 'the frame time, to the second');
  assert.equal(res.body.review.true_in_bed_transition_id, putDown, 'and WHICH frame, the labelled example');
  assert.equal(res.body.review.true_onset_at, null, 'the asleep time is untouched: that was the bug');

  const shown = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  const OVERLAY = ['corrected', 'algo_onset_at', 'algo_wake_at', 'algo_in_bed_at', 'in_bed_corrected'];
  const names = nightsCols().map((c) => c.name);
  assert.deepEqual(Object.keys(shown).sort(), [...names, ...OVERLAY].sort(), 'the row keeps its columns and gains only the overlay fields');
  for (const c of names) {
    if (c === 'in_bed_at') continue;
    assert.deepEqual(shown[c], row[c], `${c} must be exactly what the detector stored — only "in bed" was corrected`);
  }
  assert.equal(shown.in_bed_at, sql(at(18, 49, 0, 20)), 'in bed 18:49');
  assert.equal(shown.onset_at, sql(at(19, 13)), 'asleep stays 19:13');
  assert.equal(shown.asleep_minutes, 600, 'not re-derived');
  assert.equal(shown.in_bed_corrected, true);
  assert.equal(shown.corrected, true);
  assert.equal(shown.algo_in_bed_at, row.in_bed_at, "the detector's own put-down rides along");
  assert.equal(shown.algo_onset_at, row.onset_at, 'algo_onset_at === onset_at, so the UI reads the ONSET as uncorrected');
  assert.equal(shown.algo_wake_at, row.wake_at);
});

test('★ the put-down night as the UI ACTUALLY saves it: in bed + the unchanged detector asleep and wake — asleep total untouched (fix round, item 3)', async () => {
  // The edit card always sends the asleep and wake times it shows (the detector's own, untouched), on
  // purpose: a time the parent saw and saved unchanged is an implicit confirmation. So "Put down here" +
  // Save is NOT an in-bed-only review in the real UI, and the old overlay re-derived asleep_minutes from
  // span - awake - unknown (647 here) over the detector's own 600 although no sleep time had changed.
  const row = plantNight(finishedNight({
    onset_at: sql(at(19, 13)), wake_at: sql(at(6, 37, 1)), in_bed_at: sql(at(19, 11, 0, 30)),
    asleep_minutes: 600, awake_minutes: 30, unknown_minutes: 7,
  }));
  const putDown = layTransition(TRANSITION.INTO_BED, sql(at(18, 49, 0, 20)));
  // Exactly NightReview.jsx's save() after "Put down here" on that frame, then "Save review".
  const res = await put({
    true_onset_local: '19:13', true_wake_local: '06:37',
    true_onset_transition_id: null, true_wake_transition_id: null,
    true_in_bed_local: '18:49', true_in_bed_transition_id: putDown,
    note: null, computed_onset_at: row.onset_at, computed_wake_at: row.wake_at, verdicts: {}, reasons: {},
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.review.true_onset_at, row.onset_at, 'precondition: the unchanged asleep time WAS stored');
  assert.equal(res.body.review.true_wake_at, row.wake_at, 'precondition: and the unchanged wake time');

  const shown = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  for (const c of nightsCols().map((col) => col.name)) {
    if (c === 'in_bed_at') continue;
    assert.deepEqual(shown[c], row[c], `${c} must be exactly what the detector stored`);
  }
  assert.equal(shown.asleep_minutes, 600, 'not the re-derived 647');
  assert.equal(shown.in_bed_at, sql(at(18, 49, 0, 20)));
  assert.equal(shown.corrected, true);
});

test('only ONE time given, equal to the night\'s own: still nothing re-derived; a CHANGED one still re-derives', () => {
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(6, 37, 1)), asleep_minutes: 600, awake_minutes: 30, unknown_minutes: 7 }));
  saveNightReview(CHILD, DATE, { trueWakeAt: sql(at(6, 37, 1)) });
  assert.equal(applyCorrection(CHILD, storedRow()).asleep_minutes, 600, 'the confirmed wake changes nothing');
  saveNightReview(CHILD, DATE, { trueWakeAt: sql(at(6, 10, 1)) });
  // 19:13 to 06:10 = 657 minutes, less 30 awake and 7 unknown.
  assert.equal(applyCorrection(CHILD, storedRow()).asleep_minutes, 657 - 30 - 7, 'a different wake re-derives, as always');
});

test('★ "unchanged" means unchanged from the night being SHOWN, not from what the review page showed (fix round 2, item 3)', () => {
  // Opus #2: the review page seeds from the LIVE compute, the card overlays the STORED row, so a time the
  // parent left alone can differ from the stored one, and then the card re-derives while the detail page
  // (live) does not. The suggested fix, "a time equal to the review's own computed_* is unchanged", was
  // tried and rejected: it breaks the case the store-first step exists for. A page opened at 08:16 shows
  // a wake of 05:51; the parent marks only the put-down and saves at 09:50; the store-first step stores
  // the fresh night, whose wake has moved to 08:31 (measured 2026-08-29). The card then shows the parent's
  // 05:51, and its total must be re-derived to match it, or it reads "up 05:51" above a total that runs
  // to 08:31. The same holds on the detail page, whose live wake is 08:31 by then. Planted directly: the
  // stored asleep_minutes (700) is the fresh compute's, over 19:40 to 08:31.
  plantNight(finishedNight({ onset_at: sql(at(19, 40)), wake_at: sql(at(8, 31, 1)), asleep_minutes: 700, awake_minutes: 20, unknown_minutes: 5 }));
  saveNightReview(CHILD, DATE, {
    trueInBedAt: sql(at(19, 20)), trueOnsetAt: sql(at(19, 40)), trueWakeAt: sql(at(5, 51, 1)),
    computedOnsetAt: sql(at(19, 40)), computedWakeAt: sql(at(5, 51, 1)),
  });
  // 19:40 to 05:51 = 611 minutes, less 20 awake and 5 unknown.
  const card = applyCorrection(CHILD, storedRow());
  assert.equal(card.wake_at, sql(at(5, 51, 1)), 'the card shows the wake the parent saw and saved');
  assert.equal(card.asleep_minutes, 611 - 20 - 5, 'and a total that fits inside it, not the stored 700 that runs to 08:31');
  // The detail page's live night by then: the same 08:31 wake, its own (different) asleep figure.
  const detail = applyCorrection(CHILD, { ...storedRow(), asleep_minutes: 690 });
  assert.equal(detail.asleep_minutes, card.asleep_minutes, 'the detail page re-derives the same total: the two screens agree');
  // The other half, stated rather than hidden: where the SHOWN night already has the parent's time (the
  // detail page's live compute on an older night), nothing is re-derived there, while a card whose stored
  // row differs does re-derive. That difference is a README known limit, not a rule this test protects.
  const live = { ...storedRow(), onset_at: sql(at(19, 40)), wake_at: sql(at(5, 51, 1)), asleep_minutes: 590 };
  assert.equal(applyCorrection(CHILD, live).asleep_minutes, 590, 'a night showing the same times keeps its own total');
});

test('in bed AND asleep corrected together: both shown, and the asleep span is derived exactly as before', () => {
  plantNight(finishedNight({
    onset_at: sql(at(19, 5)), wake_at: sql(at(6, 30, 1)), in_bed_at: sql(at(19, 1)),
    asleep_minutes: 500, awake_minutes: 20, unknown_minutes: 4,
  }));
  saveNightReview(CHILD, DATE, { trueOnsetAt: sql(at(19, 13)), trueInBedAt: sql(at(18, 49)) });
  const out = applyCorrection(CHILD, storedRow());
  assert.equal(out.onset_at, sql(at(19, 13)));
  assert.equal(out.in_bed_at, sql(at(18, 49)));
  assert.equal(out.in_bed_corrected, true);
  // 19:13 to 06:30 = 677 minutes, less 20 awake and 4 unknown, as the existing derivation always did.
  assert.equal(out.asleep_minutes, 677 - 20 - 4);
});

test('a time-only correction carries no in_bed_corrected key — it is present only when the parent gave "in bed"', () => {
  plantNight(finishedNight({ onset_at: sql(at(19, 5)), wake_at: sql(at(6, 30, 1)), in_bed_at: sql(at(19, 1)), asleep_minutes: 500 }));
  saveNightReview(CHILD, DATE, { trueWakeAt: sql(at(6, 10, 1)) });
  const out = applyCorrection(CHILD, storedRow());
  assert.equal('in_bed_corrected' in out, false);
  assert.equal(out.in_bed_at, sql(at(19, 1)), "the detector's put-down, untouched");
  assert.equal(out.algo_in_bed_at, sql(at(19, 1)));
});

// --- "in bed" must not be after "asleep", judged on the MERGED review (plan review R2) --------------------

test('★ in bed up to 59 s after asleep is accepted; 60 s is refused — and the refusal writes nothing, verdicts included', async () => {
  // A frame keeps its seconds, a typed time is to the minute: "asleep 19:40" is 19:40:00, and a put-down
  // frame at 19:40:59 is the same minute. At 19:41:00 it is a full minute after, a contradiction.
  assert.equal((await put({ true_onset_local: '19:40' })).status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(19, 40)), 'precondition: asleep stored from an EARLIER save');
  const sameMinute = layTransition(TRANSITION.INTO_BED, sql(at(19, 40, 0, 59)));
  const aMinuteLate = layTransition(TRANSITION.INTO_BED, sql(at(19, 41, 0, 0)));

  const refused = await put({ true_in_bed_transition_id: aMinuteLate, verdicts: { [aMinuteLate]: 'wrong' } });
  assert.equal(refused.status, 400, 'merged with the stored asleep time, 60 s after is refused');
  assert.match(refused.body.error, /can't be after "Fell asleep"/);
  assert.equal(reviewRow().true_in_bed_at, null, 'nothing stored');
  assert.equal(db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(aMinuteLate).verdict, null,
    'and the verdict in the refused save did not land: the check runs before applyVerdicts writes');

  const ok = await put({ true_in_bed_transition_id: sameMinute });
  assert.equal(ok.status, 200, '59 s after, the same minute, is accepted');
  assert.equal(reviewRow().true_in_bed_at, sql(at(19, 40, 0, 59)));
});

test('the ordering is checked in both directions and in one request', async () => {
  // One request: typed in bed after typed asleep.
  const both = await put({ true_in_bed_local: '19:50', true_onset_local: '19:45' });
  assert.equal(both.status, 400);
  assert.equal(reviewRow(), undefined);

  // The other direction, merged: in bed stored first, then an asleep time before it.
  assert.equal((await put({ true_in_bed_local: '19:30' })).status, 200);
  const earlierAsleep = await put({ true_onset_local: '19:29' });
  assert.equal(earlierAsleep.status, 400, 'asleep 19:29 against a stored in bed 19:30 is refused');
  assert.equal(reviewRow().true_onset_at, null);

  // A put-down with no corrected asleep time AND no stored night has nothing to contradict. (With a stored
  // night it is compared with that night's asleep time: see the stored-onset test below, fix round 2.)
  assert.equal((await put({ true_in_bed_local: '21:00' })).status, 200);

  // And the lib refuses it on its own, for any caller that skips the route.
  saveNightReview(CHILD, DATE, { trueInBedAt: sql(at(19, 0)), trueOnsetAt: sql(at(19, 20)) });
  assert.throws(() => saveNightReview(CHILD, DATE, { trueInBedAt: sql(at(19, 21)) }), /in bed comes before asleep/);
  assert.equal(reviewRow().true_in_bed_at, sql(at(19, 0)), 'and the throw stored nothing');
});

// --- "asleep" must not be after "up for the day", and "in bed" must not be after the STORED asleep time ----
// Fix round 2 (Opus #4, verified): only in bed <= asleep was enforced, so a wake before the asleep time was
// stored and every screen then showed a night that ends before it starts (asleep floored to 0).

const verdictOf = (id) => db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(id).verdict;

test('★ asleep after wake is refused on the MERGED review, with a minute of slack, and the refusal writes nothing, verdicts included', async () => {
  const exit = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 30, 1)));
  // One request: by the noon rule 07:30 is the morning after, so asleep 07:30 is an hour AFTER wake 06:30.
  const both = await put({ true_onset_local: '07:30', true_wake_local: '06:30', verdicts: { [exit]: 'correct' } });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /"Fell asleep" can't be after "Got up for the day"/);
  assert.equal(reviewRow(), undefined, 'nothing stored');
  assert.equal(verdictOf(exit), null, 'and the verdict in the refused save did not land: the check runs before applyVerdicts writes');

  // Merged: the wake saved first, the asleep time after it in a later save.
  assert.equal((await put({ true_wake_local: '06:30' })).status, 200);
  const later = await put({ true_onset_local: '07:30' });
  assert.equal(later.status, 400, 'asleep 07:30 against a STORED wake 06:30 is refused');
  assert.equal(reviewRow().true_onset_at, null);

  // An ordinary overnight is fine, and so is the same minute: a wake FRAME keeps its seconds, a typed asleep
  // time is to the minute, so up at 06:29:30 beside asleep "06:30" is someone saying both happened in one
  // minute. A full minute earlier is a contradiction.
  assert.equal((await put({ true_onset_local: '19:30' })).status, 200, 'asleep 19:30, up 06:30');
  assert.equal((await put({ true_onset_local: '06:30' })).status, 200, 'the same minute, typed');
  const sameMinute = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 29, 1, 30)));
  const aMinuteEarly = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 29, 1, 0)));
  assert.equal((await put({ true_wake_transition_id: aMinuteEarly })).status, 400, 'up 06:29:00 is a minute before asleep 06:30');
  assert.equal((await put({ true_wake_transition_id: sameMinute })).status, 200, 'up 06:29:30 is the same minute');
  assert.equal(reviewRow().true_wake_at, sql(at(6, 29, 1, 30)));
});

test('★ an in-bed time saved with no asleep time is checked against the night\'s STORED asleep time', async () => {
  // Without this it saved, and the card then silently hid it: showsInBed only shows a put-down at least a
  // minute BEFORE the asleep time it sits beside, and with no corrected asleep time that is the stored one.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(6, 37, 1)), asleep_minutes: 600 }));
  const aMinuteLate = layTransition(TRANSITION.INTO_BED, sql(at(19, 14, 0, 0)));
  const sameMinute = layTransition(TRANSITION.INTO_BED, sql(at(19, 13, 0, 59)));

  const refused = await put({ true_in_bed_transition_id: aMinuteLate, verdicts: { [aMinuteLate]: 'correct' } });
  assert.equal(refused.status, 400, 'a put-down 60 s after the stored asleep 19:13');
  assert.match(refused.body.error, /"In bed" can't be after/);
  assert.equal(reviewRow(), undefined, 'nothing stored');
  assert.equal(verdictOf(aMinuteLate), null, 'verdicts included');
  assert.equal((await put({ true_in_bed_local: '19:30' })).status, 400, 'typed, the same');

  assert.equal((await put({ true_in_bed_transition_id: sameMinute })).status, 200, '59 s after is the same minute');
  assert.equal(reviewRow().true_in_bed_at, sql(at(19, 13, 0, 59)));
  // With an asleep time in the review, THAT is what in bed is checked against (the merged rule above), not
  // the stored night's: the parent is saying the detector's 19:13 was wrong.
  assert.equal((await put({ true_in_bed_local: '19:30', true_onset_local: '19:45' })).status, 200);
  assert.equal(reviewRow().true_in_bed_at, sql(at(19, 30)));
});

// --- which frame can be "in bed" --------------------------------------------------------------------------

test('only a got-into-bed event of THIS night can be the put-down; the onset id keeps its old, untyped check', async () => {
  const exit = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 30, 1)));
  const otherChildsPutDown = layTransition(TRANSITION.INTO_BED, sql(at(19, 5)), OTHER_CAM);
  for (const [why, id] of [['a got-out-of-bed event', exit], ["another child's put-down", otherChildsPutDown], ['no such event', 999999]]) {
    const res = await put({ true_in_bed_transition_id: id });
    assert.equal(res.status, 400, why);
    assert.match(res.body.error, /not a got-into-bed event of this night/, why);
  }
  assert.equal((await put({ true_in_bed_local: '7pm' })).status, 400, 'a malformed typed time is refused, not stored as nothing');
  assert.equal(reviewRow(), undefined, 'none of those stored anything');

  // The UI always sends BOTH the frame and the typed time it filled from it (the frame's HH:MM). The frame
  // wins, to the second: a typed 18:50 beside a frame at 18:49:20 stores 18:49:20 (B25).
  const frame = layTransition(TRANSITION.INTO_BED, sql(at(18, 49, 0, 20)));
  assert.equal((await put({ true_in_bed_local: '18:50', true_in_bed_transition_id: frame })).status, 200);
  assert.equal(reviewRow().true_in_bed_at, sql(at(18, 49, 0, 20)), 'the frame wins over the typed time');
  assert.equal(reviewRow().true_in_bed_transition_id, frame);
  db.prepare('DELETE FROM sleep_reviews').run();

  // A page loaded before the split still sends its "Put down here" frame as the ONSET. It must keep saving
  // exactly as it always did, and nothing reinterprets it as "in bed".
  const putDown = layTransition(TRANSITION.INTO_BED, sql(at(18, 49, 0, 20)));
  const old = await put({ true_onset_transition_id: putDown });
  assert.equal(old.status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(18, 49, 0, 20)));
  assert.equal(reviewRow().true_in_bed_at, null);
});

// --- in bed is one of "the times" for "no one was in the bed" ----------------------------------------------

test('"no one was in the bed" and an in-bed time are mutually exclusive, like every other time', async () => {
  const putDown = layTransition(TRANSITION.INTO_BED, sql(at(18, 49)));
  for (const body of [{ true_in_bed_local: '18:49' }, { true_in_bed_transition_id: putDown }]) {
    const res = await put({ nobody_in_bed: true, ...body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, /not both/);
  }
  assert.throws(() => saveNightReview(CHILD, DATE, { nobodyInBed: true, trueInBedAt: sql(at(18, 49)) }), /pick one/);
  assert.throws(() => saveNightReview(CHILD, DATE, { nobodyInBed: true, trueInBedTransitionId: putDown }), /pick one/);
  assert.equal(reviewRow(), undefined);

  // The flag NULLS a stored in-bed answer...
  assert.equal((await put({ true_in_bed_transition_id: putDown })).status, 200);
  assert.equal((await put({ nobody_in_bed: true })).status, 200);
  assert.equal(reviewRow().true_in_bed_at, null);
  assert.equal(reviewRow().true_in_bed_transition_id, null);
  // ...and an in-bed time sent with the flag OMITTED clears the flag: the newest answer wins.
  assert.equal((await put({ true_in_bed_local: '18:49' })).status, 200);
  assert.equal(reviewRow().nobody_in_bed, 0);
  assert.equal(reviewRow().true_in_bed_at, sql(at(18, 49)));
});

test('an empty frame id is "no frame", with the flag or without it: never a 500, never a stored frame 0 (fix round 2)', async () => {
  // '' became Number('') = 0 in the route's patch, which saveNightReview reads as a frame: with "no one was
  // in the bed" that tripped its flag-plus-times throw, a 500 whose body Cloudflare strips. transitionInstant
  // already read '' as "no frame"; the patch now agrees with it.
  for (const key of ['true_in_bed_transition_id', 'true_onset_transition_id', 'true_wake_transition_id']) {
    db.prepare('DELETE FROM sleep_reviews').run();
    const flagged = await put({ nobody_in_bed: true, [key]: '' });
    assert.equal(flagged.status, 200, `${key}: '' beside the flag: ${JSON.stringify(flagged.body)}`);
    assert.equal(reviewRow().nobody_in_bed, 1);
    assert.equal(reviewRow()[key], null);
    db.prepare('DELETE FROM sleep_reviews').run();
    assert.equal((await put({ [key]: '' })).status, 200);
    assert.equal(reviewRow()[key], null, `${key}: '' is stored as no frame, not as frame 0`);
  }
});

test('a second in-bed answer REPLACES the first (the upsert updates it), undefined keeps it, null clears it', async () => {
  assert.equal((await put({ true_in_bed_local: '18:49' })).status, 200);
  assert.equal((await put({ true_in_bed_local: '18:55' })).status, 200);
  assert.equal(reviewRow().true_in_bed_at, sql(at(18, 55)), 'changed your mind about the put-down: the second answer is stored');
  // A stale card on a second phone that has never heard of "in bed" must not blank it.
  assert.equal((await put({ note: 'story night', true_onset_local: '19:13' })).status, 200);
  assert.equal(reviewRow().true_in_bed_at, sql(at(18, 55)));
  assert.equal((await put({ true_in_bed_local: null, true_in_bed_transition_id: null })).status, 200);
  assert.equal(reviewRow().true_in_bed_at, null, 'an explicit null clears it, like the other times');
});

// --- the receipt and the response shapes (never break open clients) ---------------------------------------

// The card is about the LAST completed night by the real clock, so these store a row for that night.
function storeLastNight() {
  const night = lastCompletedNightDate(CHILD);
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, onset_at, wake_at, asleep_minutes)
     VALUES (?, ?, ?, ?, 'ok', '2026-08-29 09:13:00', '2026-08-29 20:37:00', 600)`
  ).run(CHILD, night, `${night} 09:00:00`, `${night} 21:00:00`);
  return night;
}

test('★ an in-bed-only answer is a done card, with the RESOLVED times to read back', () => {
  // Before this, the card's "done" state required a true asleep or wake time, so an in-bed-only answer
  // made the card simply vanish: the "did it save?" failure the receipt exists to prevent.
  const night = storeLastNight();
  saveNightReview(CHILD, night, { trueInBedAt: '2026-08-29 08:49:00' });
  const card = reviewCardState(CHILD);
  assert.equal(card.state, 'done');
  assert.equal(card.true_in_bed_at, '2026-08-29 08:49:00');
  assert.equal(card.onset_at, '2026-08-29 09:13:00', 'asleep: the detector time the card shows, since the parent gave none');
  assert.equal(card.wake_at, '2026-08-29 20:37:00');
  assert.equal(card.true_onset_at, null, 'the OLD key keeps its old meaning: what the parent typed');
});

test('the done card resolves to the parent\'s own times where they gave them, and to none for "no one was in the bed"', () => {
  const night = storeLastNight();
  saveNightReview(CHILD, night, { trueOnsetAt: '2026-08-29 09:20:00' });
  let card = reviewCardState(CHILD);
  assert.equal(card.onset_at, '2026-08-29 09:20:00', 'their asleep time');
  assert.equal(card.wake_at, '2026-08-29 20:37:00', "and the detector's wake beside it");
  assert.equal(card.true_in_bed_at, null);
  saveNightReview(CHILD, night, { nobodyInBed: true });
  card = reviewCardState(CHILD);
  assert.equal(card.nobody_in_bed, true);
  assert.equal(card.onset_at, null, 'no sleep time is read back for a night nobody slept in');
  assert.equal(card.wake_at, null);
});

test('never break open clients: the review GET and the done card only ADD keys', async () => {
  // The keys a page loaded before this change reads. A hand list on purpose: it is the historical
  // contract being protected, not a description of the schema.
  const OLD_REVIEW_KEYS = ['child_id', 'night_date', 'true_onset_at', 'true_wake_at', 'true_onset_transition_id',
    'true_wake_transition_id', 'computed_onset_at', 'computed_wake_at', 'note', 'dismissed', 'nobody_in_bed', 'reviewed_at'];
  const OLD_CARD_KEYS = ['state', 'pending', 'night_date', 'true_onset_at', 'true_wake_at', 'nobody_in_bed'];
  await put({ true_in_bed_local: '18:49' });
  const review = (await get(`/review/${DATE}`)).body.review;
  for (const k of OLD_REVIEW_KEYS) assert.ok(k in review, `review GET lost ${k}`);
  assert.ok('true_in_bed_at' in review && 'true_in_bed_transition_id' in review, 'and gained the two new ones');

  const night = storeLastNight();
  saveNightReview(CHILD, night, { trueInBedAt: '2026-08-29 08:49:00' });
  const card = (await get('/review/pending')).body;
  for (const k of OLD_CARD_KEYS) assert.ok(k in card, `done card lost ${k}`);
  for (const k of ['true_in_bed_at', 'onset_at', 'wake_at']) assert.ok(k in card, `done card gained ${k}`);
});

// ================================ Part B: a corrected night is locked ================================

// ★ Two predicates, one truth (plan review R9). The lock is SQL (nightIsLocked); what the night SHOWS is JS
// (applyCorrection), and a third spelling decides the done card and the save-time store
// (reviewCorrectsNight). Each sleep_reviews column is planted ON ITS OWN over a scored, finished stored
// row, and all three must agree about every one of them. The column list comes from PRAGMA, so a column
// added later fails the classification check below until someone decides whether it corrects a night.
const LOCKING = ['nobody_in_bed', 'true_onset_at', 'true_wake_at', 'true_in_bed_at'];
const NOT_LOCKING = ['true_onset_transition_id', 'true_wake_transition_id', 'true_in_bed_transition_id',
  'computed_onset_at', 'computed_wake_at', 'note', 'dismissed'];
const REVIEW_KEYS = ['child_id', 'night_date', 'reviewed_at'];

test('★ the lock, the overlay and the card agree about every sleep_reviews column, one column at a time', () => {
  const cols = reviewCols();
  const unclassified = cols.map((c) => c.name).filter((n) => ![...LOCKING, ...NOT_LOCKING, ...REVIEW_KEYS].includes(n));
  assert.deepEqual(unclassified, [], `classify these sleep_reviews columns as locking or not: ${unclassified.join(', ')}`);

  plantNight(finishedNight({ onset_at: sql(at(19, 5)), wake_at: sql(at(6, 30, 1)), in_bed_at: sql(at(19, 1)), asleep_minutes: 500 }));
  const stored = storedRow();
  // Per column, of the column's REAL type (plan review R5): a value the overlay reads as an answer, and
  // (fix round, item 5) values that are falsy but NOT NULL, planted straight into the table so no save-time
  // normalisation hides them: '' for text, 0 and -1 for integers. Truthiness in JS and `IS NOT NULL` /
  // `= 1` in SQL read those differently, and they are exactly where two spellings of one rule drift.
  const markers = (c) => (/INT/i.test(c.type)
    ? [['answer', 1], ['0', 0], ['-1', -1]]
    : [['answer', sql(at(19, 20))], ["''", '']]);
  const shapes = [['(a review row with nothing in it)', {}, false]];
  for (const c of cols.filter((col) => !REVIEW_KEYS.includes(col.name))) {
    for (const [kind, v] of markers(c)) shapes.push([`${c.name} = ${kind}`, { [c.name]: v }, kind === 'answer' && LOCKING.includes(c.name)]);
  }
  for (const [name, values, expected] of shapes) {
    db.prepare('DELETE FROM sleep_reviews').run();
    const keys = ['child_id', 'night_date', ...Object.keys(values)];
    db.prepare(`INSERT INTO sleep_reviews (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`)
      .run({ child_id: CHILD, night_date: DATE, ...values });
    const locked = nightIsLocked(CHILD, DATE);
    const overlaid = applyCorrection(CHILD, stored).corrected === true;
    const answers = reviewCorrectsNight(reviewRow());
    assert.equal(locked, overlaid, `${name}: the lock (${locked}) and the overlay (${overlaid}) disagree`);
    assert.equal(answers, overlaid, `${name}: reviewCorrectsNight (${answers}) and the overlay (${overlaid}) disagree`);
    assert.equal(locked, expected, `${name}: expected ${expected ? '' : 'NOT '}to lock`);
  }
});

test('a save stores an empty string as NULL, so no row it writes is read two ways', () => {
  // The route never sends '' (an emptied field arrives as null), but saveNightReview is the rule "for every
  // caller". '' is "nothing" to the overlay and was "a value" to the lock's SQL.
  saveNightReview(CHILD, DATE, { trueOnsetAt: '', trueWakeAt: '', trueInBedAt: '', note: '' });
  for (const col of ['true_onset_at', 'true_wake_at', 'true_in_bed_at', 'note']) assert.equal(reviewRow()[col], null, col);
  assert.doesNotThrow(() => saveNightReview(CHILD, DATE, { nobodyInBed: true, trueInBedAt: '' }),
    "an empty string is not a time, so it does not collide with the flag");
  assert.equal(reviewRow().nobody_in_bed, 1);
  // A hand-written non-canonical flag is re-written as the canonical value by the next save.
  db.prepare('UPDATE sleep_reviews SET nobody_in_bed = -1 WHERE child_id = ?').run(CHILD);
  saveNightReview(CHILD, DATE, { note: 'x' });
  assert.equal(reviewRow().nobody_in_bed, 0, '-1 is not "said nobody", and is stored as the 0 it means');
});

test('the lock needs a SCORED stored row that was computed after its window closed', () => {
  saveNightReview(CHILD, DATE, { trueWakeAt: sql(at(6, 10, 1)) });
  assert.equal(nightIsLocked(CHILD, DATE), false, 'no stored row: nothing to lock');
  for (const [status, locks] of [['ok', true], ['empty', true], ['no_data', false], ['no_sleep', false], ['off', false]]) {
    db.prepare('DELETE FROM sleep_nights').run();
    plantNight(finishedNight({ status }));
    assert.equal(nightIsLocked(CHILD, DATE), locks, `a corrected ${status} row ${locks ? 'locks' : 'does not lock'}`);
  }
  // The boundary itself (B7): a row stored in the very minute the window closes (the job's first tick can
  // land there; computed_at is minute-floored) is a finished night, and locks.
  db.prepare('DELETE FROM sleep_nights').run();
  plantNight(finishedNight({ computed_at: WINDOW_END }));
  assert.equal(nightIsLocked(CHILD, DATE), true, 'computed_at == window_end locks');
  db.prepare('DELETE FROM sleep_nights').run();
  plantNight(finishedNight({ computed_at: sql(at(6, 59, 1)) }));
  assert.equal(nightIsLocked(CHILD, DATE), false, 'one minute before the window closed does not');
  // Plan review R9: a row written while its window was still open is a snapshot of a night in progress
  // (an admin ?store=1 for tonight is the one way one exists). It must not freeze, and neither must a
  // "no one was in the bed" on it, which the overlay itself ignores until the night is over.
  db.prepare('DELETE FROM sleep_nights').run();
  const future = new Date(Date.now() + 3600 * 1000);
  plantNight(finishedNight({ window_end: sql(future), computed_at: sql(new Date(future.getTime() - 2 * 3600 * 1000)) }));
  assert.equal(nightIsLocked(CHILD, DATE), false, 'a time correction over an in-progress snapshot does not lock');
  saveNightReview(CHILD, DATE, { nobodyInBed: true });
  assert.equal(nightIsLocked(CHILD, DATE), false, 'nor does the flag');
  assert.equal(applyCorrection(CHILD, storedRow()).corrected, undefined, 'and the overlay agrees: it ignores the flag until the night is over');
});

// --- the nightly job ---------------------------------------------------------------------------------------

test('★ the nightly job leaves a corrected night alone: no recompute at all, and not one column moves', (t) => {
  // The recalculated night, as a test. The same night is recomputed by the tick BEFORE the correction (proving the
  // job would have touched it) and not by the tick after. The job's own "Computed N" line is how a
  // recompute is observed (the same technique as recompute-night.test.js's #508 T11b), so the fixture's
  // second child is taken out of the job for this test: its line must count this child alone.
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(OTHER_CHILD);
  layLateWakeNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  const info = t.mock.method(logger, 'info', () => {});
  const computedLines = () => info.mock.calls.filter((c) => /\[sleep\] Computed 1 sleep summary/.test(String(c.arguments[0]))).length;
  runNightlySleepJob();
  assert.equal(storedRow().status, 'ok', 'precondition: the first pass scored the night');

  t.mock.timers.tick(20 * 60000);
  const beforeCorrection = computedLines();
  runNightlySleepJob();
  assert.equal(computedLines(), beforeCorrection + 1, 'control: with no correction, a provisional night IS recomputed');

  saveNightReview(CHILD, DATE, { trueWakeAt: sql(at(6, 10, 1)) });
  assert.equal(nightIsLocked(CHILD, DATE), true, 'precondition: the correction locked it');
  assert.equal(isEvidenceFinal(storedRow().window_end, Date.parse(`${storedRow().computed_at.replace(' ', 'T')}Z`)), false,
    'precondition: still provisional, so only the lock can stop the job');
  // Hostile: a marker in every column the lock and the job's gates do not read, so a recompute that wrote
  // anything at all is visible by name.
  const GATES = ['id', 'child_id', 'night_date', 'status', 'window_end', 'computed_at'];
  nightsCols().forEach((c, i) => {
    if (GATES.includes(c.name)) return;
    const v = /INT/i.test(c.type) ? 700000 + i : /REAL/i.test(c.type) ? 700.5 + i : `LOCKED:${c.name}`;
    db.prepare(`UPDATE sleep_nights SET ${c.name} = ? WHERE child_id = ? AND night_date = ?`).run(v, CHILD, DATE);
  });
  const planted = storedRow();

  for (const minutes of [30, 30, 30]) {
    t.mock.timers.tick(minutes * 60000);
    const seen = computedLines();
    runNightlySleepJob();
    assert.equal(computedLines(), seen, 'the job skipped the corrected night before computing it');
    assert.deepEqual(storedRow(), planted, 'and nothing in its stored row moved, computed_at included');
  }
});

test('★ removing the last correction un-locks: the job stores the night once more, even hours past the 3h window', (t) => {
  // Plan review R7. A skipped pass never touches computed_at, so a row last written before the evidence
  // horizon is still owed one pass once the lock lifts, even though the wall clock is well past it.
  layLateWakeNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  runNightlySleepJob();
  t.mock.timers.tick(5 * 60000);
  saveNightReview(CHILD, DATE, { trueOnsetAt: sql(at(19, 12)) }); // 07:10: stored once more, then locked
  const lockedAt = storedRow().computed_at;
  assert.equal(lockedAt, minuteSql(at(7, 10, 1)));

  t.mock.timers.tick(at(13, 0, 1).getTime() - at(7, 10, 1).getTime()); // 13:00, three hours past the horizon
  runNightlySleepJob();
  assert.equal(storedRow().computed_at, lockedAt, 'still locked: not touched');

  saveNightReview(CHILD, DATE, { trueOnsetAt: null }); // the only correction, removed
  assert.equal(nightIsLocked(CHILD, DATE), false);
  assert.equal(storedRow().computed_at, lockedAt, 'removing a correction stores nothing by itself');
  t.mock.timers.tick(30 * 60000);
  runNightlySleepJob();
  assert.equal(storedRow().computed_at, minuteSql(at(13, 30, 1)), 'the owed pass ran, hours past the 3h window');

  const final = storedRow();
  t.mock.timers.tick(30 * 60000);
  runNightlySleepJob();
  assert.deepEqual(storedRow(), final, 'and that write was at or after the horizon, so the night is final now');
});

// --- saving a correction stores the night as it looked, THEN locks it (the plan's design change) ----------

test('★ a night corrected on its provisional first row is locked with the LIVE wake, not the first pass\'s null', async (t) => {
  // Both plan reviewers: the morning card is offered on the job's first row, which has no wake yet on a
  // night whose departure is still being confirmed. Locking that row would freeze "still asleep" forever.
  layLateWakeNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob();
  assert.equal(storedRow().wake_at, null, 'precondition: the first pass had no wake yet');

  t.mock.timers.tick(at(7, 50, 1).getTime() - at(7, 2, 1).getTime());
  const res = await put({ true_onset_local: '19:12' }); // the parent corrects only the asleep time
  assert.equal(res.status, 200);
  assert.equal(storedRow().wake_at, sql(at(7, 20, 1)), 'the night was stored from the live compute: up 07:20');
  assert.equal(storedRow().computed_at, minuteSql(at(7, 50, 1)), 'at the moment of the save');
  assert.equal(nightIsLocked(CHILD, DATE), true);

  const saved = storedRow();
  t.mock.timers.tick(40 * 60000);
  runNightlySleepJob();
  assert.deepEqual(storedRow(), saved, 'and the lock keeps exactly that');
});

test('a plain "That\'s right" confirmation locks the night too', async (t) => {
  layLateWakeNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 50, 1).getTime() });
  runNightlySleepJob();
  const shown = (await get(`/review/${DATE}`)).body.computed;
  // Exactly what NightReview's "That's right" sends: the shown times as typed times, plus the echo.
  const res = await put({
    true_onset_local: '19:10', true_wake_local: '07:20',
    computed_onset_at: shown.onset_at, computed_wake_at: shown.wake_at,
  });
  assert.equal(res.status, 200);
  assert.equal(nightIsLocked(CHILD, DATE), true, 'reviewed is complete, whether it was a correction or a confirmation');
});

test('saves that do not correct the night neither store it nor lock it: a dismissal, the event answers, and an API-only bare note', async (t) => {
  layLateWakeNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  runNightlySleepJob();
  const first = storedRow();
  const frame = layTransition(TRANSITION.INTO_BED, sql(at(19, 1)));
  t.mock.timers.tick(20 * 60000);
  for (const body of [
    { dismissed: true },
    // ⚠️ API ONLY: no screen sends a note on its own. The edit card always sends its asleep and wake times
    // with it, so a note saved there DOES lock the night (owner decision D2, 2026-09-30); that exact body is
    // tested in sleepReportNotify.test.js, where the suppressed follow-up push can be seen too.
    { note: 'a cold, slept badly' },
    // What NightReview's "Save just the event answers" sends: verdicts plus the computed echo.
    { verdicts: { [frame]: 'correct' }, computed_onset_at: first.onset_at, computed_wake_at: first.wake_at },
  ]) {
    assert.equal((await put(body)).status, 200, JSON.stringify(body));
    assert.deepEqual(storedRow(), first, `${JSON.stringify(body)} must not re-store the night`);
    assert.equal(nightIsLocked(CHILD, DATE), false, `${JSON.stringify(body)} must not lock it`);
  }
});

test('the save-time store only does what the job still owes: never a missing, unscored, open or FINAL row', (t) => {
  // No row: nothing is created, so the job keeps the night's first scored pass (its timelapse, its report).
  layPlainNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  assert.deepEqual(storeNightBeforeCorrection(CHILD, DATE), { stored: false, skipped: 'unscored' });
  saveNightReview(CHILD, DATE, { trueWakeAt: sql(at(6, 10, 1)) });
  assert.equal(storedRow(), undefined, 'a correction before the night was ever stored creates no row');

  // Unscored: left for the job, which scores it and then the lock holds.
  plantNight(finishedNight({ status: 'no_data', computed_at: sql(at(7, 5, 1)) }));
  assert.deepEqual(storeNightBeforeCorrection(CHILD, DATE), { stored: false, skipped: 'unscored' });

  // A window still open: never store a night in progress. (The review saved above is removed first: over a
  // scored, closed row it would LOCK the night, and a locked night is skipped before anything else.)
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM sleep_reviews').run();
  plantNight(finishedNight({ computed_at: sql(at(7, 1, 1)) }));
  assert.deepEqual(storeNightBeforeCorrection(CHILD, DATE, at(6, 59, 1).getTime()), { stored: false, skipped: 'in_progress' });
  // ...and the same provisional row once the window HAS closed is refreshed (the case this exists for).
  assert.equal(storeNightBeforeCorrection(CHILD, DATE).stored, true);
});

test('★ a caregiver correcting a FINAL last night does not re-score it (that is the admin Recompute\'s job)', async (t) => {
  // The recompute here WOULD change the row (real samples, planted figures), so leaving it alone is the
  // guard working, not a no-op. The clock puts DATE as the child's LAST completed night, half an hour past
  // its evidence horizon, and the row was written after the horizon: only the finality check can skip it.
  layPlainNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(10, 30, 1).getTime() });
  plantNight(finishedNight({ onset_at: 'PLANTED', wake_at: 'PLANTED', asleep_minutes: 1, computed_at: sql(at(10, 5, 1)) }));
  const before = storedRow();
  const res = await put({ true_wake_local: '06:10' }, { token: caregiverToken });
  assert.equal(res.status, 200, 'caregivers can still review, as always');
  assert.deepEqual(storedRow(), before, 'the final row was not re-scored');
  assert.equal(nightIsLocked(CHILD, DATE), true, 'and it is now locked as it was');
});

test('★ a correction on an OLD night whose row never became final is not re-scored either (fix round, item 1)', async (t) => {
  // Found by review: rows written before #351 (0.31.0) were written once and never finalised, and a
  // locked row's computed_at stays early for good, so an old night's OWN computed_at can still read
  // "provisional". Only "is this the child's last completed night?" tells the job's scope from history.
  // Ten days later, a caregiver corrects DATE. Real samples mean a re-score WOULD change the planted row.
  layPlainNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 0, 11).getTime() });
  plantNight(finishedNight({ onset_at: 'PLANTED', wake_at: 'PLANTED', asleep_minutes: 1, computed_at: sql(at(7, 5, 1)) }));
  assert.equal(isEvidenceFinal(WINDOW_END, at(7, 5, 1).getTime()), false, 'precondition: provisional by its OWN computed_at');
  const before = storedRow();
  const res = await put({ true_wake_local: '06:10' }, { token: caregiverToken });
  assert.equal(res.status, 200);
  assert.deepEqual(storedRow(), before, 'a ten-day-old night is not re-scored with today\'s detector');
  assert.deepEqual(storeNightBeforeCorrection(CHILD, DATE), { stored: false, skipped: 'locked' },
    'and it is locked as it was');
  db.prepare('DELETE FROM sleep_reviews').run();
  assert.deepEqual(storeNightBeforeCorrection(CHILD, DATE), { stored: false, skipped: 'not_last_night' },
    'the skip that protects it is the last-night check, not finality');
});

test('★ corrected in the half hour between the evidence horizon and the job\'s next pass: the owed pass still runs (B8)', async (t) => {
  // Finality is judged on the row's OWN computed_at, never on the current time (that is the #351 bug).
  // Exit at 09:35, confirmable at ~09:56, horizon 10:00. The job last wrote the row at 09:45 (wake still
  // unknown). The parent corrects the asleep time at 10:10, before the job's next tick at 10:15. The row
  // is owed one pass: judged on "now" (past the horizon) it would look final, the store would be skipped,
  // and the lock would freeze "still asleep" for good, because the job never recomputes a locked night.
  layNight([[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(9, 25, 1), at(9, 35, 1)]], at(10, 30, 1));
  layTransition(TRANSITION.OUT_OF_BED, sql(at(9, 35, 1, 30)));
  t.mock.timers.enable({ apis: ['Date'], now: at(9, 45, 1).getTime() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(storedRow().wake_at, null, 'precondition: not yet confirmable at 09:45');

  t.mock.timers.tick(at(10, 10, 1).getTime() - at(9, 45, 1).getTime());
  assert.equal(isEvidenceFinal(WINDOW_END), true, 'precondition: by the wall clock the horizon has passed');
  const res = await put({ true_onset_local: '19:12' });
  assert.equal(res.status, 200);
  assert.equal(storedRow().computed_at, minuteSql(at(10, 10, 1)), 'the owed pass ran at the save');
  assert.equal(storedRow().wake_at, sql(at(9, 35, 1)), 'and it is the full-evidence night that got locked');
  assert.equal(nightIsLocked(CHILD, DATE), true);
});

test('★ a later save on an already-locked night recomputes NOTHING: re-edit, note or verdict (fix round, item 2)', async (t) => {
  // Every save that leaves the night corrected calls the store-first step. Once the night is locked the
  // store is refused anyway, so it must return BEFORE computeNight: otherwise each re-edit, note or
  // verdict paid for a full compute, and a compute that threw would 500 a save after applyVerdicts wrote.
  // computeNight's first act is `SELECT id FROM cameras WHERE child_id = ?`, prepared per call and nowhere
  // else on this route, so counting that statement counts computes without touching production code.
  layLateWakeNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  runNightlySleepJob();
  t.mock.timers.tick(5 * 60000);
  assert.equal((await put({ true_wake_local: '07:20' })).status, 200); // the first correction: stores, then locks
  assert.equal(nightIsLocked(CHILD, DATE), true, 'precondition: locked');
  assert.equal(isEvidenceFinal(WINDOW_END, Date.parse(`${storedRow().computed_at.replace(' ', 'T')}Z`)), false,
    'precondition: still provisional, so without the lock check the store-first step WOULD compute');
  const locked = storedRow();
  const frame = layTransition(TRANSITION.INTO_BED, sql(at(19, 1)));

  const prepare = t.mock.method(db, 'prepare');
  const computes = () => prepare.mock.calls.filter((c) => c.arguments[0] === 'SELECT id FROM cameras WHERE child_id = ?').length;
  for (const body of [{ true_onset_local: '19:12' }, { note: 'a cold' }, { verdicts: { [frame]: 'correct' } }]) {
    const seen = computes();
    assert.equal((await put(body)).status, 200, JSON.stringify(body));
    assert.equal(computes(), seen, `${JSON.stringify(body)} ran computeNight on a locked night`);
    assert.deepEqual(storedRow(), locked, 'and the locked row is untouched');
  }
  assert.deepEqual(storeNightBeforeCorrection(CHILD, DATE), { stored: false, skipped: 'locked' });
});

test('★ a FIRST correction whose save-time compute throws is a 500 before anything is written: no verdict, no review (fix round 2)', async (t) => {
  // Opus #6, verified. The store-first step runs a full computeNight, and it ran inside saveNightReview,
  // AFTER applyVerdicts had written: a compute that threw left the verdicts saved while the person was told
  // the save failed. Now the route runs it after every refusal and before any write. The compute is made to
  // throw at its first statement (the same per-call prepare the test above counts), without touching
  // production code.
  layLateWakeNight();
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  runNightlySleepJob();
  t.mock.timers.tick(5 * 60000);
  const first = storedRow();
  const frame = layTransition(TRANSITION.INTO_BED, sql(at(19, 1)));

  const COMPUTE_FIRST_SQL = 'SELECT id FROM cameras WHERE child_id = ?';
  const realPrepare = db.prepare.bind(db);
  const prepare = t.mock.method(db, 'prepare', (source) => {
    if (source === COMPUTE_FIRST_SQL) throw new Error('compute failed');
    return realPrepare(source);
  });
  const res = await put({ true_wake_local: '07:20', verdicts: { [frame]: 'correct' }, reasons: {} });
  prepare.mock.restore();

  assert.equal(res.status, 500, JSON.stringify(res.body));
  assert.equal(res.body.error, 'compute failed', 'precondition: the 500 is the save-time compute, not something else');
  assert.equal(verdictOf(frame), null, 'the verdict was NOT written');
  assert.equal(reviewRow(), undefined, 'nor the review');
  assert.deepEqual(storedRow(), first, 'nor the night');
  assert.equal(nightIsLocked(CHILD, DATE), false);

  // The same save once the compute works: stored first, then locked, verdict and all. And stored ONCE: the
  // route's own store-first step replaces saveNightReview's, it does not run beside it (a second one would
  // find the night not yet locked and still provisional, and compute it again).
  const spy = t.mock.method(db, 'prepare', (source) => realPrepare(source));
  assert.equal((await put({ true_wake_local: '07:20', verdicts: { [frame]: 'correct' } })).status, 200);
  const computes = spy.mock.calls.filter((c) => c.arguments[0] === COMPUTE_FIRST_SQL).length;
  spy.mock.restore();
  assert.equal(computes, 1, 'one save-time compute, not two');
  assert.equal(verdictOf(frame), 'correct');
  assert.equal(nightIsLocked(CHILD, DATE), true);
  assert.equal(storedRow().computed_at, minuteSql(at(7, 10, 1)), 'stored at the save');
});

// --- the admin Recompute and ?stored=1 ----------------------------------------------------------------------

test('★ ?store=1 is refused with a 409 "reviewed" on a corrected night, for each of the four kinds of correction', async () => {
  layPlainNight();
  computeAndStoreNight(CHILD, DATE); // real clock: a finished, final row
  const ok = await get(`/sleep/${DATE}?store=1`);
  assert.equal(ok.status, 200, 'control: uncorrected, the admin can recompute');
  assert.equal(ok.body.stored, true);

  const putDown = layTransition(TRANSITION.INTO_BED, sql(at(18, 49)));
  for (const body of [{ true_onset_local: '19:12' }, { true_wake_local: '06:10' },
    { true_in_bed_transition_id: putDown }, { nobody_in_bed: true }]) {
    db.prepare('DELETE FROM sleep_reviews').run();
    assert.equal((await put(body)).status, 200);
    const before = storedRow();
    const res = await get(`/sleep/${DATE}?store=1`);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(res.body.reason, 'reviewed');
    assert.match(res.body.error, /corrected in the morning review/);
    assert.match(res.body.error, /left as it is/, 'the same closing sentence as the other refusals');
    assert.deepEqual(storedRow(), before, 'nothing written');
  }
});

test('the "reviewed" refusal comes BEFORE "would_downgrade": a locked night is never told its data aged out', () => {
  layPlainNight();
  computeAndStoreNight(CHILD, DATE);
  saveNightReview(CHILD, DATE, { trueWakeAt: sql(at(6, 10, 1)) });
  db.prepare('DELETE FROM activity_samples').run(); // a recompute would now come back no_data
  const r = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(r.stored, false);
  assert.equal(r.refused, 'reviewed');
});

test('a caregiver\'s ?store=1 on a corrected night is still just a read, as on any other night', async () => {
  layPlainNight();
  computeAndStoreNight(CHILD, DATE);
  await put({ true_wake_local: '06:10' });
  const res = await get(`/sleep/${DATE}?store=1`, caregiverToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.stored, undefined);
  assert.equal(res.body.corrected, true, 'the normal, overlaid read');
});

test('?stored=1 says whether the night is locked, beside the saved row it always returned', async () => {
  layPlainNight();
  let res = await get(`/sleep/${DATE}?stored=1`);
  assert.deepEqual(res.body, { night: null, locked: false });

  computeAndStoreNight(CHILD, DATE);
  res = await get(`/sleep/${DATE}?stored=1`);
  assert.equal(res.body.locked, false);
  assert.equal(res.body.night.status, 'ok', 'the saved row is still there, unchanged in shape');

  await put({ true_wake_local: '06:10' });
  assert.equal((await get(`/sleep/${DATE}?stored=1`)).body.locked, true);

  // A corrected night whose saved row is unscored is NOT locked: Recompute is how that one gets fixed.
  db.prepare("UPDATE sleep_nights SET status = 'no_data' WHERE child_id = ?").run(CHILD);
  assert.equal((await get(`/sleep/${DATE}?stored=1`)).body.locked, false);
});

// ================================ Fix round 3 (2026-10-02) ================================
// Each finding below was found by a reviewer TRACING the code (Opus and Codex, round 3). Two kinds of test
// here, labelled so the next reader can tell them apart (reworded in fix round 4, Opus #4 / Codex #2, because
// this header used to claim every test failed on the unfixed code, and two did not):
//   - REGRESSION tests were first run against the unfixed code and failed there: the noon wake, the onset
//     shown before noon, the clocks-back hour, B1, B2 and C.
//   - GUARD tests pass on the old code and the new alike. They pin a boundary of a fix so that widening or
//     loosening it fails: "DIFFERS from the one shown" and "never refused over a stored night". Each says which
//     mutants it kills.
// The mutants.json entries labelled "fix3" (and "fix4") pin all of them.

// --- a typed time the page SHOWED is saved as the instant it showed (A, Opus #1) ----------------------------

// The fixture's zone is a fixed UTC+10 in July, so a local clock reading is the UTC instant plus ten hours.
const localHm = (s) => new Date(Date.parse(`${s.replace(' ', 'T')}Z`) + TZ_OFF).toISOString().slice(11, 16);

test('★ a detected wake after local noon is saved as shown: "That\'s right" with 12:05 lands on the morning after (fix round 3, A)', async () => {
  // localHmToUtcSql reads a bare HH:MM at or after 12:00 as the night's OWN date. But a detected wake can be
  // after local noon: any window end is accepted, the departure search runs WAKE_LOOKAHEAD_MS (3 h) past it,
  // and a departure past the window end is reported as-is. With a window ending at 10:00 a 12:05 departure IS
  // the night's wake. "That's right" sent "12:05", the noon rule put it seven hours BEFORE the asleep time, and
  // the asleep-after-wake 400 refused the app's own time (before that 400 existed, it was stored on the wrong
  // day). Nothing on the screen could fix it: a 12:05 exit is outside the review's noon-to-noon event list.
  db.prepare("UPDATE children SET sleep_window_end = '10:00' WHERE id = ?").run(CHILD);
  layNight([[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(11, 55, 1), at(12, 5, 1)]], at(12, 30, 1));
  layTransition(TRANSITION.OUT_OF_BED, sql(at(12, 5, 1, 30)));
  const shown = (await get(`/review/${DATE}`)).body.computed;
  assert.equal(shown.wake_at, sql(at(12, 5, 1)), 'precondition: the detector itself reports 12:05 the morning after');
  assert.ok(shown.onset_at, 'precondition: and an asleep time');

  // Exactly what NightReview's "That's right" sends: the shown times as typed times, plus the echo.
  const echo = { computed_onset_at: shown.onset_at, computed_wake_at: shown.wake_at };
  const res = await put({ true_onset_local: localHm(shown.onset_at), true_wake_local: '12:05', ...echo });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(reviewRow().true_wake_at, sql(at(12, 5, 1)), 'the morning after, where the page showed it');
  assert.equal(reviewRow().true_onset_at, shown.onset_at);

  // Any edit-card save sends the same unchanged 12:05 (here: a put-down marked, then Save).
  const edit = await put({
    true_onset_local: localHm(shown.onset_at), true_wake_local: '12:05', true_onset_transition_id: null,
    true_wake_transition_id: null, true_in_bed_local: '18:50', note: null, ...echo, verdicts: {}, reasons: {},
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(reviewRow().true_wake_at, sql(at(12, 5, 1)));
});

test('a typed time that DIFFERS from the one shown keeps the noon rule, and so does a missing or out-of-range echo (fix round 3, A)', async () => {
  // GUARD, mostly: on the unfixed code (no echo at all) every assertion here held EXCEPT the seconds-echo one
  // below, so this test fails there only through that assertion. What it is for is killing the mutants that
  // loosen the echo: fix3 A2 (no bound), A3 (whatever was typed), A5 (the echo's own seconds) and fix4 M2
  // (minutes compared alone: a typed 06:05 taken as a shown 12:05).
  // A window ending at 10:00, so a 12:05 wake the morning after is one the app can show (fix round 4: the echo
  // is trusted only inside the span the detector can report for the night, see localHmToUtcSql). With the
  // default 07:00 end the seconds-echo assertion would now test the bound instead of the seconds.
  db.prepare("UPDATE children SET sleep_window_end = '10:00' WHERE id = ?").run(CHILD);
  const shownWake = sql(at(12, 5, 1));
  // 12:10 is not what the page showed, so nothing says which day: the noon rule puts it on the night's own
  // date (the README known limit), and beside an asleep time that is the asleep-after-wake 400.
  assert.equal((await put({ true_wake_local: '12:10', computed_wake_at: shownWake })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(12, 10)), "the night's own date");
  const typed = await put({ true_onset_local: '19:10', true_wake_local: '12:10', computed_wake_at: shownWake });
  assert.equal(typed.status, 400);
  // Before noon is the morning after, as always, whatever was shown.
  assert.equal((await put({ true_wake_local: '11:50', computed_wake_at: shownWake })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(11, 50, 1)));
  // The same minutes past a different hour is a different time (fix round 4, Opus M2): a typed 06:05 is not the
  // shown 12:05, so it is the noon rule's 06:05 the morning after, not the echo.
  assert.equal((await put({ true_wake_local: '06:05', computed_wake_at: shownWake })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(6, 5, 1)));
  // No echo (a page with no opinion, or an API caller): the noon rule.
  assert.equal((await put({ true_wake_local: '12:05', computed_wake_at: null })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(12, 5)));
  // An echo outside the span the detector can report for this night is not trusted to move a typed time: the
  // echo is the client's word, and without a bound it could put a typed HH:MM on any day at all.
  for (const far of [sql(at(12, 5, 2)), sql(at(12, 5, -1))]) {
    assert.equal((await put({ true_wake_local: '12:05', computed_wake_at: far })).status, 200);
    assert.equal(reviewRow().true_wake_at, sql(at(12, 5)), `an echo of ${far} is ignored`);
  }
  // An echo carrying seconds (no real one does: computeNight writes whole minutes) saves the typed MINUTE on the
  // echo's date. A typed time is to the minute, and the ordering rules' minute of slack is measured from that.
  assert.equal((await put({ true_wake_local: '12:05', computed_wake_at: sql(at(12, 5, 1, 40)) })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(12, 5, 1)));
  // The ordinary night: the shown time and the noon rule agree, to the same stored string.
  db.prepare('DELETE FROM sleep_reviews').run();
  const res = await put({
    true_onset_local: '19:13', true_wake_local: '06:37', computed_onset_at: sql(at(19, 13)), computed_wake_at: sql(at(6, 37, 1)),
  });
  assert.equal(res.status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(19, 13)));
  assert.equal(reviewRow().true_wake_at, sql(at(6, 37, 1)));
});

test('the same for the asleep time: an onset shown before local noon on the night\'s own date is saved there (fix round 3, A)', async () => {
  // Route-level, with the echo planted: an asleep time before local noon on the night's own date needs a window
  // that opens before noon (a household whose night starts in the morning), here 11:00. By the noon rule "11:30"
  // is the morning AFTER, which puts it after a 06:30 wake and refuses the save. (The window is set since fix
  // round 4, which trusts an echo only inside the span the detector can report for the night: the default
  // 19:00 window could never show an 11:30 onset.)
  db.prepare("UPDATE children SET sleep_window_start = '11:00' WHERE id = ?").run(CHILD);
  const shownOnset = sql(at(11, 30));
  const res = await put({ true_onset_local: '11:30', true_wake_local: '06:30', computed_onset_at: shownOnset });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(reviewRow().true_onset_at, shownOnset, "the night's own date, as shown");
  // Typed differently, the noon rule again: the morning after, after the wake, refused.
  db.prepare('DELETE FROM sleep_reviews').run();
  const typed = await put({ true_onset_local: '11:35', true_wake_local: '06:30', computed_onset_at: shownOnset });
  assert.equal(typed.status, 400);
  assert.equal(reviewRow(), undefined);
});

test('on the night the clocks go back, an unchanged time lands on the occurrence the page showed (fix round 3, A)', async () => {
  // This zone leaves daylight saving at 03:00 on Sunday 2026-04-05, so 02:00-02:59 happens twice: 02:30 in
  // daylight time (15:30 UTC) and then 02:30 in standard time (16:30 UTC). A bare "02:30" can only be read as
  // one of them; the echo of what the page showed says which.
  const NIGHT = '2026-04-04';
  const first = '2026-04-04 15:30:00';
  const second = '2026-04-04 16:30:00';
  assert.equal((await put({ true_wake_local: '02:30', computed_wake_at: first }, { date: NIGHT })).status, 200);
  assert.equal(reviewRow(NIGHT).true_wake_at, first, 'the first occurrence, as shown');
  assert.equal((await put({ true_wake_local: '02:30', computed_wake_at: second }, { date: NIGHT })).status, 200);
  assert.equal(reviewRow(NIGHT).true_wake_at, second, 'the second occurrence, as shown');
  assert.equal((await put({ true_wake_local: '02:30', computed_wake_at: null }, { date: NIGHT })).status, 200);
  // Pinned for a zone EAST of UTC only; the test below pins one west of it, where the answer is the other one.
  assert.equal(reviewRow(NIGHT).true_wake_at, second, 'nothing shown, east of UTC: the second occurrence (README known limit)');
});

test('the clocks-back hour with nothing shown is read as the FIRST occurrence west of UTC: the README must not claim one answer (fix round 4, docs)', async () => {
  // PIN, not a fix: Opus #2 (fix round 4) found the README and CHANGELOG saying a typed time in the repeated hour
  // is always its SECOND occurrence. That is what zonedToUtc's refinement pass resolves east of UTC (Melbourne,
  // pinned above; also Auckland, London, Berlin), but west of it (New York, Los Angeles, also Santiago, so it is
  // not the hemisphere) it resolves the FIRST. New York leaves daylight saving at 02:00 on Sunday 2026-11-01, so
  // 01:00-01:59 happens twice: 01:30 EDT (05:30 UTC), then 01:30 EST (06:30 UTC). The echo still names either.
  const setTz = (tz) => db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(tz);
  setTz('America/New_York');
  try {
    const NIGHT = '2026-10-31';
    assert.equal((await put({ true_wake_local: '01:30' }, { date: NIGHT })).status, 200);
    assert.equal(reviewRow(NIGHT).true_wake_at, '2026-11-01 05:30:00', 'nothing shown, west of UTC: the FIRST occurrence');
    assert.equal((await put({ true_wake_local: '01:30', computed_wake_at: '2026-11-01 06:30:00' }, { date: NIGHT })).status, 200);
    assert.equal(reviewRow(NIGHT).true_wake_at, '2026-11-01 06:30:00', 'the second occurrence, as shown');
  } finally {
    setTz(TZ);
  }
});

// --- the ordering checks cannot be stepped around (B, Opus #2 + Codex #1) ----------------------------------

test('★ clearing the asleep time is checked against the night\'s STORED asleep time too, and a refusal writes nothing (fix round 3, B1)', async () => {
  // The stored-asleep check ran only for a save that GAVE an in-bed time. A review holding in bed 19:30 and
  // asleep 19:45 is consistent, but a later save that CLEARS the asleep time leaves "in bed 19:30, no asleep
  // time": the card then lays that put-down beside the STORED asleep 19:13, and showsInBed silently hides it,
  // the hiding the check exists to prevent.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(6, 37, 1)), asleep_minutes: 600 }));
  const exit = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 37, 1)));
  assert.equal((await put({ true_in_bed_local: '19:30', true_onset_local: '19:45' })).status, 200);

  // Exactly the edit card's save with "Fell asleep" emptied and In bed left alone (so not sent).
  const res = await put({
    true_onset_local: null, true_wake_local: '06:37', true_onset_transition_id: null, true_wake_transition_id: null,
    note: null, computed_onset_at: sql(at(19, 13)), computed_wake_at: sql(at(6, 37, 1)),
    verdicts: { [exit]: 'correct' }, reasons: {},
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /"In bed" can't be after the time they fell asleep/);
  assert.equal(reviewRow().true_onset_at, sql(at(19, 45)), 'nothing written: the asleep time is still there');
  assert.equal(reviewRow().true_wake_at, null);
  assert.equal(verdictOf(exit), null, 'verdicts included');

  // Clearing both leaves no put-down to hide, and a put-down before the stored asleep time is fine.
  assert.equal((await put({ true_in_bed_local: null, true_onset_local: null })).status, 200);
  assert.equal((await put({ true_in_bed_local: '19:00' })).status, 200);
  assert.equal((await put({ true_onset_local: null })).status, 200, 'in bed 19:00 beside the stored 19:13');
});

test('★ an asleep time saved with no wake time is checked against the night\'s STORED wake time (fix round 3, B2)', async () => {
  // Asleep was only ever compared with a wake in the review itself, so "07:30" (by the noon rule, the morning
  // after) saved fine beside the stored 06:30 wake, and every screen then showed asleep 07:30, up 06:30, with
  // the total floored to 0.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(6, 30, 1)), asleep_minutes: 600 }));
  const exit = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 30, 1)));
  const refused = await put({ true_onset_local: '07:30', verdicts: { [exit]: 'correct' } });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /"Fell asleep" can't be after the time they got up/);
  assert.equal(reviewRow(), undefined, 'nothing stored');
  assert.equal(verdictOf(exit), null, 'verdicts included');

  // The same minute of slack as every ordering rule: the same minute is fine, a full minute after is not.
  assert.equal((await put({ true_onset_local: '06:31' })).status, 400, 'a minute after the stored wake');
  assert.equal((await put({ true_onset_local: '06:30' })).status, 200, 'the same minute');
  // With a wake time in the review, THAT is what asleep is checked against, not the stored one.
  assert.equal((await put({ true_onset_local: '07:30', true_wake_local: '07:45' })).status, 200);
  // No stored wake (the departure still being confirmed): nothing to check against.
  db.prepare('DELETE FROM sleep_reviews').run();
  db.prepare('UPDATE sleep_nights SET wake_at = NULL WHERE child_id = ?').run(CHILD);
  assert.equal((await put({ true_onset_local: '07:30' })).status, 200);
});

test('★ a note or an event answer is never refused over a stored night that moved after the review: only a save touching those times is checked (fix round 3, B)', async () => {
  // GUARD: this passes on the code before fix round 3 and after it alike. It exists to kill the mutants that
  // WIDEN the stored-night checks to saves that do not touch those times: fix3 B1b (no touch guard on the
  // in-bed check), B1c (an asleep time NOT SENT read as cleared) and B2b (no touch guard on the asleep check).
  // A stored night can move under an existing review: a review saved before the night's first scored summary
  // locks only at that summary, which the nightly job then writes. The two stored-night checks validate what is
  // being saved NOW, so a later note or event answer must not be refused over a contradiction it did not make.
  plantNight(finishedNight({ onset_at: sql(at(19, 45)), wake_at: sql(at(6, 37, 1)), asleep_minutes: 600 }));
  const exit = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 37, 1)));

  // In bed 19:30 against a stored asleep 19:45: fine. Then the stored asleep time moves to 19:13.
  assert.equal((await put({ true_in_bed_local: '19:30' })).status, 200);
  db.prepare('UPDATE sleep_nights SET onset_at = ? WHERE child_id = ?').run(sql(at(19, 13)), CHILD);
  assert.equal((await put({ note: 'a cold' })).status, 200, 'a note');
  assert.equal((await put({ verdicts: { [exit]: 'correct' } })).status, 200, 'an event answer');
  assert.equal((await put({ dismissed: true })).status, 200, 'a dismissal');

  // Asleep 05:30 against a stored wake 06:37: fine. Then the stored wake moves to 05:00.
  db.prepare('DELETE FROM sleep_reviews').run();
  assert.equal((await put({ true_onset_local: '05:30' })).status, 200);
  db.prepare('UPDATE sleep_nights SET wake_at = ? WHERE child_id = ?').run(sql(at(5, 0, 1)), CHILD);
  assert.equal((await put({ note: 'a cold' })).status, 200, 'a note');
  assert.equal((await put({ verdicts: { [exit]: 'wrong' } })).status, 200, 'an event answer');
  assert.equal(reviewRow().note, 'a cold');
  assert.equal(verdictOf(exit), 'wrong');
});

// --- a malformed echo is refused before anything is written (C, Opus #3 / Codex #2) ------------------------

test('★ a computed_* echo that is not a string is a 400 before anything is written, not a 500 after the verdicts (fix round 3, C)', async () => {
  // Pre-existing (at HEAD before this branch). The check was UTC_TIMESTAMP.test(String(v)), and the String of a
  // one-element array is its element, so ['2026-07-02 09:00:00'] passed. The array reached better-sqlite3 only
  // in the final upsert, after the verdicts had been written: a 500, whose body Cloudflare strips, for a save
  // that had half happened.
  const exit = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 30, 1)));
  for (const key of ['computed_onset_at', 'computed_wake_at']) {
    const res = await put({ true_wake_local: '06:10', [key]: ['2026-07-02 09:00:00'], verdicts: { [exit]: 'correct' } });
    assert.equal(res.status, 400, `${key}: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error, new RegExp(`${key} must be`));
    assert.equal(reviewRow(), undefined, 'nothing stored');
    assert.equal(verdictOf(exit), null, 'and the verdict did not land');
  }
});

// ================================ Fix round 4 (2026-10-02) ================================
// Codex + Opus reviewed fix round 3; Opus also ran copies of the time functions. Labelled as above: a
// REGRESSION test failed on the round-3 code before the round-4 fix; a GUARD or PIN passed there too and says
// what it kills or pins.

// --- the echo is trusted only inside the span the detector can report for THIS night (item 1) --------------

test('★ an asleep time the detector put on the evening BEFORE the night\'s date is saved as shown (fix round 4, 1a)', async () => {
  // REGRESSION (Opus #1, reproduced). Fix round 3 trusted an echo only on the night's LOCAL date or the morning
  // after. But computeNight looks for the asleep time from ONSET_LOOKBEHIND_MS (3 h) before the window opens, so
  // a window opening between 00:00 and 02:59 can report an asleep time on the PREVIOUS date. "That's right" then
  // sent 23:30 / 07:00: the asleep echo was outside the bound, the noon rule put 23:30 on the night's own
  // evening, after the 07:00 wake, and the save was refused over the app's own times.
  db.prepare("UPDATE children SET sleep_window_start = '01:00', sleep_window_end = '09:00' WHERE id = ?").run(CHILD);
  // A real night for that window, so the times below are the detector's own and not planted: awake until 23:30
  // the evening before with a put-down at 23:27, asleep from 23:30 (a small twitch every ten minutes, below
  // MOTION_ACTIVE, is what tells an occupied bed from an empty one), a stir at 03:00, up at 07:00.
  for (let t = at(22, 0, -1); t < at(9, 30); t = new Date(t.getTime() + 60000)) {
    const moving = [[at(22, 0, -1), at(23, 30, -1)], [at(3, 0), at(3, 9)], [at(6, 50), at(7, 0)]]
      .some(([a, b]) => t >= a && t < b);
    const twitch = t.getUTCMinutes() % 10 === 5;
    insertSample.run(CAM, minuteSql(t), moving ? 0.4 : 0.0002, moving ? 0.6 : twitch ? 0.003 : 0.0002);
  }
  layTransition(TRANSITION.INTO_BED, sql(at(23, 27, -1, 10)));
  layTransition(TRANSITION.OUT_OF_BED, sql(at(7, 0, 0, 30)));
  const computed = (await get(`/review/${DATE}`)).body.computed;
  // Opus's exact input, which the detector reproduces: night 2026-07-01, asleep 23:30 on 06-30, up 07:00 on 07-01.
  const shown = { computed_onset_at: '2026-06-30 13:30:00', computed_wake_at: '2026-06-30 21:00:00' };
  assert.equal(computed.onset_at, shown.computed_onset_at, 'precondition: the detector reports asleep 23:30 the evening before');
  assert.equal(computed.wake_at, shown.computed_wake_at, "precondition: and up at 07:00 on the night's date");
  assert.equal(shown.computed_onset_at, sql(at(23, 30, -1)), 'precondition: that is 23:30 local');
  // Exactly what NightReview's "That's right" sends.
  const res = await put({ true_onset_local: '23:30', true_wake_local: '07:00', ...shown });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(reviewRow().true_onset_at, shown.computed_onset_at, 'asleep: the evening before, as shown');
  assert.equal(reviewRow().true_wake_at, shown.computed_wake_at, 'up: as shown');
});

test('★ a hand-made echo cannot move a typed time onto the FOLLOWING evening (fix round 4, 1b)', async () => {
  // REGRESSION (Codex #1, reproduced). The round-3 bound accepted any echo on the night's date or the next, so
  // "19:00" with an echo of 19:00 on 07-02 stored an asleep time the FOLLOWING evening, a day no typed time could
  // ever select, and nothing this night's detector could have shown (its window is 19:00-07:00).
  const res = await put({ true_onset_local: '19:00', computed_onset_at: '2026-07-02 09:00:00' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(reviewRow().true_onset_at, sql(at(19, 0)), "the echo is ignored: the noon rule's own evening");
});

test('★ the echo is trusted exactly to the edges of that span, and not a minute past either (fix round 4, 1d)', async () => {
  // REGRESSION at two of the four edges (the round-3 calendar bound refused the first and took the last). Each
  // edge is placed where the noon rule would answer DIFFERENTLY from the echo, or the test could not tell them
  // apart. The span is [window start - ONSET_LOOKBEHIND_MS, window end + WAKE_LOOKAHEAD_MS), half-open like
  // the window: computeNight's earliest asleep time is the first minute of its lookbehind, and its latest
  // departure is strictly before the end of its lookahead (bedTransitions reads `created_at < ?`).
  // Start edge: a window opening at 01:00 can report from 22:00 the evening before.
  db.prepare("UPDATE children SET sleep_window_start = '01:00', sleep_window_end = '09:00' WHERE id = ?").run(CHILD);
  assert.equal((await put({ true_onset_local: '22:00', computed_onset_at: sql(at(22, 0, -1)) })).status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(22, 0, -1)), 'the first minute of the span: as shown');
  assert.equal((await put({ true_onset_local: '21:59', computed_onset_at: sql(at(21, 59, -1)) })).status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(21, 59)), 'a minute before it: the noon rule');
  // End edge: a window closing at 10:00 can report up to 12:59 the morning after.
  db.prepare('DELETE FROM sleep_reviews').run();
  db.prepare("UPDATE children SET sleep_window_start = '19:00', sleep_window_end = '10:00' WHERE id = ?").run(CHILD);
  assert.equal((await put({ true_wake_local: '12:59', computed_wake_at: sql(at(12, 59, 1)) })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(12, 59, 1)), 'the last minute of the span: as shown');
  assert.equal((await put({ true_wake_local: '13:00', computed_wake_at: sql(at(13, 0, 1)) })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(13, 0)), 'the end of the span itself: the noon rule');
});

test('an echo at exactly 12:00 and 11:59 on the night\'s date, the noon rule\'s edge: as shown inside the span, by the rule outside it (fix round 4, Codex)', async () => {
  // GUARD for the inside half and for the moved-noon mutants; REGRESSION for its last assertion, which the round-3
  // calendar bound failed (it took an 11:59 echo the default window could never show). Inside: a window opening
  // at 14:00 reports from 11:00, so both are times the app can show, and 11:59 is saved on the night's date
  // although the rule alone would say the morning after.
  db.prepare("UPDATE children SET sleep_window_start = '14:00' WHERE id = ?").run(CHILD);
  assert.equal((await put({ true_onset_local: '12:00', computed_onset_at: sql(at(12, 0)) })).status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(12, 0)));
  assert.equal((await put({ true_onset_local: '11:59', computed_onset_at: sql(at(11, 59)) })).status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(11, 59)), "as shown: the night's own date");
  // Outside (the default 19:00 window reports from 16:00): by the rule, which kills a moved noon in either
  // direction (12:00 is the night's own date, 11:59 the morning after).
  db.prepare("UPDATE children SET sleep_window_start = '19:00' WHERE id = ?").run(CHILD);
  assert.equal((await put({ true_onset_local: '12:00', computed_onset_at: sql(at(12, 0)) })).status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(12, 0)), "by the rule: the night's own date");
  assert.equal((await put({ true_onset_local: '11:59', computed_onset_at: sql(at(11, 59)) })).status, 200);
  assert.equal(reviewRow().true_onset_at, sql(at(11, 59, 1)), 'by the rule: the morning after');
});

test('a caller that passes no span gets the round-3 bound: the night\'s LOCAL date or the morning after (fix round 4, fallback)', () => {
  // GUARD. The route always passes the span. A caller of localHmToUtcSql with an echo but no span falls back to
  // the round-3 calendar bound, on the LOCAL date: 09:00 on the night's date here is 23:00 UTC the day BEFORE,
  // so reading the UTC date would refuse it (Opus M1).
  assert.equal(localHmToUtcSql(DATE, '09:00', sql(at(9, 0))), sql(at(9, 0)), "the night's own local date, as shown");
  assert.equal(localHmToUtcSql(DATE, '12:05', sql(at(12, 5, 1))), sql(at(12, 5, 1)), 'the morning after, as shown');
  assert.equal(localHmToUtcSql(DATE, '19:00', sql(at(19, 0, 2))), sql(at(19, 0)), 'two days on: ignored, the noon rule');
  assert.equal(localHmToUtcSql(DATE, '09:00'), sql(at(9, 0, 1)), 'the two-argument form: the noon rule');
});

// --- the stored-night checks, at the boundaries the round-3 mutants did not reach (item 4) -------------------

test('an asleep time saved alone beside a LATER wake already in the review is judged against that wake, not the stored one (fix round 4, M3)', async () => {
  // GUARD. The stored-wake check is for a review with no wake of its OWN, judged on the merged review. Spelled on
  // the patch instead (`!patch.trueWakeAt`), a wake saved in an earlier request would be ignored. A night that
  // did not settle until 05:00: the detector took a 04:30 exit as the wake, the parent corrected the wake to
  // 07:45 first, then the asleep time.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(4, 30, 1)), asleep_minutes: 300 }));
  assert.equal((await put({ true_wake_local: '07:45' })).status, 200);
  const res = await put({ true_onset_local: '05:00' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(reviewRow().true_onset_at, sql(at(5, 0, 1)));
});

test('an in-bed time saved alone beside an asleep time saved in an EARLIER request is judged against that one, not the stored one (fix round 4, M4)', async () => {
  // GUARD, the same for "in bed": stored asleep 19:13, the parent's asleep 19:45 saved first, then in bed 19:30
  // in a second request. Judged on the patch (`!patch.trueOnsetAt`) it met the stored 19:13 and was refused.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(6, 37, 1)), asleep_minutes: 600 }));
  assert.equal((await put({ true_onset_local: '19:45' })).status, 200);
  const res = await put({ true_in_bed_local: '19:30' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(reviewRow().true_in_bed_at, sql(at(19, 30)));
});

test('a picked "Asleep here" FRAME after the stored wake is refused like a typed time (fix round 4, M5)', async () => {
  // GUARD. The stored-wake check keys on the RESOLVED asleep time, which a frame gives without any typed field.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(6, 30, 1)), asleep_minutes: 600 }));
  const frame = layTransition(TRANSITION.INTO_BED, sql(at(6, 45, 1, 10)));
  const res = await put({ true_onset_transition_id: frame });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /"Fell asleep" can't be after the time they got up/);
  assert.equal(reviewRow(), undefined);
});

test('clearing the asleep time as an empty string, or by a frame id alone, is still a clear (fix round 4, M6)', async () => {
  // GUARD. "Cleared" is the resolved asleep time being null, however the request spelled it: an API's '' and a
  // bare `true_onset_transition_id: null` both clear it, and must meet the stored-asleep check like the edit
  // card's null does.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: sql(at(6, 37, 1)), asleep_minutes: 600 }));
  for (const clear of [{ true_onset_local: '' }, { true_onset_transition_id: null }]) {
    db.prepare('DELETE FROM sleep_reviews').run();
    assert.equal((await put({ true_in_bed_local: '19:30', true_onset_local: '19:45' })).status, 200);
    const res = await put(clear);
    assert.equal(res.status, 400, `${JSON.stringify(clear)}: ${JSON.stringify(res.body)}`);
    assert.equal(reviewRow().true_onset_at, sql(at(19, 45)), 'nothing written');
  }
});

test('each stored-night check needs only its OWN stored time: in bed with no stored wake, asleep with no stored asleep time (fix round 4, Codex)', async () => {
  // GUARD. The stored wake is NULL while the departure is still being confirmed; the in-bed check must not wait
  // for it. And the asleep check reads the stored wake alone.
  plantNight(finishedNight({ onset_at: sql(at(19, 13)), wake_at: null, asleep_minutes: 600 }));
  assert.equal((await put({ true_in_bed_local: '19:30' })).status, 400, 'a put-down after the stored asleep time, no stored wake yet');
  db.prepare('DELETE FROM sleep_nights').run();
  plantNight(finishedNight({ onset_at: null, wake_at: sql(at(6, 30, 1)), asleep_minutes: 600 }));
  assert.equal((await put({ true_onset_local: '07:30' })).status, 400, 'asleep after the stored wake, no stored asleep time');
  assert.equal(reviewRow(), undefined);
});

test('an EMPTY array echo is refused too, before anything is written (fix round 4, Codex)', async () => {
  // GUARD. String([]) is '', so a check that let an "empty" value through would pass [], and better-sqlite3
  // would refuse to bind it only in the final upsert: the 500-after-the-verdicts of fix round 3, item C.
  const exit = layTransition(TRANSITION.OUT_OF_BED, sql(at(6, 30, 1)));
  for (const key of ['computed_onset_at', 'computed_wake_at']) {
    const res = await put({ true_wake_local: '06:10', [key]: [], verdicts: { [exit]: 'correct' } });
    assert.equal(res.status, 400, `${key}: ${JSON.stringify(res.body)}`);
    assert.equal(reviewRow(), undefined, 'nothing stored');
    assert.equal(verdictOf(exit), null, 'and the verdict did not land');
  }
});

// ================================ Fix round 5 (2026-10-02) ================================
// Codex's review of fix round 4 traced four mutants it expected to SURVIVE (traced, not run). Each test below
// kills one, and each has a `scripts/mutants.json` entry named "in-bed/lock fix5 ...". All are GUARDs: they pass
// on the round-4 code and exist to pin what it already does.
//
// ⚠️ ONSET_LOOKBEHIND_MS and WAKE_LOOKAHEAD_MS are not exported, so this file does not keep a copy of the 3 h.
// It asks the APP where its own boundaries are: childSamplingActiveNow opens exactly ONSET_LOOKBEHIND_MS before
// the window (frozen clock, one millisecond either side), and isEvidenceFinal flips exactly WAKE_LOOKAHEAD_MS
// after window_end. A span edge that is not where those two flip is not the detector's edge.

// Where the app's own gates flip, for this child and night. `endSql` is the window's end as sleep_nights stores
// it: written out by the caller from the zone's real offset, not derived from the helper under test.
function appBoundaries(span, endSql) {
  const samplingAt = (ms) => {
    // mock.timers replaces the global Date, which the plain `new Date()` inside sleepAnalysis's localDateStr reads.
    mock.timers.enable({ apis: ['Date'], now: ms });
    try { return childSamplingActiveNow(CHILD); } finally { mock.timers.reset(); }
  };
  return {
    samplingOpensExactlyAtFromMs: samplingAt(span.fromMs) && !samplingAt(span.fromMs - 1),
    evidenceFinalExactlyAtToMs: isEvidenceFinal(endSql, span.toMs) && !isEvidenceFinal(endSql, span.toMs - 1),
  };
}

// The echo of `ms` as the page would send it: the UTC timestamp, which is what computeNight stores.
const echoAt = (ms) => sql(new Date(ms));

test('★ the span is the window to the MINUTE: a window at 19:03-09:02 is not rounded to a 5-minute multiple (fix round 5, 1)', () => {
  // GUARD. Codex's mutants A and B: `fromMs` floored to a 5-minute multiple, `toMs` ceiled to one. Every other
  // test in this file uses a window on the hour, where a rounding is invisible. 19:03 less the lookbehind is
  // not on the 5-minute grid, and the floor would open the span minutes early; 09:02 plus the lookahead is not
  // either, and the ceiling would close it minutes late.
  db.prepare("UPDATE children SET sleep_window_start = '19:03', sleep_window_end = '09:02' WHERE id = ?").run(CHILD);
  const span = reportableSpanMs(CHILD, DATE);
  assert.notEqual(new Date(span.fromMs).getUTCMinutes() % 5, 0, 'precondition: the opening is off the 5-minute grid');
  assert.notEqual(new Date(span.toMs).getUTCMinutes() % 5, 0, 'precondition: so is the closing');
  const b = appBoundaries(span, sql(at(9, 2, 1)));
  assert.ok(b.samplingOpensExactlyAtFromMs, 'the span opens at the very millisecond the app starts looking for an asleep time');
  assert.ok(b.evidenceFinalExactlyAtToMs, 'and closes at the very millisecond the app calls the night final');
  assert.ok(span.fromMs < at(19, 3).getTime() && span.toMs > at(9, 2, 1).getTime(), 'around the window, not inside it');
});

test('★ the echo is trusted to the minute at both edges of a window that is not on the hour (fix round 5, 1)', () => {
  // GUARD, same mutants A and B, through the function the route calls. Each edge is placed where the noon rule
  // would answer DIFFERENTLY from the echo (a morning time reads as the morning AFTER, an afternoon time as the
  // night's own date), or an echo taken and an echo refused would look the same.
  // Start edge: a window opening at 03:03 can report from 00:03 on the night's own date (the lookbehind is
  // 3 h); the rule alone would put a 00:0x time on the morning after.
  db.prepare("UPDATE children SET sleep_window_start = '03:03', sleep_window_end = '09:02' WHERE id = ?").run(CHILD);
  let span = reportableSpanMs(CHILD, DATE);
  assert.equal(span.fromMs, at(0, 3).getTime(), 'precondition: the span opens at 00:03');
  assert.equal(localHmToUtcSql(DATE, '00:03', echoAt(at(0, 3).getTime()), span), sql(at(0, 3)), 'the first minute of the span: as shown');
  assert.equal(localHmToUtcSql(DATE, '00:04', echoAt(at(0, 4).getTime()), span), sql(at(0, 4)), 'a minute inside it: as shown');
  assert.equal(localHmToUtcSql(DATE, '00:02', echoAt(at(0, 2).getTime()), span), sql(at(0, 2, 1)), 'a minute before it: the noon rule');
  // End edge: a window closing at 09:02 the morning after can report up to 12:01 then (12:02 is the end of the
  // lookahead itself, half-open).
  db.prepare("UPDATE children SET sleep_window_start = '19:03', sleep_window_end = '09:02' WHERE id = ?").run(CHILD);
  span = reportableSpanMs(CHILD, DATE);
  assert.equal(span.toMs, at(12, 2, 1).getTime(), 'precondition: the span closes at 12:02');
  assert.equal(localHmToUtcSql(DATE, '12:01', echoAt(at(12, 1, 1).getTime()), span), sql(at(12, 1, 1)), 'the last minute of the span: as shown');
  assert.equal(localHmToUtcSql(DATE, '12:02', echoAt(at(12, 2, 1).getTime()), span), sql(at(12, 2)), 'the end of the span itself: the noon rule');
  assert.equal(localHmToUtcSql(DATE, '12:04', echoAt(at(12, 4, 1).getTime()), span), sql(at(12, 4)), 'a little past it: the noon rule');
});

// --- a night that crosses a DST change keeps its real length (fix round 5, 2) --------------------------------

// Melbourne: clocks go BACK on Sunday 2026-04-05 03:00 (AEDT +11 -> AEST +10) and FORWARD on Sunday 2026-10-04
// 02:00 (AEST +10 -> AEDT +11). The night that starts the evening before crosses each. The window's edges are
// written out here from those offsets, not derived from the helpers under test.
const utc = (y, mo, d, h, mi, offsetH) => Date.UTC(y, mo - 1, d, h, mi) - offsetH * 3600000;
const pad2 = (n) => String(n).padStart(2, '0');

function assertDstNight({ night, start, end, endSql, endOffsetH, startOffsetH, hours }) {
  db.prepare("UPDATE children SET sleep_window_start = '19:00', sleep_window_end = '10:30' WHERE id = ?").run(CHILD);
  const span = reportableSpanMs(CHILD, night);
  assert.equal((end - start) / 3600000, hours, 'the fixture: a night whose real length is not its clock length');
  const b = appBoundaries(span, endSql);
  assert.ok(b.evidenceFinalExactlyAtToMs, "the span closes where the app's own lookahead does, not an hour either side");
  assert.ok(b.samplingOpensExactlyAtFromMs, "and opens where the app's own lookbehind does");
  // The last minute inside and the end itself, as the page would show them on the clock AFTER the change.
  const hm = (ms) => {
    const local = new Date(ms + endOffsetH * 3600000);
    return `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  };
  const [h] = hm(span.toMs).split(':').map(Number);
  assert.ok(h >= 12, 'precondition: an afternoon time, where the noon rule answers differently from the echo');
  const inside = span.toMs - 60000;
  const [d0, mo0, y0] = [Number(night.slice(8)), Number(night.slice(5, 7)), Number(night.slice(0, 4))];
  const ruleOf = (hhmm) => sql(new Date(utc(y0, mo0, d0, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), startOffsetH)));
  assert.equal(localHmToUtcSql(night, hm(inside), echoAt(inside), span), echoAt(inside), `just inside (${hm(inside)}): as shown`);
  assert.equal(localHmToUtcSql(night, hm(span.toMs), echoAt(span.toMs), span), ruleOf(hm(span.toMs)), `at the end (${hm(span.toMs)}): the noon rule`);
  assert.equal(localHmToUtcSql(night, hm(span.toMs + 60000), echoAt(span.toMs + 60000), span), ruleOf(hm(span.toMs + 60000)), 'a minute after: the noon rule');
}

test('★ a night that crosses the clocks going BACK is 16.5 real hours, and the echo is trusted exactly to its DST-adjusted end (fix round 5, 2a)', () => {
  // GUARD. Codex's mutant C: `tzOffsetMs(start) - tzOffsetMs(end)` added to `toMs`, which would shift the end of
  // the span by the DST change (an hour LATE here) while the window itself is right. Window 19:00-10:30: starts
  // 19:00 AEDT on 04-04 (08:00Z), ends 10:30 AEST on 04-05 (00:30Z): 16.5 real hours for 15.5 on the clock.
  assertDstNight({
    night: '2026-04-04', start: utc(2026, 4, 4, 19, 0, 11), end: utc(2026, 4, 5, 10, 30, 10),
    endSql: '2026-04-05 00:30:00', startOffsetH: 11, endOffsetH: 10, hours: 16.5,
  });
});

test('★ a night that crosses the clocks going FORWARD is 14.5 real hours, and the echo is trusted exactly to its DST-adjusted end (fix round 5, 2b)', () => {
  // GUARD, the other direction: mutant C shifts the end the opposite way (an hour EARLY) here, so an echo the app
  // can show would be refused. Window 19:00-10:30: starts 19:00 AEST on 10-03 (09:00Z), ends 10:30 AEDT on 10-04
  // (23:30Z): 14.5 real hours for 15.5 on the clock.
  assertDstNight({
    night: '2026-10-03', start: utc(2026, 10, 3, 19, 0, 10), end: utc(2026, 10, 4, 10, 30, 11),
    endSql: '2026-10-03 23:30:00', startOffsetH: 10, endOffsetH: 11, hours: 14.5,
  });
});

// --- a night that crosses New Year (fix round 5, 3) ------------------------------------------------------------

test('★ a wake the detector put on 1 January is saved as shown for the night of 31 December, though its UTC date is in a different year (fix round 5, 3)', async () => {
  // GUARD. Codex's mutant D: a year test on the echo's UTC date appended to the span condition. Melbourne
  // 12:05 on 2027-01-01 is 01:05 UTC on 2027-01-01, a different UTC year from the night's date, 2026-12-31 (the
  // year of the NIGHT's date and the year of the INSTANT are different things, and a span check is about
  // instants). The noon rule alone would put 12:05 on the night's own date, a day early. Window 19:00-10:00, so
  // the lookahead reaches 13:00 on the 1st.
  db.prepare("UPDATE children SET sleep_window_start = '19:00', sleep_window_end = '10:00' WHERE id = ?").run(CHILD);
  const night = '2026-12-31';
  const wake = '2027-01-01 01:05:00'; // 12:05 AEDT (+11) on 2027-01-01
  assert.equal(Date.parse(`${wake.replace(' ', 'T')}Z`), utc(2027, 1, 1, 12, 5, 11), 'precondition: that is 12:05 local');
  assert.ok(utc(2027, 1, 1, 12, 5, 11) < reportableSpanMs(CHILD, night).toMs, 'precondition: inside the span');
  const res = await put({ true_wake_local: '12:05', computed_wake_at: wake }, { date: night });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(reviewRow(night).true_wake_at, wake, 'as shown: 12:05 on 1 January, not a day early');
  // The same night with no echo is the noon rule, so the assertion above is the echo's doing and not a
  // coincidence of the rule.
  db.prepare('DELETE FROM sleep_reviews').run();
  const plain = await put({ true_wake_local: '12:05' }, { date: night });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(reviewRow(night).true_wake_at, '2026-12-31 01:05:00', "the rule alone: 12:05 on the night's own date");
});
