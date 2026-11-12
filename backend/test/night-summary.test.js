// The night summary's selection (src/lib/nightSummary.js; sleep score plan, phase 3). The words are the browser's
// (frontend/test/nightSummaryPhrases.test.js); the routes that return the summary are checked in
// sleep-score-routes.test.js (every shape, the switch, a failing summary).
//
// EVERY TEST HERE HAS A PRECONDITION AND A LITERAL EXPECTED VALUE, and each sits on a boundary or between two plausible
// implementations:
//   the headline class follows the score's parts at each edge ........ "headline class: ..."
//   an early estimate's headline ignores the overall score .......... "an early estimate ..."
//   a night with no score / promoted from empty / in progress ........ "promoted from empty ...", "in progress ...", "no score ..."
//   a null parameter is never selected ............................... "an observation with a null parameter ..."
//   "about the same as usual" margins, both sides of each ............ "the margins ..."
//   no summary_facts: no fact-based observation, no throw ............ "a night with no summary_facts ..."
//   wake clustering: the window edge, and "most" ..................... "wake clustering ..."
//   wakes outside a corrected span are filtered ...................... "wakes outside the corrected span ..."
//   a span moved past the tolerance: no wake-count / longest ......... "a time moved by 16 minutes ..." (15 keeps them)
//   reduced coverage at 80% and 15 unwatched minutes ................. "reduced coverage ..."
//   the cap and the order are deterministic .......................... "at most four ...", "the same input twice ..."
//   not-ok nights: one plain line, nothing judgemental ............... "a night that is not ok ..."
//
// ⚠️ Fixture ids are made up: the repo is public.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

// sleepScore.js imports sleepAnalysis.js, which opens the database.
useTempDataDir();
const { default: db } = await import('../src/db.js');
const { scoreNight, toScoringInput, SCORE_CONFIG } = await import('../src/lib/sleepScore.js');
const { selectSummary, SUMMARY_CONFIG } = await import('../src/lib/nightSummary.js');
const { OBSERVATION_PARAMS, HEADLINE_KEYS } = await import('../src/lib/nightSummaryKeys.js');

after(() => {
  try { db.close(); } catch { /* already closed */ }
  cleanupTempDataDirs();
});

const CONTEXT = { v: 1, camera_id: 'cam-a', tz: 'UTC', window: { start: '19:00', end: '07:00' }, algo: '6' };
const NOW = Date.UTC(2026, 2, 12, 12, 0, 0); // well after the fixture night
const CHILD = 'kid-a';

const facts = (wakes, roomActivityWakes = 0, climate = { temp_min: null, temp_max: null }) =>
  JSON.stringify({ v: 1, climate, sleep: { wakes, room_activity_wakes: roomActivityWakes } });
const wakeAt = (hhmm, minutes = 5, day = '2026-03-11') => ({ start_at: `${day} ${hhmm}:00`, minutes });

// A STORED row: 19:00 to 07:00 UTC, asleep 19:30, up 06:30, put down 19:10 (a 20-minute settle), fully watched, final.
const stored = (over = {}) => ({
  child_id: CHILD,
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
  summary_facts: null,
  ...over,
});

// A baseline with every metric ready at the given medians (sleepBaseline's shape).
const USUAL = { asleep: 600, efficiency: 0.8, wake_count: 4, longest_share: 0.4, settle_minutes: 20, stir_rate: 1, onset_clock: 450, wake_clock: 1110 };
const baselineOf = (medians = USUAL, n = 7) => ({
  nights: n,
  metrics: Object.fromEntries(Object.entries(medians).map(([k, median]) => [k, { median, n, ready: n >= 7 }])),
});

// The real score of a night, and the summary of it: nothing here is faked but the baseline.
function summarise(night, { baseline = baselineOf(), age = 36, nowMs = NOW } = {}) {
  const input = toScoringInput(night, { nowMs });
  const score = scoreNight(input, baseline, age);
  return selectSummary(night, score, { childId: CHILD, input });
}
const keys = (summary) => summary.observations.map((o) => o.key);
const obs = (summary, key) => summary.observations.find((o) => o.key === key);

