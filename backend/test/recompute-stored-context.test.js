// #361 PR 3: the admin Recompute can re-score a night WITH the settings it was saved with (`?context=stored`).
//
// Why: step 1 (#808) stores, beside every night, the camera, timezone, window and rules version that produced it,
// and step 2 (#810) taught computeNight to replay one. Nothing passed one, so a night whose camera had since been
// turned off, moved to another child, demoted by a new main camera or dragged down the tile order could only be
// recomputed into `no_data` or another camera's numbers. This PR is the first caller:
//   - GET /children/:id/sleep/:date?context=stored|current (absent = current = exactly what it always did);
//     `raw=1` (only with `context`) leaves a parent's correction off the answer;
//   - the same param on `?store=1` (admin), plus `expect_context` (the stored string the dialog was shown);
//   - `?stored=1` gains `contexts` (the two contexts, whether they differ, live camera names);
//   - computeAndStoreNight(..., { context }) writes the replayed context with TODAY's rules label, and refuses a
//     replay whose camera is gone (`stored_camera_missing`) whatever `allowDowngrade` says.
// Plan: ~/.claude/plans/ticklish-mixing-moore.md (incl. revisions R1-R3), design planning/361-scoring-context.md.
//
// ⚠️ HOSTILE FIXTURES: the settings a night was stored with and today's differ on purpose (camera, timezone, window,
// each alone and all three at once), and the two cameras saw different nights (A and B differ on every number), so
// a route or writer that ignores any one of them cannot pass by accident. Camera and child names are neutral: the
// repo is public.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeNight, computeAndStoreNight, runNightlySleepJob, SCORING_ALGO, parseScoringContext, currentScoringContext } =
  await import('../src/lib/sleepAnalysis.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { default: childrenRouter } = await import('../src/routes/children.js');
const { logger } = await import('../src/lib/logger.js');

const CHILD = 'sc-child';
const CHILD2 = 'sc-child-2';
const CAM = 'sc-cam-a';
const CAM2 = 'sc-cam-b';
const DATE = '2026-07-01';
// A non-UTC zone with no DST edge near the fixture night (UTC+10 in July), so `at()` is plain arithmetic and a
// hard-coded 'UTC' anywhere cannot pass.
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const exactSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// The numbers a person sees for a night: what the replay tests assert, not only a status.
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
// 20:10, one awakening 01:00-01:15, up at 05:30. Different on every number (the same pair as
// scoring-context-replay.test.js), so a replay that reads the wrong camera cannot match by accident.
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
const rowOf = () => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);
const rowCount = () => db.prepare('SELECT COUNT(*) c FROM sleep_nights WHERE child_id = ?').get(CHILD).c;
const setRowContext = (raw) =>
  db.prepare('UPDATE sleep_nights SET scoring_context = ? WHERE child_id = ? AND night_date = ?').run(raw, CHILD, DATE);

const get = (query, token = adminToken) => call(`${server.url}/api/children/${CHILD}/sleep/${DATE}${query}`, { token });

// Store the night as the nightly job would (no context: today's settings), and hand back its numbers and the
// stored context string. Fails loudly if no context was stored, so a missing write cannot look like a match.
function storeOriginal() {
  const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(summary.stored, true, 'precondition: the original night was stored');
  const raw = rowOf().scoring_context;
  assert.ok(parseScoringContext(raw), `precondition: the stored context parses: ${raw}`);
  return { original: numbers(summary), raw };
}
// Plant figures no compute produces, keeping the stored context, so a re-store is OBSERVABLE: after it the row must
// hold the replay's numbers again, which a refused or skipped write cannot fake.
const staleRow = () =>
  db.prepare(`UPDATE sleep_nights SET onset_at = '2026-07-01 08:01:00', asleep_minutes = 1, wake_count = 9,
                computed_at = 'PINNED' WHERE child_id = ? AND night_date = ?`).run(CHILD, DATE);

