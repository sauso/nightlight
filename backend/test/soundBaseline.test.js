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

/** A settled analyser sitting on a QUIET room, plus the index the caller's own sequence starts at. */
function settled() {
  const a = analyser();
  drive(a, rep(SEED_WINDOWS + secs(30), QUIET));
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
  // 25 windows, five of them very loud and scattered. The median is the quiet floor; the MEAN would
  // be ~-53. This is the discriminating case: the baseline used to be seeded from a SINGLE window, so
  // a relaunch landing during a cry seeded ambient AT CRY LEVEL — and it relaunches 5 s after any exit.
  const levels = rep(SEED_WINDOWS, QUIET);
  for (const i of [0, 3, 11, 19, 24]) levels[i] = -20;

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
  const rows = drive(a, rep(secs(12 * 60), QUIET + 9), T0 + 60000);

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
  const r = a.push(QUIET - 12, T0 + 60000);
  assert.equal(r.recordDb, 0);
});

test('the freeze lasts EXACTLY DEAD_BAND_MAX_MS — not one reading more or less', () => {
  // The direction ("it eventually unfreezes") is passed by any escape hatch at any duration. This
  // pins the duration itself, measured from the analyser's own behaviour rather than from an assumed
  // ramp length: the first reading that holds the baseline is when the freeze clock starts, and the
  // next reading that moves it must be exactly DEAD_BAND_MAX_MS later.
  const a = settled();
  const rows = drive(a, rep(secs(12 * 60), QUIET + 9), T0 + 60000);

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
  const rows = drive(a, rep(secs(4 * 60), QUIET + 9), T0 + 60000);

  const holdIdx = firstHold(rows, 1);
  assert.ok(holdIdx > 0);
  const frozenAt = rows[holdIdx].baseline;
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
  const rows = drive(a, Array.from({ length: 12 }, () => block).flat(), T0 + 60000);

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
  const rows = drive(a, rep(secs(3 * 60), QUIET - 6), T0 + 60000);
  assert.ok(Math.abs(rows[rows.length - 1].baseline - (QUIET - 6)) < 0.05, 'tracks a quieter room');
});

// ---------------------------------------------------------------------------------------------
// Existing behaviour that must not regress
// ---------------------------------------------------------------------------------------------

test('a sustained ABOVE-margin source is absorbed exactly REBASELINE_MS after it crosses', () => {
  const a = settled();
  const rows = drive(a, rep(secs(3 * 60), QUIET + 15), T0 + 60000);

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
});

test('a 3-second burst is not absorbed, and the floor returns to the quiet value afterwards', () => {
  // The single most important property for sleep data: a short loud event must leave no trace in the
  // ambient floor. An absorb is a STEP (the whole excursion folded in at once), so it is distinguished
  // from the EMA's ordinary crawl by the size of a single reading's move.
  const a = settled();
  const burst = drive(a, rep(secs(3), QUIET + 15), T0 + 60000);
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
  const rows = drive(a, rep(secs(30), QUIET + 15), T0 + 60000);

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
  const first = drive(a, rep(secs(20), QUIET + 15), T0 + 60000);
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
