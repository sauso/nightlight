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
const { pendingReview, getNightReview, saveNightReview, localHmToUtcSql, applyCorrection,
  reviewCardState, transitionInstant } = await import('../src/lib/sleepReviews.js');
const { recordBedTransition, setTransitionVerdict, TRANSITION } = await import('../src/lib/bedTransitions.js');
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

test("the app's answer is frozen as what was ON SCREEN, not recomputed at save time", async () => {
  // THE regression test for this feature, and it must go through the REAL path: GET fills the form,
  // the night drifts while the page is open, PUT saves. An earlier version called computeNight AGAIN
  // at save time and stored that, so a person confirming "yes, 19:40 was right" had the row record the
  // app as having said nothing at all — a confirmation silently becoming a disagreement, in the one
  // table meant to settle such questions. Saving directly through the lib does NOT catch this.
  laySamples();
  const shown = (await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, { token })).body.computed;
  assert.ok(shown.onset_at, 'the app had an answer on screen');

  db.prepare('DELETE FROM activity_samples').run(); // the night moves while the page is open

  const res = await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, {
    method: 'PUT',
    token,
    body: {
      true_onset_local: '19:40',
      computed_onset_at: shown.onset_at,
      computed_wake_at: shown.wake_at,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.review.computed_onset_at, shown.onset_at, 'what was judged, not what is true now');
});

