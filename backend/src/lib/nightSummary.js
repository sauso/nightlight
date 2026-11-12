// ★ THE NIGHT SUMMARY: which facts to say about a night (sleep score plan, phase 3; planning/sleep-score-plan.md,
// Design 5).
//
// selectSummary(night, score, ctx) returns { headline: { key }, observations: [{ key, params }], seed } and nothing
// else: KEYS and RAW PARAMETERS, no wording at all. The sentences live in the browser
// (frontend/src/lib/nightSummaryPhrases.js), which picks a variant from `seed` and the key. Keeping words out of the
// server means a retuned phrase needs no server release, a tab left open across a deploy cannot show a stale
// sentence, and a later LLM phase can reword the same facts.
//
// PURE. No database read, no clock, no randomness: the same night and score give the same answer, byte for byte. The
// route glue (lib/sleepScoreAttach.js) hands over the night, its score and the normalised scoring input it already
// built, so nothing here is worked out twice and the "usual" the score used is the "usual" the summary quotes.
//
// THE RULES THAT SHAPE EVERYTHING BELOW, each a decision and not an accident:
//   1. DESCRIPTIVE ONLY. Facts that were measured, and how they compare with this child's own recent nights. No cause,
//      no advice, no praise or blame. (The phrase library enforces the same in its own tests.)
//   2. THE HEADLINE CAN NEVER CONTRADICT THE SCORE. Its class (settled / typical / mixed / unsettled) is derived from
//      the score's own component scores, with thresholds that sit on the score's band edges (SUMMARY_CONFIG.headline).
//      It is worked out even when the child's "Show sleep score" switch hides the score: the switch hides the number,
//      not the description of the night.
//   3. A NIGHT WITH NO SCORE GETS A NEUTRAL HEADLINE and only plain measured facts, never a judgement. Two cases
//      matter most: a night still in progress (nothing to judge yet), and a night a parent promoted from "empty" by
//      typing two times (its zero wake-ups and its one unbroken stretch were never measured, so "settled" or "no
//      wake-ups" would be invented, plan Design 5).
//   4. AN OBSERVATION WITH A NULL PARAMETER IS NEVER SELECTED. A figure that is missing or was judged unusable is left
//      out, not shown as "null" or guessed (`observation()` is the one place an observation is built).
//   5. A CORRECTED NIGHT IS HANDLED BY THE SCORE'S OWN RULES, not a copy of them: wakes outside the parent's span are
//      dropped, and when a correction moved a time by more than SCORE_CONFIG.correction_span_tolerance_minutes the
//      detector's wake-up and longest-stretch figures describe a different span and are not quoted at all.
//
// ⚠️ EVERY NUMBER IN SUMMARY_CONFIG IS A STARTING VALUE, tuned by reading nights on one household's cameras. A
// threshold set on one room is a hypothesis about every other (CLAUDE.md, "Building for someone else's house"); each
// says where it came from. Nothing here assumes a timezone, a clock format, a temperature unit or a locale: times go
// out as stored UTC strings and temperatures as degrees Celsius, and the browser formats them.

import { SCORE_CONFIG, toScoringInput } from './sleepScore.js';
import { parseSummaryFacts } from './sleepAnalysis.js';
import { OBSERVATION_PARAMS } from './nightSummaryKeys.js';

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}

// A band's lower edge from the score's own config, so the headline thresholds follow a retuned band instead of
// quietly disagreeing with it (a headline "settled" over a score that no longer reads "Great").
const bandEdge = (band) => SCORE_CONFIG.bands.find((b) => b.band === band).min;

