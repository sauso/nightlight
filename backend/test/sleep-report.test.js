// The weekly and monthly sleep report (#1236): src/lib/sleepReport.js through GET /api/children/:id/sleep/report
// (src/routes/children.js), on a real temp database over real HTTP, no mocks.
//
// Each claim and the test that fails without it:
//   a week starts on week_start (1, 7, 6), whatever day of it `date` is ... "period bounds, week ..."
//   a month is the 1st to its real last day (28, 29, 30, 31) ............. "period bounds, month ..."
//   no date skipped or doubled across a DST change; clock times are wall
//     clock in each night's own zone ...................................... "Melbourne ..."
//   the default date is TODAY IN THE APP TIMEZONE, not UTC's .............. "the default date ..."
//   the CORRECTED night is summarised, not the detector's row ............. "a corrected night ..."
//   empty bed, "no one was in the bed", promoted from empty, no data:
//     gaps with a class and no figures .................................... "gaps ..."
//   the night in progress is a gap and never counted ...................... "the night in progress ..."
//   80% of the window watched counts, one minute less does not ........... "coverage ..."
//   a figure needs 3 values: 2 is { value: null, ready: false } .......... "the 3-night minimum ..."
//   steady / up / down at each floor, not_enough when a side is thin ....... "steady, up and down ...", "the comparison through the route ..."
//   an incomplete period with < 3 counted nights is not compared .......... "an incomplete period ..."
//   a camera or window change sets `context_changed`, nothing else does ... "context_changed ..."
//   the Show sleep score switch removes EVERY score key ................... "show_sleep_score = 0 ..."
//   best and worst: ties go to the earlier night ......................... "best and worst ..."
//   earliest_night_date, and previous: null before the first night ........ "earliest_night_date ..."
//   404, 400 ............................................................... "unknown child ...", "bad parameters ..."
//   admin and caregiver get the same answer ............................... "admin and caregiver ..."
//
// ⚠️ Fixture ids and names are made up: the repo is public. Fixed dates are in 2025 and early 2026 so no test clock
// (test:future moves it a year ahead) can put them in the future; the two tests about "today" build on the real date.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { zonedToUtc, toSqlUtc, lastCompletedNightDate } = await import('../src/lib/sleepAnalysis.js');
const { applyCorrection } = await import('../src/lib/sleepReviews.js');
const { scoreNight, toScoringInput, ageMonthsOn } = await import('../src/lib/sleepScore.js');
const { sleepBaseline } = await import('../src/lib/sleepBaseline.js');
const { REPORT_CONFIG, periodBounds, compare, summariseNights } = await import('../src/lib/sleepReport.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

const CHILD = 'rp-child';
const BIRTHDAY = '2022-01-15'; // three years old in 2025: old enough for an early-estimate score
const MIN = 60000;
const HOUR = 60 * MIN;

let server;
let adminToken;
let carerToken;

const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const day = (date, n) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const isoWeekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
const localToday = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ctx = (over = {}) => JSON.stringify({ v: 1, camera_id: 'rp-cam', tz: 'UTC', window: { start: '19:00', end: '07:00' }, algo: '10', ...over });
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const COLUMNS = ['child_id', 'night_date', 'window_start', 'window_end', 'status', 'onset_at', 'wake_at', 'in_bed_at',
  'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes', 'coverage_minutes',
  'stir_minutes', 'wake_unconfirmed_at', 'scoring_context', 'computed_at'];
const insertNight = db.prepare(`INSERT INTO sleep_nights (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`);

// One stored night in UTC: window 19:00 to 07:00, put down 19:10, asleep 19:30, up 06:30, 600 minutes asleep, fully
// watched, final. `over` replaces any column.
function nightRow(date, over = {}) {
  return {
    child_id: CHILD,
    night_date: date,
    window_start: `${date} 19:00:00`,
    window_end: `${day(date, 1)} 07:00:00`,
    status: 'ok',
    onset_at: `${date} 19:30:00`,
    wake_at: `${day(date, 1)} 06:30:00`,
    in_bed_at: `${date} 19:10:00`,
    asleep_minutes: 600,
    awake_minutes: 60,
    unknown_minutes: 0,
    wake_count: 2,
    longest_stretch_minutes: 330,
    coverage_minutes: 720,
    stir_minutes: 20,
    wake_unconfirmed_at: null,
    scoring_context: ctx(),
    computed_at: `${day(date, 1)} 10:00:00`,
    ...over,
  };
}
const put = (date, over = {}) => insertNight.run(nightRow(date, over));
const putAll = (dates, over = {}) => dates.forEach((d) => put(d, over));
// The same night in a real timezone: every time is a LOCAL wall-clock time converted with the app's own zonedToUtc, so a
// night across a clock change has a 13- or 11-hour window, as a real one would.
function putLocal(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const at = (dd, h, mi) => zonedToUtc(y, m - 1, d + dd, h, mi, tz);
  const start = at(0, 19, 0);
  const end = at(1, 7, 0);
  put(date, {
    window_start: toSqlUtc(start),
    window_end: toSqlUtc(end),
    onset_at: toSqlUtc(at(0, 19, 30)),
    wake_at: toSqlUtc(at(1, 6, 30)),
    in_bed_at: toSqlUtc(at(0, 19, 10)),
    coverage_minutes: (end - start) / MIN,
    scoring_context: ctx({ tz }),
    computed_at: sqlAt(end.getTime() + 3 * HOUR),
  });
}
const review = (date, cols) => {
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO sleep_reviews (child_id, night_date, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
    .run(CHILD, date, ...keys.map((k) => cols[k]));
};
const setTz = (tz) => db.prepare("UPDATE settings SET timezone = ? WHERE id = 'app'").run(tz);
const get = (query, token = adminToken, child = CHILD) => call(`${server.url}/api/children/${child}/sleep/report${query}`, { token });
const week = (date, extra = '') => get(`?period=week&date=${date}${extra}`);
const datesFrom = (from, n) => Array.from({ length: n }, (_, i) => day(from, i));
// Every path in `v` at which a key named `name` appears.
function keysNamed(v, name, path = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => keysNamed(x, name, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === name) out.push(`${path}.${k}`);
      keysNamed(x, name, `${path}.${k}`, out);
    }
  }
  return out;
}

