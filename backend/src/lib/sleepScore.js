// ★ THE SLEEP SCORE: the scoring maths (sleep score plan, phase 1b; planning/sleep-score-plan.md, Design 1 and 4).
//
// A night gets a 0-100 score from five components, each compared with the child's own recent nights where the
// plan says so (lib/sleepBaseline.js) and with a fixed curve where it does not. Nothing here is stored. The sleep
// routes attach the result to every night they return (lib/sleepScoreAttach.js, phase 1c); no screen shows it yet.
// The score is worked out ON READ from the night object an
// endpoint is about to return, so it always agrees with the figures shown beside it, and a parent's correction or a
// retuned curve applies to every night at once with no backfill.
//
// TWO FUNCTIONS, AND WHY THERE ARE TWO:
//   toScoringInput(night)  turns a stored `sleep_nights` row OR a fresh computeNight result (each with or without the
//                          correction overlay) into ONE shape, and decides PER METRIC whether the figure may be used.
//   scoreNight(...)        is pure arithmetic on that shape.
// The baseline builds every earlier night through the SAME toScoringInput, so a figure this file refuses to score
// (a longest stretch on a night whose times a parent moved by more than the tolerance, a settling time the UI hides) can never become part
// of what "usual" means either. That is the whole reason eligibility lives here and not in the two callers.
//
// ⚠️ EVERY NUMBER IN SCORE_CONFIG IS A STARTING VALUE. The curves were tuned on two cameras in one house (see the
// notes beside each), which is a hypothesis about every other room, not a measurement of it. Scores are not
// comparable between children or rooms, and a change to any number here must bump SCORE_VERSION.
//
// What this file deliberately does NOT do: read the database (sleepBaseline.js does), word anything (the bands are
// keys, the client words them), or credit unwatched minutes as sleep.

import { parseScoringContext, isEvidenceFinal } from './sleepAnalysis.js';

// The formula's version, returned with every score so a client (and, later, a stored history) can tell two
// formulas apart. Bump it with ANY change to SCORE_CONFIG or to the rules below.
//   1: the first formula (phase 1b, never returned by any route).
//   2: a time correction drops restlessness and the longest-stretch term only when a time moved by more than
//      `correction_span_tolerance_minutes` (was: any change); a wake the parent confirmed unchanged is confirmed.
export const SCORE_VERSION = 2;

// NIGHT sleep by age, for a child with no baseline yet. Transcribed from Table 1 ("Numeric Percentile Values"),
// column "Nighttime Sleep Duration", sub-column "Mean", of:
//   Iglowstein I, Jenni OG, Molinari L, Largo RH. Sleep duration from infancy to adolescence: reference values and
//   generational trends. Pediatrics. 2003;111(2):302-307. doi:10.1542/peds.111.2.302
// Rows are [age in years, hours] exactly as printed, so the list can be checked against the paper line by line.
// The 0.5 and 0.75 year rows are left out: under 12 months this file never uses an age figure (see scoreNight).
//
// ⚠️ NOT THE SAME QUANTITY AS `asleep_minutes`, AND THE DIFFERENCE HAS A DIRECTION. The paper's Methods: parents
// were asked "When does the child go to bed usually?" and "When does the child wake up usually?", and "Nighttime
// sleep duration was calculated from bedtime and wake time". So these are parent-reported USUAL TIME IN BED at
// night, for 493 Swiss children born 1974-1993. `asleep_minutes` is one night's measured minutes asleep: it leaves
// out the time taken to fall asleep and every minute counted awake. A normal night therefore reads BELOW these
// figures, by more the more wake time the camera sees. So the age figure is NEVER compared with `asleep_minutes`:
// while it is the reference (an early estimate), duration is the night's whole span from falling asleep to waking
// (`span_minutes`), the nearest thing a camera has to "bedtime to wake time" (owner decision, 2026-11-12, after the
// first evidence run gave ordinary nights a duration score of 0 to 25 against it). Still not the same quantity (the
// span leaves out the time taken to fall asleep, and one night is not a "usual"), which is why a score made with it
// is marked `early_estimate` and carries no band word. Once the child's own usual is ready, duration is measured
// minutes asleep against usual minutes asleep, and this table is not read. The docs must say so with the feature.
export const AGE_NIGHT_SLEEP_HOURS = Object.freeze([
  [1, 11.7], [1.5, 11.6], [2, 11.5], [3, 11.4], [4, 11.2], [5, 11.1], [6, 10.9], [7, 10.7], [8, 10.4], [9, 10.2],
  [10, 9.9], [11, 9.6], [12, 9.3], [13, 9.0], [14, 8.6], [15, 8.3], [16, 7.9],
].map((row) => Object.freeze(row)));

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}

