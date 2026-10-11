// The sleep accuracy scoreboard (scripts/scoreboard.mjs): how far is the app's FRESH answer from what the
// parent said happened, split into nights the code was fitted to and nights it has not seen.
//
// ⚠️ IT LIVES HERE BECAUSE THIS IS THE ONLY TEST HARNESS IN THE REPO (same reason as
// probe-sample-timing.test.js): the module under test is repo-root tooling (`scripts/`).
//
// THREE LAYERS, because each catches a different way of being wrong:
//   1. parseInstant / parseArgs: pure. The split is only as good as the time parser: a zone-less string read
//      as local time moves a review across the cutoff on a laptop in another timezone.
//   2. scoreReviews / summarise with a STUBBED computeNight: every number below is worked out by hand from the
//      stub's inputs (the errors are chosen, not derived), so a wrong comparison, threshold or denominator
//      cannot also move the expectation.
//   3. The real script, as a child process, on a real database file with real activity samples: proves the
//      snapshot is not touched, the backend's own computeNight is what is scored (stored rows are decoys),
//      the transition fallback works, child labels follow creation order, and no name reaches the output.
//      Expected errors there are known because the truth is built as "what computeNight says, +/- a chosen
//      offset", so they hold whatever the algorithm's numbers are on the day.
//
// Claim -> test (each fails when the claim is false; scripts/scoreboard.mjs mutated to prove it, see the PR):
//   within-threshold bounds are inclusive and a blank is a miss ...... "per-field percentages ..."
//   median / mean are absolute and over scored nights only ........... "median and mean are ..."
//   the split is "<= cutoff is fitted-to" ............................ "the split boundary ..."
//   dismissed / nobody_in_bed / no-truth / no_data are excluded ...... "exclusions ..."
//   NULL wake and > 60 are counted apart ............................. "per-field percentages ..." (wake_null, wake_over_60)
//   the original snapshot is never written ........................... "read-only: ..."
//   the fresh recompute is scored, not the stored row ................ "scores the fresh recompute ..."
//   a picked transition stands in for a typed time ................... "scores the fresh recompute ..." (nights B and C)
//   no child or camera name in the output ............................ "no name ..."
//   --out is refused inside the repo ................................. "--out inside the repository ..."
//   --backend scores that tree's computeNight ........................ "--backend ..."
//   the clock is frozen (a night in progress shows its blank) ........ "the frozen clock decides ..."
//   the newest rows (a -wal beside the snapshot) are read ............ "a -wal beside the snapshot ..."
//   the default clock is the file's mtime ............................ "the clock defaults ..."
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

// DATA_DIR must be set before db.js is first imported (it opens the database at module load).
useTempDataDir();

const SB = await import(new URL('../../scripts/scoreboard.mjs', import.meta.url).href);
const SCRIPT = fileURLToPath(new URL('../../scripts/scoreboard.mjs', import.meta.url));
const { default: db } = await import('../src/db.js');
const { computeNight } = await import('../src/lib/sleepAnalysis.js');

const tmpDirs = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  try { db.close(); } catch { /* already closed */ }
  cleanupTempDataDirs();
});

// ---------------------------------------------------------------------------------------------------
// 1. time and arguments
// ---------------------------------------------------------------------------------------------------

describe('parseInstant', () => {
  test('a zone-less time is UTC, never this machine\'s local time', () => {
    // Date.parse('2026-10-11T07:50:00') is LOCAL time: on a laptop at +11 that is 11 hours off, and a review
    // saved at 07:50 UTC would land on the other side of a midnight cutoff.
    assert.equal(SB.parseInstant('2026-10-11 07:50:00'), Date.UTC(2026, 9, 11, 7, 50, 0));
    assert.equal(SB.parseInstant('2026-10-11T07:50:00'), Date.UTC(2026, 9, 11, 7, 50, 0));
    assert.equal(SB.parseInstant('2026-10-11'), Date.UTC(2026, 9, 11));
    assert.equal(SB.parseInstant('2026-10-11T07:50:00Z'), Date.UTC(2026, 9, 11, 7, 50, 0));
    assert.equal(SB.parseInstant('2026-10-11T18:50:00+11:00'), Date.UTC(2026, 9, 11, 7, 50, 0));
  });
  test('rubbish is null, not NaN or "now"', () => {
    for (const v of [null, undefined, '', 'yesterday', '2026-13-45 99:00:00x', '11/10/2026']) assert.equal(SB.parseInstant(v), null, String(v));
  });
});