before(async () => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', 'UTC')
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run();
  const admin = makeUser(db, { id: 'u-rp-admin', username: 'admin', role: 'admin' });
  adminToken = signToken({ id: admin.id, sub: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  const carer = makeUser(db, { id: 'u-rp-carer', username: 'carer', role: 'caregiver' });
  carerToken = signToken({ id: carer.id, sub: carer.id, username: carer.username, role: 'caregiver', sid: makeSession(db, carer.id) });
  server = await mountRouter('/api/children', childrenRouter);
});

beforeEach(() => {
  for (const t of ['sleep_reviews', 'sleep_nights', 'children']) db.prepare(`DELETE FROM ${t}`).run();
  setTz('UTC');
  db.prepare(`INSERT INTO children (id, name, birthday, track_sleep, sleep_window_start, sleep_window_end)
              VALUES (?, 'Report child', NULL, 1, '19:00', '07:00')`).run(CHILD);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

// ================================================== periods ==================================================

test('period bounds, week: it starts on week_start (1, 7 and 6) whether the date is its first, middle or last day', async () => {
  // 2025-03-10 is a Monday.
  const cases = [
    [1, ['2025-03-10', '2025-03-13', '2025-03-16'], '2025-03-10', '2025-03-16'], // Monday to Sunday
    [7, ['2025-03-09', '2025-03-12', '2025-03-15'], '2025-03-09', '2025-03-15'], // Sunday to Saturday
    [6, ['2025-03-08', '2025-03-11', '2025-03-14'], '2025-03-08', '2025-03-14'], // Saturday to Friday
  ];
  for (const [weekStart, dates, from, to] of cases) {
    for (const date of dates) assert.deepEqual(periodBounds('week', date, weekStart), { kind: 'week', from, to }, `${date}, week_start ${weekStart}`);
  }
  // Across a year end, and the default week_start (Monday).
  assert.deepEqual(periodBounds('week', '2025-01-01'), { kind: 'week', from: '2024-12-30', to: '2025-01-05' });

  // The route: the same bounds, and one night entry per date, in order.
  const r = await week('2025-03-12', '&week_start=7');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.period, { kind: 'week', from: '2025-03-09', to: '2025-03-15', complete: true });
  assert.deepEqual(r.body.nights.map((n) => n.date),
    ['2025-03-09', '2025-03-10', '2025-03-11', '2025-03-12', '2025-03-13', '2025-03-14', '2025-03-15']);
  assert.deepEqual(r.body.previous, null, 'no nights at all, so nothing to compare with');
  const def = await week('2025-03-12');
  assert.deepEqual([def.body.period.from, def.body.period.to], ['2025-03-10', '2025-03-16'], 'no week_start: Monday');
});

test('period bounds, month: the 1st to the real last day (28, 29 in a leap year, 30, 31; 2100 is not a leap year)', async () => {
  const cases = [
    ['2026-02-14', '2026-02-01', '2026-02-28'],
    ['2028-02-29', '2028-02-01', '2028-02-29'],
    ['2000-02-01', '2000-02-01', '2000-02-29'],
    ['2100-02-10', '2100-02-01', '2100-02-28'],
    ['2025-04-30', '2025-04-01', '2025-04-30'],
    ['2025-01-15', '2025-01-01', '2025-01-31'],
    ['2025-12-31', '2025-12-01', '2025-12-31'],
  ];
  for (const [date, from, to] of cases) assert.deepEqual(periodBounds('month', date), { kind: 'month', from, to }, date);

  for (const [date, from, n] of [['2025-02-03', '2025-02-01', 28], ['2024-02-03', '2024-02-01', 29], ['2025-06-30', '2025-06-01', 30], ['2025-07-01', '2025-07-01', 31]]) {
    const r = await get(`?period=month&date=${date}`);
    assert.equal(r.status, 200, date);
    assert.deepEqual(r.body.nights.map((x) => x.date), datesFrom(from, n), `${date}: one entry per day of the month`);
    assert.equal(r.body.summary.nights_in_period, n, `${date}: a finished month counts every date`);
  }
});

// A week and a whole month across each of a zone's two clock changes, with the app AND the process in that zone (so
// any date maths done in LOCAL time, new Date(y, m, d) or a parsed 'YYYY-MM-DD' stepped by 86 400 000 ms, would land
// on the change). `weeks`: [a date in the week, its Thursday, the night that crosses the change, that night's window
// in minutes]; every week here starts on Thursday (week_start 4) so the change falls mid-week. `months`: [1st, days].
async function acrossClockChanges(TZ, weeks, months) {
  setTz(TZ);
  const savedTz = process.env.TZ;
  process.env.TZ = TZ;
  try {
    for (const [date, from, longNight, minutes] of weeks) {
      db.prepare('DELETE FROM sleep_nights').run();
      const dates = datesFrom(from, 7);
      dates.forEach((d) => putLocal(d, TZ));
      const row = db.prepare('SELECT coverage_minutes FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(CHILD, longNight);
      assert.equal(row.coverage_minutes, minutes, `precondition: the night of ${longNight} really crosses the clock change`);
      const r = await week(date, '&week_start=4');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.nights.map((n) => [n.date, n.status_class]), dates.map((d) => [d, 'counted']), date);
      const s = r.body.summary;
      assert.deepEqual([s.nights_counted, s.nights_in_period], [7, 7], date);
      // 19:30 is 450 minutes after noon and 06:30 is 1110 on EVERY night, the two around the change included.
      assert.deepEqual(s.onset_clock, { value: 450, n: 7, ready: true, spread: 0 }, date);
      assert.deepEqual(s.wake_clock, { value: 1110, n: 7, ready: true, spread: 0 }, date);
      assert.deepEqual(r.body.nights.map((n) => n.onset_clock), Array(7).fill(450), date);
    }
    for (const [from, n] of months) {
      db.prepare('DELETE FROM sleep_nights').run();
      datesFrom(from, n).forEach((d) => putLocal(d, TZ));
      const r = await get(`?period=month&date=${day(from, 10)}`);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.nights.map((x) => x.date), datesFrom(from, n), from);
      assert.equal(new Set(r.body.nights.map((x) => x.date)).size, n, `${from}: no date doubled`);
      assert.equal(r.body.summary.nights_counted, n, `${from}: every night counted`);
      assert.deepEqual([r.body.summary.onset_clock.value, r.body.summary.wake_clock.value, r.body.summary.wake_clock.spread], [450, 1110, 0], from);
    }
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  }
}

test('Melbourne: a week and a month across each clock change skip no date and double none, and clock times stay wall clock', async () => {
  // Thursday 2026-04-02 to Wednesday 2026-04-08: the clocks go back at 03:00 on Sunday the 5th, inside the night of
  // the 4th. Thursday 2026-10-01 to Wednesday the 7th: forward at 02:00 on Sunday the 4th, inside the night of the 3rd.
  await acrossClockChanges('Australia/Melbourne',
    [['2026-04-05', '2026-04-02', '2026-04-04', 780], ['2026-10-04', '2026-10-01', '2026-10-03', 660]],
    [['2026-04-01', 30], ['2026-10-01', 31]]);
});

test('New York: a week and a month across each clock change (the northern dates) skip no date and double none', async () => {
  // Thursday 2025-03-06 to Wednesday 2025-03-12: forward at 02:00 on Sunday the 9th, inside the night of the 8th.
  // Thursday 2025-10-30 to Wednesday 2025-11-05: back at 02:00 on Sunday 2 November, inside the night of the 1st, and
  // the week crosses a month end as well.
  await acrossClockChanges('America/New_York',
    [['2025-03-09', '2025-03-06', '2025-03-08', 660], ['2025-11-02', '2025-10-30', '2025-11-01', 780]],
    [['2025-03-01', 31], ['2025-11-01', 30]]);
});

test('the default date is today in the app timezone, not in UTC (one of the two zones always differs from UTC)', async () => {
  // Pacific/Kiritimati is UTC+14: its date is AHEAD of UTC's from 10:00 UTC. Etc/GMT+12 is UTC-12: BEHIND until 12:00
  // UTC. So at any moment at least one of them is on another date than UTC, and the checks are built so a report
  // dated by UTC fails there: ahead, today is the FIRST day of its week (the UTC date falls in the week before);
  // behind, today is the LAST day (the UTC date falls in the week after).
  const seen = [];
  for (const [tz, firstDay] of [['Pacific/Kiritimati', true], ['Etc/GMT+12', false]]) {
    setTz(tz);
    for (let attempt = 0; attempt < 2; attempt++) {
      const today = localToday(tz);
      const weekStart = firstDay ? isoWeekday(today) : (isoWeekday(today) % 7) + 1;
      const r = await get(`?period=week&week_start=${weekStart}`);
      if (localToday(tz) !== today) continue; // midnight passed during the request: try once more
      assert.equal(r.status, 200);
      const from = firstDay ? today : day(today, -6);
      assert.deepEqual([r.body.period.from, r.body.period.to], [from, day(from, 6)], tz);
      assert.equal(r.body.period.complete, false, `${tz}: the week holding today is not over`);
      seen.push([tz, today]);
      break;
    }
  }
  assert.equal(seen.length, 2, 'both zones were checked');
  const utc = localToday('UTC');
  assert.ok(seen.some(([, d]) => d !== utc), 'precondition: one zone was on another date than UTC');
});

// ============================================ which nights count ============================================

test('a corrected night: the CORRECTED figure is summarised, not the detector\'s row', async () => {
  put('2025-03-10', { asleep_minutes: 500 });
  put('2025-03-11', { asleep_minutes: 600 });
  // The detector said 700 (with it the median would be 600). The parent moved the wake to 03:10, so the span is 460
  // minutes, less the 60 awake: 400 asleep, and the median of 400, 500, 600 is 500.
  put('2025-03-12', { asleep_minutes: 700 });
  review('2025-03-12', { true_wake_at: '2025-03-13 03:10:00' });
  const overlaid = applyCorrection(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get('2025-03-12'));
  assert.deepEqual([overlaid.corrected, overlaid.asleep_minutes, overlaid.wake_at], [true, 400, '2025-03-13 03:10:00'], 'precondition: the overlay');

  const r = await week('2025-03-12');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.summary.asleep_minutes, { value: 500, n: 3, ready: true });
  const corrected = r.body.nights.find((n) => n.date === '2025-03-12');
  assert.equal(corrected.asleep_minutes, 400);
  assert.equal(corrected.wake_at, '2025-03-13 03:10:00', 'the corrected wake, for the page to print');
  // A wake moved by more than 15 minutes drops the detector's longest stretch (toScoringInput): not on the night either.
  assert.equal('longest_stretch_minutes' in corrected, false);
  assert.deepEqual(r.body.summary.longest_stretch_minutes, { value: null, n: 2, ready: false });
});

