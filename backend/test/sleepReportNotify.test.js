// ROADMAP §1.6: the sleep-report follow-up notification — a follow-up fires once, and only once, when
// a night's wake time was unknown at first notify and a later recompute resolves it.
//
// This needs REAL push delivery mocked (not just DB-state assertions) for two reasons: (1) the whole
// point of the feature is what a parent actually receives — the notification title/body/tag — not just
// an internal flag, and (2) `notifySleepReports`/`notifySleepReportUpdates` are STATICALLY imported by
// sleepAnalysis.js, so `t.mock.module` on sleepReportAlert.js itself cannot intercept them from a test
// that also imports sleepAnalysis.js (sleepInsights.test.js's own "no duplicate notification" test hits
// this exact limitation and only checks a timelapse-call proxy for that reason). push.js's
// `firebase-admin/app`/`firebase-admin/messaging` imports ARE dynamic — only reached inside `initPush()`
// at runtime, not at module load — so mocking THOSE and driving the real `runNightlySleepJob()` end to
// end lets these tests see the actual message reaching the SDK boundary, the same technique
// push.test.js already uses for a different question.
import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

const dataDir = useTempDataDir();

const sendEach = mock.fn(async (messages) => ({
  responses: messages.map(() => ({ success: true })),
  successCount: messages.length,
}));
mock.module('firebase-admin/app', { namedExports: { initializeApp: () => {}, cert: () => ({}) } });
mock.module('firebase-admin/messaging', { namedExports: { getMessaging: () => ({ sendEach }) } });

const { default: db } = await import('../src/db.js');
const { initPush } = await import('../src/lib/push.js');
const { notifySleepReportUpdates } = await import('../src/lib/sleepReportAlert.js');
const { runNightlySleepJob, lastCompletedNightDate, computeAndStoreNight, nightIsLocked } = await import('../src/lib/sleepAnalysis.js');
const { saveNightReview } = await import('../src/lib/sleepReviews.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const KID = 'notify-kid';
const KID2 = 'notify-kid-2';
const CAM = 'notify-cam';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne, July: UTC+10, no DST edge to reason about
const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const NIGHT_DATE = '2026-07-01';

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTransition = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)`
);
// One sample per minute across [19:00, to). Minutes inside an `active` range carry real movement.
function layNight(camId, activeRanges, to) {
  for (let t = at(19, 0); t < to; t = new Date(t.getTime() + 60000)) {
    const moving = activeRanges.some(([a, b]) => t >= a && t < b);
    insertSample.run(camId, sqlTime(t), moving ? 0.4 : 0.0002, moving ? 0.6 : 0.0002);
  }
}

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Notify Kid', 1, '19:00', '07:00')`).run(KID);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Notify Cam', 'rtsp://example/stream', ?, 'notifycam')`).run(CAM, KID);

  // Real push, mocked only at the firebase-admin SDK boundary (see file header).
  fs.writeFileSync(
    path.join(dataDir, 'firebase-service-account.json'),
    JSON.stringify({ project_id: 'test-project', private_key: 'x' })
  );
  fs.writeFileSync(
    path.join(dataDir, 'google-services.json'),
    JSON.stringify({
      client: [{ client_info: { mobilesdk_app_id: 'app-1' }, api_key: [{ current_key: 'key-1' }] }],
      project_info: { project_id: 'test-project', project_number: '123' },
    })
  );
  assert.equal(await initPush(), true, 'precondition: fake Firebase setup must actually initialize');
  makeUser(db, { id: 'u-1', username: 'alice' });
  const sid = makeSession(db, 'u-1');
  db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run('tok-1', 'u-1', sid, 'android');
});

beforeEach(() => {
  db.prepare('DELETE FROM sleep_nights').run();
  db.prepare('DELETE FROM sleep_reviews').run();
  db.prepare('DELETE FROM children WHERE id = ?').run(KID2);
  db.prepare('UPDATE children SET track_sleep = 1 WHERE id = ?').run(KID);
  db.prepare('DELETE FROM activity_samples').run();
  db.prepare('DELETE FROM bed_transitions').run();
  db.prepare("UPDATE settings SET sleep_report_alert_enabled = 1, push_enabled = 1 WHERE id = 'app'").run();
  sendEach.mock.resetCalls();
});

