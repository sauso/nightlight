// Tests for the sound ambient-baseline state machine (src/lib/soundBaseline.js).
//
// ★ WHY THESE EXIST: this logic was a closure inside `startSoundDetector`, so it had ZERO tests and
// was not in the `test:core` coverage include list — the one file on the sleep path the gate did not
// watch, while `sleepAnalysis.js` downstream sat at 99.5%. A verified production defect (the ambient
// floor freezing for 7.9 unbroken hours, inflating awake time) lived there for months.
//
// ⚠️ THE TESTS I FIRST PLANNED DID NOT DISCRIMINATE, and that is recorded here so it isn't repeated:
//   * "step +9 dB, assert the excursion decays toward zero" passes for a fix and fails for a DIFFERENT
//     correct fix (a percentile floor does not move until the window turns over) — it tests a
//     particular implementation, not the property.
//   * "a 30 s cry must not be absorbed" is passed by EVERY mutant that was on the table.
// So the assertions below are built to pin the BOUNDARY rather than the direction: where exactly the
// freeze starts, and exactly how many milliseconds later it ends. A constant mutated by one reading
// has to fail.
//
// No database, no ffmpeg, no timers: the analyser takes `now` as an argument, so a 12-minute night
// replays in milliseconds.
//
// ★ MUTATION RESULTS, 2026-09-02: 41 mutants run across two sweeps, 39 killed, no-op control survived.
// The two that survive are judged EQUIVALENT, written down so the next person does not re-derive them:
//   * the dead-band ESCAPE using the trailing mean rather than the instantaneous reading. The branch is
//     only reachable after five minutes of sustained elevation, where the two expressions are equal to
//     within the signal's own variance and converge to the same floor. The same mutation in the
//     below-band branch, where it does matter, IS killed.
//   * the staleness reset not clearing `loudSince`. It also clears `recent`, so the first reading back
//     cannot be `confirmed` and necessarily takes the `else` branch, which zeroes `loudSince` anyway.
//     The line is kept as defence in depth: it stops being redundant the moment anyone touches the
//     window reset beside it.
//
// ★ #453 (digital silence), 2026-10-02: `#453 M1`-`M14` in scripts/mutants.json, all killed (the analyser
// ones by this file alone, `--test-name-pattern "#453"`). Two of them — silence resetting `loudSince`, and
// silence resetting `frozenSince` — are killed ONLY by the at-ambient equivalence test below, so a change
// that weakens that test's fixture (fewer silent windows above the margin or inside the dead band) has to
// re-run them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSoundAnalyser,
  marginDb,
  BASELINE_ALPHA,
  REBASELINE_MS,
  DEAD_BAND_MAX_MS,
  SEED_WINDOWS,
} from '../src/lib/soundBaseline.js';

// One loudness window is 1600 samples at 8 kHz = 200 ms (soundDetector.js's WIN_SAMPLES / WIN_RATE).
const READING_MS = 200;
// A realistic epoch, NOT 0. `lastAlert` initialises to 0, so with a clock starting at 0 the very first
// reading would satisfy `now - lastAlert >= cooldownMs` only by accident of the epoch — a test that
// started at 0 would silently exercise a state the real detector never sees.
const T0 = Date.UTC(2026, 8, 2, 20, 0, 0);

// The shipped defaults: sound_sensitivity 50, sound_confirm_s 4, sound_cooldown_s 120.
const MARGIN = marginDb(50); // 11.0707…
const TRAIL_N = 20; // 4 s confirm / 200 ms
const COOLDOWN_MS = 120000;

const QUIET = -60; // a plausible quiet-bedroom RMS in dBFS

const analyser = (over = {}) =>
  createSoundAnalyser({ margin: MARGIN, trailN: TRAIL_N, cooldownMs: COOLDOWN_MS, ...over });

const rep = (n, v) => Array.from({ length: n }, () => v);
const secs = (s) => Math.round((s * 1000) / READING_MS);

/** Push a level sequence through the analyser at one reading per 200 ms; return every result + its t. */
function drive(a, levels, startT = T0) {
  const out = [];
  let t = startT;
  for (const lvl of levels) {
    out.push({ t, ...a.push(lvl, t) });
    t += READING_MS;
  }
  return out;
}

// Where every "settled analyser" fixture hands over to the sequence under test.
const START = T0 + 60000;

/**
 * An analyser that has seeded and settled on a QUIET room, handing over CONTIGUOUSLY at `START`.
 *
 * ⚠️ The contiguity is load-bearing, not tidiness. This helper used to stop at T0+34.8 s while every
 * caller began at T0+60 s, leaving a 25 s hole between them — harmless until the analyser learned to
 * recognise a hole in the stream, at which point four fixtures silently began each test by throwing
 * away the trailing window they were about to measure. Real audio has no such hole, so a fixture with
 * one is not testing the code that runs.
 */
function settled() {
  const a = analyser();
  drive(a, rep((START - T0) / READING_MS, QUIET));
  return a;
}

/** Index of the first reading at or after `from` whose baseline differs from the one before it. */
function firstMove(rows, from) {
  for (let i = Math.max(1, from); i < rows.length; i++) {
    if (rows[i].baseline !== rows[i - 1].baseline) return i;
  }
  return -1;
}