// A score with chosen part scores, to put the headline's thresholds on their edges without hunting for a night that
// lands there. Only what the headline reads is filled in.
const fakeScore = ({ continuity = 90, restlessness = null, overall = 90, early = false, continuityAvailable = true } = {}) => ({
  score: overall,
  band: early ? null : 'great',
  early_estimate: early,
  components: [
    { key: 'duration', score: 90, available: true, value: 600, usual: 600, basis: 'asleep_vs_usual' },
    { key: 'continuity', score: continuityAvailable ? continuity : null, available: continuityAvailable, terms: [] },
    { key: 'restlessness', score: restlessness, available: restlessness != null },
  ],
});
const headlineOf = (score, night = stored()) =>
  selectSummary(night, score, { childId: CHILD, input: toScoringInput(night, { nowMs: NOW }) }).headline.key;

describe('the headline class follows the score', () => {
  test('headline class: each edge, one point either side (continuity and restlessness decide, the overall score must reach its band)', () => {
    // Precondition: the thresholds are the ones these literals are written against, and the overall edges ARE the
    // score's band edges (a retuned band moves the headline with it).
    assert.deepEqual(
      [SUMMARY_CONFIG.headline.unsettled_below, SUMMARY_CONFIG.headline.settled.min_part, SUMMARY_CONFIG.headline.typical.min_part,
        SUMMARY_CONFIG.headline.settled.min_overall, SUMMARY_CONFIG.headline.typical.min_overall],
      [50, 80, 65, 85, 70]
    );
    assert.deepEqual(SCORE_CONFIG.bands.map((b) => b.min), [85, 70, 55], 'precondition: the band edges 85 and 70 are the headline edges');
    const cases = [
      // [continuity, restlessness, overall, expected]
      [80, null, 85, 'settled'], [79, null, 95, 'typical'], [80, null, 84, 'typical'],
      [65, null, 70, 'typical'], [64, null, 95, 'mixed'], [65, null, 69, 'mixed'],
      [50, null, 95, 'mixed'], [49, null, 95, 'unsettled'],
      [100, 80, 95, 'settled'], [100, 79, 95, 'typical'], [100, 50, 95, 'mixed'], [100, 49, 95, 'unsettled'],
      // The weakest of the two decides: a fine continuity does not rescue a restless night.
      [100, 64, 95, 'mixed'],
    ];
    for (const [continuity, restlessness, overall, expected] of cases) {
      assert.equal(headlineOf(fakeScore({ continuity, restlessness, overall })), expected, `continuity ${continuity}, restlessness ${restlessness}, overall ${overall}`);
    }
  });

  test('a short night with unbroken sleep (overall low, continuity high) is "mixed", never "unsettled": only waking and stirring can say that', () => {
    assert.equal(headlineOf(fakeScore({ continuity: 100, overall: 30 })), 'mixed');
    assert.equal(headlineOf(fakeScore({ continuity: 100, overall: 54 })), 'mixed');
  });

  test('an early estimate: the overall score is not consulted (continuity 80 is "settled" at an overall 10), and the continuity edge still applies', () => {
    assert.equal(headlineOf(fakeScore({ continuity: 80, overall: 10, early: true })), 'settled');
    assert.equal(headlineOf(fakeScore({ continuity: 79, overall: 99, early: true })), 'typical');
    assert.equal(headlineOf(fakeScore({ continuity: 49, overall: 99, early: true })), 'unsettled');
  });

  test('no continuity part to judge by: the neutral line, not a class', () => {
    assert.equal(headlineOf(fakeScore({ continuityAvailable: false })), 'neutral_last_night');
  });

  test('a real scored night: the usual night of the fixture has continuity 77 and a score of 93, so "typical"; the same night with no wakes is "settled"', () => {
    // Precondition: the real score, by hand (sleep-score.test.js "a full night"): continuity 77, overall 93.
    const night = stored();
    const score = scoreNight(toScoringInput(night, { nowMs: NOW }), baselineOf(), 36);
    assert.deepEqual([score.score, score.components.find((c) => c.key === 'continuity').score], [93, 77]);
    assert.equal(summarise(night).headline.key, 'typical');
    // 750 minutes watched, 700 asleep, 50 awake, one 5-minute wake, a 650-minute stretch: continuity is high.
    const calm = stored({ asleep_minutes: 700, awake_minutes: 50, wake_count: 1, longest_stretch_minutes: 650 });
    assert.equal(summarise(calm).headline.key, 'settled');
  });
});

