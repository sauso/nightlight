import { useContext, useMemo } from 'react';
import { SettingsContext } from './SettingsContext.jsx';
import {
  resolveZone, zonesDiffer, formatInZone, dayKey, todayKey, formatDayKey, TIME, DATE_TIME, DAY,
} from './homeTime.js';

// The home zone plus formatters already bound to it, for components. `differs` is true when the viewer's
// device sits in another zone; the time-of-day formatters then append the short zone name (see
// homeTime.js). Date-only formatters never carry one: a day heading has no clock to misread.
//
// Reads SettingsContext directly rather than through useSettings(), which destructures a null context
// and throws: a few screens render outside a provider in tests, and the right answer there is the
// default zone, not a crash. Until the first /settings reply arrives `settings.timezone` is the
// placeholder 'UTC' (SettingsContext DEFAULTS); these formatters re-render with the real one when it
// lands, which is a display flicker only. A screen that must not ACT on the placeholder gates on
// `loaded` itself (NightReview does).
export function useHomeTime() {
  const zone = resolveZone(useContext(SettingsContext)?.settings?.timezone);
  const differs = zonesDiffer(zone);
  return useMemo(() => ({
    zone,
    differs,
    // 3:12 AM            (+ " GMT+11" when the device is elsewhere)
    time: (d, opts = TIME) => formatInZone(d, zone, opts, differs),
    // 1/5/2026, 3:12:00 AM  — the title/tooltip form, same shape as toLocaleString()
    dateTime: (d, opts = DATE_TIME) => formatInZone(d, zone, opts, differs),
    // 1/5/2026 — the home-zone calendar day of an instant
    day: (d, opts = DAY) => formatInZone(d, zone, opts, false),
    dayKey: (d) => dayKey(d, zone),
    todayKey: () => todayKey(zone),
    dayLabel: (key, opts) => formatDayKey(key, opts),
  }), [zone, differs]);
}