// ONE object holds every weight, anchor, edge and threshold, so tuning is one diff and one version bump. A curve is
// a list of [x, score] anchors, x ascending, joined by straight lines and flat beyond both ends: no steps anywhere,
// so one more minute never moves a score by more than a fraction of a point.
//
// WHERE THE NUMBERS CAME FROM. Unless a line says otherwise: a starting value, set by running
// scripts/sleep-score-evidence.mjs on snapshots of one household's two databases (the same two children and two
// cameras in both, so one sample, not two) and adjusting until scores spread across the range instead of piling up
// at either end. In that house the cameras were moved to a top-down view part-way through the data, and the same
// children then read about 7 to 16 counted wakes and 200 to 530 minutes asleep a night where they had read 0 to 5
// and 560 to 700; the person who runs it judges the later picture the truer one. The absolute curves below are set
// to spread scores across BOTH ranges. In another room, with another camera angle, they may sit too high or too
// low: that is the reason most components lean on the child's own baseline, and the reason for the docs' line that
// scores are not comparable between children or rooms.
export const SCORE_CONFIG = deepFreeze({
  // The plan's weights (owner decision): duration matters most, consistency least. They sum to 100; when a
  // component is unavailable it is dropped and the others keep their proportions.
  weights: { duration: 35, continuity: 30, settling: 15, restlessness: 15, consistency: 5 },

  // Weakest-link cap (plan, Design 4): the final score may not exceed continuity + this, nor restlessness + this,
  // nor duration + this. Without it a night with long stretches awake still reads "Good" on its duration and
  // settling alone. Duration joined the list on 2026-11-12 (owner decision): the first evidence run had `ok` nights
  // of 16 to 30 minutes scoring 40 to 55, because half an hour of unbroken sleep is perfectly continuous.
  cap_margin: 40,

  // Band edges, highest first (owner decision). Below the last edge there is no band word.
  bands: [{ min: 85, band: 'great' }, { min: 70, band: 'good' }, { min: 55, band: 'fair' }],

  // What "usual" is made from (plan, Design 3). sleepBaseline.js reads these.
  baseline: {
    max_nights: 14, // the newest qualifying nights used
    max_age_days: 28, // and none older than this
    min_values: 7, // a metric's median is ready only with at least this many usable values OF THAT METRIC
    min_coverage: 0.8, // a baseline night must have been watched for at least this share of its window
  },

  // When a score is flagged low-confidence. 15 unwatched minutes is also where the longest-stretch term is dropped
  // (a camera dropout resets the stretch counter) and where a night stops counting towards the usual duration.
  low_confidence: { min_coverage: 0.8, max_unwatched_minutes: 15 },

  // How far a parent may move the time asleep or the time up before the detector's longest stretch and stir count
  // stop describing the night (toScoringInput, "HOW FAR THE SPAN MOVED"). At or under it both figures stay; over
  // it they are dropped, from the score and from what "usual" is made of. Owner decision, 2026-11-12 (#1041):
  // before it, a one-minute adjustment dropped them, so a parent who tidies the times most mornings would never
  // get a restlessness score. 15 is a judgement, not a measurement: no data set it. It matches the 15 unwatched
  // minutes above (about as much of a night as the score already tolerates not having measured).
  correction_span_tolerance_minutes: 15,

  // Under this age continuity is judged against the child's own baseline only: night waking is ordinary in a young
  // baby and an absolute curve would mark every such night down. 12 months is the plan's line, a judgement, not a
  // measurement: no child under 12 months was in the data these numbers were set on.
  infant_months: 12,

  // Duration. x = minutes UNDER the reference (the usual, or the age figure). At or over it: 100. The three
  // anchors are the plan's.
  duration: { curve: [[0, 100], [90, 50], [240, 0]] },

  continuity: {
    // The share of each term inside the component. Efficiency leads: it is the one figure that reads sensibly in
    // both camera views above. The wake COUNT is weighted lightly on purpose: a "wake" is 5 or more active minutes,
    // and how many of those a camera counts depends heavily on its angle (0 to 5 a night from the side, 7 to 16
    // from above, same children), so no absolute count curve serves both; this one is wide and counts for a fifth.
    terms: { efficiency: 0.5, longest_share: 0.3, wake_count: 0.2 },
    // From `infant_months` up, when the age is known: fixed curves.
    absolute: {
      // x = asleep / (asleep + awake). Seen: 0.85 to 1.0 from the side view, 0.32 to 0.86 from above.
      efficiency: [[0.45, 0], [0.7, 50], [0.85, 85], [0.95, 100]],
      // x = longest unbroken stretch / (asleep + awake + unwatched). Seen: 0.3 to 1.0, then 0.08 to 0.55.
      longest_share: [[0.04, 0], [0.15, 40], [0.35, 75], [0.6, 100]],
      // x = counted wakes.
      wake_count: [[0, 100], [4, 80], [10, 50], [18, 10], [22, 0]],
    },
    // Under `infant_months`, or when the age is unknown: how far the night falls short of the child's usual.
    // ⚠️ UNTUNED: no infant data existed when these were written. They are shaped like the curves above and
    // nothing more. `wake_floor` stops a child who usually has no wakes being marked down for a single one.
    relative: {
      efficiency_drop: [[0, 100], [0.1, 50], [0.3, 0]], // x = usual efficiency - tonight's
      longest_share_drop: [[0, 100], [0.15, 50], [0.4, 0]], // x = usual share - tonight's
      wake_excess: [[0, 100], [3, 50], [8, 0]], // x = tonight's wakes - max(usual, wake_floor)
      wake_floor: 1,
    },
  },

  // Settling. x = minutes from the put-down to sleep. Up to 20 minutes is treated as ordinary. ⚠️ The detector
  // only records a put-down within 45 minutes before sleep, so unless a parent enters the put-down this term
  // cannot read below the 45-minute anchor: a very slow settle shows up as a missing put-down, not a low score.
  settling: { curve: [[20, 100], [45, 50], [90, 0]] },

  // Restlessness. x = stir minutes per hour asleep OVER max(the child's usual, floor_per_hour). The floor keeps a
  // very still sleeper (a usual near zero, which would otherwise mark any movement down) from being judged against
  // nothing. Seen: about 2 to 9 stir minutes per hour asleep.
  restlessness: { floor_per_hour: 2, curve: [[0, 100], [3, 50], [8, 0]] },

  // Consistency. x = minutes between tonight's clock time and the child's usual one, for the time asleep and the
  // time up, each scored and averaged. A quarter of an hour either way is treated as on time.
  consistency: { curve: [[15, 100], [60, 50], [150, 0]] },
});

