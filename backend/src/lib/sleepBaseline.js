// ★ THE SLEEP SCORE'S BASELINE: what "usual" means for one child on one night (sleep score plan, phase 1b;
// planning/sleep-score-plan.md, Design 3). Read by nothing yet: no route calls it in this phase.
//
// sleepBaseline(childId, night) reads the child's STORED nights before `night`, lays each parent correction over
// its row, and returns a median per metric with the number of nights behind it. It is a pure read: nothing is
// written, so a correction to an older night changes every later night's baseline on the next read by itself.
//
// WHICH NIGHTS COUNT, and why each rule is there:
//   - strictly BEFORE the night, never the night itself or a later one: a night must not be its own "usual";
//   - no older than 28 days, and only the newest 14 that qualify: recent enough to be this child now. The cap is
//     applied AFTER the rules below (as earlyExitThresholdMin in sleepAnalysis.js does), so a run of unusable
//     nights does not shrink the baseline when older usable ones are still in range;
//   - `ok` after corrections: a night a parent marked "no one was in the bed" reads `empty` and is out;
//   - not promoted from `empty` by a correction: its wake count and longest stretch were never measured;
//   - watched for at least 80% of its window;
//   - scored from the SAME camera and the SAME sleep window as the night being scored, read from each row's stored
//     `scoring_context`. A different camera sees a different amount of movement and a different window measures a
//     different night, so either change restarts the baseline. A row from before the column existed (NULL) says
//     nothing about what produced it and does not qualify.
// ⚠️ KNOWN LIMIT: "the same camera" is the camera's id. Moving or re-aiming a camera keeps its id, so nights from
// before and after a physical move share one baseline until the older ones age out of the 28 days. In the data
// these rules were first run on, such a move multiplied the counted wakes and cut the measured sleep by about a
// third for the same children: for up to four weeks after it, "usual" is partly the old view. There is no date or
// switch for it here on purpose: that would be a rule about one house.
//
// PER-METRIC READINESS. A median is `ready` only with at least `min_values` (7) usable values OF THAT METRIC, not
// seven qualifying nights: seven nights of which one has a stir count do not make a usual stir rate. Whether a
// night's figure is usable is decided by toScoringInput (sleepScore.js), the same function that prepares the night
// being scored, so nothing the scorer would refuse can be counted as usual.
//
// Medians, not means: one unusual night must not move what usual is.

import db from '../db.js';
import { applyCorrection } from './sleepReviews.js';
import { SCORE_CONFIG, toScoringInput } from './sleepScore.js';

// Baseline metric -> the toScoringInput metric it is the median of. `asleep` reads `usual_asleep`, which leaves
// out nights with no confirmed wake or more than 15 unwatched minutes (see toScoringInput). Clock times are local
// minutes since noon in EACH night's own stored timezone (clockMinutesSinceNoon), so a timezone change mid-history
// compares 19:30 with 19:30.
const BASELINE_METRICS = Object.freeze({
  asleep: 'usual_asleep',
  wake_count: 'wake_count',
  awake_minutes: 'awake_minutes',
  efficiency: 'efficiency',
  longest_stretch: 'longest_stretch',
  longest_share: 'longest_share',
  settle_minutes: 'settle_minutes',
  stir_rate: 'stir_rate',
  onset_clock: 'onset_clock',
  wake_clock: 'wake_clock',
});

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// A calendar date string moved by whole days. Arithmetic on the date parts in UTC, where every day is 24 hours, so
// no timezone or clock change can skip or repeat a date (the localDateStr lesson in sleepAnalysis.js).
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const sameContext = (a, b) =>
  Boolean(a && b) && a.camera_id != null && a.camera_id === b.camera_id
  && a.window.start === b.window.start && a.window.end === b.window.end;

// May this earlier night (a toScoringInput result) stand in the baseline of `target`?
function qualifies(input, target) {
  return Boolean(input)
    && input.status === 'ok'
    && !input.in_progress
    && !input.promoted_from_empty
    && input.coverage_frac != null && input.coverage_frac >= SCORE_CONFIG.baseline.min_coverage
    && sameContext(input.context, target.context);
}

// The pure half: `inputs` are the child's earlier nights as toScoringInput results, NEWEST FIRST, corrections
// already overlaid. Separate from the database read so the evidence script and the tests can feed it directly.
export function baselineFromInputs(target, inputs) {
  const { max_nights: maxNights, min_values: minValues } = SCORE_CONFIG.baseline;
  const used = [];
  for (const input of inputs) {
    if (!qualifies(input, target)) continue;
    used.push(input);
    if (used.length === maxNights) break;
  }
  const metrics = {};
  for (const [key, from] of Object.entries(BASELINE_METRICS)) {
    const values = used.filter((n) => n.metrics[from].usable).map((n) => n.metrics[from].value);
    metrics[key] = { median: median(values), n: values.length, ready: values.length >= minValues };
  }
  return { nights: used.length, metrics };
}

const priorNightsStmt = db.prepare(
  `SELECT * FROM sleep_nights
    WHERE child_id = ? AND night_date < ? AND night_date >= ?
    ORDER BY night_date DESC`
);

// `night`: the night being scored, as a night object or a toScoringInput result. A night with no readable context
// (a fresh compute handed over without one, a row from before `scoring_context`) matches nothing and gets an empty
// baseline: every metric `ready: false`. `context` is toScoringInput's option, for a FRESH compute: the scoring
// context that compute ran with. Without it a fresh night silently has no usual (Opus review of PR #1040), so a
// caller holding a fresh compute must pass it here or hand over a toScoringInput result made with it.
export function sleepBaseline(childId, night, { context = null, nowMs = Date.now() } = {}) {
  const target = toScoringInput(night, { context, nowMs });
  if (!target || !target.context || !/^\d{4}-\d{2}-\d{2}$/.test(String(target.night_date))) {
    return baselineFromInputs({ context: null }, []);
  }
  const from = shiftDate(target.night_date, -SCORE_CONFIG.baseline.max_age_days);
  const inputs = priorNightsStmt
    .all(childId, target.night_date, from)
    .map((row) => toScoringInput(applyCorrection(childId, row), { nowMs }));
  return baselineFromInputs(target, inputs);
}
