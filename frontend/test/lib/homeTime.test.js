// lib/homeTime.js — every time the UI shows is rendered in the HOME timezone (#561), with a zone label
// when the viewer's device is somewhere else.
//
// ★ THE FIXTURE ZONES ARE CHOSEN, NOT RANDOM. The suite's device zone is pinned to Pacific/Auckland
// (vite.config.js) and the locale to en-AU (test/setup.js). The home zones used below —
// America/Los_Angeles and UTC — are neither, so "format in the HOME zone" and "format in the device's
// zone" give different answers and a mutant that mixes them up cannot hide. Los Angeles is also a
// daylight-saving zone on the opposite side of the date line from Auckland, so a day key built from the
// device's calendar day differs from the home day for most hours of the day.
import { describe, test, expect } from 'vitest';
import {
  DEFAULT_HOME_ZONE, TIME, DATE_TIME, resolveZone, deviceZone, zonesDiffer, formatInZone, dayKey, todayKey,
  formatDayKey,
} from '../../src/lib/homeTime.js';

const LA = 'America/Los_Angeles';
const at = (iso) => new Date(iso);

describe('the harness itself', () => {
  test('the device zone really is the pinned one (otherwise every other test here proves nothing)', () => {
    expect(deviceZone()).toBe('Pacific/Auckland');
  });
});

describe('resolveZone — a missing or unknown zone falls back to the default, never to the device', () => {
  test('a real IANA name is kept', () => {
    expect(resolveZone(LA)).toBe(LA);
    expect(resolveZone('UTC')).toBe('UTC');
  });

  test.each([undefined, null, '', 'Not/AZone', 'garbage', 42, {}])('%j -> the default', (bad) => {
    expect(resolveZone(bad)).toBe(DEFAULT_HOME_ZONE);
  });

  test('the default is UTC, the backend default (settings.timezone)', () => {
    expect(DEFAULT_HOME_ZONE).toBe('UTC');
  });
});

describe('formatInZone', () => {
  const D = at('2026-08-31T02:00:00Z'); // 19:00 on 30 Aug in Los Angeles, 14:00 on 31 Aug in Auckland

  test('renders in the HOME zone, not the device zone', () => {
    expect(formatInZone(D, LA, TIME)).toBe('7:00 pm');
    expect(formatInZone(D, 'Pacific/Auckland', TIME)).toBe('2:00 pm');
  });

  test('a missing zone renders in UTC (the default), not in the device zone', () => {
    expect(formatInZone(D, undefined, TIME)).toBe('2:00 am');
    expect(formatInZone(D, 'Not/AZone', TIME)).toBe('2:00 am');
  });

  test('withZone appends the short zone name; without it there is none', () => {
    expect(formatInZone(D, LA, TIME, true)).toBe('7:00 pm GMT-7');
    expect(formatInZone(D, LA, TIME, false)).toBe('7:00 pm');
    expect(formatInZone(D, 'UTC', TIME, true)).toBe('2:00 am UTC');
  });

  test('the date-and-time form carries the home DATE too (the home day is the 30th, not the 31st)', () => {
    expect(formatInZone(D, LA, DATE_TIME, true)).toBe('30/08/2026, 7:00:00 pm GMT-7');
  });

  test('an invalid date is an empty string, not a thrown RangeError', () => {
    expect(formatInZone(new Date('nope'), LA, TIME)).toBe('');
    expect(formatInZone(undefined, LA, TIME)).toBe('');
    expect(formatInZone('2026-08-31', LA, TIME)).toBe('');
  });

  test('the locale and clock format are the viewer\'s, not baked in: no hour12 is forced', () => {
    // A caller that wants 24h passes it; the helper must not override it either way.
    expect(formatInZone(D, LA, { ...TIME, hour12: false })).toBe('19:00');
    expect(formatInZone(D, LA, { ...TIME, hour12: true })).toBe('7:00 pm');
  });
});

describe('daylight saving — both edges, in the HOME zone', () => {
  // Los Angeles 2026: clocks go forward at 02:00 PST on 8 Mar (to 03:00 PDT) and back at 02:00 PDT on
  // 1 Nov (to 01:00 PST).
  test('spring forward: the hour that does not exist is skipped, and the offset changes', () => {
    expect(formatInZone(at('2026-03-08T09:59:00Z'), LA, TIME, true)).toBe('1:59 am GMT-8');
    expect(formatInZone(at('2026-03-08T10:00:00Z'), LA, TIME, true)).toBe('3:00 am GMT-7');
  });

  test('fall back: the same wall-clock hour happens twice and the LABEL tells the two apart', () => {
    // This is the case the zone label earns its keep on: 1:30 am occurs at 08:30Z (PDT) and again at
    // 09:30Z (PST). Without the label an alert log shows two rows at "1:30 am" an hour apart.
    expect(formatInZone(at('2026-11-01T08:30:00Z'), LA, TIME, true)).toBe('1:30 am GMT-7');
    expect(formatInZone(at('2026-11-01T09:30:00Z'), LA, TIME, true)).toBe('1:30 am GMT-8');
  });

  test('the home day is 23 hours long on the spring-forward date and 25 on the fall-back date', () => {
    // 8 Mar starts at 08:00Z (PST midnight) and the NEXT day starts at 07:00Z (PDT midnight).
    expect(dayKey(at('2026-03-08T07:59:00Z'), LA)).toBe('2026-03-07');
    expect(dayKey(at('2026-03-08T08:00:00Z'), LA)).toBe('2026-03-08');
    expect(dayKey(at('2026-03-09T06:59:00Z'), LA)).toBe('2026-03-08');
    expect(dayKey(at('2026-03-09T07:00:00Z'), LA)).toBe('2026-03-09');
    // 1 Nov starts at 07:00Z (PDT midnight) and the next day at 08:00Z (PST midnight).
    expect(dayKey(at('2026-11-01T06:59:00Z'), LA)).toBe('2026-10-31');
    expect(dayKey(at('2026-11-01T07:00:00Z'), LA)).toBe('2026-11-01');
    expect(dayKey(at('2026-11-02T07:59:00Z'), LA)).toBe('2026-11-01');
    expect(dayKey(at('2026-11-02T08:00:00Z'), LA)).toBe('2026-11-02');
  });
});