describe('nights with no judgement to make', () => {
  test('promoted from empty: the neutral headline and only the total and the times, even beside a "great" score and hostile facts', () => {
    // The parent typed two times over an empty bed (sleepReviews.js asScoredFromEmpty): 0 wakes and one stretch were
    // never measured. Every field that could leak a claim is planted: wakes, room activity, a climate, a usual.
    const night = stored({
      status: 'ok', algo_status: 'empty', corrected: true, algo_onset_at: null, algo_wake_at: null,
      asleep_minutes: 540, awake_minutes: 0, wake_count: 0, longest_stretch_minutes: 540, stir_minutes: null,
      summary_facts: facts([wakeAt('01:00'), wakeAt('01:10'), wakeAt('01:20')], 3, { temp_min: 19, temp_max: 21 }),
    });
    const input = toScoringInput(night, { nowMs: NOW });
    assert.equal(input.promoted_from_empty, true, 'precondition: the night reads as promoted');
    // A caller that handed over a "great" score (it cannot happen: scoreNight refuses) must still not get "settled".
    const greedy = selectSummary(night, fakeScore({ continuity: 100, restlessness: 100, overall: 99 }), { childId: CHILD, input });
    const real = summarise(night);
    for (const s of [greedy, real]) {
      assert.deepEqual(s, {
        headline: { key: 'neutral_last_night' },
        observations: [
          { key: 'times_entered_by_hand', params: {} },
          { key: 'total_sleep', params: { minutes: 540 } },
          { key: 'sleep_span', params: { onset_at: '2026-03-10 19:30:00', wake_at: '2026-03-11 06:30:00' } },
        ],
        seed: 'kid-a|2026-03-10',
      });
    }
  });

  test('in progress: the "so far" headline and no observations, whatever the night holds', () => {
    const night = stored({ summary_facts: facts([wakeAt('01:00'), wakeAt('01:10'), wakeAt('01:20')], 3, { temp_min: 19, temp_max: 21 }) });
    const before = Date.UTC(2026, 2, 11, 2, 0, 0); // 02:00, inside the window
    assert.equal(toScoringInput(night, { nowMs: before }).in_progress, true, 'precondition: the window is still open');
    const s = summarise(night, { nowMs: before });
    assert.deepEqual(s, { headline: { key: 'neutral_so_far' }, observations: [], seed: 'kid-a|2026-03-10' });
    // A fresh compute says so itself.
    assert.deepEqual(selectSummary({ ...night, in_progress: true }, { score: null, reason: 'in_progress' }, { childId: CHILD }).headline,
      { key: 'neutral_so_far' });
  });

  test('no score for want of a reference: the neutral headline, the plain facts, and the line that there is no usual yet', () => {
    // No baseline and no birthday: scoreNight answers no_duration_reference.
    const night = stored();
    const score = scoreNight(toScoringInput(night, { nowMs: NOW }), baselineOf(USUAL, 0), null);
    assert.equal(score.reason, 'no_duration_reference', 'precondition');
    const s = summarise(night, { baseline: baselineOf(USUAL, 0), age: null });
    assert.equal(s.headline.key, 'neutral_last_night');
    assert.deepEqual(s.observations, [
      { key: 'building_baseline', params: {} },
      { key: 'total_sleep', params: { minutes: 600 } },
      { key: 'wake_ups', params: { count: 4 } },
      { key: 'longest_stretch', params: { minutes: 300 } },
    ]);
  });

  test('an early estimate: the class comes from continuity, the "building a usual" line leads, and no comparison with a usual is made', () => {
    const night = stored();
    const early = scoreNight(toScoringInput(night, { nowMs: NOW }), baselineOf(USUAL, 3), 36);
    assert.deepEqual([early.early_estimate, early.band], [true, null], 'precondition: an early estimate');
    const s = summarise(night, { baseline: baselineOf(USUAL, 3) });
    assert.equal(s.headline.key, 'typical'); // continuity 77 against the age curves
    assert.deepEqual(keys(s), ['building_baseline', 'total_sleep', 'wake_ups', 'longest_stretch']);
  });

  test('a night that is not ok: one plain line and nothing judgemental; off and no data have no summary at all', () => {
    const base = stored();
    const plainLine = (over) => selectSummary({ ...base, ...over }, { score: null, reason: 'not_ok' }, { childId: CHILD });
    assert.deepEqual(plainLine({ status: 'no_sleep' }).observations, [{ key: 'no_sleep_detected', params: {} }]);
    assert.deepEqual(plainLine({ status: 'empty' }).observations, [{ key: 'no_sleep_detected', params: {} }]);
    assert.deepEqual(plainLine({ status: 'empty', nobody_in_bed: true }).observations, [{ key: 'nobody_in_bed', params: {} }]);
    for (const status of ['no_sleep', 'empty']) assert.equal(plainLine({ status }).headline.key, 'neutral_last_night');
    for (const status of ['off', 'no_data', 'something_new', undefined]) assert.equal(plainLine({ status }), null, String(status));
    assert.equal(selectSummary(null, null), null);
    // An ok night whose total a correction clamped to zero measured no sleep.
    assert.deepEqual(summarise(stored({ asleep_minutes: 0 })).observations, [{ key: 'no_sleep_detected', params: {} }]);
  });
});

