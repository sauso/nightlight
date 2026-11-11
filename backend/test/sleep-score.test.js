// The sleep score's maths (src/lib/sleepScore.js; sleep score plan, phase 1b). Nothing calls it yet.
//
// EVERY TEST HERE HAS A PRECONDITION AND A LITERAL EXPECTED VALUE, worked out by hand from the curve anchors in
// SCORE_CONFIG, and each one either sits on a boundary or separates two implementations that are both plausible:
//   a curve is a straight line between anchors, not a step .......... "duration falls in a straight line ..."
//   the whole score is the weighted mean of ROUNDED components ...... "a full night: every component ..."
//   the cap is continuity + 40 / restlessness + 40, lower one named . "weakest-link cap ..."
//   an unavailable component is dropped and the rest rescaled ....... "a missing put-down ..."
//   no score: not ok, in progress, promoted from empty, no reference,
//     under 12 months with no baseline; negative age = no birthday .. "no score ..."
//   age 11 vs 12 months; early estimate has no band word ............ "the age figure ..."
//   band edges 84/85, 69/70, 54/55 .................................. "band edges"
//   final at computed_at >= window end + 3 h, on the ROW's time ..... "provisional ..."
//   low confidence at coverage < 80%, > 15 unwatched, no real wake .. "low confidence ..."
//   duration never credits unwatched minutes ........................ "more than 15 unwatched minutes ..."
//   a changed span drops longest stretch and restlessness ........... "a corrected span ..."
//   settling follows frontend/src/lib/inBed.js ...................... "settling mirrors ..."
//   under 12 months / unknown age: continuity against usual only .... "continuity under 12 months ..."
//   restlessness is the excess over max(usual, floor) ............... "restlessness ..."
//   a stored row and a fresh compute of one night score the same .... "a fresh compute ..."
//   clock times are wall-clock in the night's own zone, DST-safe .... "clock minutes ..."
//   the age table is the paper's, joined by straight lines .......... "age figures ..."
//
// NOT tested here: the wording of anything (there is none: bands and reasons are keys), and the config as a whole
// (a snapshot of it would only say the numbers are the numbers). The baseline has its own file.
//
// ⚠️ Fixture ids are made up: the repo is public.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

// sleepScore.js imports sleepAnalysis.js (for the context parser and the finality test), which opens the database.
useTempDataDir();
const { default: db } = await import('../src/db.js');
const {
  SCORE_VERSION, SCORE_CONFIG, scoreNight, toScoringInput, bandFor, ageMonthsOn, ageNightSleepMinutes, clockMinutesSinceNoon,
} = await import('../src/lib/sleepScore.js');

after(() => {
  try { db.close(); } catch { /* already closed */ }
  cleanupTempDataDirs();
});

const CONTEXT = { v: 1, camera_id: 'cam-a', tz: 'UTC', window: { start: '19:00', end: '07:00' }, algo: '6' };
const NOW = Date.UTC(2026, 2, 12, 12, 0, 0); // well after the fixture night

// A STORED row: 19:00 to 07:00 UTC, asleep 19:30, up 06:30, put down 19:10 (a 20-minute settle), fully watched,
// stored exactly 3 hours after the window (final).
const stored = (over = {}) => ({
  child_id: 'kid-a',
  night_date: '2026-03-10',
  window_start: '2026-03-10 19:00:00',
  window_end: '2026-03-11 07:00:00',
  status: 'ok',
  onset_at: '2026-03-10 19:30:00',
  wake_at: '2026-03-11 06:30:00',
  in_bed_at: '2026-03-10 19:10:00',
  asleep_minutes: 600,
  awake_minutes: 150,
  unknown_minutes: 0,
  wake_count: 4,
  longest_stretch_minutes: 300,
  coverage_minutes: 720,
  stir_minutes: 20,
  wake_unconfirmed_at: null,
  scoring_context: JSON.stringify(CONTEXT),
  computed_at: '2026-03-11 10:00:00',
  ...over,
});

// A baseline with every metric ready at the given medians (sleepBaseline's shape).
const USUAL = { asleep: 600, efficiency: 0.8, wake_count: 4, longest_share: 0.4, settle_minutes: 20, stir_rate: 1, onset_clock: 450, wake_clock: 1110 };
const baselineOf = (medians = USUAL, n = 7) => ({
  nights: n,
  metrics: Object.fromEntries(Object.entries(medians).map(([k, median]) => [k, { median, n, ready: n >= 7 }])),
});
const score = (night, baseline = baselineOf(), age = 36) => scoreNight(toScoringInput(night, { nowMs: NOW }), baseline, age);
const comp = (result, key) => result.components.find((c) => c.key === key);
const term = (result, key) => comp(result, 'continuity').terms.find((t) => t.key === key);

