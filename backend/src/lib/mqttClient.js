import mqtt from 'mqtt';
import { domainToASCII } from 'node:url';
import { X509Certificate } from 'node:crypto';
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
    .prepare(
      `SELECT mqtt_enabled, mqtt_host, mqtt_port, mqtt_username, mqtt_password,
              mqtt_tls, mqtt_tls_ca, mqtt_tls_verify FROM settings WHERE id = ?`
    )
    .get('app');
}

// The broker's most recent connection error, in words an admin can act on, or null. Kept so the Settings screen can
// say WHY it is disconnected (a certificate that is not trusted is invisible otherwise: the badge only turns red, and
// the reason lived only in the container log). Cleared on a successful connect and whenever the configuration changes.
let lastError = null;

// A short, safe description of a connection error. Never the raw TLS detail, never anything that could hold a
// certificate: a recognised code gets a sentence written here, and an unrecognised one gets its message cut to 200
// characters with any PEM block removed first.
//
// "The broker's own certificate" is only a usable CA when that certificate is SELF-SIGNED. A broker certificate signed
// by an authority, pasted as the CA, is refused by the TLS layer (UNABLE_TO_VERIFY_LEAF_SIGNATURE, measured against the
// test broker in mqtt-tls.test.js), so every sentence says "for a self-signed broker" next to it (#537 review).
const ISSUER_NOT_TRUSTED = "The broker's certificate could not be verified: its issuer is not trusted. Add the CA certificate that signed it below (or, for a self-signed broker, the broker's own certificate), or turn off \"Verify the broker's certificate\".";
const MQTT_ERRORS = {
  DEPTH_ZERO_SELF_SIGNED_CERT: "The broker's certificate is self-signed and not trusted. Add the CA certificate below (for a self-signed broker, that is the broker's own certificate), or turn off \"Verify the broker's certificate\".",
  SELF_SIGNED_CERT_IN_CHAIN: "The broker's certificate chain ends in an authority Nightlight does not trust. Add that CA certificate below, or turn off \"Verify the broker's certificate\".",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ISSUER_NOT_TRUSTED,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: ISSUER_NOT_TRUSTED,
  UNABLE_TO_GET_ISSUER_CERT: ISSUER_NOT_TRUSTED,
  CERT_HAS_EXPIRED: "The broker's certificate has expired. Renew it on the broker.",
  CERT_NOT_YET_VALID: "The broker's certificate is not valid yet. Check the date and time on the broker and on this server.",
  ERR_TLS_CERT_ALTNAME_INVALID: "The broker's certificate is not valid for the host name or address entered above. Use the name the certificate was issued for.",
  ERR_SSL_WRONG_VERSION_NUMBER: 'The broker did not answer with TLS. Check the port (brokers usually use 8883 for TLS and 1883 for plain MQTT) and that TLS is enabled on the broker.',
  ECONNREFUSED: 'The broker refused the connection. Check the host and port, and that the broker is running.',
  ENOTFOUND: 'The broker host name could not be found.',
  ETIMEDOUT: 'The broker did not answer in time.',
  EHOSTUNREACH: 'The broker could not be reached.',
};
// When a CA certificate IS configured it is the only thing trusted for the connection, so "add the CA certificate"
// tells the admin to do what they think they already did. Every "not trusted" failure then means the same thing: what
// they pasted is not what signed the broker's certificate (the usual cause is pasting the broker's own certificate
// when an authority signed it). `caAdded` is passed by the connection, which knows whether it gave the TLS layer a CA.
export const MQTT_CA_NOT_ISSUER = "The broker's certificate could not be verified: the certificate you added is not a CA that signed the broker's certificate. Paste the CA (or, for a self-signed broker, the broker's own certificate), or turn off \"Verify the broker's certificate\".";
const NOT_TRUSTED_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT',
]);
export function describeMqttError(err, { caAdded = false } = {}) {
  const code = typeof err?.code === 'string' ? err.code : null;
  const raw = String(err?.message ?? 'Connection error')
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, '[certificate removed]')
    .replace(/\s+/g, ' ')
    .trim();
  // `detail` is the underlying message, cleaned the same way, for the server log (which has always shown it).
  const detail = raw.length > 200 ? `${raw.slice(0, 200)}…` : raw || 'Connection error';
  if (caAdded && NOT_TRUSTED_CODES.has(code)) return { code, message: MQTT_CA_NOT_ISSUER, detail };
  if (code && Object.hasOwn(MQTT_ERRORS, code)) return { code, message: MQTT_ERRORS[code], detail };
  // Node reports a TLS client talking to a plain-text server as EPROTO, with the OpenSSL reason only in the message
  // (measured against a plain socket on Node 24: code 'EPROTO', "...ssl3_get_record:wrong version number"). Matched
  // on that reason, so an EPROTO for any other cause keeps its own words.
  if (code === 'EPROTO' && /wrong version number|packet length too long|record layer failure|http request/i.test(raw)) {
    return { code: 'ERR_SSL_WRONG_VERSION_NUMBER', message: MQTT_ERRORS.ERR_SSL_WRONG_VERSION_NUMBER, detail };
  }
  return { code, message: detail, detail };
}

