// The poller (lib/cameraSensors.js) against a real database and a faked fetch: what it stores, what it must NOT store,
// and the ways a camera can change under a request that is still in flight.
//
// The clock is stepped by hand (setClockForTest), so a 5 s poll, a 60 s back-off and a minute boundary are exact and
// nothing here waits. Timers are never started: tickOnce() is called directly and awaited.
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const sensors = await import('../src/lib/cameraSensors.js');
const { NLCAM_SOURCE } = await import('../src/lib/nightlightCamera.js');
const { purgeCamera } = await import('../src/lib/entityPurge.js');
const { tickOnce, liveSensors, retryCameraSensors, setClockForTest, resetCameraSensorsForTest, stopCameraSensors, pruneNlcamReadings } = sensors;

const T0 = Date.UTC(2026, 10, 20, 3, 0, 0); // on a minute boundary
const IP = '192.168.3.50';
const CAM = 'nl-cam-1';
const RTSP = (pw = 'pw1', host = IP) => `rtsp://nightlight:${pw}@${host}:554/main`;
let now;
let fetchCalls;
let respond;

const ok = (value) => ({ value, state: 'ok' });
const sensorsAnswer = (over = {}) => ({
  simulated: false,
  radar: { presence: ok(true), heart_rate_bpm: ok(92), breathing_rate_bpm: ok(22), distance_cm: ok(80), link: 'up' },
  environment: { temperature_c: ok(21.4), humidity_pct: ok(45) },
  ambient_light_lux: ok(3),
  pressure: { kind: 'digital', occupied: ok(true) },
  ...over,
});
const answer = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function addCamera(id = CAM, extra = {}) {
  makeCamera(db, { id, name: id, extra: { rtsp_url: RTSP(), sensor_source: NLCAM_SOURCE, ...extra } });
}
const rows = (table, where = '') => db.prepare(`SELECT * FROM ${table} ${where}`).all();
const step = async (ms) => { now += ms; await tickOnce(); };

before(() => {
  mock.method(globalThis, 'fetch', async (url, opts) => { fetchCalls.push({ url: String(url), opts }); return respond(url, opts); });
});
after(() => { stopCameraSensors(); mock.restoreAll(); setClockForTest(null); cleanupTempDataDirs(); });
beforeEach(() => {
  resetCameraSensorsForTest();
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM sensor_readings').run();
  db.prepare('DELETE FROM nlcam_readings').run();
  now = T0;
  setClockForTest(() => now);
  fetchCalls = [];
  respond = () => answer(sensorsAnswer());
});

test('a poll stores ok climate in sensor_readings and, a minute later, the minute of radar, light and pad readings', async () => {
  addCamera();
  await tickOnce();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, `http://${IP}:8080/api/v1/sensors`);
  assert.equal(fetchCalls[0].opts.headers.Authorization, `Basic ${Buffer.from('nightlight:pw1').toString('base64')}`);
  const climate = rows('sensor_readings');
  assert.equal(climate.length, 1);
  assert.deepEqual([climate[0].camera_id, climate[0].temperature, climate[0].humidity, climate[0].simulated], [CAM, 21.4, 45, 0]);
  assert.equal(rows('nlcam_readings').length, 0, 'the minute is not finished yet');
  await step(5000);
  await step(5000);
  assert.equal(rows('sensor_readings').length, 1, 'climate is sampled once per five minutes, like the MQTT sampler');
  await step(55_000); // into the next minute
  const minute = rows('nlcam_readings', 'ORDER BY metric');
  assert.deepEqual([...new Set(minute.map((r) => r.bucket))], [Math.floor(T0 / 60000)]);
  assert.deepEqual(minute.map((r) => r.metric), ['breathing_rate', 'distance_cm', 'heart_rate', 'light_lux', 'pad_occupied', 'presence']);
  const hr = minute.find((r) => r.metric === 'heart_rate');
  assert.deepEqual([hr.n, hr.mean, hr.min, hr.max, hr.last, hr.simulated], [3, 92, 92, 92, 92, 0]);
  assert.equal(minute.find((r) => r.metric === 'presence').mean, 1);
  await step(5 * 60_000);
  assert.equal(rows('sensor_readings').length, 2, 'the next five-minute slot');
  const live = liveSensors(CAM);
  assert.equal(live.status, 'ok');
  assert.equal(live.metrics.temperature, 21.4);
  assert.equal(live.metrics.heart_rate, 92);
});