before(async () => {
  const admin = makeUser(db, { id: 'u-sc-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-sc-c', username: 'carer', role: 'caregiver' });
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
              VALUES (?, 'Context Kid', 1, '19:30', '07:00')`).run(CHILD);
  addCamera(CAM, CHILD, 0, 'Bed cam');
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- 1-2. the stored settings are what a stored-settings save re-scores with, one trigger at a time ----------

test('a disabled camera (the #361 report): context=stored re-stores the SAME numbers from it; the default is still refused', async () => {
  layA(CAM);
  const { original } = storeOriginal();
  assert.equal(original.status, 'ok', 'precondition: a scored night');
  staleRow();
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);

  // The default (no param) is exactly today's: no enabled camera, so no_data, refused over the scored row. The
  // `aged_out` wording for a camera that is merely off is the pre-existing imprecision the route's comment states.
  const before = rowOf();
  const plain = await get('?store=1&detail=1');
  assert.equal(plain.status, 409);
  assert.equal(plain.body.reason, 'aged_out');
  assert.deepEqual(rowOf(), before, 'the default path wrote nothing');

  const res = await get('?store=1&detail=1&context=stored');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.stored, true);
  assert.deepEqual(numbers(res.body), original, 'the numbers the night was first saved with');
  assert.deepEqual(numbers(rowOf()), original, 'and they are what the row now holds');
  assert.notEqual(rowOf().computed_at, 'PINNED', 'the row really was written');
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, CAM, 'the written context keeps the stored camera');
  assert.equal(res.body.analysis_camera_id, CAM);
  assert.deepEqual(res.body.scoring, { source: 'stored', algo: SCORING_ALGO, current_algo: SCORING_ALGO, algo_differs: false, problem: null });
});

// The other triggers. Each changes ONE setting, checks that today's settings really give other numbers (a plain read
// AND, at the end, a default store), and that the stored-settings save gives back the original numbers.
const TRIGGERS = [
  ['another camera is now the main one', () => setPrimary(CAM2)],
  ['the sleep window changed', () => setWindow('21:00', '06:00')],
  ['the app timezone changed', () => setTz('Asia/Tokyo')],
];
for (const [label, change] of TRIGGERS) {
  test(`${label}: context=stored re-stores the original numbers; the default still re-scores with today's settings`, async () => {
    addCamera(CAM2, CHILD, 1, 'Door cam');
    layA(CAM);
    layB(CAM2);
    const { original } = storeOriginal();
    staleRow();
    change();

    const today = await get('');
    assert.equal(today.status, 200);
    assert.notDeepEqual(numbers(today.body), original, 'precondition: today\'s settings give other numbers');

    const res = await get('?store=1&detail=1&context=stored');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(numbers(res.body), original);
    assert.deepEqual(numbers(rowOf()), original);

    // And the default is untouched by any of this: it stores today's numbers, as it always did.
    const plain = await get('?store=1&detail=1');
    assert.equal(plain.status, 200);
    assert.deepEqual(numbers(rowOf()), numbers(today.body), 'the default writes today\'s settings\' numbers');
    assert.notDeepEqual(numbers(rowOf()), original);
  });
}

// --- 3. what a stored-settings save WRITES -------------------------------------------------------------------

