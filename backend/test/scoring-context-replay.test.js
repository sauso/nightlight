// #361 PR 2: computeNight can re-score a night WITH a stored scoring context instead of today's settings.
//
// Why: step 1 (#808, scoring-context.test.js) records beside every stored night which camera, timezone, window
// and rules version produced it, but nothing read it back, so a stored `ok` night still turned into `no_data` the
// moment its camera was disabled (the #361 report), and moved whenever the primary, the tile order, the window or
// the timezone changed. This PR adds the reading side and nothing else:
//   - parseScoringContext(raw): the JSON (or object) -> a normalised context, or null for anything the step-1
//     writer could not have produced; it never throws;
//   - currentScoringContext(childId): THE one definition of "the context a night would be scored with now",
//     which step 1's writer now uses without changing a stored byte;
//   - computeNight(childId, date, { context }): with a context, the timezone, window and scored camera come from
//     it, and the result gains a `scoring` block; without one, the result is exactly what it was (golden).
// Nothing calls computeNight with a context yet (the admin Recompute choice is the next PR), so no number a
// person sees can change. Plan: planning/361-scoring-context.md and the reviewed #361 plan (PR 2, refinements a-c).
//
// ⚠️ The camera and child fixtures are neutral on purpose: the repo is public.

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeNight, computeAndStoreNight, SCORING_ALGO, parseScoringContext, currentScoringContext } =
  await import('../src/lib/sleepAnalysis.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');

const CHILD = 'rp-child';
const CHILD2 = 'rp-child-2';
const CAM = 'rp-cam-a';
const CAM2 = 'rp-cam-b';
const DATE = '2026-07-01';
// A non-UTC zone with no DST edge near the fixture night (UTC+10 in July), so `at()` is plain arithmetic and a
// hard-coded 'UTC' anywhere cannot pass.
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const exactSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const json = (v) => JSON.parse(JSON.stringify(v)); // what a client actually receives
// 12:00 local the next day: past the night's evidence horizon (07:00 + 3 h), so in_progress/as_of are fixed.
const NOON_AFTER = at(12, 0, 1).getTime();

// The numbers a person sees for a night. The replay tests assert THESE, not only that some key changed.
const NUMBER_KEYS = ['status', 'onset_at', 'wake_at', 'asleep_minutes', 'awake_minutes', 'wake_count', 'coverage_minutes'];
const numbers = (n) => Object.fromEntries(NUMBER_KEYS.map((k) => [k, n[k]]));
const omit = (n, ...keys) => Object.fromEntries(Object.entries(n).filter(([k]) => !keys.includes(k)));

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
const sensor = (cam, temp, hum) =>
  db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, ?, ?, ?)')
    .run(cam, temp, hum, exactSql(at(23, 0)));
const outOfBed = (cam, d) =>
  db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run(cam, TRANSITION.OUT_OF_BED, exactSql(d));

// Night A (the one the context records): settles by 19:40, sleeps through, up at 06:00 (scoring-context.test.js's
// layOkNight). Night B (what the OTHER camera saw): settles only after 20:10, one awakening 01:00-01:15, up at
// 05:30. Different on every number, so a replay that reads the wrong camera cannot match by accident.
function layA(cam = CAM) {
  layMinutes(cam, [[at(19, 30), at(19, 40)], [at(6, 0, 1), at(7, 0, 1)]], at(18, 20), at(7, 0, 1));
  sensor(cam, 21.5, 48);
  outOfBed(cam, at(6, 2, 1));
}
function layB(cam = CAM2) {
  layMinutes(cam, [[at(18, 20), at(20, 10)], [at(1, 0, 1), at(1, 15, 1)], [at(5, 30, 1), at(7, 0, 1)]], at(18, 20), at(7, 0, 1));
  sensor(cam, 18, 60);
  outOfBed(cam, at(5, 32, 1));
}

