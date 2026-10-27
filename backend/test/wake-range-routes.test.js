// "Up between X and Y" on the wire (lib/wakeRange.js wired into routes/children.js). The rule's own edges are
// in wake-range.test.js; this file pins what only a route can show:
//   - `wake_range` is on EVERY response that returns a night beside `wake_at`: the child's "last night" card
//     (/sleep/live), the history list (/sleep), the detail page (/sleep/:date), the morning review screen
//     (/review/:date) and the review card (/review/pending);
//   - it is NOT on the raw reads (`?stored=1`, `raw=1`): those answer "what did the detector save";
//   - it is computed AFTER the parent's correction, so a corrected night, and "no one was in the bed", read null;
//   - it is additive: with the field removed the night is byte-identical to what the route returned before.
//
// One REAL night is laid minute by minute (the "exit earlier than the movement-only wake" shape of #509 C3 in
// sleepAnalysis.test.js), so the two estimates come out of the real detector rather than out of a fixture that
// agrees with the code by construction. A second test plants a stored row with a marker in every other column.
// Melbourne is the fixture zone because a real, non-UTC zone is what catches a hard-coded offset.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { computeAndStoreNight } = await import('../src/lib/sleepAnalysis.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'wr-child';
const CAM = 'wr-cam';
const DATE = '2026-07-01';
const TZ = 'Australia/Melbourne';
const TZ_OFF = 10 * 3600 * 1000; // Melbourne in July: UTC+10, no DST edge anywhere near
const at = (h, m, dayShift = 0, s = 0) => new Date(Date.UTC(2026, 6, 1 + dayShift, h, m, s) - TZ_OFF);
const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const plus = (d, n) => new Date(d.getTime() + n * 60000);
const hhmm = (u) => (u
  ? new Date(u.replace(' ', 'T') + 'Z').toLocaleString('en-AU', { timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit' })
  : null);
// The clock for every request: an hour after the 07:00 window closed, so the night is finished and is "last night".
const MORNING = () => at(8, 0, 1).getTime();

const STILL_OCCUPIED = 0.004;
const STILL_EMPTY = 0.0002;
const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTrace = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level, sound_peak,
     motion_out_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, ?, ?, 1, 0)`
);
const insertTransition = db.prepare('INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)');

// The #509 C3 shape: movement stops at 05:30, the bed reads empty-still from 05:31 while the room stays
// audible until 06:25, and the child is logged leaving the bed at 05:31. The reported wake (the exit) is
// 05:31 and the movement-only wake is 06:25: 54 minutes apart, so a range.
function layRangeNight() {
  for (let t = at(19, 30); t < at(5, 25, 1); t = plus(t, 1)) {
    const moving = t >= at(19, 30) && t < at(19, 40);
    insertSample.run(CAM, sql(t), moving ? 0.4 : STILL_OCCUPIED, moving ? 0.6 : STILL_OCCUPIED);
  }
  for (let t = at(5, 25, 1); t < at(5, 31, 1); t = plus(t, 1)) insertTrace.run(CAM, sql(t), 0.15, 0.15, 0, 0);
  for (let t = at(5, 31, 1); t < at(6, 25, 1); t = plus(t, 1)) insertTrace.run(CAM, sql(t), STILL_EMPTY, STILL_EMPTY, 0, 0);
  for (let t = at(6, 25, 1); t < at(8, 0, 1); t = plus(t, 1)) insertTrace.run(CAM, sql(t), STILL_EMPTY, STILL_EMPTY, 10, 0);
  insertTransition.run(CAM, 'out_of_bed', 0.05, sql(at(5, 31, 1, 10)));
}

let server;
let adminToken;
const get = (path) => call(`${server.url}/api/children/${CHILD}${path}`, { token: adminToken });
const put = (path, body) => call(`${server.url}/api/children/${CHILD}${path}`, { method: 'PUT', token: adminToken, body });
const storedRow = () => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, DATE);

// Every response that carries this night beside `wake_at`, fetched fresh. Each entry: how to reach the night
// object (and its range) inside the body.
const SURFACES = [
  ['/sleep/live (the child card)', () => get('/sleep/live'), (b) => b.night, (b) => b.night.wake_range],
  ['/sleep (the history list)', () => get('/sleep?nights=60'), (b) => b.nights.find((n) => n.night_date === DATE), (b) => b.nights.find((n) => n.night_date === DATE).wake_range],
  ['/sleep/:date (the detail page)', () => get(`/sleep/${DATE}`), (b) => b, (b) => b.wake_range],
  ['/sleep/:date?context=auto (what the detail page sends)', () => get(`/sleep/${DATE}?context=auto`), (b) => b, (b) => b.wake_range],
  ['/review/:date (the review screen)', () => get(`/review/${DATE}`), (b) => b.computed, (b) => b.wake_range],
  ['/review/pending (the review card)', () => get('/review/pending'), (b) => b, (b) => b.wake_range],
];

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
              VALUES (?, 'Range Kid', 1, '19:30', '07:00')`).run(CHILD);
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path)
              VALUES (?, 'Range Cam', 'rtsp://example/stream', ?, 'rangecam')`).run(CAM, CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('★ a real night with two different estimates carries wake_range on every surface, and the night is otherwise unchanged', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  const summary = computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal(summary.status, 'ok', 'precondition');
  assert.equal(hhmm(summary.wake_at), '05:31', 'precondition: the reported wake is the exit');
  assert.equal(hhmm(summary.wake_at_algo), '06:25', 'precondition: the movement-only wake is the later one');
  const raw = storedRow();
  assert.equal(raw.wake_at, summary.wake_at, 'precondition: the stored row holds both estimates');

  for (const [label, fetch, nightOf, rangeOf] of SURFACES) {
    const res = await fetch();
    assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.body)}`);
    const range = rangeOf(res.body);
    assert.deepEqual(range, { from: summary.wake_at, to: summary.wake_at_algo }, `${label}: the earlier estimate first`);
    // Additive: `wake_at` is byte-identical to the detector's, on every surface that returns one.
    assert.equal(nightOf(res.body).wake_at, summary.wake_at, `${label}: wake_at is unchanged`);
  }

  // "Byte-identical without the field": the two surfaces that return the whole stored/fresh night. With
  // `wake_range` removed they must equal what the route returned before this change (the raw read's row).
  const list = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  const { wake_range: listRange, ...listRest } = list;
  assert.ok(listRange);
  assert.deepEqual(listRest, raw, 'the history list entry, minus wake_range, IS the stored row');
  const card = (await get('/sleep/live')).body;
  assert.equal(card.scope, 'last');
  const { wake_range: cardRange, ...cardRest } = card.night;
  assert.ok(cardRange);
  assert.deepEqual(cardRest, raw, 'the card night, minus wake_range, IS the stored row');
});