test('the written context is the stored camera, timezone and window with TODAY\'s algo, and it round-trips', async () => {
  // All three settings differ from today's at once, and the stored row carries an older rules label: a writer
  // that took ANY of the three from today's settings, or copied the stored label, gets a different string.
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original, raw } = storeOriginal();
  const older = { ...parseScoringContext(raw), algo: 'older-rules' };
  setRowContext(JSON.stringify(older));
  setPrimary(CAM2);
  setTz('Asia/Tokyo');
  setWindow('20:15', '06:45');
  const today = currentScoringContext(CHILD);
  assert.equal(today.camera_id, CAM2, 'precondition: today differs on the camera');
  assert.equal(today.tz, 'Asia/Tokyo', 'precondition: and the timezone');
  assert.deepEqual(today.window, { start: '20:15', end: '06:45' }, 'precondition: and the window');

  const res = await get('?store=1&context=stored');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(numbers(rowOf()), original);
  assert.equal(res.body.scoring.algo_differs, true, 'the replay says the saved numbers came from other rules');
  // Byte for byte: step 1's key order, the stored settings, today's rules label.
  const algo = JSON.stringify(SCORING_ALGO);
  assert.equal(rowOf().scoring_context,
    `{"v":1,"camera_id":"${CAM}","tz":"${TZ}","window":{"start":"19:30","end":"07:00"},"algo":${algo}}`);
  assert.deepEqual(parseScoringContext(rowOf().scoring_context), { ...older, algo: SCORING_ALGO }, 'it parses back');
  // The written camera is the one the numbers came from (the summary's), not merely the context's id.
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, res.body.analysis_camera_id);
});

test('lib: computeAndStoreNight normalises a context object to step 1\'s key order and refuses garbage before computing', () => {
  layA(CAM);
  const { raw } = storeOriginal();
  const ctx = parseScoringContext(raw);
  // The same context with its keys in another order (an API caller's object): the stored string is still step 1's.
  const shuffled = { algo: ctx.algo, window: { end: ctx.window.end, start: ctx.window.start }, tz: ctx.tz, camera_id: ctx.camera_id, v: 1 };
  staleRow();
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false, context: shuffled });
  assert.equal(rowOf().scoring_context, raw);
  const before = rowOf();
  for (const bad of [{ ...ctx, v: 2 }, 'not json', false]) {
    assert.throws(() => computeAndStoreNight(CHILD, DATE, { context: bad }), TypeError, JSON.stringify(bad));
  }
  assert.deepEqual(rowOf(), before, 'a refused context wrote nothing');
});

// --- 4. no usable stored context, or a bad param: a readable 400, nothing written ----------------------------

test('context=stored with no saved row, a NULL (legacy) column or an unreadable one is a 400 no_stored_context, nothing written', async () => {
  layA(CAM);
  // No saved row at all.
  for (const q of ['?context=stored', '?store=1&context=stored']) {
    const res = await get(q);
    assert.equal(res.status, 400, q);
    assert.equal(res.body.reason, 'no_stored_context', q);
    assert.match(res.body.error, /Recompute it with the current settings instead/, q);
  }
  assert.equal(rowCount(), 0, 'no row was created');

  storeOriginal();
  for (const [label, raw] of [['NULL (saved before #361)', null], ['corrupt JSON', '{"v":1,'], ['a v2 shape', '{"v":2}']]) {
    setRowContext(raw);
    const before = rowOf();
    for (const q of ['?context=stored&raw=1', '?store=1&detail=1&context=stored']) {
      const res = await get(q);
      assert.equal(res.status, 400, `${label} ${q}`);
      assert.equal(res.body.reason, 'no_stored_context', `${label} ${q}`);
      assert.deepEqual(rowOf(), before, `${label} ${q}: the row is byte-for-byte unchanged`);
    }
  }
});

test('an unknown context value is a 400 before anything is computed or written, with or without store=1', async () => {
  layA(CAM);
  for (const q of ['?context=banana', '?store=1&context=banana', '?store=1&context=Stored', '?store=1&context=stored&context=current', '?store=1&context=']) {
    const res = await get(q);
    assert.equal(res.status, 400, q);
    assert.match(res.body.error, /context must be "stored" or "current"/, q);
  }
  assert.equal(rowCount(), 0, 'no row was created');
  storeOriginal();
  staleRow();
  const before = rowOf();
  const res = await get('?store=1&context=banana');
  assert.equal(res.status, 400);
  assert.deepEqual(rowOf(), before, 'the stale row was not re-stored');
  // `stored=1` still wins: it returns before the param is read.
  assert.equal((await get('?stored=1&context=banana')).status, 200);
});

