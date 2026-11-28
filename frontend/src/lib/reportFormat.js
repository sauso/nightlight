// The words, numbers and shapes of the weekly and monthly sleep report page (issue #1236). Pure functions, so every rule
// is tested without rendering anything (test/reportFormat.test.js). The page is pages/SleepReport.jsx; the server side is
// backend/src/lib/sleepReport.js, and the shape of its answer is in docs/sleep-tracking.md, "Weekly and monthly reports".
//
// THE RULES THIS FILE KEEPS, each a decision and not an accident:
//   1. A GAP IS NOT A ZERO. A night that did not count has no figures at all (the server sends only its date and why). It
//      is drawn as an empty slot with a reason in words and is never given a height, so nothing here can turn "no data"
//      into a bar of 0, a score of 0 or a time of "0m". `value: null` is the same: it is "not enough nights", never 0.
//   2. A CHANGE IS ARROW + WORDS, never colour alone, and never judged: "up 8 points" does not say whether that is good.
//   3. NO NUMBER FROM THE SERVER'S RULES IS REPEATED HERE (the 3-night minimum, the "steady" floors, the 80% coverage):
//      the page reads `ready`, `direction` and `status_class` as sent, so a retuned server cannot leave this wording
//      stating the old value (the same rule as sleepScoreText.js, rule 3).
//   4. DELTAS ARE ROUNDED FOR DISPLAY ONLY. The server sends them unrounded; the rounding is here, once.
//   5. NOTHING ASSUMES A LOCALE, A ZONE OR A CALENDAR. Dates are calendar strings read on their date parts in UTC and
//      formatted in UTC (a date has no zone: no device or home zone can move it to a neighbouring day); the first day of
//      the week comes from the viewer's own locale (localeWeekStart), never from a country.

import { addDays } from './nightView.js';
import { formatDayKey } from './homeTime.js';
import { bandOfValue, bandWord, clockText, minutesText, scoreLabel } from './sleepScoreText.js';

// ---- the request ----------------------------------------------------------------------------------------------------

// The first day of the week in the viewer's own locale, ISO numbered (1 = Monday ... 7 = Sunday), which is what the server's
// `week_start` takes. Both spellings exist across browsers: `getWeekInfo()` (the current spec, Chromium 130+, Firefox, Safari)
// and the older `weekInfo` property (Chromium before that, Safari 17). A runtime with neither, a language the runtime does
// not know, or an answer outside 1..7 falls back to Monday, the ISO default: a fallback, never an assumption about a country.
// `Intl.Locale` is looked up when called, not when the module loads, so a test can stand in for it.
export function localeWeekStart(language = typeof navigator !== 'undefined' ? navigator.language : undefined) {
  try {
    const locale = new Intl.Locale(language);
    const info = (typeof locale.getWeekInfo === 'function' ? locale.getWeekInfo() : undefined) ?? locale.weekInfo;
    const first = info?.firstDay;
    return Number.isInteger(first) && first >= 1 && first <= 7 ? first : 1;
  } catch {
    return 1;
  }
}