describe('the curves and the whole score', () => {
  test('duration falls in a straight line between the anchors: 45 minutes under usual is 75, not 100 or 50', () => {
    const at = (asleep) => comp(score(stored({ asleep_minutes: asleep })), 'duration').score;
    assert.equal(at(600), 100);
    assert.equal(at(640), 100); // more than usual is not better than usual
    assert.equal(at(555), 75);
    assert.equal(at(510), 50);
    assert.equal(at(435), 25);
    assert.equal(at(360), 0);
    assert.equal(at(100), 0);
  });

  test('a full night: every component, its weight, and the weighted mean of the rounded parts', () => {
    const r = score(stored());
    // efficiency 600/750 = 0.8 -> 50 + 35 * (0.10/0.15) = 73.3; longest 300/750 = 0.4 -> 75 + 25 * (0.05/0.25) = 80;
    // 4 wakes -> 80. Continuity = 0.5*73 + 0.3*80 + 0.2*80 = 76.5 -> 77.
    assert.deepEqual(comp(r, 'continuity').terms.map((t) => [t.key, t.score]), [['efficiency', 73], ['longest_share', 80], ['wake_count', 80]]);
    assert.deepEqual(r.components.map((c) => [c.key, c.score, c.weight, c.available]), [
      ['duration', 100, 35, true],
      ['continuity', 77, 30, true],
      ['settling', 100, 15, true], // 20 minutes
      ['restlessness', 100, 15, true], // 2 per hour, usual 1, floor 2: no excess
      ['consistency', 100, 5, true],
    ]);
    assert.equal(r.score, 93); // (3500 + 2310 + 1500 + 1500 + 500) / 100 = 93.1
    assert.equal(r.band, 'great');
    assert.equal(r.version, SCORE_VERSION);
    assert.equal(r.capped_by, null);
    assert.deepEqual([comp(r, 'duration').value, comp(r, 'duration').usual], [600, 600]);
  });

  // A broken night: half the span awake, no stretch to speak of, 22 wakes. Efficiency 0.5 -> 10; longest
  // 30/600 = 0.05 -> 3.6 -> 4; wakes -> 0. Continuity = 5 + 1.2 + 0 = 6.2 -> 6.
  const BROKEN = { asleep_minutes: 300, awake_minutes: 300, longest_stretch_minutes: 30, wake_count: 22, stir_minutes: 10 };
  const usual300 = baselineOf({ ...USUAL, asleep: 300 });

  test('weakest-link cap: the score cannot exceed continuity + 40, and says what capped it', () => {
    const r = score(stored(BROKEN), usual300);
    assert.equal(comp(r, 'continuity').score, 6);
    // Uncapped: (3500 + 180 + 1500 + 1500 + 500) / 100 = 71.8 -> 72, a "Good" night with five hours awake.
    assert.equal(r.score, 46);
    assert.equal(r.capped_by, 'continuity');
    assert.equal(r.band, null);
  });

  test('weakest-link cap: restlessness + 40 too, and the LOWER of the two ceilings is the one named', () => {
    // 110 stir minutes in 10 hours asleep = 11 per hour; usual 1, floor 2: 9 over, past the curve's end -> 0.
    const restless = score(stored({ stir_minutes: 110 }));
    assert.equal(comp(restless, 'restlessness').score, 0);
    assert.equal(restless.score, 40); // uncapped (3500 + 2310 + 1500 + 0 + 500) / 100 = 78
    assert.equal(restless.capped_by, 'restlessness');

    // Both low: continuity 6 allows 46, restlessness 0 allows 40. 55 stir minutes in 5 hours = 11 per hour.
    const both = score(stored({ ...BROKEN, stir_minutes: 55 }), usual300);
    assert.deepEqual([comp(both, 'continuity').score, comp(both, 'restlessness').score], [6, 0]);
    assert.equal(both.score, 40);
    assert.equal(both.capped_by, 'restlessness');
  });

  test('weakest-link cap: duration + 40 too, so twenty unbroken minutes is not a middling night', () => {
    // 20 minutes asleep against a usual 600: duration 0. Nothing else is wrong with it: no wakes, one stretch, no
    // stirring. Uncapped: (0 + 3000 + 1500 + 1500 + 500) / 100 = 65.
    const r = score(stored({ asleep_minutes: 20, awake_minutes: 0, wake_count: 0, longest_stretch_minutes: 20, stir_minutes: 0 }));
    assert.deepEqual([comp(r, 'duration').score, comp(r, 'continuity').score, comp(r, 'restlessness').score], [0, 100, 100]);
    assert.equal(r.score, 40);
    assert.equal(r.capped_by, 'duration');
  });

  test('a missing put-down drops settling and rescales the rest: it is not scored as zero', () => {
    // A 90-minute settle scores 0 and counts: (3500 + 2310 + 0 + 1500 + 500) / 100 = 78.1.
    const slow = score(stored({ in_bed_at: '2026-03-10 18:00:00' }));
    assert.deepEqual([comp(slow, 'settling').score, slow.score], [0, 78]);
    // The same night with no put-down: (3500 + 2310 + 1500 + 500) / 85 = 91.9. (The plan's known limit.)
    const none = score(stored({ in_bed_at: null }));
    assert.deepEqual([comp(none, 'settling').available, comp(none, 'settling').reason, comp(none, 'settling').score], [false, 'no_in_bed', null]);
    assert.equal(none.score, 92);
  });

  test('band edges', () => {
    assert.deepEqual([85, 84, 70, 69, 55, 54].map(bandFor), ['great', 'good', 'good', 'fair', 'fair', null]);
    // And through scoreNight: everything perfect except a 90-minute settle is exactly 85; with the time asleep
    // also 51 minutes off usual (onset 60, wake 100 -> consistency 80) it is 84.
    const perfect = { awake_minutes: 0, wake_count: 0, longest_stretch_minutes: 600, in_bed_at: '2026-03-10 18:00:00' };
    const a = score(stored(perfect), baselineOf({ ...USUAL, efficiency: 1, longest_share: 1 }));
    assert.deepEqual([a.score, a.band], [85, 'great']);
    const b = score(stored(perfect), baselineOf({ ...USUAL, efficiency: 1, longest_share: 1, onset_clock: 399 }));
    assert.deepEqual([comp(b, 'consistency').score, b.score, b.band], [80, 84, 'good']);
  });
});

