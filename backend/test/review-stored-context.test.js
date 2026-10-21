// #361 PR 4b: the morning review uses the same settings as the sleep detail page.
//
// Why: after PR 4a the detail page works a FINISHED night out with the camera, timezone and window it was saved with
// (when they differ from today's), but the review page still used today's: its "What we recorded" differed from the
// page, its photo list came from today's cameras and today's timezone's noon to noon, and the save-time check of an
// echoed time (reportableSpanMs) used today's window, which can file a replayed time a day out. Now ONE decision,
// displayContextFor (the detail page's savedSettingsToShow, no rule of its own), feeds all of it:
//   - getNightReview's `computed` (the detail page's numbers) and its additive `settings: { key, tz }`;
//   - transitionsFor: the saved zone's noon to noon, and the saved camera only while it still belongs to THIS child
//     (the ownership boundary: a camera moved to another child, or deleted, contributes nothing);
//   - reportableSpanMs(childId, date, ctx): the span an echoed time is trusted in;
//   - the PUT is bound to the settings the GET used (plan R1): `settings_key` back, 409 `settings_changed` on a
//     mismatch, before anything is written; an absent key (an older open page) is not checked.
// Plan: ~/.claude/plans/ticklish-mixing-moore.md, PART 3 and its revisions R1-R3.
//
// ⚠️ HOSTILE FIXTURES: in every case the saved settings DIFFER from today's in the one setting under test, so code that
// ignores the decision changes the answer; the camera that moved to another child has events inside the night's span;
// the timezone test plants one event that only the saved zone's noon to noon holds and one that only today's does.
// Camera and child names are neutral: the repo is public.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  computeNight, computeAndStoreNight, computeNightForDisplay, displayContextFor, reportableSpanMs, parseScoringContext,
} = await import('../src/lib/sleepAnalysis.js');
const { getNightReview, pendingReview } = await import('../src/lib/sleepReviews.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'rv-child';
const CHILD2 = 'rv-child-2';
const CAM = 'rv-cam-a';
const CAM2 = 'rv-cam-b';
const DATE = '2026-07-01';
// Melbourne in July: UTC+10, no DST edge near the fixture night, so `at()` is plain arithmetic.
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const exactSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const json = (v) => JSON.parse(JSON.stringify(v));
// 12:00 local the day after: past the night's window and its evidence horizon.
const NOON_AFTER = at(12, 0, 1).getTime();
// The `computed` block's keys, as getNightReview returns them.
const COMPUTED_KEYS = ['status', 'onset_at', 'in_bed_at', 'wake_at', 'asleep_minutes', 'wake_count'];
const computedOf = (n) => Object.fromEntries(COMPUTED_KEYS.map((k) => [k, n[k] ?? null]));
// 'HH:MM' on today's clock in Melbourne, as the review page shows a time.
const localHm = (sqlUtc) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
  .format(new Date(`${sqlUtc.replace(' ', 'T')}Z`));

let server;
let adminToken;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
// One sample a minute on `cam` over [from, to): moving (0.4) inside any of the `moving` spans, else still (0.004).
function layMinutes(cam, moving, from, to) {
  for (let t = from; t < to; t = new Date(t.getTime() + 60000)) {
    const m = moving.some(([a, b]) => t >= a && t < b);
    insertSample.run(cam, sqlTime(t), m ? 0.4 : 0.004, m ? 0.4 : 0.004);
  }
}
// Inserted directly (recordBedTransition sweeps rows older than 45 days); returns the row id.
const layTransition = (cam, type, d) => Number(
  db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run(cam, type, exactSql(d)).lastInsertRowid
);
// Night A on `cam`: settles by 19:40, sleeps through, up at 06:00 (the pair from display-stored-context.test.js).
function layA(cam = CAM) {
  layMinutes(cam, [[at(19, 30), at(19, 40)], [at(6, 0, 1), at(7, 0, 1)]], at(18, 20), at(7, 0, 1));
  return layTransition(cam, TRANSITION.OUT_OF_BED, at(6, 2, 1));
}
// Night B on `cam`: settles only after 20:10, one awakening, up at 05:30. Different on every number.
function layB(cam = CAM2) {
  layMinutes(cam, [[at(18, 20), at(20, 10)], [at(1, 0, 1), at(1, 15, 1)], [at(5, 30, 1), at(7, 0, 1)]], at(18, 20), at(7, 0, 1));
  return layTransition(cam, TRANSITION.OUT_OF_BED, at(5, 32, 1));
}

const addCamera = (id, child, sort, name) =>
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, ?, 'rtsp://example/x', ?, ?, ?, 0)`).run(id, name, child, `p-${id}`, sort);
const setTz = (tz) => db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(tz);
const setWindow = (start, end) =>
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, CHILD);
const rowOf = () => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
const reviewRow = () => db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
const verdictOf = (id) => db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(id)?.verdict ?? null;

const reviewUrl = `/api/children/${CHILD}/review/${DATE}`;
const getReview = () => call(`${server.url}${reviewUrl}`, { token: adminToken });
const put = (body) => call(`${server.url}${reviewUrl}`, { method: 'PUT', token: adminToken, body });
const idsOf = (review) => review.transitions.map((t) => t.id).sort((a, b) => a - b);

// Store the night as the nightly job would (today's settings at the time); fails loudly if no context was written.
function storeOriginal() {
  const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(summary.stored, true, 'precondition: the night was stored');
  const raw = rowOf().scoring_context;
  assert.ok(parseScoringContext(raw), `precondition: the stored context parses: ${raw}`);
  return raw;
}

before(async () => {
  const admin = makeUser(db, { id: 'u-rv-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Review Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(CHILD2);
  addCamera(CAM, CHILD, 0, 'Bed cam');
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- (1) what the review says the app recorded -------------------------------------------------------------------

test('computed: a finished night whose window changed is the detail page\'s replay (with settings.key); a plain night is today\'s', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA(CAM);
  const raw = storeOriginal();

  // Plain: today's settings are the saved ones, so the review is the plain compute and says so with an empty key.
  const plainReview = getNightReview(CHILD, DATE);
  assert.deepEqual(plainReview.computed, computedOf(json(computeNight(CHILD, DATE))));
  assert.deepEqual(plainReview.settings, { key: '', tz: TZ });

  setWindow('21:00', '06:00');
  const page = json(computeNightForDisplay(CHILD, DATE, { mode: 'auto' }));
  assert.equal(page.scoring_view?.applied, 'stored', 'precondition: the detail page shows the saved settings');
  const today = computedOf(json(computeNight(CHILD, DATE)));
  const review = getNightReview(CHILD, DATE);
  assert.deepEqual(review.computed, computedOf(page), 'the review starts from the detail page\'s numbers');
  assert.deepEqual(review.computed, computedOf(rowOf()), 'which are the saved row\'s (what the card shows)');
  assert.notDeepEqual(review.computed, today, 'precondition: today\'s window gives other numbers');
  assert.deepEqual(review.settings, { key: raw, tz: TZ }, 'the exact stored string, and the saved zone');
});

// --- (2) the echo span: a replayed time outside TODAY's span is saved as shown ----------------------------------

test('window change: "That\'s right" on a replayed 12:05 wake outside today\'s span stores the exact instant shown', async (t) => {
  // Saved with a window ending 10:00, so the detector can report a wake at 12:05 the morning after (its lookahead is
  // 3 h). Today's window ends 07:00: its span closes at 10:00, so 12:05 is outside it, and the noon rule alone would
  // put a typed "12:05" on the night's OWN date, before the asleep time (a 400 over the app's own times).
  t.mock.timers.enable({ apis: ['Date'], now: at(14, 0, 1).getTime() });
  setWindow('19:30', '10:00');
  layMinutes(CAM, [[at(19, 30), at(19, 40)], [at(11, 55, 1), at(12, 5, 1)]], at(18, 20), at(12, 30, 1));
  layTransition(CAM, TRANSITION.OUT_OF_BED, at(12, 5, 1, 30));
  storeOriginal();
  setWindow('19:30', '07:00');

  const res = await getReview();
  assert.equal(res.status, 200);
  const shown = res.body.computed;
  assert.equal(shown.wake_at, sqlTime(at(12, 5, 1)), 'precondition: the replay reports 12:05 the morning after');
  assert.ok(shown.onset_at, 'precondition: and an asleep time');
  assert.ok(Date.parse(`${shown.wake_at.replace(' ', 'T')}Z`) >= reportableSpanMs(CHILD, DATE).toMs,
    'precondition: 12:05 is outside today\'s span');

  // Exactly what NightReview's "That's right" sends.
  const saved = await put({
    true_onset_local: localHm(shown.onset_at), true_wake_local: '12:05',
    computed_onset_at: shown.onset_at, computed_wake_at: shown.wake_at, settings_key: res.body.settings.key,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(reviewRow().true_wake_at, shown.wake_at, 'the morning after, where the page showed it');
  assert.equal(reviewRow().true_onset_at, shown.onset_at);
});

// --- (3) + (4) + (7) the camera set: the saved camera only while it is still THIS child's -------------------------

test('the saved camera is listed, accepted and counted while it is this child\'s (turned off); moved to another child or deleted: none of it', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  const camEvent = layA(CAM);
  const camEvening = layTransition(CAM, TRANSITION.INTO_BED, at(19, 35));
  const cam2Event = layB(CAM2);
  const raw = storeOriginal();
  assert.equal(parseScoringContext(raw).camera_id, CAM, 'precondition: scored from the first camera');

  // Turned off since: today's set is the second camera only, the saved settings bring the first back.
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  let res = await getReview();
  assert.deepEqual(idsOf(res.body), [camEvent, camEvening, cam2Event].sort((a, b) => a - b), 'both cameras\' events');
  assert.equal(res.body.transitions.find((x) => x.id === camEvent).camera_name, 'Bed cam');
  assert.equal(pendingReview(CHILD)?.transition_count, 3, 'the card counts the same set');
  const ok = await put({ true_wake_transition_id: camEvent, verdicts: { [camEvening]: 'correct' }, settings_key: res.body.settings.key });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(reviewRow().true_wake_at, exactSql(at(6, 2, 1)), 'its frame is accepted, to the second');
  assert.equal(verdictOf(camEvening), 'correct');
  db.prepare('DELETE FROM sleep_reviews').run();
  db.prepare('UPDATE bed_transitions SET verdict = NULL').run();

  // Moved to another child: its events (inside this night's span) are now that child's. The decision is still the
  // saved settings, so only the ownership check keeps them out.
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD2, CAM);
  // Deleted: the camera row is gone but its events are left in place (hostile: entityPurge would remove them).
  for (const [label, change] of [['moved', () => {}], ['deleted', () => db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM)]]) {
    change();
    assert.equal(displayContextFor(CHILD, DATE)?.context.camera_id, CAM, `${label}: precondition: the saved settings apply`);
    res = await getReview();
    assert.deepEqual(idsOf(res.body), [cam2Event], `${label}: only this child's camera`);
    assert.equal(pendingReview(CHILD)?.transition_count, 1, `${label}: the card counts the same set`);
    const key = res.body.settings.key;
    assert.equal(key, raw);
    const frame = await put({ true_wake_transition_id: camEvent, settings_key: key });
    assert.equal(frame.status, 400, `${label}: frame`);
    assert.match(frame.body.error, /is not an event of this night/);
    const verdict = await put({ verdicts: { [camEvening]: 'wrong' }, settings_key: key });
    assert.equal(verdict.status, 400, `${label}: verdict`);
    assert.match(verdict.body.error, /is not part of this night/);
    assert.equal(reviewRow(), undefined, `${label}: nothing stored`);
    assert.equal(verdictOf(camEvening), null, `${label}: no verdict written`);
  }
});

