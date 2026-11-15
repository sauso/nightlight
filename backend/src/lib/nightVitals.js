// HEART RATE AND BREATHING OVER A NIGHT, FOR DISPLAY ONLY (owner request, 2026-11-14: "display heart rate and breathing
// on a card, and on the timeline when you hold and scroll").
//
// ⚠️ READ-ONLY AND OUTSIDE THE SLEEP MATHS. Nothing here is stored, scored, summarised, pushed or fed back into a
// night: routes/children.js attaches the result to an answer AFTER the night, its score and its summary were worked out
// (never inside computeNight), so it can never reach `sleep_nights`, `summary_facts`, a review or the score.
//
// WHAT COUNTS AS A MEASURED MINUTE is deliberately the SAME as the sleep sensor shadow (lib/sleepSensor.js: validHrMinute
// / validRrMinute, one definition of "a measured heart beat", read through the same readDeviceMinutes): a heart-rate row
// with at least VITALS_HR_MIN_N non-zero updates, a breathing-rate row with at least VITALS_RR_MIN_N and not the 1.0
// placeholder, and the 1 m distance cut. So the screen never draws a minute the shadow would call "no vital signs".
// Rows are never read raw here: a 0 is "no value" (docs/esphome.md), never a heart rate of 0.
//
// ⚠️ KNOWN LIMITS (docs/esphome.md, lib/sleepSensor.js):
//   - The thresholds assume the stock firmware, which reports several times a minute. A device configured to report less
//     often (a throttle filter, a 60 s interval) never reaches them and shows nothing: a gap, not a wrong number.
//   - The 1 m distance cut is weak (after real wakes the distance read a flat 57-75 cm over an EMPTY bed), so these
//     figures can include an adult at the bed, a pet, or a second sleeper. Nothing here separates them.
//   - HEART RATE IS UNVALIDATED. The 2026-11-07 staging check found no sleep/wake pattern in it, a maximum that pins at
//     127 (a likely sensor ceiling, not a heart rate) and one sensor that was misplaced. The screen therefore says
//     "sensor estimate, not for medical use", draws no alert, and a gap is shown as a gap. Breathing was not validated
//     against anything either.
//   - Nothing is retained beyond the ESPHome readings' retention setting (Settings, ESPHome; default 30 days): an older
//     night shows nothing, whatever its stored row says. (This file must not name the raw tables: the boundary test
//     esphome-boundaries.test.js lets only lib/sleepSensor.js do that, and this one reads through it.)
import { toSqlUtc } from './sleepAnalysis.js';
import { readDeviceMinutes, readableLimitMin, validHrMinute, validRrMinute } from './sleepSensor.js';
import { logger } from './logger.js';

const MINUTE_MS = 60000;
// The chart's grid: the same 5 minutes as the temperature series (sleepAnalysis.js nightClimate), so the lines share
// an axis and a scrubbed minute finds one point in each.
const BUCKET_MIN = 5;

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
// Whole numbers on the screen: beats per minute and breaths per minute are not worth a decimal, and a decimal would
// claim a precision the sensor does not have.
const whole = (v) => (v == null ? null : Math.round(v));

// avg / min / max of the minute values that fall in [fromMin, toMin), or null when there are none. `rows` are
// { min, hr, rr } with the value for `field` possibly null.
function summarise(rows, field, fromMin, toMin) {
  const values = rows.filter((r) => r.min >= fromMin && r.min < toMin && r[field] != null).map((r) => r[field]);
  if (!values.length) return null;
  return { avg: whole(mean(values)), min: whole(Math.min(...values)), max: whole(Math.max(...values)), minutes: values.length };
}