describe('when there is no score, and the age figure', () => {
  test('no score: a night that is not ok, in progress, or promoted from empty', () => {
    assert.deepEqual(score(stored({ status: 'empty' })), { score: null, reason: 'not_ok', version: SCORE_VERSION, status: 'empty' });
    // A stored row whose window is still open (an admin store of tonight).
    const open = scoreNight(toScoringInput(stored(), { nowMs: Date.UTC(2026, 2, 11, 6, 59) }), baselineOf(), 36);
    assert.equal(open.reason, 'in_progress');
    assert.equal(scoreNight(toScoringInput(stored(), { nowMs: Date.UTC(2026, 2, 11, 7, 0) }), baselineOf(), 36).score, 93);
    // A fresh compute says so itself.
    assert.equal(scoreNight(toScoringInput({ ...stored(), in_progress: true }, { context: CONTEXT, nowMs: NOW }), baselineOf(), 36).reason, 'in_progress');
    // asScoredFromEmpty's shape: `ok`, zero wakes, one stretch as long as the span, none of it measured.
    const promoted = stored({ algo_status: 'empty', corrected: true, awake_minutes: 0, wake_count: 0, longest_stretch_minutes: 600 });
    assert.deepEqual(score(promoted), { score: null, reason: 'promoted_from_empty', version: SCORE_VERSION });
  });

  test('no score without a duration reference: no baseline and no birthday; a negative age is no birthday', () => {
    const none = baselineOf(USUAL, 6); // six values: nothing is ready
    assert.equal(score(stored(), none, null).reason, 'no_duration_reference');
    assert.equal(score(stored(), none, -3).reason, 'no_duration_reference');
    assert.equal(score(stored(), null, null).reason, 'no_duration_reference');
    // With a usual duration, a missing birthday does not stop the score (the night equals its usual throughout).
    assert.equal(score(stored(), baselineOf(), null).score, 100);
  });

  test('the age figure: used from 12 months, refused at 11; an early estimate carries no band word', () => {
    const none = baselineOf(USUAL, 6);
    assert.equal(score(stored(), none, 11).reason, 'under_12_months_no_baseline');
    // At 12 months: 11.7 h = 702 minutes in bed. That is a time in bed, so it is compared with the SPAN (asleep +
    // awake = 500 + 100 = 600), never the 500 asleep: 102 under -> 50 - 50 * (12/150) = 46. Against the 500 asleep
    // it would be 202 under -> 13.
    const short = { asleep_minutes: 500, awake_minutes: 100, longest_stretch_minutes: 240 };
    const r = score(stored(short), none, 12);
    assert.deepEqual([comp(r, 'duration').value, comp(r, 'duration').usual, comp(r, 'duration').score, comp(r, 'duration').basis], [600, 702, 46, 'span_vs_age']);
    // Continuity: efficiency 500/600 = 0.833 -> 81; longest 240/600 = 0.4 -> 80; 4 wakes -> 80: 80.5 -> 81 (rounded
    // terms 81, 80, 80 -> 80.5). Restlessness and consistency have no usual: (35*46 + 30*81 + 15*100) / 80 = 69.25.
    assert.deepEqual([comp(r, 'restlessness').reason, comp(r, 'consistency').reason], ['no_baseline', 'no_baseline']);
    assert.equal(r.score, 69);
    assert.equal(r.early_estimate, true);
    assert.equal(r.band, null); // 69 would be "fair"
    // With the usual ready the same night is not an early estimate, is judged on minutes asleep, and has its word.
    const ready = score(stored());
    assert.deepEqual([ready.early_estimate, ready.band, comp(ready, 'duration').basis, comp(ready, 'duration').value], [false, 'great', 'asleep_vs_usual', 600]);
  });

  test('no score for an ok night with zero minutes asleep (a correction can clamp the total to 0)', () => {
    assert.deepEqual(score(stored({ asleep_minutes: 0 })), { score: null, reason: 'no_sleep_measured', version: SCORE_VERSION });
    assert.equal(score(stored({ asleep_minutes: 1 })).score !== null, true);
  });

  test('age in whole months on the night: the day before the first birthday is 11, the birthday is 12', () => {
    assert.equal(ageMonthsOn('2025-03-11', '2026-03-10'), 11);
    assert.equal(ageMonthsOn('2025-03-11', '2026-03-11'), 12);
    assert.equal(ageMonthsOn('2026-06-01', '2026-03-10'), -3); // a future birthday: negative, never clamped to 0
    assert.equal(ageMonthsOn('', '2026-03-10'), null);
    assert.equal(ageMonthsOn('next spring', '2026-03-10'), null);
  });

  test('age figures are the source table, in minutes, joined by straight lines', () => {
    assert.equal(ageNightSleepMinutes(11), null);
    assert.equal(ageNightSleepMinutes(12), 702); // 11.7 h at 1 year
    assert.equal(ageNightSleepMinutes(36), 684); // 11.4 h at 3 years
    assert.equal(ageNightSleepMinutes(30), 687); // half way from 11.5 h (2 years) to 11.4 h (3 years)
    assert.equal(ageNightSleepMinutes(192), 474); // 7.9 h at 16 years
    assert.equal(ageNightSleepMinutes(240), 474); // held beyond the table
  });
});