describe('parseArgs', () => {
  test('defaults, and every option', () => {
    const a = SB.parseArgs(['x.db']);
    assert.equal(a.db, 'x.db');
    assert.equal(a.unseenAfter, '2026-10-11T00:00:00Z');
    assert.equal(a.json, false);
    const b = SB.parseArgs(['x.db', '--clock=2026-10-11T07:50:00Z', '--unseen-after=2026-10-12', '--json', '--out=o.md', '--label=dev@abc', '--backend=/b']);
    assert.deepEqual([b.clock, b.unseenAfter, b.json, b.out, b.label, b.backend], ['2026-10-11T07:50:00Z', '2026-10-12', true, 'o.md', 'dev@abc', '/b']);
  });
  test('a typo or a stray word is refused, not ignored', () => {
    // --unseen-afer silently ignored would score the DEFAULT split and look entirely plausible.
    for (const argv of [['x.db', '--unseen-afer=2026-10-12'], ['x.db', '--clock'], ['x.db', '--clock='], ['x.db', 'y.db'], [], ['x.db', '--clock=banana'], ['x.db', '--unseen-after=nope']]) {
      assert.throws(() => SB.parseArgs(argv), Error, JSON.stringify(argv));
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. scoring with a stubbed computeNight
// ---------------------------------------------------------------------------------------------------

const BASE = Date.UTC(2026, 8, 1, 20, 0, 0);
const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const UNSEEN_AFTER = '2026-10-11T00:00:00Z';
const FITTED_AT = '2026-10-05 07:00:00';
const UNSEEN_AT = '2026-10-12 07:00:00';

// One review plus the stub's answer for it. For each field: undefined = the parent gave no time;
// a number = the app is that many MINUTES LATER than the truth (negative = earlier); 'blank' = a true time
// exists and the app returned none.
function makeCase(child, night, { at = FITTED_AT, ib, on, wk, status = 'ok', dismissed = 0, nobody = 0, throws = false } = {}) {
  const val = (v) => (v === undefined || v === 'blank' ? null : sqlAt(BASE + v * 60000));
  const truth = (v) => (v === undefined ? null : sqlAt(BASE));
  return {
    review: {
      child_id: child, night_date: night, dismissed, nobody_in_bed: nobody, reviewed_at: at,
      true_in_bed_at: truth(ib), true_onset_at: truth(on), true_wake_at: truth(wk),
    },
    answer: throws ? 'throw' : { status, in_bed_at: val(ib), onset_at: val(on), wake_at: val(wk) },
  };
}
function score(cases, extra = {}) {
  const answers = new Map(cases.map((c) => [`${c.review.child_id}|${c.review.night_date}`, c.answer]));
  const childNo = new Map([['k1', 1], ['k2', 2]]);
  return SB.scoreReviews(cases.map((c) => c.review), {
    childNo,
    compute: (id, night) => { const a = answers.get(`${id}|${night}`); if (a === 'throw') throw new Error('boom'); return a; },
    unseenAfterMs: SB.parseInstant(UNSEEN_AFTER),
    ...extra,
  });
}
const group = (report, name) => report.groups.find((g) => g.group === name);

// The hand-worked scenario. Child k1, fitted-to:
//   wake errors (min)  a:+4  b:+10  c:-12  d:+90  e:blank      -> truth 5, scored 4, within(10): a,b = 2,
//                                                                 |e| = 4,10,12,90 -> median 11, mean 29,
//                                                                 blank 1, over 60: 1 (d)
//   onset errors       a:-20 b:+15  c:+16  d:blank e:0          -> truth 5, scored 4, within(15): b,e = 2,
//                                                                 |e| = 20,15,16,0 -> median 15.5, mean 12.75 -> 12.8
//   in-bed errors      a:+10 c:-11                              -> truth 2, scored 2, within(10): a = 1,
//                                                                 |e| = 10,11 -> median 10.5, mean 10.5
// Child k1, unseen: wake u1:+3 u2:-61 u3:+60 -> |e| = 3,61,60; within 1; over 60: ONLY u2 (60 is not > 60);
//                                                 median 60, mean 41.3; no blank.
const K1_CASES = [
  makeCase('k1', '2026-09-01', { ib: 10, on: -20, wk: 4 }),
  makeCase('k1', '2026-09-02', { on: 15, wk: 10 }),
  makeCase('k1', '2026-09-03', { ib: -11, on: 16, wk: -12 }),
  makeCase('k1', '2026-09-04', { on: 'blank', wk: 90 }),
  makeCase('k1', '2026-09-05', { on: 0, wk: 'blank' }),
  makeCase('k1', '2026-10-12', { at: UNSEEN_AT, wk: 3 }),
  makeCase('k1', '2026-10-13', { at: UNSEEN_AT, wk: -61 }),
  makeCase('k1', '2026-10-14', { at: UNSEEN_AT, wk: 60 }),
];

describe('scoreReviews / summarise (stubbed computeNight)', () => {
  test('per-field percentages, blanks and the > 60 count are exactly the hand-worked ones', () => {
    const { nights, excluded } = score(K1_CASES);
    assert.equal(nights.length, 8);
    assert.deepEqual(excluded, { dismissed: 0, nobody_in_bed: 0, no_true_time: 0, unknown_child: 0, no_data: 0 });
    const f = SB.summarise(nights.filter((n) => n.set === 'fitted'));
    assert.equal(f.nights, 5);

    assert.deepEqual(f.fields.wake, { threshold_min: 10, n_truth: 5, n_scored: 4, within: 2, within_pct: 40, median_abs_min: 11, mean_abs_min: 29 });
    assert.equal(f.wake_null, 1, 'one night had a true wake and the app gave none');
    assert.equal(f.wake_over_60, 1);

    assert.deepEqual(f.fields.onset, { threshold_min: 15, n_truth: 5, n_scored: 4, within: 2, within_pct: 40, median_abs_min: 15.5, mean_abs_min: 12.8 });
    assert.deepEqual(f.fields.in_bed, { threshold_min: 10, n_truth: 2, n_scored: 2, within: 1, within_pct: 50, median_abs_min: 10.5, mean_abs_min: 10.5 });

    const u = SB.summarise(nights.filter((n) => n.set === 'unseen'));
    assert.equal(u.nights, 3);
    assert.deepEqual(u.fields.wake, { threshold_min: 10, n_truth: 3, n_scored: 3, within: 1, within_pct: 33, median_abs_min: 60, mean_abs_min: 41.3 });
    assert.equal(u.wake_null, 0);
    assert.equal(u.wake_over_60, 1, '|error| of exactly 60 is not "over 60"; only -61 is');
    // a field nobody gave a truth for is "no data", not 0%
    assert.deepEqual(u.fields.onset, { threshold_min: 15, n_truth: 0, n_scored: 0, within: 0, within_pct: null, median_abs_min: null, mean_abs_min: null });
  });

  test('median and mean are over absolute errors: opposite signs do not cancel', () => {
    // +30 and -30 average to 0 signed. Absolute: median = mean = 30.
    const { nights } = score([makeCase('k1', '2026-09-01', { wk: 30 }), makeCase('k1', '2026-09-02', { wk: -30 })]);
    const s = SB.summarise(nights).fields.wake;
    assert.equal(s.median_abs_min, 30);
    assert.equal(s.mean_abs_min, 30);
    assert.equal(s.within, 0);
    // and the per-night error keeps its sign
    assert.deepEqual(nights.map((n) => n.err.wake), [30, -30]);
  });

  test('a blank does not flatter the median or mean, but it does cost the percentage', () => {
    const { nights } = score([makeCase('k1', '2026-09-01', { wk: 2 }), makeCase('k1', '2026-09-02', { wk: 'blank' })]);
    const s = SB.summarise(nights);
    assert.equal(s.fields.wake.within_pct, 50, '1 of 2 truths hit; the blank is a miss');
    assert.equal(s.fields.wake.median_abs_min, 2, 'the blank is not a zero error');
    assert.equal(s.fields.wake.mean_abs_min, 2);
    assert.equal(s.wake_null, 1);
  });

  test('the split boundary: reviewed exactly at the cutoff is fitted-to, one second later is unseen', () => {
    const cases = [
      makeCase('k1', '2026-09-01', { wk: 0, at: '2026-10-10 23:59:59' }),
      makeCase('k1', '2026-09-02', { wk: 0, at: '2026-10-11 00:00:00' }), // exactly --unseen-after
      makeCase('k1', '2026-09-03', { wk: 0, at: '2026-10-11 00:00:01' }),
      makeCase('k1', '2026-09-04', { wk: 0, at: null }), // cannot be proven unseen: cautious side
    ];
    const { nights } = score(cases);
    assert.deepEqual(nights.map((n) => n.set), ['fitted', 'fitted', 'unseen', 'fitted']);
  });

  test('exclusions: dismissed, nobody_in_bed, no true time, no_data and an unknown child are not scored, and are counted', () => {
    const cases = [
      makeCase('k1', '2026-09-01', { wk: 5 }), // the one scored night
      makeCase('k1', '2026-09-02', { wk: 5, dismissed: 1 }), // has a time, but dismissed
      makeCase('k1', '2026-09-03', { ib: 1, on: 1, wk: 1, nobody: 1 }), // has times AND nobody_in_bed
      makeCase('k1', '2026-09-04', { dismissed: 1, nobody: 1, wk: 1 }), // both flags: counted once, as dismissed
      makeCase('k1', '2026-09-05', {}), // no true time at all
      makeCase('k1', '2026-09-06', { wk: 5, status: 'no_data' }), // the snapshot cannot see this night
      makeCase('ghost', '2026-09-07', { wk: 5 }), // a child no longer in the database
    ];
    const { nights, excluded } = score(cases);
    assert.deepEqual(nights.map((n) => n.night), ['2026-09-01']);
    assert.deepEqual(excluded, { dismissed: 2, nobody_in_bed: 1, no_true_time: 1, unknown_child: 1, no_data: 1 });
  });

  test('a night whose computeNight throws is a blank, not a crash and not a skipped night', () => {
    const { nights } = score([makeCase('k1', '2026-09-01', { wk: 5, throws: true })]);
    assert.equal(nights.length, 1);
    assert.equal(nights[0].computed.wake, null);
    assert.equal(nights[0].status, 'threw');
    assert.equal(SB.summarise(nights).wake_null, 1);
  });

  test('the report groups by child and an overall row that is the union', () => {
    const cases = [
      ...K1_CASES,
      makeCase('k2', '2026-09-01', { wk: 0 }),
      makeCase('k2', '2026-10-12', { wk: 40, at: UNSEEN_AT }),
    ];
    const rep = SB.buildReport(score(cases), { db: 'x.db', label: null, clock: 'c', clock_source: 's', unseen_after: 'u', timezone: 'UTC' });
    assert.deepEqual(rep.groups.map((g) => g.group), ['child 1', 'child 2', 'overall']);
    assert.equal(group(rep, 'child 1').fitted.nights, 5);
    assert.equal(group(rep, 'child 2').fitted.nights, 1);
    assert.equal(group(rep, 'overall').fitted.nights, 6);
    assert.equal(group(rep, 'overall').unseen.nights, 4);
    assert.equal(group(rep, 'child 2').unseen.fields.wake.within_pct, 0);
    assert.equal(rep.scored_nights, 10);
    // the JSON night list keeps SIGNED minutes and which truths were given
    const n = rep.nights.find((x) => x.child === 1 && x.night === '2026-09-03');
    assert.deepEqual(n.err_min, { in_bed: -11, onset: 16, wake: -12 });
    assert.deepEqual(n.truth_given, { in_bed: true, onset: true, wake: true });
  });

  test('Markdown says how not to read it, carries n, and flags a small set', () => {
    const rep = SB.buildReport(score(K1_CASES), { db: 'x.db', label: 'dev@abc1234', clock: '2026-10-11T08:00:00.000Z', clock_source: '--clock', unseen_after: '2026-10-11T00:00:00.000Z', timezone: 'UTC' });
    const md = SB.renderMarkdown(rep);
    assert.match(md, /not a random sample/);
    assert.match(md, /flatters us/);
    assert.match(md, /Only "unseen" measures progress/);
    assert.match(md, /0 dismissed, 0 "nobody in the bed", 0 with no true time, 0 with no activity data/);
    assert.match(md, /\| overall \| unseen \| 3\* \|/, 'a 3-night set carries its n and a marker');
    assert.match(md, /Fewer than 10 nights: .*overall unseen \(n=3\)/);
    assert.match(md, /dev@abc1234/);
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. the real script on a real database
// ---------------------------------------------------------------------------------------------------

// Names planted in EVERY column the script could plausibly leak (children.name, cameras.name which
// computeNight surfaces as analysis_camera_name, a review's note and its answerer). None may reach output.
const MARK = 'Zq9-marker';
const KID_FIRST = { id: 'zz-created-first', name: `${MARK}-child-one`, created: '2026-01-01 00:00:00', cam: 'sb-cam-1' };
// Its id sorts BEFORE the first child's: a script that ordered by id would swap the labels.
const KID_SECOND = { id: 'aa-created-second', name: `${MARK}-child-two`, created: '2026-02-01 00:00:00', cam: 'sb-cam-2' };
// Inside the night that starts 2026-07-04 19:30 UTC: that night is IN PROGRESS. Child 2 left the bed at
// 02:30, so on the frozen clock only 15 minutes of absence exist (the departure scan needs 20) and the wake
// is blank, while on any later clock (the night long over) the same data gives a wake. A script that did not
// freeze the clock cannot produce the blank. (A first version cut child 2's samples at 03:00 and never got a
// wake on ANY clock: the frozen-clock mutants survived it.)
const CLOCK = '2026-07-05T02:45:00Z';
const LATER_CLOCK = '2026-07-06T00:00:00Z';
const CUTOFF = '2026-07-20 12:00:00';

const T = (date, h, m) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const insertSample = db.prepare(
  `INSERT INTO activity_samples (camera_id, bucket_start, motion_level, motion_peak, sound_level,
     sound_peak, motion_frames, sound_windows) VALUES (?, ?, ?, ?, 0, 0, 1, 0)`
);
const insertTransition = db.prepare(`INSERT INTO bed_transitions (camera_id, type, peak, created_at) VALUES (?, ?, ?, ?)`);
// The shape sleepAnalysis.test.js calls layDepartureNight (a real 2026-08 night): settling 19:30-19:40, two
// awakenings, then out of bed at 05:09 and never back, a parent handling the empty bed from 06:45. With an
// into_bed at 19:31 and the out_of_bed at 05:09 that scores ok with all three times. `until` cuts the
// samples short (the night still in progress); `exit` omits the morning departure; `exitAtMs` puts it
// somewhere else.
function layNight(cam, date, { until = null, exit = true, exitAtMs = null } = {}) {
  const day = 86400000;
  const active = [
    [T(date, 19, 30), T(date, 19, 40)], [T(date, 23, 0), T(date, 23, 6)],
    [T(date, 2, 0) + day, T(date, 2, 8) + day], [T(date, 5, 0) + day, T(date, 5, 9) + day],
    [T(date, 6, 45) + day, T(date, 7, 0) + day],
  ];
  const end = until ?? T(date, 7, 0) + day;
  for (let t = T(date, 18, 20); t < end; t += 60000) {
    const moving = active.some(([a, b]) => t >= a && t < b);
    insertSample.run(cam, sqlTime(t), moving ? 0.4 : 0.0002, moving ? 0.6 : 0.0002);
  }
  insertTransition.run(cam, 'into_bed', 0.5, sqlTime(T(date, 19, 31)));
  if (exitAtMs != null) insertTransition.run(cam, 'out_of_bed', 0.4, sqlTime(exitAtMs));
  else if (exit) insertTransition.run(cam, 'out_of_bed', 0.4, sqlTime(T(date, 5, 9) + day));
}

let fixture; // { snapDir, snap }

describe('scripts/scoreboard.mjs on a real database', () => {
before(() => {
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', 'UTC') ON CONFLICT(id) DO UPDATE SET timezone = 'UTC'`).run();
  for (const k of [KID_FIRST, KID_SECOND]) {
    db.prepare(`INSERT INTO children (id, name, created_at, track_sleep, sleep_window_start, sleep_window_end)
                VALUES (?, ?, ?, 1, '19:30', '07:00')`).run(k.id, k.name, k.created);
    db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
                VALUES (?, ?, 'rtsp://example/x', ?, ?, 0, 0)`).run(k.cam, `${MARK}-cam-${k.id}`, k.id, `p-${k.cam}`);
  }
  // Child 1: three complete nights.
  for (const d of ['2026-07-01', '2026-07-02', '2026-07-03']) layNight(KID_FIRST.cam, d);
  // Child 2: the night in progress at CLOCK (out of the bed at 02:30): wake is NULL on the frozen clock only.
  layNight(KID_SECOND.cam, '2026-07-04', { exitAtMs: Date.UTC(2026, 6, 5, 2, 30) });

  // What the backend itself says for each night: the truth is built from THESE, +/- a chosen offset, so the
  // expected errors are exact whatever the algorithm's numbers are.
  const fresh = Object.fromEntries(['2026-07-01', '2026-07-02', '2026-07-03'].map((d) => [d, computeNight(KID_FIRST.id, d)]));
  for (const d of Object.keys(fresh)) {
    assert.equal(fresh[d].status, 'ok', `fixture night ${d} must score ok (got ${fresh[d].status})`);
    assert.ok(fresh[d].in_bed_at && fresh[d].onset_at && fresh[d].wake_at, `fixture night ${d} must have all three times`);
  }
  const shift = (s, minutes) => sqlTime(Date.parse(`${s.replace(' ', 'T')}Z`) + minutes * 60000);
  const [a, b, c] = ['2026-07-01', '2026-07-02', '2026-07-03'].map((d) => fresh[d]);

  // STORED rows that disagree with the fresh recompute (decoys): a script that read sleep_nights, or the
  // review's computed_* columns, instead of recomputing would get different errors.
  for (const d of Object.keys(fresh)) {
    db.prepare(`INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, in_bed_at, onset_at, wake_at)
                VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-01 01:00:00', 'ok', '2026-01-01 00:01:00', '2026-01-01 00:02:00', '2026-01-01 00:03:00')`).run(KID_FIRST.id, d);
  }
  // Night C's wake truth is a bed transition the parent PICKED (no typed time). It is recorded by a SECOND
  // camera of that child (sort_order 1, so not the one the night is scored from): a row on the scoring
  // camera would itself be evidence and move the wake it is meant to be compared with.
  db.prepare(`INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, disabled)
              VALUES ('sb-cam-1b', ?, 'rtsp://example/y', ?, 'p-sb-cam-1b', 1, 0)`).run(`${MARK}-cam-b`, KID_FIRST.id);
  const tr = insertTransition.run('sb-cam-1b', 'out_of_bed', 0.5, shift(c.wake_at, -10));
  // Night B's in-bed and onset truths are picked transitions too (each column has its own fallback).
  const trIb = insertTransition.run('sb-cam-1b', 'into_bed', 0.5, shift(b.in_bed_at, 3)); // app is 3 min EARLIER
  const trOn = insertTransition.run('sb-cam-1b', 'out_of_bed', 0.5, b.onset_at); // app is exact
  const ins = db.prepare(
    `INSERT INTO sleep_reviews (child_id, night_date, true_in_bed_at, true_onset_at, true_wake_at,
        true_in_bed_transition_id, true_onset_transition_id, true_wake_transition_id,
        computed_onset_at, computed_wake_at, note, dismissed, nobody_in_bed, answered_by_username, reviewed_at)
     VALUES (@child_id, @night_date, @ib, @on, @wk, @ibt, @ont, @wkt, '2026-01-01 00:02:00', '2026-01-01 00:03:00', @note, @dismissed, @nobody, @who, @at)`);
  const row = (o) => ins.run({ ib: null, on: null, wk: null, ibt: null, ont: null, wkt: null, dismissed: 0, nobody: 0, note: `${MARK}-note`, who: `${MARK}-user`, ...o });
  // A: reviewed well before the cutoff. in-bed err +4 (within 10), onset err -20 (outside 15), wake err +8 (within).
  row({ child_id: KID_FIRST.id, night_date: '2026-07-01', at: '2026-07-10 08:00:00', ib: shift(a.in_bed_at, -4), on: shift(a.onset_at, 20), wk: shift(a.wake_at, -8) });
  // B: reviewed EXACTLY at the cutoff -> fitted-to. in-bed err -3 and onset err 0 (both picked transitions),
  //    wake err +90 (over 60).
  row({ child_id: KID_FIRST.id, night_date: '2026-07-02', at: CUTOFF, ibt: trIb.lastInsertRowid, ont: trOn.lastInsertRowid, wk: shift(b.wake_at, -90) });
  // C: reviewed one second after -> unseen. in-bed err -10.1 (outside), onset err +15 (inclusive: within),
  //    wake truth only via the picked transition: err +10 (inclusive: within).
  row({ child_id: KID_FIRST.id, night_date: '2026-07-03', at: '2026-07-20 12:00:01', ib: shift(c.in_bed_at, 10.1), on: shift(c.onset_at, -15), wkt: tr.lastInsertRowid });
  // Child 2: the in-progress night, true wake given -> wake blank. Reviewed after the cutoff -> unseen.
  row({ child_id: KID_SECOND.id, night_date: '2026-07-04', at: '2026-07-25 08:00:00', wk: '2026-07-05 06:00:00' });
  // Excluded rows, each with otherwise valid times so a missing exclusion would score them.
  row({ child_id: KID_FIRST.id, night_date: '2026-06-01', at: '2026-07-10 08:00:00', on: '2026-06-01 20:00:00', wk: '2026-06-02 06:00:00', dismissed: 1 });
  row({ child_id: KID_FIRST.id, night_date: '2026-06-02', at: '2026-07-10 08:00:00', on: '2026-06-02 20:00:00', wk: '2026-06-03 06:00:00', nobody: 1 });
  row({ child_id: KID_FIRST.id, night_date: '2026-06-03', at: '2026-07-10 08:00:00' }); // no true time at all
  row({ child_id: KID_SECOND.id, night_date: '2026-07-01', at: '2026-07-10 08:00:00', on: '2026-07-01 20:00:00', wk: '2026-07-02 06:00:00' }); // no samples: no_data

  // A clean snapshot of the finished database, named like the app's own file in a directory of its own: a
  // script that opened it IN PLACE (DATA_DIR = its directory) would migrate it and write -wal/-shm beside it.
  const snapDir = mkTmp('nightlight-sb-snap-');
  const snap = path.join(snapDir, 'babymonitor.db');
  db.prepare('VACUUM INTO ?').run(snap);
  // Make the snapshot NEED a migration: db.js recreates this index on open, so any run that opens the file
  // in place rewrites it. Without this a finished snapshot is a no-op to open and "never written" is a claim
  // no test can fail (found by mutation: opening it in place survived).
  const raw = new Database(snap);
  raw.pragma('journal_mode = DELETE');
  raw.exec('DROP INDEX idx_bed_transitions_cam_time');
  raw.close();
  fixture = { snapDir, snap, pristine: null };
  fixture.pristine = snapState(snapDir, snap);
});

function run(args, opts = {}) {
  const env = { ...process.env };
  delete env.DATA_DIR; // the script must make its own, never inherit the test suite's
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, ...opts });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
const snapState = (dir, file) => ({
  sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  mtimeMs: fs.statSync(file).mtimeMs,
  listing: fs.readdirSync(dir).sort(),
});

  test('scores the fresh recompute against the review, with the split, exclusions and NULL wake', () => {
    const r = run([fixture.snap, `--clock=${CLOCK}`, `--unseen-after=${CUTOFF.replace(' ', 'T')}Z`, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const rep = JSON.parse(r.stdout);

    // Exclusions: 1 dismissed, 1 nobody_in_bed, 1 no true time, 1 no_data (child 2's 07-01: no samples).
    assert.deepEqual(rep.excluded, { dismissed: 1, nobody_in_bed: 1, no_true_time: 1, unknown_child: 0, no_data: 1 });
    assert.equal(rep.scored_nights, 4);
    assert.equal(rep.timezone, 'UTC');
    assert.equal(rep.clock_source, '--clock');

    const byNight = Object.fromEntries(rep.nights.map((n) => [`${n.child}|${n.night}`, n]));
    // Child labels follow CREATION order (the first-created child's id sorts last).
    const A = byNight['1|2026-07-01'];
    const B = byNight['1|2026-07-02'];
    const C = byNight['1|2026-07-03'];
    const D = byNight['2|2026-07-04'];
    assert.ok(A && B && C && D, JSON.stringify(Object.keys(byNight)));
    // The errors are the chosen offsets: computed - true, signed, minutes.
    assert.deepEqual(A.err_min, { in_bed: 4, onset: -20, wake: 8 });
    assert.deepEqual(B.err_min, { in_bed: -3, onset: 0, wake: 90 }, 'B in-bed and onset truths came from picked transitions');
    assert.deepEqual(C.err_min, { in_bed: -10.1, onset: 15, wake: 10 }, 'C wake truth came from the picked transition');
    // The split: A before, B exactly at the cutoff (fitted-to), C one second after (unseen), D after.
    assert.deepEqual([A.set, B.set, C.set, D.set], ['fitted', 'fitted', 'unseen', 'unseen']);
    // Night in progress: status ok, wake blank, in the NULL count.
    assert.equal(D.status, 'ok');
    assert.equal(D.err_min.wake, null);
    assert.deepEqual(D.truth_given, { in_bed: false, onset: false, wake: true });

    const c1 = rep.groups.find((g) => g.group === 'child 1');
    // fitted (A, B): wake within 1/2 (8 yes, 90 no), onset within 1/2 (0 yes, -20 no), in-bed 2/2 (+4, -3), >60: 1.
    assert.equal(c1.fitted.nights, 2);
    assert.deepEqual([c1.fitted.fields.wake.within, c1.fitted.fields.wake.n_truth], [1, 2]);
    assert.deepEqual([c1.fitted.fields.onset.within, c1.fitted.fields.onset.n_truth], [1, 2]);
    assert.deepEqual([c1.fitted.fields.in_bed.within, c1.fitted.fields.in_bed.n_truth], [2, 2]);
    assert.equal(c1.fitted.wake_over_60, 1);
    assert.equal(c1.fitted.wake_null, 0);
    // unseen (C): onset +15 and wake +10 are exactly ON their thresholds and count as within; in-bed -10.1 does not.
    assert.deepEqual([c1.unseen.fields.wake.within, c1.unseen.fields.wake.n_truth], [1, 1]);
    assert.deepEqual([c1.unseen.fields.onset.within, c1.unseen.fields.onset.n_truth], [1, 1]);
    assert.deepEqual([c1.unseen.fields.in_bed.within, c1.unseen.fields.in_bed.n_truth], [0, 1]);
    const c2 = rep.groups.find((g) => g.group === 'child 2');
    assert.equal(c2.unseen.nights, 1);
    assert.equal(c2.unseen.wake_null, 1, 'the night in progress has no wake yet');
    assert.equal(c2.unseen.fields.wake.within_pct, 0);
    assert.equal(c2.unseen.fields.wake.mean_abs_min, null);
    const all = rep.groups.find((g) => g.group === 'overall');
    assert.equal(all.fitted.nights + all.unseen.nights, 4);
  });

  test('the frozen clock decides what a night in progress shows: blank now, a wake once time has moved on', () => {
    // Non-vacuity for the assertion above: the SAME snapshot at a later clock does give child 2 a wake, so
    // the blank at CLOCK is the clock's doing, not a fixture that never had one.
    const r = run([fixture.snap, `--clock=${LATER_CLOCK}`, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const d = JSON.parse(r.stdout).nights.find((n) => n.child === 2);
    assert.notEqual(d.err_min.wake, null, 'with the night over, the 02:30 departure is confirmed');
  });

  test('read-only: the snapshot\'s bytes, mtime and directory are untouched by every run so far', () => {
    // Compared with the state taken when the fixture was BUILT, not with "just before this run": the tests
    // above have already run the script several times, and a script that opened the file in place would
    // have migrated it on the first of them, leaving this run a no-op to compare against (found by
    // mutation: opening in place survived a before/after taken inside this test).
    const r = run([fixture.snap, `--clock=${CLOCK}`]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(snapState(fixture.snapDir, fixture.snap), fixture.pristine);
    assert.ok(!fixture.pristine.listing.some((f) => /-wal$|-shm$|-journal$/.test(f)), 'fixture starts clean, so a sibling would show');
  });

  test('a -wal beside the snapshot is read too: the newest rows live there', () => {
    const dir = mkTmp('nightlight-sb-wal-');
    const live = path.join(dir, 'live.db');
    fs.copyFileSync(fixture.snap, live);
    const w = new Database(live);
    w.pragma('journal_mode = WAL');
    w.pragma('wal_autocheckpoint = 0'); // keep the change in the -wal, as a running app's newest rows are
    // The parent dismisses night A AFTER the last checkpoint: only the -wal knows.
    w.prepare(`UPDATE sleep_reviews SET dismissed = 1 WHERE child_id = ? AND night_date = '2026-07-01'`).run(KID_FIRST.id);
    // A snapshot taken the way `cp` of a live app's files would: both files, copied while the app has it open.
    const copyDir = mkTmp('nightlight-sb-walcopy-');
    const copy = path.join(copyDir, 'snapshot.db');
    fs.copyFileSync(live, copy);
    fs.copyFileSync(`${live}-wal`, `${copy}-wal`);
    assert.ok(fs.statSync(`${copy}-wal`).size > 0, 'the change is in the -wal and not in the main file');
    w.close();

    const rep = JSON.parse(run([copy, `--clock=${CLOCK}`, '--json']).stdout);
    assert.equal(rep.excluded.dismissed, 2, 'night A now counts as dismissed: the -wal was read');
    assert.equal(rep.scored_nights, 3);
    const main = JSON.parse(run([fixture.snap, `--clock=${CLOCK}`, '--json']).stdout);
    assert.equal(main.excluded.dismissed, 1, 'control: the same snapshot without the -wal change');
  });

  test('the clock defaults to the snapshot file\'s modification time', () => {
    // On a COPY: touching the shared fixture would change the read-only test's subject.
    const dir = mkTmp('nightlight-sb-mtime-');
    const copy = path.join(dir, 'snapshot.db');
    fs.copyFileSync(fixture.snap, copy);
    const when = new Date(CLOCK);
    fs.utimesSync(copy, when, when);
    const r = run([copy, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.clock, new Date(CLOCK).toISOString());
    assert.equal(rep.clock_source, 'snapshot file modification time');
    // and with that clock the night in progress is the same one as under --clock
    assert.equal(rep.nights.find((n) => n.child === 2).err_min.wake, null);
  });

  test('no name from the database reaches either output format', () => {
    for (const args of [[], ['--json']]) {
      const r = run([fixture.snap, `--clock=${CLOCK}`, ...args]);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.length > 200, 'there is output to check');
      assert.ok(!r.stdout.includes(MARK), `a planted marker leaked: ${r.stdout.slice(0, 400)}`);
      assert.ok(!r.stderr.includes(MARK));
      assert.ok(!/zz-created-first|aa-created-second|sb-cam/.test(r.stdout), 'no child or camera id either');
    }
    const md = run([fixture.snap, `--clock=${CLOCK}`]).stdout;
    assert.match(md, /\| child 1 \|/);
    assert.match(md, /\| child 2 \|/);
  });

  test('--out writes the file instead of stdout, and is refused inside the repository', () => {
    const outDir = mkTmp('nightlight-sb-out-');
    const dest = path.join(outDir, 'ledger.md');
    const ok = run([fixture.snap, `--clock=${CLOCK}`, `--out=${dest}`]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, '');
    assert.match(fs.readFileSync(dest, 'utf8'), /Sleep accuracy scoreboard/);

    const repoFile = path.join(path.dirname(SCRIPT), 'scoreboard-should-not-exist.md');
    fs.rmSync(repoFile, { force: true });
    try {
      const bad = run([fixture.snap, `--clock=${CLOCK}`, `--out=${repoFile}`]);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /inside the repository/);
      assert.equal(fs.existsSync(repoFile), false, 'nothing was written into the repo');
    } finally {
      // If the guard ever fails, do not leave a stray file in the working tree to poison the next run.
      fs.rmSync(repoFile, { force: true });
    }
  });

  test('usage errors exit 2 with no output on stdout', () => {
    for (const args of [[], [fixture.snap, '--nope'], [path.join(fixture.snapDir, 'missing.db')]]) {
      const r = run(args);
      assert.notEqual(r.code, 0);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.length > 0);
    }
  });

  test('--backend scores THAT tree\'s computeNight (the old-vs-new comparison)', () => {
    // A fake backend whose computeNight answers a constant: if --backend were ignored the numbers would be the
    // real tree's and the single review here would not score +7.
    const tree = mkTmp('nightlight-sb-fake-');
    const lib = path.join(tree, 'backend', 'src', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(path.join(tree, 'backend', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'backend', 'package.json'), '{"type":"module"}\n');
    fs.writeFileSync(path.join(lib, 'sleepAnalysis.js'),
      "export function computeNight() { return { status: 'ok', in_bed_at: null, onset_at: null, wake_at: '2026-07-02 06:07:00' }; }\n");
    fs.writeFileSync(path.join(tree, 'backend', 'src', 'db.js'), [
      'const rows = {',
      "  children: [{ id: 'fake-kid' }],",
      "  settings: { timezone: 'Fake/Zone' },",
      "  reviews: [{ child_id: 'fake-kid', night_date: '2026-07-01', dismissed: 0, nobody_in_bed: 0, reviewed_at: '2026-07-10 08:00:00', true_in_bed_at: null, true_onset_at: null, true_wake_at: '2026-07-02 06:00:00' }],",
      '};',
      'export default {',
      '  prepare(sql) {',
      '    return {',
      "      all: () => (/FROM children/.test(sql) ? rows.children : /sleep_reviews/.test(sql) ? rows.reviews : []),",
      '      get: () => rows.settings,',
      '    };',
      '  },',
      '  close() {},',
      '};',
      '',
    ].join('\n'));
    const r = run([fixture.snap, `--clock=${CLOCK}`, '--json', `--backend=${path.join(tree, 'backend')}`]);
    assert.equal(r.code, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.timezone, 'Fake/Zone');
    assert.deepEqual(rep.nights.map((n) => n.err_min.wake), [7]);

    const missing = run([fixture.snap, `--clock=${CLOCK}`, `--backend=${path.join(tree, 'nope')}`]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not a nightlight backend/);
  });
});