const addCamera = (id, child, sort, name) =>
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, ?, 'rtsp://example/x', ?, ?, ?, 0)`).run(id, name, child, `p-${id}`, sort);
const setTz = (tz) => db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(tz);
const setWindow = (start, end) =>
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, CHILD);
const storedRow = () => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);

// Store the night as the app does today, and hand back what it stored: the summary (as a client sees it) and the
// stored context, parsed. Fails loudly if no context was stored, so a missing write can never look like a match.
function storeOriginal() {
  const summary = json(computeAndStoreNight(CHILD, DATE));
  const raw = storedRow()?.scoring_context;
  assert.equal(typeof raw, 'string', 'precondition: the night was stored with a context');
  const ctx = parseScoringContext(raw);
  assert.ok(ctx, `precondition: the stored context parses: ${raw}`);
  return { original: omit(summary, 'stored'), ctx };
}

// The core assertion of every replay test: a plain recompute really moved (so the test is not vacuous), and the
// replay with the stored context gives back the ORIGINAL numbers, and everything else the original said except
// the keys a test names as following today's settings (`scoring` is new on the replay by design).
function assertReplayed(original, ctx, { except = [] } = {}) {
  const plain = json(computeNight(CHILD, DATE));
  const replay = json(computeNight(CHILD, DATE, { context: ctx }));
  assert.notDeepEqual(numbers(plain), numbers(original), 'precondition: the change really moves a plain recompute');
  assert.deepEqual(numbers(replay), numbers(original), 'the replay reproduces the original numbers');
  assert.deepEqual(omit(replay, 'scoring', ...except), omit(original, ...except), 'and the rest of the original answer');
  assert.deepEqual(replay.scoring, { source: 'stored', algo: SCORING_ALGO, current_algo: SCORING_ALGO, algo_differs: false, problem: null });
  return { plain, replay };
}

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setTz(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Replay Kid', 1, '19:30', '07:00')`).run(CHILD);
  addCamera(CAM, CHILD, 0, 'Bed cam');
});

after(() => {
  db.close();
  cleanupTempDataDirs();
});

// --- 1. nothing that exists today changes ---------------------------------------------------------------

test('the stored scoring_context string is byte-identical to step 1, key order included', (t) => {
  // scoringContextFor now builds its JSON from currentScoringContext. These literals are what step 1 (#808) wrote
  // for the same settings, captured on the source before this PR: the same keys in the same order, so a stored
  // row cannot change by one byte.
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA();
  computeAndStoreNight(CHILD, DATE);
  const algo = JSON.stringify(SCORING_ALGO);
  assert.equal(storedRow().scoring_context,
    `{"v":1,"camera_id":"rp-cam-a","tz":"Australia/Melbourne","window":{"start":"19:30","end":"07:00"},"algo":${algo}}`);

  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  setTz('');
  setWindow('not-a-time', '25:00');
  computeAndStoreNight(CHILD, DATE);
  assert.equal(storedRow().scoring_context,
    `{"v":1,"camera_id":null,"tz":"UTC","window":{"start":"19:00","end":"25:00"},"algo":${algo}}`);
});

