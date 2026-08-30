// The morning review — recording what actually happened, from the person who was there.
//
// Why this exists at all: every sleep change so far has been judged against the owner's recollection
// the next morning ("around 6am"). That was fine while errors were measured in hours. It stopped being
// fine when they reached ~10 minutes, because the error became smaller than the measurement — and the
// same handful of nights was used to design a change AND to validate it, so nothing was ever held out.
//
// ⚠️ The subtle part is NOT the form. It is that `computed_*` is captured at the moment of judging.
// A completed night's computed wake genuinely moves through the morning (measured 2026-08-29: 05:51 at
// 08:16 and 08:31 at 09:50 — same night, same data, as ordinary daytime activity accumulates inside the
// analysis lookahead). A ground-truth row storing only the true time would silently re-score itself
// against a different answer later, and "were we right about this night" would change its own mind.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight } = await import('../src/lib/sleepAnalysis.js');
const { pendingReview, getNightReview, saveNightReview } = await import('../src/lib/sleepReviews.js');
const { recordBedTransition, TRANSITION } = await import('../src/lib/bedTransitions.js');
const { lastCompletedNightDate } = await import('../src/lib/sleepAnalysis.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'mr-child';
const CAM = 'mr-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const exactSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

let server;
let token;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);

// A night that scores `ok`: plainly occupied, settling until 19:40, up at 06:00.
function laySamples() {
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    const moving = (t >= at(19, 30) && t < at(19, 40)) || (t >= at(6, 0, 1) && t < at(6, 20, 1));
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
}

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Review Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- what the review stores ---------------------------------------------------------------------

test("the app's answer is frozen at the moment it is judged", () => {
  // THE regression test for this feature. Save a review, then change what the analysis would say, then
  // read the review back: the recorded `computed_*` must still be what was on screen when the person
  // answered. Without this, "we were right about this night" re-decides itself later.
  laySamples();
  const saved = saveNightReview(CHILD, DATE, { trueWakeAt: exactSql(at(6, 0, 1)) });
  assert.ok(saved.computed_onset_at, 'the app had an answer, and it was recorded');
  const judged = { onset: saved.computed_onset_at, wake: saved.computed_wake_at };

  // The night now looks entirely different — as it genuinely does when morning activity accumulates.
  db.prepare('DELETE FROM activity_samples').run();
  for (let t = at(18, 20); t < at(10, 0, 1); t = new Date(t.getTime() + 60000)) {
    insertSample.run(CAM, sqlTime(t), 0.4, 0.4);
  }

  const reread = getNightReview(CHILD, DATE);
  assert.notEqual(reread.computed.onset_at, judged.onset, 'the LIVE answer really has moved');
  assert.equal(reread.review.computed_onset_at, judged.onset, 'but the judged answer must not');
  assert.equal(reread.review.computed_wake_at, judged.wake);
  assert.equal(reread.review.true_wake_at, exactSql(at(6, 0, 1)), 'nor the truth');
});

test('a second review of the same night replaces the first rather than duplicating it', () => {
  laySamples();
  saveNightReview(CHILD, DATE, { trueWakeAt: exactSql(at(6, 0, 1)), note: 'first' });
  saveNightReview(CHILD, DATE, { trueWakeAt: exactSql(at(5, 45, 1)), note: 'corrected' });
  const rows = db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ?').all(CHILD);
  assert.equal(rows.length, 1, 'one row per child-night');
  assert.equal(rows[0].note, 'corrected');
  assert.equal(rows[0].true_wake_at, exactSql(at(5, 45, 1)));
});

test('a review can record the truth even when the app had no opinion', () => {
  // No samples at all, so the night is no_data. The person still knows what happened, and that is
  // exactly the night worth capturing — "we saw nothing; they slept 19:40 to 06:10" is the most
  // damning record available, and must not be refused for lack of a computed value to compare against.
  const saved = saveNightReview(CHILD, DATE, {
    trueOnsetAt: exactSql(at(19, 40)), trueWakeAt: exactSql(at(6, 10, 1)),
  });
  assert.equal(saved.computed_onset_at, null);
  assert.equal(saved.true_onset_at, exactSql(at(19, 40)));
});