// An equivalence pin, not a feature test: it passes on the code before #361 PR 3 too (that code ignored the
// param). It is here to fail if `current` ever stops meaning "exactly the default" (a default flipped to the
// stored settings, or `current` read as `stored`).
test('context=current is exactly the default: the same answer for a read, and the same write for a store', async () => {
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  storeOriginal();
  setPrimary(CAM2);
  const plain = await get('?detail=1');
  const current = await get('?detail=1&context=current');
  assert.deepEqual(current.body, plain.body);
  assert.ok(!('scoring' in plain.body), 'no scoring block on the default path');
  await get('?store=1&context=current');
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, CAM2, 'today\'s camera, as the default writes');
});

// --- 5. the stored camera no longer exists ----------------------------------------------------------------

test('a deleted stored camera: store is a 409 stored_camera_missing ALWAYS (over a scored and an unscored row), a read says no_data + camera_deleted', async () => {
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { raw } = storeOriginal();
  // Only the camera row goes (its samples stay), and the child keeps a camera that would score: a fallback to
  // today's main camera would store an `ok` night.
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);

  const before = rowOf();
  const res = await get('?store=1&detail=1&context=stored');
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'stored_camera_missing');
  assert.match(res.body.error, /no longer exists/);
  assert.match(res.body.error, /Nothing was saved/);
  assert.deepEqual(rowOf(), before, 'over a scored row: unchanged');

  // Over an UNSCORED row the downgrade guard would let a no_data store through; this refusal must not.
  db.prepare("UPDATE sleep_nights SET status = 'no_data' WHERE child_id = ?").run(CHILD);
  const unscored = rowOf();
  const again = await get('?store=1&context=stored');
  assert.equal(again.status, 409);
  assert.equal(again.body.reason, 'stored_camera_missing');
  assert.deepEqual(rowOf(), unscored, 'over an unscored row: unchanged');

  // And at the lib level with every downgrade guard off (`allowDowngrade: true`): still refused.
  const lib = computeAndStoreNight(CHILD, DATE, { context: raw });
  assert.equal(lib.stored, false);
  assert.equal(lib.refused, 'stored_camera_missing');
  assert.deepEqual(rowOf(), unscored);

  const read = await get('?context=stored&raw=1');
  assert.equal(read.status, 200);
  assert.equal(read.body.status, 'no_data');
  assert.equal(read.body.scoring.problem, 'camera_deleted');
  assert.equal(read.body.analysis_camera_id, null);
});

// --- 6. precedence: the other refusals keep their meaning under a stored context ---------------------------

test('precedence: a locked night is `reviewed` even when its stored camera is also gone', async () => {
  layA(CAM);
  storeOriginal();
  db.prepare("INSERT INTO sleep_reviews (child_id, night_date, true_wake_at) VALUES (?, ?, '2026-07-01 20:10:00')").run(CHILD, DATE);
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  const before = rowOf();
  const res = await get('?store=1&context=stored');
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'reviewed');
  assert.deepEqual(rowOf(), before);
  // Sanity: without the lock the same request IS the camera refusal, so the order above is what decided it.
  db.prepare('DELETE FROM sleep_reviews').run();
  assert.equal((await get('?store=1&context=stored')).body.reason, 'stored_camera_missing');
});

// Both downgrade guards are judged on the REPLAY's answer. Hostile: today's settings (another main camera, whose
// night scores with a wake) would store fine, so a route that dropped the context, or a guard skipped for a replay,
// would write and fail these.
test('precedence: would_downgrade still fires under a stored context (the stored camera\'s data has aged out)', async () => {
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original } = storeOriginal();
  setPrimary(CAM2);
  db.prepare('DELETE FROM activity_samples WHERE camera_id = ?').run(CAM);
  assert.equal(computeNight(CHILD, DATE).status, 'ok', 'precondition: today\'s settings would score and store');
  const before = rowOf();
  const res = await get('?store=1&context=stored');
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'aged_out');
  assert.equal(res.body.status, 'no_data');
  assert.deepEqual(rowOf(), before);
  assert.deepEqual(numbers(rowOf()), original);
});