describe('provisional and low confidence', () => {
  test('provisional: a stored row is final only when ITS computed_at is at least 3 hours past the window end', () => {
    const at = (computed_at, nowMs = NOW) => scoreNight(toScoringInput(stored({ computed_at }), { nowMs }), baselineOf(), 36).provisional;
    assert.equal(at('2026-03-11 09:59:00'), true); // although the clock (NOW) is long past the horizon
    assert.equal(at('2026-03-11 10:00:00'), false);
    // A corrected stored night is locked and never re-stored: final whatever its computed_at.
    const locked = stored({ computed_at: '2026-03-11 07:30:00', corrected: true, algo_onset_at: '2026-03-10 19:30:00', algo_wake_at: '2026-03-11 06:30:00', algo_in_bed_at: '2026-03-10 19:10:00' });
    assert.equal(score(locked).provisional, false);
    // ...unless it was stored while the night was still running: that row is not locked and will be re-stored.
    assert.equal(score({ ...locked, computed_at: '2026-03-11 06:59:00' }).provisional, true);
    assert.equal(score({ ...locked, computed_at: '2026-03-11 07:00:00' }).provisional, false);
  });

  test('provisional: a corrected FRESH compute is still judged on the clock (its detector figures are recomputed)', () => {
    const fresh = { ...stored(), in_progress: false, analysis_camera_id: 'cam-a', wake_unconfirmed: null, corrected: true, algo_onset_at: '2026-03-10 19:30:00', algo_wake_at: '2026-03-11 06:30:00' };
    delete fresh.computed_at;
    delete fresh.scoring_context;
    assert.equal(scoreNight(toScoringInput(fresh, { context: CONTEXT, nowMs: Date.UTC(2026, 2, 11, 9, 0, 0) }), baselineOf(), 36).provisional, true);
  });

  test('provisional: a fresh compute is final when it runs at or after the horizon', () => {
    const fresh = { ...stored(), in_progress: false, analysis_camera_id: 'cam-a', wake_unconfirmed: null };
    delete fresh.computed_at;
    delete fresh.scoring_context;
    const at = (nowMs) => scoreNight(toScoringInput(fresh, { context: CONTEXT, nowMs }), baselineOf(), 36).provisional;
    assert.equal(at(Date.UTC(2026, 2, 11, 9, 59, 59)), true);
    assert.equal(at(Date.UTC(2026, 2, 11, 10, 0, 0)), false);
  });

  test('low confidence: under 80% of the window watched', () => {
    const r = (coverage_minutes) => score(stored({ coverage_minutes }));
    assert.deepEqual([r(576).low_confidence, r(576).low_confidence_reasons], [false, []]); // exactly 80% of 720
    assert.deepEqual([r(575).low_confidence, r(575).low_confidence_reasons], [true, ['low_coverage']]);
    assert.equal(r(575).score, 93); // flagged, not marked down
  });

  test('more than 15 unwatched minutes: low confidence, the longest-stretch term dropped, and NO minute credited as sleep', () => {
    const at15 = score(stored({ unknown_minutes: 15 }));
    const at16 = score(stored({ unknown_minutes: 16 }));
    assert.deepEqual([at15.low_confidence, term(at15, 'longest_share').available], [false, true]);
    assert.deepEqual([at16.low_confidence, at16.low_confidence_reasons, at16.unwatched_minutes], [true, ['unwatched'], 16]);
    assert.deepEqual([term(at16, 'longest_share').available, term(at16, 'longest_share').reason], [false, 'unwatched']);
    // Continuity is then efficiency and wakes only: (0.5*73 + 0.2*80) / 0.7 = 75.
    assert.equal(comp(at16, 'continuity').score, 75);
    // Duration is the measured 600 in both: a version that topped up the unwatched minutes would read 616.
    assert.deepEqual([comp(at15, 'duration').value, comp(at16, 'duration').value], [600, 600]);
    // 200 unwatched minutes on a night 100 short of usual do not buy the duration back.
    // (100 under usual -> 50 - 50 * (10/150) = 46.7; crediting them would read 100.)
    assert.equal(comp(score(stored({ asleep_minutes: 500, unknown_minutes: 200 })), 'duration').score, 47);
    // Unwatched minutes say nothing against the stir count: restlessness stays.
    assert.equal(comp(at16, 'restlessness').available, true);
    // The longest stretch is a share of the WHOLE span, unwatched minutes included: 300/760 = 0.395 -> 79 (of the
    // watched 750 it would be 0.4 -> 80).
    assert.equal(term(score(stored({ unknown_minutes: 10 })), 'longest_share').score, 79);
    // A row from before the column existed (NULL) is read as no unwatched minutes, not as unknown.
    const old = score(stored({ unknown_minutes: null }));
    assert.deepEqual([old.low_confidence, old.unwatched_minutes, term(old, 'longest_share').available], [false, 0, true]);
  });

  test('low confidence: no confirmed wake (none at all, or an early exit the detector skipped)', () => {
    assert.deepEqual(score(stored({ wake_at: null })).low_confidence_reasons, ['wake_unconfirmed']);
    // Only the wake clock is in doubt: the time they fell asleep still counts towards consistency.
    assert.deepEqual(comp(score(stored({ wake_at: null })), 'consistency').terms.map((t) => [t.key, t.available]), [['onset', true], ['wake', false]]);
    assert.deepEqual(score(stored({ wake_unconfirmed_at: '2026-03-11 04:10:00' })).low_confidence_reasons, ['wake_unconfirmed']);
    // A wake the parent gave is confirmed by them, whatever the detector noted.
    const parentWake = stored({
      wake_unconfirmed_at: '2026-03-11 04:10:00', corrected: true, wake_at: '2026-03-11 06:40:00',
      algo_wake_at: '2026-03-11 06:30:00', algo_onset_at: '2026-03-10 19:30:00', algo_in_bed_at: '2026-03-10 19:10:00',
    });
    assert.equal(score(parentWake).low_confidence, false);
  });
});