// computeNight(CHILD, DATE) with no context for layA on CAM plus layB on CAM2 (CAM first by sort_order), captured
// on the source BEFORE this PR (dev 848b69e) with the clock frozen at NOON_AFTER. Both cameras' sensors feed
// climate (19.8 is the rounded average of 21.5 and 18), which pins `cams` to today's cameras on the plain path.
// If a deliberate scoring change moves this, update it AND bump SCORING_ALGO (see its comment in sleepAnalysis.js).
// #700 added `wake_unconfirmed: null` (an added key; this night has no early exit and no earlier stored nights, so
// nothing else about it moves) and bumped SCORING_ALGO to '2'.
const GOLDEN = {
  night_date: '2026-07-01',
  window_start: '2026-07-01 09:30:00',
  window_end: '2026-07-01 21:00:00',
  in_progress: false,
  as_of: '2026-07-01 21:00:00',
  analysis_camera_id: 'rp-cam-a',
  analysis_camera_name: 'Bed cam',
  onset_at: '2026-07-01 09:40:00',
  wake_at: '2026-07-01 20:00:00',
  in_bed_at: null,
  onset_at_shadow: '2026-07-01 09:40:00',
  wake_at_shadow: '2026-07-01 20:00:00',
  onset_at_algo: '2026-07-01 09:40:00',
  wake_at_algo: '2026-07-01 20:00:00',
  asleep_minutes: 620,
  awake_minutes: 0,
  unknown_minutes: 0,
  wake_count: 0,
  longest_stretch_minutes: 620,
  coverage_minutes: 690,
  wake_unconfirmed: null,
  climate: {
    temp_avg: 19.8, temp_min: 18, temp_max: 21.5, temp_samples: 2,
    humidity_avg: 54, humidity_min: 48, humidity_max: 60, humidity_samples: 2,
  },
  status: 'ok',
};
// The same call with includeTimeline (the detail page's shape, segments, wakes, alerts and all), too long for a
// literal, so its JSON's sha256, captured on the same source at the same frozen instant. If it fails, diff the
// output against the parent commit's: the hash says only THAT the plain path's output moved.
// Re-captured for #700: the JSON gained `"wake_unconfirmed":null` (after `coverage_minutes`). With that key removed it
// hashes to the previous value, 113fd4973ca3976b34b33eb9cded2b55cea0c093b6a7a2ea6639abc18d11a17d (checked when this
// was updated), so the added key is the whole of the change.
const GOLDEN_TIMELINE_SHA256 = '048ae90a712bbc6c58305f80c2e2e12f453463bd821840e52a6e286bc5b786e1';

test('golden: without a context computeNight returns exactly what it did before #361 PR 2, with no scoring key', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const plain = computeNight(CHILD, DATE);
  assert.deepEqual(json(plain), GOLDEN);
  assert.ok(!('scoring' in plain), 'no scoring block without a context');
  // Every way of not passing a context is the same call.
  for (const opts of [{}, { includeTimeline: false }, { context: null }, { context: undefined }]) {
    assert.deepEqual(json(computeNight(CHILD, DATE, opts)), GOLDEN, JSON.stringify(opts));
  }
  const timeline = computeNight(CHILD, DATE, { includeTimeline: true });
  assert.ok(!('scoring' in timeline));
  assert.equal(createHash('sha256').update(JSON.stringify(timeline)).digest('hex'), GOLDEN_TIMELINE_SHA256);
  assert.deepEqual(json(computeNight(CHILD, DATE, { includeTimeline: true, context: null })), json(timeline));
});

// --- 2. currentScoringContext is the one definition of "today" ----------------------------------------------

// Each setting a context records, changed one at a time: a named primary, Automatic, no enabled camera, the
// fallbacks for an empty timezone and window, a malformed window and an out-of-range one, tracking off.
const SETTINGS = [
  ['Automatic, first by sort_order', () => {}],
  ['a named primary', () => db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(CAM2, CHILD)],
  ['no enabled camera', () => db.prepare('UPDATE cameras SET disabled = 1').run()],
  ['empty timezone and window (the fallbacks)', () => { setTz(''); setWindow('', ''); }],
  ['a malformed and an out-of-range window', () => setWindow('not-a-time', '25:00')],
  ['another timezone and window', () => { setTz('Europe/London'); setWindow('20:15', '06:45'); }],
  ['tracking off', () => db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD)],
];

test('currentScoringContext is what step 1 stores, byte for byte, in every setting', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  for (const [label, apply] of SETTINGS) {
    apply();
    const current = currentScoringContext(CHILD);
    computeAndStoreNight(CHILD, DATE);
    assert.equal(JSON.stringify(current), storedRow().scoring_context, label);
    assert.deepEqual(parseScoringContext(storedRow().scoring_context), current, `${label}: and it parses back to itself`);
  }
});

test('replaying with currentScoringContext reproduces a plain computeNight exactly', (t) => {
  // The plain path resolves today's settings itself and the replay path takes them from a context. If the two
  // spellings of "today" ever drifted (a different tie-break, a different fallback), PR 3's "current" choice
  // would describe settings the plain compute does not use. Same-instant replay of today's context must equal it.
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  for (const [label, apply] of SETTINGS) {
    apply();
    for (const includeTimeline of [false, true]) {
      const plain = json(computeNight(CHILD, DATE, { includeTimeline }));
      const replay = json(computeNight(CHILD, DATE, { includeTimeline, context: currentScoringContext(CHILD) }));
      assert.deepEqual(omit(replay, 'scoring'), plain, `${label} (timeline ${includeTimeline})`);
    }
  }
});

