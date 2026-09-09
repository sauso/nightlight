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
  // silence about a limit is the thing this repo's rules forbid. Bounded: the EMA drags the floor
  // back down within ~20 s once the room quietens, which is why it is a limit and not a defect.
  const a = analyser();
  const rows = drive(a, [...rep(15, -20), ...rep(10, QUIET)]);
  assert.equal(rows[SEED_WINDOWS - 1].baseline, -20);
});

test('true digital silence (-Infinity) neither seeds nor moves the baseline', () => {
  const a = analyser();
  const rows = drive(a, [...rep(SEED_WINDOWS, -Infinity), ...rep(SEED_WINDOWS, QUIET)]);
  // If -Infinity counted toward the seed the baseline would exist (and be -Infinity) by reading 25.
  assert.equal(rows[SEED_WINDOWS - 1].baseline, null, 'silence does not count toward the seed');
  assert.equal(rows[2 * SEED_WINDOWS - 1].baseline, QUIET);

  const after = a.push(-Infinity, T0 + 10 * 60000);
  assert.equal(after.baseline, QUIET, 'and it does not disturb a settled baseline');
  assert.equal(after.recordDb, null, 'nor does it record a spurious excursion');
  assert.equal(after.wouldAlert, false);
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