describe('what is selected, and when', () => {
  test('the usual night: four comparisons by the fixed order, each with its literal params ("about the same" on every side)', () => {
    const s = summarise(stored());
    assert.deepEqual(s, {
      headline: { key: 'typical' },
      observations: [
        { key: 'total_sleep_vs_usual', params: { minutes: 600, usual_minutes: 600, direction: 'about_the_same' } },
        { key: 'wake_ups_vs_usual', params: { count: 4, usual_count: 4, direction: 'about_the_same' } },
        { key: 'longest_stretch_vs_usual', params: { minutes: 300, direction: 'about_the_same' } },
        { key: 'settling_time', params: { minutes: 20 } },
      ],
      seed: 'kid-a|2026-03-10',
    });
  });

  test('the margins: 30 minutes of 600, one wake-up, five points of the stretch share: the edge is "the same", one step past is not', () => {
    const dir = (night, key) => obs(summarise(night), key).params.direction;
    // Asleep. Margin = max(20, 5% of 600 = 30).
    assert.deepEqual([570, 630, 569, 631].map((m) => dir(stored({ asleep_minutes: m }), 'total_sleep_vs_usual')),
      ['about_the_same', 'about_the_same', 'less', 'more']);
    // Wake-ups against a usual of 4: one either way is the same.
    assert.deepEqual([3, 5, 2, 6].map((n) => dir(stored({ wake_count: n }), 'wake_ups_vs_usual')),
      ['about_the_same', 'about_the_same', 'less', 'more']);
    // Longest stretch: share of the 750-minute span against a usual 0.4; 337 is 0.4493, 338 is 0.4507.
    assert.deepEqual([337, 338, 263, 262].map((m) => dir(stored({ longest_stretch_minutes: m }), 'longest_stretch_vs_usual')),
      ['about_the_same', 'more', 'about_the_same', 'less']);
  });

  test('a comparison that is not "about the same" outranks every plain fact and the biggest deviation leads', () => {
    // 450 asleep (150 under: 25%), 8 wakes against 4 (100%): the wake-up line leads, the total follows, then the ties.
    const s = summarise(stored({ asleep_minutes: 450, wake_count: 8 }));
    assert.deepEqual(keys(s).slice(0, 2), ['wake_ups_vs_usual', 'total_sleep_vs_usual']);
    assert.deepEqual(obs(s, 'wake_ups_vs_usual').params, { count: 8, usual_count: 4, direction: 'more' });
    assert.deepEqual(obs(s, 'total_sleep_vs_usual').params, { minutes: 450, usual_minutes: 600, direction: 'less' });
  });

  test('an observation with a null parameter is never selected: each missing figure drops its own line and nothing else', () => {
    const withTemps = (min, max) => facts([], 0, { temp_min: min, temp_max: max });
    // A night with so little else that the range is not cut by the cap: precondition, both ends present, it is selected.
    const only = (night) => selectSummary(night, { score: null, reason: 'no_duration_reference' }, { childId: CHILD });
    const bare = { wake_count: null, longest_stretch_minutes: null, in_bed_at: null };
    assert.deepEqual(obs(only(stored({ summary_facts: withTemps(19.2, 21.7), ...bare })), 'temperature_range').params,
      { min_c: 19.2, max_c: 21.7 });
    // A null at either end drops the line; a null wake count, stretch and put-down drop theirs.
    assert.equal(obs(only(stored({ summary_facts: withTemps(null, 21.7), ...bare })), 'temperature_range'), undefined);
    const none = only(stored({ summary_facts: withTemps(19.2, null), ...bare }));
    assert.deepEqual(keys(none), ['building_baseline', 'total_sleep'], 'no temperature range (a null end), no wake-ups, no stretch, no settling');
    // A usual that is ready for the total but missing for the wake-ups falls back to the plain wake-up line.
    const noWakeUsual = summarise(stored(), { baseline: baselineOf({ ...USUAL, wake_count: undefined }) });
    assert.deepEqual(obs(noWakeUsual, 'wake_ups').params, { count: 4 });
    assert.equal(obs(noWakeUsual, 'wake_ups_vs_usual'), undefined);
  });

  test('every selected observation carries exactly the params its key declares (the table the phrase library is tested against)', () => {
    const night = stored({ summary_facts: facts([wakeAt('01:00'), wakeAt('01:30'), wakeAt('02:00')], 2, { temp_min: 18, temp_max: 22 }) });
    const all = [summarise(night), summarise(stored({ coverage_minutes: 500 })), summarise(night, { baseline: baselineOf(USUAL, 3) })];
    const seen = new Set();
    for (const s of all) {
      assert.ok(HEADLINE_KEYS.includes(s.headline.key));
      for (const o of s.observations) {
        seen.add(o.key);
        assert.deepEqual(Object.keys(o.params).sort(), [...OBSERVATION_PARAMS[o.key]].sort(), o.key);
      }
    }
    assert.ok(seen.size >= 6, `precondition: several different keys were exercised (${[...seen]})`);
  });

  test('at most four observations, and the same input twice gives byte-identical output', () => {
    // Six candidates: a cluster, room activity, the four comparisons and the temperatures.
    const night = stored({ summary_facts: facts([wakeAt('01:00'), wakeAt('01:30'), wakeAt('02:00'), wakeAt('05:00')], 2, { temp_min: 18, temp_max: 22 }) });
    const first = summarise(night);
    assert.equal(first.observations.length, SUMMARY_CONFIG.max_observations);
    assert.equal(SUMMARY_CONFIG.max_observations, 4);
    assert.deepEqual(keys(first), ['wake_clustering', 'room_activity_near_wakes', 'total_sleep_vs_usual', 'wake_ups_vs_usual']);
    assert.equal(JSON.stringify(summarise(night)), JSON.stringify(first));
    assert.equal(JSON.stringify(summarise(structuredClone(night))), JSON.stringify(first));
  });

  test('the seed is (child, night date): the same on every read, different between nights and children', () => {
    const a = summarise(stored());
    assert.equal(a.seed, 'kid-a|2026-03-10');
    assert.equal(summarise(stored({ night_date: '2026-03-09' })).seed, 'kid-a|2026-03-09');
    const input = toScoringInput(stored(), { nowMs: NOW });
    assert.equal(selectSummary(stored(), fakeScore(), { childId: 'kid-b', input }).seed, 'kid-b|2026-03-10');
  });
});