test('a reading that is not ok stores nothing and is not shown, whatever value is planted under it', async () => {
  addCamera();
  const planted = sensorsAnswer();
  const leaves = [];
  const walk = (node) => { if (node && typeof node === 'object') { if ('state' in node) leaves.push(node); else Object.values(node).forEach(walk); } };
  walk(planted);
  assert.equal(leaves.length, 8, "the fixture has eight readings");
  for (const leaf of leaves) { leaf.state = 'uncertain'; leaf.value = typeof leaf.value === 'boolean' ? true : 21; }
  respond = () => answer(planted);
  await tickOnce();
  await step(65_000);
  assert.equal(rows('sensor_readings').length, 0);
  assert.equal(rows('nlcam_readings').length, 0);
  assert.deepEqual(liveSensors(CAM).metrics, {});
});

test('simulated is stored per sample: a camera that does not say real is simulated', async () => {
  addCamera();
  respond = () => answer(sensorsAnswer({ simulated: true }));
  await tickOnce();
  await step(65_000);
  assert.ok(rows('sensor_readings').every((r) => r.simulated === 1));
  assert.ok(rows('nlcam_readings').length > 0 && rows('nlcam_readings').every((r) => r.simulated === 1));
  assert.equal(liveSensors(CAM).simulated, true);
  db.prepare('DELETE FROM sensor_readings').run();
  db.prepare('DELETE FROM nlcam_readings').run();
  resetCameraSensorsForTest();
  const noFlag = sensorsAnswer(); delete noFlag.simulated;
  respond = () => answer(noFlag);
  now += 10 * 60_000;
  await tickOnce();
  await step(65_000);
  assert.ok(rows('sensor_readings').length > 0 && rows('sensor_readings').every((r) => r.simulated === 1), 'a missing flag fails toward simulated');
  db.prepare('DELETE FROM sensor_readings').run();
  resetCameraSensorsForTest();
  respond = () => answer(sensorsAnswer({ simulated: false }));
  now += 10 * 60_000;
  await tickOnce();
  assert.equal(rows('sensor_readings')[0].simulated, 0, 'only an explicit false is real');
});

test('a group that is switched off is not stored or shown; with all four off the camera is not contacted', async () => {
  addCamera(CAM, { sensor_groups: JSON.stringify({ climate: false, radar: true, light: false, pad: false }) });
  await tickOnce();
  await step(65_000);
  assert.equal(rows('sensor_readings').length, 0, 'climate is off');
  assert.deepEqual([...new Set(rows('nlcam_readings').map((r) => r.metric))].sort(), ['breathing_rate', 'distance_cm', 'heart_rate', 'presence']);
  assert.deepEqual(Object.keys(liveSensors(CAM).metrics).sort(), ['breathing_rate', 'distance_cm', 'heart_rate', 'presence']);
  db.prepare('UPDATE cameras SET sensor_groups = ? WHERE id = ?').run(JSON.stringify({ climate: false, radar: false, light: false, pad: false }), CAM);
  fetchCalls = [];
  await step(20_000);
  assert.equal(fetchCalls.length, 0);
  assert.equal(liveSensors(CAM).status, 'off');
});