test('gaps: an empty bed, "no one was in the bed", a night promoted from empty and no data carry a class and no figures', async () => {
  put('2025-03-10'); // counted
  put('2025-03-11', { asleep_minutes: 999 }); // a parent said no one was in the bed
  review('2025-03-11', { nobody_in_bed: 1 });
  put('2025-03-12', { status: 'empty', onset_at: null, wake_at: null, asleep_minutes: null, awake_minutes: null, wake_count: null, longest_stretch_minutes: null });
  // The detector saw an empty bed; the parent typed both times. The overlay makes it `ok` with 600 minutes "asleep",
  // which would count if promotion were not a gap.
  put('2025-03-13', { status: 'empty', onset_at: null, wake_at: null, asleep_minutes: null, awake_minutes: null, wake_count: null, longest_stretch_minutes: null });
  review('2025-03-13', { true_onset_at: '2025-03-13 20:00:00', true_wake_at: '2025-03-14 06:00:00' });
  put('2025-03-14', { status: 'no_data', asleep_minutes: null });
  put('2025-03-15', { status: 'no_sleep', onset_at: null, wake_at: null, asleep_minutes: null });
  // 2025-03-16: no row at all.
  const promoted = applyCorrection(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get('2025-03-13'));
  assert.deepEqual([promoted.status, promoted.algo_status, promoted.asleep_minutes], ['ok', 'empty', 600], 'precondition: promoted from empty');

  const r = await week('2025-03-12');
  assert.deepEqual(r.body.nights.slice(1), [
    { date: '2025-03-11', status_class: 'empty_bed' },
    { date: '2025-03-12', status_class: 'empty_bed' },
    { date: '2025-03-13', status_class: 'no_data' },
    { date: '2025-03-14', status_class: 'no_data' },
    { date: '2025-03-15', status_class: 'no_data' },
    { date: '2025-03-16', status_class: 'no_data' },
  ]);
  assert.equal(r.body.nights[0].status_class, 'counted');
  assert.deepEqual([r.body.summary.nights_counted, r.body.summary.nights_in_period], [1, 7]);
  assert.equal(r.body.summary.asleep_minutes.n, 1, 'neither 999 nor the promoted 600 reached the figures');
});

