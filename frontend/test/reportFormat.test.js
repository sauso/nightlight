// The pure half of the weekly and monthly report page (lib/reportFormat.js, issue #1236): the words, the rounding, the week
// start, the period arithmetic and the chart models. The page around them is in sleepReport.test.jsx.
//
// WHAT THIS PROTECTS, in order of how silently it would break:
//   - a GAP BECOMING A ZERO: a night that did not count must never get a height, a score or a "0m" (chartModel, typicalText);
//   - a CHANGE worded the wrong way round or from an unrounded delta ("up 7.999999 points", "15 minutes earlier" for later);
//   - the WEEK START: the page sends the viewer's own locale's first day, never a fixed one;
//   - the PERIOD ARITHMETIC at the edges (December to January, February in a leap year, a week over the year end).
import { describe, test, expect, vi, afterEach } from 'vitest';
import {
  FIGURE_TILES, UPCOMING_WORDS, canGoNext, canGoPrevious, changeText, chartModel, driftDomain, gapSummary, gapWords,
  isCalendarDate, isReportShape, localeWeekStart, notReadyWords, nextPeriodDate, periodTitle, previousPeriodDate, readReportParams, reportApiPath,
  reportQuery, slotLabel, slotName, spreadText, typicalText,
} from '../src/lib/reportFormat.js';

// ICU's range separator and spacing vary by version (an en dash, with or without thin spaces): compare on a normalised form.
const plain = (s) => s.replace(/[\s  ]+/g, ' ').replace(/[–—]/g, '-').replace(/ ?- ?/g, '-');

describe('localeWeekStart', () => {
  const realLocale = Intl.Locale;
  afterEach(() => { Intl.Locale = realLocale; });
  // A stand-in that answers by language, so a test can tell "read from the locale" from "hard-coded".
  const stub = (impl) => { Intl.Locale = class { constructor(l) { Object.assign(this, impl(l)); } }; };

  test('★ reads the first day from the viewer\'s language: Sunday-first and Monday-first differ', () => {
    stub((l) => ({ getWeekInfo: () => ({ firstDay: l === 'en-US' ? 7 : 1 }) }));
    expect(localeWeekStart('en-US')).toBe(7);
    expect(localeWeekStart('en-GB')).toBe(1);
  });

  test('uses the older `weekInfo` property when there is no getWeekInfo()', () => {
    stub((l) => ({ weekInfo: { firstDay: l === 'ar-EG' ? 6 : 1 } }));
    expect(localeWeekStart('ar-EG')).toBe(6);
  });

  test('getWeekInfo() answering nothing falls through to weekInfo', () => {
    stub(() => ({ getWeekInfo: () => undefined, weekInfo: { firstDay: 7 } }));
    expect(localeWeekStart('en-US')).toBe(7);
  });

  test('a runtime with neither, an unknown language, or an out-of-range answer falls back to Monday (1)', () => {
    stub(() => ({}));
    expect(localeWeekStart('en-US')).toBe(1);
    stub(() => ({ getWeekInfo: () => ({ firstDay: 0 }) }));
    expect(localeWeekStart('en-US')).toBe(1);
    stub(() => ({ getWeekInfo: () => ({ firstDay: 8 }) }));
    expect(localeWeekStart('en-US')).toBe(1);
    stub(() => ({ getWeekInfo: () => ({ firstDay: 'sunday' }) }));
    expect(localeWeekStart('en-US')).toBe(1);
    Intl.Locale = class { constructor() { throw new RangeError('Incorrect locale information provided'); } };
    expect(localeWeekStart('not a locale')).toBe(1);
    expect(localeWeekStart(undefined)).toBe(1);
  });

  test('the real runtime agrees with the common calendars (Sunday in the US, Monday in Germany)', () => {
    expect(localeWeekStart('en-US')).toBe(7);
    expect(localeWeekStart('de-DE')).toBe(1);
  });
});