describe('corrections and the put-down', () => {
  const ALGO = { corrected: true, algo_onset_at: '2026-03-10 19:30:00', algo_wake_at: '2026-03-11 06:30:00', algo_in_bed_at: '2026-03-10 19:10:00' };

  test('a corrected span drops the longest-stretch term and restlessness, and clamps the stretch shown', () => {
    // The parent moved the wake 3.5 hours earlier: applyCorrection re-derives asleep (here 300) and leaves the
    // detector's 500-minute stretch on the row, longer than the night it now sits in (#355).
    const night = stored({ ...ALGO, wake_at: '2026-03-11 03:00:00', asleep_minutes: 300, longest_stretch_minutes: 500 });
    const r = score(night);
    assert.deepEqual([term(r, 'longest_share').available, term(r, 'longest_share').reason], [false, 'span_corrected']);
    assert.deepEqual([comp(r, 'restlessness').available, comp(r, 'restlessness').reason], [false, 'span_corrected']);
    assert.equal(toScoringInput(night, { nowMs: NOW }).longest_stretch_display, 300);
    // A moved ONSET changes the span just as a moved wake does.
    const onsetMoved = score(stored({ ...ALGO, onset_at: '2026-03-10 20:30:00', asleep_minutes: 540 }));
    assert.deepEqual([term(onsetMoved, 'longest_share').reason, comp(onsetMoved, 'restlessness').reason], ['span_corrected', 'span_corrected']);
    // An in-bed-only correction changed no sleep time: both stay.
    const inBedOnly = score(stored({ ...ALGO, in_bed_at: '2026-03-10 19:05:00', in_bed_corrected: true }));
    assert.deepEqual([term(inBedOnly, 'longest_share').available, comp(inBedOnly, 'restlessness').available], [true, true]);
  });

  test('settling mirrors frontend/src/lib/inBed.js: hidden beside a corrected onset unless the parent gave the put-down too', () => {
    const settle = (over) => {
      const c = comp(score(stored(over)), 'settling');
      return [c.available, c.reason, c.value];
    };
    // The parent moved the onset; the put-down is still the detector's rejected estimate.
    assert.deepEqual(settle({ ...ALGO, onset_at: '2026-03-10 19:50:00' }), [false, 'in_bed_hidden', null]);
    // They gave the put-down as well: 19:05 to 19:50.
    assert.deepEqual(settle({ ...ALGO, onset_at: '2026-03-10 19:50:00', in_bed_at: '2026-03-10 19:05:00', in_bed_corrected: true }), [true, null, 45]);
    // A wake-only correction leaves the put-down and the onset one story.
    assert.deepEqual(settle({ ...ALGO, wake_at: '2026-03-11 06:00:00' }), [true, null, 20]);
  });

  test('settling mirrors inBed.js: a put-down less than a minute before sleep (or after it) is not a settle time', () => {
    const avail = (in_bed_at) => comp(score(stored({ in_bed_at })), 'settling');
    assert.deepEqual([avail('2026-03-10 19:29:01').available, avail('2026-03-10 19:29:01').reason], [false, 'in_bed_hidden']); // 59 s
    assert.deepEqual([avail('2026-03-10 19:29:00').available, avail('2026-03-10 19:29:00').value], [true, 1]); // 60 s
    assert.equal(avail('2026-03-10 19:30:40').available, false); // the put-down's own second, after the floored onset
  });
});