/** Index of the first reading at or after `from` whose baseline is UNCHANGED from the one before it. */
function firstHold(rows, from) {
  for (let i = Math.max(1, from); i < rows.length; i++) {
    if (rows[i].baseline === rows[i - 1].baseline) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------------------------

test('reports nothing until it has SEED_WINDOWS readings, then seeds from their MEDIAN', () => {
  const a = analyser();
  // ⚠️ THREE distinct levels, not two. My first fixture put 5 of 25 windows at cry level and the rest
  // at the floor — which the median passes, but so does p25, p75, the min, and every other order
  // statistic from index 0 to 19, because they all land on the same value. It discriminated
  // median-from-mean and nothing else. Here 8 low / 9 middle / 8 high means the median (index 12) is
  // the ONLY statistic that returns QUIET: p25 lands on -70, p75 on -20, min on -70.
  assert.equal(SEED_WINDOWS, 25, 'the fixture below is hand-sized to this and does not track it');
  const levels = [...rep(8, -70), ...rep(9, QUIET), ...rep(8, -20)];
  assert.equal(levels.length, 25);

  const rows = drive(a, levels);
  for (let i = 0; i < SEED_WINDOWS - 1; i++) {
    assert.equal(rows[i].baseline, null, `still seeding at reading ${i}`);
    assert.equal(rows[i].recordDb, null, 'nothing is recorded to the activity timeline while seeding');
  }
  assert.equal(rows[SEED_WINDOWS - 1].baseline, QUIET, 'seeded at the median, not the mean');
  // The seeding reading itself scores nothing — there is no baseline yet to score it against.
  assert.equal(rows[SEED_WINDOWS - 1].recordDb, null);

  // The `baseline` accessor is what the detector's 15-second level line prints, and that log is the
  // ONLY evidence the 7.9-hour freeze ever existed — it is production diagnostics, not a test hook.
  assert.equal(a.baseline, QUIET);
  assert.equal(analyser().baseline, null, 'and it reads null before the analyser has seeded');
});

test('KNOWN LIMIT: a stream that is loud for MOST of the seed still seeds high', () => {
  // The median protects against a few loud windows, not against a continuously loud stream. If the
  // detector comes up in the middle of a long cry, more than half the seed is the cry and the floor
  // is set at cry level — the exact failure the seeding change is aimed at, merely made much less
  // likely. Written down here because the commit message for that change overstated it, and because
  // silence about a limit is the thing this repo's rules forbid. Bounded ONLY BY A REAL QUIET FLOOR: the
  // EMA drags the floor back down once the room quietens to a measurable, non-zero level, which is why
  // it is a limit and not a defect. ⚠️ Digital silence (an all-zero window) does NOT drag it down: since
  // #453 a silent window is a reading AT the ambient, whose tracking step is exactly zero, so silence never
  // lowers the floor (it can still RAISE it, through the ordinary 45 s absorb of a sound that was loud just
  // before: see "#453 R11/R18"). See the #453 KNOWN LIMIT test below for the silent-room version of this limit.
  const a = analyser();
  const rows = drive(a, [...rep(15, -20), ...rep(10, QUIET)]);
  assert.equal(rows[SEED_WINDOWS - 1].baseline, -20);
});

// ---------------------------------------------------------------------------------------------
// #453: digital silence is an OBSERVATION — a reading at the ambient, not a missing reading
// ---------------------------------------------------------------------------------------------
// An all-zero 200 ms window has rms 0, so its level is -Infinity. Before #453 the detector threw such a
// window away before it reached this analyser, and the analyser's own guard dropped it too. That made a
// muted or gated microphone look like no microphone at all (no per-minute sound row, a "no microphone?"
// strike on a quick exit), and — the part that decided the design — it made silence INVISIBLE to the
// trailing confirm window, so separate sounds with silence between them read as one continuous loud run
// and could alert (the C1a repro below, demonstrated on dev e9e5d83 before the fix).
// The design (plan v2): a silent window, once there is an ambient, runs the normal path as a reading
// EXACTLY AT the ambient. Rejected, so nobody re-proposes them: a floor value (-90.3 dBFS) fed into the
// baseline (a silent night drags the ambient to the floor and the next ordinary household noise reads
// +30 dB), and "silence touches nothing" (fixes the counters, keeps the pulse alert). No constant here was
// added or changed.

test('#453 C1: while seeding, silence records 0 (heard, nothing above ambient) and never joins the seed', () => {
  const a = analyser();
  const rows = drive(a, [...rep(SEED_WINDOWS, -Infinity), ...rep(SEED_WINDOWS, QUIET)]);
  for (let i = 0; i < SEED_WINDOWS; i++) {
    // If -Infinity counted toward the seed the baseline would exist (and be -Infinity) by reading 25.
    assert.equal(rows[i].baseline, null, `silence is not evidence of the ambient (reading ${i})`);
    assert.equal(rows[i].recordDb, 0, `a silent window is a quiet observation, recorded as 0 (reading ${i})`);
    assert.equal(rows[i].silent, true);
    assert.equal(rows[i].over, null, 'no ambient yet, so no trailing average to report');
    assert.equal(rows[i].confirmed, false);
    assert.equal(rows[i].wouldAlert, false);
  }
  // The seed is 25 AUDIBLE readings: the first 24 of them still report nothing at all.
  for (let i = SEED_WINDOWS; i < 2 * SEED_WINDOWS - 1; i++) {
    assert.equal(rows[i].baseline, null, `still seeding at reading ${i}`);
    assert.equal(rows[i].recordDb, null, 'an audible window records nothing until there is an ambient (the documented asymmetry)');
    assert.equal(rows[i].silent, false);
  }
  assert.equal(rows[2 * SEED_WINDOWS - 1].baseline, QUIET, 'seeded on the 25th audible reading');
});

test('#453 C1: a silent window inside a partly-filled seed neither joins it nor clears it', () => {
  // 10 audible, one silent, 15 audible = 25 audible readings: seeded on the 26th push and not one sooner
  // (silence joined the seed: seeded on the 25th push) or later (silence cleared it: 15 short at the end).
  const a = analyser();
  const rows = drive(a, [...rep(10, -70), -Infinity, ...rep(SEED_WINDOWS - 10, QUIET)]);
  for (let i = 0; i < SEED_WINDOWS; i++) assert.equal(rows[i].baseline, null, `still seeding at reading ${i}`);
  assert.equal(rows[10].recordDb, 0, 'the silent window itself is recorded as quiet');
  // The median of 10 x -70 and 15 x -60 is -60.
  assert.equal(rows[SEED_WINDOWS].baseline, QUIET, 'seeded on exactly the 25th audible reading');
});

test('#453 C1: silence longer than the trailing window, in the middle of the seed, is a hole like an outage', () => {
  // While there is no ambient a silent window does not advance the stream clock (it is not part of the
  // seed, so it is not part of the contiguous 5 s the seed is meant to be). A long silence mid-seed is
  // therefore treated as the staleness rule treats an outage: the partial seed is dropped and the seed
  // restarts from the next audible reading. Identical to dev, where the silence never reached the analyser.
  const a = analyser();
  const first = drive(a, rep(10, -70));
  const quiet = drive(a, rep(secs(10), -Infinity), first[first.length - 1].t + READING_MS);
  const rest = drive(a, rep(SEED_WINDOWS, QUIET), quiet[quiet.length - 1].t + READING_MS);
  assert.equal(rest[SEED_WINDOWS - 2].baseline, null, 'the 10 readings before the silence were dropped');
  assert.equal(rest[SEED_WINDOWS - 1].baseline, QUIET, 'and the seed is 25 fresh readings');
});

test('#453 C1: a silent window on a settled analyser is EXACTLY a reading at the ambient', () => {
  // A full, quiet trailing window (20 x -60 against a -60 floor), then one silent window, contiguously.
  // The window it joins is still all ambient, so `over` is exactly 0 and the window stays confirmed.
  const a = settled();
  const r = a.push(-Infinity, START);
  assert.deepEqual(r, { baseline: QUIET, over: 0, confirmed: true, recordDb: 0, wouldAlert: false, silent: true });
  assert.equal(a.baseline, QUIET, 'a reading at the ambient moves nothing: the EMA step is exactly zero');
  // An audible reading reports `silent: false`, so a caller can always tell the two apart.
  assert.equal(a.push(QUIET, START + READING_MS).silent, false);
});

test('#453: a silent window is indistinguishable from a reading AT THE CURRENT AMBIENT, across alerts, the absorb and the dead-band escape', () => {
  // The design claim itself, checked as an equivalence rather than by example: two analysers, same
  // history, one given -Infinity and the other given its own `baseline` at that moment. Every field of
  // every result must agree except `silent`. The fixture visits every rule a silent window could reach:
  // an alert and its cooldown, the 45 s absorb, the dead band and its 5-minute escape, sparse pulses, a
  // long silence and a cry after it. Any special-casing of silence beyond "rms = baseline" shows up here
  // as a field that differs: resetting loudSince / frozenSince / the trailing window, consuming the
  // cooldown, a floor value, a stale `over`.
  const S = null; // a silent window
  const every = (n, k, lvl) => Array.from({ length: n }, (_, i) => (i % k === k - 1 ? S : lvl));
  const DEAD_BAND_END = secs(70) + secs(180) + secs(6 * 60) - 1; // the last reading of the dead-band phase
  const seq = [
    ...every(secs(70), 8, QUIET + 15), //  above the margin, silence every 8th: alerts, then absorbed at 45 s
    ...every(secs(180), 6, QUIET), //      back to quiet: the EMA tracks the floor down again
    ...every(secs(6 * 60), 25, QUIET + 9), // the dead band, silence every 25th: frozen, escapes at 5 min
    ...rep(secs(2 * 60), QUIET + 9),
    ...Array.from({ length: secs(80) }, (_, i) => (i % 10 === 0 ? QUIET + 15 : S)), // sparse pulses, silence between
    ...rep(secs(10 * 60), S), //           ten minutes of silence
    ...every(secs(40), 12, QUIET + 30), // a cry with dropouts
  ];
  const a = settled();
  const b = settled();
  let t = START;
  const seen = { alerts: 0, silentAboveMargin: 0, silentInBand: 0, absorbs: 0 };
  for (const [i, lvl] of seq.entries()) {
    const before = a.baseline;
    const ra = a.push(lvl === S ? -Infinity : lvl, t);
    const rb = b.push(lvl === S ? b.baseline : lvl, t);
    const { silent: sa, ...fa } = ra;
    const { silent: sb, ...fb } = rb;
    assert.deepEqual(fa, fb, `reading ${i} (${lvl === S ? 'silent' : lvl}): the silent analyser diverged from the at-ambient one`);
    assert.equal(sa, lvl === S, `reading ${i}: silent flag`);
    assert.equal(sb, false);
    if (lvl === S && ra.confirmed && ra.over >= MARGIN) seen.silentAboveMargin++;
    if (lvl === S && ra.confirmed && ra.over >= MARGIN * 0.5 && ra.over < MARGIN) seen.silentInBand++;
    if (ra.baseline - before > 1) seen.absorbs++;
    if (ra.wouldAlert) {
      seen.alerts++;
      a.markAlerted(t);
      b.markAlerted(t);
    }
    // The dead-band escape really ran: the pre-freeze leak alone lifts the floor only ~1.2 dB (the 4-minute
    // test above), so a floor more than 5 dB up after 6 minutes of +9 has been tracking again.
    if (i === DEAD_BAND_END) assert.ok(a.baseline > QUIET + 5, `the dead band never escaped (floor ${a.baseline})`);
    t += READING_MS;
  }
  // Not vacuous: the fixture really reached each rule WITH silent windows inside it.
  assert.ok(seen.alerts >= 2, `alerts: ${seen.alerts}`);
  assert.ok(seen.absorbs >= 1, 'the 45 s absorb never ran');
  assert.ok(seen.silentAboveMargin > 5, `silent windows above the margin: ${seen.silentAboveMargin}`);
  assert.ok(seen.silentInBand > 5, `silent windows inside the dead band: ${seen.silentInBand}`);
});

// ---------------------------------------------------------------------------------------------
// #453 fix round 1: the equivalence above, made to bite
// ---------------------------------------------------------------------------------------------
// ⚠️ FOUND BY THE CODE REVIEW (Opus, 2026-10-02) AS SURVIVING MUTANTS: the fixture above visits every rule,
// but never at the moments where silence alone decides a branch, so seven mutants that special-case silence
// survived the whole 2,085-test suite: the staleness reset skipped for silence (R9, the 2026-09-02 defect
// re-opened through silence after an ordinary ffmpeg restart), silence not resetting `loudSince` (R5) or
// `frozenSince` (R13), not starting `loudSince` (R14), never absorbing (R11), keeping the trailing window
// across an absorb (R18), never alerting (R12). The crafted cases below are the review's own distinguishing
// inputs (re-derived here); the seeded differential after them is the general net.

const SEEDING_SILENT = { baseline: null, over: null, confirmed: false, recordDb: 0, wouldAlert: false, silent: true };
const RESULT_FIELDS = ['baseline', 'over', 'confirmed', 'recordDb', 'wouldAlert'];

/**
 * Drive two analysers through one history: `a` hears -Infinity for every silent window (`null`), `b` hears
 * its own current baseline. Every field but `silent` must agree on every reading (while `b` is still seeding
 * there is no ambient to stand in for, so a silent window must instead be exactly "no reading" for the state:
 * `b` is not pushed and `a` must return SEEDING_SILENT). Returns `a`'s rows. `gaps[i]` adds ms before reading i.
 */
function silentVsAmbient(levels, { opts = {}, gaps = {}, start = T0 } = {}) {
  const a = analyser(opts);
  const b = analyser(opts);
  let t = start;
  return levels.map((lvl, i) => {
    t += gaps[i] ?? 0;
    const silent = lvl === null;
    let ra;
    if (silent && b.baseline === null) {
      ra = a.push(-Infinity, t);
      assert.deepEqual(ra, SEEDING_SILENT, `reading ${i}: a silent window while seeding`);
    } else {
      ra = a.push(silent ? -Infinity : lvl, t);
      const rb = b.push(silent ? b.baseline : lvl, t);
      for (const f of RESULT_FIELDS) {
        assert.ok(Object.is(ra[f], rb[f]), `reading ${i} (${silent ? 'silent' : lvl}) ${f}: silent analyser ${ra[f]}, at-ambient ${rb[f]}`);
      }
      assert.equal(ra.silent, silent);
    }
    const row = { i, t, lvl, ...ra };
    t += READING_MS;
    return row;
  });
}
const isStep = (rows, i) => i > 0 && rows[i].baseline - rows[i - 1].baseline > 1; // an absorb, never an EMA step

test('#453 R9: digital silence as the FIRST window after an outage still drops the stale trailing window', () => {
  // The 2026-09-02 staleness defect (see `staleMs` in the source), arriving through silence: 20 s of a cry
  // above the margin, a 30 s hole in the stream (the routine ffmpeg restart), then the room is digitally
  // silent. The silent window must clear the stale window exactly as an audible one does. With the reset
  // skipped for silence, that first silent window read ~13 dB over against the stale cry, and the cry was
  // absorbed a few readings later (the floor jumped to ~-45.7 in a silent room).
  const levels = [...rep((START - T0) / READING_MS, QUIET), ...rep(secs(20), QUIET + 15), ...rep(secs(10), null)];
  const back = (START - T0) / READING_MS + secs(20); // the first reading after the hole
  const rows = silentVsAmbient(levels, { gaps: { [back]: 30000 } });
  const floor = rows[back - 1].baseline;
  assert.equal(rows[back].confirmed, false, 'the stale window must be discarded, not reused');
  assert.equal(rows[back].over, 0, 'a silent window alone in a fresh window is exactly at the ambient');
  for (let i = back; i < rows.length; i++) assert.equal(rows[i].baseline, floor, `the floor moved at reading ${i}`);
});

test('#453 R5: a silent window that drops the trailing average below the margin restarts the 45 s absorb clock', () => {
  // A source just over the margin with a silent window every 4 s, each followed by a louder one. The first
  // silent window lands one reading after the average first crosses the margin and dips it back under; the
  // loud window after it lifts it straight back over. That dip restarts `loudSince`, as a quiet reading does,
  // so the absorb comes exactly 45 s after the SECOND crossing (49.2 s in); with silence keeping `loudSince`
  // it came 45 s after the first (48.8 s in: floor -47.7 at that reading instead of -58.8).
  const cycle = [null, QUIET + 23.3, ...rep(18, QUIET + 12.3)];
  const levels = [...rep((START - T0) / READING_MS, QUIET), ...rep(20, QUIET + 12.3), ...Array.from({ length: 20 }, () => cycle).flat()];
  const rows = silentVsAmbient(levels);
  let runStart = null;
  let absorbs = 0;
  let silentDips = 0;
  rows.forEach((r, i) => {
    if (r.t < START) return;
    if (isStep(rows, i)) {
      absorbs++;
      assert.equal(r.t - runStart, 45000, `absorbed ${r.t - runStart} ms after the current above-margin run began`);
      runStart = null;
      return;
    }
    if (r.confirmed && r.over >= MARGIN) runStart ??= r.t;
    else {
      if (r.lvl === null && runStart !== null) silentDips++;
      runStart = null;
    }
  });
  assert.equal(absorbs, 1, 'the fixture must reach an absorb');
  assert.ok(silentDips >= 1, `silent windows that interrupted an above-margin run: ${silentDips}`);
  assert.ok(Math.abs(rows.find((r) => r.t - START >= 48800).baseline - (QUIET + 1.18)) < 0.1, 'not yet absorbed at 48.8 s');
});

test('#453 R13: a silent window that drops the average below half the margin restarts the dead-band freeze clock', () => {
  // A source in the dead band (+6.7 over a floor that froze at ~-58.8) where every silent window dips the
  // trailing average below half the margin and the louder window after it lifts it straight back. Each dip
  // is a below-band reading, which spends the freeze clock exactly as a quiet reading AT the ambient would
  // (its EMA step is zero), so the 5-minute escape never comes: the floor holds for the whole 8.6 minutes.
  // With silence keeping `frozenSince`, the escape came 302.6 s in.
  // ⚠️ STATED, NOT HIDDEN (KNOWN-ISSUES.md, #453 limits): this is the one shape where silence holds the
  // freeze that the 2026-09-02 escape exists to end. dev e9e5d83, where silence was invisible, learned this
  // source (floor -52.9). It needs EVERY silent window to be followed at once by a louder one (a steadier
  // source after a silent dip makes audible below-band readings, which move the floor and escape normally).
  const cycle = [null, QUIET + 14.7, ...rep(17, QUIET + 6.7)];
  const levels = [...rep((START - T0) / READING_MS, QUIET), ...rep(20, QUIET + 10)];
  while (levels.length < (START - T0) / READING_MS + 20 + secs(8.6 * 60)) levels.push(...cycle);
  const rows = silentVsAmbient(levels);
  const from = (START - T0) / READING_MS + 20;
  const held = rows[from].baseline;
  for (let i = from; i < rows.length; i++) assert.equal(rows[i].baseline, held, `the floor moved at reading ${i}`);
  const dips = rows.slice(from).filter((r) => r.lvl === null && r.over < MARGIN * 0.5).length;
  assert.ok(dips > 100, `silent windows below half the margin: ${dips}`);
  assert.ok(rows.slice(from).every((r) => r.lvl === null || (r.over >= MARGIN * 0.5 && r.over < MARGIN)), 'every audible reading is in the band');
});

test('#453 R15: a silent window that lifts the average over the margin starts the dead-band freeze clock', () => {
  // The rarest shape: silence RAISES the trailing average when the reading it pushes out sat below the
  // floor. Sensitivity 100 (margin 4 dB) and the minimum 3-window average make it reachable: a quiet dip,
  // two loud readings, then a silent window whose average (5.3) crosses the margin from 1.4. The freeze clock
  // starts on THAT reading, as it would on a reading at the ambient, so the escape lands exactly 5 minutes
  // after it (with silence not starting the clock, one reading later).
  const opts = { margin: marginDb(100), trailN: 3 };
  const levels = [...rep((START - T0) / READING_MS, QUIET), QUIET - 12, QUIET + 8, QUIET + 8, null, ...rep(2000, QUIET + 3.5)];
  const rows = silentVsAmbient(levels, { opts });
  const s = (START - T0) / READING_MS + 3;
  assert.equal(rows[s].lvl, null);
  assert.ok(rows[s - 1].over < 2 && rows[s].confirmed && rows[s].over >= 4, `the silent window crosses the margin: ${rows[s - 1].over} -> ${rows[s].over}`);
  const move = rows.findIndex((r, i) => i > s && r.baseline !== rows[i - 1].baseline);
  assert.ok(rows.slice(s + 1, move).every((r) => r.over >= 2 && r.over < 4), 'held in the band until the escape');
  assert.equal(rows[move].t - rows[s].t, DEAD_BAND_MAX_MS, 'the escape counts from the silent window');
});

test('#453 R11/R18: the 45 s absorb can land on a silent window, and empties the trailing window as any absorb does', () => {
  // A +30 cry for 46 s, then silence: for a few readings the trailing average still holds the cry, and the
  // absorb falls due 0.6 s into the silence. It must fire there (as on a reading at the ambient) and empty
  // the window. Consequence, documented in KNOWN-ISSUES.md: the floor is now the cry's level, so a +20 cry
  // after the silence is NOT alerted. dev e9e5d83 alerted it: there the silence was a hole longer than the
  // trailing window, the staleness reset dropped the 44.4 s run, and nothing was absorbed.
  const cryStart = (START - T0) / READING_MS;
  const levels = [...rep(cryStart, QUIET), ...rep(secs(46), QUIET + 30), ...rep(secs(10), null), ...rep(secs(30), QUIET + 20)];
  const rows = silentVsAmbient(levels);
  const absorbAt = rows.findIndex((r, i) => isStep(rows, i));
  assert.equal(rows[absorbAt].lvl, null, 'the absorb lands on a silent window');
  assert.equal(rows[absorbAt].t - rows[cryStart + secs(46)].t, 600, '0.6 s into the silence');
  assert.ok(rows[absorbAt].baseline > QUIET + 20, `the floor jumped to the cry: ${rows[absorbAt].baseline}`);
  assert.equal(rows[absorbAt + 1].confirmed, false, 'the trailing window was emptied');
  assert.equal(rows[absorbAt + 1].over, 0);
  assert.equal(rows.slice(cryStart + secs(56)).filter((r) => r.wouldAlert).length, 0, 'the later +20 cry is under the new floor');
});

test('#453 R12: the alert can fire ON a silent window', () => {
  // A +15 source with every 5th window silent and no alert sent yet (no cooldown running): the trailing
  // average first reaches the margin on a silent window, and that window is alert-eligible, as a reading at
  // the ambient would be. With silence never alerting, the alert came one window later.
  const levels = [...rep((START - T0) / READING_MS, QUIET), ...Array.from({ length: 800 }, (_, i) => (i % 5 === 4 ? null : QUIET + 15))];
  const rows = silentVsAmbient(levels);
  const first = rows.findIndex((r) => r.wouldAlert);
  assert.equal(rows[first].lvl, null, 'the first alert-eligible reading is a silent window');
  assert.ok(rows[first - 1].over < MARGIN && rows[first].over >= MARGIN);
});

// A small, fast, deterministic PRNG (mulberry32), so the differential below is the same run every time and a
// failure names the seed that reproduces it.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One random stream through two analysers, as in `silentVsAmbient` but generated, with random settings
 * (margin, confirm window, cooldown), random holes in the stream (mostly longer than the trailing window,
 * some shorter, some backward clock steps), alerts marked sent or suppressed at random (quiet hours), and
 * silent windows deliberately placed where silence alone can decide a branch: the first window after a hole,
 * the reading the average crosses the margin on, the seconds around a due absorb, and a louder window straight
 * after a silent one. Returns null, or what diverged.
 */
function differentialStream(seed, reach) {
  const rnd = mulberry32(seed);
  const between = (lo, hi) => lo + rnd() * (hi - lo);
  const chance = (p) => rnd() < p;
  const confirmS = chance(0.5) ? 4 : Math.floor(between(0, 31)); // the Sound confirm setting, 0-30 s
  const trailN = Math.max(3, Math.round((confirmS * 1000) / READING_MS)); // as soundDetector.js derives it
  const margin = marginDb(chance(0.4) ? 50 : 1 + Math.floor(rnd() * 100));
  const cooldownMs = 1000 * (chance(0.5) ? 120 : 1 + Math.floor(rnd() * 600));
  const staleMs = trailN * READING_MS;
  const opts = { margin, trailN, cooldownMs };
  const a = createSoundAnalyser(opts);
  const b = createSoundAnalyser(opts);
  let t = T0 + Math.floor(rnd() * 86_400_000);
  const floor = between(-75, -35);
  const total = 400 + Math.floor(rnd() * (chance(0.15) ? 3000 : 1200));
  let n = 0;
  let loudFrom = null;
  let prev = null;
  let afterHole = false;
  let lastSilent = false;
  const where = () => `seed ${seed}, reading ${n}, ${JSON.stringify(opts)}`;

  function step(level) {
    const silent = level === null;
    if (silent && b.baseline === null) {
      const ra = a.push(-Infinity, t);
      for (const f of RESULT_FIELDS) if (!Object.is(ra[f], SEEDING_SILENT[f])) return `${where()}: seeding silent ${f} ${ra[f]}`;
      return a.baseline === null ? null : `${where()}: silence seeded the ambient`;
    }
    const before = b.baseline;
    const ra = a.push(silent ? -Infinity : level, t);
    const rb = b.push(silent ? b.baseline : level, t);
    for (const f of RESULT_FIELDS) {
      if (!Object.is(ra[f], rb[f])) return `${where()} (${silent ? 'silent' : level}): ${f} silent analyser ${ra[f]}, at-ambient ${rb[f]}`;
    }
    if (ra.silent !== silent) return `${where()}: silent flag`;
    const absorbed = before !== null && rb.baseline - before > 0.5 && rb.over >= margin;
    if (silent) {
      if (rb.confirmed && rb.over >= margin) reach.silentAboveMargin++;
      if (absorbed) reach.silentAbsorbs++;
      if (rb.wouldAlert) reach.silentAlerts++;
      if (afterHole) reach.silentAfterHole++;
    }
    if (absorbed) loudFrom = null;
    else if (rb.confirmed && rb.over >= margin) loudFrom ??= t;
    else loudFrom = null;
    if (rb.wouldAlert && chance(0.7)) {
      // The caller marks an alert only when one really went out: both analysers, or neither.
      a.markAlerted(t);
      b.markAlerted(t);
    }
    prev = rb;
    return null;
  }

  function target(level) {
    if (afterHole && chance(0.6)) return null;
    if (prev && prev.confirmed && prev.over >= margin * 0.9 && loudFrom === null && chance(0.4)) return null;
    if (loudFrom !== null && t - loudFrom >= 43_000 && t - loudFrom <= 47_000 && chance(0.5)) return null;
    return level;
  }

  while (n < total) {
    const base = b.baseline ?? floor;
    const kind = rnd();
    let len;
    let gen;
    let silentP = 0;
    if (kind < 0.18) {
      len = 10 + Math.floor(rnd() * 300); // quiet, around the floor
      const o = between(-3, 2);
      gen = () => base + o + between(-1, 1);
      silentP = between(0, 0.3);
    } else if (kind < 0.40) {
      len = 5 + Math.floor(rnd() * 300); // a loud burst over the margin, with quiet dips below the floor
      const o = margin + between(-2, 25);
      gen = () => (chance(0.05) ? base - 25 : base + o);
      silentP = between(0, 0.4);
    } else if (kind < 0.52) {
      len = 150 + Math.floor(rnd() * 600); // hovering at the margin, with spikes
      const o = margin + between(-0.5, 2.5);
      const sp = between(3, 12);
      gen = () => (chance(0.05) ? base + o + sp : base + o);
      silentP = between(0.03, 0.2);
    } else if (kind < 0.64) {
      len = 100 + Math.floor(rnd() * 1700); // in the dead band, up to ~6 minutes
      const o = margin * between(0.5, 1);
      const sp = between(3, 10);
      gen = () => {
        const r = rnd();
        return r < 0.03 ? base - 20 : r < 0.08 ? base + o + sp : base + o;
      };
      silentP = between(0, 0.2);
    } else if (kind < 0.72) {
      len = 20 + Math.floor(rnd() * 300); // under half the margin
      const o = margin * between(0, 0.5);
      gen = () => base + o;
      silentP = between(0, 0.3);
    } else if (kind < 0.86) {
      len = 1 + Math.floor(rnd() * 400); // a run of silence
      gen = () => null;
    } else {
      const r = rnd(); // a hole in the stream
      if (r < 0.7) t += staleMs + 1 + Math.floor(rnd() * 60_000);
      else if (r < 0.85) t += Math.floor(rnd() * staleMs);
      else t -= Math.floor(rnd() * 120_000); // the wall clock stepped back
      afterHole = true;
      reach.holes++;
      continue;
    }
    for (let k = 0; k < len && n < total; k++, n++) {
      let level = gen();
      if (level !== null && chance(silentP)) level = null;
      level = target(level);
      if (level !== null && lastSilent && chance(0.3)) level += margin * between(0.5, 1.5);
      if (level !== null) level = Math.min(0, level); // 0 dBFS is full scale: nothing real is louder
      lastSilent = level === null;
      const err = step(level);
      if (err) return err;
      afterHole = false;
      t += 190 + Math.floor(rnd() * 26); // a jittery cadence, never grid-aligned
    }
  }
  return null;
}

test('#453: SEEDED DIFFERENTIAL — over 2,000 random streams a silent window is exactly a reading at the current ambient', () => {
  // The general net under the crafted cases above. Measured against the review's mutants (2,000 seeds): it
  // kills the staleness skip (R9) on ~400 seeds, R14 on ~200, R12 on ~135, the absorb mutants (R11/R18) on
  // ~70 and R5 on ~15. It does NOT reach R13/R15 (they need a dead-band hold of 5 minutes in a precise shape),
  // which is why those two have crafted cases. Silence skipping the EMA step is EQUIVALENT (the step is exactly
  // zero at the ambient) and survives by construction. ~1 s.
  const reach = { silentAboveMargin: 0, silentAbsorbs: 0, silentAlerts: 0, silentAfterHole: 0, holes: 0 };
  for (let seed = 1; seed <= 2000; seed++) {
    const err = differentialStream(seed, reach);
    if (err) assert.fail(`diverged: ${err}`);
  }
  // Not vacuous: the moments that matter were really reached, many times.
  assert.ok(reach.silentAfterHole > 300, `silent first windows after a hole: ${reach.silentAfterHole}`);
  assert.ok(reach.silentAboveMargin > 5000, `silent windows above the margin: ${reach.silentAboveMargin}`);
  assert.ok(reach.silentAlerts > 50, `silent windows that were alert-eligible: ${reach.silentAlerts}`);
  assert.ok(reach.silentAbsorbs > 20, `absorbs that landed on a silent window: ${reach.silentAbsorbs}`);
});

test('#453 C1a: separate sounds with digital silence between them do NOT add up to an alert', () => {
  // ★ THE REPRO THAT DECIDED THE DESIGN (plan v2, Opus finding 1, verified by running it). Settled at -60,
  // then a -45 window every 2 s and digital silence in between. On dev e9e5d83 the silence never reached
  // the analyser, so its trailing window held only the pulses: it alerted at reading 160 (~32 s) and then
  // absorbed the ambient to -45.0 in one step. With the same pulses separated by real -60 readings it
  // never alerts (the control below). Silence must behave like the control: it dilutes the window.
  const pulses = (between) => Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? QUIET + 15 : between));

  const a = settled();
  const rows = drive(a, pulses(-Infinity), START);
  assert.equal(rows.filter((r) => r.wouldAlert).length, 0, 'pulses separated by silence alerted');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(Math.abs(rows[i].baseline - rows[i - 1].baseline) < 1, `the floor stepped at reading ${i} (an absorb)`);
  }
  // The floor moved ONLY by the ordinary EMA: each of the 40 pulses closes BASELINE_ALPHA of its gap, and
  // each silent window, a reading exactly at the ambient, moves it by exactly zero. So it lands on the
  // closed form, not on -60 and not on -45. ⚠️ Stated, not hidden: nothing pulls it back DOWN between the
  // pulses (a silent window moves it by exactly zero here), so over a long run of sparse sub-margin pulses
  // with silence between them the floor creeps toward the pulse level at the EMA's ordinary rate (10 min of
  // +8 dB pulses every 2 s: -60 -> -52.4). That is exactly what a room whose quiet readings sat precisely
  // at the ambient would do (KNOWN-ISSUES.md, #453 limits).
  const expected = QUIET + 15 - 15 * (1 - BASELINE_ALPHA) ** 40;
  assert.ok(Math.abs(a.baseline - expected) < 1e-9, `floor ${a.baseline}, expected the EMA-only ${expected}`);

  // Control: the same pulses with a real -60 between them never alerted on dev either.
  const c = settled();
  const control = drive(c, pulses(QUIET), START);
  assert.equal(control.filter((r) => r.wouldAlert).length, 0);
  assert.ok(c.baseline < QUIET + 2, `the control floor stays near quiet, got ${c.baseline}`);
});