// --- (5) the timezone: the saved zone's noon to noon -------------------------------------------------------------

test('timezone change: the list covers the SAVED zone\'s noon to noon, and settings.tz names it', async (t) => {
  // 08:00 UTC the day after: London's window (19:30-07:00 BST) has ended too, so the night is finished under both.
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 6, 2, 8, 0) });
  const nightEvent = layA(CAM);
  storeOriginal();
  // Melbourne's noon to noon is 02:00Z on the 1st to 02:00Z on the 2nd; London's (BST) 11:00Z to 11:00Z.
  const onlyMelbourne = layTransition(CAM, TRANSITION.OUT_OF_BED, new Date(Date.UTC(2026, 6, 1, 5, 0))); // 15:00 Melbourne
  const onlyLondon = layTransition(CAM, TRANSITION.OUT_OF_BED, new Date(Date.UTC(2026, 6, 2, 5, 0))); // 06:00 London, the 2nd
  setTz('Europe/London');
  assert.equal(displayContextFor(CHILD, DATE)?.context.tz, TZ, 'precondition: the saved settings apply');

  const res = await getReview();
  assert.equal(res.status, 200);
  assert.deepEqual(idsOf(res.body), [nightEvent, onlyMelbourne].sort((a, b) => a - b));
  assert.equal(res.body.settings.tz, TZ);
  const span = reportableSpanMs(CHILD, DATE, displayContextFor(CHILD, DATE).context);
  assert.equal(span.fromMs, at(16, 30).getTime(), 'the echo span is the saved window in the saved zone (19:30 less 3 h)');
  assert.ok(!idsOf(res.body).includes(onlyLondon));
});