test('precedence: would_blank_notified_wake still fires under a stored context', async () => {
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  storeOriginal();
  db.prepare("UPDATE sleep_nights SET notified_wake_at = wake_at WHERE child_id = ?").run(CHILD);
  setPrimary(CAM2);
  // The stored camera's morning movement and out-of-bed event go: its replay still scores the night, but finds no
  // wake. Today's camera keeps its own wake.
  db.prepare('UPDATE activity_samples SET motion_level = 0.004, motion_peak = 0.004 WHERE camera_id = ? AND bucket_start >= ?')
    .run(CAM, sqlTime(at(5, 0, 1)));
  db.prepare('DELETE FROM bed_transitions WHERE camera_id = ?').run(CAM);
  const replay = computeNight(CHILD, DATE, { context: rowOf().scoring_context });
  assert.equal(replay.status, 'ok', 'precondition: still a scored night');
  assert.equal(replay.wake_at, null, 'precondition: with no wake');
  assert.notEqual(computeNight(CHILD, DATE).wake_at, null, 'precondition: today\'s settings have a wake (they would store)');
  const before = rowOf();
  const res = await get('?store=1&context=stored');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /wake time a parent was notified about/);
  assert.deepEqual(rowOf(), before);
});

// --- 7. reads write nothing; a caregiver cannot store; the correction overlay and raw=1 ---------------------

test('a context=stored read writes nothing, and a caregiver\'s store=1&context=stored computes but stores nothing', async () => {
  layA(CAM);
  const { original } = storeOriginal();
  staleRow();
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  const before = rowOf();
  for (const q of ['?context=stored', '?detail=1&context=stored&raw=1']) {
    const res = await get(q);
    assert.equal(res.status, 200, q);
    assert.deepEqual(numbers(res.body), original, `${q}: the replay`);
    assert.deepEqual(rowOf(), before, `${q}: nothing written`);
  }
  const care = await get('?store=1&context=stored', caregiverToken);
  assert.equal(care.status, 200);
  assert.equal(care.body.stored, undefined, 'a read, not a store');
  assert.deepEqual(numbers(care.body), original);
  assert.deepEqual(rowOf(), before, 'a caregiver wrote nothing');
});

test('a context read is overlaid by a parent\'s correction like every normal read; raw=1 is not; raw=1 without context is ignored', async () => {
  // A corrected night whose saved row is UNSCORED is not locked, so it is still recompute-eligible (the plan's
  // "PR 3/4 notes"): the dialog's preview must show what a store would write, which is the detector's answer.
  layA(CAM);
  const { original } = storeOriginal();
  db.prepare("UPDATE sleep_nights SET status = 'no_data' WHERE child_id = ?").run(CHILD);
  const typed = '2026-07-01 10:05:00';
  db.prepare('INSERT INTO sleep_reviews (child_id, night_date, true_onset_at) VALUES (?, ?, ?)').run(CHILD, DATE, typed);
  assert.equal((await get('?stored=1')).body.locked, false, 'precondition: not locked');
  assert.notEqual(original.onset_at, typed, 'precondition: the correction differs from the detector');

  const overlaid = await get('?context=stored');
  assert.equal(overlaid.body.onset_at, typed);
  assert.equal(overlaid.body.corrected, true);

  const raw = await get('?context=stored&raw=1');
  assert.equal(raw.body.onset_at, original.onset_at);
  assert.ok(!('corrected' in raw.body), 'no overlay at all');
  assert.deepEqual(numbers(raw.body), { ...original });

  // raw=1 means nothing without `context`: the existing paths are untouched.
  const plainRaw = await get('?raw=1');
  assert.equal(plainRaw.body.onset_at, typed);
  assert.equal(plainRaw.body.corrected, true);
});