test('#453 C1b: ten minutes of silence do not blind the detector — a real cry afterwards still alerts', () => {
  const a = settled();
  const silence = drive(a, rep(secs(10 * 60), -Infinity), START);
  assert.equal(silence[silence.length - 1].baseline, QUIET, 'silence held the ambient exactly');
  assert.ok(silence.every((r) => !r.wouldAlert), 'silence never alerts');
  const cry = drive(a, rep(secs(30), QUIET + 15), silence[silence.length - 1].t + READING_MS);
  // A silent window that consumed the cooldown would hold this off for 120 s.
  assert.ok(cry.some((r) => r.wouldAlert), 'a cry after a silent stretch must alert');
});

test('#453 C1b: ...and silence does not drag the ambient down to a floor: a sound 4 dB over it stays quiet', () => {
  // Settled at -64, ten minutes of silence, then a sustained -60 (household noise, +4 dB) for 30 s: 150
  // readings, so the trailing window is CONFIRMED and the alert rule really runs. A floor value fed into
  // the baseline during the silence would have dragged the ambient to ~-90 and made this read +30 dB.
  const a = analyser();
  drive(a, rep((START - T0) / READING_MS, QUIET - 4));
  const silence = drive(a, rep(secs(10 * 60), -Infinity), START);
  assert.equal(silence[silence.length - 1].baseline, QUIET - 4);
  const noise = drive(a, rep(secs(30), QUIET), silence[silence.length - 1].t + READING_MS);
  assert.ok(noise.filter((r) => r.confirmed).length >= 100, 'the alert rule must actually have been evaluated');
  assert.equal(noise.filter((r) => r.wouldAlert).length, 0, 'household noise 4 dB over the real ambient alerted');
  assert.ok(Math.abs(noise[0].recordDb - 4) < 1e-9, `scored against the real ambient, got ${noise[0].recordDb}`);
});

