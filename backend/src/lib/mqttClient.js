import mqtt from 'mqtt';
import db from '../db.js';
import { logger } from './logger.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireMotionAlert } from './motionAlert.js';

let client = null;
let currentConfigKey = null;
const readings = new Map(); // topic -> { temperature?, humidity?, receivedAt }
const motionLastAlert = new Map(); // camera_id -> last MQTT-motion alert time (ms), for per-camera cooldown

function getMqttSettings() {
  return db
    .prepare('SELECT mqtt_enabled, mqtt_host, mqtt_port, mqtt_username, mqtt_password FROM settings WHERE id = ?')
    .get('app');
}

function configKey(cfg) {
  return JSON.stringify(cfg);
}

export function getReading(topic) {
  if (!topic) return null;
  return readings.get(topic) || null;
}

function subscribeAllCameraTopics() {
  if (!client) return;
  // Both the temperature/humidity topic and the (separate) camera-native motion topic. UNION so a
  // camera that uses the same topic for both is only subscribed once.
  const topics = db
    .prepare(
      `SELECT mqtt_topic AS t FROM cameras WHERE mqtt_topic IS NOT NULL AND mqtt_topic != ''
       UNION
       SELECT motion_mqtt_topic AS t FROM cameras WHERE motion_mqtt_topic IS NOT NULL AND motion_mqtt_topic != ''`
    )
    .all()
    .map((r) => r.t);
  if (topics.length === 0) return;
  client.subscribe(topics, (err) => {
    if (err) logger.error('[mqtt] Failed to subscribe to camera topics:', err.message);
  });
}

// Does this payload signal motion? An explicit per-camera override wins (payload equals/contains it,
// or a JSON field equals it); otherwise a smart default recognises the common shapes cameras emit —
// plain ON/1/true/"motion", and JSON like {"motion":true} / {"event":"motion"} / {"state":"ON"} —
// while treating an explicit OFF/false/clear as "no motion" (cameras publish both edges).
// Tokens that mean motion has ENDED vs STARTED. Compared per word so a compound payload like
// "motion_stop" (which contains "motion") is correctly read as OFF, not ON — the sonoff-hack
// firmware emits exactly motion_start / motion_stop.
const OFF_TOKENS = new Set(['off', '0', 'false', 'no', 'clear', 'cleared', 'inactive', 'idle', 'stop', 'stopped', 'end', 'ended', 'closed', 'none', 'normal']);
const ON_TOKENS = new Set(['on', '1', 'true', 'yes', 'motion', 'active', 'detected', 'start', 'started', 'open', 'alarm', 'detect']);

function valueLooksLikeMotion(v) {
  if (v === true) return true;
  if (typeof v === 'number') return v > 0;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  if (!s) return false;
  const tokens = s.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((t) => OFF_TOKENS.has(t))) return false; // an OFF word wins (e.g. "motion_stop")
  if (tokens.some((t) => ON_TOKENS.has(t))) return true;
  return /motion|detect|alarm/.test(s);
}

export function isMotionPayload(payloadStr, override) {
  const s = (payloadStr || '').trim();
  if (!s) return false;
  if (override && override.trim()) {
    const o = override.trim().toLowerCase();
    if (s.toLowerCase() === o || s.toLowerCase().includes(o)) return true;
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object') return Object.values(j).some((v) => String(v).toLowerCase() === o);
    } catch { /* not JSON */ }
    return false;
  }
  try {
    const j = JSON.parse(s);
    if (j && typeof j === 'object' && !Array.isArray(j)) {
      const fields = ['motion', 'motion_detected', 'motionDetected', 'event', 'state', 'alarm', 'occupancy', 'value', 'status', 'detected'];
      const known = fields.filter((f) => f in j);
      if (known.length) return known.some((f) => valueLooksLikeMotion(j[f]));
      // Unknown object shape — fall through to a whole-payload string check.
    }
  } catch { /* not JSON */ }
  return valueLooksLikeMotion(s);
}

