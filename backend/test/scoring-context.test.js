// #361 PR 1: a stored night records the QUESTION as well as the answer.
//
// Why: a sleep_nights row kept the result (times, minutes, status) but not what produced it: which camera,
// which timezone, which window, which version of the scoring rules. Every later re-score used whatever those
// were TODAY, so a stored `ok` night could turn into `no_data` the moment its camera was disabled
// (planning/361-scoring-context.md, sections 1-3). This PR only WRITES a small JSON record of that context
// (`scoring_context`) on every store; nothing reads it yet. So these tests pin three things:
//   - what is written: exactly the five agreed keys, with the values computeNight actually used (the
//     EFFECTIVE window after parseHm, the configured timezone or its 'UTC' fallback, the scored camera);
//   - what is NOT written: no camera name, address, credential or child detail (hostile fixture below);
//   - that nothing else changed: computeNight's own output is byte-identical to what it was before #361
//     (a golden literal captured on the unchanged source), and the stored-night endpoints only GAIN a key.
//
// ⚠️ The camera and child fixtures are neutral on purpose: the repo is public.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeNight, computeAndStoreNight, runNightlySleepJob, getStoredNights, SCORING_ALGO } =
  await import('../src/lib/sleepAnalysis.js');
const { TRANSITION } = await import('../src/lib/bedTransitions.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'sc-child';
const CAM = 'sc-cam-a';
const CAM2 = 'sc-cam-b';
const DATE = '2026-07-01';
// Any non-UTC zone works; this one has no DST edge near the fixture night (UTC+10 in July), so `at()` is
// plain arithmetic. The point of a non-UTC zone is that a hard-coded 'UTC' cannot pass.
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000;

const at = (h, m, dayShift = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m) - TZ_OFF);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ').replace(/:\d\d$/, ':00');
const exactSql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const json = (v) => JSON.parse(JSON.stringify(v)); // what a client actually receives

const CONTEXT_KEYS = ['algo', 'camera_id', 'tz', 'v', 'window'];

let server;
let adminToken;

const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);

// A night that scores `ok` (nobody-in-bed.test.js's layOkNight): settling until 19:40, up from 06:00 with the
// movement running on to the window's close so the detector reports a wake time, one room reading so climate
// is a real value, and one recorded "got out of bed" so the transition path is part of the golden output.
function layOkNight(cam = CAM) {
  for (let t = at(18, 20); t < at(7, 0, 1); t = new Date(t.getTime() + 60000)) {
    const moving = (t >= at(19, 30) && t < at(19, 40)) || (t >= at(6, 0, 1) && t < at(7, 0, 1));
    insertSample.run(cam, sqlTime(t), moving ? 0.4 : 0.004, moving ? 0.4 : 0.004);
  }
  db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, created_at) VALUES (?, ?, ?, ?)')
    .run(cam, 21.5, 48, exactSql(at(23, 0)));
  db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, 0.4, ?)')
    .run(cam, TRANSITION.OUT_OF_BED, exactSql(at(6, 2, 1)));
}

const storedRow = (date = DATE) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);

// The stored context, parsed. Fails loudly (rather than returning undefined) when there is no row or the
// column is not a string, so a missing write can never look like a matching value.
function storedContext(date = DATE) {
  const row = storedRow(date);
  assert.ok(row, 'precondition: the night was stored');
  assert.equal(typeof row.scoring_context, 'string', `scoring_context must be a JSON string, got ${JSON.stringify(row.scoring_context)}`);
  return JSON.parse(row.scoring_context);
}

const setTz = (tz) => db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(tz);
const setWindow = (start, end) =>
  db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(start, end, CHILD);