// Two halves of a cry with two seconds of silence between them: shorter than the 4 s trailing window, so
// the silence is NOT a hole in the stream (no staleness reset). `first` ends above the margin, with
// `loudSince` running.
function cryWithAGap() {
  const a = settled();
  const first = drive(a, rep(secs(20), QUIET + 15), START);
  assert.ok(first[first.length - 1].confirmed && first[first.length - 1].over >= MARGIN, 'precondition: above the margin');
  const gap = drive(a, rep(secs(2), -Infinity), first[first.length - 1].t + READING_MS);
  const second = drive(a, rep(secs(60), QUIET + 15), gap[gap.length - 1].t + READING_MS);
  return { gap, second };
}

test('#453 C1c: silence between two halves of a cry dilutes the trailing window instead of leaving the first half in it', () => {
  const { gap, second } = cryWithAGap();
  const floor = gap[gap.length - 1].baseline;
  // The first reading back: 9 cry readings left from the first half, the 10 silent windows (each at the
  // ambient, which the dead band held still through the gap), and this one. On dev the silence was never
  // pushed, so this window held 20 cry readings and read ~14 dB over: a stale run carried across the gap.
  assert.ok(Math.abs(second[0].over - (QUIET + 15 - floor) / 2) < 1e-9, `over ${second[0].over}, floor ${floor}`);
  assert.equal(second[0].confirmed, true);
  assert.ok(gap.every((r) => r.confirmed), 'silence kept the window full (no staleness reset)');
});