test('only a literal private address is polled: a name, a public address and a link-local address are never contacted', async () => {
  addCamera('h1', { rtsp_url: RTSP('pw', 'camera.local') });
  addCamera('h2', { rtsp_url: RTSP('pw', '8.8.8.8') });
  addCamera('h3', { rtsp_url: RTSP('pw', '169.254.169.254') });
  addCamera('h4', { rtsp_url: RTSP('pw', '127.0.0.1') });
  await tickOnce();
  await step(10_000);
  assert.equal(fetchCalls.length, 0);
  for (const id of ['h1', 'h2', 'h3', 'h4']) assert.equal(liveSensors(id).status, 'off', id);
});

test('a camera that is not a Nightlight Camera source is never polled', async () => {
  makeCamera(db, { id: 'plain', name: 'plain' });
  makeCamera(db, { id: 'disabled', name: 'disabled', extra: { rtsp_url: RTSP(), sensor_source: NLCAM_SOURCE, disabled: 1 } });
  await tickOnce();
  assert.equal(fetchCalls.length, 0);
});

test('one request in flight per camera, and a failure backs off 5, 10, 20, 40, 60, 60 seconds', async () => {
  addCamera();
  let release;
  respond = () => new Promise((resolve) => { release = () => resolve(answer(sensorsAnswer())); });
  const first = tickOnce();
  const second = tickOnce();
  await Promise.resolve();
  assert.equal(fetchCalls.length, 1, 'the second tick does not start a second request');
  now += 30_000;
  const third = tickOnce();
  await Promise.resolve();
  assert.equal(fetchCalls.length, 1, 'still one in flight after 30 s');
  release();
  await Promise.all([first, second, third]);
  assert.equal(liveSensors(CAM).status, 'ok');

  resetCameraSensorsForTest();
  db.prepare('DELETE FROM sensor_readings').run();
  respond = () => { throw new TypeError('fetch failed'); };
  fetchCalls = [];
  const expectedGaps = [5, 10, 20, 40, 60, 60];
  now = T0;
  await tickOnce();
  let at = now;
  for (const gap of expectedGaps) {
    const before = fetchCalls.length;
    now = at + gap * 1000 - 1;
    await tickOnce();
    assert.equal(fetchCalls.length, before, `no request ${gap} s after the failure, 1 ms early`);
    now = at + gap * 1000;
    await tickOnce();
    assert.equal(fetchCalls.length, before + 1, `a request exactly ${gap} s after the failure`);
    at = now;
  }
  assert.equal(liveSensors(CAM).status, 'offline');
  assert.equal(rows('sensor_readings').length, 0, 'a failing camera writes nothing');
  // A success clears the back-off.
  respond = () => answer(sensorsAnswer());
  now = at + 60_000;
  await tickOnce();
  assert.equal(liveSensors(CAM).status, 'ok');
  const calls = fetchCalls.length;
  await step(4_999);
  assert.equal(fetchCalls.length, calls);
  await step(1);
  assert.equal(fetchCalls.length, calls + 1, 'back on the 5 s cadence');
});

test('a 401 stops polling that camera: never retried, until the login changes or Retry is pressed', async () => {
  addCamera();
  respond = () => answer({ error: 'unauthorized' }, 401);
  await tickOnce();
  assert.equal(liveSensors(CAM).status, 'login_failed');
  assert.equal(fetchCalls.length, 1);
  for (const gap of [5_000, 60_000, 3_600_000, 86_400_000]) await step(gap);
  assert.equal(fetchCalls.length, 1, 'a stale password is not sent again (the camera locks an address out after 10 wrong tries)');
  // The owner fixes the stream password in an ordinary edit: the poll resumes on its own.
  db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(RTSP('newpw'), CAM);
  await step(1000);
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].opts.headers.Authorization, `Basic ${Buffer.from('nightlight:newpw').toString('base64')}`);
  assert.equal(liveSensors(CAM).status, 'login_failed');
  await step(3_600_000);
  assert.equal(fetchCalls.length, 2);
  // Retry resumes it without a change.
  assert.equal(retryCameraSensors(CAM), true);
  await step(1000);
  assert.equal(fetchCalls.length, 3);
  // A camera that was fixed on the camera itself answers 200 after Retry.
  respond = () => answer(sensorsAnswer());
  retryCameraSensors(CAM);
  await step(1000);
  assert.equal(liveSensors(CAM).status, 'ok');
  assert.equal(retryCameraSensors('no-such-camera'), false);
});

