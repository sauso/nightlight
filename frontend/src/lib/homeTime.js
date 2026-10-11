// Home-time formatting: every time the UI shows is rendered in the HOME timezone (`settings.timezone`),
// not the viewer's device zone. Owner decision 2026-10-10 on #561 (and #512): an alert at "3:12 AM" must
// mean the same instant on the phone in the hallway and on a grandparent's phone abroad, and must agree
// with the sleep report and the quiet-hours schedule, which were already in home time. When the viewer's
// device is in a DIFFERENT zone the time carries a short zone label ("3:12 AM GMT+11") so nobody reads
// it as their own clock; in a single-zone household nothing changes at all.
//
// Pure functions that take the zone explicitly (testable without React); components get the zone and
// the pre-bound formatters from the `useHomeTime()` hook in ./useHomeTime.js.
//
// Locale and clock format are deliberately NOT chosen here: every formatter passes `[]` (the viewer's own
// locale) and leaves hour12 unset, exactly as the sleep screens always have, so 12/24-hour follows the
// device and nothing is assumed about whoever runs this (CLAUDE.md "Building for someone else's house").

// What the backend defaults `settings.timezone` to (see SettingsContext DEFAULTS). A missing or
// unrecognised zone falls back to it rather than to the device zone: falling back to the device would
// re-create the very device-vs-home disagreement this module exists to remove, and it would do so
// silently, with no label.
export const DEFAULT_HOME_ZONE = 'UTC';

// Option bags that reproduce what `toLocaleString()` / `toLocaleTimeString([], …)` / `toLocaleDateString()`
// printed before, so converting a screen changes the ZONE and nothing else about how it looks.
export const TIME = Object.freeze({ hour: 'numeric', minute: '2-digit' });
export const DATE_TIME = Object.freeze({
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
});
export const DAY = Object.freeze({ year: 'numeric', month: 'numeric', day: 'numeric' });

// IANA name -> canonical name, or null when the runtime does not know it. Cached: it runs on every
// render of every row.
const canonicalCache = new Map();
function canonicalZone(tz) {
  if (typeof tz !== 'string' || !tz) return null;
  if (canonicalCache.has(tz)) return canonicalCache.get(tz);
  let canon = null;
  try {
    canon = new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    // RangeError: not a zone this runtime knows. Falls through to null.
  }
  canonicalCache.set(tz, canon);
  return canon;
}

// A zone safe to hand to Intl: the given one if it is a real IANA name, else the default.
export function resolveZone(tz) {
  return canonicalZone(tz) ? tz : DEFAULT_HOME_ZONE;
}

// The viewer's own zone, or null when the runtime will not say (then we cannot claim it differs).
export function deviceZone() {
  try {
    return canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

// Does the device sit in a different zone from home? Compared by CANONICAL name so an alias of the same
// zone ('Asia/Calcutta' / 'Asia/Kolkata') does not put a label on a household that never leaves home.
// Known limit: two distinct names that happen to share an offset today (Europe/Paris vs Europe/Berlin)
// still count as different, which only ever adds a label, never hides one.
export function zonesDiffer(home, device = deviceZone()) {
  const h = canonicalZone(resolveZone(home));
  const dev = canonicalZone(device);
  return !!dev && !!h && dev !== h;
}

// `d` rendered in `zone` with the given Intl options; `withZone` appends the short zone name in the
// position the viewer's locale puts it. '' for an invalid date (Intl would throw on one).
export function formatInZone(d, zone, opts, withZone = false) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat([], {
    ...opts,
    timeZone: resolveZone(zone),
    ...(withZone ? { timeZoneName: 'short' } : null),
  }).format(d);
}

// The 'YYYY-MM-DD' calendar day `d` falls on IN `zone`. This is what day grouping must key on: the same
// clip is on one home-zone day for every viewer, whereas the device's own day differs between a phone at
// home and one abroad (a 23:30 clip is "tomorrow" for a viewer twelve hours ahead).
// Built from formatToParts, not from the locale's date string, so no locale can reorder it.
export function dayKey(d, zone) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveZone(zone), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const todayKey = (zone, now = new Date()) => dayKey(now, zone);

// A 'YYYY-MM-DD' key as a label. A calendar date has no zone, so it is built at noon UTC and printed in
// UTC: no device or home zone can move it to a neighbouring day or land it in a daylight-saving gap
// (a local midnight that does not exist). An unparseable key is returned as given.
export function formatDayKey(key, opts = DAY) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key));
  if (!m) return String(key);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  if (Number.isNaN(d.getTime())) return String(key);
  return new Intl.DateTimeFormat([], { ...opts, timeZone: 'UTC' }).format(d);
}