describe('the request and the address', () => {
  test('isCalendarDate: only a real day, not just the shape', () => {
    for (const ok of ['2026-11-09', '2028-02-29', '2026-12-31']) expect(isCalendarDate(ok), ok).toBe(true);
    for (const bad of ['2026-02-31', '2027-02-29', '2026-13-01', '2026-11-9', '26-11-09', '', null, undefined, 20261109]) {
      expect(isCalendarDate(bad), String(bad)).toBe(false);
    }
  });

  test('readReportParams: week by default, month on request, a bad date is "today" (no date), never a 400 sent', () => {
    expect(readReportParams(new URLSearchParams(''))).toEqual({ kind: 'week', date: null });
    expect(readReportParams(new URLSearchParams('period=month&date=2026-10-01'))).toEqual({ kind: 'month', date: '2026-10-01' });
    expect(readReportParams(new URLSearchParams('period=year&date=2026-02-31'))).toEqual({ kind: 'week', date: null });
  });

  test('reportApiPath always carries period and week_start, and date only when there is one', () => {
    expect(reportApiPath('kid-1', { kind: 'week', date: '2026-11-09', weekStart: 7 }))
      .toBe('/children/kid-1/sleep/report?period=week&date=2026-11-09&week_start=7');
    expect(reportApiPath('kid-1', { kind: 'month', date: null, weekStart: 1 }))
      .toBe('/children/kid-1/sleep/report?period=month&week_start=1');
  });

  test('reportQuery leaves the date out when there is none', () => {
    expect(reportQuery('month', null)).toEqual({ period: 'month' });
    expect(reportQuery('week', '2026-11-09')).toEqual({ period: 'week', date: '2026-11-09' });
  });
});

describe('moving between periods', () => {
  test.each([
    ['a week across the year end', { from: '2026-12-28', to: '2027-01-03' }, '2026-12-27', '2027-01-04'],
    ['December', { from: '2026-12-01', to: '2026-12-31' }, '2026-11-30', '2027-01-01'],
    ['January (back across the year)', { from: '2027-01-01', to: '2027-01-31' }, '2026-12-31', '2027-02-01'],
    ['a 28-day February', { from: '2027-02-01', to: '2027-02-28' }, '2027-01-31', '2027-03-01'],
    ['a 29-day February', { from: '2028-02-01', to: '2028-02-29' }, '2028-01-31', '2028-03-01'],
    ['a 30-day month', { from: '2026-04-01', to: '2026-04-30' }, '2026-03-31', '2026-05-01'],
    ['a 31-day month', { from: '2026-05-01', to: '2026-05-31' }, '2026-04-30', '2026-06-01'],
    ['a week over a daylight-saving change (Auckland, 27 Sep 2026)', { from: '2026-09-21', to: '2026-09-27' }, '2026-09-20', '2026-09-28'],
  ])('%s: the previous date is the day before `from`, the next the day after `to`', (_n, period, prev, next) => {
    expect(previousPeriodDate(period)).toBe(prev);
    expect(nextPeriodDate(period)).toBe(next);
  });

  const report = (over) => ({ period: { from: '2026-11-03', to: '2026-11-09', complete: true }, earliest_night_date: '2026-10-01', ...over });

  test('★ previous is off exactly when the previous period lies wholly before the first saved night', () => {
    // The previous period ends 2026-11-02. The first night on that very day is reachable; one day later it is not.
    expect(canGoPrevious(report({ earliest_night_date: '2026-11-02' }))).toBe(true);
    expect(canGoPrevious(report({ earliest_night_date: '2026-11-03' }))).toBe(false);
    expect(canGoPrevious(report({ earliest_night_date: null }))).toBe(false);
    expect(canGoPrevious(null)).toBe(false);
  });

  test('★ next is on only for a finished period (period.complete true), never for the current one', () => {
    expect(canGoNext(report())).toBe(true);
    expect(canGoNext(report({ period: { from: '2026-11-03', to: '2026-11-09', complete: false } }))).toBe(false);
    expect(canGoNext(null)).toBe(false);
    expect(canGoNext({ period: {} })).toBe(false);
  });
});