// A real calendar date, not just the shape ('2026-02-31' matches the pattern and is not a day). The server refuses such a date
// with a 400, so the page never sends one: a hand-edited address with a bad date is read as "no date" (today).
export function isCalendarDate(s) {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// What the page address says: `kind` ('week' by default; anything but 'month' is a week) and `date` (null for "today", which the
// SERVER works out in the app's timezone: the page never guesses today from the device or from a settings value that may not
// have loaded yet). `search` is a URLSearchParams.
export function readReportParams(search) {
  const date = search.get('date');
  return { kind: search.get('period') === 'month' ? 'month' : 'week', date: isCalendarDate(date) ? date : null };
}

// The GET path for one report. `week_start` is always sent (it is ignored for a month, and a month and a week then differ by
// `period` alone).
export function reportApiPath(childId, { kind, date, weekStart }) {
  const q = [`period=${kind}`];
  if (date) q.push(`date=${date}`);
  q.push(`week_start=${weekStart}`);
  return `/children/${childId}/sleep/report?${q.join('&')}`;
}

// The page's own query string for a period: the date is left out when it is null so "this week" stays a short, shareable link.
export const reportQuery = (kind, date) => (date ? { period: kind, date } : { period: kind });

// The page of one report, for the links in (ChildDetail, SleepDetail).
export const reportPagePath = (childId) => `/children/${childId}/reports`;

// ---- the period -----------------------------------------------------------------------------------------------------

// A date inside the period before / after the one shown, from the server's own bounds: the day before `from` and the day after
// `to`. Going by the answer's bounds means the page never repeats the server's week and month arithmetic (week_start, month
// lengths, leap years): December to January is `addDays('2026-12-31', 1)`, and nothing else.
export const previousPeriodDate = (period) => addDays(period.from, -1);
export const nextPeriodDate = (period) => addDays(period.to, 1);

// The previous period lies wholly before the child's first saved night: there is nothing to go back to.
export function canGoPrevious(report) {
  const earliest = report?.earliest_night_date;
  return typeof earliest === 'string' && previousPeriodDate(report.period) >= earliest;
}

// `period.complete` is false for the period that is still running (and for one that lies in the future): never a page beyond it.
export const canGoNext = (report) => report?.period?.complete === true;

// "3–9 Nov 2026" (or the locale's own form) for a week, "November 2026" for a month. A range is one Intl call (formatRange), so
// the locale decides the order, the separator and what is shared when the two ends are in one month or one year ("28 Oct – 3 Nov
// 2026", "28 Dec 2026 – 3 Jan 2027"). Runtimes without formatRange get "from to to". Both ends are formatted as plain dates
// (formatDayKey: noon UTC, printed in UTC), so no zone can shift either.
const noonUtc = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
};
const RANGE_DATE = { day: 'numeric', month: 'short', year: 'numeric' };
export function periodTitle(kind, from, to) {
  if (!isCalendarDate(from) || !isCalendarDate(to)) return `${from} to ${to}`;
  if (kind === 'month') return formatDayKey(from, { month: 'long', year: 'numeric' });
  const f = new Intl.DateTimeFormat([], { ...RANGE_DATE, timeZone: 'UTC' });
  return typeof f.formatRange === 'function'
    ? f.formatRange(noonUtc(from), noonUtc(to))
    : `${formatDayKey(from, RANGE_DATE)} to ${formatDayKey(to, RANGE_DATE)}`;
}

export const periodWord = (kind) => (kind === 'month' ? 'month' : 'week');

// ---- the figures ----------------------------------------------------------------------------------------------------

