// #361 PR 4a: the sleep detail page shows a FINISHED night with the settings it was saved with.
//
// Why: the child's card shows a night's SAVED row, but the detail page worked every night out afresh with today's
// camera, timezone and window. After a camera was turned off, moved to another child, demoted by a new main camera or
// dragged down the tile order, or after the window or the timezone changed, a finished night's page changed (or went
// `no_data`, the #361 report) while its card did not. Now:
//   - computeNightForDisplay(childId, date, { mode }) is the ONE place that decides (sleepAnalysis.js). In mode 'auto'
//     it replays the saved row's `scoring_context` iff the child tracks sleep, a row exists, the wall clock has
//     reached that ROW's `window_end` (plan R1: not its computed_at), the context parses and it differs from today's;
//     else it is the plain compute. Whenever replay would apply it adds `scoring_view` in BOTH modes (plan R3);
//     otherwise there is no new key at all;
//   - GET /children/:id/sleep/:date?context=auto (READS only; the page sends it), `context=current` and NO param keep
//     today's settings (plan R2: an open page from before this PR is a deployed client); an admin store with `auto`
//     is a 400.
// Plan: ~/.claude/plans/ticklish-mixing-moore.md, PART 2, revisions R1-R9 (they override D1-D5).
//
// ⚠️ HOSTILE FIXTURES (plan R7): in every case where a rule could be dropped without notice (in progress, not yet
// ended, provisional, tracking off, identical settings), the saved context DIFFERS from today's, so a replay that
// should not happen changes the answer; and the two cameras saw different nights (A and B differ on every number, the
// pair from scoring-context-replay.test.js), so a page that reads the wrong camera cannot match by accident. Where the
// settings are identical, the answer must DEEP-EQUAL the plain compute. Camera and child names are neutral: the repo
// is public.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  computeNight, computeAndStoreNight, computeNightForDisplay, runNightlySleepJob, SCORING_ALGO, parseScoringContext,
  currentScoringContext, currentNightDate,
} = await import('../src/lib/sleepAnalysis.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { default: childrenRouter } = await import('../src/routes/children.js');
const { logger } = await import('../src/lib/logger.js');

const CHILD = 'dv-child';
const CHILD2 = 'dv-child-2';
const CAM = 'dv-cam-a';
const CAM2 = 'dv-cam-b';
const DATE = '2026-07-01';
// A non-UTC zone with no DST edge near the fixture night (UTC+10 in July), so `at()` is plain arithmetic and a
// hard-coded 'UTC' anywhere cannot pass. (The DST test below uses its own night.)
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const exactSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const json = (v) => JSON.parse(JSON.stringify(v)); // what a client actually receives
const omit = (n, ...keys) => Object.fromEntries(Object.entries(n).filter(([k]) => !keys.includes(k)));
// 12:00 local the day after: past the night's window AND its evidence horizon (07:00 + 3 h), so nothing moves.
const NOON_AFTER = at(12, 0, 1).getTime();

// The numbers a person sees for a night: what these tests assert, not only a status.
const NUMBER_KEYS = ['status', 'onset_at', 'wake_at', 'asleep_minutes', 'awake_minutes', 'wake_count', 'coverage_minutes'];
const numbers = (n) => Object.fromEntries(NUMBER_KEYS.map((k) => [k, n[k]]));

let server;
let adminToken;
let caregiverToken;

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
const outOfBed = (cam, d) =>
  db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run(cam, TRANSITION.OUT_OF_BED, exactSql(d));

// Night A (what CAM saw): settles by 19:40, sleeps through, up at 06:00. Night B (what CAM2 saw): settles only after
// 20:10, one awakening 01:00-01:15, up at 05:30. Different on every number.
function layA(cam = CAM) {
  layMinutes(cam, [[at(19, 30), at(19, 40)], [at(6, 0, 1), at(7, 0, 1)]], at(18, 20), at(7, 0, 1));
  outOfBed(cam, at(6, 2, 1));
}
function layB(cam = CAM2) {
  layMinutes(cam, [[at(18, 20), at(20, 10)], [at(1, 0, 1), at(1, 15, 1)], [at(5, 30, 1), at(7, 0, 1)]], at(18, 20), at(7, 0, 1));
  outOfBed(cam, at(5, 32, 1));
}

const addCamera = (id, child, sort, name) =>
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, ?, 'rtsp://example/x', ?, ?, ?, 0)`).run(id, name, child, `p-${id}`, sort);
const setTz = (tz) => db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(tz);
const setWindow = (start, end) =>
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, CHILD);
const setPrimary = (cam) => db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(cam, CHILD);
const rowOf = (date = DATE) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const setRowContext = (raw) =>
  db.prepare('UPDATE sleep_nights SET scoring_context = ? WHERE child_id = ? AND night_date = ?').run(raw, CHILD, DATE);
const display = (mode, opts = {}) => json(computeNightForDisplay(CHILD, DATE, { mode, ...opts }));
const plain = (opts = {}) => json(computeNight(CHILD, DATE, opts));

const get = (query, token = adminToken) => call(`${server.url}/api/children/${CHILD}/sleep/${DATE}${query}`, { token });

// Store the night as the nightly job would (today's settings at the time) and hand back its numbers and the stored
// context string. Fails loudly if no context was stored, so a missing write cannot look like a match.
function storeOriginal(date = DATE) {
  const summary = computeAndStoreNight(CHILD, date, { allowDowngrade: false });
  assert.equal(summary.stored, true, 'precondition: the original night was stored');
  const raw = rowOf(date).scoring_context;
  assert.ok(parseScoringContext(raw), `precondition: the stored context parses: ${raw}`);
  return { original: numbers(json(summary)), raw };
}
// Precondition for every "replay must NOT happen here" case: today's settings really differ from the saved ones, so
// the rule under test is the only thing keeping the answer plain.
function assertSettingsDiffer(raw) {
  const saved = parseScoringContext(raw);
  const now = currentScoringContext(CHILD);
  assert.ok(
    saved.camera_id !== now.camera_id || saved.tz !== now.tz || JSON.stringify(saved.window) !== JSON.stringify(now.window),
    'precondition: the saved settings differ from today\'s'
  );
}

before(async () => {
  const admin = makeUser(db, { id: 'u-dv-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-dv-c', username: 'carer', role: 'caregiver' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  caregiverToken = signToken({ sub: care.id, sid: makeSession(db, care.id), role: 'caregiver', username: 'carer' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Display Kid', 1, '19:30', '07:00')`).run(CHILD);
  addCamera(CAM, CHILD, 0, 'Bed cam');
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- 1. per trigger: a finished night's page shows the SAVED row's numbers; today's settings do not --------------

