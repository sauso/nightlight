// Run a test suite "as if it were later" (issue #570).
//
// WHY THIS EXISTS. #534 was a front-end test that failed on every PR from 2026-10-01 with no code
// change: a fixture date that was "in the future" the day it was written and in the past a month
// later. `moving between nights` (2026-09-29) and `which night it opens on` (2026-10-01) were the same
// shape. A suite that is green TODAY says nothing about next month, and a red check that nobody caused
// teaches people to merge over red. The only way to find these before the calendar does is to move the
// calendar: run the suite with the wall clock shifted forward and see what falls over.
//
// This file is a preload (`node --import`, or a vitest setup file) that shifts the clock for the whole
// process:
//
//   NIGHTLIGHT_CLOCK_SHIFT_DAYS   a number of days to add (365 = a year ahead; default 365 when this
//                                 file is loaded and the variable is unset), OR an ISO instant that
//                                 means "start the run at that moment" (use it to land on a month end,
//                                 a leap day or a DST changeover: 2027-04-03T15:55:00Z). 0 = do nothing.
//   NIGHTLIGHT_CLOCK_TZ           an IANA zone to run in. Windows ignores a TZ set before launch, but
//                                 assigning process.env.TZ at runtime works on every platform, so it is
//                                 set here rather than on the command line.
//
// Run it with `cd backend && npm run test:future` (a year ahead; override the amount with the variable)
// or `cd frontend && NIGHTLIGHT_CLOCK_SHIFT_DAYS=365 npm test`. CI runs both weekly: future-clock.yml.
//
// WHAT MOVES, AND WHAT DELIBERATELY DOES NOT
//   * `new Date()` and `Date.now()` move. A date given explicitly (`new Date('2026-09-21')`, `Date.UTC`)
//     and `Date.parse` are untouched, which is the point: a fixture with a fixed date now sits further
//     in the past, exactly as it will in real life.
//   * SQLite reads its OWN clock, which JavaScript cannot move. `datetime('now', '-14 days')` is how
//     every retention sweep and session expiry decides what is old, so a shifted JS clock over an
//     unshifted database would test nothing and agree with itself. 'now' in SQL text handed to
//     better-sqlite3 is therefore rewritten to carry the same offset. (A test that opens a database
//     some other way is not covered; none does today.)
//   * Timers do not move. setTimeout, performance.now and process.hrtime are monotonic and a "shifted
//     timer" is meaningless; this tool finds calendar dependence, not load or machine-speed flakes.
//
// WHY A SUBCLASS AND NOT A PROXY. The first version wrapped Date in a Proxy. node:test's
// `mock.timers.enable({ apis: ['Date'] })` writes `Date.now` THROUGH the proxy onto the real Date, the
// shifted `now` then read the mocked one, and every test that used mock timers died with "Maximum call
// stack size exceeded" (bedTransitions.test.js, restart-cancellation.test.js). A subclass leaves the
// real Date untouched, so whatever mocks the global afterwards sees an ordinary class.
//
// KNOWN LIMIT: the subclass cannot be called without `new`, so a bare `Date()` (which returns a string
// of the current time) throws under this preload. Nothing in the suites does that; if one starts to,
// this is why it fails only here.

const RealDate = Date;
const raw = process.env.NIGHTLIGHT_CLOCK_SHIFT_DAYS;
const spec = raw === undefined || raw === '' ? '365' : raw;

// A bare number is days; anything else must parse as an instant. A typo ("365d") must fail loudly:
// quietly running an UNSHIFTED suite and reporting it green is the exact false assurance this tool
// exists to remove.
function shiftMs() {
  if (/^-?\d+(\.\d+)?$/.test(spec)) return Number(spec) * 86_400_000;
  const at = RealDate.parse(spec);
  if (Number.isNaN(at)) {
    throw new Error(`NIGHTLIGHT_CLOCK_SHIFT_DAYS=${JSON.stringify(spec)} is neither a number of days nor an ISO instant`);
  }
  return at - RealDate.now();
}
const OFFSET = shiftMs();

if (process.env.NIGHTLIGHT_CLOCK_TZ) process.env.TZ = process.env.NIGHTLIGHT_CLOCK_TZ;

if (OFFSET !== 0 && !globalThis.__nightlightClockShifted) {
  // Guard: a vitest worker evaluates the setup file once per test file, and a second subclass would
  // stack a second offset on the first.
  globalThis.__nightlightClockShifted = true;
  const realNow = RealDate.now.bind(RealDate);
  globalThis.Date = class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(realNow() + OFFSET);
      else super(...args);
    }
    static now() {
      return realNow() + OFFSET;
    }
  };

  // The database clock. Optional: the front end has no better-sqlite3 and needs none of this.
  try {
    const { createRequire } = await import('node:module');
    const Database = createRequire(`${process.cwd()}/package.json`)('better-sqlite3');
    const secs = Math.round(OFFSET / 1000);
    const shifted = `'now','${secs >= 0 ? '+' : ''}${secs} seconds'`;
    const rewrite = (sql) =>
      typeof sql === 'string'
        ? sql.replace(/'now'/g, shifted).replace(/CURRENT_TIMESTAMP/g, `datetime(${shifted})`)
        : sql;
    for (const method of ['prepare', 'exec']) {
      const original = Database.prototype[method];
      Database.prototype[method] = function (sql, ...rest) {
        return original.call(this, rewrite(sql), ...rest);
      };
    }
  } catch {
    // no better-sqlite3 reachable from this working directory: nothing to shift
  }
}
