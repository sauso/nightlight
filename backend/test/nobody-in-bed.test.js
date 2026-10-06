// "No one was in the bed" — a parent overruling the detector's WHOLE night (added 2026-09-29).
//
// Why it exists: on 2026-09-28 the detector reported a child asleep 19:52-07:20, 628 minutes, status
// `ok`, in a bed nobody slept in. The correction flow could only move times, so the owner saved a review
// with nothing in it. This is the missing answer.
//
// The design is the one time corrections already use, and these tests pin the parts of it that are easy
// to get subtly wrong:
//   - it is an OVERLAY (applyCorrection), never a write to sleep_nights, so a recompute or the nightly job
//     cannot fight the parent and un-flagging restores the detector's night exactly;
//   - the overlaid night must be SHAPED like a real detector-`empty` night, down to which keys exist, or
//     every screen that already understands `empty` would be reading a hybrid it was never written for;
//   - "flag" and "times" are mutually exclusive, and the newest answer wins;
//   - readers that bypass the overlay (sleepInsights) must still honour it.
//
// ⚠️ The shape tests read the SCHEMA and REAL detector output, never a hand-typed list of fields. A
// clean fixture proves nothing: a NULL that leaks looks exactly like a field correctly stripped, so the
// stored-row test plants a marker in every column PRAGMA reports.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight, computeNight, sleepInsights, lastCompletedNightDate, currentNightDate } =
  await import('../src/lib/sleepAnalysis.js');
const { saveNightReview, applyCorrection, reviewCardState } = await import('../src/lib/sleepReviews.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'nib-child';
const CAM = 'nib-cam';
const DATE = '2026-07-01'; // a night the fixture makes plainly occupied (`ok`)
const EMPTY_DATE = '2026-07-03'; // a night the fixture makes plainly empty (detector `empty`)
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne in July: UTC+10, no DST edge anywhere near

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const exactSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// The fields an overlay adds on top of a detector-shaped night. Everything else must be exactly what a
// detector-`empty` night carries. `nobody_in_bed` is added post-review (code-review finding: a time
// correction on an already-`empty` night also sets `corrected`, so the frontend needs a field that's
// true ONLY on this path) — it does not appear on a time-corrected night, see the test below.
const OVERLAY_KEYS = ['corrected', 'algo_status', 'algo_onset_at', 'algo_wake_at', 'nobody_in_bed'];

let server;
let adminToken;
let caregiverToken;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertReading = db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, ?, ?, ?)');

