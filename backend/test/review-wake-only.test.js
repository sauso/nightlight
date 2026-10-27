// The one-question morning review (2026-10-27): the screen asks only when the child got up, so a save
// carries a WAKE time and nothing else. Two things need pinning on the server:
//
//   1. A wake-only save is a complete answer. It is stored with no asleep or in-bed time, it locks the
//      night like any other correction, and the night then shows the parent's wake over the detector's
//      stored asleep time. (The old "That's right" always sent the asleep time too; the new one omits
//      it, because an omitted key is "keep what is stored" and a sent one would record the detector's
//      guess as the parent's answer.)
//   2. A wake is judged against the night's STORED asleep time. Before this, a wake saved while the review
//      held no asleep time was compared with nothing (a documented gap), which did not matter while every
//      save also carried an asleep time. Now almost every save is wake-only, so a mistyped "18:37" for
//      "06:37" saved fine and the night then ended before it began, its total floored to 0. Found in the
//      Codex gpt-6-sol plan review of this change; the check is in routes/children.js.
//
// Melbourne is the fixture zone because a real, non-UTC zone is what catches a hard-coded offset; nothing
// in the rule depends on it.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { nightIsLocked } = await import('../src/lib/sleepAnalysis.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'wo-child';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne in July: UTC+10, no DST edge anywhere near

// Local wall-clock time on the night of DATE (dayShift 1 = the morning after) -> Date.
const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, 0) - TZ_OFF);
const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const WINDOW_START = sql(at(19, 0));
const WINDOW_END = sql(at(7, 0, 1));
const ONSET = sql(at(19, 13));
const WAKE = sql(at(6, 37, 1));

let server;
let adminToken;

const put = (body) => call(`${server.url}/api/children/${CHILD}/review/${DATE}`, { method: 'PUT', token: adminToken, body });
const get = (path) => call(`${server.url}/api/children/${CHILD}${path}`, { token: adminToken });
const reviewRow = () => db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);

// A scored, FINISHED and evidence-FINAL row (computed four hours after the window closed): the lock can hold
// on it and storeNightBeforeCorrection leaves it alone. Every column not named gets a recognisable marker.
function plantNight(values) {
  const cols = db.prepare("PRAGMA table_info('sleep_nights')").all();
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
}
const finishedNight = (extra = {}) => ({
  child_id: CHILD, night_date: DATE, status: 'ok', window_start: WINDOW_START, window_end: WINDOW_END,
  computed_at: sql(at(11, 0, 1)), notified_at: null, notified_wake_at: null,
  onset_at: ONSET, wake_at: WAKE, asleep_minutes: 600, ...extra,
});

// Exactly what NightReview.jsx's "That's right" sends since the one-question screen: the wake as shown, the two
// echoes of what was on screen, the settings key as given. NO onset, in-bed, note, frame id, verdict or reason.
const thatsRight = (wakeHm = '06:37') => ({
  true_wake_local: wakeHm, computed_onset_at: ONSET, computed_wake_at: WAKE, settings_key: '',
});

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
              VALUES (?, 'Wake Kid', 1, '19:00', '07:00')`).run(CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('★ a wake-only "That\'s right" is stored as the parent\'s wake alone, locks the night, and shows over the stored asleep time', async () => {
  plantNight(finishedNight());
  const res = await put(thatsRight());
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const row = reviewRow();
  assert.equal(row.true_wake_at, WAKE, 'the wake is the parent\'s answer');
  assert.equal(row.true_onset_at, null, 'no asleep time was sent, so none is recorded as theirs');
  assert.equal(row.true_in_bed_at, null);
  assert.equal(row.note, null);
  assert.equal(row.computed_onset_at, ONSET, 'what the screen showed is recorded beside the answer');
  assert.equal(row.computed_wake_at, WAKE);
  assert.equal(nightIsLocked(CHILD, DATE), true, 'a wake-only answer corrects the night, so it locks like any other correction');

  // The sleep list shows the night with the parent's wake over the detector's stored asleep time.
  const shown = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  assert.equal(shown.corrected, true);
  assert.equal(shown.wake_at, WAKE);
  assert.equal(shown.onset_at, ONSET, 'the stored asleep time is untouched');
});

test('★ a wake typed before the night\'s STORED asleep time is refused with a 400 and nothing is written', async () => {
  plantNight(finishedNight());
  // "18:00" is, by the noon rule, 18:00 the same evening: 73 minutes before the stored 19:13 asleep time.
  const refused = await put({ ...thatsRight('18:00'), note: 'a cold' });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /"Got up for the day" can't be before the time they fell asleep/);
  assert.equal(reviewRow(), undefined, 'nothing stored, the note included');
  assert.equal(nightIsLocked(CHILD, DATE), false, 'a refused save does not lock the night');

  // The same one minute of slack as every ordering rule (a frame keeps its second, a typed time is to the
  // minute): the same minute is fine, a full minute before is not.
  assert.equal((await put(thatsRight('19:12'))).status, 400, 'a full minute before the stored asleep time');
  assert.equal((await put(thatsRight('19:13'))).status, 200, 'the same minute');
});

test('the stored asleep time is only consulted when the review has none of its own', async () => {
  // The review's own asleep time (18:00) is what the wake is judged against, not the stored 19:13: a wake of
  // 18:30 is after the parent's asleep time, so it is fine even though it is before the detector's. Kills a
  // check that compares with the stored time unconditionally.
  plantNight(finishedNight());
  assert.equal((await put({ true_onset_local: '18:00' })).status, 200);
  assert.equal((await put({ true_wake_local: '18:30' })).status, 200);
  assert.equal(reviewRow().true_wake_at, sql(at(18, 30)));
});

test('a save that gives no wake is never refused over a stored asleep time that has since moved', async () => {
  // GUARD, like its siblings in review-in-bed-and-lock.test.js: a stored night can move under an existing
  // review, and a later note or dismissal must not be refused over a contradiction it did not make.
  plantNight(finishedNight());
  assert.equal((await put(thatsRight())).status, 200);
  db.prepare('UPDATE sleep_nights SET onset_at = ? WHERE child_id = ?').run(sql(at(7, 30, 1)), CHILD);
  assert.equal((await put({ note: 'a cold' })).status, 200, 'a note');
  assert.equal((await put({ dismissed: true })).status, 200, 'a dismissal');
});

test('with no stored night, or no stored asleep time, there is nothing to check a wake against', async () => {
  assert.equal((await put(thatsRight('18:00'))).status, 200, 'no stored night at all');
  db.prepare('DELETE FROM sleep_reviews').run();
  plantNight(finishedNight({ onset_at: null }));
  assert.equal((await put(thatsRight('18:00'))).status, 200, 'a stored night with no asleep time');
});

test('★ the comparison allows 60 s of slack and not a second less: a stored asleep time WITH seconds, 30 s and 90 s after the wake', async () => {
  // Every case above is minute-aligned, so a slack of 30 s (or 0) passes them all. A frame keeps its seconds
  // (asleep 19:13:30) while a typed wake is to the minute, so 19:13 is 30 s before: the same breath, accepted.
  // 19:12 is 90 s before: refused. Kills a mutation of ASLEEP_AFTER_WAKE_SLACK_MS in sleepReviews.js.
  plantNight(finishedNight({ onset_at: sql(new Date(at(19, 13).getTime() + 30000)) }));
  const refused = await put(thatsRight('19:12'));
  assert.equal(refused.status, 400, '90 s before the stored asleep time');
  assert.equal(reviewRow(), undefined, 'nothing stored');
  assert.equal((await put(thatsRight('19:13'))).status, 200, '30 s before the stored asleep time');
});