// A curve's value at x: flat before the first anchor and after the last, a straight line between two.
export function curveAt(points, x) {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

// Whole months between a birthday and a night's date, both 'YYYY-MM-DD' calendar dates (no clock, so no timezone
// can move it). Null for a missing or unreadable birthday. A birthday AFTER the night gives a negative number,
// which scoreNight treats as "no birthday" (the children route accepts a future date).
export function ageMonthsOn(birthday, nightDate) {
  const ymd = (s) => (typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null);
  const b = ymd(birthday);
  const n = ymd(nightDate);
  if (!b || !n) return null;
  return (n[1] - b[1]) * 12 + (n[2] - b[2]) - (Number(n[3]) < Number(b[3]) ? 1 : 0);
}

// The age figure in minutes, joined by straight lines between the table's rows like every other curve here. Null
// under 12 months (never used there) and for no age; held at the last row beyond 16 years.
export function ageNightSleepMinutes(ageMonths) {
  if (!Number.isFinite(ageMonths) || ageMonths < 12) return null;
  return Math.round(curveAt(AGE_NIGHT_SLEEP_HOURS, ageMonths / 12) * 60);
}

const utcMs = (s) => (typeof s === 'string' && s ? Date.parse(`${s.replace(' ', 'T')}Z`) : NaN);
const num = (v) => (Number.isFinite(v) ? v : null);

// Local clock minutes since 12:00 noon, in `tz`, of a stored UTC time: 19:30 is 450, 07:00 the next morning 1140.
// Counted from noon so an evening and the morning after it sit on one number line with no wrap at midnight.
// ⚠️ WALL-CLOCK, read with Intl in the zone (the way earlyExitThresholdMin in sleepAnalysis.js reads a local
// HH:MM), never "minutes elapsed since noon": on the two nights a year the clocks move, 07:00 is still 07:00 to
// the family, and elapsed minutes would shift that night's wake by an hour against every other night.
export function clockMinutesSinceNoon(sqlUtc, tz) {
  const ms = utcMs(sqlUtc);
  if (!Number.isFinite(ms) || typeof tz !== 'string') return null;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(ms));
  } catch {
    return null; // a zone Intl refuses: no clock time, so no consistency term, rather than a throw on read
  }
  const p = parts.reduce((a, x) => ((a[x.type] = x.value), a), {});
  return (((Number(p.hour) * 60 + Number(p.minute) - 720) % 1440) + 1440) % 1440;
}