// --- (6) when the saved settings do NOT apply, nothing changes ---------------------------------------------------

test('a legacy NULL context, identical settings, or a saved window not yet ended: today\'s list, span and numbers, empty key', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const today = () => ({ computed: getNightReview(CHILD, DATE).computed, ids: idsOf(getNightReview(CHILD, DATE)) });

  // No saved row: the reference (today's settings). Then each case must give exactly the same.
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  const reference = today();
  const referenceSpan = reportableSpanMs(CHILD, DATE);
  db.prepare('UPDATE cameras SET disabled = 0 WHERE id = ?').run(CAM);
  storeOriginal(); // scored from the first camera, which is then turned off: the saved settings differ from today's
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  assert.equal(displayContextFor(CHILD, DATE)?.context.camera_id, CAM, 'precondition: with a usable context it would apply');

  const cases = [
    ['legacy NULL context', () => db.prepare('UPDATE sleep_nights SET scoring_context = NULL').run()],
    ['identical settings', () => {
      db.prepare('DELETE FROM sleep_nights').run();
      storeOriginal(); // saved with today's settings (the first camera is off)
    }],
    ['saved window not ended yet', () => {
      db.prepare('DELETE FROM sleep_nights').run();
      db.prepare('UPDATE cameras SET disabled = 0 WHERE id = ?').run(CAM);
      t.mock.timers.setTime(at(23, 0).getTime());
      storeOriginal(); // during the night, from the first camera
      db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
    }],
  ];
  for (const [label, setup] of cases) {
    setup();
    const review = getNightReview(CHILD, DATE);
    assert.equal(displayContextFor(CHILD, DATE), null, `${label}: no saved settings`);
    assert.deepEqual(review.settings, { key: '', tz: TZ }, label);
    assert.deepEqual(idsOf(review), reference.ids, `${label}: today's list (the turned-off camera is not in it)`);
    if (label !== 'saved window not ended yet') {
      assert.deepEqual(review.computed, reference.computed, `${label}: today's numbers`);
    } else {
      assert.deepEqual(review.computed, computedOf(json(computeNight(CHILD, DATE))), `${label}: today's numbers, live`);
    }
    assert.deepEqual(reportableSpanMs(CHILD, DATE, displayContextFor(CHILD, DATE)?.context ?? null), referenceSpan, label);
  }
});