// A night that scores `ok`: plainly occupied, settling until 19:40, up from 06:00. morning-review.test.js's
// laySamples, except the morning movement runs on to the window's close: stopping at 06:20 (as there)
// leaves the detector reporting NO wake time, and a null wake_at cannot show whether the overlay kept
// the detector's wake as algo_wake_at or dropped it.
function layOkNight() {
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    const moving = (t >= at(19, 30) && t < at(19, 40)) || (t >= at(6, 0, 1) && t < at(7, 0, 1));
    insertSample.run(CAM, sqlTime(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
  // A room reading, so `climate`/`avg_temperature` are REAL values an overlay could wrongly null. Left
  // null, "kept" and "nulled" would be indistinguishable for them.
  insertReading.run(CAM, 21.5, 48, exactSql(at(23, 0)));
}

// A night the detector itself scores `empty`: full coverage, and not a flicker in the bed all night.
function layEmptyNight() {
  for (let t = at(18, 20, 2); t < at(7, 0, 3); t = new Date(t.getTime() + 60000)) {
    insertSample.run(CAM, sqlTime(t), 0.004, 0.004);
  }
  insertReading.run(CAM, 19.5, 52, exactSql(at(23, 0, 2)));
}

// Inserted directly: recordBedTransition sweeps rows older than 45 days, and this night is months old.
function layTransition(type, when) {
  return db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run(CAM, type, when).lastInsertRowid;
}

const reviewUrl = (date = DATE) => `${server.url}/api/children/${CHILD}/review/${date}`;
const put = (body, { token = adminToken, date = DATE } = {}) => call(reviewUrl(date), { method: 'PUT', token, body });
const get = (path, token = adminToken) => call(`${server.url}/api/children/${CHILD}${path}`, { token });
const reviewRow = (date = DATE) => db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const storedRow = (date = DATE) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);
const json = (v) => JSON.parse(JSON.stringify(v)); // what a client actually receives

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
              VALUES (?, 'Bed Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p', 0, 0)`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- 1. saving it ---------------------------------------------------------------------------------

test('saving "no one was in the bed" stores the flag and NULLs every time a previous review had', async () => {
  layOkNight();
  const wakeFrame = layTransition(TRANSITION.OUT_OF_BED, exactSql(at(6, 0, 1)));
  // A previous, time-based answer to the same night, including a NAMED FRAME — all four columns the
  // flag has to clear are populated, so a survivor among them is visible.
  const first = await put({ true_onset_local: '19:40', true_wake_transition_id: wakeFrame, note: 'kept' });
  assert.equal(first.status, 200);
  assert.ok(first.body.review.true_onset_at && first.body.review.true_wake_at, 'precondition: times stored');
  assert.equal(first.body.review.true_wake_transition_id, wakeFrame, 'precondition: frame id stored');

  const res = await put({ nobody_in_bed: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.review.nobody_in_bed, 1, 'the PUT response carries the new column (additively)');
  for (const col of ['true_onset_at', 'true_wake_at', 'true_onset_transition_id', 'true_wake_transition_id']) {
    assert.equal(res.body.review[col], null, `${col} must be cleared — flag + times is a contradiction`);
  }
  assert.equal(res.body.review.note, 'kept', 'the note is not a time, and survives');
  assert.ok(db.prepare('SELECT 1 FROM bed_transitions WHERE id = ?').get(wakeFrame),
    'un-naming a frame is not deleting it: the transition (and its snapshot) stays');

  const shown = await get(`/review/${DATE}`);
  assert.equal(shown.body.review.nobody_in_bed, 1, 'GET review returns it');
  assert.equal(shown.body.review.true_onset_at, null);
  assert.equal(shown.body.computed.status, 'ok', 'the review screen still shows what the DETECTOR said');
});

// --- 2. it reaches every read of the night ------------------------------------------------------------

test('the flag reaches /sleep?nights, /sleep/:date (with and without detail) and /sleep/live', async () => {
  // Fails with the old `if (!r.true_onset_at && !r.true_wake_at) return night` early return in place:
  // the flag carries no times, so that line would pass the detector's ok night through untouched.
  layOkNight();
  const stored = computeAndStoreNight(CHILD, DATE);
  assert.equal(stored.status, 'ok', 'precondition: the detector scored this night as sleep');
  assert.ok(stored.onset_at && stored.wake_at);

  assert.equal((await put({ nobody_in_bed: true })).status, 200);

  const check = (night, where) => {
    assert.equal(night.status, 'empty', `${where}: shown as empty`);
    assert.equal(night.corrected, true, `${where}: and says a person corrected it`);
    assert.equal(night.algo_status, 'ok', `${where}: with the detector's own verdict kept alongside`);
    assert.equal(night.algo_onset_at, stored.onset_at, `${where}: and its times`);
    assert.equal(night.algo_wake_at, stored.wake_at, `${where}`);
    assert.equal(night.onset_at, null, `${where}: no sleep is claimed`);
    assert.equal(night.wake_at, null, `${where}`);
    assert.equal(night.asleep_minutes, null, `${where}`);
  };
  check((await get('/sleep?nights=14')).body.nights[0], '/sleep?nights');
  check((await get(`/sleep/${DATE}`)).body, '/sleep/:date');
  check((await get(`/sleep/${DATE}?detail=1`)).body, '/sleep/:date?detail=1');

  // /sleep/live answers "tonight so far" whenever the real clock is inside the child's window, which
  // would make this test depend on the time of day it runs. Move the window to start two hours from
  // now, so the route deterministically takes the "last night" branch that reads the stored row.
  const hNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(hh(hNow + 2), hh(hNow + 3), CHILD);
  assert.equal(currentNightDate(CHILD), null, 'precondition: no night in progress, so /sleep/live reads the stored row');
  const live = (await get('/sleep/live')).body;
  assert.equal(live.scope, 'last');
  check(live.night, '/sleep/live');
});