const INPUT_MARK = 'scoring_input_v';
const isScoringInput = (x) => Boolean(x) && x[INPUT_MARK] === 1;

// A metric as the scorer and the baseline both read it: usable only with a value and no reason against it.
const metric = (value, reason = null) => {
  const v = num(value);
  const why = reason ?? (v == null ? 'missing' : null);
  return { value: why ? null : v, usable: !why, reason: why };
};

// ONE NORMALISED INPUT (plan, Design 1). `night` is what an endpoint returns: a stored row or a fresh compute, with
// the correction overlay (sleepReviews.js applyCorrection) already laid over it when there is one.
//
// `context`: for a FRESH compute only, the scoring context that compute actually ran with (currentScoringContext
// for a plain compute, the stored context for a replay). A fresh result does not carry its timezone or window, and
// they are never guessed from today's settings here: without it the night has no context, matches no baseline, and
// is scored as an early estimate. A stored row carries its own (`scoring_context`) and ignores the option.
// `nowMs`: the clock, for "is it still in progress" on a stored row and "is it final" on a fresh compute.
export function toScoringInput(night, { context = null, nowMs = Date.now() } = {}) {
  if (isScoringInput(night)) return night;
  if (!night || typeof night !== 'object') return null;
  // computeNight always says `in_progress`; a sleep_nights row has no such column.
  const fromStored = typeof night.in_progress !== 'boolean';

  let ctx;
  if (fromStored) ctx = parseScoringContext(night.scoring_context ?? null);
  else {
    ctx = context == null ? null : parseScoringContext(context);
    // The camera the figures really came from, as scoringContextFor stores it.
    if (ctx) ctx = { ...ctx, camera_id: night.analysis_camera_id ?? null };
  }

  const startMs = utcMs(night.window_start);
  const endMs = utcMs(night.window_end);
  const windowMinutes = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? (endMs - startMs) / 60000 : null;
  const coverage = num(night.coverage_minutes);
  const inProgress = fromStored ? Number.isFinite(endMs) && nowMs < endMs : night.in_progress;

  const corrected = night.corrected === true;
  // The same two tests applyCorrection makes ("AN UNCHANGED TIME IS NOT A CHANGED ONE"), read from the fields the
  // overlay leaves: a time the parent saved unchanged did not change the span.
  const onsetCorrected = corrected && (night.onset_at ?? null) !== (night.algo_onset_at ?? null);
  const wakeCorrected = corrected && (night.wake_at ?? null) !== (night.algo_wake_at ?? null);
  const spanCorrected = onsetCorrected || wakeCorrected;
  // HOW FAR THE SPAN MOVED (owner decision 2026-11-12, #1041). The detector's longest stretch and stir count were
  // measured over ITS span. A parent's small adjustment leaves them describing nearly the same night; a large one
  // does not. So they are dropped only when a time moved by MORE than the tolerance (see SCORE_CONFIG).
  // ⚠️ THE LARGER of the two moves, not their sum. Each time is its own judgement by the parent ("asleep a little
  // later", "up a little earlier"), and the rule is meant to forgive a small adjustment to either; a sum would
  // drop the figures for a parent who nudges both ends by eight minutes, which is exactly the habit the decision
  // is about. Consequence, accepted: both ends moved by the full tolerance leaves up to twice that many minutes
  // at the edges that the figures were or were not measured over.
  // A time supplied where the detector had none (or one that cannot be read) has no distance: it counts as moved.
  const movedMinutes = (now, algo) => {
    const a = utcMs(now);
    const b = utcMs(algo);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) / 60000 : Infinity;
  };
  const spanMovedMinutes = Math.max(
    onsetCorrected ? movedMinutes(night.onset_at, night.algo_onset_at) : 0,
    wakeCorrected ? movedMinutes(night.wake_at, night.algo_wake_at) : 0,
  );
  const spanMoved = spanMovedMinutes > SCORE_CONFIG.correction_span_tolerance_minutes;
  // asScoredFromEmpty (sleepReviews.js): the detector saw an empty bed and a parent typed two times. Its wakes (0)
  // and longest stretch (the whole span) were never measured.
  const promotedFromEmpty = night.status === 'ok' && night.algo_status === 'empty';

  // Is the wake a real, confirmed one? No wake at all means "still asleep when the window closed", and a skipped
  // early exit (#700) means the detector doubted its own answer: either way the night's length is not settled.
  // A wake the parent GAVE is confirmed by them, whatever the detector noted, and whether or not it moved: the
  // overlay says so with `wake_given` (applyCorrection; #1041). Not `corrected`, which is also true for a review
  // that only gave the put-down or the time asleep, and not "the wake differs from the detector's", which misses
  // a parent who looked at the detector's wake and saved it as it was (the edit card's ordinary save).
  const detectorDoubt = fromStored ? night.wake_unconfirmed_at != null : night.wake_unconfirmed != null;
  const wakeConfirmed = night.wake_at != null && (night.wake_given === true || !detectorDoubt);

  // FINAL OR PROVISIONAL (plan, Design 4). A stored row is judged on its OWN computed_at, never the clock: between
  // the 3-hour horizon and the job's next tick, a row last written before the horizon is still owed a refresh
  // (the #351 lesson, see storeNightBeforeCorrection). A corrected stored night is locked and never re-stored, so
  // it is final, but ONLY when the row was written at or after the window's end: a row stored while the night was
  // still running (an admin store, a seeded demo night) is not locked and will be re-stored (nightIsLocked; Opus
  // review of PR #1040). A fresh compute is final when it runs after the horizon, corrected or not: its detector
  // figures (awake minutes, wake count) are still recomputed from samples each time.
  let final = false;
  if (typeof night.window_end === 'string' && Number.isFinite(endMs)) {
    if (fromStored) {
      const computedMs = utcMs(night.computed_at);
      final = Number.isFinite(computedMs) && ((corrected && computedMs >= endMs) || isEvidenceFinal(night.window_end, computedMs));
    } else final = isEvidenceFinal(night.window_end, nowMs);
  }

  const asleep = num(night.asleep_minutes);
  const awake = num(night.awake_minutes);
  const unknown = num(night.unknown_minutes) ?? 0; // NULL on rows from before the column: read as none, as applyCorrection does
  const unwatched = unknown > SCORE_CONFIG.low_confidence.max_unwatched_minutes;
  const longest = num(night.longest_stretch_minutes);
  const stir = num(night.stir_minutes);
  const span = asleep != null && awake != null ? asleep + awake + unknown : null;

  // SETTLING follows the UI's in-bed rule: this MIRRORS frontend/src/lib/inBed.js (`showsInBed`), and must change
  // with it. A put-down the page hides (the detector's own estimate beside an onset the parent replaced, or one
  // less than a minute before sleep) is not one the score may judge the night on. Consequence, accepted: a child
  // asleep within a minute of the put-down has no settling term rather than a perfect one.
  const onsetMs = utcMs(night.onset_at);
  const inBedMs = utcMs(night.in_bed_at);
  let settle;
  if (!night.in_bed_at || !night.onset_at || !Number.isFinite(onsetMs) || !Number.isFinite(inBedMs)) settle = metric(null, 'no_in_bed');
  else if (onsetCorrected && !night.in_bed_corrected) settle = metric(null, 'in_bed_hidden');
  else if (onsetMs - inBedMs < 60000) settle = metric(null, 'in_bed_hidden');
  else settle = metric(Math.round((onsetMs - inBedMs) / 60000));

  const asleepMetric = metric(asleep);
  // What may count towards the USUAL duration (plan, Design 3): not a night with no confirmed wake (an empty bed
  // counted as sleep) nor one with more than 15 unwatched minutes (sleep under-counted). Scoring the night itself
  // still uses `asleep`: the measured minutes, never topped up.
  let usualAsleep = asleepMetric;
  if (asleepMetric.usable && !wakeConfirmed) usualAsleep = metric(null, 'wake_unconfirmed');
  else if (asleepMetric.usable && unwatched) usualAsleep = metric(null, 'unwatched');

  // A span moved past the tolerance leaves the detector's longest stretch and stir count describing a different
  // span (HOW FAR THE SPAN MOVED, above); an unwatched gap resets the stretch counter mid-sleep.
  const spanReason = spanMoved ? 'span_corrected' : null;
  const longestReason = spanReason ?? (unwatched ? 'unwatched' : null);
  // A correction inside the tolerance keeps the detector's longest stretch, but the total beside it was re-derived
  // for the new span and can now be the smaller of the two: a stretch cannot be longer than the sleep it is part
  // of (#355), so the figure that is SCORED and that enters the usual is clamped too, not only the one displayed
  // (Codex review of PR #1042).
  const longestKept = longest != null && asleep != null && spanCorrected ? Math.min(longest, asleep) : longest;
  const tz = ctx ? ctx.tz : null;

  const metrics = {
    asleep: asleepMetric,
    // Falling asleep to waking, every minute of it: what the age figure is compared with (AGE_NIGHT_SLEEP_HOURS).
    span_minutes: metric(span),
    usual_asleep: usualAsleep,
    awake_minutes: metric(awake),
    wake_count: metric(night.wake_count),
    efficiency: metric(asleep != null && awake != null && asleep + awake > 0 ? asleep / (asleep + awake) : null),
    longest_stretch: metric(longestKept, longestReason),
    longest_share: metric(longestKept != null && span > 0 ? longestKept / span : null, longestReason),
    settle_minutes: settle,
    stir_rate: metric(stir != null && asleep > 0 ? stir / (asleep / 60) : null, spanReason),
    onset_clock: metric(clockMinutesSinceNoon(night.onset_at, tz), tz ? null : 'no_timezone'),
    wake_clock: metric(clockMinutesSinceNoon(night.wake_at, tz), tz ? (wakeConfirmed ? null : 'wake_unconfirmed') : 'no_timezone'),
  };

  return {
    [INPUT_MARK]: 1,
    night_date: night.night_date ?? null,
    status: night.status ?? null,
    from_stored: fromStored,
    in_progress: inProgress,
    final,
    context: ctx ? { camera_id: ctx.camera_id, tz: ctx.tz, window: { start: ctx.window.start, end: ctx.window.end } } : null,
    window_minutes: windowMinutes,
    coverage_minutes: coverage,
    coverage_frac: windowMinutes && coverage != null ? coverage / windowMinutes : null,
    corrected,
    span_corrected: spanCorrected, // ANY change to the time asleep or the time up
    span_moved_minutes: spanCorrected ? spanMovedMinutes : 0, // the larger of the two moves; Infinity = no detector time
    promoted_from_empty: promotedFromEmpty,
    wake_confirmed: wakeConfirmed,
    unknown_minutes: unknown,
    // For display only: after a span correction the detector's stretch can exceed the re-derived total (#355).
    // Clamped on ANY span correction, however small: a stretch longer than the total is wrong at one minute too.
    longest_stretch_display: longestKept,
    metrics,
  };
}