// --- 3. replay per trigger: the stored context gives back the original numbers ------------------------------

test('replay: disabling the only camera, the #361 report, no longer turns the night into no_data', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA();
  const { original, ctx } = storeOriginal();
  assert.equal(original.status, 'ok', 'precondition: a scored night');
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  const { plain } = assertReplayed(original, ctx);
  assert.equal(plain.status, 'no_data', 'today: the report exactly');
});

test('replay: reassigning the camera to another child keeps the night on that camera', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original, ctx } = storeOriginal();
  assert.equal(original.analysis_camera_id, CAM, 'precondition');
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(CHILD2);
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD2, CAM);
  // The camera is looked up by id whoever owns it now; climate follows today's cameras (a stated limit, below).
  const { plain, replay } = assertReplayed(original, ctx, { except: ['climate'] });
  assert.equal(plain.analysis_camera_id, CAM2, 'today: the child is scored from the camera it still has');
  assert.equal(replay.analysis_camera_id, CAM);
  assert.equal(replay.analysis_camera_name, 'Bed cam', 'the name is looked up live');
});

test('replay: naming a different primary camera keeps the night on the camera it was scored from', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original, ctx } = storeOriginal();
  db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(CAM2, CHILD);
  const { plain } = assertReplayed(original, ctx);
  assert.equal(plain.analysis_camera_id, CAM2);
});

test('replay: dragging the tiles of an Automatic child keeps the night on the camera it was scored from', (t) => {
  // Not vacuous only with a child on Automatic (no named primary) and two ENABLED cameras: that is the one case in
  // which tile order decides the scored camera (#655).
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  assert.equal(db.prepare('SELECT primary_camera_id FROM children WHERE id = ?').get(CHILD).primary_camera_id, null);
  const { original, ctx } = storeOriginal();
  db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?').run(1, CAM);
  db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?').run(0, CAM2);
  const { plain } = assertReplayed(original, ctx);
  assert.equal(plain.analysis_camera_id, CAM2, 'today: the tile now first');
});

test('replay: changing the child window keeps the window the night was scored with', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA();
  const { original, ctx } = storeOriginal();
  setWindow('21:00', '06:00');
  const { plain, replay } = assertReplayed(original, ctx);
  assert.notEqual(plain.window_start, original.window_start, 'precondition');
  assert.equal(replay.window_start, '2026-07-01 09:30:00', '19:30 Melbourne, the stored window');
  assert.equal(replay.window_end, '2026-07-01 21:00:00');
});

test('replay: changing the app timezone keeps the zone the night was scored in', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA();
  const { original, ctx } = storeOriginal();
  setTz('Asia/Tokyo'); // UTC+9: the same 19:30-07:00 window lands an hour later in UTC
  const { plain, replay } = assertReplayed(original, ctx);
  assert.equal(plain.window_start, '2026-07-01 10:30:00', 'precondition: today the window moved');
  assert.equal(replay.window_start, original.window_start);
});

test('replay: a stored 25:00 window parses and replays identically to the original night', (t) => {
  // The writer stores pad(h):pad(m) of whatever parseHm read, with no range check, so a saved 25:00 (refused by the
  // route today, but an older install or a restored database can hold it) is a real v1 context: 19:30 to 01:00 the
  // next day. The parser must take it, and the replay must feed it to the window maths exactly as the original did.
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA();
  setWindow('19:30', '25:00');
  const { original, ctx } = storeOriginal();
  assert.deepEqual(ctx.window, { start: '19:30', end: '25:00' });
  assert.equal(original.window_end, '2026-07-01 15:00:00', 'precondition: 25:00 really scored it, as 01:00 the next day');
  setWindow('19:30', '07:00');
  assertReplayed(original, ctx);
});