describe('dayKey — the calendar day in the HOME zone', () => {
  test('★ near midnight the home day and the device day differ, and the HOME day wins', () => {
    // 07:30Z on 5 Jan is 23:30 on 4 Jan in Los Angeles but 20:30 on 5 Jan in Auckland (the device).
    const d = at('2026-01-05T07:30:00Z');
    expect(dayKey(d, LA)).toBe('2026-01-04');
    expect(dayKey(d, 'UTC')).toBe('2026-01-05');
    // What the old code did: the device's own calendar day.
    expect(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
      .toBe('2026-01-05');
  });

  test('a missing or unknown zone keys on UTC, not on the device', () => {
    const d = at('2026-01-05T07:30:00Z'); // the 5th in UTC and in Auckland; pick an instant where they differ
    expect(dayKey(d, undefined)).toBe('2026-01-05');
    const e = at('2026-01-04T20:00:00Z'); // the 4th in UTC, the 5th in Auckland (09:00)
    expect(dayKey(e, undefined)).toBe('2026-01-04');
    expect(dayKey(e, 'Not/AZone')).toBe('2026-01-04');
  });

  test('is zero-padded YYYY-MM-DD whatever the locale, and empty for an invalid date', () => {
    expect(dayKey(at('2026-02-03T12:00:00Z'), 'UTC')).toBe('2026-02-03');
    expect(dayKey(new Date('nope'), 'UTC')).toBe('');
  });

  test('todayKey takes the home zone\'s today', () => {
    const now = at('2026-09-30T20:00:00Z'); // 30 Sep in Los Angeles, already 1 Oct in Auckland
    expect(todayKey(LA, now)).toBe('2026-09-30');
    expect(todayKey('Pacific/Auckland', now)).toBe('2026-10-01');
  });
});

describe('zonesDiffer — when the label appears', () => {
  test('a different zone differs; the same zone does not', () => {
    expect(zonesDiffer(LA, 'Pacific/Auckland')).toBe(true);
    expect(zonesDiffer('Pacific/Auckland', 'Pacific/Auckland')).toBe(false);
  });

  test('★ the real device is compared by default: home = the device zone means no label', () => {
    expect(zonesDiffer('Pacific/Auckland')).toBe(false);
    expect(zonesDiffer(LA)).toBe(true);
  });

  test('an alias of the same zone is NOT a difference (so a household that never travels sees no label)', () => {
    expect(zonesDiffer('NZ', 'Pacific/Auckland')).toBe(false);
    expect(zonesDiffer('Pacific/Auckland', 'NZ')).toBe(false);
  });

  test('a device that will not report its zone is never claimed to differ', () => {
    expect(zonesDiffer(LA, null)).toBe(false);
  });

  test('an unset or invalid home zone is UTC, which differs from a non-UTC device', () => {
    expect(zonesDiffer(undefined, 'Pacific/Auckland')).toBe(true);
    expect(zonesDiffer('Not/AZone', 'Pacific/Auckland')).toBe(true);
    expect(zonesDiffer(undefined, 'UTC')).toBe(false);
  });
});

describe('formatDayKey — a calendar date has no zone', () => {
  test('prints the date and weekday of the key, whatever the device zone', () => {
    // 8 Mar 2026 was a Sunday. Built at noon UTC and printed in UTC: no device offset can move it.
    expect(formatDayKey('2026-03-08', { weekday: 'short', day: 'numeric', month: 'short' })).toBe('Sun, 8 Mar');
    expect(formatDayKey('2026-03-08')).toBe('08/03/2026');
  });

  test('a month label from the first of the month', () => {
    expect(formatDayKey('2026-09-01', { month: 'long', year: 'numeric' })).toBe('September 2026');
  });

  test('something that is not a day key is returned as given, not as "Invalid Date"', () => {
    expect(formatDayKey('not a date')).toBe('not a date');
    expect(formatDayKey(undefined)).toBe('undefined');
  });
});