test('a follow-up fires with the corrected wake time, and both messages carry the same tag', async (t) => {
  // The departure itself hasn't started yet at the FIRST tick (2 minutes after window close) — nothing
  // in the data yet suggests the child is up, so wake_at is genuinely null (not merely "unconfirmed"),
  // which is the null->real shape this design targets. A real transition an hour later corroborates it.
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 20, 1, 30)));

  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'the original report must have gone out');
  const first = sendEach.mock.calls[0].arguments[0][0];
  assert.equal(first.notification.title, 'Sleep report — Notify Kid');
  assert.ok(!first.notification.body.includes('up '), 'wake time unknown at first notify — no "up HH:MM" clause yet');

  const nightDate = lastCompletedNightDate(KID);
  const tag = `sleep_report_${KID}_${nightDate}`;
  assert.equal(first.android.notification.tag, tag, 'the ORIGINAL must be tagged too, or a later follow-up has nothing to collapse onto');

  let row = db.prepare('SELECT notified_at, notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.ok(row.notified_at, 'notified_at must be set after the original goes out');
  assert.equal(row.notified_wake_at, null, 'wake was unknown at first notify');

  sendEach.mock.resetCalls();
  t.mock.timers.tick(at(8, 0, 1).getTime() - at(7, 2, 1).getTime());
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'exactly one follow-up');
  const followup = sendEach.mock.calls[0].arguments[0][0];
  assert.equal(followup.notification.title, 'Sleep report updated — Notify Kid');
  assert.ok(followup.notification.body.includes('up 07:20'), 'the corrected wake time must appear');
  assert.equal(followup.android.notification.tag, tag, 'same tag as the original — this is what makes it REPLACE it in the tray');

  row = db.prepare('SELECT wake_at, notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.notified_wake_at, row.wake_at, 'the ledger must match what is actually stored');
});

test('★ no follow-up after a parent said "no one was in the bed" — and it still goes out if they take it back', async (t) => {
  // Plan review R2. The job keeps recomputing a night for ~3h after its window closes, so without its
  // own check a parent could flag the night at 07:30 and be pushed the detector's "up 07:20" at 08:00, for
  // a child they have just said was never there. Same night as the first test above, so the follow-up is
  // known to fire when nothing stops it.
  //
  // Rewritten 2026-09-30 for the lock. This used to assert the stored wake_at DID resolve while the flag
  // stood ("the job kept storing after a flag"). A flagged night is now locked, so the job does not
  // re-store it at all while the flag stands: the stored row stays exactly as the flag found it, which is
  // a stronger reason than the follow-up gate for nothing going out.
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 20, 1, 30)));

  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'the original report went out, wake unknown');
  const nightDate = lastCompletedNightDate(KID);

  saveNightReview(KID, nightDate, { nobodyInBed: true });
  const flagged = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  sendEach.mock.resetCalls();
  t.mock.timers.tick(at(8, 0, 1).getTime() - at(7, 2, 1).getTime());
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 0, 'no "Sleep report updated" for a night the parent said was empty');
  const row = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.deepEqual(row, flagged, 'the flagged night is locked: the job did not re-store it at all');
  assert.equal(row.wake_at, null, 'so its stored wake is still the unknown the flag found');
  assert.equal(row.notified_wake_at, null, 'nothing was sent, so nothing is recorded as told');

  // Taken back inside the evidence window: the lock lifts, the job owes the night the pass it skipped,
  // and the detector's night is what the app shows again, so its resolved wake time is worth sending.
  saveNightReview(KID, nightDate, { nobodyInBed: false });
  t.mock.timers.tick(30 * 60 * 1000);
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'the follow-up goes out once the flag is withdrawn');
  assert.equal(sendEach.mock.calls[0].arguments[0][0].notification.title, 'Sleep report updated — Notify Kid');
  assert.ok(db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate).wake_at,
    'and the un-locked night was re-stored with its wake');
});

