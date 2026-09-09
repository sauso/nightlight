import { describe, it, expect } from 'vitest';
import {
  addDays,
  fmtDur,
  fmtDurBig,
  fmtDurAbbr,
  utcMs,
  clipForWake,
  alertsInRange,
  alertLabel,
  labelFor,
  pctOf,
  shortHour,
} from '../src/pages/SleepDetail.jsx';

// The derivation logic behind the sleep detail screen.
//
// ★ WHY THESE AND NOT THE SCREEN. SleepDetail is the most information-dense page in the app and the
// one place the owner reads to find out what actually happened overnight. Almost everything on it is
// DERIVED — a duration formatted from minutes, a marker positioned as a percentage across a bar, a
// clip matched to a wake by timestamp. Every one of those fails SILENTLY: there is no error, no empty
// state, just a number that is wrong, and nothing else in the system disagrees with it. That is the
// opposite of the seam bugs e2e is good at, and it is what a unit test is genuinely best at catching.
//
// The helpers were exported for this, following the precedent set for CameraTile's helpers: the
// component itself is left alone (it fetches, and mounts a timeline over live data), while the logic
// that can be wrong on its own is pinned here.
//
// ⚠️ The suite runs with TZ=UTC pinned in vite.config.js. That is load-bearing for the timezone tests
// below — without it they would pass on a Melbourne machine and fail everywhere else, which is exactly
// the daylight-saving class of bug this repo has already shipped once.