// Camera-native motion over MQTT: a camera on the 'mqtt' source published to its motion topic. Runs
// the SAME downstream as frame-diff (record event + push with snapshot), gated by the same per-camera
// cooldown and quiet-hours schedule so a chatty camera can't flood alerts.
function handleMotionMessage(topic, str) {
  let cams;
  try {
    cams = db
      .prepare(
        `SELECT * FROM cameras
           WHERE motion_mqtt_topic = ? AND detect_motion_enabled = 1 AND detect_source = 'mqtt'
             AND (disabled IS NULL OR disabled = 0)`
      )
      .all(topic);
  } catch {
    return;
  }
  for (const cam of cams) {
    if (!isMotionPayload(str, cam.motion_mqtt_value)) continue;
    if (!inActiveWindow(cam)) continue; // outside quiet-hours window: fully ignored
    const now = Date.now();
    const cooldownMs = Math.max(1, cam.detect_cooldown_s ?? 60) * 1000;
    if (now - (motionLastAlert.get(cam.id) || 0) < cooldownMs) continue;
    motionLastAlert.set(cam.id, now);
    logger.info(`[detect] MQTT motion on "${cam.name}" (topic ${topic})`);
    fireMotionAlert(cam, 'camera-reported motion (MQTT)').catch(() => {});
  }
}

// Called on startup, after a settings save, and after any camera add/edit/delete that
// touches an MQTT topic - cheap to call liberally, since it no-ops if nothing actually
// changed (aside from re-subscribing, which is itself a no-op for already-subscribed
// topics).
export function refreshMqttConnection() {
  const cfg = getMqttSettings();

  // Disabled counts the same as unconfigured: tear down any live connection and,
  // critically, don't leave a client endlessly retrying a broker that's deliberately
  // off. The saved broker config itself is untouched - re-enabling picks it back up.
  if (!cfg.mqtt_host || !cfg.mqtt_enabled) {
    if (client) {
      client.end(true);
      client = null;
      currentConfigKey = null;
      readings.clear();
      logger.info('[mqtt] Disconnected (disabled or unconfigured).');
    }
    return;
  }

  const key = configKey(cfg);
  if (key === currentConfigKey) {
    subscribeAllCameraTopics(); // broker config unchanged, but camera topics might not be
    return;
  }

  if (client) client.end(true);
  currentConfigKey = key;
  readings.clear();

  client = mqtt.connect(`mqtt://${cfg.mqtt_host}:${cfg.mqtt_port || 1883}`, {
    username: cfg.mqtt_username || undefined,
    password: cfg.mqtt_password || undefined,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    logger.info('[mqtt] Connected to broker.');
    subscribeAllCameraTopics();
  });

  client.on('reconnect', () => {
    logger.info('[mqtt] Reconnecting to broker...');
  });

  client.on('error', (err) => {
    logger.error('[mqtt] Connection error:', err.message);
  });

  client.on('message', (topic, payload) => {
    const str = payload.toString();
    // A topic may be a motion topic, a temp/humidity topic, or (rarely) both — try both handlers.
    handleMotionMessage(topic, str);
    // Fails silently on anything unexpected (not JSON, no recognizable fields) - this is meant to
    // degrade gracefully for an unrelated topic/payload shape, not spam errors for something that
    // was never meant to be a temp/humidity reading.
    try {
      const data = JSON.parse(str);
      const reading = { receivedAt: Date.now() };
      if (typeof data.temperature === 'number') reading.temperature = data.temperature;
      if (typeof data.humidity === 'number') reading.humidity = data.humidity;
      if (reading.temperature !== undefined || reading.humidity !== undefined) {
        readings.set(topic, reading);
      }
    } catch {
      // Ignore.
    }
  });
}

export function stopMqtt() {
  if (client) client.end(true);
}

export { subscribeAllCameraTopics };