// The widened follow-up gate (2026-09-30): ANY correction, not only "no one was in the bed", stops the
// detector's wake being pushed over the parent's own answer. Most corrected nights never reach the gate
// (the lock skips a corrected SCORED row before computing), so this takes the one path that does: the
// first pass is `no_data` (the samples have not arrived yet), which the lock deliberately does NOT freeze,
// and the parent corrects the wake before the night first scores.
// Shared fixture for the gate test and its control, so the control proves the gate test's night really
// does reach a follow-up when nothing stops it.
function noDataThenScored(t) {
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob(); // nothing recorded yet: no_data, first report goes out
  assert.equal(sendEach.mock.callCount(), 1, 'precondition: the original (no data) report went out');
  const nightDate = lastCompletedNightDate(KID);
  const first = db.prepare('SELECT status, notified_at, notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(first.status, 'no_data', 'precondition: the first pass had nothing to score');
  assert.ok(first.notified_at && first.notified_wake_at === null, 'precondition: notified, wake unknown');
  // The night's samples arrive late (the same occupied night as the first test above).
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 20, 1, 30)));
  return nightDate;
}

test('★ no follow-up after a parent corrected the wake time — the gate covers every correction, not only the flag', async (t) => {
  const nightDate = noDataThenScored(t);
  saveNightReview(KID, nightDate, { trueWakeAt: sqlTime(at(7, 25, 1)) });
  sendEach.mock.resetCalls();
  t.mock.timers.tick(at(8, 0, 1).getTime() - at(7, 2, 1).getTime());
  runNightlySleepJob();
  const row = db.prepare('SELECT status, wake_at, notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.status, 'ok', 'precondition: the no_data row was NOT frozen by the correction — it scored');
  assert.ok(row.wake_at, 'precondition: the detector wake resolved, so only the gate can hold the follow-up back');
  assert.equal(sendEach.mock.callCount(), 0, 'the parent typed the wake; the detector\'s is not pushed over it');
  assert.equal(row.notified_wake_at, null, 'nothing was sent, so nothing is recorded as told');
});

test('...and the same night with NO correction does get its follow-up (the control for the test above)', async (t) => {
  const nightDate = noDataThenScored(t);
  sendEach.mock.resetCalls();
  t.mock.timers.tick(at(8, 0, 1).getTime() - at(7, 2, 1).getTime());
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'without a correction the follow-up fires');
  assert.equal(sendEach.mock.calls[0].arguments[0][0].notification.title, 'Sleep report updated — Notify Kid');
  assert.ok(db.prepare('SELECT notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate).notified_wake_at);
});

test('★ a note saved from the review\'s EDIT CARD locks the night and stops the follow-up (owner decision D2)', async (t) => {
  // The edit card always sends the asleep and wake times it shows (the detector's own, untouched) with
  // whatever else is saved, so a parent who opens "Not quite…" and adds only a note has confirmed those
  // times, and the night locks. Decided on purpose (2026-09-30): the screen is not changed. This is the
  // exact body NightReview.jsx's save() sends for that, through the real route; the bare `{ note }` in
  // review-in-bed-and-lock.test.js is API-only and no screen sends it. Same night as the first test above,
  // so the follow-up is known to fire at 08:00 when nothing stops it.
  const token = signToken({ sub: 'u-1', sid: makeSession(db, 'u-1'), role: 'admin', username: 'alice' });
  const server = await mountRouter('/api/children', childrenRouter);
  t.after(() => server.close());
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 20, 1, 30)));
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'precondition: the original report went out, wake unknown');
  const nightDate = lastCompletedNightDate(KID);
  const url = `${server.url}/api/children/${KID}/review/${nightDate}`;

  t.mock.timers.tick(3 * 60 * 1000); // 07:05: the parent opens the review
  const shown = (await call(url, { token })).body.computed;
  assert.ok(shown.onset_at, 'precondition: the detector has an asleep time for the card to show');
  // NightReview's toLocalHhmm: the shown instant as wall-clock HH:MM in the app's zone, '' when unknown.
  const hhmm = (utc) => (utc
    ? new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .format(new Date(`${utc.replace(' ', 'T')}Z`))
    : '');
  // save(true) after "Not quite…" and a note, nothing else touched: the shown times as typed (an empty one
  // as null), no frame named, In bed untouched and so not sent at all, the echo, and empty answer maps.
  const res = await call(url, {
    method: 'PUT',
    token,
    body: {
      true_onset_local: hhmm(shown.onset_at) || null,
      true_wake_local: hhmm(shown.wake_at) || null,
      true_onset_transition_id: null,
      true_wake_transition_id: null,
      note: 'a cold, slept badly',
      computed_onset_at: shown.onset_at ?? null,
      computed_wake_at: shown.wake_at ?? null,
      verdicts: {},
      reasons: {},
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(nightIsLocked(KID, nightDate), true, 'a note saved from the edit card locks the night');
  const locked = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);

  sendEach.mock.resetCalls();
  t.mock.timers.tick(at(8, 0, 1).getTime() - at(7, 5, 1).getTime());
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 0, 'no "Sleep report updated" over the times the parent confirmed');
  assert.deepEqual(db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate), locked,
    'and the job left the locked night alone');
});