// --- 4. the camera named by the context is missing, or there was none, or tracking is off --------------------

test('a deleted context camera is no_data with problem camera_deleted, never a fallback to the primary', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original, ctx } = storeOriginal();
  assert.equal(ctx.camera_id, CAM);
  // Only the camera row goes: its samples are still there, so "no_data" cannot come from missing samples.
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  const plain = json(computeNight(CHILD, DATE));
  assert.equal(plain.status, 'ok', 'precondition: the child has another camera with a scored night (a fallback would score)');
  assert.equal(plain.analysis_camera_id, CAM2);
  const replay = json(computeNight(CHILD, DATE, { context: ctx }));
  assert.equal(replay.status, 'no_data');
  assert.equal(replay.analysis_camera_id, null, 'no camera was analysed');
  assert.equal(replay.analysis_camera_name, null);
  assert.equal(replay.onset_at, null);
  assert.equal(replay.coverage_minutes, 0);
  assert.deepEqual(replay.scoring, { source: 'stored', algo: SCORING_ALGO, current_algo: SCORING_ALGO, algo_differs: false, problem: 'camera_deleted' });
  assert.notDeepEqual(numbers(replay), numbers(original));
});

test('precedence: tracking off wins over every context camera, and camera_id null is faithfully no_data', (t) => {
  // Plan refinement a: computeNight returns `off` BEFORE it looks at the camera, and a replay keeps that order.
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA(CAM);
  const ctxCam = currentScoringContext(CHILD);
  const ctxNone = { ...ctxCam, camera_id: null }; // what step 1 stores for a night with no enabled camera
  const ctxGone = { ...ctxCam, camera_id: 'rp-cam-deleted' };
  const replay = (ctx) => json(computeNight(CHILD, DATE, { context: ctx }));

  // Tracking ON.
  assert.equal(replay(ctxCam).status, 'ok', 'precondition: the context camera scores');
  const none = replay(ctxNone);
  assert.equal(none.status, 'no_data', 'camera_id null: no camera then, so no data now, even though today has one');
  assert.equal(none.analysis_camera_id, null);
  assert.equal(none.scoring.problem, null, 'not a deleted camera: there was none');
  assert.equal(json(computeNight(CHILD, DATE)).status, 'ok', 'precondition: a plain compute would score');
  const gone = replay(ctxGone);
  assert.equal(gone.status, 'no_data');
  assert.equal(gone.scoring.problem, 'camera_deleted');

  // Tracking OFF: `off` whatever the context says. `problem` still reports a missing camera, because the camera is
  // looked up before the `off` return, exactly as a plain compute resolves (and reports) its camera on an off night.
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  for (const [label, ctx, problem] of [['camera', ctxCam, null], ['null', ctxNone, null], ['deleted', ctxGone, 'camera_deleted']]) {
    const off = replay(ctx);
    assert.equal(off.status, 'off', label);
    assert.equal(off.scoring.problem, problem, label);
  }
  assert.equal(replay(ctxCam).analysis_camera_id, CAM, 'an off replay names its camera as a plain off night does');
});

test('algo_differs says the saved numbers came from other rules; the replay still runs today\'s rules', (t) => {
  // Plan revision 1: settings are replayable, rules are not. A context from older rules is re-scored with the
  // rules in this file and flagged, never "scored with rules N".
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  layA();
  const today = json(computeNight(CHILD, DATE, { context: currentScoringContext(CHILD) }));
  assert.equal(today.scoring.algo_differs, false);
  const older = json(computeNight(CHILD, DATE, { context: { ...currentScoringContext(CHILD), algo: 'older-rules' } }));
  assert.deepEqual(older.scoring, { source: 'stored', algo: 'older-rules', current_algo: SCORING_ALGO, algo_differs: true, problem: null });
  assert.deepEqual(omit(older, 'scoring'), omit(today, 'scoring'), 'the label changes nothing about the compute');
});

// --- 5. the parser accepts exactly what step 1 can write -----------------------------------------------------