// --- R1: the PUT is bound to the settings the GET used -----------------------------------------------------------

// A night under a 00:00-08:00 window: asleep shortly after midnight on the night's own date, up at 07:00. Stored at
// 12:00 that day, past the window and its evidence horizon.
function layEarlyWindowNight() {
  setWindow('00:00', '08:00');
  layMinutes(CAM, [[at(0, 0), at(0, 10)], [at(7, 0), at(8, 0)]], at(22, 50, -1), at(8, 0));
  layTransition(CAM, TRANSITION.OUT_OF_BED, at(7, 2));
}

test('settings_changed: the plan\'s two requests (00:00-08:00 at GET, 19:00-07:00 before PUT) are refused with 409, nothing written', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(12, 0).getTime() });
  layEarlyWindowNight();
  storeOriginal();
  const res = await getReview();
  assert.equal(res.status, 200);
  assert.equal(res.body.settings.key, '', 'precondition: today\'s settings are the saved ones');
  const shown = res.body.computed;
  assert.ok(shown.onset_at && shown.wake_at, `precondition: a night with both times: ${JSON.stringify(shown)}`);

  setWindow('19:00', '07:00');
  const before = rowOf();
  const body = {
    true_onset_local: localHm(shown.onset_at), true_wake_local: localHm(shown.wake_at),
    computed_onset_at: shown.onset_at, computed_wake_at: shown.wake_at, verdicts: {}, reasons: {},
  };
  const refused = await put({ ...body, settings_key: res.body.settings.key });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.reason, 'settings_changed');
  assert.match(refused.body.error, /changed while you were reviewing\. Reload the page/);
  assert.equal(reviewRow(), undefined, 'no review stored');
  assert.deepEqual(rowOf(), before, 'the saved night untouched (the store-first step did not run)');

  // A key that is not text is a client bug: refused, nothing written.
  const junk = await put({ ...body, settings_key: 7 });
  assert.equal(junk.status, 400);
  assert.equal(reviewRow(), undefined);

  // An older open page sends no key: no check, as before this existed. Here the night is now shown with its saved
  // settings, which are the ones that page used, so its times land where it showed them.
  const old = await put(body);
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.equal(reviewRow().true_onset_at, shown.onset_at);
  assert.equal(reviewRow().true_wake_at, shown.wake_at);
});