test('★ the raw reads carry no wake_range: ?stored=1 and context+raw=1 answer "what the detector saved"', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  const stored = await get(`/sleep/${DATE}?stored=1`);
  assert.equal(stored.status, 200);
  assert.ok(stored.body.night);
  assert.equal('wake_range' in stored.body.night, false, '?stored=1');
  const rawRead = await get(`/sleep/${DATE}?context=current&raw=1`);
  assert.equal(rawRead.status, 200);
  assert.equal('wake_range' in rawRead.body, false, 'context=current&raw=1');
});

test('★ a night the parent corrected shows their single time: wake_range is null on every surface, wake_at is theirs', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  // The wake-only save the review screen sends: the answer, the two echoes of what was on screen, the settings key.
  const shown = (await get(`/review/${DATE}`)).body;
  assert.ok(shown.wake_range, 'precondition: the screen was offered a range');
  const saved = await put(`/review/${DATE}`, {
    true_wake_local: '06:40', computed_onset_at: shown.computed.onset_at, computed_wake_at: shown.computed.wake_at,
    settings_key: shown.settings.key,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  for (const [label, fetch, nightOf, rangeOf] of SURFACES) {
    const res = await fetch();
    assert.equal(res.status, 200, label);
    // The pending card has no night object once answered (state 'done'); it still carries the field.
    assert.equal(rangeOf(res.body), null, `${label}: the field is present and null, not a range beside the parent's time`);
    if (label.startsWith('/review/pending')) {
      assert.equal(res.body.state, 'done');
      assert.equal(hhmm(res.body.wake_at), '06:40');
    } else if (!label.startsWith('/review/:date')) {
      assert.equal(nightOf(res.body).corrected, true, label);
      assert.equal(hhmm(nightOf(res.body).wake_at), '06:40', label);
    }
  }
  // The detector's own stored row is untouched by the correction, so the raw read still has the estimates.
  assert.equal(hhmm(storedRow().wake_at), '05:31');
});

test('"no one was in the bed" has no range: the detector\'s times it keeps as algo_* are not a wake', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  assert.equal((await put(`/review/${DATE}`, { nobody_in_bed: true })).status, 200);
  for (const [label, fetch, , rangeOf] of SURFACES) {
    const res = await fetch();
    assert.equal(res.status, 200, label);
    assert.equal(rangeOf(res.body), null, label);
  }
  assert.equal((await get(`/sleep/${DATE}`)).body.nobody_in_bed, true, 'precondition: the night really reads as flagged');
});