const TRIGGERS = [
  // The #361 report: the only camera turned off. Today's settings find no camera at all.
  ['the camera was turned off', () => {}, () => db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM)],
  ['the camera moved to another child', () => { addCamera(CAM2, CHILD, 1, 'Door cam'); layB(CAM2); }, () => {
    db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(CHILD2);
    db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD2, CAM);
  }],
  ['another camera was named the main one', () => { addCamera(CAM2, CHILD, 1, 'Door cam'); layB(CAM2); }, () => setPrimary(CAM2)],
  ['the tiles were reordered (Automatic)', () => { addCamera(CAM2, CHILD, 1, 'Door cam'); layB(CAM2); }, () => {
    db.prepare('UPDATE cameras SET sort_order = 1 WHERE id = ?').run(CAM);
    db.prepare('UPDATE cameras SET sort_order = 0 WHERE id = ?').run(CAM2);
  }],
  ['the sleep window changed', () => {}, () => setWindow('21:00', '06:00')],
  ['the app timezone changed', () => {}, () => setTz('Asia/Tokyo')],
];
for (const [label, extra, change] of TRIGGERS) {
  test(`${label}: mode auto shows the saved row's numbers (the replay), mode current today's (plain + scoring_view)`, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
    extra();
    layA(CAM);
    const { original, raw } = storeOriginal();
    change();

    const auto = display('auto');
    const current = display('current');
    assert.deepEqual(numbers(auto), numbers(rowOf()), 'the page agrees with the saved row (what the card shows)');
    assert.deepEqual(numbers(auto), original);
    assert.notDeepEqual(numbers(current), original, 'precondition: today\'s settings really give other numbers');
    // Exactly the two computes, nothing else: the replay of the saved context, and the plain compute, each plus the key.
    assert.deepEqual(omit(auto, 'scoring_view'), plain({ context: raw }));
    assert.deepEqual(omit(current, 'scoring_view'), plain());
    assert.equal(auto.scoring_view.applied, 'stored');
    assert.equal(current.scoring_view.applied, 'current');
    assert.ok(!('scoring' in current), 'today\'s settings are a plain compute: no replay block');
  });
}