test('a completed review is not blanked by a later partial save', async () => {
  // The two-phones case this app is built for: a stale card on a second device sends {dismissed:true}
  // after a parent has carefully filled the form on the first. Only supplied fields may be written.
  laySamples();
  await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, {
    method: 'PUT', token, body: { true_onset_local: '19:40', true_wake_local: '06:00', note: 'kept' },
  });
  await call(`${server.url}/api/children/${CHILD}/review/${DATE}`, {
    method: 'PUT', token, body: { dismissed: true },
  });
  const row = db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ?').get(CHILD);
  assert.equal(row.note, 'kept', 'the note survives');
  assert.ok(row.true_onset_at, 'and so do the times');
  assert.equal(row.dismissed, 1, 'and the dismissal is actually recorded, not merely implied');
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
  assert.equal(saved.computed_onset_at, null, 'the app had nothing to say, and that is recorded');
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

test('the card only ever asks about LAST night, never an older one', () => {
  // An earlier version offered the most recent UNREVIEWED night within a week. Every answer or
  // dismissal then made the card jump further back, so it walked away through the week while the night
  // you actually wanted was no longer on offer — "the card I originally selected for 5.49 is now
  // gone". Older nights are reached from the sleep detail page instead, which can reach any of them.
  const anchor = lastCompletedNightDate(CHILD);
  const [y, m, d] = anchor.split('-').map(Number);
  const threeNightsAgo = new Date(Date.UTC(y, m - 1, d - 3)).toISOString().slice(0, 10);

  storeNight(threeNightsAgo);
  assert.equal(pendingReview(CHILD), null, 'an older unreviewed night is NOT offered');

  storeNight(anchor);
  assert.equal(pendingReview(CHILD).night_date, anchor, 'last night is');
});

test('answering last night does not make the card jump to an older one', () => {
  const anchor = lastCompletedNightDate(CHILD);
  const [y, m, d] = anchor.split('-').map(Number);
  storeNight(new Date(Date.UTC(y, m - 1, d - 2)).toISOString().slice(0, 10));
  storeNight(anchor);

  saveNightReview(CHILD, anchor, { trueWakeAt: exactSql(at(5, 29, 1)) });

  assert.equal(pendingReview(CHILD), null, 'nothing left to ask about');
  assert.equal(reviewCardState(CHILD).state, 'done', 'it shows the receipt for last night instead');
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
  assert.equal(res.body.state, 'none');
});

// --- the boundaries the rules are stated in terms of -----------------------------------------------

test('the review window follows the app timezone, not a hard-coded one', () => {
  // An earlier version anchored the window on a literal 04:00 UTC — midday only in Melbourne.
  // settings.timezone defaults to 'UTC', so on a default install that window ended before dawn and
  // EVERY morning transition was silently missing from the review: the exact events this screen exists
  // to collect, absent, with the screen looking like it was working on a quiet night.
  for (const [tz, offsetH] of [['Australia/Melbourne', 10], ['UTC', 0], ['America/New_York', -4]]) {
    db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(tz);
    db.prepare('DELETE FROM bed_transitions').run();
    // A bedtime at 19:00 and a morning wake at 06:00, as they would be stored for a night of DATE in tz.
    const utcFor = (localH, dayShift) =>
      new Date(Date.UTC(2026, 6, 1 + dayShift, localH - offsetH, 0)).toISOString().slice(0, 19).replace('T', ' ');
    // Inserted directly, NOT via recordBedTransition: every insert sweeps rows older than 45 days, and
    // this fixture's night is months in the past, so the second call would prune the first row and the
    // test would "fail" for a reason that has nothing to do with timezones.
    //
    // Three events, and the third pins the START of the window as the other two pin the end: 08:00 on
    // the night's own date is the PREVIOUS night's morning, and must not appear. Without it, a window
    // whose start was hard-coded early still passed — it only over-collected, which is invisible when
    // every fixture event belongs to the night being asked about.
    const events = [
      [TRANSITION.OUT_OF_BED, utcFor(8, 0), false],  // yesterday morning — before this night begins
      [TRANSITION.INTO_BED, utcFor(19, 0), true],    // bedtime
      [TRANSITION.OUT_OF_BED, utcFor(6, 1), true],   // this morning's wake
    ];
    for (const [type, when] of events) {
      db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
        .run(CAM, type, when);
    }
    const shown = getNightReview(CHILD, DATE).transitions.map((t) => t.created_at);
    for (const [, when, expected] of events) {
      assert.equal(shown.includes(when), expected,
        `${tz}: ${when} should ${expected ? '' : 'NOT '}be in the review`);
    }
  }
  db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(TZ);
});

test('noon decides which calendar day a bare time belongs to', () => {
  // The night spans midnight, so 'HH:MM' alone is ambiguous. The rule is "at or after noon belongs to
  // the night's own date" — pinned ON the boundary, not comfortably either side of it. Melbourne is
  // UTC+10 in July.
  assert.equal(localHmToUtcSql(DATE, '12:00'), '2026-07-01 02:00:00', 'noon is the night itself');
  assert.equal(localHmToUtcSql(DATE, '11:59'), '2026-07-02 01:59:00', 'a minute earlier is the morning after');
  assert.equal(localHmToUtcSql(DATE, '00:00'), '2026-07-01 14:00:00', 'midnight is the morning after');
  assert.equal(localHmToUtcSql(DATE, '23:59'), '2026-07-01 13:59:00', 'just before midnight is the night itself');
});

// --- verdicts belong to a night, and to a child ----------------------------------------------------

test('a verdict cannot be stamped on another child event, or another night', async () => {
  // setTransitionVerdict updates by primary key alone, so the SCOPING is the protection. Without it any
  // authenticated caller could label another child's event from another month — and because a verdict
  // exempts a row from the 45-day prune, could pin arbitrary rows and their JPEGs on disk forever.
  db.prepare("INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)"
    + " VALUES ('other-kid', 'Other', 1, '19:30', '07:00')").run();
  db.prepare("INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)"
    + " VALUES ('other-cam', 'Other Cam', 'rtsp://x', 'other-kid', 'other-p', 0, 0)").run();
  const foreign = recordBedTransition('other-cam', TRANSITION.OUT_OF_BED, 0.4);
  db.prepare("UPDATE bed_transitions SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(foreign);

  const res = await call(server.url + '/api/children/' + CHILD + '/review/' + DATE, {
    method: 'PUT', token, body: { verdicts: { [foreign]: 'wrong' } },
  });

  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(foreign).verdict, null);
});

test('the lib refuses an invalid verdict on its own, not only via the route', () => {
  // Two layers, because these labels are what everything else gets measured against and the lib is
  // reachable from anywhere in the backend.
  const id = recordBedTransition(CAM, TRANSITION.OUT_OF_BED, 0.4);
  assert.equal(setTransitionVerdict(id, 'definitely-maybe'), false);
  assert.equal(setTransitionVerdict(id, 'correct'), true);
  assert.equal(setTransitionVerdict(id, null), true, 'and a verdict can be cleared again');
  assert.equal(db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(id).verdict, null);
});

// --- input that should be a 4xx, never a 5xx --------------------------------------------------------

test('junk in a field is refused, not turned into a 500 with the body stripped', async () => {
  // Cloudflare strips 5xx bodies, so an unbindable value reaching SQLite means the user sees nothing at
  // all. Every one of these has to be a readable 4xx.
  const cases = [
    { note: { a: 1 } },
    { note: 12345 },
    { computed_onset_at: 'yesterday' },
    { computed_wake_at: '2026-07-02T06:00:00Z' },
  ];
  for (const body of cases) {
    const res = await call(server.url + '/api/children/' + CHILD + '/review/' + DATE, { method: 'PUT', token, body });
    assert.equal(res.status, 400, JSON.stringify(body) + ' must be a 4xx');
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_reviews').get().c, 0, 'and nothing was stored');
});

test('a bad date is refused on the PUT as well as the GET', async () => {
  // Without this the string becomes a night_date primary key and files ground truth under nonsense.
  const res = await call(server.url + '/api/children/' + CHILD + '/review/not-a-date', {
    method: 'PUT', token, body: { true_wake_local: '06:00' },
  });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_reviews').get().c, 0);
});

// --- a correction is what gets SHOWN -----------------------------------------------------------------

test('a corrected night displays the corrected times, not the detector\'s', async () => {
  // The owner's first real use: they told the app when their child got up, the card kept showing the
  // old time, and they said "this is actually worse". Correcting a night and seeing nothing change
  // reads as the app having ignored you — and the corrected time IS the best information available.
  laySamples();
  computeAndStoreNight(CHILD, DATE);
  const before = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ?').get(CHILD);

  await call(server.url + '/api/children/' + CHILD + '/review/' + DATE, {
    method: 'PUT', token, body: { true_wake_local: '05:29' },
  });

  const res = await call(server.url + '/api/children/' + CHILD + '/sleep?nights=1', { token });
  const shown = res.body.nights[0];
  assert.equal(shown.wake_at, '2026-07-01 19:29:00', 'the card shows what the person said');
  assert.equal(shown.corrected, true, 'and says so');
  assert.equal(shown.algo_wake_at, before.wake_at, 'the detector\'s own answer is kept alongside');
  assert.equal(
    db.prepare('SELECT wake_at FROM sleep_nights WHERE child_id = ?').get(CHILD).wake_at, before.wake_at,
    'the stored row is NOT overwritten — it is still what a future change gets scored against'
  );
});

test('asleep minutes are re-derived so the card cannot contradict itself', () => {
  // "Up at 05:29" above "slept 10h 15m" is visibly wrong to anyone reading it.
  const night = {
    night_date: DATE, onset_at: exactSql(at(19, 30)), wake_at: exactSql(at(7, 0, 1)),
    asleep_minutes: 690, awake_minutes: 0,
  };
  saveNightReview(CHILD, DATE, { trueWakeAt: exactSql(at(5, 29, 1)) });
  const out = applyCorrection(CHILD, night);
  assert.equal(out.asleep_minutes, 599, '19:30 to 05:29 is 9h59m');
});

test('a night nobody corrected is passed through untouched', () => {
  const night = { night_date: DATE, onset_at: 'x', wake_at: 'y', asleep_minutes: 1 };
  assert.deepEqual(applyCorrection(CHILD, night), night);
});

test('a dismissal is not a correction', () => {
  // Dismissing records "I do not want to answer", which must never become a claim about the night.
  const night = { night_date: DATE, onset_at: 'x', wake_at: 'y', asleep_minutes: 1 };
  saveNightReview(CHILD, DATE, { dismissed: true });
  assert.deepEqual(applyCorrection(CHILD, night), night);
});

// --- the card says what happened to your answer -----------------------------------------------------

test('the card confirms an answered night instead of vanishing', () => {
  // A prompt that simply disappears on save is indistinguishable from one that failed, which is
  // precisely how this first landed: "it then disappeared and the card didn't update".
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  assert.equal(reviewCardState(CHILD).state, 'ask');

  saveNightReview(CHILD, night, { trueWakeAt: exactSql(at(5, 29, 1)) });

  const done = reviewCardState(CHILD);
  assert.equal(done.state, 'done');
  assert.equal(done.night_date, night);
  assert.equal(done.true_wake_at, exactSql(at(5, 29, 1)), 'and shows back what was recorded');
});

test('the response keeps the OLD shape as well as the new one', () => {
  // A running page is a deployed client you cannot update. This response used to be `{ pending }`;
  // adding `state` and dropping `pending` silently blanked the card on every page loaded before the
  // deploy — no error, nothing to click, the feature simply gone. That is exactly what happened, on a
  // phone left open on the child's screen. Add to a response shape; never take away.
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  const asking = reviewCardState(CHILD);
  assert.equal(asking.state, 'ask');
  assert.equal(asking.pending?.night_date, night, 'an older client still finds `pending`');

  saveNightReview(CHILD, night, { trueWakeAt: exactSql(at(5, 29, 1)) });
  const done = reviewCardState(CHILD);
  assert.equal(done.state, 'done');
  assert.equal(done.pending, null, 'and correctly sees nothing to ask about');
});

test('a dismissed night stays quiet — no prompt and no receipt', () => {
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  saveNightReview(CHILD, night, { dismissed: true });
  assert.equal(reviewCardState(CHILD).state, 'none');
});

// --- naming a frame as the moment ------------------------------------------------------------------

// Inserted directly: recordBedTransition sweeps rows older than 45 days on every insert, and this
// fixture's night is months in the past.
function layTransition(type, when) {
  return db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run(CAM, type, when).lastInsertRowid;
}

test('naming a frame records the moment to the SECOND, not to the typed minute', async () => {
  // The whole reason to point at a picture rather than type: the event carries an exact instant, and a
  // person types a rounded recollection. 05:52:37 is what happened; "05:52" is what anyone would type.
  laySamples();
  const id = layTransition(TRANSITION.OUT_OF_BED, '2026-07-01 19:52:37');

  const res = await call(server.url + '/api/children/' + CHILD + '/review/' + DATE, {
    method: 'PUT', token, body: { true_wake_transition_id: id, true_wake_local: '05:52' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.review.true_wake_at, '2026-07-01 19:52:37', 'the frame wins over the typed time');
  assert.equal(res.body.review.true_wake_transition_id, id, 'and WHICH frame is remembered');
});

test('a named frame is what the card then shows', () => {
  // End to end: pointing at a picture has to move the number on the child's page, or it is data entry
  // for its own sake.
  const id = layTransition(TRANSITION.OUT_OF_BED, '2026-07-01 19:52:37');
  saveNightReview(CHILD, DATE, { trueWakeAt: '2026-07-01 19:52:37', trueWakeTransitionId: id });
  const shown = applyCorrection(CHILD, {
    night_date: DATE, onset_at: exactSql(at(19, 30)), wake_at: exactSql(at(7, 0, 1)), asleep_minutes: 690, awake_minutes: 0,
  });
  assert.equal(shown.wake_at, '2026-07-01 19:52:37');
  assert.equal(shown.corrected, true);
});

test('a put-down frame sets the bedtime, not the wake', () => {
  const id = layTransition(TRANSITION.INTO_BED, '2026-07-01 09:31:12');
  const saved = saveNightReview(CHILD, DATE, { trueOnsetAt: '2026-07-01 09:31:12', trueOnsetTransitionId: id });
  assert.equal(saved.true_onset_at, '2026-07-01 09:31:12');
  assert.equal(saved.true_wake_at, null);
});

test('a frame from another night or another child is refused', async () => {
  // Same scoping as verdicts: an unchecked id would let a review claim another child's event as the
  // moment their child woke, in the table everything else gets measured against.
  db.prepare("INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)"
    + " VALUES ('other-kid', 'Other', 1, '19:30', '07:00')").run();
  db.prepare("INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)"
    + " VALUES ('other-cam', 'Other Cam', 'rtsp://x', 'other-kid', 'other-p', 0, 0)").run();
  const foreign = db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run('other-cam', TRANSITION.OUT_OF_BED, '2026-07-01 19:52:37').lastInsertRowid;

  for (const bad of [foreign, 999999, 0, -1, 'abc']) {
    const res = await call(server.url + '/api/children/' + CHILD + '/review/' + DATE, {
      method: 'PUT', token, body: { true_wake_transition_id: bad },
    });
    assert.equal(res.status, 400, bad + ' must be refused');
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_reviews').get().c, 0, 'and nothing was stored');
});

test('transitionInstant tells "no frame named" apart from "not this night\'s frame"', () => {
  // null must not collapse into undefined: one means "they typed a time instead", the other is an
  // error the caller has to reject rather than store as no answer.
  const id = layTransition(TRANSITION.OUT_OF_BED, '2026-07-01 19:52:37');
  assert.equal(transitionInstant(CHILD, DATE, null), null);
  assert.equal(transitionInstant(CHILD, DATE, ''), null);
  assert.equal(transitionInstant(CHILD, DATE, id), '2026-07-01 19:52:37');
  assert.equal(transitionInstant(CHILD, DATE, id + 1000), undefined);
  assert.equal(transitionInstant(CHILD, DATE, 'nonsense'), undefined);
});