test('#453 C1c: ...and does not carry the first half\'s elevation into the 45 s absorb', () => {
  const { second } = cryWithAGap();
  // `loudSince` restarted in the gap (the diluted window fell below the margin), so the second half must
  // serve its own 45 s: absorbed exactly 45 s after IT crosses the margin, not 45 s after the first half did.
  const crossIdx = second.findIndex((r) => r.confirmed && r.over >= MARGIN);
  const absorbIdx = second.findIndex((r, i) => i > 0 && r.baseline - second[i - 1].baseline > 1);
  assert.ok(crossIdx > 0 && absorbIdx > crossIdx, `cross ${crossIdx}, absorb ${absorbIdx}`);
  assert.equal(second[absorbIdx].t - second[crossIdx].t, 45000, 'absorbed 45 s after the SECOND half crossed');
});

test('#453 C1d: NaN and +Infinity are invalid input, not silence — dropped, touching nothing', () => {
  // 16-bit PCM can only ever produce a finite level or -Infinity; the analyser is a public module, and a
  // NaN fed into the baseline would poison it permanently.
  const dropped = (baseline) => ({ baseline, over: null, confirmed: false, recordDb: null, wouldAlert: false, silent: false });
  const a = settled();
  assert.deepEqual(a.push(NaN, START), dropped(QUIET));
  assert.deepEqual(a.push(Infinity, START + READING_MS), dropped(QUIET));
  assert.equal(a.baseline, QUIET);
  const fresh = analyser();
  assert.deepEqual(fresh.push(NaN, T0), dropped(null));
  const rows = drive(fresh, rep(SEED_WINDOWS, QUIET), T0 + READING_MS);
  assert.equal(rows[SEED_WINDOWS - 2].baseline, null, 'a NaN did not count toward the seed');
  assert.equal(rows[SEED_WINDOWS - 1].baseline, QUIET);
});

test('#453 KNOWN LIMIT: a detector that has only ever heard silence has no ambient, so the first real sound seeds it — even a cry', () => {
  // Stated in KNOWN-ISSUES.md, not fixable without inventing a floor (the rejected design). A muted mic
  // that is then un-muted into a sustained cry seeds the ambient AT cry level from its first 25 audible
  // windows (the KNOWN LIMIT above), so that first event is not alerted; and silence afterwards never
  // brings the ambient back down, because a silent window is a reading at the ambient. Only a real,
  // quieter reading lowers it.
  const a = analyser();
  const silence = drive(a, rep(secs(10 * 60), -Infinity));
  assert.ok(silence.every((r) => r.baseline === null && r.recordDb === 0 && !r.wouldAlert));
  const cry = drive(a, rep(secs(30), QUIET + 40), silence[silence.length - 1].t + READING_MS);
  assert.equal(cry[SEED_WINDOWS - 1].baseline, QUIET + 40, 'seeded at the cry');
  assert.equal(cry.filter((r) => r.wouldAlert).length, 0, 'so that first cry is not alerted');
  const after = drive(a, rep(secs(10 * 60), -Infinity), cry[cry.length - 1].t + READING_MS);
  assert.equal(after[after.length - 1].baseline, QUIET + 40, 'silence after a sound already AT the ambient moves nothing');
  const quietAgain = drive(a, rep(secs(60), QUIET), after[after.length - 1].t + READING_MS);
  assert.ok(quietAgain[quietAgain.length - 1].baseline < QUIET + 40 - 10, 'a real quiet floor still pulls it down');
});

test('#453 KNOWN LIMIT: bursts shorter than the seed, with silence longer than the confirm window between them, never teach an ambient', () => {
  // KNOWN-ISSUES.md states this with these numbers (fix round 1, review finding: the docs said "the first ~5 s
  // of real sound become the ambient", which is not true here). While seeding, a silent window does not
  // advance the stream clock, so a silence longer than the trailing window (the Sound confirm setting) is a
  // hole and drops the partial seed; 4 s bursts never reach the 25 windows. A cold start, 9 minutes of 4 s
  // bursts at -30 dBFS with 5 s of silence between: no ambient, no alert, the loud windows stored as nothing
  // and the 1,500 silent ones as 0, so those minutes read quiet. dev e9e5d83 never learned an ambient from
  // this stream either (its silences were outages); what is new is that the silent windows are now stored.
  const a = analyser();
  const levels = [];
  while (levels.length < secs(9 * 60)) levels.push(...rep(secs(4), -30), ...rep(secs(5), -Infinity));
  levels.length = secs(9 * 60);
  const rows = drive(a, levels);
  assert.equal(a.baseline, null, 'no ambient was ever learned');
  assert.equal(rows.filter((r) => r.wouldAlert).length, 0);
  assert.ok(rows.every((r, i) => r.recordDb === (levels[i] === -Infinity ? 0 : null)), 'silent windows store 0, loud ones nothing');
  assert.equal(rows.filter((r) => r.recordDb === 0).length, 1500);
});