const noScore = (reason, extra = {}) => ({ score: null, reason, version: SCORE_VERSION, ...extra });

// The band KEY for a score ('great' | 'good' | 'fair'), or null under the lowest edge, where the number is shown
// with no word. Keys, not wording: the client words them.
export function bandFor(score) {
  for (const b of SCORE_CONFIG.bands) if (score >= b.min) return b.band;
  return null;
}

// A weighted mean of the parts that have a score, each rounded first so a breakdown shown to a person adds up to
// the number above it. Null when none has one.
function weightedMean(parts) {
  const have = parts.filter((p) => p.available);
  const total = have.reduce((s, p) => s + p.weight, 0);
  if (!have.length || total <= 0) return null;
  return have.reduce((s, p) => s + p.weight * p.score, 0) / total;
}

const part = (key, weight, { score = null, reason = null, value = null, usual = null, terms } = {}) => ({
  key,
  score: score == null ? null : Math.round(score),
  weight,
  available: score != null,
  reason: score == null ? reason : null,
  value,
  usual,
  ...(terms ? { terms } : {}),
});

// The score for one night. `night`: a night object or toScoringInput's result. `baseline`: sleepBaseline's result
// for this night (or null: no history). `ageMonths`: the child's age on the night's date (ageMonthsOn), or null.
//
// Returns { score, band, version, provisional, low_confidence, capped_by, components: [...] } with three additive
// keys (`early_estimate`, `low_confidence_reasons`, `unwatched_minutes`) so the breakdown can say why, or
// { score: null, reason, version } when the night must not be scored.
export function scoreNight(night, baseline, ageMonths) {
  const input = toScoringInput(night);
  const cfg = SCORE_CONFIG;
  if (!input) return noScore('no_night');
  if (input.in_progress) return noScore('in_progress');
  if (input.status !== 'ok') return noScore('not_ok', { status: input.status });
  // Its wake count and longest stretch were typed into existence, not measured: no continuity to score.
  if (input.promoted_from_empty) return noScore('promoted_from_empty');
  const m = input.metrics;
  // Zero counts as none: a time correction can clamp the total to 0 on a night that stays `ok` (applyCorrection's
  // Math.max(0, ...)), and "no sleep" has no score (plan, Known limits). Found by the Codex review of PR #1040.
  if (!m.asleep.usable || m.asleep.value <= 0) return noScore('no_sleep_measured');

  // A birthday after the night is a typo or a placeholder, not an age: treated as no birthday.
  const age = Number.isFinite(ageMonths) && ageMonths >= 0 ? ageMonths : null;
  const usualOf = (key) => {
    const b = baseline?.metrics?.[key];
    return b && b.ready === true && Number.isFinite(b.median) ? b.median : null;
  };

  // --- Duration: against the child's usual when it is ready, else the age figure, else no score at all.
  let durationRef = usualOf('asleep');
  const earlyEstimate = durationRef == null;
  if (durationRef == null) {
    if (age == null) return noScore('no_duration_reference');
    // Under 12 months there is no age figure this file trusts and no absolute continuity curve either.
    if (age < cfg.infant_months) return noScore('under_12_months_no_baseline');
    durationRef = ageNightSleepMinutes(age);
  }
  // Like with like: measured minutes asleep against the usual minutes asleep, but the whole span against the age
  // figure, which is a time in bed (see AGE_NIGHT_SLEEP_HOURS). `basis` tells the breakdown which it was. The span
  // is always there when the total is on a real night; if it is not, the total stands in rather than no score.
  const durationValue = earlyEstimate && m.span_minutes.usable ? m.span_minutes.value : m.asleep.value;
  const duration = {
    ...part('duration', cfg.weights.duration, {
      score: curveAt(cfg.duration.curve, durationRef - durationValue),
      value: durationValue,
      usual: durationRef,
    }),
    basis: earlyEstimate ? 'span_vs_age' : 'asleep_vs_usual',
  };

  // --- Continuity: fixed curves from 12 months when the age is known; otherwise only against the child's own
  // usual. An UNKNOWN age takes the baseline path too: the child may be a baby, and a night with no birthday is
  // only ever scored when a baseline exists, so little is lost.
  const absolute = age != null && age >= cfg.infant_months;
  const C = cfg.continuity;
  const term = (key, weight, metricKey, absScore, relScore) => {
    const mm = m[metricKey];
    if (!mm.usable) return part(key, weight, { reason: mm.reason });
    if (absolute) return part(key, weight, { score: absScore(mm.value), value: mm.value, usual: usualOf(metricKey) });
    const usual = usualOf(metricKey);
    if (usual == null) return part(key, weight, { reason: 'no_baseline', value: mm.value });
    return part(key, weight, { score: relScore(mm.value, usual), value: mm.value, usual });
  };
  const contTerms = [
    term('efficiency', C.terms.efficiency, 'efficiency',
      (v) => curveAt(C.absolute.efficiency, v), (v, u) => curveAt(C.relative.efficiency_drop, u - v)),
    term('longest_share', C.terms.longest_share, 'longest_share',
      (v) => curveAt(C.absolute.longest_share, v), (v, u) => curveAt(C.relative.longest_share_drop, u - v)),
    term('wake_count', C.terms.wake_count, 'wake_count',
      (v) => curveAt(C.absolute.wake_count, v), (v, u) => curveAt(C.relative.wake_excess, v - Math.max(u, C.relative.wake_floor))),
  ];
  const contScore = weightedMean(contTerms);
  const continuity = part('continuity', cfg.weights.continuity, {
    score: contScore,
    reason: contTerms[0].reason ?? 'missing',
    value: m.efficiency.value,
    usual: usualOf('efficiency'),
    terms: contTerms,
  });

  // --- Settling: a fixed curve; dropped when the put-down is missing or hidden (toScoringInput).
  const settling = m.settle_minutes.usable
    ? part('settling', cfg.weights.settling, { score: curveAt(cfg.settling.curve, m.settle_minutes.value), value: m.settle_minutes.value, usual: usualOf('settle_minutes') })
    : part('settling', cfg.weights.settling, { reason: m.settle_minutes.reason });

  // --- Restlessness: only against the child's own usual, and only the EXCESS over it (or over the floor).
  let restlessness;
  const stirUsual = usualOf('stir_rate');
  if (!m.stir_rate.usable) restlessness = part('restlessness', cfg.weights.restlessness, { reason: m.stir_rate.reason });
  else if (stirUsual == null) restlessness = part('restlessness', cfg.weights.restlessness, { reason: 'no_baseline', value: m.stir_rate.value });
  else {
    restlessness = part('restlessness', cfg.weights.restlessness, {
      score: curveAt(cfg.restlessness.curve, m.stir_rate.value - Math.max(stirUsual, cfg.restlessness.floor_per_hour)),
      value: m.stir_rate.value,
      usual: stirUsual,
    });
  }

  // --- Consistency: how far the time asleep and the time up sit from the child's usual clock times.
  const clockTerm = (key, metricKey) => {
    const mm = m[metricKey];
    if (!mm.usable) return part(key, 1, { reason: mm.reason });
    const usual = usualOf(metricKey);
    if (usual == null) return part(key, 1, { reason: 'no_baseline', value: mm.value });
    // The shorter way round the clock: the number line wraps at noon, so a usual 11:50 and a 12:10 are 20 minutes
    // apart, not 1420 (a sleep window that ends near noon; Codex review of PR #1040). The MEDIAN of clock times
    // that straddle noon is still not circular: known limit, such a child's usual wake can read wrong.
    const apart = Math.abs(mm.value - usual);
    return part(key, 1, { score: curveAt(cfg.consistency.curve, Math.min(apart, 1440 - apart)), value: mm.value, usual });
  };
  const clockTerms = [clockTerm('onset', 'onset_clock'), clockTerm('wake', 'wake_clock')];
  const consistency = part('consistency', cfg.weights.consistency, {
    score: weightedMean(clockTerms),
    reason: clockTerms.map((t) => t.reason).find((r) => r && r !== 'no_baseline') ?? 'no_baseline',
    terms: clockTerms,
  });

  const components = [duration, continuity, settling, restlessness, consistency];
  let score = Math.round(weightedMean(components));
  // WEAKEST-LINK CAP. Checked in turn, so the LOWEST of the ceilings is the one named.
  let cappedBy = null;
  for (const c of [duration, continuity, restlessness]) {
    if (c.available && c.score + cfg.cap_margin < score) {
      score = c.score + cfg.cap_margin;
      cappedBy = c.key;
    }
  }

  const reasons = [];
  if (input.coverage_frac == null || input.coverage_frac < cfg.low_confidence.min_coverage) reasons.push('low_coverage');
  if (input.unknown_minutes > cfg.low_confidence.max_unwatched_minutes) reasons.push('unwatched');
  if (!input.wake_confirmed) reasons.push('wake_unconfirmed');

  return {
    score,
    // No band word on an early estimate: the reference is an age figure of a different quantity (see
    // AGE_NIGHT_SLEEP_HOURS), and withholding the word also softens the step when the usual takes over.
    band: earlyEstimate ? null : bandFor(score),
    version: SCORE_VERSION,
    provisional: !input.final,
    low_confidence: reasons.length > 0,
    capped_by: cappedBy,
    components,
    early_estimate: earlyEstimate,
    low_confidence_reasons: reasons,
    unwatched_minutes: input.unknown_minutes,
  };
}