// The detail page always asks with `detail=1` (includeTimeline), and a night with a scoring_view is exactly the one
// this PR changes. Code review of PR 4a: dropping `includeTimeline` from the helper's computeNight call survived every
// other test (they compare numbers, or use identical settings where the plain path runs).
test('the timeline is kept in both modes: a replay with includeTimeline is the full detail answer, and so is today\'s', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { raw } = storeOriginal();
  setPrimary(CAM2);
  const auto = display('auto', { includeTimeline: true });
  const current = display('current', { includeTimeline: true });
  assert.equal(auto.scoring_view?.applied, 'stored');
  assert.equal(current.scoring_view?.applied, 'current');
  assert.deepEqual(omit(auto, 'scoring_view'), plain({ includeTimeline: true, context: raw }));
  assert.deepEqual(omit(current, 'scoring_view'), plain({ includeTimeline: true }));
  for (const [label, out] of [['auto', auto], ['current', current]]) {
    for (const k of ['segments', 'wakes']) assert.ok(Array.isArray(out[k]) && out[k].length > 0, `${label}: ${k} present`);
    // These fixtures record no movement outside the bed, so the list is there and empty.
    assert.ok(Array.isArray(out.visits), `${label}: visits present`);
  }
});

// --- 2. when the saved settings are NOT used: the answer is the plain compute, with no new key ------------------

test('identical settings: auto is EXACTLY the plain compute (no scoring, no scoring_view), with and without the timeline', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  storeOriginal();
  for (const includeTimeline of [false, true]) {
    for (const mode of ['auto', 'current']) {
      const out = display(mode, { includeTimeline });
      assert.deepEqual(out, plain({ includeTimeline }), `${mode}, timeline ${includeTimeline}`);
      assert.ok(!('scoring_view' in out) && !('scoring' in out), `${mode}: no new key`);
    }
  }
  // Only the rules label differs: still nothing to choose (a replay cannot honour another rules version anyway).
  setRowContext(JSON.stringify({ ...parseScoringContext(rowOf().scoring_context), algo: 'older-rules' }));
  assert.deepEqual(display('auto'), plain());
});

test('a night whose saved window has NOT ended is live, even with differing settings; it replays from the window\'s end', (t) => {
  // 23:00 local on the night itself: an admin's store (or the demo seed) can write a row during the night.
  t.mock.timers.enable({ apis: ['Date'], now: at(23, 0).getTime() });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { raw } = storeOriginal();
  assert.equal(rowOf().window_end, '2026-07-01 21:00:00', 'precondition: 07:00 Melbourne, still ahead');
  setPrimary(CAM2);
  assertSettingsDiffer(raw);
  assert.deepEqual(display('auto'), plain(), 'in progress: today\'s settings, no new key');
  assert.deepEqual(display('current'), plain());

  // One minute before the saved window's end: still live. At it: the saved settings (the boundary is inclusive).
  t.mock.timers.setTime(at(6, 59, 1).getTime());
  assert.deepEqual(display('auto'), plain(), '06:59: still live');
  t.mock.timers.setTime(at(7, 0, 1).getTime());
  const atEnd = display('auto');
  assert.equal(atEnd.scoring_view?.applied, 'stored', '07:00: the saved settings');
  assert.deepEqual(omit(atEnd, 'scoring_view'), plain({ context: raw }));
});