describe('periodTitle', () => {
  test('a week inside one month shares the month and year', () => {
    expect(plain(periodTitle('week', '2026-11-03', '2026-11-09'))).toMatch(/^3-9 Nov 2026$/);
  });

  test('a week over a month end names both months once', () => {
    const t = plain(periodTitle('week', '2026-10-28', '2026-11-03'));
    expect(t).toMatch(/^28 Oct-3 Nov 2026$/);
  });

  test('★ a week over the year end names both years', () => {
    expect(plain(periodTitle('week', '2026-12-28', '2027-01-03'))).toMatch(/^28 Dec 2026-3 Jan 2027$/);
  });

  test('a week over the daylight-saving change in the suite\'s own zone does not move either end', () => {
    // 27 Sep 2026 is the Sunday the clocks go forward in Auckland, the zone the suite runs in: a title built from local times would slip a day.
    expect(plain(periodTitle('week', '2026-09-21', '2026-09-27'))).toMatch(/^21-27 Sep/);
  });

  test.each([
    ['a 28-day month', '2027-02-01', '2027-02-28', 'February 2027'],
    ['a 29-day month', '2028-02-01', '2028-02-29', 'February 2028'],
    ['a 30-day month', '2026-04-01', '2026-04-30', 'April 2026'],
    ['a 31-day month', '2026-05-01', '2026-05-31', 'May 2026'],
    ['December', '2026-12-01', '2026-12-31', 'December 2026'],
  ])('%s is "Month Year"', (_n, from, to, title) => {
    expect(periodTitle('month', from, to)).toBe(title);
  });

  test('a runtime without formatRange gets "from to to"', () => {
    const proto = Intl.DateTimeFormat.prototype;
    const real = proto.formatRange;
    proto.formatRange = undefined;
    try {
      expect(plain(periodTitle('week', '2026-11-03', '2026-11-09'))).toBe('3 Nov 2026 to 9 Nov 2026');
    } finally {
      proto.formatRange = real;
    }
  });

  test('a bad date is printed as it came, never "Invalid Date"', () => {
    expect(periodTitle('week', 'nope', '2026-11-09')).toBe('nope to 2026-11-09');
  });
});

describe('typicalText', () => {
  test('★ no value is never 0, NaN or a dash: it is null', () => {
    for (const { key } of FIGURE_TILES) {
      expect(typicalText(key, null), key).toBeNull();
      expect(typicalText(key, undefined), key).toBeNull();
      expect(typicalText(key, NaN), key).toBeNull();
    }
  });

  test('prints each figure in its own form, rounded for display', () => {
    expect(typicalText('score', 81.6)).toBe('82');
    expect(typicalText('asleep_minutes', 605)).toBe('10h 5m');
    expect(typicalText('asleep_minutes', 44.6)).toBe('45m');
    expect(typicalText('wake_count', 2)).toBe('2');
    expect(typicalText('wake_count', 1.5)).toBe('1.5');
    expect(typicalText('settle_minutes', 12)).toBe('12m');
    expect(typicalText('longest_stretch_minutes', 320)).toBe('5h 20m');
    // 450 minutes after noon is 19:30; the clock form (12 or 24 hour) is the viewer's.
    expect(typicalText('onset_clock', 450)).toMatch(/7:30|19:30/);
  });

  test('a measured zero is a zero (a median of no wake-ups is a real answer), unlike a missing value', () => {
    expect(typicalText('wake_count', 0)).toBe('0');
  });
});

describe('spreadText', () => {
  test('rounds to a whole minute, and to the nearest five from ten up', () => {
    expect(spreadText(20)).toBe('half of nights within about 20 minutes');
    expect(spreadText(17.4)).toBe('half of nights within about 15 minutes');
    expect(spreadText(7.4)).toBe('half of nights within about 7 minutes');
    expect(spreadText(1)).toBe('half of nights within about 1 minute');
  });

  test('no spread (or a nonsense one) prints nothing; a spread of nothing says the times matched', () => {
    expect(spreadText(null)).toBeNull();
    expect(spreadText(undefined)).toBeNull();
    expect(spreadText(-3)).toBeNull();
    expect(spreadText(0)).toMatch(/almost exactly the same time/);
    expect(spreadText(0.4)).toMatch(/almost exactly the same time/);
  });
});