before(async () => {
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'sensor_readings', 'bed_transitions', 'cameras', 'children']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setTz(TZ);
  db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Context Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Bed cam', 'rtsp://example/x', ?, 'p-a', 0, 0)`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// --- 1. what is written ------------------------------------------------------------------------------

test('a stored night records exactly v, camera_id, tz, window and algo', () => {
  layOkNight();
  const summary = computeAndStoreNight(CHILD, DATE);
  assert.equal(summary.status, 'ok', 'precondition: a scored night');
  assert.equal(typeof SCORING_ALGO, 'string', 'SCORING_ALGO is exported as a string label');
  assert.ok(SCORING_ALGO.length > 0);
  assert.deepEqual(storedContext(), {
    v: 1,
    camera_id: CAM,
    tz: TZ,
    window: { start: '19:30', end: '07:00' },
    algo: SCORING_ALGO,
  });
});

test('no camera or child detail other than the camera id reaches the stored context (hostile fixture)', () => {
  // A marker in EVERY other TEXT column of the camera and child rows, derived from the schema (PRAGMA), so a
  // column added later is covered without anyone remembering to list it. Kept valid on purpose: the ids
  // (`cameras.id` IS the payload's camera_id, and the app mints it as a uuid, routes/cameras.js) and the
  // relationship columns (`cameras.child_id`, `children.primary_camera_id`), which decide WHICH camera scores.
  // The window columns are marked too: what is stored is the window parseHm made of them, never the raw text.
  const KEEP = { cameras: ['id', 'child_id'], children: ['id', 'primary_camera_id'] };
  const planted = [];
  for (const [table, key] of [['cameras', CAM], ['children', CHILD]]) {
    for (const c of db.prepare(`PRAGMA table_info(${table})`).all()) {
      if (KEEP[table].includes(c.name) || !/TEXT|CHAR|CLOB/i.test(c.type)) continue;
      const marker = `ZZMARK_${table}_${c.name}`;
      db.prepare(`UPDATE ${table} SET ${c.name} = ? WHERE id = ?`).run(marker, key);
      planted.push(marker);
    }
  }
  // Not vacuous: the fields the design names as must-never-be-stored really carry a marker.
  for (const must of ['cameras_name', 'cameras_rtsp_url', 'cameras_snapshot_url', 'cameras_mqtt_topic',
    'cameras_talk_password', 'cameras_onvif_password', 'children_name', 'children_birthday']) {
    assert.ok(planted.includes(`ZZMARK_${must}`), `precondition: ${must} carries a marker`);
  }
  // The named-primary path, so the camera is chosen through the child row that is full of markers.
  db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(CAM, CHILD);
  layOkNight();

  computeAndStoreNight(CHILD, DATE);
  const raw = storedRow().scoring_context;
  assert.equal(typeof raw, 'string', 'precondition: a context was stored');
  for (const marker of planted) assert.ok(!raw.includes(marker), `${marker} leaked into scoring_context: ${raw}`);
  assert.ok(!raw.includes('ZZMARK'), raw);
  assert.equal(JSON.parse(raw).camera_id, CAM, 'the camera id itself is the one thing kept');
});

// --- 2. tz and window are what computeNight used --------------------------------------------------

test('tz and window are the ones computeNight used: a non-UTC zone and a custom window', () => {
  setTz('Europe/London');
  setWindow('20:00', '06:00');
  computeAndStoreNight(CHILD, DATE);
  const ctx = storedContext();
  assert.equal(ctx.tz, 'Europe/London');
  assert.deepEqual(ctx.window, { start: '20:00', end: '06:00' });
  // The same settings really scored the night: London is UTC+1 in July, so 20:00-06:00 local is these UTC bounds.
  const row = storedRow();
  assert.equal(row.window_start, '2026-07-01 19:00:00');
  assert.equal(row.window_end, '2026-07-02 05:00:00');
});

test('a child on the defaults stores 19:00-07:00 and UTC, the install default and the fallback', () => {
  // A fresh install: settings.timezone is 'UTC' (db.js seeds it) and a child added without a window gets the
  // column defaults.
  setTz('UTC');
  db.prepare('DELETE FROM children').run();
  db.prepare("INSERT INTO children (id, name) VALUES (?, 'Default Kid')").run(CHILD);
  // The delete unassigned the camera (cameras.child_id is ON DELETE SET NULL); give it back.
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(CHILD, CAM);
  computeAndStoreNight(CHILD, DATE);
  assert.deepEqual(storedContext(), { v: 1, camera_id: CAM, tz: 'UTC', window: { start: '19:00', end: '07:00' }, algo: SCORING_ALGO });
  assert.equal(storedRow().window_start, '2026-07-01 19:00:00');

  // An empty timezone and empty window: computeNight falls back to 'UTC' and 19:00/07:00, so that is what
  // scored the night and what must be stored, never the raw empty strings.
  setTz('');
  setWindow('', '');
  computeAndStoreNight(CHILD, DATE);
  const ctx = storedContext();
  assert.equal(ctx.tz, 'UTC');
  assert.deepEqual(ctx.window, { start: '19:00', end: '07:00' });
  assert.equal(storedRow().window_start, '2026-07-01 19:00:00');
});

test('the window stored is the EFFECTIVE one: a malformed saved time stores what scored the night', () => {
  // computeNight reads the window through parseHm, which turns a non-numeric hour into 19 and a non-numeric
  // minute into 0 (sleepInsights.test.js deliberately allows a malformed saved window). The context records
  // the window that was USED, so a replay rebuilds the same bounds.
  setTz('UTC');
  setWindow('not-a-time', '07:00');
  computeAndStoreNight(CHILD, DATE);
  assert.deepEqual(storedContext().window, { start: '19:00', end: '07:00' });
  assert.equal(storedRow().window_start, '2026-07-01 19:00:00', 'precondition: 19:00 really is what scored it');

  setWindow('20:30', '06:00');
  computeAndStoreNight(CHILD, DATE);
  assert.deepEqual(storedContext().window, { start: '20:30', end: '06:00' });
  assert.equal(storedRow().window_start, '2026-07-01 20:30:00');
});

// --- 3. camera_id is the scored camera ------------------------------------------------------------------

test('camera_id is the camera the night was scored from: the named primary, else the first enabled', () => {
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Door cam', 'rtsp://example/y', ?, 'p-b', 1, 0)`).run(CAM2, CHILD);
  layOkNight(CAM);
  layOkNight(CAM2);

  db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(CAM2, CHILD);
  const named = computeAndStoreNight(CHILD, DATE);
  assert.equal(named.analysis_camera_id, CAM2, 'precondition: computeNight scored the named camera');
  assert.equal(storedContext().camera_id, CAM2);

  db.prepare('UPDATE children SET primary_camera_id = NULL WHERE id = ?').run(CHILD);
  computeAndStoreNight(CHILD, DATE);
  assert.equal(storedContext().camera_id, CAM, 'Automatic: the first enabled camera by sort_order');
});

test('a no_data night (no enabled camera) and an off night still store a context, camera_id null when none', () => {
  db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM);
  const none = computeAndStoreNight(CHILD, DATE);
  assert.equal(none.status, 'no_data', 'precondition');
  assert.deepEqual(storedContext(), { v: 1, camera_id: null, tz: TZ, window: { start: '19:30', end: '07:00' }, algo: SCORING_ALGO });

  db.prepare('UPDATE cameras SET disabled = 0 WHERE id = ?').run(CAM);
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(CHILD);
  const off = computeAndStoreNight(CHILD, DATE);
  assert.equal(off.status, 'off', 'precondition');
  const ctx = storedContext();
  assert.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
  assert.equal(ctx.camera_id, off.analysis_camera_id, 'whatever camera computeNight resolved, nothing invented');
  assert.equal(ctx.tz, TZ);
});

