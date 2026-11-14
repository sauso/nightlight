// Heart rate and breathing on the sleep routes (owner request 2026-11-14): `night.vitals` on /sleep/live and
// /sleep/:date, and nowhere else. Each test names what it kills.
//
//   - /sleep/live carries `vitals` (summary, no series) for tonight, for last night computed fresh and for a stored last
//     night; /sleep/:date?detail=1 carries the series; a plain /sleep/:date the summary only;
//   - a child without a sensor gets NO `vitals` key (the response is as before), and a caregiver reads the same;
//   - READ-ONLY: the stored row and its summary_facts never contain it, and reading a night twice changes no table;
//   - the summary follows the night the page shows: onset..wake, and a parent's correction moves it.
//
// ⚠️ CLOCK-INDEPENDENT ON PURPOSE, like sleep-live-last-night.test.js: the window is placed relative to now (UTC, so no
// clock change exists), and every night is laid against the same functions the route uses.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { computeAndStoreNight, lastCompletedNightDate, currentNightDate, computeNight } = await import('../src/lib/sleepAnalysis.js');
const { saveNightReview } = await import('../src/lib/sleepReviews.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'vr-child';
const BARE = 'vr-bare'; // a child with a camera and a night but no sensor
const CAM = 'vr-cam';
const BARE_CAM = 'vr-bare-cam';
const MIN = 60000;
const HOUR = 60 * MIN;
const HOURS = 10; // window length

let server;
let adminToken;
let caregiverToken;
let startHour;

const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ':00';
const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const putRow = db.prepare(
  'INSERT OR REPLACE INTO esphome_readings (entity_id, bucket, last, mean, min, max, n, nzero, nmiss) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)'
);
const get = (path, token = adminToken, id = CHILD) => call(`${server.url}/api/children/${id}${path}`, { token });
const rowOf = (date) => db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, date);

// One sample a minute over [from, to) in ms: moving (0.4) inside any `moving` span, else still (0.004).
function layMinutes(cam, moving, from, to) {
  db.exec('BEGIN');
  for (let t = from; t < to; t += MIN) {
    const m = moving.some(([a, b]) => t >= a && t < b);
    insertSample.run(cam, sqlAt(t), m ? 0.4 : 0.004, m ? 0.4 : 0.004);
  }
  db.exec('COMMIT');
}
// A radar sensor for `childId`; one valid heart-rate and breathing row per minute over [from, to), values from the
// callbacks (ms -> mean), a distance of 60 cm.
function laySensor(childId, from, to, hrAt, rrAt = () => 24) {
  const device = db.prepare("INSERT INTO esphome_devices (name, host, child_id) VALUES ('radar', '192.0.2.10', ?)")
    .run(childId).lastInsertRowid;
  const entity = (objectId, name, deviceClass, unit) => db.prepare(
    `INSERT INTO esphome_entities (device_id, object_id, child_id, kind, name, device_class, unit, active)
     VALUES (?, ?, ?, 'sensor', ?, ?, ?, 1)`
  ).run(device, objectId, childId, name, deviceClass, unit).lastInsertRowid;
  const hr = entity('heart_rate', 'Heart Rate', null, 'bpm');
  const rr = entity('respiratory_rate', 'Respiratory Rate', null, null);
  const dist = entity('distance', 'Distance', 'distance', 'cm');
  db.exec('BEGIN');
  for (let t = from; t < to; t += MIN) {
    const b = Math.floor(t / MIN);
    const h = hrAt(t);
    const r = rrAt(t);
    if (h != null) putRow.run(hr, b, h, h, h, h, 10);
    if (r != null) putRow.run(rr, b, r, r, r, r, 40);
    putRow.run(dist, b, 60, 60, 60, 60, 10);
  }
  db.exec('COMMIT');
}

function setWindow(hour) {
  startHour = ((hour % 24) + 24) % 24;
  for (const id of [CHILD, BARE]) {
    db.prepare('UPDATE children SET sleep_window_start = ?, sleep_window_end = ? WHERE id = ?').run(hh(startHour), hh(startHour + HOURS), id);
  }
}
const windowStart = (date) => Date.parse(`${date}T00:00:00Z`) + startHour * HOUR;