export const SUMMARY_CONFIG = deepFreeze({
  headline: {
    // The headline is read off the child's CONTINUITY part score and, when there is one, the RESTLESSNESS part score
    // (both 0 to 100, SCORE_CONFIG): the two parts that are about waking and stirring, which is what the four
    // headline sentences describe. The weakest of them decides, so a night with one bad part cannot read "settled".
    //   unsettled  the weakest part is under 50. On every curve in SCORE_CONFIG a part score of 50 is the anchor
    //              "clearly worse than ordinary" (efficiency 0.70, ten wakes, 3 stir minutes an hour over usual).
    //              Only these two parts can say "unsettled": a short night with unbroken sleep has a low OVERALL score
    //              (the duration cap) and must not be described as one with a lot of waking.
    //   settled    the weakest part is 80 or more AND the overall score is in the top band. 80 is above the "ordinary"
    //              end of every continuity curve (efficiency 0.85 scores 85).
    //   typical    the weakest part is 65 or more AND the overall score reaches the second band.
    //   mixed      everything in between, including a night whose parts are fine but whose overall score is low.
    // The overall score's edges ARE the score's band edges. On an EARLY ESTIMATE (no usual yet; the score carries no
    // band word) the overall score is not consulted: it rests on an age figure of a different quantity, and a
    // headline must not claim more than the band word does.
    unsettled_below: 50,
    settled: { min_part: 80, min_overall: bandEdge('great') },
    typical: { min_part: 65, min_overall: bandEdge('good') },
  },

  // "About the same as usual": a night inside these margins of the child's median is not "more" or "less". Starting
  // values, set by eye on one house's nights; nothing measured them.
  //   asleep: the larger of 20 minutes and 5% of the usual (30 minutes on a ten-hour usual): a night's total moves
  //     that much with nothing to tell.
  //   wake_count: one wake-up either way (a count is a whole number and a camera's count wobbles by one).
  //   longest_share: 5 points of the share of the span (about half an hour of a ten-hour night).
  same_as_usual: { asleep_minutes: 20, asleep_fraction: 0.05, wake_count: 1, longest_share: 0.05 },

  // WAKE CLUSTERING: most of a night's wake-ups inside one window. The window opens at a wake-up and is 90 minutes long
  // (about one sleep cycle in an infant; a judgement, not a measurement). "Most" is MORE THAN HALF of all the night's
  // wake-ups, and at least 3 of them: two wake-ups close together are not a pattern.
  cluster: { window_minutes: 90, min_wakes: 3 },

  // How notable each observation is, highest first. The 2 to 4 shown are the most notable available; a tie goes to
  // the key that comes first in OBSERVATION_PARAMS, so the order is the same on every read.
  //   - a comparison that is NOT "about the same" outranks every plain fact, biggest deviation first
  //     (`vs_usual_base` plus the deviation as a percentage, capped at `deviation_cap`);
  //   - a gap in what was watched outranks a comparison: what follows is built on less than the whole night;
  //   - a plain fact has a fixed rank. Settling is raised when it took longer than the score's own "ordinary" (the
  //     first anchor of SCORE_CONFIG.settling).
  notability: {
    reduced_coverage: 160,
    vs_usual_base: 100,
    deviation_cap: 50,
    wake_clustering: 90,
    building_baseline: 85,
    room_activity_near_wakes: 80,
    vs_usual_same: 60,
    settling_time_long: 50,
    total_sleep: 40,
    wake_ups: 38,
    longest_stretch: 36,
    settling_time: 30,
    temperature_range: 20,
  },
  max_observations: 4,
});

const KEY_ORDER = Object.freeze(Object.keys(OBSERVATION_PARAMS));

const utcMs = (s) => (typeof s === 'string' && s ? Date.parse(`${s.replace(' ', 'T')}Z`) : NaN);
const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// The ONE place an observation is built. Its params must be exactly the key's declared ones
// (nightSummaryKeys.js), so the browser's phrase library, which is tested against the same table, can rely on them; and
// any param that is null, undefined or not a finite number (a string is allowed for a time or a direction) means the
// observation is not selected (rule 4). A key that is not in the table, or params of the wrong shape, is a bug in
// THIS file and throws, which the route glue turns into `summary: null` rather than a wrong sentence.
function observation(key, params = {}) {
  const declared = OBSERVATION_PARAMS[key];
  if (!declared) throw new Error(`night summary: unknown observation key ${key}`);
  const names = Object.keys(params);
  if (names.length !== declared.length || !declared.every((n) => names.includes(n))) {
    throw new Error(`night summary: ${key} params do not match the declared set`);
  }
  for (const v of Object.values(params)) {
    if (v == null || (typeof v === 'number' && !Number.isFinite(v)) || (typeof v !== 'number' && typeof v !== 'string')) return null;
  }
  return { key, params };
}

// 'more' | 'less' | 'about_the_same'. `margin` is the largest gap still counted as the same.
const direction = (value, usual, margin) => (Math.abs(value - usual) <= margin ? 'about_the_same' : value > usual ? 'more' : 'less');

