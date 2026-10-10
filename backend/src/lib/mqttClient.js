import mqtt from 'mqtt';
import { domainToASCII } from 'node:url';
import db from '../db.js';
import { logger } from './logger.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';

let client = null;
let currentConfigKey = null;
const readings = new Map(); // topic -> { temperature?, humidity?, receivedAt }
const motionLastAlert = new Map(); // camera_id -> last MQTT-motion alert time (ms), for per-camera cooldown
const seenTopics = new Set(); // topics we've logged a first message for (so "receiving on X" logs once)

// Keep log lines readable — MQTT payloads can be long JSON; show enough to recognise the shape.
function shortPayload(str) {
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

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
    // Log every inbound motion-topic message with how it was read, so the log shows a camera is still
    // reporting (and when it last did) — the thing that would've made a silently-stopped camera obvious.
    const isMotion = isMotionPayload(str, cam.motion_mqtt_value);
    if (!isMotion) {
      logger.info(`[mqtt] "${cam.name}" motion topic ${topic}: ${shortPayload(str)} → no motion`);
      continue;
    }
    if (!inActiveWindow(cam)) {
      logger.info(`[mqtt] "${cam.name}" motion (${topic}) ignored — outside its active/quiet-hours window`);
      continue; // outside quiet-hours window: fully ignored
    }
    const now = Date.now();
    const cooldownMs = Math.max(1, cam.detect_cooldown_s ?? 60) * 1000;
    if (now - (motionLastAlert.get(cam.id) || 0) < cooldownMs) {
      logger.info(`[mqtt] "${cam.name}" motion (${topic}) within cooldown — not re-alerting`);
      continue;
    }
    motionLastAlert.set(cam.id, now);
    logger.info(`[detect] MQTT motion on "${cam.name}" (topic ${topic})`);
    fireDetectionAlert(cam, ALERT.MOTION, 'camera-reported (MQTT)').catch(() => {});
  }
}

// Called on startup, after a settings save, and after any camera add/edit/delete that
// touches an MQTT topic - cheap to call liberally, since it no-ops if nothing actually
// changed (aside from re-subscribing, which is itself a no-op for already-subscribed
// topics).
// Live connection state for the Settings UI. `connected` reflects the mqtt.js client's own
// flag (true once the broker handshake completes, false while retrying/down).
export function mqttStatus() {
  const cfg = getMqttSettings();
  return {
    enabled: !!(cfg.mqtt_enabled && cfg.mqtt_host),
    connected: !!(client && client.connected),
  };
}

// The broker URL for a saved host and port, or an Error whose message says what is wrong (#543). One place, used
// both to REFUSE a bad value at save time (routes/settings.js) and to build the connection, so the two cannot
// disagree about what a usable broker is.
//
// Why it exists: `mqtt.connect` throws synchronously on a port outside 1-65535 ("Port should be >= 0 and < 65536")
// and on a host that is not a URL authority (an unbalanced `[` is "Invalid URL"). Both used to reach the database
// untouched, and then `refreshMqttConnection()` at boot, at the top level of index.js and before the crash guards,
// threw on every start: a container that exits and restarts forever, with the UI that could fix it unreachable.
//
// The host check is "does it survive being put in an mqtt:// URL unchanged": a `/`, `?`, `#` or `@` in it would
// not throw, it would be silently read as a path, a query or a user name, and the client would connect somewhere
// the admin did not type. A host containing one is refused instead. (A path, query or fragment also changes the port
// that URL parses, so the `u.port` comparison alone would catch them; the explicit checks are listed so the intent
// is readable, and a mutant that drops only `u.pathname` is therefore equivalent.)
//
// ⚠️ THE URL CHECK ALONE IS NOT ENOUGH (#641). It runs the WHATWG `URL` parser, but mqtt.js 5.x does NOT use that
// parser: `mqtt.connect` reads the string with Node's legacy `url.parse` (node_modules/mqtt/build/lib/connect/index.js).
// The two disagree on a handful of characters, and the WHATWG one is the more forgiving: it silently DELETES tab, CR
// and LF anywhere in the input, and it accepts `;`, `'` and `%` in a non-special-scheme host, while the legacy parser
// ends the host at each of them and reads the rest as a path (so `broker%20x:8883` is checked as host `broker%20x`
// port 8883 but CONNECTS to `broker` on the default port 1883). The check passed and the client went somewhere else.
// So the host is first held to an alphabet: letters and digits, `.`, `-`, `_` (the underscore is not legal in a DNS
// name but is common on a LAN, and both parsers keep it), or an IPv6 literal in brackets (hex digits, `:` and `.`).
// Anything else, above all whitespace and control characters, is refused BEFORE the URL parser sees it.
//
// An internationalised name (`bücher.example`) is allowed in but handed on as its punycode form
// (`xn--bcher-kva.example`, from `domainToASCII`). The WHATWG parser would percent-encode it and the legacy one
// converts it itself, and a few letters (U+037A is one) are converted by one and refused by the other, so sending
// mqtt.js pure ASCII removes that last place the two could disagree. A name that does not convert is refused.
// test/mqtt-broker-validation.test.js feeds every character to the real mqtt.js parse and compares, so a future
// mqtt.js that reads a character differently fails there instead of here in the field.
const BROKER_HOST_ALPHABET = /^(?:[\p{L}\p{N}_.-]+|\[[0-9A-Fa-f:.]+\])$/u;
const BROKER_ASCII_HOST = /^[a-z0-9_.-]+$/;

