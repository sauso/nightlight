// ★ THE WEEKLY AND MONTHLY SLEEP REPORT (issue #1236): how one child slept over a calendar week or month, beside the
// period just before it. Read by GET /api/children/:id/sleep/report (routes/children.js); the user-facing description
// is docs/sleep-tracking.md, "Weekly and monthly reports". Keep the two in step.
//
// A PURE READ. Nothing is stored, no setting is added, and no existing answer changes: the report is worked out on read
// from `sleep_nights` (never pruned, so an old month reads as well as this one), the way the score is.
//
// REUSED, NOT REDEFINED. Every rule a report needs already exists, and a second copy of any of them would let the report
// and the night card disagree about the same night:
//   - the night as the family sees it: applyCorrections (sleepReviews.js) over the stored rows, so a parent's corrected
//     times, "no one was in the bed" and a night promoted from empty read here exactly as on the card. A report built
//     from the raw rows would summarise the detector's answer, not the corrected one;
//   - which figures of a night may be used: toScoringInput (sleepScore.js), the one function the score and the
//     baseline both build every night through;
//   - which nights count: nightQualifies (sleepBaseline.js), the per-night half of the baseline's rule (`ok`, over, not
//     promoted from empty, watched for at least 80% of its window). The baseline's same-camera-same-window clause is
//     NOT applied: a report spans such changes on purpose and says so in `notes` instead (see NOTES below);
//   - the score: attachScore (sleepScoreAttach.js), the glue every sleep route uses, so a night's score here is the one
//     its detail page shows;
//   - medians: `median` (sleepBaseline.js). Medians, not means, for the baseline's reason: one unusual night must not
//     move what a typical night of the period was.
//
// ONE CLOCK. `nowMs` is read once per report and handed to every toScoringInput and attachScore, as the /sleep list
// does, so two nights of one report are never judged at two different moments. The period's `complete` flag comes
// from lastCompletedNightDate (sleepAnalysis.js), which reads the wall clock itself; the route calls both in one
// synchronous handler, so they are the same moment to within a millisecond.
//
// DATES are calendar strings moved on their date parts in UTC (shiftDate), never by 86 400 000 ms and never by parsing
// 'YYYY-MM-DD' as a local time: a day is not 24 hours on the two nights a year the clocks change, and that arithmetic
// once skipped and repeated dates in Melbourne (localDateStr in sleepAnalysis.js). A night belongs to the LOCAL date it
// started on (`sleep_nights.night_date`), so a period is named by its night dates: the week of Monday the 2nd to Sunday
// the 8th holds the night that began on Sunday the 8th and ended on the Monday morning after.
//
// ⚠️ KNOWN LIMITS, all stated in the docs:
//   - the "steady" floors are judgement, not measurement (REPORT_CONFIG.steady);
//   - a camera or sleep-window change inside the two periods can move a comparison by itself: a different camera sees
//     a different amount of movement, and a different window measures a different night. It is the baseline's known
//     limit too. The report flags it (`notes: ['context_changed']`) and does not try to correct for it;
//   - moving or re-aiming the SAME camera keeps its id, so it is not flagged: a month that straddles such a move mixes
//     two views of the bed in one median (in the data the score was tuned on, a move multiplied the counted wakes and
//     cut the measured sleep by about a third for the same children; sleepBaseline.js).

import db from '../db.js';
import { applyCorrections } from './sleepReviews.js';
import { toScoringInput } from './sleepScore.js';
import { attachScore } from './sleepScoreAttach.js';
import { median, nightQualifies, shiftDate } from './sleepBaseline.js';
import { lastCompletedNightDate, localDateStr } from './sleepAnalysis.js';