// --- no "Sleep report updated" hours late (fix round 2, 2026-09-30, Opus #3, verified) -------------------
//
// The follow-up had no time limit of its own: it relied on the job never recomputing a night past its
// evidence horizon (window end + 3h). Un-locking breaks that on purpose (plan review R7: removing the last
// correction lets the job store the night once more, even hours later), and that owed pass then pushed
// "Sleep report updated" as if it were news. Window 19:00-07:00 Melbourne, so the horizon is 10:00.

test('★ a correction removed after the 3-hour window lets the owed pass store the night, but sends no "updated" push', async (t) => {
  // The reviewer's trigger exactly: first report with the wake unknown, corrected at 07:10, correction
  // removed at 13:00, job at 13:30.
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 20, 1, 30)));
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'precondition: the original report went out');
  const nightDate = lastCompletedNightDate(KID);
  const row = () => db.prepare('SELECT wake_at, computed_at, notified_at, notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row().notified_wake_at, null, 'precondition: wake unknown at first notify');

  t.mock.timers.tick(at(7, 10, 1).getTime() - at(7, 2, 1).getTime());
  saveNightReview(KID, nightDate, { trueOnsetAt: sqlTime(at(19, 12)) }); // 07:10: stored once more, then locked
  sendEach.mock.resetCalls();
  t.mock.timers.tick(at(13, 0, 1).getTime() - at(7, 10, 1).getTime());
  runNightlySleepJob(); // 13:00, locked: nothing
  saveNightReview(KID, nightDate, { trueOnsetAt: null }); // the only correction, removed
  t.mock.timers.tick(30 * 60 * 1000);
  runNightlySleepJob(); // 13:30: the pass the lock skipped

  assert.equal(row().computed_at, sqlTime(at(13, 30, 1)), 'precondition: the owed pass ran (R7 un-lock is untouched)');
  assert.ok(row().wake_at, 'precondition: and resolved the wake, so only a freshness gate can hold the push back');
  assert.equal(sendEach.mock.callCount(), 0, 'no "Sleep report updated" six and a half hours after the window closed');
  assert.equal(row().notified_wake_at, null, 'nothing was sent, so nothing is recorded as told');
});

// A departure that can only be confirmed on the job's FIRST pass past the horizon (the #351 case: exit at
// 09:35, confirmed by about 09:56, horizon 10:00). The first report went out at 07:02 with no wake; the job
// then did not run again until `when` (a container that was down, which is also how a real late pass happens).
function lateDeparture(t, when) {
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(9, 25, 1), at(9, 35, 1)]], at(10, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(9, 35, 1, 30)));
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'precondition: the original report went out');
  sendEach.mock.resetCalls();
  t.mock.timers.tick(when.getTime() - at(7, 2, 1).getTime());
  runNightlySleepJob();
  const nightDate = lastCompletedNightDate(KID);
  const row = db.prepare('SELECT wake_at, notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.wake_at, sqlTime(at(9, 35, 1)), 'precondition: the late pass resolved the 09:35 wake');
  return row;
}

test('the follow-up still goes out up to one job tick past the horizon: that tick is the only one that can see a late departure', async (t) => {
  // 10:30 = window end + 3h + one 30-minute tick. A gate at the bare horizon would lose this push for good.
  const row = lateDeparture(t, at(10, 30, 1));
  assert.equal(sendEach.mock.callCount(), 1, 'the follow-up went out');
  assert.equal(sendEach.mock.calls[0].arguments[0][0].notification.title, 'Sleep report updated — Notify Kid');
  assert.equal(row.notified_wake_at, row.wake_at);
});