const component = (score, key) => (Array.isArray(score?.components) ? score.components.find((c) => c && c.key === key) : null);
const term = (comp, key) => (Array.isArray(comp?.terms) ? comp.terms.find((t) => t && t.key === key) : null);
const usable = (c) => Boolean(c) && c.available === true && finite(c.value) && finite(c.usual);

// The headline class from the score's parts (SUMMARY_CONFIG.headline). Null when the continuity part could not be
// scored: nothing to judge the night on, so the caller falls back to the neutral line.
function headlineClass(score) {
  const H = SUMMARY_CONFIG.headline;
  const continuity = component(score, 'continuity');
  if (!continuity || !continuity.available || !finite(continuity.score)) return null;
  const restlessness = component(score, 'restlessness');
  const weakest = restlessness && restlessness.available && finite(restlessness.score)
    ? Math.min(continuity.score, restlessness.score)
    : continuity.score;
  const overall = score.early_estimate ? null : score.score;
  if (weakest < H.unsettled_below) return 'unsettled';
  if (weakest >= H.settled.min_part && (overall == null || overall >= H.settled.min_overall)) return 'settled';
  if (weakest >= H.typical.min_part && (overall == null || overall >= H.typical.min_overall)) return 'typical';
  return 'mixed';
}

// The night's COUNTED wake-ups from `summary_facts.sleep`, with a correction's span applied. Null when there are none
// to read (an older night, a night with no measured sleep, text that does not parse, an entry that does not look like
// a wake). `dropped` is how many the span removed.
//   A parent's time correction can leave wake-ups outside the span they gave (before the time asleep, or at or after
//   the time up). Those were never in the child's night as the parent describes it, so they are filtered out BEFORE any
//   wake-based observation is chosen (rule 5). An uncorrected night is as the detector measured it, wakes inside its
//   own span by construction, and is not filtered.
function countedWakes(facts, input, night) {
  const raw = facts?.sleep?.wakes;
  if (!Array.isArray(raw)) return null;
  const wakes = [];
  for (const w of raw) {
    if (!w || typeof w.start_at !== 'string' || !finite(w.minutes) || !Number.isFinite(utcMs(w.start_at))) return null;
    wakes.push({ start_at: w.start_at, minutes: w.minutes, ms: utcMs(w.start_at) });
  }
  if (!input.corrected) return { wakes, dropped: 0 };
  const from = utcMs(night.onset_at);
  const to = night.wake_at ? utcMs(night.wake_at) : Infinity;
  if (!Number.isFinite(from) || Number.isNaN(to)) return null;
  const kept = wakes.filter((w) => w.ms >= from && w.ms < to);
  return { wakes: kept, dropped: wakes.length - kept.length };
}

// More than half of the wake-ups, at least `min_wakes` of them, inside one window that opens at a wake-up. The window
// with the most wake-ups wins; the earliest on a tie. Returns { count, from_at, to_at } (the first one's start to the
// last one's end), or null.
function wakeCluster(wakes) {
  const { window_minutes: windowMin, min_wakes: minWakes } = SUMMARY_CONFIG.cluster;
  if (wakes.length < minWakes) return null;
  const sorted = [...wakes].sort((a, b) => a.ms - b.ms);
  let best = null;
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].ms - sorted[i].ms <= windowMin * 60000) j++;
    const count = j - i + 1;
    if (!best || count > best.count) best = { count, i, j };
  }
  if (best.count < minWakes || best.count * 2 <= sorted.length) return null;
  const last = sorted[best.j];
  return { count: best.count, from_at: sorted[best.i].start_at, to_at: sqlAt(last.ms + last.minutes * 60000) };
}

const neutral = (key, observations, seed) => ({ headline: { key }, observations, seed });