// ONE object holds the report's numbers, so a change to any of them is one reviewed diff.
export const REPORT_CONFIG = Object.freeze({
  // A figure is given only with at least this many usable values of it in the period; with fewer it is
  // `{ value: null, ready: false }`. A median of one or two nights is not a trend: one bad night would be "the week".
  // Three is the smallest count whose median has a night on either side of it. Chosen by judgement, NOT fitted to any
  // night or camera. Deliberately lower than the baseline's 7 (SCORE_CONFIG.baseline.min_values), which answers a
  // different question ("what is usual for scoring one night"): a week with one missed night could never reach 7.
  min_values: 3,
  // "Steady": a change between the two periods' medians smaller than this, in the figure's own unit, is reported as
  // `steady` rather than up or down. A change AT the floor is a change.
  // ⚠️ EVERY FLOOR IS CHOSEN BY JUDGEMENT, NOT FITTED TO ANY NIGHT OR CAMERA; a different house may want other
  // numbers; see docs/sleep-tracking.md ("Weekly and monthly reports"), where they are listed as a known limit.
  steady: Object.freeze({
    score: 5, // points out of 100: a third of the narrowest band (Good is 70 to 84)
    asleep_minutes: 15, // a quarter of an hour of sleep a night
    // Half a wake. A median of whole counts moves in halves, so this reports any change of the typical count. Wake
    // counts are the figure that depends most on the camera's angle (sleepScore.js), which the docs say.
    wake_count: 0.5,
    longest_stretch_minutes: 15,
    settle_minutes: 5, // settling is short: 5 minutes is a quarter of the score's "ordinary" 20
    onset_clock: 15, // the score's consistency curve already treats 15 minutes either way as on time
    wake_clock: 15,
  }),
});

// Report figure -> the toScoringInput metric it is the median of. Time asleep reads `usual_asleep`, the baseline's own
// choice: it leaves out a night with no confirmed wake (a child still asleep when the window closed, or an empty bed
// counted as sleep) and one with more than 15 unwatched minutes (sleep under-counted), so unwatched time is handled
// exactly as it is for "usual". Clock figures are local minutes since noon in EACH night's own stored timezone
// (clockMinutesSinceNoon inside toScoringInput), so a timezone change mid-period compares 19:30 with 19:30.
const FIGURES = Object.freeze({
  asleep_minutes: 'usual_asleep',
  wake_count: 'wake_count',
  longest_stretch_minutes: 'longest_stretch',
  settle_minutes: 'settle_minutes',
  onset_clock: 'onset_clock',
  wake_clock: 'wake_clock',
});
const CLOCK_FIGURES = new Set(['onset_clock', 'wake_clock']);
// What each NIGHT carries for the per-night chart: the same metrics as the summary, so every number on a night is one of
// the values its period's median was taken over, and a figure the summary refuses is absent on the night too (a counted
// night can therefore lack one). Settling is in the summary only.
const NIGHT_FIGURES = ['asleep_minutes', 'wake_count', 'longest_stretch_minutes', 'onset_clock', 'wake_clock'];

// ---- dates ----------------------------------------------------------------------------------------------------------

const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;

// The years a report may be asked for. Nightlight did not exist before 2000, so no saved night can predate it, and
// the top end keeps every period and its neighbours inside four-digit years: toISOString writes a year past 9999 as
// '+010000-...', so '9999-12-31' gave a week running into an invalid date string (Codex review of PR #1239). 2100 is
// a generous bound, not a measured one; widening it is one line, as long as a week after it still ends before 10000.
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

// A real calendar date in MIN_YEAR..MAX_YEAR, not just the shape: '2026-02-31' matches the pattern and is not a day
// (Date.UTC would quietly roll it over to 3 March).
export function isCalendarDate(s) {
  const m = typeof s === 'string' ? DATE_PARTS.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < MIN_YEAR || y > MAX_YEAR) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// ISO weekday of a calendar date: 1 = Monday ... 7 = Sunday. Read in UTC, where the date IS the day: no zone applies.
function isoWeekday(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

// The period of `kind` that holds the night date `date`: { kind, from, to }, both ends inclusive.
//   month: the 1st to the last day of that month;
//   week:  7 days starting on the most recent `weekStart` weekday (ISO, 1 = Monday) at or before `date`. The browser
//          sends its locale's first day of the week; nothing here assumes Monday, or any one country's calendar.
export function periodBounds(kind, date, weekStart = 1) {
  if (kind === 'month') {
    const [y, m] = date.split('-').map(Number);
    // Day 0 of the next month is the last day of this one: 28, 29, 30 or 31, leap years included, with no table.
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { kind, from: `${date.slice(0, 7)}-01`, to: last };
  }
  const from = shiftDate(date, -((isoWeekday(date) - weekStart + 7) % 7));
  return { kind, from, to: shiftDate(from, 6) };
}

// Every calendar date from `from` to `to`, inclusive. 'YYYY-MM-DD' strings compare as dates.
function datesOf(from, to) {
  const out = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) out.push(d);
  return out;
}