test('...and a minute after that it does not: the pass still stores the night, but the news is too old to push', async (t) => {
  const row = lateDeparture(t, at(10, 31, 1));
  assert.equal(sendEach.mock.callCount(), 0, 'no "Sleep report updated" at 10:31');
  assert.equal(row.notified_wake_at, null, 'and nothing recorded as told');
});

test('a night corrected before it was ever stored still gets its first report, and is locked from the next tick', async (t) => {
  // Saving a correction stores the night first only when there is a SCORED row to refresh
  // (storeNightBeforeCorrection); it never creates one. So a parent who reviews a night from the sleep
  // detail page before the job's first pass (the first ~30 minutes after the window closes) changes
  // nothing about that pass: it stores the night, sends the report and makes the timelapse as always.
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(1, 0, 1), at(1, 9, 1)]], at(7, 0, 1));
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 1, 1).getTime() });
  const nightDate = lastCompletedNightDate(KID);
  saveNightReview(KID, nightDate, { trueWakeAt: sqlTime(at(6, 40, 1)) });
  const stored = () => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(stored(), undefined, 'the correction created no row');

  t.mock.timers.tick(4 * 60 * 1000);
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'the first report went out as usual');
  const first = stored();
  assert.equal(first.status, 'ok');

  t.mock.timers.tick(30 * 60 * 1000);
  runNightlySleepJob();
  assert.deepEqual(stored(), first, 'the next tick found it corrected and scored: locked');
  assert.equal(sendEach.mock.callCount(), 1, 'and nothing more was sent');
});

test('the original also carries a tag when it is a single-child report, matching what a later follow-up would use', async (t) => {
  // A night that resolves its wake time on the very FIRST pass never gets a follow-up at all — but the
  // ORIGINAL must still be tagged in that case, since nothing else will ever tag it and a later,
  // unrelated notification for the SAME child (a different night) must not accidentally collapse onto it.
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(1, 0, 1), at(1, 9, 1)]], at(7, 0, 1));
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1);
  const msg = sendEach.mock.calls[0].arguments[0][0];
  const nightDate = lastCompletedNightDate(KID);
  assert.equal(msg.android.notification.tag, `sleep_report_${KID}_${nightDate}`);
});

test('a night that never got its first notification does not get a follow-up', async (t) => {
  // The first compute lands OUTSIDE REPORT_FRESH_MS (2h) after window close — simulates a container that
  // was down across the morning. canNotify is true throughout; the freshness gate alone must suppress it.
  // ⚠️ `at(9, 40, 1)` — day 1, matching every other timestamp below and the window this samples for.
  // Found by adversarial review: `at(9, 40, 0)` here is BEFORE `at(19, 0)` (day 0), so layNight's loop
  // never runs at all — zero samples, a silently vacuous fixture that passed for the wrong reason
  // (no_data's own always-null wake_at, not the freshness gate this test is named for).
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(6, 50, 1), at(7, 15, 1)]], at(9, 40, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 15, 1, 30)));

  t.mock.timers.enable({ apis: ['Date'], now: at(9, 30, 1).getTime() }); // 2h30m after window close
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 0, 'past the freshness window — nothing sent, nothing to correct');
  const nightDate = lastCompletedNightDate(KID);
  let row = db.prepare('SELECT notified_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.notified_at, null);

  // A later tick, still inside the 3h evidence horizon, resolves the wake time for real.
  t.mock.timers.tick(20 * 60 * 1000);
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 0, 'no baseline notification exists to correct — must stay silent');
});