test('#453 KNOWN LIMIT: faint sounds separated by silence creep the ambient up at the ordinary rate (10 min of +8 dB every 2 s: -60 -> -52.4)', () => {
  // The number KNOWN-ISSUES.md quotes. Each +8 reading is under half the margin, so the ordinary tracking
  // closes 1% (BASELINE_ALPHA) of its gap; each silent window between them moves the floor by exactly zero
  // where a real quieter reading would pull it back down.
  const a = settled();
  drive(a, Array.from({ length: secs(10 * 60) }, (_, i) => (i % 10 === 0 ? QUIET + 8 : -Infinity)), START);
  assert.ok(Math.abs(a.baseline - -52.39) < 0.01, `floor after 10 min: ${a.baseline}`);
});

// ---------------------------------------------------------------------------------------------
// ★★★ THE REGRESSION TESTS FOR THE VERIFIED DEFECT: the dead band was an absorbing state
// ---------------------------------------------------------------------------------------------

test('a +9 dB step INSIDE the dead band is eventually learned, not frozen forever', () => {
  // +9 dB sits between margin/2 (5.54) and margin (11.07) — the band where the baseline deliberately
  // does not track. Before the fix it never tracked AGAIN: measured on prod, `ambient=-63.5` on 1891
  // consecutive level lines = 7.9 unbroken hours pinned to one value, which is what a white-noise
  // machine switched on at bedtime did every single night.
  const a = settled();
  const rows = drive(a, rep(secs(12 * 60), QUIET + 9), START);

  const last = rows[rows.length - 1];
  assert.ok(
    Math.abs(last.baseline - (QUIET + 9)) < 0.05,
    `baseline should have learned the new floor, got ${last.baseline}`
  );
  assert.ok(last.recordDb < 0.05, `excursion should decay to ~0, got ${last.recordDb}`);

  // ⚠️ THE ABSOLUTE DEADLINE, and it is not decoration. The exactness test below measures the
  // resume against DEAD_BAND_MAX_MS itself, so it is self-referential: a mutant that doubles the
  // constant moves both sides of that assertion and SURVIVES it (verified 2026-09-02). This states
  // the user-visible promise independently — a white-noise machine switched on at bedtime is learned
  // within six minutes — and it is what kills that mutant.
  // Measured against the value the floor FROZE at, not against the first reading: the ramp's
  // sub-margin/2 leading edge lifts the floor ~1.2 dB before the freeze locks in, so comparing to
  // reading 0 left only ~1.1 dB of headroom and the doubled-constant mutant slipped through it.
  const frozenAt = rows[firstHold(rows, 1)].baseline;
  const at6min = rows[secs(6 * 60) - 1];
  assert.ok(
    at6min.baseline - frozenAt > 3,
    `the floor must be visibly climbing 6 minutes in, got ${at6min.baseline} vs frozen ${frozenAt}`
  );
});

test('a reading BELOW the ambient floor records 0, never a negative excursion', () => {
  // activityTracker.recordSound drops anything that is not >= 0, so an unclamped negative would
  // silently discard the window instead of recording a quiet minute — the timeline would then have
  // fewer sound windows than minutes and read as "no data" rather than "quiet".
  const a = settled();
  const r = a.push(QUIET - 12, START);
  assert.equal(r.recordDb, 0);
});

test('the freeze lasts EXACTLY DEAD_BAND_MAX_MS — not one reading more or less', () => {
  // The direction ("it eventually unfreezes") is passed by any escape hatch at any duration. This
  // pins the duration itself, measured from the analyser's own behaviour rather than from an assumed
  // ramp length: the first reading that holds the baseline is when the freeze clock starts, and the
  // next reading that moves it must be exactly DEAD_BAND_MAX_MS later.
  const a = settled();
  const rows = drive(a, rep(secs(12 * 60), QUIET + 9), START);

  const holdIdx = firstHold(rows, 1);
  assert.ok(holdIdx > 0, 'the baseline must actually freeze — the dead band is not being entered');
  const resumeIdx = firstMove(rows, holdIdx + 1);
  assert.ok(resumeIdx > 0, 'the baseline must resume');
  assert.equal(
    rows[resumeIdx].t - rows[holdIdx].t,
    DEAD_BAND_MAX_MS,
    'tracking resumes exactly one DEAD_BAND_MAX_MS after the freeze begins'
  );
  // And it stays frozen for the whole of that window — one flicker mid-freeze would mean the clock is
  // being reset, which is the bug wearing a different hat.
  for (let i = holdIdx; i < resumeIdx; i++) {
    assert.equal(rows[i].baseline, rows[holdIdx].baseline, `baseline moved mid-freeze at reading ${i}`);
  }
});

test('the dead band still protects a 4-minute moderate cry from raising its own baseline', () => {
  // This is the guard the escape must NOT destroy: a cry ramping up must not quietly desensitise
  // itself. 4 minutes is inside DEAD_BAND_MAX_MS, so the baseline must not move at all while it runs.
  // A mutant shortening the escape to REBASELINE_MS (45 s) — the obvious "just reuse the constant"
  // simplification — dies here.
  const a = settled();
  const rows = drive(a, rep(secs(4 * 60), QUIET + 9), START);

  const holdIdx = firstHold(rows, 1);
  assert.ok(holdIdx > 0);
  const frozenAt = rows[holdIdx].baseline;
  // The leak, pinned. The step's leading edge sits below margin/2 for its first 14 readings while the
  // 20-reading trailing average fills, and the EMA tracks those — lifting the floor ~1.18 dB before
  // the freeze locks in. Asserted rather than merely described, because the SIZE of the leak is what
  // makes the excursion below read 7.8 rather than 9, and because an EMA that tracked the trailing
  // AVERAGE instead of the instantaneous reading would leak only ~0.2 dB and pass every other
  // assertion in this file.
  assert.ok(
    Math.abs(frozenAt - (QUIET + 1.18)) < 0.15,
    `expected the pre-freeze leak to be ~1.18 dB, got ${(frozenAt - QUIET).toFixed(2)}`
  );

  const last = rows[rows.length - 1];
  assert.equal(last.baseline, frozenAt, 'a 4-minute moderate cry must not move the ambient floor');
  // Still comfortably above sleepAnalysis's SOUND_ACTIVE (6 dB), which is the threshold that decides
  // whether the minute reads as noise at all — that is the property worth pinning, not a round number.
  // It is 7.8 rather than the full 9 because the ramp's first ~7 readings are below margin/2 and the
  // EMA tracks them, lifting the floor ~1.2 dB before the freeze locks in. That leak is pre-existing
  // and unchanged here; it is recorded so the next person doesn't read 7.8 as a bug.
  assert.ok(last.recordDb > 6, `and it must still read as loud, got ${last.recordDb}`);
});

test('an OSCILLATING source that crosses the margin still escapes the freeze', () => {
  // The nastiest shape, and the one that kills the naive fix. `loudSince` resets on every dip, so a
  // source alternating above and below the alert margin is never absorbed by REBASELINE_MS; and if the
  // freeze clock were reset whenever the level went above the margin, it would never escape the dead
  // band either. It is continuously elevated the whole time, so it must be treated as ambient.
  const block = [...rep(secs(30), QUIET + 13), ...rep(secs(30), QUIET + 7)];
  const a = settled();
  const rows = drive(a, Array.from({ length: 12 }, () => block).flat(), START);

  const last = rows[rows.length - 1];
  assert.ok(
    last.baseline > QUIET + 3,
    `an oscillating source must not pin the floor at the quiet value, got ${last.baseline}`
  );
});

test('a quiet room ratchets the baseline DOWN normally (the guard is not one-sided any more)', () => {
  // The original guard let the baseline fall freely (a below-baseline reading always passes
  // `over < margin/2`) while blocking every rise — which is exactly what made the band absorbing.
  // Falling must still work.
  const a = settled();
  const rows = drive(a, rep(secs(3 * 60), QUIET - 6), START);
  assert.ok(Math.abs(rows[rows.length - 1].baseline - (QUIET - 6)) < 0.05, 'tracks a quieter room');
});

test('the freeze clock is re-armed once the floor tracks again, so EVERY later cry is protected', () => {
  // ⚠️ FOUND BY AN ADVERSARIAL REVIEW, 2026-09-02, as a SURVIVING MUTANT: deleting the
  // `frozenSince = 0` in the below-band branch left every test in this file green while destroying
  // the dead band for the whole rest of the night. It is the only reset outside the absorb, so
  // without it the clock keeps running from the FIRST freeze of the evening and every subsequent
  // moderate cry is absorbed on its first reading.
  //
  // The shape is an ordinary night: white-noise machine on (freeze, then escape after 5 min), the
  // machine off again, then the child cries. That cry must get the same 5 minutes of protection as
  // the one in the test above — a single-episode fixture cannot see this at all.
  const a = settled();
  let t = START;
  const machineOn = drive(a, rep(secs(12 * 60), QUIET + 9), t);
  t = machineOn[machineOn.length - 1].t + READING_MS;
  const machineOff = drive(a, rep(secs(3 * 60), QUIET + 9 - 9), t);
  t = machineOff[machineOff.length - 1].t + READING_MS;

  const cry = drive(a, rep(secs(4 * 60), QUIET + 9), t);
  const holdIdx = firstHold(cry, 1);
  assert.ok(holdIdx > 0, 'the second episode must freeze the floor too');
  const last = cry[cry.length - 1];
  assert.equal(last.baseline, cry[holdIdx].baseline, 'the second 4-minute cry must be protected too');
  assert.ok(last.recordDb > 6, `and must still read as loud, got ${last.recordDb}`);
});