// The query as the route received it -> { kind, date, weekStart } or { error } (a plain sentence for a 400). Every
// value is checked as a string: Express hands a repeated parameter over as an array, which must be a 400, not a crash.
// `date` absent means today (buildSleepReport works it out); `week_start` absent means Monday (1).
export function parseReportQuery({ period, date, week_start: weekStart } = {}) {
  if (period !== 'week' && period !== 'month') return { error: 'period must be week or month' };
  if (date !== undefined && !isCalendarDate(date)) return { error: `date must be a real calendar date from ${MIN_YEAR} to ${MAX_YEAR}, as YYYY-MM-DD` };
  if (weekStart !== undefined && !(typeof weekStart === 'string' && /^[1-7]$/.test(weekStart))) {
    return { error: 'week_start must be a whole number from 1 (Monday) to 7 (Sunday)' };
  }
  return { kind: period, date: date ?? null, weekStart: weekStart === undefined ? 1 : Number(weekStart) };
}

// ---- figures --------------------------------------------------------------------------------------------------------

const figureOf = (values) => {
  const n = values.length;
  const ready = n >= REPORT_CONFIG.min_values;
  return { value: ready ? median(values) : null, n, ready };
};

// How spread out the nights' clock times were: the interquartile range in minutes (the middle half of the nights lie
// within it). Linear interpolation between the sorted values, the common "inclusive" method. Given only beside a
// `ready` median: with fewer nights there is no middle half to speak of.
function interquartileRange(values) {
  const s = [...values].sort((a, b) => a - b);
  const at = (p) => {
    const pos = (s.length - 1) * p;
    const lo = Math.floor(pos);
    return s[lo] + (s[Math.ceil(pos)] - s[lo]) * (pos - lo);
  };
  return at(0.75) - at(0.25);
}

// The best (or worst) of `ranked` by `key`, or null with fewer than `min_values` to choose from: the best of two nights
// is not a best night, for the same reason a median of two is not a trend. `ranked` is ascending by date and the
// comparison is strict, so on a tie the EARLIER night is kept.
function extreme(ranked, key, beats) {
  if (ranked.length < REPORT_CONFIG.min_values) return null;
  let pick = ranked[0];
  for (const r of ranked) if (beats(r[key], pick[key])) pick = r;
  return pick;
}

// The summary of one period. `counted`: the period's COUNTED nights, ascending by date, each { date, input, score }
// (`input` a toScoringInput result with corrections laid over, `score` the night's number or null when it has none).
// `showScore`: the child's Show sleep score switch; off, there is no `score` key at all, and best and worst are judged
// by time asleep. `nightsInPeriod`: the period's dates up to and including the last finished night.
export function summariseNights(counted, { showScore, nightsInPeriod }) {
  const summary = { nights_counted: counted.length, nights_in_period: nightsInPeriod };
  const scored = counted.filter((n) => Number.isFinite(n.score));
  if (showScore) summary.score = figureOf(scored.map((n) => n.score));
  for (const [key, metric] of Object.entries(FIGURES)) {
    const values = counted.filter((n) => n.input.metrics[metric].usable).map((n) => n.input.metrics[metric].value);
    const figure = figureOf(values);
    summary[key] = CLOCK_FIGURES.has(key) ? { ...figure, spread: figure.ready ? interquartileRange(values) : null } : figure;
  }
  const ranked = showScore
    ? scored.map((n) => ({ date: n.date, score: n.score }))
    : counted.filter((n) => n.input.metrics.usual_asleep.usable)
      .map((n) => ({ date: n.date, asleep_minutes: n.input.metrics.usual_asleep.value }));
  const by = showScore ? 'score' : 'asleep_minutes';
  summary.best_night = extreme(ranked, by, (a, b) => a > b);
  summary.worst_night = extreme(ranked, by, (a, b) => a < b);
  return summary;
}