// The summary for one night, or null when there is nothing to describe (tracking off, or no data: the page already
// says so and a summary line would add noise).
//   night   the night object the endpoint returns: a stored row or a fresh compute, with a correction laid over it.
//   score   scoreNight's result for it (a number, or { score: null, reason }), or null when none could be worked out.
//           It is the score WHETHER OR NOT the child's switch shows it: the summary reads it, the response may omit it.
//   ctx     { childId, input }: `input` is toScoringInput(night) as the score was made from it (worked out here when
//           not given); `childId` only feeds the seed. The seed is (child, night date): stable across reads, so the
//           browser's chosen wording does not change when the page refetches, and different between nights.
export function selectSummary(night, score, ctx = {}) {
  if (!night || typeof night !== 'object') return null;
  if (night.status !== 'ok' && night.status !== 'no_sleep' && night.status !== 'empty') return null;
  const input = ctx.input ?? toScoringInput(night, { context: ctx.context ?? null, nowMs: ctx.nowMs ?? Date.now() });
  if (!input) return null;
  const seed = `${ctx.childId ?? ''}|${night.night_date ?? ''}`;
  const keep = (list) => list.filter(Boolean);

  // A night still in progress: nothing to judge and nothing is final. The headline alone.
  if (input.in_progress) return neutral('neutral_so_far', [], seed);

  if (night.status === 'no_sleep') return neutral('neutral_last_night', keep([observation('no_sleep_detected')]), seed);
  if (night.status === 'empty') {
    // `nobody_in_bed` is its own flag (sleepReviews.js): a parent's statement, which is not the same thing as the
    // detector having watched an empty bed, so it gets its own sentence.
    return neutral('neutral_last_night', keep([observation(night.nobody_in_bed ? 'nobody_in_bed' : 'no_sleep_detected')]), seed);
  }

  const asleep = input.metrics.asleep;
  // Nothing measured as slept (a total of zero, which a correction can leave on a night that stays `ok`).
  if (!asleep.usable || asleep.value <= 0) return neutral('neutral_last_night', keep([observation('no_sleep_detected')]), seed);

  // PROMOTED FROM "EMPTY" (rule 3): the parent's two times, and the total they imply. Nothing else: its wake-ups and
  // stretch were not measured, and neither was the settling.
  if (input.promoted_from_empty) {
    return neutral('neutral_last_night', keep([
      observation('times_entered_by_hand'),
      observation('total_sleep', { minutes: asleep.value }),
      observation('sleep_span', { onset_at: night.onset_at ?? null, wake_at: night.wake_at ?? null }),
    ]), seed);
  }

  const cfg = SUMMARY_CONFIG;
  const N = cfg.notability;
  const m = input.metrics;
  const hasScore = Boolean(score) && finite(score.score);
  const facts = parseSummaryFacts(night.summary_facts);

  // The camera did not watch enough of the window, or part of the sleep was not observed (the same two lines the
  // score calls low confidence: SCORE_CONFIG.low_confidence). A coverage that cannot be worked out counts as short.
  const lowCoverage = input.coverage_frac == null || input.coverage_frac < SCORE_CONFIG.low_confidence.min_coverage;
  const unwatched = input.unknown_minutes > SCORE_CONFIG.low_confidence.max_unwatched_minutes;
  const reduced = lowCoverage || unwatched;

  // A time moved by more than the tolerance: the detector's wake-up count, wake list and longest stretch describe
  // another span (rule 5). Reuses the score's own figures, not a second copy of the rule.
  const spanMoved = input.span_moved_minutes > SCORE_CONFIG.correction_span_tolerance_minutes;

  const candidates = []; // { obs, rank }
  const add = (obs, rank) => { if (obs) candidates.push({ obs, rank }); };
  // A comparison with the child's usual: ranked by how far it is from usual, "about the same" ranks as a plain fact.
  const addVs = (obs, deviation) => {
    if (!obs) return;
    const same = obs.params.direction === 'about_the_same';
    add(obs, same ? N.vs_usual_same : N.vs_usual_base + Math.min(N.deviation_cap, Math.round(deviation * 100)));
  };

  // --- Total asleep, with the usual beside it when there is one. Not when part of the night was unwatched: the
  // total is then an under-count (the score scores it anyway, so as not to credit minutes nobody saw) and "less than
  // usual" would state a difference that may be only the missing minutes; the coverage line says so instead.
  const duration = component(score, 'duration');
  const durationVs = hasScore && !score.early_estimate && !reduced && usable(duration) && duration.basis === 'asleep_vs_usual' ? duration : null;
  if (durationVs) {
    const S = cfg.same_as_usual;
    const margin = Math.max(S.asleep_minutes, S.asleep_fraction * durationVs.usual);
    addVs(observation('total_sleep_vs_usual', {
      minutes: durationVs.value, usual_minutes: durationVs.usual, direction: direction(durationVs.value, durationVs.usual, margin),
    }), Math.abs(durationVs.value - durationVs.usual) / durationVs.usual);
  } else add(observation('total_sleep', { minutes: asleep.value }), N.total_sleep);

  // --- Wake-ups and the longest stretch: the detector's figures for ITS span, so not after a correction that moved
  // a time past the tolerance (and not on a night where the stretch counter was reset by an unwatched gap: the
  // score already marks that metric unusable).
  if (!spanMoved) {
    const continuity = component(score, 'continuity');
    const wakeTerm = hasScore && !reduced ? term(continuity, 'wake_count') : null;
    if (m.wake_count.usable) {
      if (usable(wakeTerm)) {
        const S = cfg.same_as_usual;
        addVs(observation('wake_ups_vs_usual', {
          count: m.wake_count.value, usual_count: wakeTerm.usual, direction: direction(m.wake_count.value, wakeTerm.usual, S.wake_count),
        }), Math.abs(m.wake_count.value - wakeTerm.usual) / Math.max(wakeTerm.usual, 1));
      } else add(observation('wake_ups', { count: m.wake_count.value }), N.wake_ups);
    }
    if (m.longest_stretch.usable) {
      const shareTerm = hasScore && !reduced ? term(continuity, 'longest_share') : null;
      if (usable(shareTerm)) {
        const S = cfg.same_as_usual;
        addVs(observation('longest_stretch_vs_usual', {
          minutes: m.longest_stretch.value, direction: direction(shareTerm.value, shareTerm.usual, S.longest_share),
        }), Math.abs(shareTerm.value - shareTerm.usual) / Math.max(shareTerm.usual, 0.1));
      } else add(observation('longest_stretch', { minutes: m.longest_stretch.value }), N.longest_stretch);
    }
  }

  // --- Settling: only where the score would have used the put-down (toScoringInput hides one the page hides).
  if (m.settle_minutes.usable) {
    const longSettle = m.settle_minutes.value > SCORE_CONFIG.settling.curve[0][0];
    add(observation('settling_time', { minutes: m.settle_minutes.value }), longSettle ? N.settling_time_long : N.settling_time);
  }

  // --- From `summary_facts` (nights stored from 2026-11-11; an older night has none and gets none of these).
  if (!spanMoved) {
    const counted = countedWakes(facts, input, night);
    if (counted) {
      const cluster = wakeCluster(counted.wakes);
      if (cluster) add(observation('wake_clustering', cluster), N.wake_clustering);
      // How many wake-ups had movement in the room around them is a count over ALL the night's wake-ups: once a
      // correction has dropped any of them, which ones had it is unknown, so the figure is not quoted. Needs at least
      // two wake-ups, so the sentence is never "1 of the 1".
      const roomWakes = facts.sleep.room_activity_wakes;
      if (counted.dropped === 0 && counted.wakes.length >= 2 && finite(roomWakes) && roomWakes >= 1 && roomWakes <= counted.wakes.length) {
        add(observation('room_activity_near_wakes', { count: roomWakes, wakes: counted.wakes.length }), N.room_activity_near_wakes);
      }
    }
  }
  const climate = facts?.climate;
  if (climate && finite(climate.temp_min) && finite(climate.temp_max)) {
    add(observation('temperature_range', { min_c: climate.temp_min, max_c: climate.temp_max }), N.temperature_range);
  }

  // --- What was not measured well.
  if (reduced) {
    add(observation('reduced_coverage', {
      coverage_percent: input.coverage_frac == null ? null : Math.round(input.coverage_frac * 100),
      unwatched_minutes: input.unknown_minutes,
    }), N.reduced_coverage);
  }
  // No usual yet: an early estimate, or no score for want of a reference.
  const noUsualYet = hasScore
    ? score.early_estimate === true
    : score?.reason === 'no_duration_reference' || score?.reason === 'under_12_months_no_baseline';
  if (noUsualYet) add(observation('building_baseline'), N.building_baseline);

  // --- The headline. A class only from a score, on a night that was watched well enough to judge.
  let headline = 'neutral_last_night';
  if (hasScore && !reduced) headline = headlineClass(score) ?? 'neutral_last_night';

  candidates.sort((a, b) => b.rank - a.rank || KEY_ORDER.indexOf(a.obs.key) - KEY_ORDER.indexOf(b.obs.key));
  return {
    headline: { key: headline },
    observations: candidates.slice(0, cfg.max_observations).map((c) => c.obs),
    seed,
  };
}