describe('changeText: an arrow AND words, from the server\'s direction, with the size rounded for display', () => {
  const up = (delta) => ({ direction: 'up', delta });
  const down = (delta) => ({ direction: 'down', delta });

  test('★ points: up and down, singular and plural, delta rounded', () => {
    expect(changeText('points', up(8))).toEqual({ trend: 'up', text: 'up 8 points' });
    expect(changeText('points', up(7.6))).toEqual({ trend: 'up', text: 'up 8 points' });
    expect(changeText('points', down(-3.4))).toEqual({ trend: 'down', text: 'down 3 points' });
    expect(changeText('points', up(1))).toEqual({ trend: 'up', text: 'up 1 point' });
  });

  test('★ clock figures say later or earlier in minutes, and in hours from an hour up', () => {
    expect(changeText('clock', up(15))).toEqual({ trend: 'up', text: '15 minutes later' });
    expect(changeText('clock', down(-20))).toEqual({ trend: 'down', text: '20 minutes earlier' });
    expect(changeText('clock', up(65))).toEqual({ trend: 'up', text: '1h 5m later' });
    expect(changeText('clock', up(15.4)).text).toBe('15 minutes later');
  });

  test('durations: minutes, then hours and minutes', () => {
    expect(changeText('minutes', up(25))).toEqual({ trend: 'up', text: 'up 25 minutes' });
    expect(changeText('minutes', down(-1))).toEqual({ trend: 'down', text: 'down 1 minute' });
    expect(changeText('minutes', up(90))).toEqual({ trend: 'up', text: 'up 1h 30m' });
  });

  test('wake-ups move in halves, so a tenth is kept', () => {
    expect(changeText('count', up(0.5))).toEqual({ trend: 'up', text: 'up 0.5 wake-ups' });
    expect(changeText('count', down(-1))).toEqual({ trend: 'down', text: 'down 1 wake-up' });
    expect(changeText('count', down(-1.5))).toEqual({ trend: 'down', text: 'down 1.5 wake-ups' });
    expect(changeText('count', up(1.04))).toEqual({ trend: 'up', text: 'up 1 wake-up' });
  });

  test('steady is steady, and not enough nights says so', () => {
    expect(changeText('points', { direction: 'steady', delta: 2 })).toEqual({ trend: 'steady', text: 'steady' });
    expect(changeText('points', { direction: 'not_enough', delta: null })).toEqual({ trend: 'none', text: 'not enough nights to compare' });
    expect(changeText('points', undefined)).toEqual({ trend: 'none', text: 'not enough nights to compare' });
  });

  test('a direction this build does not know, or a missing delta, is "not enough", never a guess', () => {
    expect(changeText('points', { direction: 'sideways', delta: 4 }).trend).toBe('none');
    expect(changeText('points', { direction: 'up', delta: null }).trend).toBe('none');
    expect(changeText('points', { direction: 'up', delta: NaN }).trend).toBe('none');
  });

  test('a change that rounds to nothing to show reads as steady, in the only words that are true', () => {
    expect(changeText('points', up(0.3))).toEqual({ trend: 'steady', text: 'steady' });
    expect(changeText('clock', down(-0.2))).toEqual({ trend: 'steady', text: 'steady' });
  });
});

describe('gapWords', () => {
  test('each reason has its own words', () => {
    expect(gapWords('no_data')).toBe('No data');
    expect(gapWords('low_coverage')).toBe('Not enough of this night was watched');
    expect(gapWords('empty_bed')).toBe('No one was in the bed');
    expect(gapWords('in_progress')).toBe('Tonight, still in progress');
  });

  test('a date that has not finished and has nothing saved is "not recorded yet", not "no data"; other reasons are unchanged', () => {
    expect(gapWords('no_data', { upcoming: true })).toBe(UPCOMING_WORDS);
    expect(gapWords('empty_bed', { upcoming: true })).toBe('No one was in the bed');
  });

  test('a class this build does not know is still words, never empty or "undefined"', () => {
    expect(gapWords('something_new')).toBe('This night did not count');
  });
});