// One figure of this period against the same figure of the previous one: { direction, delta }, `delta` being current
// minus previous, unrounded (the page rounds). `not_enough` unless BOTH figures are `ready`: a change is never claimed
// from a period too thin to have a typical value.
//
// An incomplete current period ("so far") IS compared once its figure is ready, and the answer says `complete: false`
// so the page can label it. The rule "never compare an incomplete period with fewer than 3 counted nights" holds by
// construction: a figure needs `min_values` (3) usable values, so it needs at least 3 counted nights. It has no branch
// of its own (it could not be told apart from this one); a test pins it.
export function compare(current, previous, floor, { clock = false } = {}) {
  if (!current?.ready || !previous?.ready) return { direction: 'not_enough', delta: null };
  let delta = current.value - previous.value;
  // Clock figures sit on a line that wraps at noon (clockMinutesSinceNoon): measured the shorter way round, as the
  // score's consistency term does, so 11:50 then 12:10 is 20 minutes later, not 1420 earlier. The medians themselves
  // are not circular (the score's known limit): for a window ending near noon they can still read wrong.
  if (clock) delta = ((((delta + 720) % 1440) + 1440) % 1440) - 720;
  if (Math.abs(delta) < floor) return { direction: 'steady', delta };
  return { direction: delta > 0 ? 'up' : 'down', delta };
}

// Why a night is, or is not, counted. The first test IS the counting rule (nightQualifies); the rest only name the
// clause that failed, so the page can show the gap with a reason. Never a figure: a gap is not a zero.
function statusClassOf(input) {
  if (nightQualifies(input)) return 'counted';
  if (input.in_progress) return 'in_progress';
  if (input.status === 'empty') return 'empty_bed'; // the detector saw an empty bed, or a parent said no one was in it
  // A night promoted from empty (the camera saw an empty bed and a parent typed two times) reads as no data, not as an
  // empty bed: the parent said someone slept, but nothing about that night was measured (its wake count and longest
  // stretch were typed into existence; sleepScore.js). `no_sleep`, `no_data` and `off` nights are no data too.
  if (input.status !== 'ok' || input.promoted_from_empty) return 'no_data';
  return 'low_coverage'; // ok, finished, measured, and watched for less than 80% of its window (or an unknown share)
}

// NOTES: what the comparison cannot see. `context_changed`: the counted nights of the two periods together were scored
// from more than one (camera, sleep window), read from each row's stored `scoring_context`. A row from before that
// column (NULL) counts as one more context, "unknown": not a change by itself (two NULL nights are one context), but
// unknown beside a known one is one, because nothing says they match. The timezone is left out, as the baseline's
// sameContext leaves it out: clock times are read in each night's own zone already.
const contextKey = (ctx) => (ctx ? JSON.stringify([ctx.camera_id, ctx.window.start, ctx.window.end]) : 'unknown');

// One night of the current period as the page draws it. A gap carries its class and nothing else.
function nightEntry(date, e, showScore) {
  if (!e) return { date, status_class: 'no_data' }; // no row at all for that date
  if (e.status_class !== 'counted') return { date, status_class: e.status_class };
  const out = { date, status_class: 'counted' };
  if (showScore && e.score != null) out.score = e.score; // != null, not truthiness: a score of 0 is a score
  for (const key of NIGHT_FIGURES) {
    const m = e.input.metrics[FIGURES[key]];
    if (m.usable) out[key] = m.value;
  }
  // The corrected UTC times, for the page to print in the home timezone. A wake the detector doubted (or none at all)
  // is where watching stopped, not a time up, so it is left out as wake_clock leaves it out.
  if (e.row.onset_at) out.onset_at = e.row.onset_at;
  if (e.row.wake_at && e.input.wake_confirmed) out.wake_at = e.row.wake_at;
  return out;
}

const rangeStmt = db.prepare(
  'SELECT * FROM sleep_nights WHERE child_id = ? AND night_date BETWEEN ? AND ? ORDER BY night_date'
);
const earliestStmt = db.prepare('SELECT MIN(night_date) AS night_date FROM sleep_nights WHERE child_id = ?');
// Read here, like attachScore reads it, so no caller can forget the switch.
const switchStmt = db.prepare('SELECT show_sleep_score FROM children WHERE id = ?');
const timezoneStmt = db.prepare("SELECT timezone FROM settings WHERE id = 'app'");