describe('what each component is judged against', () => {
  test('continuity under 12 months, or with no birthday, is judged against the usual only; from 12 months on fixed curves', () => {
    const night = stored({ wake_count: 6 });
    const usual = baselineOf({ ...USUAL, wake_count: 6 });
    // 6 wakes against a usual 6: nothing over. On the fixed curve 6 wakes is 80 - 30 * (2/6) = 70.
    assert.deepEqual([term(score(night, usual, 11), 'wake_count').score, term(score(night, usual, 12), 'wake_count').score], [100, 70]);
    assert.equal(term(score(night, usual, null), 'wake_count').score, 100);
    // Efficiency 0.8 against a usual 0.9: 0.1 under -> 50 (the fixed curve gives 73).
    assert.equal(term(score(night, baselineOf({ ...USUAL, efficiency: 0.9 }), 11), 'efficiency').score, 50);
    // A baby with a usual duration but no usual for any continuity figure: the component is dropped, not guessed.
    const durationOnly = { nights: 7, metrics: { asleep: { median: 600, n: 7, ready: true }, efficiency: { median: 0.8, n: 6, ready: false } } };
    const r = score(night, durationOnly, 11);
    assert.deepEqual([comp(r, 'continuity').available, comp(r, 'continuity').reason], [false, 'no_baseline']);
    assert.equal(r.capped_by, null);
  });

  test('a wake count under the floor is not marked down against a usual of none', () => {
    const usual = baselineOf({ ...USUAL, wake_count: 0 });
    assert.equal(term(score(stored({ wake_count: 1 }), usual, 11), 'wake_count').score, 100);
    // 4 wakes against max(0, floor 1): 3 over -> 50.
    assert.equal(term(score(stored({ wake_count: 4 }), usual, 11), 'wake_count').score, 50);
    // Above the floor the usual itself is the allowance, no more: 6 wakes against a usual 3 is 3 over -> 50.
    assert.equal(term(score(stored({ wake_count: 6 }), baselineOf({ ...USUAL, wake_count: 3 }), 11), 'wake_count').score, 50);
  });

  test('judged against the usual, a SHORTER longest stretch is the worse one', () => {
    // Tonight's longest stretch is 0.4 of the span. Usual 0.55: 0.15 short -> 50. Usual 0.25: better than usual -> 100.
    const share = (usual) => term(score(stored(), baselineOf({ ...USUAL, longest_share: usual }), 11), 'longest_share').score;
    assert.deepEqual([share(0.55), share(0.25)], [50, 100]);
  });

  test('restlessness is the excess over max(usual, floor), per hour asleep, and needs a ready usual', () => {
    const rest = (stir_minutes, stir_rate, n = 7) => comp(score(stored({ stir_minutes }), baselineOf({ ...USUAL, stir_rate }, n)), 'restlessness');
    // 20 minutes in 10 hours = 2 per hour. Usual 0.5 is under the floor of 2: no excess (excess over usual alone
    // would be 1.5 -> 75).
    assert.equal(rest(20, 0.5).score, 100);
    // 70 minutes = 7 per hour against a usual 4: 3 over -> 50.
    assert.deepEqual([rest(70, 4).score, rest(70, 4).value, rest(70, 4).usual], [50, 7, 4]);
    // A night stored before the stir count existed.
    assert.deepEqual([rest(null, 4).available, rest(null, 4).reason], [false, 'missing']);
  });

  test('a metric with six values behind it is not a usual: the component is unavailable, the others still score', () => {
    const b = baselineOf();
    b.metrics.stir_rate = { median: 4, n: 6, ready: false };
    b.metrics.onset_clock = { median: 450, n: 6, ready: false };
    const r = score(stored({ stir_minutes: 70 }), b);
    assert.deepEqual([comp(r, 'restlessness').available, comp(r, 'restlessness').reason], [false, 'no_baseline']);
    // Consistency still has the wake clock, on time: 100.
    assert.deepEqual(comp(r, 'consistency').terms.map((t) => [t.key, t.available]), [['onset', false], ['wake', true]]);
    assert.equal(comp(r, 'consistency').score, 100);
    assert.equal(r.early_estimate, false);
  });

  test('consistency: each clock time against its usual, averaged', () => {
    // Asleep 19:30 against a usual 18:30 (60 minutes late -> 50); up 06:30 against 06:30 (-> 100).
    const r = score(stored(), baselineOf({ ...USUAL, onset_clock: 390 }));
    assert.deepEqual(comp(r, 'consistency').terms.map((t) => [t.key, t.value, t.usual, t.score]), [['onset', 450, 390, 50], ['wake', 1110, 1110, 100]]);
    assert.equal(comp(r, 'consistency').score, 75);
  });
});

