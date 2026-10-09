// scripts/clock-shift.mjs is the tool that finds time-bombed fixtures (issue #570): it runs a suite with
// the wall clock moved forward. A tool that SILENTLY does nothing is worse than no tool — it turns
// "the suite passes a year from now" into a statement nobody checked — so each thing it claims to move
// (and each thing it claims not to) is pinned here by running a real child process under it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// A file:// URL, not a path: on Windows `--import C:\...` is read as a URL with the scheme `c:`.
const PRELOAD = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/clock-shift.mjs')).href;
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;

function cleanEnv() {
  const e = { ...process.env };
  delete e.NIGHTLIGHT_CLOCK_SHIFT_DAYS;
  delete e.NIGHTLIGHT_CLOCK_TZ;
  delete e.NODE_OPTIONS;
  return e;
}

// The REAL wall clock, read by an unshifted child. This file's own `Date` cannot be trusted as the
// reference: `npm run test:future` runs THIS suite under the shift too (and the weekly CI job does), and
// a test that compares a child's shifted clock to its own shifted clock agrees with itself whether the
// tool works or not — or, as it did the first time, fails for the wrong reason.
const realNow = () => Number(spawnSync(process.execPath, ['-p', 'Date.now()'], { env: cleanEnv(), encoding: 'utf8' }).stdout);

// Run `code` in a child with the preload, and parse the JSON it prints. cwd is backend/ because that is
// where better-sqlite3 resolves from, exactly as in `npm run test:future`.
function under(env, code) {
  const childEnv = cleanEnv();
  const r = spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', code], {
    cwd: BACKEND, env: { ...childEnv, ...env }, encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null };
}

const NOW = `
  import Database from 'better-sqlite3';
  const db = new Database(':memory:');
  const sql = (q, ...p) => Date.parse(db.prepare(q).pluck().get(...p).replace(' ', 'T') + 'Z');
  console.log(JSON.stringify({
    dateNow: Date.now(), ctor: new Date().getTime(),
    epoch: new Date(0).getTime(), explicit: new Date('2026-09-21T10:00:00Z').getTime(),
    utc: Date.UTC(2026, 8, 21), isDate: new Date() instanceof Date, ctorName: Date.name,
    sqlNow: sql("SELECT datetime('now')"),
    sqlMinus: sql("SELECT datetime('now', '-14 days')"),
    sqlParam: sql("SELECT datetime('now', ?)", '-1 days'),
    sqlStamp: sql('SELECT CURRENT_TIMESTAMP'),
    sqlDefault: (() => { db.exec("CREATE TABLE t (c TEXT DEFAULT (datetime('now')))"); db.exec('INSERT INTO t DEFAULT VALUES'); return Date.parse(db.prepare('SELECT c FROM t').pluck().get().replace(' ', 'T') + 'Z'); })(),
  }));
`;

describe('★ NIGHTLIGHT_CLOCK_SHIFT_DAYS moves every clock a fixture can be compared against', () => {
  const { out, status, stderr } = under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '365' }, NOW);
  const real = realNow();

  test('the child ran', () => assert.equal(status, 0, stderr));

  test('Date.now() and new Date() are a year ahead', () => {
    assert.ok(Math.abs(out.dateNow - (real + 365 * DAY)) < 60_000, `Date.now() was ${new Date(out.dateNow).toISOString()}`);
    assert.ok(Math.abs(out.ctor - (real + 365 * DAY)) < 60_000);
  });

  test('a date written out in full does NOT move — that is the point, a fixed fixture ages', () => {
    assert.equal(out.epoch, 0);
    assert.equal(out.explicit, Date.parse('2026-09-21T10:00:00Z'));
    assert.equal(out.utc, Date.UTC(2026, 8, 21));
  });

  test('a shifted date is still a Date (instanceof is how a lot of code tells a Date from a string)', () => {
    assert.equal(out.isDate, true);
  });

  // The JS clock alone would leave every retention sweep and session expiry reading the REAL clock: the
  // suite would agree with itself and prove nothing about next year.
  test('SQLite datetime(\'now\') moves too, with and without a modifier, and CURRENT_TIMESTAMP and a DEFAULT', () => {
    const want = real + 365 * DAY;
    assert.ok(Math.abs(out.sqlNow - want) < 60_000, new Date(out.sqlNow).toISOString());
    assert.ok(Math.abs(out.sqlMinus - (want - 14 * DAY)) < 60_000, 'a modifier must still apply on top of the shift');
    assert.ok(Math.abs(out.sqlParam - (want - DAY)) < 60_000);
    assert.ok(Math.abs(out.sqlStamp - want) < 60_000, 'CURRENT_TIMESTAMP');
    assert.ok(Math.abs(out.sqlDefault - want) < 60_000, 'a column DEFAULT (datetime(\'now\'))');
  });
});