// `child`: { id, birthday } (the birthday is attachScore's, for an early-estimate score).
// `kind`: 'week' | 'month'. `date`: any night date inside the wanted period, or null for today's local date in the app
// timezone (settings.timezone, read with the DST-safe localDateStr). `weekStart`: ISO 1 (Monday) to 7 (Sunday).
// The inputs are trusted: the route checks them with parseReportQuery first.
export function buildSleepReport(child, { kind, date = null, weekStart = 1, nowMs = Date.now() } = {}) {
  const day = date ?? localDateStr(timezoneStmt.get()?.timezone || 'UTC');
  const current = periodBounds(kind, day, weekStart);
  const prev = periodBounds(kind, shiftDate(current.from, -1), weekStart); // the same kind, ending the day before
  const lastComplete = lastCompletedNightDate(child.id);
  const switchRow = switchStmt.get(child.id);
  // Only an explicit 0 hides the score, attachScore's own rule. Hidden, attachScore is not even called, so no score
  // can reach the answer by any path.
  const showScore = !(switchRow && switchRow.show_sleep_score === 0);

  // ONE read for both periods, then the corrections, then one normalised input per night.
  const byDate = new Map();
  for (const row of applyCorrections(child.id, rangeStmt.all(child.id, prev.from, current.to))) {
    const input = toScoringInput(row, { nowMs });
    const entry = { date: row.night_date, row, input, status_class: statusClassOf(input), score: null };
    if (entry.status_class === 'counted' && showScore) {
      const s = attachScore(child, row, { nowMs }).score;
      entry.score = s && Number.isFinite(s.score) ? s.score : null; // a night with no score has none here either
    }
    byDate.set(row.night_date, entry);
  }

  const periodOf = (p) => {
    const dates = datesOf(p.from, p.to);
    const counted = dates.map((d) => byDate.get(d)).filter((e) => e?.status_class === 'counted');
    // Dates up to and including the last finished night: all of them once the period is over, fewer "so far". A date
    // whose saved night COUNTS is finished too, whatever today's window says: it counted because its OWN saved window
    // has ended (toScoringInput's in_progress), while lastCompletedNightDate reads TODAY's window. The two disagree
    // after a window end is moved later (the case sleepAnalysis.js documents for computeNightForDisplay, rule 5: saved
    // under a 07:00 end, the end becomes 09:00, the report opened at 08:00), and without this the answer said
    // "7 of 6 nights" (Codex review of PR #1239). nights_in_period can therefore never be below nights_counted.
    const nightsInPeriod = dates.filter((d) => d <= lastComplete || byDate.get(d)?.status_class === 'counted').length;
    return { dates, counted, summary: summariseNights(counted, { showScore, nightsInPeriod }) };
  };
  const cur = periodOf(current);
  const earliest = earliestStmt.get(child.id)?.night_date ?? null;
  // No previous period when it lies wholly before the child's first saved night: there is nothing to compare with,
  // which is not the same as a period of gaps.
  const before = earliest == null || prev.to < earliest ? null : periodOf(prev);

  const comparison = {};
  if (showScore) comparison.score = compare(cur.summary.score, before?.summary.score, REPORT_CONFIG.steady.score);
  for (const key of Object.keys(FIGURES)) {
    comparison[key] = compare(cur.summary[key], before?.summary[key], REPORT_CONFIG.steady[key], { clock: CLOCK_FIGURES.has(key) });
  }

  const contexts = new Set([...cur.counted, ...(before ? before.counted : [])].map((e) => contextKey(e.input.context)));

  return {
    period: { kind, from: current.from, to: current.to, complete: lastComplete >= current.to },
    earliest_night_date: earliest,
    nights: cur.dates.map((d) => nightEntry(d, byDate.get(d), showScore)),
    summary: cur.summary,
    previous: before ? { from: prev.from, to: prev.to, summary: before.summary } : null,
    comparison,
    notes: contexts.size > 1 ? ['context_changed'] : [],
  };
}