// --- 3. the shape: exactly a detector-`empty` night -----------------------------------------------------

// The observations a night keeps whatever was or wasn't in the bed. Every OTHER column of sleep_nights
// is treated as a sleep claim that must read null — so a column added later is a claim until somebody
// decides otherwise, and this test fails until they do. That default is deliberate: a leaked claim
// ("slept 10h") on a night the parent said was empty is the harmful direction.
const OBSERVED_COLUMNS = [
  'id', 'child_id', 'night_date', 'window_start', 'window_end', 'coverage_minutes',
  'avg_temperature', 'avg_humidity', 'computed_at', 'notified_at', 'notified_wake_at',
];

test('★ a flagged stored row reads exactly like a detector-empty row: every claim column null, every observation kept', async () => {
  const cols = db.prepare("PRAGMA table_info('sleep_nights')").all();
  const names = cols.map((c) => c.name);
  const unknown = OBSERVED_COLUMNS.filter((c) => !names.includes(c));
  assert.deepEqual(unknown, [], `OBSERVED_COLUMNS names column(s) that no longer exist: ${unknown.join(', ')}`);
  const claims = names.filter((c) => c !== 'status' && !OBSERVED_COLUMNS.includes(c));

  // The detector's own empty row, for real. Every column this test calls a claim must be NULL there —
  // this is what ties the classification to the detector rather than to this file's opinion. A new
  // column the detector fills on an empty night fails here until it is classified.
  layEmptyNight();
  const realEmpty = computeAndStoreNight(CHILD, EMPTY_DATE);
  assert.equal(realEmpty.status, 'empty', 'precondition: the detector really scored an empty bed');
  const realRow = storedRow(EMPTY_DATE);
  for (const c of claims) {
    assert.equal(realRow[c], null, `a detector-empty row stores ${c} = ${realRow[c]}, so it is not a claim to null — classify it`);
  }
  for (const c of ['window_start', 'window_end', 'coverage_minutes', 'avg_temperature', 'avg_humidity', 'computed_at']) {
    assert.notEqual(realRow[c], null, `a detector-empty row keeps ${c}, so the overlay must too`);
  }

  // A hostile `ok` row: a recognisable marker in EVERY column, so anything the overlay forgets to clear
  // shows up by name instead of hiding behind a NULL. child_id/night_date are the join keys and status
  // must say `ok` for there to be anything to overrule; everything else is a marker.
  const marker = {};
  cols.forEach((c, i) => {
    if (c.name === 'child_id') marker[c.name] = CHILD;
    else if (c.name === 'night_date') marker[c.name] = DATE;
    else if (c.name === 'status') marker[c.name] = 'ok';
    else if (/INT/i.test(c.type)) marker[c.name] = 900000 + i;
    else if (/REAL/i.test(c.type)) marker[c.name] = 1000.25 + i;
    else marker[c.name] = `MARK:${c.name}`;
  });
  db.prepare(`INSERT INTO sleep_nights (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`).run(marker);

  assert.equal((await put({ nobody_in_bed: true })).status, 200);
  const shown = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);

  assert.deepEqual(Object.keys(shown).sort(), [...names, ...OVERLAY_KEYS].sort(),
    'the row keeps its columns and gains only the overlay fields');
  assert.equal(shown.status, 'empty');
  for (const c of claims) {
    assert.equal(shown[c], null, `${c} leaked onto a night the parent said was empty (value ${JSON.stringify(shown[c])})`);
  }
  for (const c of OBSERVED_COLUMNS) {
    assert.equal(shown[c], marker[c], `${c} is an observation and must be kept as measured`);
  }
  assert.equal(shown.algo_status, 'ok');
  assert.equal(shown.algo_onset_at, 'MARK:onset_at', "the detector's own onset rides along");
  assert.equal(shown.algo_wake_at, 'MARK:wake_at');
});

