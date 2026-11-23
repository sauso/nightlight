// Polls a Nightlight Camera's local sensor API (lib/nightlightCamera.js) and stores what it says.
//
// WHAT IS STORED, AND WHAT IS NOT
//  - Room temperature and humidity go to the existing sensor_readings table, one row per camera per 5 minutes: the
//    same table, cadence and 30-day retention the MQTT sampler uses, so the child page chart and the night's climate
//    average work unchanged. A camera has ONE climate source: while its climate switch is on, lib/sensorSampler.js
//    skips it (no mixing, no double weighting; an API outage is an honest gap).
//  - Radar (presence, heart rate, breathing rate, distance), light and the bed pad go to nlcam_readings, one row per
//    camera, minute and quantity (mean/min/max/n/last), like the ESPHome readings. NOTHING reads them in this phase:
//    the night card, the score and the sleep shadow are not fed from the camera (they need a per-source rule; a 5 s
//    poll cannot meet the "30 breathing updates per minute" rule that was measured on ESPHome).
//  - Only `ok` readings, only for the groups the owner left on, only plausible numbers (see nightlightCamera.js).
//  - Every row carries `simulated`. A camera running invented bench data says so, and a sample is simulated unless
//    the answer carries an explicit `simulated: false`. sleepAnalysis.js nightClimate ignores simulated rows.
//
// LIFECYCLE
//  - One 1 s tick looks at every camera with sensor_source = 'nightlight-api'. A camera is polled every 5 s, one
//    request in flight, 2 s timeout, at most 4 cameras at once. A failure backs off 5, 10, 20, 40, 60 s.
//  - A 401 STOPS polling that camera. The camera locks an address out for 5 minutes after 10 wrong logins in a
//    minute, so retrying a stale password every 5 s would lock Nightlight out (its own stream login too, same
//    address). It resumes when the stored login or address changes, or the owner presses Retry.
//  - A camera that is deleted, disabled, edited or switched off while a request is in flight must not be written
//    for: each camera has a generation that any such change bumps, and every write re-reads the camera row and
//    drops the result unless it still matches (sensor_readings has no foreign key, so a late write would leave an
//    orphan row).
import db, { deviceReadingRetentionDays } from '../db.js';
import { logger } from './logger.js';
import { safeInterval } from './processGuards.js';
import {
  NLCAM_SOURCE, NLCAM_PORT, METRIC_GROUP, GROUPS, parseGroups, parseSensors, fetchLanJson, readHealth, cameraHost, cameraLogin, isNightlightHost,
} from './nightlightCamera.js';

const TICK_MS = 1000;
const POLL_MS = 5000;
const FETCH_TIMEOUT_MS = 2000;
const BACKOFF_MS = [5000, 10000, 20000, 40000, 60000];
const MAX_CONCURRENT = 4;
// A reading older than this is not shown as current.
export const LIVE_FRESH_MS = 30000;
// Same cadence as sensorSampler.js: the climate chart and the night average were built for one row per 5 minutes.
const CLIMATE_EVERY_MS = 5 * 60 * 1000;
const MINUTE_MS = 60000;
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

const states = new Map();
let tickTimer = null;
let pruneTimer = null;
let stopped = false;
// The clock is a variable only so a test can step minutes without waiting; production never sets it.
let clock = () => Date.now();
export function setClockForTest(fn) { clock = fn || (() => Date.now()); }

const loadCamera = () => db.prepare(
  `SELECT id, rtsp_url, onvif_username, onvif_password, disabled, sensor_source, sensor_api_port, sensor_groups, nlcam_device_id
     FROM cameras WHERE id = ?`
);
const listCameras = () => db.prepare(
  `SELECT id, rtsp_url, onvif_username, onvif_password, disabled, sensor_source, sensor_api_port, sensor_groups, nlcam_device_id
     FROM cameras WHERE sensor_source = ?`
);

const portOf = (cam) => (Number.isInteger(cam?.sensor_api_port) ? cam.sensor_api_port : NLCAM_PORT);

