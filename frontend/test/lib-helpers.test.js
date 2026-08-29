// Pure helpers. Cheap to cover completely, and both feed user-visible copy on the child screens, so a
// wrong answer here is visible to a parent rather than buried in a log.
import { describe, test, expect, afterEach, vi } from 'vitest';
import { ageLabel } from '../src/lib/age.js';
import { getGreeting, getCommonTimezones } from '../src/lib/greeting.js';

// A fixed "now" so age maths can't drift with the calendar; otherwise these tests rot silently.
function freeze(iso) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}
afterEach(() => vi.useRealTimers());

describe('ageLabel', () => {
  test('returns null for a missing, blank or unparseable birthday', () => {
    expect(ageLabel(null)).toBeNull();
    expect(ageLabel(undefined)).toBeNull();
    expect(ageLabel('')).toBeNull();
    expect(ageLabel('not-a-date')).toBeNull();
  });

  test('returns null for a birthday in the future rather than a negative age', () => {
    freeze('2026-08-26T10:00:00Z');
    expect(ageLabel('2027-01-01')).toBeNull();
  });

  test('reports months below two years, singular at exactly one', () => {
    freeze('2026-08-26T10:00:00Z');
    expect(ageLabel('2026-07-26')).toBe('1 month');
    expect(ageLabel('2026-02-26')).toBe('6 months');
    expect(ageLabel('2026-08-26')).toBe('0 months'); // born today
  });

  test('does not count a month until the day-of-month has passed', () => {
    // Born on the 27th, today is the 26th: not yet a full month.
    freeze('2026-08-26T10:00:00Z');
    expect(ageLabel('2026-07-27')).toBe('0 months');
  });

  test('switches to years at exactly 24 months, singular at two', () => {
    freeze('2026-08-26T10:00:00Z');
    expect(ageLabel('2024-09-26')).toBe('23 months'); // one month short
    expect(ageLabel('2024-08-26')).toBe('2 years');
    expect(ageLabel('2022-08-26')).toBe('4 years');
  });

  test('keeps the months past two years, where they still carry the information', () => {
    // "3 years" spans a year over which a child's sleep changes completely, so the months stay.
    freeze('2026-08-26T10:00:00Z');
    expect(ageLabel('2023-06-26')).toBe('3 years 2 months');
    expect(ageLabel('2023-07-26')).toBe('3 years 1 month'); // singular
    expect(ageLabel('2020-01-26')).toBe('6 years 7 months');
  });

  test('a whole number of years drops the months rather than printing zero', () => {
    freeze('2026-08-26T10:00:00Z');
    expect(ageLabel('2023-08-26')).toBe('3 years');
    expect(ageLabel('2024-08-26')).toBe('2 years');
  });
});

describe('getGreeting', () => {
  const at = (hourUtc) => {
    freeze(`2026-08-26T${String(hourUtc).padStart(2, '0')}:00:00Z`);
    return getGreeting('UTC');
  };

  test('covers each part of the day, including the boundaries', () => {
    expect(at(5)).toBe('Good morning');
    expect(at(11)).toBe('Good morning');
    expect(at(12)).toBe('Good afternoon');
    expect(at(16)).toBe('Good afternoon');
    expect(at(17)).toBe('Good evening');
    expect(at(21)).toBe('Good evening');
    expect(at(22)).toBe('Good night');
    expect(at(4)).toBe('Good night'); // the small hours — this app runs overnight
  });

  test('respects the configured timezone rather than the machine clock', () => {
    freeze('2026-08-26T22:00:00Z'); // 08:00 next day in Melbourne
    expect(getGreeting('Australia/Melbourne')).toBe('Good morning');
    expect(getGreeting('UTC')).toBe('Good night');
  });

  test('falls back to local time for an invalid timezone instead of throwing', () => {
    freeze('2026-08-26T10:00:00Z');
    expect(typeof getGreeting('Not/AZone')).toBe('string');
  });
});

describe('getCommonTimezones', () => {
  test('returns a non-empty list that includes the deployment timezone', () => {
    const zones = getCommonTimezones();
    expect(Array.isArray(zones)).toBe(true);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones).toContain('Australia/Melbourne');
  });
});