// Last completed night for both children: settling for the first ten minutes, still after, up for the last hour (the
// layout sleep-live-last-night.test.js uses). Onset is the window start + 10 min, wake is the window end - 60 min.
function layLastNight() {
  const last = lastCompletedNightDate(CHILD);
  const start = windowStart(last);
  const end = start + HOURS * HOUR;
  for (const cam of [CAM, BARE_CAM]) layMinutes(cam, [[start, start + 10 * MIN], [end - HOUR, end]], start - 70 * MIN, end);
  return { last, start, end };
}
// The marker plan: 111 before the onset, 90 asleep, 140 after the wake. The summary must be exactly 90 for a night that
// is summarised onset..wake, and the series carries all of them.
const planted = (start, end) => (t) => (t < start + 10 * MIN ? 111 : t < end - HOUR ? 90 : 140);

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', 'UTC')
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run();
  const admin = makeUser(db, { id: 'u-vr-admin', username: 'admin', role: 'admin' });
  adminToken = signToken({ sub: admin.id, sid: makeSession(db, admin.id), role: 'admin', username: 'admin' });
  const cg = makeUser(db, { id: 'u-vr-cg', username: 'carer', role: 'caregiver' });
  caregiverToken = signToken({ sub: cg.id, sid: makeSession(db, cg.id), role: 'caregiver', username: 'carer' });
  server = await mountRouter('/api/children', childrenRouter);
});
beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'activity_samples', 'bed_transitions', 'esphome_readings', 'esphome_entities',
    'esphome_devices', 'cameras', 'children']) db.prepare(`DELETE FROM ${t}`).run();
  for (const [id, cam] of [[CHILD, CAM], [BARE, BARE_CAM]]) {
    db.prepare(`INSERT INTO children (id, name, track_sleep, sleep_window_start, sleep_window_end) VALUES (?, 'Kid', 1, '19:30', '07:00')`).run(id);
    db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
                VALUES (?, 'Cam', 'rtsp://example/x', ?, ?, 0, 0)`).run(cam, id, `p_${cam}`);
  }
  setWindow(new Date().getUTCHours() + 2); // opens two hours from now: "now" is never inside it
});
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

test('/sleep/live, last night computed fresh: vitals over onset..wake, no series, the rest of the night unchanged', async () => {
  // Kills: not attaching on this branch; summarising the whole window (111 and 140 would pull the mean off 90).
  const { last, start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, planted(start, end));
  assert.equal(rowOf(last), undefined, 'precondition: not saved yet');
  const r = await get('/sleep/live');
  const night = r.body.night;
  assert.deepEqual([r.body.scope, night.night_date, night.status, night.onset_at, night.wake_at],
    ['last', last, 'ok', sqlAt(start + 10 * MIN), sqlAt(end - HOUR)], 'precondition: the night is read as the layout says');
  assert.deepEqual(night.vitals, {
    hr: { avg: 90, min: 90, max: 90, minutes: 530 }, // 10 minutes in .. 60 before the end of a 10 h window: 600 - 10 - 60
    rr: { avg: 24, min: 24, max: 24, minutes: 530 },
  });
  assert.equal('series' in night.vitals, false);
  // Only the key was added: the same night, computed again, is what came back.
  const { vitals, score, summary, live, ...rest } = night;
  const plain = JSON.parse(JSON.stringify(computeNight(CHILD, last)));
  for (const k of Object.keys(plain)) assert.deepEqual(rest[k], plain[k], `key ${k} unchanged`);
});

test('/sleep/live, last night SAVED: vitals are worked out on read and never stored', async () => {
  // Kills: computing the vitals inside the stored summary (the stored row and summary_facts must never hold them).
  const { last, start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, planted(start, end));
  assert.equal(computeAndStoreNight(CHILD, last).status, 'ok', 'precondition');
  const stored = JSON.stringify(rowOf(last));
  const r = await get('/sleep/live');
  assert.equal(r.body.scope, 'last');
  assert.equal(r.body.night.vitals.hr.avg, 90);
  assert.equal(r.body.night.vitals.hr.minutes, 530);
  // The saved row is byte-for-byte what it was, holds no `vitals` anywhere, and has no such column.
  assert.equal(JSON.stringify(rowOf(last)), stored);
  assert.doesNotMatch(stored, /vitals/);
  assert.doesNotMatch(String(rowOf(last).summary_facts), /vitals|"hr"|"rr"/);
  const columns = db.prepare('PRAGMA table_info(sleep_nights)').all().map((c) => c.name);
  assert.ok(!columns.some((c) => /vital|heart|breath/i.test(c)), 'schema: no vitals column');
});

test('/sleep/live, tonight: vitals so far (the night is in progress), summarised from the onset', async () => {
  // Kills: reading to the window's end in the future; summarising from the window start (111 would show).
  setWindow(new Date().getUTCHours() - 3); // the window opened between three and four hours ago
  const current = currentNightDate(CHILD);
  assert.ok(current, 'precondition: a night is in progress');
  const start = Date.parse(`${computeNight(CHILD, current).window_start.replace(' ', 'T')}Z`);
  const nowMin = Math.floor(Date.now() / MIN) * MIN;
  for (const cam of [CAM, BARE_CAM]) layMinutes(cam, [[start, start + 20 * MIN]], start, nowMin);
  // 111 while settling (the first 20 minutes), 90 once asleep.
  laySensor(CHILD, start, nowMin, (t) => (t < start + 20 * MIN ? 111 : 90));
  const r = await get('/sleep/live');
  const night = r.body.night;
  assert.deepEqual([r.body.scope, night.in_progress, night.status, night.onset_at], ['tonight', true, 'ok', sqlAt(start + 20 * MIN)], 'precondition');
  assert.equal(night.vitals.hr.avg, 90);
  assert.equal(night.vitals.hr.max, 90);
  assert.ok(night.vitals.hr.minutes > 0);
  assert.equal('series' in night.vitals, false);
});

test('a child without a sensor has NO `vitals` key, on every route', async () => {
  // Kills: attaching `vitals: null` (the response would no longer be what clients got before).
  const { last, start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, planted(start, end)); // another child's sensor must not leak
  const live = await get('/sleep/live', adminToken, BARE);
  assert.equal(live.body.night.status, 'ok', 'precondition');
  assert.equal('vitals' in live.body.night, false);
  const detail = await get(`/sleep/${last}?detail=1`, adminToken, BARE);
  assert.equal(detail.body.status, 'ok');
  assert.equal('vitals' in detail.body, false);
});

test('a caregiver reads the same vitals as an admin', async () => {
  const { start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, planted(start, end));
  const asAdmin = await get('/sleep/live');
  const asCaregiver = await get('/sleep/live', caregiverToken);
  assert.equal(asCaregiver.status, 200);
  assert.deepEqual(asCaregiver.body.night.vitals, asAdmin.body.night.vitals);
  assert.ok(asCaregiver.body.night.vitals.hr);
});

test('/sleep/:date: detail=1 adds the 5-minute series over the timeline span; a plain read has the summary only', async () => {
  // Kills: no series on the detail read; a series on every plain read; the series on a grid other than 5 minutes.
  const { last, start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, planted(start, end));
  const detail = (await get(`/sleep/${last}?detail=1`)).body;
  assert.equal(detail.status, 'ok');
  const series = detail.vitals.series;
  assert.ok(Array.isArray(series) && series.length > 100, `a series over the night (${series?.length})`);
  for (const p of series) {
    assert.match(p.t, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/);
    assert.equal(Date.parse(`${p.t.replace(' ', 'T')}Z`) % (5 * MIN), 0, `${p.t} is on the 5-minute grid`);
  }
  // The summary is still onset..wake (90), while the series shows the 111 settling minutes and the 140 morning ones.
  assert.equal(detail.vitals.hr.avg, 90);
  assert.ok(series.some((p) => p.hr === 111) && series.some((p) => p.hr === 140) && series.some((p) => p.hr === 90));
  // The series is kept to the timeline's own span: the bar's first and last minute.
  assert.ok(series.every((p) => p.t >= (detail.display_start || detail.window_start).slice(0, 16) && p.t < (detail.display_end || detail.window_end)));
  const plain = (await get(`/sleep/${last}`)).body;
  assert.equal(plain.vitals.hr.avg, 90);
  assert.equal('series' in plain.vitals, false);
});

test('/sleep/:date: the Recompute dialog\'s detector-only previews (raw / stored context) carry no vitals', async () => {
  const { last, start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, planted(start, end));
  assert.equal(computeAndStoreNight(CHILD, last).status, 'ok');
  const raw = (await get(`/sleep/${last}?context=current&raw=1`)).body;
  assert.equal(raw.status, 'ok');
  assert.equal('vitals' in raw, false);
  const stored = (await get(`/sleep/${last}?context=stored`)).body;
  assert.equal('vitals' in stored, false);
  assert.equal('vitals' in (await get(`/sleep/${last}?stored=1`)).body.night, false, 'and the saved-row read');
});

test('a night corrected by a parent: the vitals follow the corrected wake, and still come back', async () => {
  // Kills: summarising the detector's wake instead of the night the page shows. The wake moves from 60 minutes before the
  // end to 90 before it; the 140s of the morning start at 60 before the end, so this moves the summary only if the
  // correction is read: with the detector's wake the minutes 90..60 before the end (planted 90) are included, with the
  // corrected one they are not, and the planted 150 below sits in exactly that span.
  const { last, start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, (t) => (t < start + 10 * MIN ? 111 : t < end - 90 * MIN ? 90 : t < end - HOUR ? 150 : 140));
  assert.equal(computeAndStoreNight(CHILD, last).status, 'ok');
  const before = (await get('/sleep/live')).body.night.vitals.hr;
  assert.ok(before.max === 150 && before.avg > 90, `uncorrected: the 150s are inside the night (${JSON.stringify(before)})`);
  saveNightReview(CHILD, last, { trueWakeAt: sqlAt(end - 90 * MIN) }, { storeFirst: false });
  const after = (await get('/sleep/live')).body.night;
  assert.equal(after.corrected, true, 'precondition');
  assert.deepEqual([after.vitals.hr.avg, after.vitals.hr.max], [90, 90]);
});

test('reading a night twice changes no table', async () => {
  const { last, start, end } = layLastNight();
  laySensor(CHILD, start - 30 * MIN, end + 30 * MIN, planted(start, end));
  const tables = ['sleep_nights', 'sleep_reviews', 'esphome_readings', 'esphome_entities', 'esphome_devices', 'activity_samples'];
  const snap = () => JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
  const before = snap();
  await get('/sleep/live');
  await get(`/sleep/${last}?detail=1`);
  await get('/sleep/live');
  assert.equal(snap(), before);
});