// Rule 2 on its own. In the test above today's window is the saved one, so rule 5 (in progress under today's window)
// also keeps the page live; here today's window has already CLOSED (its end was moved earlier, to 22:00) while the
// saved window still runs to 07:00, so only rule 2 does. (The rule 2 catalogue mutant survived without this test once
// rule 5 was added in the PR 4a review.)
test('a saved window that has NOT ended keeps the page live even after today\'s window has closed (rule 2 alone)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(23, 0).getTime() });
  layA(CAM);
  const { raw } = storeOriginal(); // during the night: the saved window runs to 07:00
  setWindow('19:30', '22:00');
  assertSettingsDiffer(raw);
  assert.equal(currentNightDate(CHILD), null, 'precondition: not in progress under today\'s window');
  assert.equal(plain().in_progress, false, 'precondition: today\'s settings call the night over');
  assert.deepEqual(display('auto'), plain(), 'live: today\'s settings, no new key');
});

test('a provisional row (window ended, evidence horizon not reached) uses its saved settings: the rule is window_end', (t) => {
  // 07:30, half an hour after the window: the job's first pass. Its horizon (10:00) is still ahead, so a rule that
  // waited for "final evidence" would show today's settings here while the card shows this row.
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 30, 1).getTime() });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original, raw } = storeOriginal();
  setPrimary(CAM2);
  assertSettingsDiffer(raw);
  const auto = display('auto');
  assert.equal(auto.scoring_view?.applied, 'stored');
  assert.deepEqual(numbers(auto), original);
  assert.deepEqual(numbers(auto), numbers(rowOf()));
});

// Code review of PR 4a, reproduced from its probe: the window END moved later after the night was saved, so the saved
// row's window_end has passed while today's window is still open. The card and /sleep/live show the night LIVE; the
// page used to show a finished replay beside them (in progress false, other minutes).
test('a night still in progress under TODAY\'s window stays live even though its saved window has ended (rule 5)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 30, 1).getTime() });
  layA(CAM);
  const { raw } = storeOriginal(); // 07:30, the 19:30-07:00 window
  t.mock.timers.setTime(at(7, 45, 1).getTime());
  setWindow('19:30', '09:00');
  t.mock.timers.setTime(at(8, 0, 1).getTime());
  assertSettingsDiffer(raw);
  assert.ok(Date.now() >= Date.parse(`${rowOf().window_end.replace(' ', 'T')}Z`), 'precondition: the saved window has ended');

  const live = await call(`${server.url}/api/children/${CHILD}/sleep/live`, { token: adminToken });
  assert.equal(live.body.scope, 'tonight', 'precondition: the card shows it as tonight');
  assert.equal(live.body.night.in_progress, true);

  const page = await get('?detail=1&context=auto');
  assert.equal(page.status, 200);
  assert.equal(page.body.in_progress, true, 'the page is live too');
  assert.ok(!('scoring_view' in page.body) && !('scoring' in page.body), 'no saved-settings view while it is in progress');
  assert.equal(page.body.asleep_minutes, live.body.night.asleep_minutes, 'and agrees with the card');
  assert.deepEqual(display('auto'), plain());

  // Once today's window has closed too, the saved settings apply (the boundary is today's window end, 09:00).
  t.mock.timers.setTime(at(8, 59, 1).getTime());
  assert.ok(!('scoring_view' in display('auto')), '08:59: still in progress');
  t.mock.timers.setTime(at(9, 0, 1).getTime());
  assert.equal(display('auto').scoring_view?.applied, 'stored', '09:00: finished under both');
});

test('no saved row, a legacy NULL context, or an unreadable one: today\'s settings, byte-identical, no new key', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  // No row at all.
  setPrimary(CAM2);
  assert.deepEqual(display('auto', { includeTimeline: true }), plain({ includeTimeline: true }), 'no row');
  // A row from today's settings, then made legacy / unreadable, with the settings changed back so they would differ.
  setPrimary(null);
  const { raw } = storeOriginal();
  setPrimary(CAM2);
  assertSettingsDiffer(raw);
  for (const [label, value] of [['legacy NULL', null], ['unreadable', '{"v":1,'], ['a v2 shape', '{"v":2}']]) {
    setRowContext(value);
    for (const includeTimeline of [false, true]) {
      const out = display('auto', { includeTimeline });
      assert.deepEqual(out, plain({ includeTimeline }), `${label}, timeline ${includeTimeline}`);
      assert.ok(!('scoring_view' in out) && !('scoring' in out), label);
    }
    // And through the route: the page's request answers exactly what an old page's request (no param) answers.
    const auto = await get('?detail=1&context=auto');
    const old = await get('?detail=1');
    assert.equal(auto.status, 200);
    assert.deepEqual(auto.body, old.body, `${label}: the route`);
    assert.ok(!('scoring_view' in auto.body), label);
  }
});