test('the card for a night waiting to be reviewed carries the range, also inside `pending` for pages from before `state`', async (t) => {
  layRangeNight();
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  computeAndStoreNight(CHILD, DATE, { allowDowngrade: false });
  const card = (await get('/review/pending')).body;
  assert.equal(card.state, 'ask');
  assert.ok(card.wake_range);
  assert.deepEqual(card.pending.wake_range, card.wake_range);
  assert.equal(hhmm(card.wake_at), '05:31', 'the existing fields are as they were');
});

test('a card with nothing to review still answers, with the field null (never absent)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  const none = await get('/review/pending');
  assert.equal(none.status, 200);
  assert.equal(none.body.state, 'none');
  assert.equal(none.body.wake_range, null);
});

test('a night with no data, and tonight so far, answer with the field present and null', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  const empty = await get(`/sleep/${DATE}`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.status, 'no_data');
  assert.equal(empty.body.wake_range, null);
  // A window that is open right now: 23:00 on DATE's evening.
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['Date'], now: at(23, 0).getTime() });
  const live = await get('/sleep/live');
  assert.equal(live.body.scope, 'tonight');
  assert.equal(live.body.night.in_progress, true);
  assert.equal(live.body.night.wake_range, null);
});

test('★ hostile stored row: the range reads ONLY status, wake_at_algo and wake_at (every other column carries a marker)', async (t) => {
  // Every column the schema has gets a recognisable value, derived from PRAGMA table_info rather than typed,
  // so a column added later is covered too. The two shadow/onset columns carry VALID times that would produce
  // a different range if read by mistake; everything else is a marker string that must never parse as a time.
  const cols = db.prepare("PRAGMA table_info('sleep_nights')").all();
  const values = {
    child_id: CHILD, night_date: DATE, status: 'ok',
    window_start: sql(at(19, 30)), window_end: sql(at(7, 0, 1)), computed_at: sql(at(11, 0, 1)),
    notified_at: null, notified_wake_at: null,
    onset_at: sql(at(19, 40)), asleep_minutes: 600, wake_count: 1,
    wake_at: sql(at(6, 40, 1)), wake_at_algo: sql(at(6, 0, 1)),
    wake_at_shadow: sql(at(5, 0, 1)), onset_at_algo: sql(at(19, 55)), onset_at_shadow: sql(at(19, 50)),
  };
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
  t.mock.timers.enable({ apis: ['Date'], now: MORNING() });
  const list = (await get('/sleep?nights=60')).body.nights.find((n) => n.night_date === DATE);
  assert.deepEqual(list.wake_range, { from: values.wake_at_algo, to: values.wake_at }, 'the range is the algo wake and the reported wake');
  assert.equal(list.wake_at, values.wake_at);
});