// --- the card on the child's page ---------------------------------------------------------------

// The card asks about recent nights, so these fixtures store a row against the night the backlog
// actually covers rather than the fixed DATE the analysis tests use. Storing the row directly is the
// point: `pendingReview` reads the SAVED summary — the same thing the card shows — and must not depend
// on recomputing anything.
function storeNight(nightDate, status = 'ok') {
  db.prepare(
    `INSERT INTO sleep_nights
       (child_id, night_date, window_start, window_end, status, onset_at, wake_at, asleep_minutes)
     VALUES (?, ?, ?, ?, ?, '2026-08-29 09:33:00', '2026-08-29 19:48:00', 615)`
  ).run(CHILD, nightDate, `${nightDate} 09:30:00`, `${nightDate} 21:00:00`, status);
}

test('a scored, unreviewed night is offered for review', () => {
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.4);
  const p = pendingReview(CHILD);
  assert.ok(p, 'there is a night to review');
  assert.equal(p.night_date, night);
});

test('a night from a few days ago is still offered — a morning you did not look is not lost', () => {
  // Anchoring on "yesterday" alone would drop it silently, and the nights worth asking about are
  // exactly the ones from the days you were too busy to open the app.
  const anchor = lastCompletedNightDate(CHILD);
  const [y, m, d] = anchor.split('-').map(Number);
  const threeNightsAgo = new Date(Date.UTC(y, m - 1, d - 3)).toISOString().slice(0, 10);
  storeNight(threeNightsAgo);
  assert.equal(pendingReview(CHILD)?.night_date, threeNightsAgo);
});

test('a night older than the backlog is left alone', () => {
  // Past a week, recollection is no better than the detector's own guess — and a bad ground-truth row
  // is worse than none, because everything else gets scored against it.
  const anchor = lastCompletedNightDate(CHILD);
  const [y, m, d] = anchor.split('-').map(Number);
  const longAgo = new Date(Date.UTC(y, m - 1, d - 30)).toISOString().slice(0, 10);
  storeNight(longAgo);
  assert.equal(pendingReview(CHILD), null);
});

test('the most recent unreviewed night is the one offered', () => {
  const anchor = lastCompletedNightDate(CHILD);
  const [y, m, d] = anchor.split('-').map(Number);
  const older = new Date(Date.UTC(y, m - 1, d - 4)).toISOString().slice(0, 10);
  storeNight(older);
  storeNight(anchor);
  assert.equal(pendingReview(CHILD).night_date, anchor);
});

test('answering it stops the card coming back', () => {
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  assert.ok(pendingReview(CHILD));
  saveNightReview(CHILD, night, { trueWakeAt: exactSql(at(6, 0, 1)) });
  assert.equal(pendingReview(CHILD), null);
});

test('dismissing it also stops the card coming back', () => {
  // Dismissal has to be as final as answering. A card that reappears after being dismissed teaches the
  // habit of ignoring it, and then the nights that DO matter get ignored too.
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  saveNightReview(CHILD, night, { dismissed: true });
  assert.equal(pendingReview(CHILD), null);
});

test('a night with nothing to confirm is never offered', () => {
  // no_data and empty carry no times to be right or wrong about.
  for (const status of ['no_data', 'empty']) {
    db.prepare('DELETE FROM sleep_nights').run();
    storeNight(lastCompletedNightDate(CHILD), status);
    assert.equal(pendingReview(CHILD), null, `${status} must not be offered`);
  }
});

test('a child who is not sleep-tracked is never asked about', () => {
  storeNight(lastCompletedNightDate(CHILD));
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  assert.equal(pendingReview(CHILD), null);
});

// --- verdicts on individual transitions ----------------------------------------------------------

test('a judged transition survives the prune that removes its unjudged neighbours', () => {
  // The whole point of collecting labels: an unreviewed guess is disposable, a labelled frame is the
  // scarce thing. If the 45-day sweep took both, a month of careful reviewing would quietly evaporate.
  const judged = recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.4);
  const unjudged = recordBedTransition(CAM, TRANSITION.INTO_BED, 0.4);
  db.prepare("UPDATE bed_transitions SET created_at = datetime('now','-90 days')").run();
  db.prepare("UPDATE bed_transitions SET verdict = 'correct' WHERE id = ?").run(judged);

  recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.4); // any insert sweeps

  assert.ok(db.prepare('SELECT 1 FROM bed_transitions WHERE id = ?').get(judged), 'judged one kept');
  assert.equal(db.prepare('SELECT 1 FROM bed_transitions WHERE id = ?').get(unjudged), undefined, 'unjudged one swept');
});