test('tracking off: `off` with no scoring_view and no replay, whatever the saved settings (plan R3)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { raw } = storeOriginal();
  setPrimary(CAM2);
  assertSettingsDiffer(raw);
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  for (const mode of ['auto', 'current']) {
    const out = display(mode);
    assert.equal(out.status, 'off', mode);
    assert.deepEqual(out, plain(), `${mode}: exactly the plain off night`);
    assert.ok(!('scoring_view' in out) && !('scoring' in out), `${mode}: no line, no toggle`);
  }
});

// --- 3. the states R1 exists for: a row the job never rewrites after the horizon -----------------------------

test('the #361 case end to end through the real job: a refused provisional row is still shown with its saved settings', (t) => {
  // The job stores `ok` at 07:30; the camera is turned off at 08:00; every later pass computes no_data and is refused
  // (would_downgrade), so the row keeps its 07:30 computed_at for good. The card shows that `ok`. Under a rule keyed on
  // the row's computed_at (the first draft) the page would say "no data" for ever.
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 30, 1).getTime() });
  const info = t.mock.method(logger, 'info', () => {});
  layA(CAM);
  runNightlySleepJob();
  const first = rowOf();
  assert.equal(first?.status, 'ok', 'precondition: the job stored a scored night');
  t.mock.timers.tick(30 * 60000);
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  for (let i = 0; i < 8; i++) { // 08:30 .. 12:00
    t.mock.timers.tick(30 * 60000);
    runNightlySleepJob();
  }
  info.mock.restore();
  assert.deepEqual(rowOf(), first, 'precondition: every later pass was refused, the row (and its computed_at) untouched');
  assert.equal(plain().status, 'no_data', 'precondition: today\'s settings find no camera');

  const auto = display('auto');
  assert.equal(auto.scoring_view?.applied, 'stored');
  assert.deepEqual(numbers(auto), numbers(first), 'the page shows what the card shows');
  assert.equal(display('current').status, 'no_data', 'and "today\'s settings" is still one tap away');
});

test('a night corrected (and so locked) before the horizon is shown with its saved settings, the correction laid over it', async (t) => {
  // Locked at 07:40, before the horizon: the job never touches it again, so its computed_at stays early for good.
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 30, 1).getTime() });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original } = storeOriginal();
  const typedWake = exactSql(at(6, 40, 1));
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, true_wake_at) VALUES (?, ?, ?)').run(CHILD, DATE, typedWake);
  assert.equal((await get('?stored=1')).body.locked, true, 'precondition: locked');
  setPrimary(CAM2);
  t.mock.timers.setTime(NOON_AFTER);
  const info = t.mock.method(logger, 'info', () => {});
  runNightlySleepJob();
  info.mock.restore();
  assert.equal(rowOf().computed_at, sqlTime(at(7, 30, 1)), 'precondition: the job left the locked row as it was');

  // The detector's own answer (raw) is the saved row's; the overlaid answer carries the parent's wake on top of it.
  const raw = await get('?detail=1&context=auto&raw=1');
  assert.equal(raw.status, 200);
  assert.deepEqual(numbers(raw.body), original);
  assert.equal(raw.body.scoring_view.applied, 'stored');
  assert.ok(!('corrected' in raw.body), 'raw: no overlay');
  const shown = await get('?detail=1&context=auto');
  assert.equal(shown.body.wake_at, typedWake, 'the correction is laid over the replay');
  assert.equal(shown.body.corrected, true);
  assert.equal(shown.body.onset_at, original.onset_at, 'and the rest is the saved night, not today\'s camera');
  assert.equal(shown.body.scoring_view.applied, 'stored');
});

// --- 4. what scoring_view says ----------------------------------------------------------------------------------