describe('the shift amount', () => {
  test('unset means a year ahead, not nothing: loading the preload IS asking for the future', () => {
    const { out } = under({}, NOW);
    assert.ok(Math.abs(out.dateNow - (realNow() + 365 * DAY)) < 60_000);
  });

  test('0 changes nothing at all (an UNSHIFTED run must not be reported as a shifted one)', () => {
    const { out } = under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '0' }, NOW);
    assert.ok(Math.abs(out.dateNow - realNow()) < 60_000);
    assert.ok(Math.abs(out.sqlNow - realNow()) < 60_000);
    // Behaviour alone cannot tell "no subclass installed" from "a subclass adding 0": the global must be
    // the untouched built-in, so nothing else (a mock, a vitest fake clock) sits on top of a wrapper.
    assert.equal(out.ctorName, 'Date');
  });

  test('a fractional and a negative number of days are honoured', () => {
    const { out } = under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '-1.5' }, NOW);
    assert.ok(Math.abs(out.dateNow - (realNow() - 1.5 * DAY)) < 60_000);
  });

  test('an ISO instant starts the run AT that moment, to land on a leap day or a DST changeover', () => {
    const { out } = under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '2028-02-29T23:59:30Z' }, NOW);
    assert.ok(Math.abs(out.dateNow - Date.parse('2028-02-29T23:59:30Z')) < 60_000, new Date(out.dateNow).toISOString());
    assert.ok(Math.abs(out.sqlNow - Date.parse('2028-02-29T23:59:30Z')) < 60_000);
  });

  test('★ a typo fails loudly — quietly running unshifted and reporting green is the false assurance this removes', () => {
    const r = under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '365d' }, NOW);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /neither a number of days nor an ISO instant/);
  });
});

describe('NIGHTLIGHT_CLOCK_TZ', () => {
  const OFFSET = `console.log(JSON.stringify({ jan: new Date(2026, 0, 1).getTimezoneOffset(), jul: new Date(2026, 6, 1).getTimezoneOffset() }));`;

  test('changes the zone at runtime (Windows ignores a TZ set before launch)', () => {
    assert.deepEqual(under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '0', NIGHTLIGHT_CLOCK_TZ: 'America/Los_Angeles' }, OFFSET).out, { jan: 480, jul: 420 });
    assert.deepEqual(under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '0', NIGHTLIGHT_CLOCK_TZ: 'Pacific/Auckland' }, OFFSET).out, { jan: -780, jul: -720 });
  });
});

describe('★ it coexists with node:test mock timers', () => {
  // The first version wrapped Date in a Proxy. `mock.timers.enable({ apis: ['Date'] })` then wrote
  // Date.now through the proxy onto the real Date, the shifted now() called the mocked one, and every
  // test file that used mock timers died with "Maximum call stack size exceeded".
  test('mocking Date after the shift, then resetting, neither recurses nor leaks', () => {
    const code = `
      import { mock } from 'node:test';
      mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
      const during = [Date.now(), new Date().getTime()];
      mock.timers.tick(500);
      const ticked = Date.now();
      mock.timers.reset();
      console.log(JSON.stringify({ during, ticked, after: Date.now() }));
    `;
    const r = under({ NIGHTLIGHT_CLOCK_SHIFT_DAYS: '365' }, code);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.during, [1_000_000, 1_000_000]);
    assert.equal(r.out.ticked, 1_000_500);
    assert.ok(Math.abs(r.out.after - (realNow() + 365 * DAY)) < 60_000, 'the shift must come back after reset');
  });
});