test('the review lists the night’s transitions, each with its verdict and camera', () => {
  const id = recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.4);
  db.prepare('UPDATE bed_transitions SET created_at = ?, verdict = ? WHERE id = ?')
    .run(exactSql(at(6, 0, 1)), 'wrong', id);
  const r = getNightReview(CHILD, DATE);
  assert.equal(r.transitions.length, 1);
  assert.equal(r.transitions[0].verdict, 'wrong');
  assert.equal(r.transitions[0].camera_name, 'Bed cam');
});

// --- over HTTP ------------------------------------------------------------------------------------

test('PUT stores the times and applies the verdicts together', async () => {
  laySamples();
  const id = recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.4);
  db.prepare('UPDATE bed_transitions SET created_at = ? WHERE id = ?').run(exactSql(at(6, 0, 1)), id);

  const res = await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, {
    method: 'PUT',
    token,
    body: { true_wake_local: '06:00', verdicts: { [id]: 'wrong' } },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.verdicts_applied, 1);
  assert.equal(res.body.review.true_wake_at, exactSql(at(6, 0, 1)), 'resolved in the app timezone');
  assert.equal(db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(id).verdict, 'wrong');
});

test('a bad verdict is refused as a batch, leaving nothing half-saved', async () => {
  // A partially-applied review is worse than a refused one: the person cannot tell which of their
  // answers landed, and these are the labels everything else gets measured against.
  laySamples();
  const good = recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.4);
  const res = await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, {
    method: 'PUT',
    token,
    body: { verdicts: { [good]: 'correct', 99: 'definitely-maybe' } },
  });
  assert.equal(res.status, 400, 'a 4xx — Cloudflare strips 5xx bodies and the reason would be lost');
  assert.equal(db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(good).verdict, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_reviews').get().c, 0, 'and nothing was stored');
});

test('a malformed time is refused rather than stored as garbage', async () => {
  // A garbled entry must not be quietly filed as "nothing recorded" — that would lose ground truth
  // while looking like a clean save.
  for (const bad of ['6am', '25:00', '6:0', '2026-07-02 06:00', 'yesterday']) {
    const res = await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, {
      method: 'PUT',
      token,
      body: { true_wake_local: bad },
    });
    assert.equal(res.status, 400, `${bad} must be refused`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_reviews').get().c, 0, 'and nothing was stored');
});

test('a wall-clock time is resolved against the app timezone, on the right side of midnight', async () => {
  // The night spans midnight: an evening hour belongs to the night's own date, a morning hour to the
  // day after. Melbourne is UTC+10 in July, so 19:33 local is 09:33 UTC on the night's date and 05:48
  // local is 19:48 UTC on that SAME date — the morning after, in local terms.
  const res = await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, {
    method: 'PUT',
    token,
    body: { true_onset_local: '19:33', true_wake_local: '05:48' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.review.true_onset_at, '2026-07-01 09:33:00');
  assert.equal(res.body.review.true_wake_at, '2026-07-01 19:48:00');
});

test('a bad date is refused, and an unknown child 404s', async () => {
  for (const bad of ['not-a-date', '2026-7-1']) {
    const res = await call(`${server.url}/api/children/${CHILD}/review/${bad}`, { token });
    assert.equal(res.status, 400, `${bad} must be refused`);
  }
  const res = await call(`${server.url}/api/children/nobody/review/${DATE}`, { token });
  assert.equal(res.status, 404);
});

test('"nothing to review" is a 200, not a 404', async () => {
  // It is polled every time a child's page opens. A 404 for the ordinary case would light up the
  // browser console every morning and train everyone to ignore the real ones.
  const res = await call(`${server.url}/api/children/${CHILD}/review/pending`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.pending, null);
});