test('the dead band starts at HALF the margin — a +6 dB source is learned, not frozen', () => {
  // ⚠️ ALSO A SURVIVING MUTANT: every other fixture here steps to +9 or +15 dB, where `margin * 0.5`
  // and `margin * 0.4` (or 0.6, or `<` vs `<=`) behave identically, so the edge itself was untested
  // in both directions. +6 dB is the shape that separates them: under the shipped half-margin the
  // trailing average never clears the edge before the EMA has followed it, so the source is simply
  // learned; move the edge down and it freezes with the floor ~5 dB low — which is exactly the
  // "reads as awake all night" failure. The 0.5 is also a user-facing promise in
  // docs/notifications.md ("between half and all of the margin"), and nothing else pins it.
  const a = settled();
  const rows = drive(a, rep(secs(4 * 60), QUIET + 6), START);
  const last = rows[rows.length - 1];
  assert.ok(
    Math.abs(last.baseline - (QUIET + 6)) < 0.1,
    `a +6 dB source is below the dead band and must be tracked, got ${last.baseline}`
  );
  assert.ok(last.recordDb < 0.1, `so its excursion decays, got ${last.recordDb}`);
});

test('a level sitting EXACTLY on half the margin is INSIDE the dead band — the comparison is <', () => {
  // The mirror of the exact-margin test further down, and the other end of the promise in
  // docs/notifications.md. `<` vs `<=` differ only when `over` lands precisely on `margin/2`, which
  // needs values that are exact in binary: sensitivity 1 gives margin === 18, half is 9, and a window
  // of identical -51s against a floor of exactly -60 gives over === 9 with no rounding at all.
  const a = createSoundAnalyser({ margin: marginDb(1), trailN: TRAIL_N, cooldownMs: COOLDOWN_MS });
  const rows = drive(a, [...rep(SEED_WINDOWS, -60), ...rep(10, -51)]);
  const post = rows.slice(SEED_WINDOWS);
  assert.equal(post[0].over, 9, 'the fixture must land exactly on half the margin');
  for (const r of post) assert.equal(r.baseline, -60, 'exactly half the margin must freeze, not track');
});

// ---------------------------------------------------------------------------------------------
// A hole in the stream — the analyser outlives an ffmpeg restart, so it has to notice one
// ---------------------------------------------------------------------------------------------

  // The ordinary restart is 5 s of back-off plus up to 45 s waiting for the MediaMTX path, so a
  // 30–50 s hole is routine, not pathological. Everything the analyser holds except the baseline is
  // wall-clock or positional, so before the staleness reset the OUTAGE ITSELF counted as observed
  // audio. All three cases below were demonstrated failing on 2026-09-02.

  test('a gap does NOT let an in-progress cry absorb itself from a reading of SILENCE', () => {
    const a = settled();
    // 20 s above the margin: `loudSince` is set, but 45 s has not elapsed so nothing is absorbed.
    const cry = drive(a, rep(secs(20), QUIET + 15), START);
    const before = cry[cry.length - 1].baseline;

    // The stream drops for 30 s and the child stops crying during it. The first reading back is a
    // SILENT room — and it used to move the floor from -58.8 to -45.8, because the stale trailing
    // window still held the cry and `now - loudSince` had cleared 45 s by sitting in the gap.
    const back = a.push(QUIET, cry[cry.length - 1].t + 30000);
    assert.ok(
      Math.abs(back.baseline - before) < 0.1,
      `a silent reading after an outage must not absorb, floor went ${before} -> ${back.baseline}`
    );
    assert.equal(back.confirmed, false, 'and the stale trailing window must be discarded, not reused');
  });

  test('a gap does not let elapsed OUTAGE count toward the 45-second absorb', () => {
    const a = settled();
    const cry = drive(a, rep(secs(20), QUIET + 15), START);
    const t = cry[cry.length - 1].t;
    // Same cry, still going after a 30 s hole. It must serve its 45 s of OBSERVED elevation from
    // scratch, so the reading immediately back cannot be the absorbing one.
    const back = a.push(QUIET + 15, t + 30000);
    assert.ok(Math.abs(back.baseline - cry[cry.length - 1].baseline) < 0.1, 'no absorb on the first reading back');
    const after = drive(a, rep(secs(20), QUIET + 15), t + 30000 + READING_MS);
    assert.ok(after.every((r, i) => i === 0 || r.baseline - after[i - 1].baseline < 1),
      'and none in the following 20 s either — the 45 s clock restarted');
  });

  test('a gap does not let elapsed OUTAGE count toward the dead-band escape', () => {
    const a = settled();
    const held = drive(a, rep(secs(60), QUIET + 9), START);
    const frozenAt = held[held.length - 1].baseline;
    // 299 s of outage plus the 60 s already served used to clear DEAD_BAND_MAX_MS on the first
    // reading back, having observed one minute of elevation.
    const back = a.push(QUIET + 9, held[held.length - 1].t + 299000);
    assert.equal(back.baseline, frozenAt, 'the escape must be earned by observed elevation only');
  });

  test('a NORMAL, JITTERY cadence is never mistaken for a gap', () => {
    // ⚠️⚠️ THE JITTER IS THE POINT, AND EVERY OTHER FIXTURE IN THIS FILE LACKS IT. `drive` advances
    // exactly 200 ms per reading, but in production `now` is `Date.now()` at the moment a 1600-sample
    // PCM window finishes arriving off a network RTSP stream — it is never grid-aligned. A staleness
    // window of one reading interval passes the grid-aligned fixture perfectly (200 > 200 is false)
    // and, on a real stream, would clear the trailing window on almost every reading, so nothing
    // would ever be confirmed and the camera would never alert again. That mutant survived the whole
    // suite until this test existed.
    const a = settled();
    let t = START;
    let confirmed = 0;
    let alerted = 0;
    for (let i = 0; i < secs(30); i++) {
      const r = a.push(QUIET + 15, t);
      if (r.confirmed) confirmed++;
      if (r.wouldAlert) alerted++;
      t += 190 + ((i * 7) % 26); // 190–215 ms, deterministic, never a multiple of 200
    }
    assert.ok(confirmed > 100, `a jittery stream must still fill the window, confirmed ${confirmed}`);
    assert.ok(alerted > 0, 'and must still alert');
  });

  test('the learned floor SURVIVES the gap — that is the whole point of the analyser outliving a restart', () => {
    const a = settled();
    const learned = drive(a, rep(secs(12 * 60), QUIET + 9), START);
    const floor = learned[learned.length - 1].baseline;
    const back = a.push(QUIET + 9, learned[learned.length - 1].t + 60000);
    // ⚠️ The staleness reset must NOT throw away `baseline`. Re-seeding on every restart is the
    // defect this file's hoisting fixed; the reset exists only to drop evidence we did not observe.
    assert.ok(Math.abs(back.baseline - floor) < 0.1, `floor kept across the gap, got ${back.baseline}`);
    assert.ok(back.recordDb < 0.1, 'so the room still reads as quiet immediately, with no relearning hole');
});

// ---------------------------------------------------------------------------------------------
// Existing behaviour that must not regress
// ---------------------------------------------------------------------------------------------

test('a sustained ABOVE-margin source is absorbed exactly REBASELINE_MS after it crosses', () => {
  const a = settled();
  const rows = drive(a, rep(secs(3 * 60), QUIET + 15), START);

  const crossIdx = rows.findIndex((r) => r.confirmed && r.over >= MARGIN);
  assert.ok(crossIdx > 0, 'a +15 dB source must clear the 11.07 dB margin');
  const absorbIdx = rows.findIndex((r, i) => i > crossIdx && r.baseline - rows[i - 1].baseline > 1);
  assert.ok(absorbIdx > 0, 'it must be absorbed');
  // The LITERAL, not the imported constant. `absorbT - crossT === REBASELINE_MS` is self-referential
  // and survives a mutant that changes the constant (verified 2026-09-02): both sides move together.
  // 45 s is the number the design rests on — long enough that a cry alerts first, short enough that a
  // fan stops alerting within a minute — so the test states it independently of the source.
  assert.equal(rows[absorbIdx].t - rows[crossIdx].t, 45000, 'absorbed at 45 s, not sooner or later');
  assert.equal(REBASELINE_MS, 45000, 'and the source agrees with that number');
  assert.ok(
    Math.abs(rows[absorbIdx].baseline - (QUIET + 15)) < 0.2,
    `absorb sets the floor to the new level, got ${rows[absorbIdx].baseline}`
  );
  assert.equal(rows[absorbIdx].wouldAlert, false, 'the absorbing reading never also alerts');

  // ⚠️ THE ABSORBING READING STILL SCORES ITSELF AGAINST THE OLD FLOOR. `recordDb` is computed before
  // the baseline moves, so this minute is recorded as the ~15 dB it actually was. Computing it after
  // would record 0.0 — and since `sound_peak` is a per-MINUTE MAXIMUM, that single reading is enough
  // to flip a genuinely loud minute to "quiet" in `activity_samples`. Found as a surviving mutant.
  assert.ok(
    rows[absorbIdx].recordDb > 13,
    `the absorbing reading records the excursion it observed, got ${rows[absorbIdx].recordDb}`
  );

  // ⚠️ AND THE TRAILING WINDOW IS EMPTIED. Without that, the very next reading is `confirmed` against
  // an average still made of pre-absorb (loud) readings measured against the NEW floor, so it can
  // alert immediately on a source that was just declared ambient. Also a surviving mutant.
  assert.equal(rows[absorbIdx + 1].confirmed, false, 'the window is rebuilt from scratch after an absorb');
  for (let i = 1; i < TRAIL_N; i++) {
    assert.equal(rows[absorbIdx + i].confirmed, false, `still refilling ${i} readings after the absorb`);
  }
  assert.equal(rows[absorbIdx + TRAIL_N].confirmed, true, 'confirmed again exactly trailN readings later');
});

