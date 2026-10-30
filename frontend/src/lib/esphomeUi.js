// Pure helpers for the ESPHome settings page and the Integrations hub row (#506). No React, no network, so every rule
// here can be tested on its own.

// The server's cap on devices (routes/esphome.js: "A maximum of 8 devices is supported."). The server enforces it;
// this only lets the page say so before Add instead of after.
export const MAX_DEVICES = 8;

// A retention that is a whole number of days from 1 to 365 (routes/esphome.js GET/PUT /settings); the server default is 30.
export const RETENTION_MIN_DAYS = 1;
export const RETENTION_MAX_DAYS = 365;
export const RETENTION_DEFAULT_DAYS = 30;
export function validRetention(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) && n >= RETENTION_MIN_DAYS && n <= RETENTION_MAX_DAYS;
}

// The five connection states the server reports (esphomeManager.js, esphomeStatus: `live?.state || 'disabled'`).
// `disconnected` is a live connection that dropped and is being retried; `failed` is a refusal (wrong key, nobody
// there) the server may not retry. An unknown state is shown as plain text rather than hidden, so a state a newer
// server adds is visible instead of silently blank.
const STATE_BADGES = {
  connected: { text: 'Connected', cls: 'status-badge--ok' },
  connecting: { text: 'Connecting', cls: 'status-badge--off' },
  disconnected: { text: 'Disconnected', cls: 'status-badge--bad' },
  failed: { text: 'Failed', cls: 'status-badge--bad' },
  disabled: { text: 'Off', cls: 'status-badge--off' },
};
export function stateBadge(device) {
  if (device?.enabled === false) return STATE_BADGES.disabled;
  const state = device?.status?.state;
  if (!state) return { text: 'Unknown', cls: 'status-badge--off' };
  return STATE_BADGES[state] || { text: String(state), cls: 'status-badge--off' };
}

// What the card says about encryption. `status.encrypted` is only true for a CONNECTED encrypted session: it is false
// while connecting, disconnected, failed and disabled EVEN WITH a key configured (a plan-review finding, verified in
// esphomeManager.js). So "not encrypted: readings can be read on your network" is claimed only for a connected plaintext
// session, and every other state reports what is configured instead of what is not (yet) happening.
export function encryptionNote(device) {
  const status = device?.status;
  if (status?.state === 'connected') {
    return status.encrypted === true
      ? { text: 'Encrypted', warn: false }
      : { text: 'Not encrypted: anyone on your network can read these readings.', warn: true };
  }
  return { text: device?.key_set ? 'Encryption key set' : 'No encryption key', warn: false };
}

// The badge on the Integrations hub row, from the whole device list: nothing to monitor -> Off; every ENABLED device
// connected -> Connected; an enabled device that is not -> Disconnected. A device the admin switched off is not a fault.
export function hubBadge(devices) {
  if (!Array.isArray(devices)) return null;
  const enabled = devices.filter((d) => d.enabled !== false);
  if (enabled.length === 0) return { text: 'Off', cls: 'status-badge--off' };
  return enabled.every((d) => d.status?.state === 'connected')
    ? { text: 'Connected', cls: 'status-badge--ok' }
    : { text: 'Disconnected', cls: 'status-badge--bad' };
}

// "3 min ago" for the last stored reading. `iso` is the server's ISO time.
export function relativeAge(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'less than a minute ago';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

// ---- The CSV download ------------------------------------------------------------------------------------------------

// The server allows at most 31 days per file (routes/esphome.js).
export const EXPORT_MAX_DAYS = 31;

// A size guard, client-side only. The route streams but has no row cap, a device may have up to 200 entities
// (esphomeTransport.js: `discovered.slice(0, 200)`), and this page holds the whole text in memory (and a second copy
// when it is saved), so 200 entities x 31 days would be about 8.9 million rows. The estimate assumes a row per entity
// per minute (a device never writes more) at ~75 bytes a row (a minute_utc timestamp, `#<id>`, a quoted entity name,
// a child id and eight numbers: 60-90 bytes measured on the shape of the file, not on a real export). It is an
// ESTIMATE, not a bound, and it counts the sensors the device has NOW: the export also holds the readings of sensors
// it no longer reports (retired when a firmware change dropped them), which are not counted. The budget is a judgment,
// not a measurement: a phone has to hold the text and its copy for the save. A typical device (7 entities) is about
// 0.75 MB a day, so all 31 days fit. A script calling the API is not bound by any of this.
export const EXPORT_BYTES_PER_ROW = 75;
export const EXPORT_BUDGET_BYTES = 25 * 1024 * 1024;
const MINUTES_PER_DAY = 1440;
export function exportBytesPerDay(entityCount) {
  return Math.max(1, Number(entityCount) || 0) * MINUTES_PER_DAY * EXPORT_BYTES_PER_ROW;
}
export function exportLongestDays(entityCount) {
  return Math.min(EXPORT_MAX_DAYS, Math.floor(EXPORT_BUDGET_BYTES / exportBytesPerDay(entityCount)));
}

const DAY_MS = 86400000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const parseDay = (s) => {
  if (typeof s !== 'string' || !DAY.test(s)) return NaN;
  const t = Date.parse(`${s}T00:00:00Z`);
  // Date.parse rolls 2026-02-31 over to March; refuse it by reading it back.
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? t : NaN;
};
export const dayString = (ms) => new Date(ms).toISOString().slice(0, 10);

// The request for a range of whole UTC days, both included. The server's `to` is EXCLUSIVE, so the day AFTER the last
// one is sent. Dates are UTC days on purpose: the file's own times are UTC, and nothing here may assume the timezone
// of whoever installed this. Returns { ok: true, from, to, days, bytes } or { ok: false, error }.
export function exportRange(fromDay, toDay, entityCount) {
  const from = parseDay(fromDay);
  const to = parseDay(toDay);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, error: 'Choose a start and an end date.' };
  if (to < from) return { ok: false, error: 'The end date is before the start date.' };
  const days = Math.round((to - from) / DAY_MS) + 1;
  if (days > EXPORT_MAX_DAYS) return { ok: false, error: `Choose no more than ${EXPORT_MAX_DAYS} days.` };
  const bytes = exportBytesPerDay(entityCount) * days;
  if (bytes > EXPORT_BUDGET_BYTES) {
    const longest = exportLongestDays(entityCount);
    const n = Math.max(1, Number(entityCount) || 0);
    return { ok: false, error: `This device has ${n} entities, so ${days} days could be too large to open here. Try up to ${longest} day${longest === 1 ? '' : 's'}, or use the API for a longer range.` };
  }
  return { ok: true, from: fromDay, to: dayString(to + DAY_MS), days, bytes };
}