// The tiles, in the order they are drawn. `key` is the server's name in `summary` and `comparison`. `change` says how a
// change in it is worded: see changeText. The score tile exists only when the server sends a `score` figure (the child's Show
// sleep score switch is on): the page asks `summary[key] !== undefined`, so with the switch off there is no score tile and
// the word "score" is on no tile.
export const FIGURE_TILES = Object.freeze([
  { key: 'score', label: 'Sleep score', change: 'points' },
  { key: 'asleep_minutes', label: 'Time asleep', change: 'minutes' },
  { key: 'wake_count', label: 'Wake-ups', change: 'count', unit: 'a night' },
  { key: 'longest_stretch_minutes', label: 'Longest stretch', change: 'minutes' },
  { key: 'settle_minutes', label: 'Settling time', change: 'minutes' },
  // "Fell asleep" and "Got up", the words docs/sleep-tracking.md and the review use: the figure is the clock time of the
  // detected sleep onset and wake, not the time the child was put down, so "bedtime" would name a different figure.
  { key: 'onset_clock', label: 'Fell asleep', change: 'clock' },
  { key: 'wake_clock', label: 'Got up', change: 'clock' },
]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// 2 -> "2", 1.5 -> "1.5", 1.04 -> "1": a count that is a median can be a half, and a delta is rounded to a tenth.
const tenths = (v) => String(Math.round(v * 10) / 10);

// The typical value as printed in a tile, or null when there is none (never "0", never "NaN").
export function typicalText(key, value) {
  if (!isNum(value)) return null;
  switch (key) {
    case 'score': return String(Math.round(value));
    case 'wake_count': return tenths(value);
    case 'onset_clock':
    case 'wake_clock': return clockText(value);
    default: return minutesText(value);
  }
}

// How far the clock times varied, from `spread` (the width of the middle half of the nights, in minutes, sent only beside a
// ready median). Rounded to a whole minute, and to the nearest five from ten up, where a precise number would claim more than an
// interquartile range of a few nights can say. Null for no spread, so a tile without one prints nothing.
export function spreadText(spread) {
  if (!isNum(spread) || spread < 0) return null;
  if (spread < 1) return 'half of nights at almost exactly the same time';
  const n = spread >= 10 ? Math.round(spread / 5) * 5 : Math.round(spread);
  return `half of nights within about ${n} ${n === 1 ? 'minute' : 'minutes'}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// 25 -> "25 minutes", 1 -> "1 minute", 65 -> "1h 5m" (the same form the other sleep screens print; minutesText).
const lengthWords = (minutes) => (minutes < 60 ? plural(minutes, 'minute', 'minutes') : minutesText(minutes));

// One figure's change against the previous period, as { trend, text }. `trend` picks the arrow ('up' | 'down' | 'steady' |
// 'none'); `text` is the words, and the words always carry the meaning ("up 8 points", "15 minutes later", "steady", "not
// enough nights to compare"). The size is the rounded absolute delta; the direction is the server's (`up`/`down`/`steady`):
// the page never decides what counts as a change. A direction this build does not know (a newer server) and a missing
// comparison both read as "not enough nights to compare", never as a guess.
export function changeText(change, comparison) {
  const none = { trend: 'none', text: 'not enough nights to compare' };
  const dir = comparison?.direction;
  if (dir === 'steady') return { trend: 'steady', text: 'steady' };
  if (dir !== 'up' && dir !== 'down') return none;
  if (!isNum(comparison.delta)) return none;
  const size = Math.abs(comparison.delta);
  let words;
  if (change === 'points') {
    const n = Math.round(size);
    words = n > 0 ? `${dir} ${plural(n, 'point', 'points')}` : null;
  } else if (change === 'count') {
    const n = Math.round(size * 10) / 10;
    words = n > 0 ? `${dir} ${n === 1 ? '1 wake-up' : `${tenths(n)} wake-ups`}` : null;
  } else if (change === 'clock') {
    const n = Math.round(size);
    words = n > 0 ? `${lengthWords(n)} ${dir === 'up' ? 'later' : 'earlier'}` : null;
  } else {
    const n = Math.round(size);
    words = n > 0 ? `${dir} ${lengthWords(n)}` : null;
  }
  // A change that rounds to nothing to show is "steady" in the only words that are true, whatever the server's floor is.
  return words ? { trend: dir, text: words } : { trend: 'steady', text: 'steady' };
}

// ---- the nights -----------------------------------------------------------------------------------------------------

const GAP_WORDS = {
  no_data: 'No data',
  low_coverage: 'Not enough of this night was watched',
  empty_bed: 'No one was in the bed',
  in_progress: 'Tonight, still in progress',
};
// A date after the last finished night with nothing saved yet is not "no data": the night has not happened (or not finished).
export const UPCOMING_WORDS = 'Not recorded yet';
// A night with no class this build knows: still a gap (never a bar), in the one phrase that is true of every class.
const GAP_FALLBACK = 'This night did not count';
export const gapWords = (status, { upcoming = false } = {}) => (
  status === 'no_data' && upcoming ? UPCOMING_WORDS : (GAP_WORDS[status] ?? GAP_FALLBACK)
);

// The most a bar of time asleep can show: the tallest night rounded up to the hour, and never under 12 hours, so a week of 9h
// nights is not drawn full height. A scale for the picture only, set by judgement and not measured: no figure is derived from it.
const ASLEEP_CEILING_FLOOR_MINUTES = 720;
// A real score is never drawn shorter than this share of the bar, so a very low night is still a bar and cannot read as a gap.
const MIN_BAR_PCT = 4;

// One calendar date of the period as the chart draws it: { date, kind, pct, band, words, ... }.
//   kind 'bar'  a counted night with the figure the chart measures: `pct` is its height, `band` the score band ('great' | 'good' |
//               'fair' | 'low') in score mode, null in time-asleep mode;
//   kind 'stub' a counted night WITHOUT that figure (no score for it, or no time asleep): it is still a night that counted, so it
//               links to its page, but it has no height to claim, and `words` says what is missing;
//   kind 'gap'  a night that did not count: no height at all, `words` the reason.
// `mode` is 'score' when any counted night has a score and 'asleep' otherwise (a child with the switch off, or with no scores yet),
// so one chart never mixes two units. The score's BAND is worked out from the number (bandOfValue): a report night carries the
// number only, so an early estimate cannot be told apart here and is drawn in its band like any other number (its figure is
// printed in the night's name).
export function chartModel(report) {
  const nights = Array.isArray(report?.nights) ? report.nights : [];
  const finished = isNum(report?.summary?.nights_in_period) ? report.summary.nights_in_period : nights.length;
  const counted = nights.filter((n) => n?.status_class === 'counted');
  const mode = counted.some((n) => isNum(n.score)) ? 'score' : 'asleep';
  const tallest = Math.max(0, ...counted.map((n) => (isNum(n.asleep_minutes) ? n.asleep_minutes : 0)));
  const ceiling = Math.max(ASLEEP_CEILING_FLOOR_MINUTES, Math.ceil(tallest / 60) * 60);
  const slots = nights.map((n, i) => {
    const date = n.date;
    if (n.status_class !== 'counted') {
      return { date, kind: 'gap', status: n.status_class, words: gapWords(n.status_class, { upcoming: i >= finished }) };
    }
    const figures = { score: isNum(n.score) ? n.score : null, asleep: isNum(n.asleep_minutes) ? n.asleep_minutes : null, wakes: isNum(n.wake_count) ? n.wake_count : null };
    if (mode === 'score' && figures.score !== null) {
      const s = Math.max(0, Math.min(100, figures.score));
      return { date, kind: 'bar', pct: Math.max(MIN_BAR_PCT, s), band: bandOfValue(s), figures };
    }
    if (mode === 'asleep' && figures.asleep !== null) {
      return { date, kind: 'bar', pct: Math.max(MIN_BAR_PCT, Math.min(100, (figures.asleep / ceiling) * 100)), band: null, figures };
    }
    return { date, kind: 'stub', band: null, figures, words: mode === 'score' ? 'No score for this night' : 'Time asleep is not known for this night' };
  });
  return { mode, slots };
}

const weekdayOf = (d) => formatDayKey(d, { weekday: 'short' });
const dayOf = (d) => Number(d.slice(8, 10));

// What a slot prints under its bar: for a week the weekday and the day number, for a month only the day number on the first day
// and every fifth after (31 of them would not fit at 11px on a phone); null on the others. The accessible name is separate.
export function slotLabel(kind, date, index) {
  if (kind === 'month') return index % 5 === 0 ? { top: String(dayOf(date)), bottom: null } : null;
  return { top: weekdayOf(date), bottom: String(dayOf(date)) };
}

// A slot's accessible name. It STARTS with what the slot prints ("Mon 3"), like the sleep strip's (WCAG 2.5.3, label in name:
// docs/design-language.md, "Accessibility floor"), then the full date and the night's figures or the reason it has none.
export function slotName(slot) {
  const lead = `${weekdayOf(slot.date)} ${dayOf(slot.date)}, ${formatDayKey(slot.date, { month: 'short', day: 'numeric' })}`;
  if (slot.kind === 'gap') return `${lead}, ${slot.words}`;
  const f = slot.figures;
  const parts = [];
  if (f.score !== null) parts.push(`score ${scoreLabel({ score: f.score, band: slot.band })}`);
  if (f.asleep !== null) parts.push(`asleep ${minutesText(f.asleep)}`);
  if (f.wakes !== null) parts.push(plural(Math.round(f.wakes * 10) / 10, 'wake-up', 'wake-ups'));
  if (slot.kind === 'stub') parts.unshift(slot.words);
  return `${lead}, ${parts.join(', ')}`;
}

// "Not counted: 1 night with no data, 2 nights not watched enough." One line, so a person on a phone, who has no hover, can read
// WHY the dashed slots are empty without opening each. Null when every night counted. Order is fixed (the reasons' order above).
const GAP_SUMMARY = {
  no_data: (n) => `${plural(n, 'night', 'nights')} with no data`,
  low_coverage: (n) => `${plural(n, 'night', 'nights')} not watched enough`,
  empty_bed: (n) => `${plural(n, 'night', 'nights')} with no one in the bed`,
  in_progress: (n) => (n === 1 ? '1 night still in progress' : `${n} nights still in progress`),
};
export function gapSummary(slots) {
  const parts = [];
  for (const status of Object.keys(GAP_SUMMARY)) {
    // A date that has not finished and has nothing saved is not a gap worth listing: the "so far" line already says it.
    const n = slots.filter((s) => s.kind === 'gap' && s.status === status && s.words !== UPCOMING_WORDS).length;
    if (n) parts.push(GAP_SUMMARY[status](n));
  }
  // A class this build does not know is counted without a reason of its own.
  const other = slots.filter((s) => s.kind === 'gap' && !(s.status in GAP_SUMMARY)).length;
  if (other) parts.push(`${plural(other, 'night', 'nights')} that did not count`);
  return parts.length ? `Not counted: ${parts.join(', ')}.` : null;
}

// ---- the drift chart ------------------------------------------------------------------------------------------------

// The vertical range of one drift chart, in minutes after noon (the server's clock scale), and where its labelled lines go.
// The range holds every dot and the whole typical band, 20 minutes of air round them, rounded OUT to a whole step so the
// labels sit on tidy times; never under two hours; at most about four labelled lines whatever the range. Null when there
// is nothing to draw.
export function driftDomain(values, typical) {
  const points = values.filter(isNum);
  if (!points.length) return null;
  const band = typical && isNum(typical.value) && isNum(typical.spread)
    ? [typical.value - typical.spread / 2, typical.value + typical.spread / 2] : [];
  const all = [...points, ...band, ...(typical && isNum(typical.value) ? [typical.value] : [])];
  const lo = Math.floor((Math.min(...all) - 20) / 60) * 60;
  let hi = Math.ceil((Math.max(...all) + 20) / 60) * 60;
  if (hi - lo < 120) hi = lo + 120;
  const step = 60 * Math.max(1, Math.ceil((hi - lo) / 60 / 4));
  hi = lo + Math.ceil((hi - lo) / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi; t += step) ticks.push(t);
  return { lo, hi, ticks };
}

// ---- the answer -----------------------------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Is this answer one the page can draw? Checked at the door, because everything after it (chartModel, the arrows, the titles)
// reads these pieces and a TypeError there would crash the whole page instead of showing the failed state: a proxy's page that
// came back as a 200, or a server answering `nights: [null]`, must read as a failure. What is required is exactly what the page
// reads: the period's bounds as real calendar dates, `nights` as a list of objects each with a real date, and `summary` and
// `comparison` as objects. `notes`, when present, is a list. NOTHING ELSE is checked, so it stays forward compatible: an extra key,
// an extra field on a night and a note code this build does not know are all accepted.
export function isReportShape(r) {
  return isObject(r)
    && isObject(r.period) && isCalendarDate(r.period.from) && isCalendarDate(r.period.to)
    && isObject(r.summary) && isObject(r.comparison)
    && Array.isArray(r.nights) && r.nights.every((n) => isObject(n) && isCalendarDate(n.date))
    && (r.notes === undefined || Array.isArray(r.notes));
}