export function mqttBrokerUrl(rawHost, port) {
  const p = port || 1883; // the default the settings screen documents for a blank port
  if (!Number.isInteger(Number(p)) || Number(p) < 1 || Number(p) > 65535) {
    throw new Error(`the port ${JSON.stringify(p)} is not a whole number between 1 and 65535`);
  }
  // JSON.stringify escapes \n, \t and the other C0 controls but leaves an invisible character (no-break or
  // zero-width space, line separator) as it is, which is exactly the one the admin cannot see to fix.
  const shown = typeof rawHost === 'string'
    ? JSON.stringify(rawHost).replace(/(?! )[\p{C}\p{Z}]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    : JSON.stringify(rawHost) ?? String(rawHost);
  const notAHost = () => new Error(`the host ${shown} is not a valid hostname or address (use letters, digits, ".", "-" and "_", or an IPv6 address in [brackets]; no spaces or other symbols)`);
  // Surrounding spaces are harmless typing noise (the settings route trims them before saving; a value already
  // stored that way is trimmed here too, so boot and save read the same host). Inner whitespace is not.
  const typed = typeof rawHost === 'string' ? rawHost.trim() : '';
  if (!BROKER_HOST_ALPHABET.test(typed)) throw notAHost();
  // Only a name with a non-ASCII letter is converted. An all-ASCII host goes through exactly as typed: domainToASCII
  // would also rewrite numeric forms (`1.2.3` becomes `1.2.0.3`) and refuse a name ending in a number.
  const host = [...typed].every((ch) => ch.charCodeAt(0) < 128) ? typed : domainToASCII(typed);
  if (!host.startsWith('[') && !BROKER_ASCII_HOST.test(host.toLowerCase())) throw notAHost();
  let u;
  try { u = new URL(`mqtt://${host}:${p}`); } catch { throw new Error(`the host ${shown} is not a valid hostname or address`); }
  if (!u.hostname || u.username || u.password || u.pathname || u.search || u.hash || u.port !== String(Number(p))) {
    throw new Error(`the host ${shown} must be just a hostname or address, with no user name, path or query`);
  }
  return `mqtt://${host}:${Number(p)}`;
}

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
    seenTopics.clear();
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

  // ⚠️ MUST NOT THROW (#543). This runs at boot before the crash guards are installed, and after every settings
  // save and camera edit. A bad value that is ALREADY stored (saved by an older version, or written by hand) has to
  // leave MQTT off and the app up, not take the process down on every start. The cache key is reset so that the
  // next call, after the admin fixes the value, tries again instead of treating the failed attempt as connected.
  try {
    client = mqtt.connect(mqttBrokerUrl(cfg.mqtt_host, cfg.mqtt_port), {
      username: cfg.mqtt_username || undefined,
      password: cfg.mqtt_password || undefined,
      reconnectPeriod: 5000,
    });
  } catch (e) {
    client = null;
    currentConfigKey = null;
    logger.error(`[mqtt] Not connecting: ${e.message}. MQTT stays off until the broker host and port are fixed in Settings.`);
    return;
  }

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
    // Log the first message seen on each topic (once), so it's visible that the broker is actually
    // delivering on a subscribed topic — invaluable when a topic is mistyped and nothing arrives.
    if (!seenTopics.has(topic)) {
      seenTopics.add(topic);
      logger.info(`[mqtt] receiving on topic "${topic}" — first message: ${shortPayload(str)}`);
    }
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