// Checks the CA text an admin pasted and returns it in a canonical form (certificates only, LF line ends, one per
// block), `null` for blank (= use the system's authorities), or throws an Error whose message is safe to show.
//
// What it refuses and why, since the field takes pasted text and its content ends up in a TLS trust decision:
//   - anything that is not PEM certificates: a stray line, a half-copied block, or two blocks run together would
//     otherwise be silently dropped by the TLS layer, leaving a connection that looks configured and trusts nothing
//     you meant it to;
//   - a PRIVATE KEY block, named as such: pasting the wrong file from a certificate folder is the common mistake, and
//     the key must never be stored or logged. It is refused before it is parsed or kept;
//   - more than 10 certificates or 100 000 characters, which no broker chain needs.
// Each block is parsed with Node's own X.509 parser, so a block that is PEM-shaped but not a certificate is refused.
// ⚠️ No message here repeats any part of the input.
export const MQTT_CA_MAX_CERTS = 10;
export const MQTT_CA_MAX_CHARS = 100_000;
export function parseMqttCa(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new Error('The CA certificate must be text in PEM format.');
  const text = raw.trim();
  if (!text) return null;
  if (text.length > MQTT_CA_MAX_CHARS) throw new Error('The CA certificate text is too long.');
  if (/PRIVATE KEY/i.test(text)) {
    throw new Error('That is a private key, not a certificate. Paste only the CA certificate (it begins with -----BEGIN CERTIFICATE-----) and never share the key.');
  }
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if (blocks.length === 0) throw new Error('No certificate found. Paste the CA certificate in PEM format, starting with -----BEGIN CERTIFICATE-----.');
  if (text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim() !== '') {
    throw new Error('The CA certificate field contains text that is not a certificate. Remove everything except the -----BEGIN CERTIFICATE----- blocks.');
  }
  if (blocks.length > MQTT_CA_MAX_CERTS) throw new Error(`Too many certificates: at most ${MQTT_CA_MAX_CERTS} are accepted.`);
  const canonical = blocks.map((b, i) => {
    try { return new X509Certificate(b).toString().trim(); } catch {
      throw new Error(`Certificate ${i + 1} of ${blocks.length} is not a valid certificate.`);
    }
  });
  return `${canonical.join('\n')}\n`;
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

// Forget a camera's MQTT-motion cooldown stamp (#555 bullet 10): the map is keyed by camera id and nothing removed
// an entry, so a deleted camera left one behind for the life of the process. Called ONLY by the camera DELETE
// route; an edit or a reconnect must keep the cooldown, so nothing else clears it.
export function forgetMqttMotionAlert(cameraId) {
  motionLastAlert.delete(cameraId);
}

// Test-only views of the store (nothing else shows what it holds).
export function _mqttMotionStampForTests(cameraId) {
  return motionLastAlert.get(cameraId);
}
export function _setMqttMotionStampForTests(cameraId, ms) {
  motionLastAlert.set(cameraId, ms);
}

// Called on startup, after a settings save, and after any camera add/edit/delete that
// touches an MQTT topic - cheap to call liberally, since it no-ops if nothing actually
// changed (aside from re-subscribing, which is itself a no-op for already-subscribed
// topics).
// Live connection state for the Settings UI. `connected` reflects the mqtt.js client's own
// flag (true once the broker handshake completes, false while retrying/down).
export function mqttStatus() {
  const cfg = getMqttSettings();
  const enabled = !!(cfg.mqtt_enabled && cfg.mqtt_host);
  const connected = !!(client && client.connected);
  return {
    enabled,
    connected,
    // Additive (#537): whether the connection uses TLS, and why it is not connected when it is not. `error` is null
    // while connected, while disabled, and until the first failure; it is a sentence (describeMqttError), not a
    // stack, and never holds any part of a certificate.
    tls: enabled && !!cfg.mqtt_tls,
    error: enabled && !connected ? lastError?.message ?? null : null,
    error_code: enabled && !connected ? lastError?.code ?? null : null,
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

// What is wrong with a host that is not usable, in words that never repeat it (see mqttBrokerUrl). At most ONE
// character of the input is named: the first one that is not allowed.
function hostProblem(typed) {
  if (!typed) return 'it is blank';
  // The paste this guards against: a whole broker URL, or user:password@host. Said as such, so the admin knows where
  // the parts go, and checked before any single character is named (the ":" of "user:password" would be next).
  if (typed.includes('://') || typed.includes('@')) {
    return 'it looks like a full address; enter only the host name or IP address (the port, user name and password have their own boxes)';
  }
  const bad = [...typed].find((ch) => !/^[\p{L}\p{N}_.-]$/u.test(ch));
  // Every character is a letter, a digit or one of `_.-`: the name has a letter with no host-name (punycode) form.
  if (bad === undefined) return 'it has a letter that cannot be used in a host name';
  if (bad === '[' || bad === ']') return 'an IPv6 address must be the whole host, in [brackets], with only hex digits, ":" and "."';
  if (bad === ' ') return 'it contains a space';
  if (bad === ':') return 'it contains ":" (the port goes in its own box, and an IPv6 address goes in [brackets])';
  const code = `U+${bad.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  // An invisible or control character is named by its code point only: printed, it would show nothing (#641).
  if (/[\p{C}\p{Z}]/u.test(bad)) return `it contains an invisible or control character (${code})`;
  return `it contains "${bad}" (${code})`;
}

export function validateHost(rawHost) {
  // Surrounding spaces are harmless typing noise (the settings route trims them before saving; a value already
  // stored that way is trimmed here too, so boot and save read the same host). Inner whitespace is not.
  const typed = typeof rawHost === 'string' ? rawHost.trim() : '';
  // ⚠️ NO MESSAGE HERE REPEATS THE HOST (#537 review). These messages go back in the 400 from PUT /settings and into
  // the "[mqtt] Not connecting" log line, and the host box is exactly where a pasted `mqtt://user:password@broker`
  // lands: echoing it (as #641 did, to make an invisible character visible) sent the password back and logged it.
  // So the message says what is wrong instead: the first character that is not allowed, named by its code point when
  // it cannot be seen (that keeps the #641 point, an admin can still find a no-break space), and never a run of it.
  const notAHost = () => new Error(`the host is not a valid hostname or address: ${hostProblem(typed)} (use letters, digits, ".", "-" and "_", or an IPv6 address in [brackets]; no spaces or other symbols)`);
  if (!BROKER_HOST_ALPHABET.test(typed)) throw notAHost();
  // Only a name with a non-ASCII letter is converted. An all-ASCII host goes through exactly as typed: domainToASCII
  // would also rewrite numeric forms (`1.2.3` becomes `1.2.0.3`) and refuse a name ending in a number.
  const host = [...typed].every((ch) => ch.charCodeAt(0) < 128) ? typed : domainToASCII(typed);
  if (!host.startsWith('[') && !BROKER_ASCII_HOST.test(host.toLowerCase())) throw notAHost();
  let u;
  try { u = new URL(`mqtt://${host}:1883`); } catch {
    // Reached by a bracketed literal that has the right characters but is not an address (`[1:2]`).
    throw new Error(`the host is not a valid hostname or address: ${host.startsWith('[') ? 'the IPv6 address in [brackets] is not a valid address' : 'it cannot be read as a host name'}`);
  }
  if (!u.hostname || u.username || u.password || u.pathname || u.search || u.hash || u.port !== '1883') {
    throw new Error('the host must be just a hostname or address, with no user name, path or query');
  }
  return host;
}

export function mqttBrokerUrl(rawHost, port, { tls = false } = {}) {
  // The default the settings screen documents for a blank port: 1883, or 8883 with TLS.
  const p = port || (tls ? 8883 : 1883);
  const scheme = tls ? 'mqtts' : 'mqtt';
  if (!Number.isInteger(Number(p)) || Number(p) < 1 || Number(p) > 65535) {
    throw new Error(`the port ${JSON.stringify(p)} is not a whole number between 1 and 65535`);
  }
  const host = validateHost(rawHost);
  return `${scheme}://${host}:${Number(p)}`;
}

export function refreshMqttConnection() {
  const cfg = getMqttSettings();

  // Disabled counts the same as unconfigured: tear down any live connection and,
  // critically, don't leave a client endlessly retrying a broker that's deliberately
  // off. The saved broker config itself is untouched - re-enabling picks it back up.
  if (!cfg.mqtt_host || !cfg.mqtt_enabled) {
    lastError = null;
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
  lastError = null;

  // ⚠️ MUST NOT THROW (#543). This runs at boot before the crash guards are installed, and after every settings
  // save and camera edit. A bad value that is ALREADY stored (saved by an older version, or written by hand) has to
  // leave MQTT off and the app up, not take the process down on every start. The cache key is reset so that the
  // next call, after the admin fixes the value, tries again instead of treating the failed attempt as connected.
  let caAdded = false;
  try {
    const tls = !!cfg.mqtt_tls;
    const options = {
      username: cfg.mqtt_username || undefined,
      password: cfg.mqtt_password || undefined,
      reconnectPeriod: 5000,
    };
    if (tls) {
      // Verification is ON unless the admin switched it off (stored 0). A stored CA replaces the system list for this
      // connection, which is what a private or self-signed broker needs; blank keeps the system's authorities. The CA
      // is re-checked here, not only at save: a value written by hand into the database must not be able to throw
      // from the boot path (#543), and its text is never logged.
      options.rejectUnauthorized = cfg.mqtt_tls_verify !== 0;
      let ca;
      try { ca = parseMqttCa(cfg.mqtt_tls_ca); } catch (e) {
        throw Object.assign(new Error(`the stored CA certificate is not usable (${e.message})`), { isCa: true });
      }
      if (ca) options.ca = ca;
      caAdded = !!options.ca;
      if (!options.rejectUnauthorized) {
        logger.warn('[mqtt] Certificate verification is OFF: the connection is encrypted but the broker is not authenticated.');
      }
    }
    client = mqtt.connect(mqttBrokerUrl(cfg.mqtt_host, cfg.mqtt_port, { tls }), options);
  } catch (e) {
    client = null;
    currentConfigKey = null;
    // Also in the status, not only in the log (#537 review): with no client, mqttStatus() said enabled, not connected
    // and no reason, so the Settings screen showed neither "Connected" nor why it was not. A fixed sentence: no part of
    // the stored value (a certificate, or a host that may hold a pasted password) goes to the screen.
    lastError = e.isCa
      ? { code: 'CA_UNUSABLE', message: 'The stored CA certificate cannot be used; replace or clear it in the CA certificate box and save.' }
      : { code: 'BROKER_UNUSABLE', message: 'The stored broker host or port cannot be used; correct it and save.' };
    logger.error(`[mqtt] Not connecting: ${e.message}. MQTT stays off until the ${e.isCa ? 'CA certificate' : 'broker host and port'} ${e.isCa ? 'is' : 'are'} fixed in Settings.`);
    return;
  }

  client.on('connect', () => {
    lastError = null;
    logger.info('[mqtt] Connected to broker.');
    subscribeAllCameraTopics();
  });

  client.on('reconnect', () => {
    logger.info('[mqtt] Reconnecting to broker...');
  });

  // mqtt.js 5 emits a TLS failure TWICE with the same Error object: once from its TLS stream builder
  // (node_modules/mqtt/build/lib/connect/tls.js, handleTLSerrors) and once from the client's own stream error handler
  // (client.js, streamErrorHandler), so every failed attempt logged two identical lines. The same object is handled once.
  let lastErr = null;
  client.on('error', (err) => {
    if (err === lastErr) return;
    lastErr = err;
    lastError = describeMqttError(err, { caAdded });
    logger.error('[mqtt] Connection error:', lastError.detail);
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