describe('addDays — the date arithmetic behind the night picker', () => {
  it('moves forward and back within a month', () => {
    expect(addDays('2026-08-15', 1)).toBe('2026-08-16');
    expect(addDays('2026-08-15', -1)).toBe('2026-08-14');
    expect(addDays('2026-08-15', 0)).toBe('2026-08-15');
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('★ steps a whole day across a daylight-saving boundary', () => {
    // THE reason this function builds its date in UTC rather than local time. Melbourne springs
    // forward on the first Sunday of October: 2026-10-04 is 23 hours long. A local-time implementation
    // adding 24 hours lands back on the SAME calendar day and the picker silently refuses to advance —
    // the shift-the-calendar-not-the-instant bug this repo has hit before.
    expect(addDays('2026-10-03', 1)).toBe('2026-10-04');
    expect(addDays('2026-10-04', 1)).toBe('2026-10-05');
    // ...and the autumn side, where a local-time implementation can skip a day instead.
    expect(addDays('2026-04-04', 1)).toBe('2026-04-05');
    expect(addDays('2026-04-05', 1)).toBe('2026-04-06');
  });
});

describe('duration formatting — three functions that disagree on purpose', () => {
  it('fmtDur renders hours and minutes, and nothing at all for no value', () => {
    expect(fmtDur(0)).toBe('0m');
    expect(fmtDur(9)).toBe('9m');
    expect(fmtDur(60)).toBe('1h 0m');
    expect(fmtDur(95)).toBe('1h 35m');
    expect(fmtDur(725)).toBe('12h 5m');
    expect(fmtDur(null)).toBe('');
    expect(fmtDur(undefined)).toBe('');
  });

  it('fmtDurBig is the same, but shows an em dash where fmtDur shows nothing', () => {
    // The difference is the point: fmtDur fills inline prose (where an empty string disappears
    // cleanly) and fmtDurBig fills a stat tile (which would otherwise render as a blank box).
    expect(fmtDurBig(95)).toBe('1h 35m');
    expect(fmtDurBig(null)).toBe('—');
    expect(fmtDurBig(0)).toBe('0m');
  });

  it('⚠️ fmtDurAbbr shows an em dash for a REAL zero, not just for missing data', () => {
    // Pinned as a deliberate difference rather than assumed correct. `min ? … : '—'` is truthiness,
    // so a genuine 0 renders identically to "we don't know" — for "Longest stretch", a night where the
    // child never managed one continuous minute reads the same as a night with no data at all.
    // Defensible for that one label; it would NOT be defensible if this were reused for awake time,
    // where zero is the best possible night and deserves to be shown as 0m.
    expect(fmtDurAbbr(0)).toBe('—');
    expect(fmtDurBig(0)).toBe('0m');
    expect(fmtDurAbbr(null)).toBe('—');
    expect(fmtDurAbbr(95)).toBe('1h 35m');
  });
});

describe('utcMs — the app stores UTC without a timezone marker', () => {
  it('★ reads a stored timestamp as UTC, not as local time', () => {
    // Timestamps arrive as `YYYY-MM-DD HH:MM:SS` with no zone. Handing that straight to `new Date()`
    // parses it as LOCAL time, which on a Melbourne machine is 10-11 hours out — every marker on the
    // timeline would sit in the wrong place, consistently enough to look deliberate.
    expect(utcMs('2026-08-30 09:33:00')).toBe(Date.UTC(2026, 7, 30, 9, 33, 0));
    expect(utcMs('2026-08-30 19:48:00')).toBe(Date.UTC(2026, 7, 30, 19, 48, 0));
  });

  it('agrees with an explicitly-zoned parse of the same instant', () => {
    expect(utcMs('2026-01-15 04:05:06')).toBe(new Date('2026-01-15T04:05:06Z').getTime());
  });
});

// A wake spanning 02:00–02:20 UTC, used by the two matching helpers below.
const WAKE_START = '2026-08-30 02:00:00';
const WAKE_END = '2026-08-30 02:20:00';
const at = (iso) => utcMs(iso);

describe('alertsInRange — which alerts belong to a wake', () => {
  const alerts = [
    { id: 1, created_at: '2026-08-30 01:50:00' }, // 10 min before — outside the 3 min margin
    { id: 2, created_at: '2026-08-30 01:57:00' }, // exactly on the early margin
    { id: 3, created_at: '2026-08-30 02:10:00' }, // squarely inside
    { id: 4, created_at: '2026-08-30 02:23:00' }, // exactly on the late margin
    { id: 5, created_at: '2026-08-30 02:24:00' }, // one minute past it
  ];

  it('★ includes the margin boundaries and excludes what lies beyond them', () => {
    // The margin exists because a wake run is trimmed to its ACTIVE minutes while an alert can fire
    // just before or after. Both edges are asserted at the exact boundary and one minute outside it —
    // a `>` written where `>=` was meant, or a margin of the wrong size, changes this list.
    expect(alertsInRange(alerts, WAKE_START, WAKE_END).map((a) => a.id)).toEqual([2, 3, 4]);
  });

  it('keeps the order it was given', () => {
    // The list renders straight into the wake, so ascending order is part of the contract.
    const shuffled = [alerts[3], alerts[1], alerts[2]];
    expect(alertsInRange(shuffled, WAKE_START, WAKE_END).map((a) => a.id)).toEqual([4, 2, 3]);
  });

  it('returns an empty list rather than throwing when nothing matches', () => {
    expect(alertsInRange([], WAKE_START, WAKE_END)).toEqual([]);
    expect(alertsInRange([alerts[0]], WAKE_START, WAKE_END)).toEqual([]);
  });

  it('a zero-length wake still collects the alerts around its instant', () => {
    // Sleep analysis can produce a wake whose start and end are the same minute; the margin is what
    // makes such a wake still able to show what triggered it.
    const out = alertsInRange(alerts, '2026-08-30 02:10:00', '2026-08-30 02:10:00');
    expect(out.map((a) => a.id)).toEqual([3]);
  });
});

describe('clipForWake — which recording belongs to a wake', () => {
  it('finds a clip anchored at the start of the wake', () => {
    const clips = [{ id: 7, started_at: '2026-08-30 02:00:00' }];
    expect(clipForWake(clips, WAKE_START, WAKE_END)?.id).toBe(7);
  });

  it('returns null — not undefined — when there is no clip', () => {
    // The caller renders on `clip && …`, and the difference matters to anyone reading the value back.
    expect(clipForWake([], WAKE_START, WAKE_END)).toBeNull();
    expect(clipForWake([{ id: 9, started_at: '2026-08-30 05:00:00' }], WAKE_START, WAKE_END)).toBeNull();
  });

  it('uses the same margin as the alerts do', () => {
    expect(clipForWake([{ id: 1, started_at: '2026-08-30 01:57:00' }], WAKE_START, WAKE_END)?.id).toBe(1);
    expect(clipForWake([{ id: 2, started_at: '2026-08-30 01:56:59' }], WAKE_START, WAKE_END)).toBeNull();
  });

  it('⚠️ takes the FIRST match in the list, which two close wakes can share', () => {
    // Pinned because it is a real consequence, not an accident of the fixture: the search is a plain
    // `find`, so if two wakes fall within a few minutes of each other the same clip satisfies both and
    // will be shown against each. Documented here rather than asserted as correct — if that is ever
    // judged wrong, this test is where the intended behaviour gets written down.
    const clips = [
      { id: 'first', started_at: '2026-08-30 02:05:00' },
      { id: 'second', started_at: '2026-08-30 02:06:00' },
    ];
    expect(clipForWake(clips, WAKE_START, WAKE_END)?.id).toBe('first');
  });
});

describe('pctOf — where a marker sits on the timeline', () => {
  const startMs = at('2026-08-30 19:00:00');
  const totalMs = 12 * 3600 * 1000; // a 12-hour window

  it('places the ends and the middle', () => {
    expect(pctOf('2026-08-30 19:00:00', startMs, totalMs)).toBe(0);
    expect(pctOf('2026-08-31 01:00:00', startMs, totalMs)).toBe(50);
    expect(pctOf('2026-08-31 07:00:00', startMs, totalMs)).toBe(100);
  });

  it('★ returns 0 for the very start — a number, not a blank', () => {
    // The value is falsy exactly when the event happens at the window's start, so every caller has to
    // test it with `!= null`. They all do today; this is the test that notices if one stops.
    const pct = pctOf('2026-08-30 19:00:00', startMs, totalMs);
    expect(pct).not.toBeNull();
    expect(Number.isFinite(pct)).toBe(true);
  });

  it('returns null for a missing timestamp', () => {
    expect(pctOf(null, startMs, totalMs)).toBeNull();
    expect(pctOf(undefined, startMs, totalMs)).toBeNull();
    expect(pctOf('', startMs, totalMs)).toBeNull();
  });

  it('goes outside 0–100 when an event falls outside the window, so the caller can clamp', () => {
    // The morning exit can land just past the window end (the shadow-wake lookahead), and the caller
    // filters on [-1, 101] before clamping. That only works if this reports the overshoot honestly
    // rather than clamping here.
    expect(pctOf('2026-08-31 07:06:00', startMs, totalMs)).toBeCloseTo(100.83, 1);
    expect(pctOf('2026-08-30 18:54:00', startMs, totalMs)).toBeCloseTo(-0.83, 1);
  });
});

describe('labels', () => {
  it('labelFor names each sleep state in the words the screen uses', () => {
    expect(labelFor('asleep')).toBe('asleep');
    expect(labelFor('stir')).toBe('stirring');
    expect(labelFor('wake')).toBe('awake');
    // Anything else — including 'settling' and an unknown state — is the out-of-sleep bucket.
    expect(labelFor('settling')).toBe('before/after sleep');
    expect(labelFor(undefined)).toBe('before/after sleep');
  });

  it('alertLabel falls back to the raw type rather than losing it', () => {
    expect(alertLabel('sound')).toBe('Sound');
    expect(alertLabel('motion')).toBe('Motion');
    // A detector added later still shows something meaningful instead of a blank row.
    expect(alertLabel('cry')).toBe('cry');
    expect(alertLabel(null)).toBe('Alert');
  });
});

describe('shortHour — the hour ticks along the timeline', () => {
  const midday = Date.UTC(2026, 7, 30, 12, 0, 0);
  const midnight = Date.UTC(2026, 7, 30, 0, 0, 0);

  it('renders a compact 12-hour label', () => {
    expect(shortHour(midday, 'UTC')).toBe('12p');
    expect(shortHour(midnight, 'UTC')).toBe('12a');
    expect(shortHour(Date.UTC(2026, 7, 30, 21, 0, 0), 'UTC')).toBe('9p');
  });

  it('★ formats in the APP timezone, not the machine one', () => {
    // The same instant reads differently in different zones, and the app's configured timezone is the
    // one that matters — a family in Melbourne must not see UTC hour ticks because the server happens
    // to be there. Melbourne is UTC+10 on this August date.
    expect(shortHour(midday, 'Australia/Melbourne')).toBe('10p');
    expect(shortHour(midday, 'America/New_York')).toBe('8a');
    expect(shortHour(midday, 'UTC')).not.toBe(shortHour(midday, 'Australia/Melbourne'));
  });

  it('⚠️ is a 12-hour label whatever the viewer is used to', () => {
    // `hour12: true` is passed explicitly, so a household that reads 24-hour time still gets "9p" here.
    // Deliberate — the ticks have to fit a few pixels — but it is an assumption about the reader, and
    // this is where it is written down. The a/p suffix is produced by stripping AM/PM from the
    // formatted string, which relies on the runtime's default locale being one that emits them.
    expect(shortHour(Date.UTC(2026, 7, 30, 13, 0, 0), 'UTC')).toBe('1p');
    expect(shortHour(Date.UTC(2026, 7, 30, 1, 0, 0), 'UTC')).toBe('1a');
  });
});