test('the structural cap: a second change after the follow-up does not fire again', async (t) => {
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 20, 1, 30)));

  t.mock.timers.enable({ apis: ['Date'], now: at(7, 2, 1).getTime() });
  runNightlySleepJob(); // original: wake unknown
  sendEach.mock.resetCalls();
  t.mock.timers.tick(at(8, 0, 1).getTime() - at(7, 2, 1).getTime());
  runNightlySleepJob(); // follow-up: resolves to 07:20
  assert.equal(sendEach.mock.callCount(), 1, 'sanity: the follow-up fired');

  sendEach.mock.resetCalls();
  // A further transition arrives; the departure scan could in principle pick a different candidate on a
  // later tick. Whether or not the stored wake_at itself moves, no THIRD notification may ever fire for
  // this night — notified_wake_at is already non-null, which is the whole of the cap.
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 25, 1)));
  t.mock.timers.tick(60 * 60 * 1000);
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 0, 'the one-shot budget is spent — no second follow-up, ever, for this night');
});

test('canNotify requires an actually-configured channel, not just the toggle', async (t) => {
  // sleep_report_alert_enabled on, but no provider actually configured (push off, nothing else on).
  db.prepare("UPDATE settings SET push_enabled = 0 WHERE id = 'app'").run();
  t.after(() => db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run());

  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(1, 0, 1), at(1, 9, 1)]], at(7, 0, 1));
  let mockedNow = at(7, 5, 1).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: mockedNow });
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 0, 'no channel configured — nothing can have been sent');
  const nightDate = lastCompletedNightDate(KID);
  let row = db.prepare('SELECT notified_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.notified_at, null, 'must not be stamped "notified" when nothing was actually deliverable');

  // Push gets configured later, on a LATER tick for the SAME night. The row already exists (computed
  // regardless of canNotify), so `!existing` is now false — and notified_at is still null, so the
  // follow-up branch's `existing.notified_at != null` also fails. This specific night is therefore
  // permanently unnotifiable — the documented "no baseline to correct" limit applies here too, not just
  // to the freshness-window case. Confirmed here rather than left as an unverified claim.
  db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run();
  t.mock.timers.tick(30 * 60 * 1000);
  mockedNow += 30 * 60 * 1000;
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 0, 'this exact night stays silent forever — it was never actually reported');

  // But a DIFFERENT night, whose window closes AFTER push was configured, must notify completely
  // normally — proves the gap is specific to nights already computed before configuration, not a
  // lingering effect on the child or camera in general.
  db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(KID);
  db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(CAM);
  layNight(CAM, [[at(19, 0, 1), at(19, 10, 1)], [at(23, 0, 1), at(23, 6, 1)], [at(1, 0, 2), at(1, 9, 2)]], at(7, 0, 2));
  const target = at(7, 5, 2).getTime();
  t.mock.timers.tick(target - mockedNow);
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'a night computed after configuration must notify normally');
});

test('canNotify also gates the FOLLOW-UP branch specifically, not just the first-notify one', async (t) => {
  // Distinct from the test above: this night's ORIGINAL notification DID go out while push was
  // configured — canNotify going false only spans the tick where the wake time would otherwise resolve.
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(7, 10, 1), at(7, 20, 1)]], at(7, 45, 1));
  insertTransition.run(CAM, 'out_of_bed', 0.4, sqlTime(at(7, 20, 1, 30)));

  let mockedNow = at(7, 2, 1).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: mockedNow });
  runNightlySleepJob(); // original: wake unknown, canNotify true
  assert.equal(sendEach.mock.callCount(), 1, 'sanity: the original went out normally');

  db.prepare("UPDATE settings SET push_enabled = 0 WHERE id = 'app'").run();
  sendEach.mock.resetCalls();
  const tick1 = at(8, 0, 1).getTime() - mockedNow;
  t.mock.timers.tick(tick1);
  mockedNow += tick1;
  runNightlySleepJob(); // wake_at resolves to 07:20, but canNotify is false
  assert.equal(sendEach.mock.callCount(), 0, 'no channel configured — the follow-up must not fire, not even queued');
  const nightDate = lastCompletedNightDate(KID);
  let row = db.prepare('SELECT notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  assert.equal(row.notified_wake_at, null, 'must not be marked as corrected when nothing was actually sent');

  // Unlike the first-notify case, this is RECOVERABLE: the follow-up condition depends only on
  // notified_wake_at still being null, not on row existence, so re-enabling push lets it fire normally.
  db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run();
  t.mock.timers.tick(30 * 60 * 1000);
  runNightlySleepJob();
  assert.equal(sendEach.mock.callCount(), 1, 'once configured again, the follow-up fires normally');
  assert.equal(sendEach.mock.calls[0].arguments[0][0].notification.title, 'Sleep report updated — Notify Kid');
});