test('★ a flagged detail response has exactly the keys a detector-empty one has — no timeline, no wakes', async () => {
  // Plan review R7: the fresh `?detail=1` result for an `ok` night carries timeline/wakes/visits/
  // segments/alerts/wakeClips/transitions/display_*, which an empty night never has. Derived entirely
  // from REAL computeNight output: which keys exist, which are null, and which were measured.
  layOkNight();
  layEmptyNight();
  const realEmpty = json(computeNight(CHILD, EMPTY_DATE, { includeTimeline: true }));
  const full = json(computeNight(CHILD, DATE, { includeTimeline: true }));
  assert.equal(realEmpty.status, 'empty', 'precondition');
  assert.equal(full.status, 'ok', 'precondition');
  // Not vacuous: the ok night really does carry extras the empty one lacks, and real claims to clear.
  const scoredOnly = Object.keys(full).filter((k) => !(k in realEmpty));
  assert.ok(scoredOnly.includes('timeline') && scoredOnly.includes('wakes'), `precondition: detail extras exist (${scoredOnly})`);
  const nulledClaims = Object.keys(realEmpty).filter((k) => realEmpty[k] === null && full[k] != null);
  assert.ok(nulledClaims.includes('onset_at') && nulledClaims.includes('asleep_minutes'), 'precondition: claims to clear');
  assert.ok(full.climate && realEmpty.climate, 'precondition: climate is real on both, so "kept" is checkable');

  assert.equal((await put({ nobody_in_bed: true })).status, 200);
  const shown = (await get(`/sleep/${DATE}?detail=1`)).body;

  const shownKeys = Object.keys(shown).filter((k) => !OVERLAY_KEYS.includes(k)).sort();
  assert.deepEqual(shownKeys, Object.keys(realEmpty).sort(), 'the same keys as a real detector-empty night');
  for (const k of Object.keys(realEmpty)) {
    if (k === 'status') assert.equal(shown.status, 'empty');
    else if (realEmpty[k] === null) assert.equal(shown[k], null, `${k} is null on a real empty night, and must be here`);
    else assert.deepEqual(shown[k], full[k], `${k} is measured, and must be this night's own measurement`);
  }
});

// --- 4. reversible, and the detector's row is never touched ---------------------------------------------