test('a camera that changes while a request is in flight is not written for', async () => {
  const mutations = {
    'deleted': () => db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM),
    'disabled': () => db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAM),
    'switched off': () => db.prepare('UPDATE cameras SET sensor_source = NULL WHERE id = ?').run(CAM),
    'moved to another address': () => db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(RTSP('pw1', '192.168.3.99'), CAM),
    'given a new password': () => db.prepare('UPDATE cameras SET rtsp_url = ? WHERE id = ?').run(RTSP('other'), CAM),
    'stopped': () => stopCameraSensors(),
  };
  for (const [what, mutate] of Object.entries(mutations)) {
    resetCameraSensorsForTest();
    db.prepare('DELETE FROM cameras').run();
    db.prepare('DELETE FROM sensor_readings').run();
    db.prepare('DELETE FROM nlcam_readings').run();
    addCamera();
    let release;
    respond = () => new Promise((resolve) => { release = () => resolve(answer(sensorsAnswer())); });
    const pending = tickOnce();
    await Promise.resolve();
    assert.equal(fetchCalls.length > 0, true, `${what}: the request was in flight`);
    mutate();
    release?.();
    await pending;
    assert.equal(rows('sensor_readings').length, 0, `${what}: no climate row (sensor_readings has no foreign key, so a late write would be an orphan)`);
    assert.equal(rows('nlcam_readings').length, 0, `${what}: no minute row`);
    fetchCalls = [];
    resetCameraSensorsForTest();
  }
});

test('a camera that is deleted or switched off is forgotten and its partial minute is dropped', async () => {
  addCamera();
  await tickOnce();
  assert.equal(liveSensors(CAM).status, 'ok');
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  await step(10_000);
  assert.equal(liveSensors(CAM).status, 'connecting', 'no state any more');
  assert.equal(rows('nlcam_readings').length, 0);
});

test('live values older than 30 seconds are not shown as current', async () => {
  addCamera();
  await tickOnce();
  assert.equal(liveSensors(CAM, now + 29_000).metrics.heart_rate, 92);
  assert.deepEqual(liveSensors(CAM, now + 31_000).metrics, {});
  assert.equal(liveSensors(CAM, now + 31_000).status, 'offline');
});

test('deleting a camera deletes its minute rows, and the daily prune keeps only the retention window', async () => {
  addCamera();
  await tickOnce();
  await step(65_000);
  assert.ok(rows('nlcam_readings').length > 0);
  purgeCamera(CAM);
  assert.equal(rows('nlcam_readings').length, 0);

  db.prepare("INSERT OR IGNORE INTO settings (id) VALUES ('app')").run();
  db.prepare("UPDATE settings SET esphome_retention_days = 7 WHERE id = 'app'").run();
  addCamera('keep');
  const nowMin = Math.floor(Date.now() / 60000);
  const insert = db.prepare('INSERT INTO nlcam_readings (camera_id, bucket, metric, n) VALUES (?, ?, ?, 1)');
  insert.run('keep', nowMin - 7 * 24 * 60 - 5, 'presence'); // five minutes outside seven days (a margin, so a minute boundary mid-test cannot flip it)
  insert.run('keep', nowMin - 7 * 24 * 60 + 5, 'presence');     // five minutes inside seven days: kept
  insert.run('keep', nowMin - 60, 'presence');
  pruneNlcamReadings();
  assert.deepEqual(rows('nlcam_readings', 'ORDER BY bucket').map((r) => r.bucket - nowMin), [-7 * 24 * 60 + 5, -60]);
});