test('a counted night whose wake the detector doubted: no time asleep, no wake time, no wake clock (the usual\'s rule)', async () => {
  put('2025-03-10', { wake_unconfirmed_at: '2025-03-11 05:00:00' });
  const r = await week('2025-03-10');
  const n = r.body.nights[0];
  assert.equal(n.status_class, 'counted');
  assert.deepEqual(['asleep_minutes', 'wake_at', 'wake_clock'].filter((k) => k in n), []);
  assert.deepEqual([n.onset_at, n.onset_clock, n.wake_count, n.longest_stretch_minutes], ['2025-03-10 19:30:00', 450, 2, 330]);
});

test('the night in progress is a gap and is never counted, even fully watched', async () => {
  const now = Date.now();
  const today = localToday('UTC');
  // A week that ENDS today, so the night in progress is inside it.
  const weekStart = (isoWeekday(today) % 7) + 1;
  // Five finished nights, today-6 to today-2 (all over by yesterday 07:00): 500, 500, 700, 700, 700 -> median 700.
  [500, 500, 700, 700, 700].forEach((asleep, i) => put(day(today, -6 + i), { asleep_minutes: asleep }));
  // Tonight, stored while it runs, watched for its whole window so far, with a confirmed wake: every clause of the
  // counting rule but "over" holds. Counted, its 100 would make the median 600.
  put(today, {
    window_start: sqlAt(now - HOUR), window_end: sqlAt(now + 11 * HOUR), onset_at: sqlAt(now - 50 * MIN),
    wake_at: sqlAt(now - 5 * MIN), in_bed_at: sqlAt(now - 55 * MIN), asleep_minutes: 100, coverage_minutes: 720,
    computed_at: sqlAt(now),
  });
  assert.equal(toScoringInput(db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get(today)).in_progress, true, 'precondition');

  const r = await week(today, `&week_start=${weekStart}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.period.to, today);
  assert.deepEqual(r.body.nights.at(-1), { date: today, status_class: 'in_progress' });
  assert.equal(r.body.summary.nights_counted, 5);
  assert.deepEqual(r.body.summary.asleep_minutes, { value: 700, n: 5, ready: true });
  assert.equal(r.body.period.complete, false);
});

test('a window end moved later: a night saved under its old window still counts as finished (nights_in_period >= nights_counted)', async () => {
  // The case sleepAnalysis.js describes for computeNightForDisplay (rule 5): a 19:00-07:00 night is saved, the window
  // end then becomes 09:00, and the report is opened at 08:00. The saved row's own window ended at 07:00, so the night
  // counts; by TODAY's window last night is still running (lastCompletedNightDate is the night before). Codex review of
  // PR #1239 found the report then said "7 of 6 nights". Run in a fixed-offset zone where it is 08:xx right now, so the
  // case is real whatever time of day the suite runs at.
  for (let attempt = 0; attempt < 2; attempt++) {
    db.prepare('DELETE FROM sleep_nights').run();
    db.prepare("UPDATE children SET sleep_window_end = '07:00' WHERE id = ?").run(CHILD);
    const offset = ((((8 - new Date().getUTCHours()) % 24) + 36) % 24) - 12; // whole hours east of UTC that make it 08:xx
    const tz = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`; // Etc/ names flip the sign
    setTz(tz);
    const hourNow = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const today = localToday(tz);
    const weekStart = (isoWeekday(today) % 7) + 1; // a week that ends today
    // Six nights, today-6 to last night, saved under 19:00-07:00: the newest ended at 07:00 today.
    datesFrom(day(today, -6), 6).forEach((d) => putLocal(d, tz));
    db.prepare("UPDATE children SET sleep_window_end = '09:00' WHERE id = ?").run(CHILD);
    const r = await week(today, `&week_start=${weekStart}`);
    if (hourNow() !== 8 || localToday(tz) !== today) continue; // the hour turned during the request: once more
    assert.equal(lastCompletedNightDate(CHILD), day(today, -2), 'precondition: by today\'s window, last night is not over');
    const s = r.body.summary;
    assert.equal(r.body.nights[5].status_class, 'counted', 'last night counts by its own saved window');
    assert.equal(s.nights_counted, 6);
    assert.ok(s.nights_in_period >= s.nights_counted, `${s.nights_counted} of ${s.nights_in_period}`);
    assert.equal(s.nights_in_period, 6, 'the six finished nights; tonight is not one of them');
    assert.equal(r.body.period.complete, false);
    return;
  }
  assert.fail('the local hour turned during both attempts');
});