// Which address and login this camera is polled with. A change in either is a new camera as far as a stopped poll
// is concerned: it is retried at once, and a request still in flight for the old values is dropped.
// The key is the values themselves (as JSON, so no separator can blur two fields together), compared in memory and
// never stored or sent. It was a SHA-256 of them until the 0.50.0 release scan (CodeQL js/insufficient-password-hash)
// read that as password hashing; it was never that, and the plaintext login is already in `cam` and in every request
// this poller makes, so hashing it bought nothing.
function fingerprint(cam) {
  const login = cameraLogin(cam);
  return JSON.stringify([cameraHost(cam), portOf(cam), login?.username, login?.password]);
}

function newState(key) {
  // healthSimulated starts true: until /health has answered, a sample is treated as simulated.
  return { key, generation: 0, nextAt: 0, failures: 0, status: 'connecting', inFlight: null, latest: null, minute: null, lastClimateAt: 0, warned: false, healthAt: 0, healthSimulated: true };
}

function abortInFlight(st) {
  if (st.inFlight) { st.inFlight.abort(); st.inFlight = null; }
}

// A camera's partial minute and last reading do not survive a change of address, login or switch.
function reset(st, key) {
  abortInFlight(st);
  st.generation++;
  st.key = key;
  st.nextAt = 0;
  st.failures = 0;
  st.status = 'connecting';
  st.latest = null;
  st.minute = null;
  st.healthAt = 0;
  st.healthSimulated = true;
}