// --- R2: the save is bound to the context the dialog previewed --------------------------------------------

test('expect_context: a save whose previewed context was replaced in the meantime is a 409 context_changed, nothing written', async () => {
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { raw } = storeOriginal();
  // What the dialog was shown when it opened.
  const shown = (await get('?stored=1')).body.night.scoring_context;
  assert.equal(shown, raw);
  // Another phone re-saves the night with another VALID context (today's main camera changed).
  setPrimary(CAM2);
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, CAM2, 'precondition: the context really changed');
  const before = rowOf();

  const res = await get(`?store=1&detail=1&context=stored&expect_context=${encodeURIComponent(shown)}`);
  assert.equal(res.status, 409);
  assert.equal(res.body.reason, 'context_changed');
  assert.match(res.body.error, /saved again while you were looking at it/);
  assert.deepEqual(rowOf(), before, 'nothing written');

  // The matching string is accepted (and a read ignores the param).
  const ok = await get(`?store=1&context=stored&expect_context=${encodeURIComponent(rowOf().scoring_context)}`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await get(`?context=stored&expect_context=${encodeURIComponent(shown)}`)).status, 200);
});

// --- 8. `contexts` on ?stored=1 ----------------------------------------------------------------------------

test('?stored=1 adds `contexts`: none for no row and a legacy NULL row, unreadable for a corrupt one', async () => {
  layA(CAM);
  let res = await get('?stored=1');
  assert.equal(res.body.night, null);
  assert.equal(res.body.locked, false);
  assert.deepEqual(res.body.contexts, {
    stored_state: 'none', stored: null, current: currentScoringContext(CHILD), differs: false,
    camera_names: { stored: null, current: 'Bed cam' },
  });

  storeOriginal();
  setRowContext(null);
  res = await get('?stored=1');
  assert.equal(res.body.night.status, 'ok', 'the saved row is still returned whole');
  assert.equal(res.body.contexts.stored_state, 'none', 'a legacy row');
  assert.equal(res.body.contexts.differs, false);

  setRowContext('{"v":1,');
  res = await get('?stored=1');
  assert.equal(res.body.contexts.stored_state, 'unreadable');
  assert.equal(res.body.contexts.stored, null);
  assert.equal(res.body.contexts.differs, false);
  assert.equal(res.body.night.scoring_context, '{"v":1,', 'the raw string is still on the row, as before');
});

test('?stored=1 `differs` is true for the camera, the timezone or the window ALONE, and false when identical or only the rules label differs', async () => {
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  const { raw } = storeOriginal();
  const differs = async () => (await get('?stored=1')).body.contexts;

  let c = await differs();
  assert.equal(c.stored_state, 'ok');
  assert.deepEqual(c.stored, parseScoringContext(raw));
  assert.equal(c.differs, false, 'identical');

  setRowContext(JSON.stringify({ ...parseScoringContext(raw), algo: 'older-rules' }));
  c = await differs();
  assert.equal(c.differs, false, 'only the rules label: the re-score uses today\'s rules either way');
  setRowContext(raw);

  // Each setting alone, then put back.
  for (const [label, change, undo] of [
    ['camera', () => setPrimary(CAM2), () => setPrimary(null)],
    ['timezone', () => setTz('Asia/Tokyo'), () => setTz(TZ)],
    ['window start', () => setWindow('20:00', '07:00'), () => setWindow('19:30', '07:00')],
    ['window end', () => setWindow('19:30', '06:30'), () => setWindow('19:30', '07:00')],
  ]) {
    change();
    assert.equal((await differs()).differs, true, label);
    undo();
    assert.equal((await differs()).differs, false, `${label}: back to identical`);
  }

  // The window is compared as the EFFECTIVE time: a hand-written `7:5`-style value equals its padded form.
  setRowContext(JSON.stringify({ ...parseScoringContext(raw), window: { start: '19:30', end: '7:0' } }));
  assert.equal((await differs()).differs, false, 'unpadded digits read the same');
});