// The child's heart rate and breathing rate over [startMs, endMs), or null.
//   `startMs` is rounded DOWN and `endMs` UP to whole UTC minutes here (nothing throws: a display must not break a
//   sleep route, and a bad bound is just "nothing to show").
//   `series`: also return the 5-minute chart series.
//   `summaryFromMs` / `summaryToMs`: the summary (avg / min / max) is over the valid minutes in this span (the night's
//   onset to its wake), the series over the range; both default to the range. The span may reach OUTSIDE the range
//   (a child asleep before the window opened, a wake after it closed, a parent's corrected time): the minutes are read
//   over the union of the two, so the summary of one night is the same whichever range a route asks for (the card reads
//   the window, the detail page the display span: before, the same night showed two different averages), while the
//   series is cut to the range so the tracks still line up with the timeline bar.
//   `nowMs`: the clock. A minute not yet readable at it (sleepSensor.js ROW_READABLE_DELAY_MS) is left out.
// null when the child has no heart-rate or breathing-rate entity, or no valid minute in what was read. Otherwise
// { hr: { avg, min, max, minutes } | null, rr: { ... } | null, series? }, where `series` is [{ t, hr, rr }], `t` the
// MEAN TIME of the bucket's valid minutes (whole minute) as a UTC 'YYYY-MM-DD HH:MM:SS' string (the climate series'
// format) and `hr` / `rr` the mean of that bucket's valid minutes (null when it has none; a bucket with neither is
// absent, so the chart breaks the line).
// Why the mean time and not the bucket's start: the screen shows a point's value for any scrubbed time within 5 minutes
// of it, and one valid reading at 12:04 stamped 12:00 was shown at 11:55, nine minutes BEFORE the only measurement,
// across a gap (found in review of the display, #1092). A bucket is still 5 minutes wide, but the point sits where its
// data is.
// Several devices on one child are averaged per minute; a device without a valid row for the role contributes nothing.
export function nightVitals(childId, startMs, endMs, {
  series = false, summaryFromMs = null, summaryToMs = null, nowMs = Date.now(),
} = {}) {
  if (![startMs, endMs, nowMs].every(Number.isFinite)) return null;
  // A summary bound that is given but not a number is "nothing to show", like a bad range; absent = the whole range.
  if ([summaryFromMs, summaryToMs].some((v) => v != null && !Number.isFinite(v))) return null;
  const startMin = Math.floor(startMs / MINUTE_MS);
  const limitMin = readableLimitMin(nowMs);
  const endMin = Math.min(Math.ceil(endMs / MINUTE_MS), limitMin);
  if (!(endMin > startMin)) return null;
  // The summary window is in minutes too: a valid minute m counts when it STARTS inside [summaryFromMs, summaryToMs), so
  // a start that is not on a minute rounds UP (the minute that began before the onset is not asleep time) and so does
  // the end (the minute that begins before the wake, and so counts, ends after it). Absent bounds mean the whole,
  // already rounded, range (not the caller's unrounded milliseconds).
  const fromMin = summaryFromMs == null ? startMin : Math.ceil(summaryFromMs / MINUTE_MS);
  const toMin = summaryToMs == null ? endMin : Math.ceil(summaryToMs / MINUTE_MS);
  // Read the union of the display range and the summary window (the latter still capped by the replay clock).
  const readFromMin = Math.min(startMin, fromMin);
  const readToMin = Math.min(Math.max(Math.ceil(endMs / MINUTE_MS), toMin), limitMin);
  if (!(readToMin > readFromMin)) return null;
  const { perMinute, vitalsSeen } = readDeviceMinutes(childId, readFromMin, readToMin);
  if (!vitalsSeen) return null;

  // One value per minute and role: the mean over the devices with a valid row.
  const minutes = [];
  for (const [min, devices] of perMinute) {
    const hrs = [];
    const rrs = [];
    for (const d of devices.values()) {
      if (validHrMinute(d.hr, d.dist) && Number.isFinite(d.hr.mean)) hrs.push(d.hr.mean);
      if (validRrMinute(d.rr, d.dist) && Number.isFinite(d.rr.mean)) rrs.push(d.rr.mean);
    }
    if (hrs.length || rrs.length) minutes.push({ min, hr: hrs.length ? mean(hrs) : null, rr: rrs.length ? mean(rrs) : null });
  }
  if (!minutes.length) return null;
  minutes.sort((a, b) => a.min - b.min);

  const out = { hr: summarise(minutes, 'hr', fromMin, toMin), rr: summarise(minutes, 'rr', fromMin, toMin) };
  if (series) {
    const buckets = new Map();
    // Only the display range [startMin, endMin): minutes read for the summary alone stay out of the chart.
    for (const m of minutes) {
      if (m.min < startMin || m.min >= endMin) continue;
      const key = Math.floor(m.min / BUCKET_MIN);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = { hrs: [], rrs: [], mins: [] }));
      b.mins.push(m.min);
      if (m.hr != null) b.hrs.push(m.hr);
      if (m.rr != null) b.rrs.push(m.rr);
    }
    // `minutes` is sorted, so the buckets were inserted in order, and the mean time of a bucket stays inside it (so the
    // points stay sorted). An empty bucket never exists: a minute is only kept when it has a value, so "a bucket with
    // neither" cannot occur here, and the chart's gap is simply a missing key.
    out.series = [...buckets.values()].map((b) => ({
      t: toSqlUtc(new Date(Math.round(mean(b.mins)) * MINUTE_MS)),
      hr: b.hrs.length ? whole(mean(b.hrs)) : null,
      rr: b.rrs.length ? whole(mean(b.rrs)) : null,
    }));
  }
  return out;
}