const insertClimate = () => db.prepare('INSERT INTO sensor_readings (camera_id, temperature, humidity, simulated) VALUES (?, ?, ?, ?)');
const insertMinute = () => db.prepare(
  `INSERT OR IGNORE INTO nlcam_readings (camera_id, bucket, metric, n, mean, min, max, last, simulated)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// Writes the finished minute. INSERT OR IGNORE: a minute is written once; if the process restarts mid-minute the
// second, partial write of that minute is ignored rather than allowed to overwrite the first (a rare partial minute,
// stated rather than merged).
function flushMinute(cameraId, minute, groups) {
  if (!minute) return;
  const insert = insertMinute();
  db.transaction(() => {
    for (const [metric, a] of minute.acc) {
      // A group the owner switched off after this minute began is not stored (code review, 2026-11-20).
      if (!groups[METRIC_GROUP[metric]]) continue;
      insert.run(cameraId, minute.bucket, metric, a.n, a.sum / a.n, a.min, a.max, a.last, minute.simulated ? 1 : 0);
    }
  })();
}

// Called with a poll's result AFTER the camera row was re-read and matched.
function record(cam, st, sensorsParsed, groups, now) {
  // Simulated if EITHER the /sensors answer or the last /health says so (an explicit real from both is the only real).
  const parsed = { ...sensorsParsed, simulated: sensorsParsed.simulated || st.healthSimulated };
  const metrics = {};
  for (const [metric, value] of Object.entries(parsed.metrics)) if (value != null && groups[METRIC_GROUP[metric]]) metrics[metric] = value;
  st.latest = { at: now, simulated: parsed.simulated, metrics };
  if (parsed.simulated && !st.warned) {
    st.warned = true;
    logger.info(`[nlcam] camera ${cam.id} reports simulated sensors: its readings are stored flagged and never used for sleep`);
  }
  // Climate: one row per 5 minutes, only when the switch is on and the camera gave an ok value.
  if (groups.climate && (metrics.temperature != null || metrics.humidity != null) && now - st.lastClimateAt >= CLIMATE_EVERY_MS) {
    insertClimate().run(cam.id, metrics.temperature ?? null, metrics.humidity ?? null, parsed.simulated ? 1 : 0);
    st.lastClimateAt = now;
  }
  // Everything else: per-minute accumulators.
  const bucket = Math.floor(now / MINUTE_MS);
  if (st.minute && st.minute.bucket !== bucket) { flushMinute(cam.id, st.minute, groups); st.minute = null; }
  for (const [metric, value] of Object.entries(metrics)) {
    if (METRIC_GROUP[metric] === 'climate') continue;
    if (!st.minute) st.minute = { bucket, acc: new Map(), simulated: false };
    let a = st.minute.acc.get(metric);
    if (!a) { a = { n: 0, sum: 0, min: value, max: value, last: value }; st.minute.acc.set(metric, a); }
    a.n++; a.sum += value; a.min = Math.min(a.min, value); a.max = Math.max(a.max, value); a.last = value;
    if (parsed.simulated) st.minute.simulated = true;
  }
}

// How often /health is asked again (it is also asked on the first poll after any reset). It is what ties the address to
// the device Nightlight recorded, and where a bench camera's `simulated: true` is learned.
const HEALTH_EVERY_MS = 5 * 60 * 1000;

async function poll(cam, st) {
  const generation = st.generation;
  const ctrl = new AbortController();
  st.inFlight = ctrl;
  const host = cameraHost(cam);
  const port = portOf(cam);
  // IDENTITY AND PROVENANCE (code review, 2026-11-20). An address can come to belong to another device, and /sensors alone
  // cannot say so; and a camera whose /health says simulated must keep every sample simulated even if its /sensors answer
  // says otherwise. So /health is asked first on the first poll and every 5 minutes: it must still be a Nightlight Camera
  // with the id recorded when the owner switched sensors on, or nothing is stored (status `wrong_device`, retried on the
  // back-off like any failure), and its `simulated` is remembered.
  const needHealth = !st.healthAt || clock() - st.healthAt >= HEALTH_EVERY_MS;
  const health = needHealth ? await readHealth(host, { port, signal: ctrl.signal }) : null;
  let result;
  if (needHealth && !health) result = { ok: false, reason: 'no_health' };
  else if (needHealth && cam.nlcam_device_id && health.device_id !== cam.nlcam_device_id) result = { ok: false, reason: 'wrong_device' };
  else {
    result = await fetchLanJson(host, '/api/v1/sensors', {
      port, login: cameraLogin(cam), timeoutMs: FETCH_TIMEOUT_MS, signal: ctrl.signal,
    });
  }
  if (st.inFlight === ctrl) st.inFlight = null;
  // Stopped, switched off, deleted or edited meanwhile: write nothing.
  if (stopped || st.generation !== generation) return;
  const fresh = loadCamera().get(cam.id);
  if (!fresh || fresh.disabled || fresh.sensor_source !== NLCAM_SOURCE || fingerprint(fresh) !== st.key) return;
  const at = clock();
  if (result.ok) {
    st.failures = 0;
    st.status = 'ok';
    st.nextAt = at + POLL_MS;
    if (health) { st.healthAt = at; st.healthSimulated = health.simulated; }
    record(fresh, st, parseSensors(result.json), parseGroups(fresh.sensor_groups), at);
    return;
  }
  if (result.status === 401) {
    // Never retried until the login or address changes (or the owner presses Retry): see the header.
    st.status = 'login_failed';
    st.nextAt = Infinity;
    return;
  }
  st.failures++;
  st.status = result.reason === 'wrong_device' ? 'wrong_device' : 'offline';
  st.nextAt = at + BACKOFF_MS[Math.min(st.failures - 1, BACKOFF_MS.length - 1)];
}

export function tickOnce(now = clock()) {
  const cams = listCameras().all(NLCAM_SOURCE);
  const seen = new Set();
  let active = [...states.values()].filter((s) => s.inFlight).length;
  const started = [];
  for (const cam of cams) {
    seen.add(cam.id);
    const key = fingerprint(cam);
    let st = states.get(cam.id);
    if (!st) { st = newState(key); states.set(cam.id, st); }
    else if (st.key !== key) reset(st, key);
    const groups = parseGroups(cam.sensor_groups);
    if (cam.disabled || !GROUPS.some((g) => groups[g]) || !isNightlightHost(cameraHost(cam))) {
      if (st.status !== 'off') reset(st, key);
      st.status = 'off';
      st.nextAt = Infinity;
      continue;
    }
    if (st.status === 'off') { st.status = 'connecting'; st.nextAt = 0; }
    if (st.inFlight || now < st.nextAt || active >= MAX_CONCURRENT) continue;
    active++;
    started.push(poll(cam, st, now).catch((err) => {
      st.inFlight = null;
      logger.warn(`[nlcam] poll of ${cam.id} failed: ${err.code || err.name || 'error'}`);
    }));
  }
  // A camera that no longer has the source (deleted, switched off): forget it. Its partial minute is dropped.
  for (const [id, st] of states) if (!seen.has(id)) { abortInFlight(st); st.generation++; states.delete(id); }
  // The interval ignores this; a test awaits it to know the polls it started have finished.
  return Promise.all(started);
}

// Tests only: forget every camera's state and allow polling again, without starting the timers.
export function resetCameraSensorsForTest() {
  for (const st of states.values()) abortInFlight(st);
  states.clear();
  stopped = false;
}

// The owner pressed Retry on a camera whose login failed.
export function retryCameraSensors(cameraId) {
  const st = states.get(cameraId);
  if (!st) return false;
  st.status = 'connecting';
  st.failures = 0;
  st.nextAt = 0;
  return true;
}

// What the screens show for one camera, from memory only (the camera list calls this for every camera). Values older
// than LIVE_FRESH_MS are not shown as current. Null when the camera is not polled at all.
export function liveSensors(cameraId, now = clock()) {
  const st = states.get(cameraId);
  if (!st) return { status: 'connecting', simulated: null, metrics: {} };
  const current = st.latest && now - st.latest.at <= LIVE_FRESH_MS ? st.latest : null;
  const status = st.status === 'ok' && !current ? 'offline' : st.status;
  return { status, simulated: st.latest ? st.latest.simulated : null, metrics: current ? { ...current.metrics } : {} };
}

// Bounded by the same retention setting as the ESPHome readings (default 30 days).
// In batches of 1000 rows with a yield between them (the esphome prune's shape), so a first prune of a long history
// cannot hold the event loop; a shutdown stops it between batches.
const PRUNE_BATCH = 1000;
export async function pruneNlcamReadings() {
  try {
    const days = deviceReadingRetentionDays();
    const cutoff = Math.floor(Date.now() / MINUTE_MS) - days * 24 * 60;
    const batch = db.prepare(
      `DELETE FROM nlcam_readings WHERE (camera_id, bucket, metric) IN
         (SELECT camera_id, bucket, metric FROM nlcam_readings WHERE bucket < ? LIMIT ${PRUNE_BATCH})`
    );
    let total = 0;
    for (;;) {
      const { changes } = batch.run(cutoff);
      total += changes;
      if (changes < PRUNE_BATCH || stopped) break;
      await new Promise((resolve) => setImmediate(resolve));
      if (stopped) break;
    }
    if (total > 0) logger.info(`[nlcam] Pruned ${total} reading(s) older than ${days} days.`);
  } catch (err) {
    logger.warn(`[nlcam] prune failed: ${err.code || err.name || 'error'}`);
  }
}

export function startCameraSensors() {
  if (tickTimer) return;
  stopped = false;
  tickTimer = safeInterval('nlcam-sensors', TICK_MS, () => tickOnce());
  pruneTimer = safeInterval('nlcam-prune', PRUNE_EVERY_MS, () => pruneNlcamReadings());
  tickTimer.unref?.();
  pruneTimer.unref?.();
  pruneNlcamReadings();
}

// Idempotent. Aborts every request in flight and forgets all state; a request that still completes writes nothing
// (the `stopped` check in poll). Nulled so a later start is not a silent no-op (issue #278).
export function stopCameraSensors() {
  stopped = true;
  clearInterval(tickTimer);
  clearInterval(pruneTimer);
  tickTimer = null;
  pruneTimer = null;
  for (const st of states.values()) { abortInFlight(st); st.generation++; }
  states.clear();
}
