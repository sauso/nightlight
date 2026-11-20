// A Nightlight Camera (the separate nightlight-cam project) answers a small JSON API on port 8080: /api/v1/health
// is open, /api/v1/sensors and /api/v1/capabilities need the camera's own login (HTTP Basic, the SAME user and
// password as its RTSP stream, so nothing new is stored). This file holds the pure parts and the one outbound
// request helper; lib/cameraSensors.js is the poller built on them.
//
// WHAT THIS ASSUMES, AND WHERE IT STOPS
//  - The host is a LITERAL private IPv4 address (not link-local), never a hostname: the request goes to an address
//    from the database or an admin's keyboard, so a name could point it at anything (SSRF, DNS rebinding). A camera
//    added by a hostname is simply not detected; the docs say "add it by IP".
//  - Any device on the camera's network can answer /health, and a malicious one can say anything. So everything read
//    here is shape-checked and range-checked, nothing is echoed back raw, and what a camera says is only ever STORED
//    as a number or a short filtered string.
//  - Plain HTTP: the login crosses the LAN in clear, exactly as the RTSP login already does (documented).
//  - Only an `ok` reading is kept. `uncertain` readings are NOT stored or shown (conservative: the camera itself says
//    it doubts them), and a null `value` is never read as zero.
import { isPrivateLanIPv4 } from './privateAddress.js';
import { decodeUrlCredential } from './urlCredentials.js';

export const NLCAM_MODEL = 'nightlight-camera';
export const NLCAM_SOURCE = 'nightlight-api';
export const NLCAM_PORT = 8080;
const HEALTH_MAX_BYTES = 4 * 1024;
const JSON_MAX_BYTES = 32 * 1024;

export const GROUPS = ['climate', 'radar', 'light', 'pad'];

// Which switch (group) owns which stored quantity.
export const METRIC_GROUP = {
  temperature: 'climate', humidity: 'climate',
  presence: 'radar', heart_rate: 'radar', breathing_rate: 'radar', distance_cm: 'radar',
  light_lux: 'light',
  pad_occupied: 'pad', pad_level: 'pad', pad_weight_kg: 'pad',
};

// A value outside these is not a plausible reading of the thing it names (a sensor fault, or a lying device): dropped
// like a reading that is not `ok`. Chosen for a nursery, not measured: the widest the hardware can honestly report.
// Heart and breathing rate start at 1 because the camera itself treats 0 as "no measurement".
const RANGES = {
  temperature: [-40, 85], humidity: [0, 100], heart_rate: [1, 250], breathing_rate: [1, 80],
  distance_cm: [0, 2000], light_lux: [0, 200000], pad_level: [0, 1e6], pad_weight_kg: [0, 200],
};

// A text field from the camera: short, plain characters only (the same filter Find cameras uses for mDNS text).
const cleanText = (value) => typeof value === 'string' && /^[A-Za-z0-9 ._+-]{1,40}$/.test(value) ? value : undefined;

// The only addresses this feature will ever contact. isPrivateLanIPv4 also accepts 169.254/16 (link-local, where
// some clouds put a metadata service): excluded here, a camera does not live there (review of the plan, 2026-11-20).
export function isNightlightHost(ip) {
  return typeof ip === 'string' && isPrivateLanIPv4(ip) && !ip.startsWith('169.254.');
}

// The camera's address as saved: the host of its stream URL.
export function cameraHost(cam) {
  try { return new URL(cam?.rtsp_url).hostname; } catch { return ''; }
}

// The login the camera API accepts. The STREAM login in rtsp_url is the one an ordinary edit keeps current; the
// separate onvif_* pair is only refreshed when an admin re-runs the ONVIF fetch, so it is the fallback, not the
// first choice (plan review, 2026-11-20: preferring it left a poll stopped after an ordinary password change).
export function cameraLogin(cam) {
  try {
    const u = new URL(cam?.rtsp_url);
    if (u.username) return { username: decodeUrlCredential(u.username), password: decodeUrlCredential(u.password || '') };
  } catch { /* fall through to the ONVIF pair */ }
  if (cam?.onvif_username) return { username: cam.onvif_username, password: cam.onvif_password || '' };
  return null;
}

// Per-group switches, stored as JSON text. Anything unparseable or missing means "all on" (the default offered when a
// Nightlight Camera is added); a key that is not a boolean is ignored.
export function parseGroups(text) {
  const groups = Object.fromEntries(GROUPS.map((g) => [g, true]));
  if (typeof text !== 'string' || !text) return groups;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') for (const g of GROUPS) if (typeof parsed[g] === 'boolean') groups[g] = parsed[g];
  } catch { /* keep the defaults */ }
  return groups;
}

// True when this camera's temperature and humidity come from its API (its climate switch is on): the MQTT sampler
// then skips it entirely, so a camera never has two sources for one night (plan review, 2026-11-20).
export function usesApiClimate(cam) {
  return cam?.sensor_source === NLCAM_SOURCE && parseGroups(cam.sensor_groups).climate;
}