test('recordFirstNotified binds from the mocked JS clock, not the real wall clock', async (t) => {
  layNight(CAM, [[at(19, 0), at(19, 10)], [at(23, 0), at(23, 6)], [at(1, 0, 1), at(1, 9, 1)]], at(7, 0, 1));
  const mockedNow = at(7, 5, 1).getTime();
  t.mock.timers.enable({ apis: ['Date'], now: mockedNow });
  runNightlySleepJob();
  const nightDate = lastCompletedNightDate(KID);
  const row = db.prepare('SELECT notified_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, nightDate);
  const expected = new Date(mockedNow).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(row.notified_at, expected, 'notified_at must reflect the MOCKED clock, not real wall time');
});

test('two children in the same tick get one combined, untagged notification', async (t) => {
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Second Kid', 1, '19:00', '07:00')`).run(KID2);
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  runNightlySleepJob(); // both kids compute no_data (no camera for KID2, none laid for KID either)
  assert.equal(sendEach.mock.callCount(), 1, 'one combined call, not two separate ones');
  const msg = sendEach.mock.calls[0].arguments[0][0];
  assert.equal(msg.notification.title, 'Sleep reports ready');
  assert.ok(msg.notification.body.includes('Notify Kid') && msg.notification.body.includes('Second Kid'));
  assert.ok(!('tag' in msg.android.notification), 'a combined multi-child message must not carry a tag key at all, not even undefined');
});

test('reportTag guard: a report missing childId or nightDate never produces a tag', async () => {
  sendEach.mock.resetCalls();
  const fakeSummary = { status: 'ok', wake_at: '2026-07-01 21:15:00', asleep_minutes: 600, wake_count: 1 };
  notifySleepReportUpdates([{ name: 'Ghost Kid', summary: fakeSummary }]); // no childId, no nightDate
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget send actually run
  assert.equal(sendEach.mock.callCount(), 1);
  const msg = sendEach.mock.calls[0].arguments[0][0];
  assert.ok(!('tag' in msg.android.notification), 'an incomplete entry must never produce a tag key at all, not even a broken one containing the literal word "undefined"');
});

test('computeAndStoreNight refuses to blank an already-notified wake time (§1a)', () => {
  // Seed a row exactly as if a follow-up had already told the parent a real wake time.
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, wake_at,
       asleep_minutes, awake_minutes, wake_count, coverage_minutes, computed_at,
       notified_at, notified_wake_at)
     VALUES (?, ?, ?, ?, 'ok', '2026-07-01 21:15:00', 600, 10, 1, 700, '2026-07-01 22:00:00',
             '2026-07-01 21:20:00', '2026-07-01 21:15:00')`
  ).run(KID, NIGHT_DATE, sqlTime(at(19, 0)), sqlTime(at(7, 0, 1)));

  // A fresh computation that legitimately scores 'empty' (SCORED, so the pre-existing status-downgrade
  // guard does NOT catch this — 'empty' passes SCORED same as 'ok') with no wake_at at all — nobody to
  // wake up. Real, reachable shape: e.g. the camera was repositioned and now sees an empty room. Full
  // coverage at near-zero motion throughout, matching sleepInsights.test.js's own "empty" fixture shape
  // — zero samples at all would instead score 'no_data' and hit the OTHER (pre-existing) guard.
  layNight(CAM, [], at(7, 0, 1));
  const result = computeAndStoreNight(KID, NIGHT_DATE, { allowDowngrade: false });
  assert.equal(result.stored, false);
  assert.equal(result.refused, 'would_blank_notified_wake');

  const row = db.prepare('SELECT status, wake_at, notified_wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(KID, NIGHT_DATE);
  assert.equal(row.status, 'ok', 'the row must be left completely untouched, not partially updated');
  assert.equal(row.wake_at, '2026-07-01 21:15:00', 'the already-notified wake time must survive the refused write');
  assert.equal(row.notified_wake_at, '2026-07-01 21:15:00');
});