test('coverage: 576 of 720 minutes watched (80%) counts; 575 is low_coverage with no figures', async () => {
  put('2025-03-10', { coverage_minutes: 575, asleep_minutes: 111 });
  put('2025-03-11', { coverage_minutes: 576 });
  const r = await week('2025-03-10');
  assert.deepEqual(r.body.nights[0], { date: '2025-03-10', status_class: 'low_coverage' });
  assert.equal(r.body.nights[1].status_class, 'counted');
  assert.equal(r.body.summary.nights_counted, 1);
});

test('the 3-night minimum: two nights give { value: null, ready: false } for every figure; the third gives values', async () => {
  db.prepare('UPDATE children SET show_sleep_score = 0 WHERE id = ?').run(CHILD); // best and worst by time asleep here
  put('2025-03-10', { asleep_minutes: 600 });
  put('2025-03-11', { asleep_minutes: 610, onset_at: '2025-03-11 19:40:00' });
  let s = (await week('2025-03-10')).body.summary;
  assert.deepEqual(s.asleep_minutes, { value: null, n: 2, ready: false });
  assert.deepEqual(s.wake_count, { value: null, n: 2, ready: false });
  assert.deepEqual(s.settle_minutes, { value: null, n: 2, ready: false });
  assert.deepEqual(s.onset_clock, { value: null, n: 2, ready: false, spread: null });
  assert.deepEqual([s.best_night, s.worst_night], [null, null], 'the best of two nights is not a best night');

  put('2025-03-12', { asleep_minutes: 650, onset_at: '2025-03-12 20:00:00' });
  s = (await week('2025-03-10')).body.summary;
  assert.deepEqual(s.asleep_minutes, { value: 610, n: 3, ready: true });
  // 19:30, 19:40, 20:00 = 450, 460, 480: median 460; quartiles 455 and 470, so the middle half spans 15 minutes.
  assert.deepEqual(s.onset_clock, { value: 460, n: 3, ready: true, spread: 15 });
  assert.deepEqual(s.settle_minutes, { value: 30, n: 3, ready: true }); // put down 19:10 each night: 20, 30, 50
  assert.deepEqual(s.best_night, { date: '2025-03-12', asleep_minutes: 650 });
  assert.deepEqual(s.worst_night, { date: '2025-03-10', asleep_minutes: 600 });
});

// =============================================== the comparison ===============================================

test('steady, up and down at each floor: a change AT the floor is a change, the next median step under it is steady', () => {
  // The floors themselves, pinned as literals (chosen by judgement; the docs list them).
  assert.deepEqual({ ...REPORT_CONFIG.steady },
    { score: 5, asleep_minutes: 15, wake_count: 0.5, longest_stretch_minutes: 15, settle_minutes: 5, onset_clock: 15, wake_clock: 15 });
  assert.equal(REPORT_CONFIG.min_values, 3);
  const fig = (value) => ({ value, n: 3, ready: true });
  // Medians of whole numbers move in halves, so floor - 0.5 is the largest change a real pair can show under it.
  for (const [floor, base] of [[5, 70], [15, 600], [0.5, 2], [15, 330], [5, 20], [15, 450], [15, 1110]]) {
    assert.deepEqual(compare(fig(base + floor), fig(base), floor), { direction: 'up', delta: floor }, `+${floor}`);
    assert.deepEqual(compare(fig(base - floor), fig(base), floor), { direction: 'down', delta: -floor }, `-${floor}`);
    assert.deepEqual(compare(fig(base + floor - 0.5), fig(base), floor), { direction: 'steady', delta: floor - 0.5 }, `+${floor - 0.5}`);
    assert.deepEqual(compare(fig(base - floor + 0.5), fig(base), floor), { direction: 'steady', delta: -floor + 0.5 }, `-${floor - 0.5}`);
  }
  // not_enough wins when either side is not ready, or there is no previous period.
  const thin = { value: null, n: 2, ready: false };
  assert.deepEqual(compare(thin, fig(600), 15), { direction: 'not_enough', delta: null });
  assert.deepEqual(compare(fig(600), thin, 15), { direction: 'not_enough', delta: null });
  assert.deepEqual(compare(fig(600), undefined, 15), { direction: 'not_enough', delta: null });
  // Clock figures go the shorter way round: 11:50 (1430 after noon) then 12:10 (10) is 20 minutes later.
  assert.deepEqual(compare(fig(10), fig(1430), 15, { clock: true }), { direction: 'up', delta: 20 });
  assert.deepEqual(compare(fig(1430), fig(10), 15, { clock: true }), { direction: 'down', delta: -20 });
  assert.deepEqual(compare(fig(10), fig(1430), 15), { direction: 'down', delta: -1420 }, 'only clock figures wrap');
});