describe('chartModel', () => {
  const counted = (date, over = {}) => ({ date, status_class: 'counted', score: 80, asleep_minutes: 600, wake_count: 2, ...over });
  const report = (nights, finished = nights.length) => ({ nights, summary: { nights_in_period: finished } });

  test('★ a gap is never a bar: no height, no band, and the reason in words', () => {
    const { slots } = chartModel(report([
      counted('2026-11-02'),
      { date: '2026-11-03', status_class: 'no_data' },
      { date: '2026-11-04', status_class: 'low_coverage' },
      { date: '2026-11-05', status_class: 'empty_bed' },
      { date: '2026-11-06', status_class: 'in_progress' },
    ], 4));
    expect(slots[0].kind).toBe('bar');
    for (const slot of slots.slice(1)) {
      expect(slot.kind, slot.date).toBe('gap');
      expect(slot, slot.date).not.toHaveProperty('pct');
      expect(slot, slot.date).not.toHaveProperty('band');
      expect(typeof slot.words).toBe('string');
    }
    expect(slots.slice(1).map((s) => s.words)).toEqual([
      'No data', 'Not enough of this night was watched', 'No one was in the bed', 'Tonight, still in progress',
    ]);
  });

  test('★ even a counted night with a score of 0 is a bar (a real number), and a very low score is never shorter than a visible bar', () => {
    const { slots } = chartModel(report([counted('2026-11-02', { score: 0 }), counted('2026-11-03', { score: 2 }), counted('2026-11-04', { score: 100 })]));
    expect(slots.map((s) => s.kind)).toEqual(['bar', 'bar', 'bar']);
    expect(slots[0].pct).toBeGreaterThan(0);
    expect(slots[1].pct).toBeGreaterThan(0);
    expect(slots[2].pct).toBe(100);
  });

  test('with scores, a bar is as tall as the score and takes the score\'s band', () => {
    const { mode, slots } = chartModel(report([
      counted('2026-11-02', { score: 90 }), counted('2026-11-03', { score: 75 }), counted('2026-11-04', { score: 60 }), counted('2026-11-05', { score: 40 }),
    ]));
    expect(mode).toBe('score');
    expect(slots.map((s) => [s.pct, s.band])).toEqual([[90, 'great'], [75, 'good'], [60, 'fair'], [40, 'low']]);
  });

  test('★ with no scores at all (the switch is off) the bars are time asleep, scaled to at least a 12 hour axis, with no band', () => {
    const noScore = (date, asleep) => ({ date, status_class: 'counted', asleep_minutes: asleep });
    const { mode, slots } = chartModel(report([noScore('2026-11-02', 360), noScore('2026-11-03', 720), noScore('2026-11-04', 840)]));
    expect(mode).toBe('asleep');
    expect(slots.map((s) => s.band)).toEqual([null, null, null]);
    // The tallest night (14h) rounds up to 14h and fills the bar; 6h is under half of it; a 12h night is not full height.
    expect(slots[2].pct).toBe(100);
    expect(slots[0].pct).toBeCloseTo((360 / 840) * 100);
    expect(slots[1].pct).toBeLessThan(100);
    const short = chartModel(report([noScore('2026-11-02', 540)])).slots[0];
    expect(short.pct).toBeCloseTo((540 / 720) * 100);
  });

  test('a counted night without the figure the chart measures is a stub (it still counted), never a height', () => {
    const scoreless = { date: '2026-11-03', status_class: 'counted', asleep_minutes: 600 };
    const { slots } = chartModel(report([counted('2026-11-02'), scoreless]));
    expect(slots[1].kind).toBe('stub');
    expect(slots[1]).not.toHaveProperty('pct');
    expect(slots[1].words).toBe('No score for this night');
    const noAsleep = { date: '2026-11-03', status_class: 'counted' };
    const asleepMode = chartModel(report([{ date: '2026-11-02', status_class: 'counted', asleep_minutes: 500 }, noAsleep]));
    expect(asleepMode.slots[1]).toMatchObject({ kind: 'stub', words: 'Time asleep is not known for this night' });
  });

  test('dates after the last finished night with nothing saved read "not recorded yet"', () => {
    const { slots } = chartModel(report([counted('2026-11-02'), { date: '2026-11-03', status_class: 'no_data' }, { date: '2026-11-04', status_class: 'no_data' }], 2));
    expect(slots[1].words).toBe('No data');
    expect(slots[2].words).toBe(UPCOMING_WORDS);
  });

  test('a malformed answer gives an empty chart, not a throw', () => {
    expect(chartModel(null)).toEqual({ mode: 'asleep', slots: [] });
    expect(chartModel({})).toEqual({ mode: 'asleep', slots: [] });
  });
});