describe('summary_facts: nights stored after 2026-11-11 carry them, older nights do not', () => {
  test('a night with no summary_facts (or ones this code cannot read) selects no fact-based observation and does not throw', () => {
    const factBased = ['wake_clustering', 'room_activity_near_wakes', 'temperature_range'];
    const bad = [null, undefined, 'not json', JSON.stringify({ v: 2, climate: { temp_min: 1, temp_max: 2 }, sleep: null }), '{}',
      JSON.stringify({ v: 1, climate: null, sleep: null }), JSON.stringify({ v: 1, climate: {}, sleep: { wakes: 'x' } })];
    for (const raw of bad) {
      const s = summarise(stored({ summary_facts: raw }));
      assert.deepEqual(keys(s).filter((k) => factBased.includes(k)), [], String(raw));
      assert.equal(s.headline.key, 'typical', String(raw));
    }
    // And the key is simply absent from the object, as on a stored row from before the column.
    const row = stored();
    delete row.summary_facts;
    assert.deepEqual(keys(summarise(row)).filter((k) => factBased.includes(k)), []);
  });

  test('wake clustering: three wake-ups inside 90 minutes of the first is a cluster (the edge counts), 91 minutes is not; "most" is MORE than half', () => {
    const third = (hhmm) => summarise(stored({ wake_count: 4, summary_facts: facts([wakeAt('01:00'), wakeAt('01:30'), wakeAt(hhmm, 7), wakeAt('05:00')]) }));
    // 01:00 + 90 minutes = 02:30. Precondition: the literal below is the cluster's end (02:30 plus 7 minutes).
    assert.deepEqual(obs(third('02:30'), 'wake_clustering').params, { count: 3, from_at: '2026-03-11 01:00:00', to_at: '2026-03-11 02:37:00' });
    assert.equal(obs(third('02:31'), 'wake_clustering'), undefined);
    // Three of six is exactly half: not "most". Three of five is.
    const six = summarise(stored({ wake_count: 6, summary_facts: facts([wakeAt('01:00'), wakeAt('01:20'), wakeAt('01:40'), wakeAt('04:00'), wakeAt('05:00'), wakeAt('06:00')]) }));
    assert.equal(obs(six, 'wake_clustering'), undefined);
    const five = summarise(stored({ wake_count: 5, summary_facts: facts([wakeAt('01:00'), wakeAt('01:20'), wakeAt('01:40'), wakeAt('04:00'), wakeAt('05:00')]) }));
    assert.equal(obs(five, 'wake_clustering').params.count, 3);
    // Two wake-ups close together are not a pattern.
    const two = summarise(stored({ wake_count: 2, summary_facts: facts([wakeAt('01:00'), wakeAt('01:10')]) }));
    assert.equal(obs(two, 'wake_clustering'), undefined);
    // The densest window wins: wake-ups at 01:00 (x1), 03:00, 03:20, 03:40, 04:00.
    const late = summarise(stored({ wake_count: 5, summary_facts: facts([wakeAt('01:00'), wakeAt('03:00'), wakeAt('03:20'), wakeAt('03:40'), wakeAt('04:00')]) }));
    assert.deepEqual(obs(late, 'wake_clustering').params, { count: 4, from_at: '2026-03-11 03:00:00', to_at: '2026-03-11 04:05:00' });
    // ...and the EARLIEST on a tie. 01:00, 01:30, 02:00 is three; 01:30, 02:00, 02:35 is three too (02:35 is 95 minutes
    // after 01:00, so the first window cannot hold it): the first one is said.
    const tie = summarise(stored({ wake_count: 4, summary_facts: facts([wakeAt('01:00'), wakeAt('01:30'), wakeAt('02:00'), wakeAt('02:35')]) }));
    assert.deepEqual(obs(tie, 'wake_clustering').params, { count: 3, from_at: '2026-03-11 01:00:00', to_at: '2026-03-11 02:05:00' });
  });

  test('room activity near wake-ups: needs at least two wake-ups and at least one with movement; never more than the wake-ups', () => {
    const run = (wakes, room) => summarise(stored({ wake_count: wakes.length, summary_facts: facts(wakes, room) }));
    const two = [wakeAt('01:00'), wakeAt('03:00')];
    assert.deepEqual(obs(run(two, 1), 'room_activity_near_wakes').params, { count: 1, wakes: 2 });
    assert.equal(obs(run(two, 0), 'room_activity_near_wakes'), undefined);
    assert.equal(obs(run([wakeAt('01:00')], 1), 'room_activity_near_wakes'), undefined, 'a single wake-up: never "1 of the 1"');
    assert.equal(obs(run(two, 3), 'room_activity_near_wakes'), undefined, 'more than the wake-ups cannot be right');
  });

  test('the temperature range is raw degrees Celsius, both ends, and is the lowest-ranked fact', () => {
    const night = stored({ summary_facts: facts([], 0, { temp_min: 19.25, temp_max: 21.5 }), wake_count: null, longest_stretch_minutes: null, in_bed_at: null });
    assert.deepEqual(obs(summarise(night), 'temperature_range').params, { min_c: 19.25, max_c: 21.5 });
  });
});