const VALID = { v: 1, camera_id: CAM, tz: TZ, window: { start: '19:30', end: '07:00' }, algo: SCORING_ALGO };
const withWindow = (w) => ({ ...VALID, window: { ...VALID.window, ...w } });
const without = (key) => omit(VALID, key);

test('parseScoringContext: everything step 1 could not have written parses to null and never throws', () => {
  const MALFORMED = [
    ['undefined', undefined], ['null', null], ['a number', 42], ['true', true], ['an array', [VALID]],
    ['an empty string', ''], ['corrupt JSON', '{"v":1,'], ['JSON null', 'null'], ['a JSON array', '[]'],
    ['a JSON string', JSON.stringify(JSON.stringify(VALID))],
    ['v 2', { ...VALID, v: 2 }], ['v as a string', { ...VALID, v: '1' }],
    ['an extra key', { ...VALID, camera_source: 'auto' }],
    ...['v', 'camera_id', 'tz', 'window', 'algo'].map((k) => [`no ${k}`, without(k)]),
    ['a numeric camera', { ...VALID, camera_id: 7 }], ['an object camera', { ...VALID, camera_id: { id: CAM } }],
    ['a bad timezone', { ...VALID, tz: 'Not/AZone' }], ['an empty timezone', { ...VALID, tz: '' }],
    ['a padded timezone', { ...VALID, tz: ' UTC' }], ['a numeric timezone', { ...VALID, tz: 10 }],
    ['an empty algo', { ...VALID, algo: '' }], ['a numeric algo', { ...VALID, algo: 1 }],
    ['an overlong algo', { ...VALID, algo: 'x'.repeat(65) }],
    ['a window string', { ...VALID, window: '19:30-07:00' }], ['a null window', { ...VALID, window: null }],
    ['a window array', { ...VALID, window: ['19:30', '07:00'] }],
    ['a window without end', { ...VALID, window: { start: '19:30' } }],
    ['a window with an extra key', withWindow({ tz: TZ })],
    ['a negative hour', withWindow({ start: '-5:00' })], ['a negative minute', withWindow({ end: '07:-30' })],
    ['letters', withWindow({ start: 'ab:cd' })], ['an empty time', withWindow({ end: '' })],
    ['an hour only', withWindow({ start: '7' })], ['seconds', withWindow({ end: '07:00:00' })],
    ['a padded time', withWindow({ start: ' 19:30' })], ['a numeric time', withWindow({ start: 1930 })],
  ];
  for (const [label, raw] of MALFORMED) {
    let parsed;
    assert.doesNotThrow(() => { parsed = parseScoringContext(raw); }, label);
    assert.equal(parsed, null, label);
    if (raw !== null && typeof raw === 'object') {
      assert.equal(parseScoringContext(JSON.stringify(raw)), null, `${label}, as stored JSON`);
    }
  }
});

test('parseScoringContext accepts the step 1 shapes, from a string or an object alike, as a fresh object', () => {
  const fromString = parseScoringContext(JSON.stringify(VALID));
  assert.deepEqual(fromString, VALID);
  assert.deepEqual(Object.keys(fromString), ['v', 'camera_id', 'tz', 'window', 'algo'], 'step 1\'s key order');
  const fromObject = parseScoringContext(VALID);
  assert.deepEqual(fromObject, VALID);
  assert.notEqual(fromObject, VALID, 'a copy, so a caller cannot mutate the stored shape through it');
  assert.notEqual(fromObject.window, VALID.window);
  assert.deepEqual(parseScoringContext(fromObject), fromObject, 'idempotent');
  for (const ok of [
    { ...VALID, camera_id: null }, // a night with no enabled camera
    withWindow({ start: '25:00' }), withWindow({ end: '99:99' }), // digits:digits, no range check (refinement b)
    { ...VALID, tz: 'UTC' }, { ...VALID, tz: 'Europe/London' },
    { ...VALID, algo: 'x'.repeat(64) },
  ]) {
    assert.deepEqual(parseScoringContext(JSON.stringify(ok)), ok, JSON.stringify(ok));
  }
});