test('the comparison through the route: each figure is compared with its own floor', async () => {
  // Previous week (2025-03-03 to 03-09): three nights of 600 asleep, asleep 19:30, up 06:30, put down 19:10.
  putAll(['2025-03-03', '2025-03-04', '2025-03-05']);
  // This week: 615 asleep (+15: up), asleep 19:44 (+14: steady), up 06:15 (-15: down), settling 34 minutes (+14: up),
  // the same wakes and longest stretch (steady, delta 0).
  for (const d of ['2025-03-10', '2025-03-11', '2025-03-12']) {
    put(d, { asleep_minutes: 615, onset_at: `${d} 19:44:00`, wake_at: `${day(d, 1)} 06:15:00` });
  }
  const r = await week('2025-03-10');
  assert.deepEqual(r.body.previous.from, '2025-03-03');
  assert.deepEqual(r.body.comparison, {
    score: { direction: 'not_enough', delta: null }, // no birthday and no usual yet: no night has a score
    asleep_minutes: { direction: 'up', delta: 15 },
    wake_count: { direction: 'steady', delta: 0 },
    longest_stretch_minutes: { direction: 'steady', delta: 0 },
    settle_minutes: { direction: 'up', delta: 14 },
    onset_clock: { direction: 'steady', delta: 14 },
    wake_clock: { direction: 'down', delta: -15 },
  });
  assert.deepEqual(r.body.notes, []);
});

test('an incomplete period with fewer than 3 counted nights is not compared; "so far" is, once it has 3', async () => {
  const today = localToday('UTC');
  const weekStart = (isoWeekday(today) % 7) + 1; // a week that ends today
  datesFrom(day(today, -13), 7).forEach((d) => put(d)); // the whole previous week, 600 a night
  put(day(today, -3), { asleep_minutes: 650 });
  put(day(today, -2), { asleep_minutes: 650 });
  let r = await week(today, `&week_start=${weekStart}`);
  assert.equal(r.body.period.complete, false);
  assert.equal(r.body.previous.summary.asleep_minutes.ready, true, 'precondition: the previous week has a figure');
  assert.deepEqual(r.body.comparison.asleep_minutes, { direction: 'not_enough', delta: null });
  // The finished dates so far: up to and including the last completed night (5 or 6, by the time of day).
  const last = lastCompletedNightDate(CHILD);
  const finished = r.body.nights.filter((n) => n.date <= last).length;
  assert.ok([5, 6].includes(finished), `precondition: ${finished}`);
  assert.equal(r.body.summary.nights_in_period, finished);

  put(day(today, -4), { asleep_minutes: 650 });
  r = await week(today, `&week_start=${weekStart}`);
  assert.equal(r.body.period.complete, false);
  assert.deepEqual(r.body.comparison.asleep_minutes, { direction: 'up', delta: 50 });
});

test('context_changed: set by a camera or window change among the COUNTED nights of both periods, and by nothing else', async () => {
  const A = ctx();
  const cases = [
    ['one camera, one window', [A, A, A, A], [], []],
    ['another camera on one night', [A, A, A, ctx({ camera_id: 'rp-cam-2' })], [], ['context_changed']],
    ['another window on one night', [A, A, A, ctx({ window: { start: '19:00', end: '06:30' } })], [], ['context_changed']],
    ['every night from before the column (NULL)', [null, null, null], [], []],
    ['a NULL night beside a known one', [A, A, A, null], [], ['context_changed']],
    ['only the timezone differs', [A, A, A, ctx({ tz: 'Europe/Berlin' })], [], []],
    ['the previous week on another camera', [A, A, A], [ctx({ camera_id: 'rp-cam-2' })], ['context_changed']],
  ];
  for (const [name, current, previous, notes] of cases) {
    db.prepare('DELETE FROM sleep_nights').run();
    current.forEach((c, i) => put(day('2025-03-10', i), { scoring_context: c }));
    previous.forEach((c, i) => put(day('2025-03-03', i), { scoring_context: c }));
    assert.deepEqual((await week('2025-03-10')).body.notes, notes, name);
  }
  // A night that does not count says nothing about what produced the counted ones.
  db.prepare('DELETE FROM sleep_nights').run();
  putAll(['2025-03-10', '2025-03-11', '2025-03-12']);
  put('2025-03-13', { scoring_context: ctx({ camera_id: 'rp-cam-2' }), coverage_minutes: 100 });
  assert.deepEqual((await week('2025-03-10')).body.notes, [], 'a low-coverage night on another camera');
});

// ============================================== score and switch ==============================================