describe('a correction by a parent', () => {
  // The wake-ups: three close together at 01:00 to 01:45, and three after 06:20 (the corrected wake). Without the
  // correction that is three of six, which is not "most"; with the late ones filtered it is three of three.
  const WAKES = [wakeAt('01:00'), wakeAt('01:20'), wakeAt('01:45'), wakeAt('06:22', 3), wakeAt('06:25', 3), wakeAt('06:28', 2)];
  const corrected = (wake, over = {}) => stored({
    corrected: true, wake_given: true, wake_at: `2026-03-11 ${wake}:00`, algo_wake_at: '2026-03-11 06:30:00', algo_onset_at: '2026-03-10 19:30:00',
    wake_count: 6, summary_facts: facts(WAKES, 2), ...over,
  });

  test('wakes outside the corrected span are filtered before any wake-based line is chosen (and the room-activity count, which cannot be re-split, goes)', () => {
    const uncorrected = summarise(stored({ wake_count: 6, summary_facts: facts(WAKES, 2) }));
    // Precondition: with all six, three is half, so no cluster, and the room-activity count is there.
    assert.equal(obs(uncorrected, 'wake_clustering'), undefined);
    assert.deepEqual(obs(uncorrected, 'room_activity_near_wakes').params, { count: 2, wakes: 6 });
    const s = summarise(corrected('06:20'));
    assert.deepEqual(obs(s, 'wake_clustering').params, { count: 3, from_at: '2026-03-11 01:00:00', to_at: '2026-03-11 01:50:00' });
    assert.equal(obs(s, 'room_activity_near_wakes'), undefined);
  });

  test('a wake-up that begins at the corrected time up is outside the span (the end is exclusive)', () => {
    // 05:50, 06:00 and 06:15 are three close together. The parent gave 06:15 as the time up: the third begins as they got up.
    const wakes = [wakeAt('01:00'), wakeAt('05:50'), wakeAt('06:00'), wakeAt('06:15')];
    const uncorrected = summarise(stored({ wake_count: 4, summary_facts: facts(wakes, 0) }));
    assert.deepEqual(obs(uncorrected, 'wake_clustering').params, { count: 3, from_at: '2026-03-11 05:50:00', to_at: '2026-03-11 06:20:00' });
    const night = stored({
      corrected: true, wake_given: true, wake_at: '2026-03-11 06:15:00', algo_wake_at: '2026-03-11 06:30:00', algo_onset_at: '2026-03-10 19:30:00',
      wake_count: 4, summary_facts: facts(wakes, 0),
    });
    assert.equal(toScoringInput(night, { nowMs: NOW }).span_moved_minutes, 15, 'precondition: inside the tolerance, so wake-up lines are still chosen');
    assert.equal(obs(summarise(night), 'wake_clustering'), undefined);
  });

  test('wakes before a corrected onset are dropped too', () => {
    // The parent moved the time asleep from 19:30 to 19:40: a wake at 19:35 is no longer in the night.
    const early = [wakeAt('19:35', 3, '2026-03-10'), wakeAt('01:00'), wakeAt('01:20'), wakeAt('01:45')];
    const night = stored({
      corrected: true, onset_at: '2026-03-10 19:40:00', algo_onset_at: '2026-03-10 19:30:00', wake_at: '2026-03-11 06:30:00',
      algo_wake_at: '2026-03-11 06:30:00', wake_count: 4, summary_facts: facts(early, 1),
    });
    const s = summarise(night);
    assert.deepEqual(obs(s, 'wake_clustering').params, { count: 3, from_at: '2026-03-11 01:00:00', to_at: '2026-03-11 01:50:00' });
    assert.equal(obs(s, 'room_activity_near_wakes'), undefined);
  });

  test('a time moved by 15 minutes keeps the wake-up and stretch lines; moved by 16 minutes selects none of them (and neither do the facts built on wakes)', () => {
    const at15 = summarise(corrected('06:15'));
    const at16 = summarise(corrected('06:14'));
    assert.equal(toScoringInput(corrected('06:15'), { nowMs: NOW }).span_moved_minutes, 15, 'precondition: a 15-minute move');
    assert.equal(toScoringInput(corrected('06:14'), { nowMs: NOW }).span_moved_minutes, 16, 'precondition: a 16-minute move');
    assert.equal(SCORE_CONFIG.correction_span_tolerance_minutes, 15, 'precondition: the tolerance these literals are written against');
    const wakeBased = ['wake_ups', 'wake_ups_vs_usual', 'longest_stretch', 'longest_stretch_vs_usual', 'wake_clustering', 'room_activity_near_wakes'];
    assert.deepEqual(keys(at16).filter((k) => wakeBased.includes(k)), []);
    assert.deepEqual(keys(at16), ['total_sleep_vs_usual', 'settling_time']);
    assert.ok(keys(at15).includes('wake_ups_vs_usual') || keys(at15).includes('wake_clustering'), keys(at15).join());
    // Check the stretch line on its own, since the cap can cut it from the full list above.
    const lean = (wake) => summarise(corrected(wake, { summary_facts: null, wake_count: 4 }));
    assert.deepEqual(keys(lean('06:15')), ['total_sleep_vs_usual', 'wake_ups_vs_usual', 'longest_stretch_vs_usual', 'settling_time']);
    assert.deepEqual(keys(lean('06:14')), ['total_sleep_vs_usual', 'settling_time']);
  });

  test('a time given where the detector had none counts as moved: no wake-up or stretch line', () => {
    const night = stored({ corrected: true, wake_given: true, wake_at: '2026-03-11 06:30:00', algo_wake_at: null, wake_count: 4 });
    assert.equal(toScoringInput(night, { nowMs: NOW }).span_moved_minutes, Infinity, 'precondition');
    assert.deepEqual(keys(summarise(night)).filter((k) => k.startsWith('wake_ups') || k.startsWith('longest')), []);
  });
});