test('scoring_view: exactly { applied, stored, current, camera_names, algo_differs }, the same in both modes but `applied`', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { raw } = storeOriginal();
  setPrimary(CAM2);
  const expected = {
    stored: parseScoringContext(raw),
    current: currentScoringContext(CHILD),
    camera_names: { stored: 'Bed cam', current: 'Door cam' },
    algo_differs: false,
  };
  assert.deepEqual(display('auto').scoring_view, { applied: 'stored', ...expected });
  assert.deepEqual(display('current').scoring_view, { applied: 'current', ...expected });
  assert.deepEqual(Object.keys(display('auto').scoring_view).sort(), ['algo_differs', 'applied', 'camera_names', 'current', 'stored']);

  // A night first worked out under other rules: the page says so (its numbers can differ from the card's).
  setRowContext(JSON.stringify({ ...parseScoringContext(raw), algo: 'older-rules' }));
  const older = display('auto');
  assert.equal(older.scoring_view.algo_differs, true);
  assert.equal(older.scoring_view.stored.algo, 'older-rules');
  assert.equal(older.scoring.algo_differs, true, 'the replay block agrees');
  assert.equal(display('current').scoring_view.algo_differs, true);
});

// --- 5. the stated limits, pinned ---------------------------------------------------------------------------------

test('a deleted saved camera, with a second camera present: no_data + camera_deleted, never the other camera\'s night', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  storeOriginal();
  // Deleting a camera purges its samples with it (entityPurge), so do both.
  db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(CAM);
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  const current = display('current');
  assert.equal(current.status, 'ok', 'precondition: today\'s settings score the night from the other camera');
  assert.equal(current.analysis_camera_id, CAM2);
  const auto = display('auto');
  assert.equal(auto.status, 'no_data');
  assert.equal(auto.analysis_camera_id, null, 'not the other camera');
  assert.equal(auto.scoring.problem, 'camera_deleted');
  assert.equal(auto.scoring_view.applied, 'stored');
  assert.equal(auto.scoring_view.camera_names.stored, null, 'the camera has no name any more');
  assert.equal(auto.scoring_view.camera_names.current, 'Door cam');
});

test('known limit: a night saved with no camera on (camera_id null) stays no_data after a camera is assigned', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA(CAM);
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, null, 'precondition: saved with no camera');
  assert.equal(rowOf().status, 'no_data');
  db.prepare('UPDATE cameras SET disabled = 0 WHERE id = ?').run(CAM);
  assert.equal(display('current').status, 'ok', 'today\'s settings would recover it');
  const auto = display('auto');
  assert.equal(auto.status, 'no_data', 'the saved settings had no camera');
  assert.equal(auto.scoring.problem, null, 'not a deleted camera: there was none');
  assert.equal(auto.scoring_view.applied, 'stored');
});

test('known limit: a night whose samples have aged out is no_data with either settings, while its saved row keeps the numbers', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original } = storeOriginal();
  setPrimary(CAM2);
  db.prepare('DELETE FROM activity_samples').run(); // the 30-day retention, at the edge of the date picker
  assert.equal(display('auto').status, 'no_data');
  assert.equal(display('auto').scoring_view.applied, 'stored', 'still the saved settings, and the page says so');
  assert.equal(display('current').status, 'no_data');
  assert.deepEqual(numbers(rowOf()), original, 'the saved row is untouched (reading never writes)');
});

test('a timezone change across a DST night: the saved zone\'s DST-aware window is the one replayed', (t) => {
  // Melbourne goes from +10 to +11 at 02:00 on 2026-10-04, inside this night, so its 19:30-07:00 window is 10.5 h
  // long. Tokyo has no DST. Times laid as UTC instants.
  const DST_DATE = '2026-10-03';
  const z = (iso) => new Date(`${iso}Z`);
  t.mock.timers.enable({ apis: ['Date'], now: z('2026-10-04T02:00:00').getTime() }); // 13:00 local, past the horizon
  layMinutes(CAM, [[z('2026-10-03T09:30:00'), z('2026-10-03T09:40:00')], [z('2026-10-03T19:00:00'), z('2026-10-03T20:00:00')]],
    z('2026-10-03T08:20:00'), z('2026-10-03T20:00:00'));
  outOfBed(CAM, z('2026-10-03T19:02:00'));
  const { original } = storeOriginal(DST_DATE);
  const saved = rowOf(DST_DATE);
  assert.equal(saved.window_start, '2026-10-03 09:30:00', 'precondition: 19:30 AEST');
  assert.equal(saved.window_end, '2026-10-03 20:00:00', 'precondition: 07:00 AEDT, after the clocks went forward');
  setTz('Asia/Tokyo');
  const auto = json(computeNightForDisplay(CHILD, DST_DATE, { mode: 'auto' }));
  const current = json(computeNightForDisplay(CHILD, DST_DATE, { mode: 'current' }));
  assert.equal(auto.window_start, saved.window_start);
  assert.equal(auto.window_end, saved.window_end);
  assert.deepEqual(numbers(auto), original);
  assert.equal(current.window_end, '2026-10-03 22:00:00', 'today\'s zone: 07:00 JST');
  assert.notDeepEqual(numbers(current), original);
});