describe('slot labels and names', () => {
  test('a week prints the weekday and the day on every slot; a month a bare number on the 1st and every fifth after', () => {
    expect(slotLabel('week', '2026-11-03', 1)).toEqual({ top: 'Tue', bottom: '3' });
    expect(slotLabel('month', '2026-11-01', 0)).toEqual({ top: '1', bottom: null });
    expect(slotLabel('month', '2026-11-06', 5)).toEqual({ top: '6', bottom: null });
    expect(slotLabel('month', '2026-11-02', 1)).toBeNull();
    expect(slotLabel('month', '2026-11-30', 29)).toBeNull();
  });

  test('★ a name STARTS with what the slot prints, and a gap\'s carries its reason in words', () => {
    const lead = 'Tue 3, 3 Nov';
    const bar = { date: '2026-11-03', kind: 'bar', band: 'good', figures: { score: 82, asleep: 605, wakes: 1 } };
    expect(slotName(bar)).toBe(`${lead}, score 82, Good, asleep 10h 5m, 1 wake-up`);
    expect(slotName({ date: '2026-11-03', kind: 'gap', status: 'empty_bed', words: 'No one was in the bed' })).toBe(`${lead}, No one was in the bed`);
    expect(slotName({ date: '2026-11-03', kind: 'stub', band: null, words: 'No score for this night', figures: { score: null, asleep: 600, wakes: 2 } }))
      .toBe(`${lead}, No score for this night, asleep 10h 0m, 2 wake-ups`);
  });

  test('the score\'s band word follows the number where there is one ("Good"), and the lowest band has none', () => {
    const f = { score: 90, asleep: null, wakes: null };
    expect(slotName({ date: '2026-11-03', kind: 'bar', band: 'great', figures: f })).toMatch(/score 90, Great$/);
    expect(slotName({ date: '2026-11-03', kind: 'bar', band: 'low', figures: { ...f, score: 40 } })).toMatch(/score 40$/);
  });
});

describe('isReportShape: what the page may draw', () => {
  const ok = () => ({
    period: { kind: 'week', from: '2026-11-02', to: '2026-11-08', complete: true },
    summary: {}, comparison: {}, nights: [{ date: '2026-11-02', status_class: 'counted' }],
  });

  test('accepts a report, with extra keys, extra night fields, no notes or any list of notes', () => {
    expect(isReportShape(ok())).toBe(true);
    expect(isReportShape({ ...ok(), brand_new: 1, notes: ['unknown_code', 3] })).toBe(true);
    expect(isReportShape({ ...ok(), nights: [{ date: '2026-11-02', extra: {} }] })).toBe(true);
    expect(isReportShape({ ...ok(), nights: [] })).toBe(true);
  });

  test.each([
    ['null', null], ['a string', 'x'], ['an array', []],
    ['nights holding null', { nights: [null] }],
    ['nights holding a non-object', { nights: ['2026-11-02'] }],
    ['a night with no date', { nights: [{ status_class: 'counted' }] }],
    ['a night with a bad date', { nights: [{ date: '2026-02-31' }] }],
    ['nights not a list', { nights: {} }],
    ['bounds that are not dates', { period: { from: 'monday', to: '2026-11-08' } }],
    ['no period', { period: undefined }],
    ['a summary that is not an object', { summary: 'x' }],
    ['no comparison', { comparison: undefined }],
    ['notes that is not a list', { notes: 'context_changed' }],
  ])('refuses %s', (_name, patch) => {
    expect(isReportShape(patch === null || typeof patch === 'string' || Array.isArray(patch) ? patch : { ...ok(), ...patch })).toBe(false);
  });
});