describe('reduced coverage', () => {
  test('coverage at 80% of the window is fine, a minute under is not: the neutral headline, the coverage line first, and no comparison with a usual', () => {
    const ok = summarise(stored({ coverage_minutes: 576 })); // 576 / 720 = 0.8
    assert.equal(obs(ok, 'reduced_coverage'), undefined);
    assert.equal(ok.headline.key, 'typical');
    const short = summarise(stored({ coverage_minutes: 575 }));
    assert.equal(short.headline.key, 'neutral_last_night');
    assert.deepEqual(short.observations[0], { key: 'reduced_coverage', params: { coverage_percent: 80, unwatched_minutes: 0 } });
    assert.deepEqual(keys(short).filter((k) => k.endsWith('_vs_usual')), []);
    assert.deepEqual(keys(short), ['reduced_coverage', 'total_sleep', 'wake_ups', 'longest_stretch']);
  });

  test('15 unwatched minutes are fine, 16 are not, whatever the coverage', () => {
    assert.equal(obs(summarise(stored({ unknown_minutes: 15 })), 'reduced_coverage'), undefined);
    const s = summarise(stored({ unknown_minutes: 16 }));
    assert.deepEqual(obs(s, 'reduced_coverage').params, { coverage_percent: 100, unwatched_minutes: 16 });
    assert.equal(s.headline.key, 'neutral_last_night');
    // The stretch counter was reset by the gap, so the score drops it and so does the summary.
    assert.deepEqual(keys(s).filter((k) => k.startsWith('longest')), []);
  });

  test('a coverage that cannot be worked out is "reduced" for the headline, but the line is not selected (its figure is missing)', () => {
    const s = summarise(stored({ coverage_minutes: null }));
    assert.equal(s.headline.key, 'neutral_last_night');
    assert.equal(obs(s, 'reduced_coverage'), undefined);
  });
});