test('the dead-band escape resumes the EMA gradually — it does NOT absorb in one step', () => {
  // ⚠️ Surviving mutant: replacing the escape's `baseline += ALPHA * (rms - baseline)` with the
  // absorb branch's `baseline += over` reaches the same floor and passes every other assertion here.
  // The gradual form is deliberate and the reason is in the source: it climbs continuously to the new
  // floor rather than stepping once every 5 minutes. A step would also drop the recorded excursion
  // from ~9 dB to 0 in a single minute, which reads downstream as the room falling silent instantly.
  const a = settled();
  const rows = drive(a, rep(secs(12 * 60), QUIET + 9), START);
  const holdIdx = firstHold(rows, 1);
  const resumeIdx = firstMove(rows, holdIdx + 1);

  const jump = rows[resumeIdx].baseline - rows[resumeIdx - 1].baseline;
  // One EMA step over a ~7.8 dB gap is 0.01 x 7.8 = 0.078 dB. An absorb would be the whole 7.8.
  assert.ok(jump > 0 && jump < 0.5, `the escape must be a crawl, not a step — moved ${jump.toFixed(3)} dB`);
  assert.ok(rows[resumeIdx].recordDb > 6, 'and the room still reads as loud on that reading');
});

test('a 3-second burst is not absorbed, and the floor returns to the quiet value afterwards', () => {
  // The single most important property for sleep data: a short loud event must leave no trace in the
  // ambient floor. An absorb is a STEP (the whole excursion folded in at once), so it is distinguished
  // from the EMA's ordinary crawl by the size of a single reading's move.
  const a = settled();
  const burst = drive(a, rep(secs(3), QUIET + 15), START);
  for (let i = 1; i < burst.length; i++) {
    assert.ok(
      Math.abs(burst[i].baseline - burst[i - 1].baseline) < 1,
      `a 3 s burst must never be folded into the floor in one step (reading ${i})`
    );
  }
  const after = drive(a, rep(secs(3 * 60), QUIET), burst[burst.length - 1].t + READING_MS);
  assert.ok(
    Math.abs(after[after.length - 1].baseline - QUIET) < 0.05,
    `the floor must come back to quiet, got ${after[after.length - 1].baseline}`
  );
});

// ---------------------------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------------------------

test('a freshly seeded analyser cannot alert until the trailing window holds trailN readings', () => {
  // The `confirmed` gate only bites at cold start — once the detector has been running, the rolling
  // window is permanently full and it is the trailing AVERAGE, not the count, that gates alerts.
  // ⚠️ I first asserted this against a settled analyser, where it is vacuously true and the fixture
  // could not have discriminated: the window was already full from the preceding quiet readings.
  const a = analyser();
  const rows = drive(a, [...rep(SEED_WINDOWS, QUIET), ...rep(TRAIL_N, QUIET + 30)]);
  const post = rows.slice(SEED_WINDOWS);
  for (let i = 0; i < TRAIL_N - 1; i++) {
    assert.equal(post[i].confirmed, false, `not confirmed with only ${i + 1} readings`);
    assert.equal(post[i].wouldAlert, false, 'and therefore cannot alert');
  }
  assert.equal(post[TRAIL_N - 1].confirmed, true, 'confirmed on the trailN-th reading');
  assert.equal(post[TRAIL_N - 1].wouldAlert, true, 'and +30 dB clears the margin immediately');
});

test('an alert needs the trailing AVERAGE above the margin, and the cooldown starts only when one fires', () => {
  const a = settled();
  const rows = drive(a, rep(secs(30), QUIET + 15), START);

  const firstAlert = rows.findIndex((r) => r.wouldAlert);
  assert.ok(firstAlert > 0, 'a +15 dB source must eventually alert');
  assert.equal(rows[0].wouldAlert, false, 'but not on the first loud reading — the average has not moved yet');
  assert.ok(rows[firstAlert].confirmed);
  assert.ok(rows[firstAlert].over >= MARGIN);
  assert.ok(rows[firstAlert - 1].over < MARGIN, 'it alerts on the exact reading the average crosses the margin');

  // ⚠️ THE CONTRACT THE DETECTOR DEPENDS ON: eligibility is reported every reading until the caller
  // says an alert actually went out. The quiet-hours schedule lives in the caller, so a suppressed
  // alert must NOT consume the cooldown — otherwise the first cry after quiet hours end is silently
  // swallowed for two minutes.
  assert.ok(rows[firstAlert + 1].wouldAlert, 'still eligible while the caller has not fired anything');
});

test('the cooldown suppresses a second alert for exactly sound_cooldown_s, then releases', () => {
  const a = settled();
  const first = drive(a, rep(secs(20), QUIET + 15), START);
  const tA = first[first.findIndex((r) => r.wouldAlert)].t;
  a.markAlerted(tA);

  // Quiet for three minutes so the floor recovers and `loudSince` resets — otherwise the 45 s
  // rebaseline absorbs the source mid-cooldown and the second burst has nothing to alert about.
  // ⚠️ My first version of this test jumped the clock straight from tA to tA + cooldown with the
  // source still loud, and that is exactly what happened: the assertion failed for a reason that had
  // nothing to do with the cooldown. Readings arrive every 200 ms in production; a fixture that skips
  // two minutes of them is not testing the code that runs.
  const quiet = drive(a, rep(secs(3 * 60), QUIET), first[first.length - 1].t + READING_MS);
  assert.ok(Math.abs(quiet[quiet.length - 1].baseline - QUIET) < 0.05);

  // Start a second burst 4 s before the cooldown expires. The trailing average needs ~3 s to cross the
  // margin, so the source is provably ALERT-WORTHY for a full second before the cooldown is up.
  const second = drive(a, rep(secs(30), QUIET + 15), tA + COOLDOWN_MS - 4000);
  const crossing = second.findIndex((r) => r.confirmed && r.over >= MARGIN);
  assert.ok(crossing >= 0 && second[crossing].t < tA + COOLDOWN_MS, 'the burst clears the margin before the cooldown ends');
  for (let i = crossing; second[i].t < tA + COOLDOWN_MS; i++) {
    assert.equal(second[i].wouldAlert, false, `loud but suppressed at ${second[i].t - tA} ms after the alert`);
  }
  const released = second.find((r) => r.wouldAlert);
  assert.equal(released.t - tA, COOLDOWN_MS, 'eligible again on the first reading at or past the cooldown');
});

test('a level sitting EXACTLY on the margin alerts — the comparison is >=, not >', () => {
  // Every fixture above steps well past the margin, so `over >= margin` and `over > margin` behave
  // identically in all of them and the boundary is untested. This is the one shape that separates
  // them, and it needs values that are exact in binary or floating point decides the outcome:
  // sensitivity 1 gives margin === 18 exactly, and a mean of twenty identical -42s is exactly -42.
  const a = createSoundAnalyser({ margin: marginDb(1), trailN: TRAIL_N, cooldownMs: COOLDOWN_MS });
  assert.equal(marginDb(1), 18, 'the fixture depends on this being exact');

  const rows = drive(a, [...rep(SEED_WINDOWS, -60), ...rep(TRAIL_N, -42)]);
  const first = rows[SEED_WINDOWS + TRAIL_N - 1];
  assert.equal(first.over, 18, 'the trailing average sits exactly one margin above the floor');
  assert.equal(first.wouldAlert, true, 'exactly at the margin must fire');
});

// ---------------------------------------------------------------------------------------------
// marginDb
// ---------------------------------------------------------------------------------------------

test('marginDb maps sensitivity 1..100 onto 18..4 dB and clamps everything outside', () => {
  assert.equal(marginDb(1), 18);
  assert.equal(marginDb(100), 4);
  assert.ok(Math.abs(marginDb(50) - 11.0707) < 0.001, 'the shipped default is ~11 dB');
  // Higher sensitivity must never mean a HARDER trigger.
  for (let s = 2; s <= 100; s++) assert.ok(marginDb(s) < marginDb(s - 1), `monotonic at ${s}`);
  assert.equal(marginDb(500), 4, 'clamped above');
  assert.equal(marginDb(-5), 18, 'clamped below');
  // 0, null and undefined all mean "unset" and fall back to the default, not to the 1..100 clamp.
  assert.equal(marginDb(0), marginDb(50));
  assert.equal(marginDb(undefined), marginDb(50));
  assert.equal(marginDb(null), marginDb(50));
});

test('the EMA time constant is ~20 s at 5 readings/s', () => {
  // BASELINE_ALPHA is stated in the source as "~20 s"; nothing checked that sentence. 100 readings of
  // alpha 0.01 closes 1 - 0.99^100 = 63.4% of the gap, which is one time constant by definition.
  const closed = 1 - (1 - BASELINE_ALPHA) ** secs(20);
  assert.ok(Math.abs(closed - 0.632) < 0.01, `expected ~63% of the gap closed in 20 s, got ${closed}`);
});