test('show_sleep_score = 0 removes EVERY score key; best and worst are then by time asleep', async () => {
  db.prepare('UPDATE children SET birthday = ? WHERE id = ?').run(BIRTHDAY, CHILD);
  const asleep = [600, 700, 500, 700, 500, 640, 620];
  datesFrom('2025-03-03', 7).forEach((d, i) => put(d, { asleep_minutes: asleep[i] - 20 }));
  datesFrom('2025-03-10', 7).forEach((d, i) => put(d, { asleep_minutes: asleep[i] }));

  // Switched on: the scores are there, each the score the detail page would show (scoreNight on the night with its
  // baseline, computed here without the code under test), and the summary is their median.
  const on = (await week('2025-03-10')).body;
  const oracle = datesFrom('2025-03-10', 7).map((d) => {
    const input = toScoringInput(applyCorrection(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get(d)));
    return scoreNight(input, sleepBaseline(CHILD, input), ageMonthsOn(BIRTHDAY, d)).score;
  });
  assert.ok(oracle.every(Number.isFinite), 'precondition: every night has a score');
  assert.deepEqual(on.nights.map((n) => n.score), oracle);
  assert.deepEqual(on.summary.score, { value: median(oracle), n: 7, ready: true });
  for (const path of ['$.summary.score', '$.nights[0].score', '$.comparison.score', '$.previous.summary.score', '$.summary.best_night.score']) {
    assert.ok(keysNamed(on, 'score').includes(path), `with the switch on, ${path} is there`);
  }
  // Best and worst by score: the highest and lowest, the earlier night on a tie.
  const pick = (better) => oracle.reduce((b, s, i) => (better(s, oracle[b]) ? i : b), 0);
  assert.deepEqual(on.summary.best_night, { date: day('2025-03-10', pick((a, b) => a > b)), score: Math.max(...oracle) });
  assert.deepEqual(on.summary.worst_night, { date: day('2025-03-10', pick((a, b) => a < b)), score: Math.min(...oracle) });

  db.prepare('UPDATE children SET show_sleep_score = 0 WHERE id = ?').run(CHILD);
  const off = (await week('2025-03-10')).body;
  assert.deepEqual(keysNamed(off, 'score'), [], 'no score key anywhere');
  assert.deepEqual(off.summary.asleep_minutes, on.summary.asleep_minutes, 'nothing else moved');
  assert.deepEqual(off.notes, on.notes);
});

test('a score of 0 is a score: it is kept on its night and counted in the median, never dropped as missing', async () => {
  db.prepare('UPDATE children SET birthday = ? WHERE id = ?').run(BIRTHDAY, CHILD);
  put('2025-03-10');
  put('2025-03-11');
  // A night at the floor of every part the early estimate can judge: a 300-minute span against an age figure of about
  // 683 (duration 0), a third of it asleep, a 10-minute longest stretch and 25 wake-ups (continuity 0), put down two
  // hours before falling asleep (settling 0). Restlessness and consistency need a usual, which 2 nights are not.
  put('2025-03-12', { asleep_minutes: 100, awake_minutes: 200, wake_count: 25, longest_stretch_minutes: 10, in_bed_at: '2025-03-12 17:30:00' });
  const oracle = datesFrom('2025-03-10', 3).map((d) => {
    const input = toScoringInput(applyCorrection(CHILD, db.prepare('SELECT * FROM sleep_nights WHERE night_date = ?').get(d)));
    return scoreNight(input, sleepBaseline(CHILD, input), ageMonthsOn(BIRTHDAY, d)).score;
  });
  assert.equal(oracle[2], 0, 'precondition: the scorer really gives this night 0');
  assert.ok(oracle[0] > 0 && oracle[1] > 0, 'precondition: the other two have ordinary scores');

  const r = (await week('2025-03-10')).body;
  assert.equal(r.nights[2].score, 0);
  assert.deepEqual(r.summary.score, { value: median(oracle), n: 3, ready: true });
  assert.deepEqual(r.summary.worst_night, { date: '2025-03-12', score: 0 });
});

test('best and worst: by time asleep when the score is off, and a tie goes to the EARLIER night', () => {
  const night = (date, asleep) => ({ date, input: toScoringInput(nightRow(date, { asleep_minutes: asleep })), score: null });
  const counted = [night('2025-03-10', 600), night('2025-03-11', 700), night('2025-03-12', 500), night('2025-03-13', 700), night('2025-03-14', 500)];
  const s = summariseNights(counted, { showScore: false, nightsInPeriod: 7 });
  assert.deepEqual(s.best_night, { date: '2025-03-11', asleep_minutes: 700 });
  assert.deepEqual(s.worst_night, { date: '2025-03-12', asleep_minutes: 500 });
  assert.equal('score' in s, false);
  // Score on, with a tie at the top and the bottom.
  const scored = counted.map((n, i) => ({ ...n, score: [80, 90, 70, 90, 70][i] }));
  const t = summariseNights(scored, { showScore: true, nightsInPeriod: 7 });
  assert.deepEqual([t.best_night, t.worst_night], [{ date: '2025-03-11', score: 90 }, { date: '2025-03-12', score: 70 }]);
  assert.deepEqual(t.score, { value: 80, n: 5, ready: true });
  // Four clock times: quartiles interpolated between the sorted values (447.5 and 462.5), a spread of 15.
  const four = ['19:30', '19:20', '19:50', '19:40'].map((hm, i) => {
    const date = day('2025-03-10', i);
    return { date, input: toScoringInput(nightRow(date, { onset_at: `${date} ${hm}:00` })), score: null };
  });
  assert.deepEqual(summariseNights(four, { showScore: false, nightsInPeriod: 4 }).onset_clock, { value: 455, n: 4, ready: true, spread: 15 });
});