test('lib: a mode other than auto or current throws, instead of quietly becoming one of them', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA(CAM);
  storeOriginal();
  for (const mode of ['stored', 'Auto', '', null]) {
    assert.throws(() => computeNightForDisplay(CHILD, DATE, { mode }), TypeError, JSON.stringify(mode));
  }
  // The default (no mode) is 'auto'.
  setWindow('21:00', '06:00');
  assert.equal(json(computeNightForDisplay(CHILD, DATE)).scoring_view.applied, 'stored');
});

// --- 6. the route -----------------------------------------------------------------------------------------------

test('route: context=auto is the saved settings; context=current and NO param are today\'s (an open old page is unchanged)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original } = storeOriginal();
  setPrimary(CAM2);

  const auto = await get('?detail=1&context=auto');
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.deepEqual(numbers(auto.body), original);
  assert.equal(auto.body.scoring_view.applied, 'stored');

  const old = await get('?detail=1');
  const current = await get('?detail=1&context=current');
  assert.deepEqual(old.body, current.body, 'no param is exactly context=current');
  assert.equal(old.body.scoring_view.applied, 'current', 'an added key on an old page\'s answer, nothing removed');
  assert.deepEqual(numbers(old.body), numbers(plain()));
  assert.notDeepEqual(numbers(old.body), original);

  // `stored` is PR 3's forced replay, unchanged: the same night, no scoring_view.
  const stored = await get('?detail=1&context=stored');
  assert.deepEqual(numbers(stored.body), original);
  assert.ok(!('scoring_view' in stored.body));

  // ?stored=1 is unchanged: the saved row, the contexts, the lock.
  const savedRow = await get('?stored=1&context=auto');
  assert.deepEqual(Object.keys(savedRow.body).sort(), ['contexts', 'locked', 'night']);
});

test('route: an admin store with context=auto is a 400 before anything is computed or written', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  storeOriginal();
  setPrimary(CAM2);
  // Figures no compute produces, so any write would show.
  db.prepare(`UPDATE sleep_nights SET asleep_minutes = 1, wake_count = 9, computed_at = 'PINNED'
                WHERE child_id = ? AND night_date = ?`).run(CHILD, DATE);
  const before = rowOf();
  for (const q of ['?store=1&context=auto', '?store=1&detail=1&context=auto']) {
    const res = await get(q);
    assert.equal(res.status, 400, q);
    assert.match(res.body.error, /only for reading a night/, q);
    assert.deepEqual(rowOf(), before, `${q}: nothing written`);
  }
  // An unknown value still is too, and names `auto` among the values a read may use.
  for (const q of ['?context=banana', '?context=Auto', '?store=1&context=banana']) {
    const res = await get(q);
    assert.equal(res.status, 400, q);
    assert.match(res.body.error, /context must be "stored" or "current", or "auto" on a read/, q);
  }
  assert.deepEqual(rowOf(), before);
  // A store with no param is today's settings, as before PR 4a (owner, #361 Q4): it writes today's camera.
  const plainStore = await get('?store=1');
  assert.equal(plainStore.status, 200);
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, CAM2);
});

test('route: a caregiver\'s store=1&context=auto is a read that honours auto, and writes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original } = storeOriginal();
  setPrimary(CAM2);
  const before = rowOf();
  const res = await get('?store=1&context=auto', caregiverToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.stored, undefined, 'a read, not a store');
  assert.deepEqual(numbers(res.body), original);
  assert.equal(res.body.scoring_view.applied, 'stored');
  assert.deepEqual(rowOf(), before);
});