test('?stored=1 camera names are looked up live, and `contexts` carries no other camera field', async () => {
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  storeOriginal();
  setPrimary(CAM2);
  db.prepare("UPDATE cameras SET name = 'Renamed cam' WHERE id = ?").run(CAM);
  // A marker in every TEXT column of both cameras that could carry an address, a credential or anything else
  // (derived from the schema, not a typed list), except the id and name the answer is allowed to carry and the
  // child link the lookup needs. A NULL that leaked would look like a field correctly left out, so every field
  // gets a value.
  const cols = db.prepare('PRAGMA table_info(cameras)').all()
    .filter((c) => /TEXT/i.test(c.type) && !['id', 'name', 'child_id'].includes(c.name));
  assert.ok(cols.length >= 3, `precondition: the schema has text columns to plant in (${cols.map((c) => c.name)})`);
  for (const cam of [CAM, CAM2]) {
    for (const c of cols) {
      try {
        db.prepare(`UPDATE cameras SET ${c.name} = ? WHERE id = ?`).run(`MARK-${c.name}-${cam}`, cam);
      } catch { /* a constrained column keeps its value; the rest still carry the marker */ }
    }
  }
  const res = await get('?stored=1');
  assert.equal(res.status, 200);
  const c = res.body.contexts;
  assert.deepEqual(c.camera_names, { stored: 'Renamed cam', current: 'Door cam' }, 'names follow a rename');
  assert.deepEqual(Object.keys(c).sort(), ['camera_names', 'current', 'differs', 'stored', 'stored_state']);
  assert.deepEqual(Object.keys(c.camera_names).sort(), ['current', 'stored']);
  for (const side of [c.stored, c.current]) {
    assert.deepEqual(Object.keys(side).sort(), ['algo', 'camera_id', 'tz', 'v', 'window']);
  }
  assert.doesNotMatch(JSON.stringify(res.body), /MARK-/, 'no other camera field anywhere in the answer');
  // A camera that no longer exists has no name (the dialog says so); the id is still the stored one.
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  const gone = (await get('?stored=1')).body.contexts;
  assert.equal(gone.camera_names.stored, null);
  assert.equal(gone.stored.camera_id, CAM);
  // And the camera of another child is named too: a stored camera is looked up whoever owns it now.
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES (?, 'Other Kid', 1)").run(CHILD2);
  addCamera(CAM, CHILD2, 0, 'Moved cam');
  assert.equal((await get('?stored=1')).body.contexts.camera_names.stored, 'Moved cam');
});

// --- 9. the stated limit: the nightly job re-stores a provisional night with TODAY's settings ----------------

test('known limit: within ~3 h of the window closing, the nightly job re-stores the night with today\'s settings again', (t) => {
  // docs/sleep-tracking.md states it: a stored-settings save on last night, while that night is still provisional,
  // is replaced by the job's next pass, which (like every caller but the Recompute opt-in) passes no context.
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 30, 1).getTime() });
  addCamera(CAM2, CHILD, 1, 'Door cam');
  layA(CAM);
  layB(CAM2);
  const { original, raw } = storeOriginal(); // CAM, at 07:30: provisional (the evidence horizon is 10:00)
  setPrimary(CAM2);
  const saved = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false, context: raw });
  assert.equal(saved.stored, true);
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, CAM, 'the stored-settings save wrote the stored camera');
  assert.deepEqual(numbers(rowOf()), original);

  const info = t.mock.method(logger, 'info', () => {});
  t.mock.timers.tick(30 * 60000);
  runNightlySleepJob();
  info.mock.restore();
  assert.equal(JSON.parse(rowOf().scoring_context).camera_id, CAM2, 'the job wrote today\'s camera back');
  assert.notDeepEqual(numbers(rowOf()), original, 'and today\'s numbers');
});
