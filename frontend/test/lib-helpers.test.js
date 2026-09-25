// Pure helpers. Cheap to cover completely, and both feed user-visible copy on the child screens, so a
// wrong answer here is visible to a parent rather than buried in a log.
import { describe, test, expect, afterEach, vi } from 'vitest';
import { ageLabel } from '../src/lib/age.js';
import { getGreeting, getCommonTimezones } from '../src/lib/greeting.js';
import { showsInBed } from '../src/lib/inBed.js';

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

describe('showsInBed (issue #501)', () => {
  const ONSET = '2026-09-01 09:10:00'; // floored to the minute, as sleepAnalysis stores it
  const night = (in_bed_at, onset_at = ONSET) => ({ in_bed_at, onset_at });

  test('shows the put-down only once it is a full minute before sleep — pinned on the boundary', () => {
    expect(showsInBed(night('2026-09-01 09:09:00'))).toBe(true); // exactly 60 s
    expect(showsInBed(night('2026-09-01 09:09:01'))).toBe(false); // 59 s
    expect(showsInBed(night('2026-09-01 08:47:12'))).toBe(true); // a real story gap
  });

  test('is one-directional: a put-down seconds AFTER the floored onset is not a gap', () => {
    // in_bed_at keeps its real second while onset_at is floored, so a child asleep the moment they
    // went down can have in_bed_at up to 59 s later. An absolute difference would show both times.
    expect(showsInBed(night('2026-09-01 09:10:59'))).toBe(false);
    expect(showsInBed(night('2026-09-01 09:30:00'))).toBe(false); // a put-down well after the onset
  });

  // The corrected-night bug (adversarial code review, 2026-09-25): the overlay replaces onset_at but
  // leaves in_bed_at as the ALGORITHM's put-down. A corrected onset LATER than that stale put-down
  // passes the one-way check above, so without its own guard the card read "In bed 19:47 · Asleep
  // 20:05" — pairing the person's time with the estimate they had just rejected.
  test('never on a night whose ONSET a person corrected, even with a full gap before it', () => {
    const corrected = {
      in_bed_at: '2026-09-01 09:47:00', // the computed put-down: 19:47 Melbourne
      algo_onset_at: '2026-09-01 09:50:00', // what the algorithm said
      onset_at: '2026-09-01 10:05:00', // what the person said: 20:05, 18 min after the stale put-down
      corrected: true,
    };
    expect(showsInBed({ ...corrected, corrected: false }), 'setup: the gap alone would show it').toBe(true);
    expect(showsInBed(corrected)).toBe(false);
  });

  test('a WAKE-only correction keeps it: the onset is still the algorithm\'s, so the pair is one story', () => {
    // Pins the other side of the guard — `corrected` alone must not hide it.
    expect(showsInBed({ ...night('2026-09-01 08:47:12'), algo_onset_at: ONSET, corrected: true })).toBe(true);
  });

  test('needs both times', () => {
    expect(showsInBed(night(null))).toBe(false);
    expect(showsInBed(night('2026-09-01 08:47:12', null))).toBe(false);
    expect(showsInBed(null)).toBe(false);
    expect(showsInBed(undefined)).toBe(false);
  });
});