test('computeNight refuses a context that does not parse instead of silently using today\'s settings', () => {
  layA();
  for (const bad of [{ ...VALID, v: 2 }, 'not json', { ...VALID, tz: 'Not/AZone' }, false]) {
    assert.throws(() => computeNight(CHILD, DATE, { context: bad }), TypeError, JSON.stringify(bad));
  }
  // The stored JSON string itself is accepted (it is parsed the same way) and is the same replay as the object.
  const ctx = currentScoringContext(CHILD);
  assert.deepEqual(json(computeNight(CHILD, DATE, { context: JSON.stringify(ctx) })), json(computeNight(CHILD, DATE, { context: ctx })));
});

// --- 6. stated limits ------------------------------------------------------------------------------------------

test('known limit: climate still comes from the child\'s cameras today, not the context\'s', (t) => {
  // `cams` (room climate and the alert list) is context, not a score: it cannot move a reported time, so a replay
  // keeps today's cameras for it (plan, PR 2). Here the context camera has left the child, so the replay's climate
  // is the remaining camera's sensor, not the average the night was stored with.
  t.mock.timers.enable({ apis: ['Date'], now: NOON_AFTER });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original, ctx } = storeOriginal();
  assert.equal(original.climate.temp_avg, 19.8, 'precondition: both sensors averaged (21.5 and 18)');
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(CHILD2);
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD2, CAM);
  const replay = json(computeNight(CHILD, DATE, { context: ctx }));
  const plain = json(computeNight(CHILD, DATE));
  assert.deepEqual(numbers(replay), numbers(original), 'the score follows the context');
  assert.deepEqual(replay.climate, plain.climate, 'climate follows today');
  assert.equal(replay.climate.temp_avg, 18);
});

test('known limit: a camera that moved to another child within the night\'s span replays with that child\'s activity', (t) => {
  // Samples and bed transitions are selected by camera id and time, not by who owned the camera at that time, and
  // no ownership-at-time table exists (plan revision 7). So a replay of a night whose camera moved to another child
  // INSIDE the span it reads ([window start - 3 h, window end + 3 h)) counts what that camera saw after the move.
  // A camera that moved after the span is replayed correctly (second half).

  // (a) Moved mid-night. The night was stored while in progress at 01:00 (an admin `?store=1`, or the demo seed),
  // so its context names the camera. The camera then moves to another child and sees an awakening at 03:00 there.
  t.mock.timers.enable({ apis: ['Date'], now: at(1, 0, 1).getTime() });
  layMinutes(CAM, [[at(19, 30), at(19, 40)]], at(18, 20), at(1, 0, 1));
  const { ctx } = storeOriginal();
  assert.equal(ctx.camera_id, CAM);
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(CHILD2);
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD2, CAM);
  layMinutes(CAM, [[at(3, 0, 1), at(3, 20, 1)]], at(1, 0, 1), at(7, 0, 1)); // the other child's room
  t.mock.timers.setTime(NOON_AFTER);
  const moved = json(computeNight(CHILD, DATE, { context: ctx, includeTimeline: true }));
  assert.equal(moved.status, 'ok');
  assert.equal(moved.wake_count, 1, 'the other child\'s 03:00 awakening is counted in this child\'s night');
  assert.ok(moved.wakes.some((w) => w.start_at === sqlTime(at(3, 0, 1))), JSON.stringify(moved.wakes));

  // (b) Moved after the span (10:00 local here): nothing the replay reads was recorded after the move.
  for (const tbl of ['sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions']) db.prepare(`DELETE FROM ${tbl}`).run();
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD, CAM);
  layA(CAM);
  const { original, ctx: ctxAfter } = storeOriginal();
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD2, CAM);
  layMinutes(CAM, [[at(12, 0, 1), at(12, 30, 1)]], at(12, 0, 1), at(13, 0, 1));
  outOfBed(CAM, at(12, 10, 1));
  t.mock.timers.setTime(at(14, 0, 1).getTime());
  const after = json(computeNight(CHILD, DATE, { context: ctxAfter }));
  // Climate follows today's cameras (the limit above): the child has none now.
  assert.deepEqual(omit(after, 'scoring', 'climate'), omit(original, 'climate'));
});