// --- 4. provisional vs final --------------------------------------------------------------------------

test('a provisional re-store refreshes the context in the same statement as the numbers', (t) => {
  // Inside the 3 h evidence window the nightly job re-stores the last completed night (#351), and an admin
  // fixing the camera in that window legitimately changes which camera scores it. Freezing the context on the
  // FIRST write would then describe numbers it did not produce (design section 8).
  t.mock.timers.enable({ apis: ['Date'], now: at(7, 5, 1).getTime() });
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES (?, 'Door cam', 'rtsp://example/y', ?, 'p-b', 1, 0)`).run(CAM2, CHILD);
  layOkNight(CAM);
  layOkNight(CAM2); // both score, so the job's downgrade guard has nothing to refuse
  computeAndStoreNight(CHILD, DATE); // the job's first pass, at 07:05 local
  const first = storedRow();
  assert.equal(JSON.parse(first.scoring_context).camera_id, CAM, 'precondition');

  db.prepare('UPDATE children SET primary_camera_id = ? WHERE id = ?').run(CAM2, CHILD);
  t.mock.timers.tick(30 * 60000);
  runNightlySleepJob();
  const second = storedRow();
  assert.notEqual(second.computed_at, first.computed_at, 'precondition: the job really re-stored the night');
  assert.equal(JSON.parse(second.scoring_context).camera_id, CAM2, 'the context follows the pass that wrote the numbers');
});

test('a final legacy NULL row is left alone by the nightly job, and gains a context only when re-stored', (t) => {
  // "No automatic backfill; a legacy row stays NULL until it is next successfully re-stored." 12:00 local is
  // past the night's evidence horizon (07:00 + 3 h), and the job still visits this night (it is the last
  // completed one), so the only thing keeping it away is the existing finality rule.
  t.mock.timers.enable({ apis: ['Date'], now: at(12, 0, 1).getTime() });
  layOkNight();
  const freshBefore = json(computeNight(CHILD, DATE));
  // Shaped like a row stored before #361: the column is not in the INSERT at all.
  db.prepare(
    `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, onset_at, wake_at,
       asleep_minutes, coverage_minutes, computed_at)
     VALUES (@child_id, @night_date, @window_start, @window_end, @status, @onset_at, @wake_at,
       @asleep_minutes, @coverage_minutes, @computed_at)`
  ).run({ child_id: CHILD, ...freshBefore, computed_at: exactSql(at(10, 30, 1)) });
  const legacy = storedRow();
  assert.equal(legacy.scoring_context, null, 'precondition: a legacy row');

  runNightlySleepJob();
  assert.deepEqual(storedRow(), legacy, 'a FINAL row is frozen by the existing rule, context and all');
  assert.deepEqual(json(computeNight(CHILD, DATE)), freshBefore, 'and a fresh read of it is what it was');

  // The admin Recompute path (`?store=1` calls exactly this) re-stores it, and the re-store writes a context.
  const res = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(res.stored, true);
  assert.equal(storedContext().camera_id, CAM);

  // Control, so "left alone" above cannot be a job that never reached this night: the SAME row with a
  // provisional computed_at is re-stored by the same job at the same clock, and so gains a context.
  db.prepare('UPDATE sleep_nights SET scoring_context = NULL, computed_at = ? WHERE child_id = ?')
    .run(exactSql(at(7, 5, 1)), CHILD);
  runNightlySleepJob();
  assert.equal(storedContext().camera_id, CAM, 'the job does visit this night; only finality kept it away');
});

// --- 5. nothing else changed --------------------------------------------------------------------------

// computeNight(CHILD, DATE) for layOkNight(), captured on the source BEFORE #361 (dev dd7e830) with the clock
// frozen at 12:00 local the next morning (past the evidence horizon, so `in_progress`/`as_of` are fixed).
// Nothing in it is clock- or machine-dependent at that frozen instant. If a deliberate scoring change moves
// this, update the literal AND bump SCORING_ALGO in the same commit (see its comment in sleepAnalysis.js).
const GOLDEN = {
  night_date: '2026-07-01',
  window_start: '2026-07-01 09:30:00',
  window_end: '2026-07-01 21:00:00',
  in_progress: false,
  as_of: '2026-07-01 21:00:00',
  analysis_camera_id: 'sc-cam-a',
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
  climate: {
    temp_avg: 21.5, temp_min: 21.5, temp_max: 21.5, temp_samples: 1,
    humidity_avg: 48, humidity_min: 48, humidity_max: 48, humidity_samples: 1,
  },
  status: 'ok',
};

test('computeNight output is unchanged: no scoring_context key, and the same answer as before #361 (golden)', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: at(12, 0, 1).getTime() });
  layOkNight();
  const out = computeNight(CHILD, DATE);
  assert.ok(!('scoring_context' in out), 'computeNight does not return the context');
  assert.deepEqual(json(out), GOLDEN);
  const stored = computeAndStoreNight(CHILD, DATE);
  assert.ok(!('scoring_context' in stored), 'nor does computeAndStoreNight (its return is computeNight + stored)');
});

test('the stored-night endpoints carry scoring_context as one additive string key', async () => {
  layOkNight();
  const summary = computeAndStoreNight(CHILD, DATE);
  const row = storedRow();
  const columns = db.prepare('PRAGMA table_info(sleep_nights)').all().map((c) => c.name);
  assert.ok(columns.includes('scoring_context'));
  // Every computed column holds exactly what computeNight returned: the context is bound AFTER the summary
  // and overwrites nothing.
  for (const c of columns) {
    if (c in summary) assert.deepEqual(row[c], summary[c], `${c} is stored as computed`);
  }

  const savedRes = await call(`${server.url}/api/children/${CHILD}/sleep/${DATE}?stored=1`, { token: adminToken });
  assert.equal(savedRes.status, 200);
  const saved = savedRes.body.night;
  assert.equal(typeof saved.scoring_context, 'string');
  assert.deepEqual(Object.keys(saved).sort(), [...columns].sort(), '?stored=1 returns the raw row, one key per column');
  assert.deepEqual(saved, row, 'and every value as stored');

  const list = (await call(`${server.url}/api/children/${CHILD}/sleep?nights=14`, { token: adminToken })).body.nights;
  assert.equal(list.length, 1);
  assert.equal(typeof list[0].scoring_context, 'string');
  assert.deepEqual(list[0], row, 'GET /sleep (getStoredNights) gains the key and changes nothing else');
  assert.deepEqual(getStoredNights(CHILD)[0], row);
});