test('settings_changed: a page shown with the saved settings, then the night re-saved with today\'s, is refused; the old page\'s save would be a day out', async (t) => {
  // The straddle the check exists for: the page showed the night with its SAVED 00:00-08:00 window (asleep 00:1x and
  // up 07:00 on the night's own date); before the save an admin re-saves it with today's 19:00-07:00 settings, so the
  // save would use today's span, where both times are outside and the noon rule dates them a day later.
  t.mock.timers.enable({ apis: ['Date'], now: at(12, 0).getTime() });
  layEarlyWindowNight();
  const raw = storeOriginal();
  setWindow('19:00', '07:00');
  const res = await getReview();
  assert.equal(res.body.settings.key, raw, 'precondition: the page shows the saved settings');
  const shown = res.body.computed;
  assert.ok(shown.onset_at && shown.wake_at, 'precondition: a night with both times');

  computeAndStoreNight(CHILD, DATE); // an admin's Recompute with today's settings
  assert.equal(displayContextFor(CHILD, DATE), null, 'precondition: now today\'s settings');
  const body = {
    true_onset_local: localHm(shown.onset_at), true_wake_local: localHm(shown.wake_at),
    computed_onset_at: shown.onset_at, computed_wake_at: shown.wake_at,
  };
  const refused = await put({ ...body, settings_key: res.body.settings.key });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'settings_changed');
  assert.equal(reviewRow(), undefined);

  // Known limit, pinned: a page loaded before this check existed sends no key and is saved by the noon rule, a day
  // after what it showed. (Reload fixes it; the check above is what the current page relies on.)
  const old = await put(body);
  assert.equal(old.status, 200);
  const dayMs = 24 * 3600 * 1000;
  const plusDay = (s) => exactSql(new Date(Date.parse(`${s.replace(' ', 'T')}Z`) + dayMs));
  assert.equal(reviewRow().true_onset_at, plusDay(shown.onset_at));
  assert.equal(reviewRow().true_wake_at, plusDay(shown.wake_at));
});