// One GET to the camera, JSON only. Never throws, never returns a body it did not validate as JSON, and carries no
// text from the response or the error back to the caller: only a short reason. Rules copied from snapshot.js
// fetchHttpSnapshot: a timeout, redirects refused (a 3xx is a failure), a declared length over the cap refused, and
// the streamed body counted against the cap (a declared length can be absent or a lie).
export async function fetchLanJson(ip, path, { port = NLCAM_PORT, login = null, timeoutMs = 3000, maxBytes = JSON_MAX_BYTES, signal } = {}) {
  if (!isNightlightHost(ip) || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'host' };
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (login) headers.Authorization = `Basic ${Buffer.from(`${login.username}:${login.password}`).toString('base64')}`;
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, { headers, signal: ctrl.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) return { ok: false, reason: 'redirect', status: res.status };
    if (!res.ok) return { ok: false, reason: 'status', status: res.status };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_big', status: res.status };
    if (!/json/i.test(res.headers.get('content-type') || '') || !res.body) return { ok: false, reason: 'not_json', status: res.status };
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) return { ok: false, reason: 'too_big', status: res.status };
      chunks.push(chunk);
    }
    let json;
    try { json = JSON.parse(Buffer.concat(chunks, total).toString('utf8')); } catch { return { ok: false, reason: 'not_json', status: res.status }; }
    return { ok: true, status: res.status, json };
  } catch {
    return { ok: false, reason: signal?.aborted ? 'aborted' : ctrl.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Every exit path leaves no connection behind (an unread body, a stalled stream).
    ctrl.abort();
  }
}

// Is this host a Nightlight Camera? Null for anything else, for any failure, silently: most cameras have nothing on
// 8080. `simulated` is true unless the camera says an explicit false (a missing or odd value fails toward "simulated",
// which keeps the reading out of every sleep figure).
export async function readHealth(ip, { port = NLCAM_PORT, signal } = {}) {
  const r = await fetchLanJson(ip, '/api/v1/health', { port, timeoutMs: 3000, maxBytes: HEALTH_MAX_BYTES, signal });
  if (!r.ok) return null;
  const j = r.json;
  if (!j || typeof j !== 'object' || j.model !== NLCAM_MODEL) return null;
  const device_id = cleanText(j.device_id);
  if (!device_id) return null;
  return { device_id, firmware: cleanText(j.firmware) || null, simulated: j.simulated !== false, api_port: port };
}

// What the camera says it has fitted. The shape is read leniently (the camera's reference lists `sensors.radar`,
// `sensors.environment`, `sensors.pressure`); a part is "fitted" unless it is false, null, "none" or {kind:"none"}.
// Null when the answer is unusable: the screen then shows every switch.
export async function readCapabilities(ip, login, { port = NLCAM_PORT, signal } = {}) {
  const r = await fetchLanJson(ip, '/api/v1/capabilities', { port, login, timeoutMs: 3000, signal });
  if (!r.ok || !r.json || typeof r.json !== 'object' || !r.json.sensors || typeof r.json.sensors !== 'object') return null;
  const fitted = (v) => v != null && v !== false && v !== 'none' && !(typeof v === 'object' && (v.kind === 'none' || v.fitted === false));
  const s = r.json.sensors;
  return { radar: fitted(s.radar), environment: fitted(s.environment), pressure: fitted(s.pressure) };
}

function okNumber(reading, metric) {
  if (!reading || typeof reading !== 'object' || reading.state !== 'ok') return null;
  const v = reading.value;
  const [lo, hi] = RANGES[metric];
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
}
function okBool(reading) {
  if (!reading || typeof reading !== 'object' || reading.state !== 'ok' || typeof reading.value !== 'boolean') return null;
  return reading.value ? 1 : 0;
}

// The /sensors answer to the quantities Nightlight stores: every one null unless the camera marked it `ok` and the
// number is plausible. `simulated` is true unless the answer carries a real boolean false.
export function parseSensors(json) {
  const j = json && typeof json === 'object' ? json : {};
  const radar = j.radar && typeof j.radar === 'object' ? j.radar : {};
  const env = j.environment && typeof j.environment === 'object' ? j.environment : {};
  const pad = j.pressure && typeof j.pressure === 'object' ? j.pressure : {};
  return {
    simulated: j.simulated !== false,
    metrics: {
      temperature: okNumber(env.temperature_c, 'temperature'),
      humidity: okNumber(env.humidity_pct, 'humidity'),
      presence: okBool(radar.presence),
      heart_rate: okNumber(radar.heart_rate_bpm, 'heart_rate'),
      breathing_rate: okNumber(radar.breathing_rate_bpm, 'breathing_rate'),
      distance_cm: okNumber(radar.distance_cm, 'distance_cm'),
      light_lux: okNumber(j.ambient_light_lux, 'light_lux'),
      pad_occupied: okBool(pad.occupied),
      pad_level: okNumber(pad.level, 'pad_level'),
      pad_weight_kg: okNumber(pad.weight_kg, 'pad_weight_kg'),
    },
  };
}