test('un-flagging restores the detector night, whose stored row is byte-identical throughout', async () => {
  layOkNight();
  computeAndStoreNight(CHILD, DATE);
  const before = storedRow(DATE);
  const plain = (await get('/sleep?nights=1')).body.nights[0];

  await put({ nobody_in_bed: true });
  assert.equal((await get('/sleep?nights=1')).body.nights[0].status, 'empty', 'precondition: the flag took');
  assert.deepEqual(storedRow(DATE), before, 'flagging does not write sleep_nights');

  const res = await put({ nobody_in_bed: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.review.nobody_in_bed, 0);
  assert.deepEqual((await get('/sleep?nights=1')).body.nights[0], plain, "the detector's night, exactly as before");
  assert.deepEqual(storedRow(DATE), before, 'and the stored row never changed at all');

  // And times can be entered normally afterwards.
  await put({ true_wake_local: '05:29' });
  const corrected = (await get('/sleep?nights=1')).body.nights[0];
  assert.equal(corrected.status, 'ok');
  assert.equal(corrected.wake_at, '2026-07-01 19:29:00');
  assert.equal(corrected.corrected, true);
});

// --- 5. validation ----------------------------------------------------------------------------------

test('a non-boolean flag is a 4xx that stores nothing', async () => {
  // Strict on purpose: this flag hides a whole night, so "false" (a string) or 1 must not read as yes.
  for (const bad of ['true', 'false', 1, 0, 'yes', {}, []]) {
    const res = await put({ nobody_in_bed: bad });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_reviews').get().c, 0, 'and nothing was stored');
});

test('flag plus a time is a 4xx, and a refused save writes NOTHING — not even the verdicts in it', async () => {
  const frame = layTransition(TRANSITION.OUT_OF_BED, exactSql(at(6, 0, 1)));
  const bodies = [
    { true_wake_local: '06:00' },
    { true_onset_local: '19:40' },
    { true_wake_transition_id: frame },
    { true_onset_transition_id: frame },
  ];
  for (const times of bodies) {
    const res = await put({ nobody_in_bed: true, ...times, verdicts: { [frame]: 'wrong' } });
    assert.equal(res.status, 400, `${JSON.stringify(times)} + flag must be refused ("pick one")`);
    assert.match(res.body.error, /not both/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sleep_reviews').get().c, 0, 'no review stored');
  assert.equal(db.prepare('SELECT verdict FROM bed_transitions WHERE id = ?').get(frame).verdict, null,
    'the verdict in the refused save did not land either — the check runs before applyVerdicts writes');
});

test('flag with EXPLICIT null times is accepted — the shape the current client sends', async () => {
  const res = await put({
    nobody_in_bed: true,
    true_onset_local: null, true_wake_local: null, true_onset_transition_id: null, true_wake_transition_id: null,
  });
  assert.equal(res.status, 200);
  assert.equal(reviewRow().nobody_in_bed, 1);
});

test('a caregiver can save it, like every other part of a review', async () => {
  const res = await put({ nobody_in_bed: true }, { token: caregiverToken });
  assert.equal(res.status, 200);
  assert.equal(reviewRow().nobody_in_bed, 1);
});

test('the lib refuses flag plus times on its own, not only via the route', () => {
  assert.throws(() => saveNightReview(CHILD, DATE, { nobodyInBed: true, trueWakeAt: exactSql(at(6, 0, 1)) }), /pick one/);
  assert.throws(() => saveNightReview(CHILD, DATE, { nobodyInBed: true, trueOnsetTransitionId: 5 }), /pick one/);
  assert.equal(reviewRow(), undefined, 'nothing stored');
});

// --- R1: the newest answer wins, and "not answering" never clears an answer ------------------------------

test('times sent WITHOUT the flag clear it — an older page overwriting a flagged night is shown, not hidden', async () => {
  // The shape an already-open page from before this feature sends: times, and no nobody_in_bed key at
  // all. If the flag survived, the times would be stored but invisible (the flag wins at display).
  layOkNight();
  computeAndStoreNight(CHILD, DATE);
  await put({ nobody_in_bed: true });

  const res = await put({ true_onset_local: '19:40', true_wake_local: '06:00' });
  assert.equal(res.status, 200);
  assert.equal(res.body.review.nobody_in_bed, 0, 'the newer answer (times) replaced the flag');
  assert.equal(res.body.review.true_wake_at, '2026-07-01 20:00:00');
  const shown = (await get('/sleep?nights=1')).body.nights[0];
  assert.equal(shown.status, 'ok');
  assert.equal(shown.wake_at, '2026-07-01 20:00:00', 'and the times are what the card shows');
});

test('saves that are NOT an answer about the times leave the flag alone', async () => {
  const frame = layTransition(TRANSITION.OUT_OF_BED, exactSql(at(6, 0, 1)));
  await put({ nobody_in_bed: true });
  const shapes = [
    { verdicts: { [frame]: 'wrong' } },                            // a verdicts-only save (withTimes false)
    { dismissed: true },                                             // a stale card on a second phone
    { note: 'still empty' },
    { nobody_in_bed: null },                                         // null = not answering
    { true_onset_local: null, true_wake_local: null, true_onset_transition_id: null, true_wake_transition_id: null },
    { true_wake_local: '' },                                         // an emptied field is not a time
  ];
  for (const body of shapes) {
    assert.equal((await put(body)).status, 200, JSON.stringify(body));
    assert.equal(reviewRow().nobody_in_bed, 1, `${JSON.stringify(body)} must not clear the flag`);
  }
});

test('explicitly saving the flag un-dismisses the night; an explicit dismissal in the same save still wins', async () => {
  await put({ dismissed: true });
  assert.equal(reviewRow().dismissed, 1, 'precondition');
  await put({ nobody_in_bed: true });
  assert.equal(reviewRow().dismissed, 0, 'the parent answered, so this is no longer a dismissal');

  await put({ nobody_in_bed: true, dismissed: true });
  assert.equal(reviewRow().dismissed, 1, 'the same save saying "dismiss" is honoured');
});

// --- 6. insights ---------------------------------------------------------------------------------------

test('sleepInsights leaves out a night a parent flagged, but keeps ordinarily reviewed ones', () => {
  // sleepInsights reads sleep_nights directly, so the overlay never reaches it: without its own check a
  // night the detector invented stays in the averages. Six `ok` nights; the outlier is the flagged one.
  const insertNight = db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, asleep_minutes,
       awake_minutes, wake_count, coverage_minutes, computed_at, avg_temperature)
     VALUES (?, ?, '2026-06-01 09:00:00', '2026-06-01 21:00:00', 'ok', ?, 0, ?, 700, '2026-06-02 00:00:00', ?)`
  );
  const nights = [['2026-06-01', 17, 0, 660], ['2026-06-02', 19, 1, 650], ['2026-06-03', 21, 2, 640],
    ['2026-06-04', 23, 3, 630], ['2026-06-05', 25, 4, 620], ['2026-06-06', 40, 9, 100]];
  for (const [d, temp, wakes, asleep] of nights) insertNight.run(CHILD, d, asleep, wakes, temp);

  // Ordinary reviews on two of the kept nights — a time correction, and an explicit un-flag (0). A check
  // that excluded every REVIEWED night rather than every FLAGGED one would drop these as well.
  saveNightReview(CHILD, '2026-06-02', { trueWakeAt: '2026-06-02 19:00:00' });
  saveNightReview(CHILD, '2026-06-03', { nobodyInBed: false });

  const beforeFlag = sleepInsights(CHILD);
  assert.equal(beforeFlag.nights_analyzed, 6, 'precondition: every night counts');
  assert.equal(beforeFlag.overall.max_temp, 40);

  saveNightReview(CHILD, '2026-06-06', { nobodyInBed: true });
  const r = sleepInsights(CHILD);
  assert.equal(r.nights_analyzed, 5, 'the flagged night is out; the two reviewed ones are still in');
  assert.equal(r.overall.max_temp, 25, 'and its 40C no longer drags the range');
});

// --- 7. the morning card -----------------------------------------------------------------------------

function storeNight(nightDate) {
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, onset_at, wake_at, asleep_minutes)
     VALUES (?, ?, ?, ?, 'ok', '2026-08-29 09:33:00', '2026-08-29 19:48:00', 615)`
  ).run(CHILD, nightDate, `${nightDate} 09:30:00`, `${nightDate} 21:00:00`);
}

test('the card shows a receipt after the flag — done, with nobody_in_bed, and the legacy pending key', async () => {
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  assert.equal(reviewCardState(CHILD).state, 'ask', 'precondition');

  await put({ nobody_in_bed: true }, { date: night });
  const card = (await get('/review/pending')).body;
  assert.equal(card.state, 'done', 'an answer with no times is still an answer — not a vanished card');
  assert.equal(card.nobody_in_bed, true);
  assert.equal(card.night_date, night);
  assert.ok('pending' in card, 'the legacy key an already-open page reads is still there');
  assert.equal(card.pending, null);
});

test('a time receipt says nobody_in_bed: false, and un-flagging with no times leaves the card quiet (stated limit)', async () => {
  const night = lastCompletedNightDate(CHILD);
  storeNight(night);
  await put({ true_wake_local: '05:29' }, { date: night });
  const card = reviewCardState(CHILD);
  assert.equal(card.state, 'done');
  assert.equal(card.nobody_in_bed, false);

  // Flag, then take it back with no times: the times the flag cleared are NOT restored (docs say so),
  // and with nothing left to confirm the card shows neither ask nor done.
  await put({ nobody_in_bed: true }, { date: night });
  await put({ nobody_in_bed: false }, { date: night });
  assert.equal(reviewRow(night).true_wake_at, null, 'earlier typed times are gone for good');
  assert.equal(reviewCardState(CHILD).state, 'none');
});

// --- 8. a recompute cannot fight the parent ---------------------------------------------------------

// Rewritten 2026-09-30 for the lock. This used to expect `stored: true` (the recompute was written and
// the overlay simply stayed on top of it). A flagged night is now a CORRECTED night, and a corrected night
// is locked: the admin recompute is refused with a 409 rather than re-scoring it underneath the parent.
// What this test always pinned still holds: the overlay stays in force and the detector's row stays the
// detector's.
test('an admin ?store=1 recompute of a flagged night is refused (the lock) and the overlay stays in force', async () => {
  layOkNight();
  computeAndStoreNight(CHILD, DATE);
  await put({ nobody_in_bed: true });
  const before = storedRow();

  const res = await get(`/sleep/${DATE}?store=1&detail=1`);
  assert.equal(res.status, 409, 'a corrected night is not recomputed');
  assert.equal(res.body.reason, 'reviewed');
  assert.deepEqual(storedRow(), before, 'and nothing was written, not even computed_at');

  assert.equal(reviewRow().nobody_in_bed, 1, 'the flag survived');
  assert.equal(storedRow().status, 'ok', 'sleep_nights holds the detector, as always');
  assert.equal((await get('/sleep?nights=1')).body.nights[0].status, 'empty', 'and the card still shows the parent');
  assert.equal((await get(`/sleep/${DATE}`)).body.status, 'empty');
});

// --- R8: never an `off` night, never tonight ------------------------------------------------------------

test('the flag does not turn an `off` night into an empty one', async () => {
  // Tracking was off: nothing was measured, so "we watched and nobody was there" would be invented.
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  computeAndStoreNight(CHILD, DATE);
  assert.equal(storedRow().status, 'off', 'precondition');
  await put({ nobody_in_bed: true });

  const listed = (await get('/sleep?nights=1')).body.nights[0];
  assert.equal(listed.status, 'off');
  assert.equal(listed.corrected, undefined);
  const fresh = (await get(`/sleep/${DATE}`)).body;
  assert.equal(fresh.status, 'off');
  assert.equal(fresh.corrected, undefined);
});

test('the flag does not touch a night still in progress — "tonight so far" shows what the camera sees', async () => {
  // A window around the REAL now, so /sleep/:date computes a genuinely in-progress night.
  const hNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const hh = (h) => `${String((h + 24) % 24).padStart(2, '0')}:00`;
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(hh(hNow - 1), hh(hNow + 1), CHILD);
  const tonight = currentNightDate(CHILD);
  assert.ok(tonight, 'precondition: a night is in progress');

  saveNightReview(CHILD, tonight, { nobodyInBed: true });
  const shown = (await get(`/sleep/${tonight}`)).body;
  assert.equal(shown.in_progress, true, 'precondition: the live night');
  assert.notEqual(shown.status, 'empty');
  assert.equal(shown.corrected, undefined, 'untouched until the night is over');
});

test('a STORED row whose window has not ended yet is treated as in progress too', () => {
  // A stored row has no in_progress column. An admin ?store=1 for tonight's date is the one way such a
  // row exists, and it must not slip past the guard; a past window_end must still be overlaid.
  saveNightReview(CHILD, DATE, { nobodyInBed: true });
  const future = exactSql(new Date(Date.now() + 3600 * 1000));
  const running = { night_date: DATE, status: 'ok', window_end: future, onset_at: 'x', wake_at: null };
  assert.deepEqual(applyCorrection(CHILD, running), running, 'still running: passed through');
  const over = { ...running, window_end: '2026-07-01 21:00:00' };
  assert.equal(applyCorrection(CHILD, over).status, 'empty', 'over: overlaid');
});

test('the flag overrules any scored or unscored status, keeping the detector verdict as algo_status', () => {
  saveNightReview(CHILD, DATE, { nobodyInBed: true });
  for (const status of ['ok', 'no_sleep', 'no_data', 'empty']) {
    const out = applyCorrection(CHILD, { night_date: DATE, status, window_end: '2026-07-01 21:00:00', onset_at: null });
    assert.equal(out.status, 'empty', status);
    assert.equal(out.algo_status, status);
    assert.equal(out.corrected, true);
  }
});