// =============================================== the answer's edges ===============================================

test('earliest_night_date, and previous: null when the previous period lies wholly before it', async () => {
  putAll(['2025-03-12', '2025-03-13', '2025-03-14']);
  const r = await week('2025-03-12');
  assert.equal(r.body.earliest_night_date, '2025-03-12');
  assert.equal(r.body.previous, null);
  assert.ok(Object.values(r.body.comparison).every((c) => c.direction === 'not_enough'));
  // The week after: its previous week holds the first nights, so it is there.
  const next = await week('2025-03-19');
  assert.deepEqual([next.body.previous.from, next.body.previous.to, next.body.previous.summary.nights_counted], ['2025-03-10', '2025-03-16', 3]);
  assert.deepEqual(next.body.nights.map((n) => n.status_class), Array(7).fill('no_data'));

  // A child with no nights at all.
  db.prepare("INSERT INTO children (id, name, track_sleep) VALUES ('rp-empty', 'Another child', 1)").run();
  const empty = await get('?period=month&date=2025-03-01', adminToken, 'rp-empty');
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.earliest_night_date, empty.body.previous, empty.body.notes], [null, null, []]);
  assert.equal(empty.body.summary.nights_counted, 0);
  assert.equal(empty.body.summary.best_night, null);
});

test('unknown child: 404, before the parameters are looked at', async () => {
  for (const q of ['?period=week', '?period=year']) {
    const r = await get(q, adminToken, 'no-such-child');
    assert.deepEqual([r.status, r.body], [404, { error: 'Child not found' }], q);
  }
});

test('bad parameters are a 400 with a plain message; a real leap day is not', async () => {
  const PERIOD = 'period must be week or month';
  const DATE = 'date must be a real calendar date from 2000 to 2100, as YYYY-MM-DD';
  const WEEK = 'week_start must be a whole number from 1 (Monday) to 7 (Sunday)';
  const cases = [
    ['', PERIOD], ['?period=year', PERIOD], ['?period=Week', PERIOD], ['?period=week&period=month', PERIOD],
    ['?period=week&date=2026-2-1', DATE], ['?period=week&date=2026-02-31', DATE], ['?period=month&date=2025-13-01', DATE],
    ['?period=week&date=', DATE], ['?period=week&date=0099-01-01', DATE], ['?period=week&date=2025-03-10&date=2025-03-11', DATE],
    ['?period=week&week_start=0', WEEK], ['?period=week&week_start=8', WEEK], ['?period=week&week_start=1.5', WEEK],
    ['?period=week&week_start=mon', WEEK], ['?period=week&week_start=01', WEEK], ['?period=week&week_start=', WEEK],
  ];
  for (const [q, error] of cases) {
    const r = await get(q);
    assert.deepEqual([r.status, r.body], [400, { error }], q);
  }
  const leap = await get('?period=month&date=2028-02-29&week_start=7');
  assert.equal(leap.status, 200);
  assert.deepEqual(leap.body.period, { kind: 'month', from: '2028-02-01', to: '2028-02-29', complete: false });
});

test('dates outside 2000 to 2100 are a 400; both ends are accepted and give valid periods (Codex review of PR #1239)', async () => {
  // 9999-12-31 used to pass, and its week ran into year 10000, which toISOString writes as '+010000-01-02'.
  const DATE = 'date must be a real calendar date from 2000 to 2100, as YYYY-MM-DD';
  for (const date of ['1999-12-31', '2101-01-01', '9999-12-31']) {
    for (const period of ['week', 'month']) {
      const r = await get(`?period=${period}&date=${date}`);
      assert.deepEqual([r.status, r.body], [400, { error: DATE }], `${period} ${date}`);
    }
  }
  const shape = /^\d{4}-\d{2}-\d{2}$/;
  const cases = [
    // 2000-01-01 is a Saturday: its Monday week starts in 1999, and the previous week too (still plain dates).
    ['week', '2000-01-01', '1999-12-27', '2000-01-02'],
    ['month', '2000-01-01', '2000-01-01', '2000-01-31'],
    // 2100-12-31 is a Friday: its Monday week starts on 2100-12-27 and ends in 2101, a valid date, not an overflow.
    ['week', '2100-12-31', '2100-12-27', '2101-01-02'],
    ['month', '2100-12-31', '2100-12-01', '2100-12-31'],
  ];
  for (const [period, date, from, to] of cases) {
    const r = await get(`?period=${period}&date=${date}`);
    assert.equal(r.status, 200, `${period} ${date}`);
    assert.deepEqual([r.body.period.from, r.body.period.to], [from, to], `${period} ${date}`);
    assert.ok(r.body.nights.every((n) => shape.test(n.date)), `${period} ${date}: every night date is YYYY-MM-DD`);
    assert.equal(r.body.nights.at(-1).date, to);
  }
});

test('admin and caregiver get the identical answer', async () => {
  db.prepare('UPDATE children SET birthday = ? WHERE id = ?').run(BIRTHDAY, CHILD);
  datesFrom('2025-03-03', 14).forEach((d, i) => put(d, { asleep_minutes: 560 + 10 * i }));
  review('2025-03-12', { true_wake_at: '2025-03-13 05:00:00' });
  const admin = await week('2025-03-12');
  const carer = await get('?period=week&date=2025-03-12', carerToken);
  assert.equal(admin.status, 200);
  assert.equal(carer.status, 200);
  assert.deepEqual(carer.body, admin.body);
  assert.ok(Number.isFinite(admin.body.summary.score.value), 'precondition: a non-trivial answer, with a score');
});