describe('notReadyWords', () => {
  test('★ fewer usable nights than counted nights is "not measured"; usable on all of them is "not enough nights"', () => {
    expect(notReadyWords({ n: 2, ready: false }, 7)).toBe('Not measured on enough of these nights');
    expect(notReadyWords({ n: 0, ready: false }, 30)).toBe('Not measured on enough of these nights');
    expect(notReadyWords({ n: 1, ready: false }, 1)).toBe('Not enough nights yet');
    expect(notReadyWords({ n: 2, ready: false }, 2)).toBe('Not enough nights yet');
  });

  test('missing numbers fall back to the plain words, never "undefined"', () => {
    expect(notReadyWords(undefined, 7)).toBe('Not enough nights yet');
    expect(notReadyWords({ ready: false }, 7)).toBe('Not enough nights yet');
    expect(notReadyWords({ n: 2 }, undefined)).toBe('Not enough nights yet');
  });
});

describe('gapSummary', () => {
  const gap = (status, words = gapWords(status)) => ({ kind: 'gap', status, words });

  test('says why, in a fixed order, for a phone with no hover', () => {
    const slots = [gap('low_coverage'), gap('no_data'), gap('no_data'), gap('empty_bed'), gap('in_progress'), { kind: 'bar' }];
    expect(gapSummary(slots)).toBe('Not counted: 2 nights with no data, 1 night not watched enough, 1 night with no one in the bed, 1 night still in progress.');
  });

  test('nothing to say when every night counted, and the not-yet-recorded dates are left to the "so far" line', () => {
    expect(gapSummary([{ kind: 'bar' }, { kind: 'bar' }])).toBeNull();
    expect(gapSummary([{ kind: 'bar' }, gap('no_data', UPCOMING_WORDS)])).toBeNull();
  });

  test('a class this build does not know is still counted', () => {
    expect(gapSummary([gap('something_new')])).toBe('Not counted: 1 night that did not count.');
  });
});

describe('driftDomain', () => {
  test('holds every dot and the band, with air, on whole-hour lines, and never under two hours', () => {
    const d = driftDomain([450, 465, 480], { value: 465, spread: 20 });
    // 450 - 20 = 430 -> floors to 420 (7 hours after noon); 480 + 20 = 500 -> ceils to 540.
    expect(d).toEqual({ lo: 420, hi: 540, ticks: [420, 480, 540] });
    expect(driftDomain([300], null)).toEqual({ lo: 240, hi: 360, ticks: [240, 300, 360] });
    const narrow = driftDomain([450], { value: 450, spread: 0 });
    expect(narrow.hi - narrow.lo).toBeGreaterThanOrEqual(120);
  });

  test('a wide range is thinned to about four labelled lines', () => {
    const d = driftDomain([0, 600], null);
    expect(d.ticks.length).toBeLessThanOrEqual(5);
    expect(d.ticks[0]).toBe(d.lo);
    expect(d.ticks.at(-1)).toBe(d.hi);
  });

  test('the band widens the range even when the dots do not', () => {
    const d = driftDomain([450], { value: 450, spread: 200 });
    expect(d.lo).toBeLessThanOrEqual(350);
    expect(d.hi).toBeGreaterThanOrEqual(550);
  });

  test('nothing to draw gives null', () => {
    expect(driftDomain([], null)).toBeNull();
    expect(driftDomain([null, NaN], { value: 450, spread: 10 })).toBeNull();
  });
});