describe('one input for a stored row and a fresh compute', () => {
  // The same night as computeNight returns it: `in_progress`, the camera it used, the skipped exit as an object,
  // and neither `computed_at` nor `scoring_context`.
  const fresh = (over = {}) => {
    const n = { ...stored(), in_progress: false, analysis_camera_id: 'cam-a', wake_unconfirmed: null, ...over };
    delete n.computed_at;
    delete n.scoring_context;
    delete n.wake_unconfirmed_at;
    return n;
  };

  test('a fresh compute handed the context it ran with scores exactly as the stored row does', () => {
    const a = score(stored());
    const b = scoreNight(toScoringInput(fresh(), { context: CONTEXT, nowMs: NOW }), baselineOf(), 36);
    assert.deepEqual(b, a);
    assert.equal(toScoringInput(fresh(), { context: CONTEXT, nowMs: NOW }).from_stored, false);
    assert.equal(toScoringInput(stored(), { nowMs: NOW }).from_stored, true);
  });

  test('the context is never guessed: a fresh compute without one has no timezone, so no clock times', () => {
    const input = toScoringInput(fresh(), { nowMs: NOW });
    assert.equal(input.context, null);
    const r = scoreNight(input, baselineOf(), 36);
    assert.deepEqual([comp(r, 'consistency').available, comp(r, 'consistency').reason], [false, 'no_timezone']);
  });

  test('a fresh compute: the camera is the one the figures came from, and a skipped early exit is an unconfirmed wake', () => {
    const input = toScoringInput(fresh({ analysis_camera_id: 'cam-b', wake_unconfirmed: { at: '2026-03-11 04:10:00', lead_min: 170, threshold_min: 60 } }), { context: CONTEXT, nowMs: NOW });
    assert.equal(input.context.camera_id, 'cam-b');
    assert.equal(input.wake_confirmed, false);
    assert.equal(input.metrics.usual_asleep.usable, false);
    assert.equal(input.metrics.asleep.usable, true); // still scored tonight, only kept out of "usual"
  });

  test('a stored row from before scoring_context has no context, and garbage in the column reads the same', () => {
    assert.equal(toScoringInput(stored({ scoring_context: null }), { nowMs: NOW }).context, null);
    assert.equal(toScoringInput(stored({ scoring_context: '{"v":2}' }), { nowMs: NOW }).context, null);
  });
});