const utcMs = (s) => (typeof s === 'string' && s ? Date.parse(`${s.replace(' ', 'T')}Z`) : NaN);

// At most one log line an hour for a failing display: the cards ask again and again, and the sentence never carries
// the error's own text (it can carry a child's id), the same rule as the score's (sleepScoreAttach.js).
const LOG_EVERY_MS = 60 * 60 * 1000;
let lastLoggedMs = -Infinity;

// The night object the route is about to return, with `vitals` added, or the SAME object when there is nothing to
// add (a night that is not `ok`, a child without a sensor, no valid minute): so a child without a radar gets a
// response byte-identical to before this existed. Never mutates `night`, never throws.
//   `series`: the detail view's chart series as well (the card needs only the summary).
//   `inProgressToo`: the detail view also draws a night still in progress (status other than `ok`); the card shows
//   vitals only for an `ok` night.
//   `display`: use the timeline's display span (display_start / display_end) for the series range, falling back to the
//   window, so the tracks line up with the bar they sit under.
// Ranges (the stored strings are naive UTC 'YYYY-MM-DD HH:MM:SS'): the range runs from the window (or display) start to
// the night's end, which for a night in progress is `as_of`, not the window's end in the future; the summary from the
// onset to the wake (to `as_of` or the window's end while the child has not woken), or from the range's start when the
// night has no onset.
export function withNightVitals(childId, night, { series = false, inProgressToo = false, display = false, nowMs = Date.now() } = {}) {
  try {
    if (!night || typeof night !== 'object') return night;
    if (night.status !== 'ok' && !(inProgressToo && night.in_progress === true)) return night;
    const live = night.in_progress === true;
    const startMs = utcMs((display && night.display_start) || night.window_start);
    const endMs = utcMs((display && night.display_end) || (live ? night.as_of : null) || night.window_end);
    const summaryFromMs = utcMs(night.onset_at);
    const summaryToMs = utcMs(night.wake_at || (live ? night.as_of : null) || night.window_end);
    const vitals = nightVitals(childId, startMs, endMs, {
      series,
      summaryFromMs: Number.isFinite(summaryFromMs) ? summaryFromMs : startMs,
      summaryToMs: Number.isFinite(summaryToMs) ? summaryToMs : endMs,
      nowMs,
    });
    // "Nothing to add" also covers valid minutes that exist only outside onset..wake on a summary-only read: both summaries
    // are then null and `{ hr: null, rr: null }` would be a truthy, useless `vitals` key (and a byte change for a child
    // whose card shows nothing). With a series asked for, a non-empty series is something to draw, so the object stays.
    if (!vitals || (!vitals.hr && !vitals.rr && !(series && vitals.series?.length))) return night;
    return { ...night, vitals };
  } catch {
    const now = Date.now();
    if (now - lastLoggedMs >= LOG_EVERY_MS) {
      lastLoggedMs = now;
      logger.warn('[sleep] heart rate and breathing skipped: reading a night\'s sensor figures failed');
    }
    return night;
  }
}

export function resetNightVitalsLogForTest() {
  lastLoggedMs = -Infinity;
}