describe('clock times', () => {
  test('clock minutes are wall-clock minutes since noon in the given zone, on a night the clocks move too', () => {
    // Europe/Berlin put its clocks forward at 02:00 on 2026-03-29. Asleep 19:30 on the 28th (UTC+1) and up 07:00
    // on the 29th (UTC+2) are 18:30 and 05:00 UTC.
    assert.equal(clockMinutesSinceNoon('2026-03-28 18:30:00', 'Europe/Berlin'), 450);
    // Minutes ELAPSED since local noon would say 1080 (the night was an hour short); reading the UTC clock, 1020.
    assert.equal(clockMinutesSinceNoon('2026-03-29 05:00:00', 'Europe/Berlin'), 1140);
    // The same instants in a zone behind UTC: 14:30 and 01:00 in New York (UTC-4).
    assert.equal(clockMinutesSinceNoon('2026-03-28 18:30:00', 'America/New_York'), 150);
    assert.equal(clockMinutesSinceNoon('2026-03-29 05:00:00', 'America/New_York'), 780);
    assert.equal(clockMinutesSinceNoon('2026-10-03 12:00:00', 'UTC'), 0);
    assert.equal(clockMinutesSinceNoon(null, 'UTC'), null);
  });

  test('consistency measures the shorter way round the clock: a usual 11:50 and a 12:10 are 20 minutes apart', () => {
    // The number line wraps at noon: 11:50 is 1430, 12:10 is 10. Twenty minutes -> 100 - 50 * (5/45) = 94; read as
    // 1420 minutes it would be 0.
    const r = score(stored({ wake_at: '2026-03-11 12:10:00' }), baselineOf({ ...USUAL, wake_clock: 1430 }));
    const wake = comp(r, 'consistency').terms.find((t) => t.key === 'wake');
    assert.deepEqual([wake.value, wake.usual, wake.score], [10, 1430, 94]);
  });

  test('the config is frozen: a caller cannot retune the score in passing', () => {
    assert.throws(() => { SCORE_CONFIG.cap_margin = 100; }, TypeError);
    assert.throws(() => { SCORE_CONFIG.duration.curve[0][1] = 0; }, TypeError);
  });
});
