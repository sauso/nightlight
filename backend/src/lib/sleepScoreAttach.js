// ★ THE SLEEP SCORE ON THE API (sleep score plan, phase 1c; planning/sleep-score-plan.md, Design 1 and 6).
//
// The one place the sleep routes (routes/children.js: /sleep/live, /sleep?nights=N, /sleep/:date) turn a night they
// are about to return into that night plus a `score` key. The maths is sleepScore.js and the "usual" is
// sleepBaseline.js; this file is only the glue, kept out of the route file so the three routes cannot each grow
// their own copy of it.
//
// THE RULE: the score is worked out from the EXACT night object the endpoint returns, after a parent's correction
// has been laid over it (or without it, where the endpoint itself returns the night without it). So the number
// always agrees with the figures beside it, and nothing is stored: a correction, a retuned curve or a new night in
// the baseline shows on the next read.
//
// ADDITIVE ONLY. A page open in a browser from before this existed is a deployed client: the night keeps every key
// it had, with the same value, and gains `score` (and, in one case below, `score_source`).
//
// What `score` can be:
//   - scoreNight's result: { score, band, version, provisional, low_confidence, capped_by, components, ... };
//   - its no-score form: { score: null, reason, version } (`in_progress`, `not_ok`, `promoted_from_empty`,
//     `no_sleep_measured`, `no_duration_reference`, `under_12_months_no_baseline`);
//   - null, when scoring itself failed (see NEVER ALLOWED TO BREAK A SLEEP ROUTE).
//
// THE PER-CHILD SWITCH (phase 2): while a child's "Show sleep score" is off (`children.show_sleep_score = 0`), the
// night is returned without the score: NO `score` key and no `score_source` (it still gains `summary`, below). Absent, not
// null, so a client can tell "switched off" (nothing to say) from "scoring failed" (null). The switch is read HERE,
// from the database, and not handed in by the routes: a route that forgot to pass it would show a score the family
// turned off, and this way no route can forget. This is the one documented exception to ADDITIVE ONLY above.
//
// THE NIGHT SUMMARY (phase 3) rides on the same glue, so no route can forget it: every night that gets `score` also
// gets `summary`: { headline: { key }, observations: [...], seed } (lib/nightSummary.js), or null when there is nothing
// to say about the night (tracking off, no data) or when making it failed. ADDITIVE, and present whether or not the
// child's switch is on: the switch hides the score (and `score_source`), not the description of the night. That is why
// the score is worked out even for a hidden child, to derive the headline class from its components; only its
// appearance in the response is switched. A failing summary leaves the score and the route as they were, with
// `summary: null`, and never costs the night its score.

import db from '../db.js';
import { logger } from './logger.js';
import { sleepBaseline } from './sleepBaseline.js';
import { scoreNight, toScoringInput, ageMonthsOn } from './sleepScore.js';
import { selectSummary } from './nightSummary.js';

// Test seam ONLY (sleep-score-routes.test.js), like failNextSensorShadowPassForTest in sleepAnalysis.js: makes the
// next score throw, so a test can prove a failing score leaves the route's answer alone. A real failure in there
// cannot be provoked from outside: every input the routes can hand over is one the maths accepts.
let failNext = false;
export function failNextScoreForTest() {
  failNext = true;
}
// The same seam for the summary alone: the score is made as usual and then selecting the summary throws.
let failNextSummary = false;
export function failNextSummaryForTest() {
  failNextSummary = true;
}

// At most one log line an hour for a failing score (and one for a failing summary, each with its own clock: a summary
// fault must not be hidden behind a score fault's line). The child's card asks /sleep/live again and again, and the
// list scores up to 60 nights in one request, so a fault that hits every night would otherwise fill the log.
const LOG_EVERY_MS = 60 * 60 * 1000;
let lastLoggedMs = -Infinity;
let lastSummaryLoggedMs = -Infinity;
export function resetScoreLogForTest() {
  lastLoggedMs = -Infinity;
  lastSummaryLoggedMs = -Infinity;
}

// The score for one night object, with the normalised input it was made from (the summary reads both, so neither is
// worked out twice). `context` is toScoringInput's option: for a FRESH compute, the scoring context that compute
// actually ran with (the caller knows; it is never guessed here). A stored row carries its own.
function scoreOf(child, night, { context, nowMs }) {
  if (failNext) {
    failNext = false;
    throw new Error('test: the score was made to fail');
  }
  const input = toScoringInput(night, { context, nowMs });
  // A night in progress or not `ok` has no score whatever its history (scoreNight's first two checks, before it
  // reads the baseline), so the baseline's database read is skipped for it. That is most reads of /sleep/live
  // through the evening, which the card repeats.
  if (!input || input.in_progress || input.status !== 'ok') return { score: scoreNight(input, null, null), input };
  // The baseline is handed the SAME normalised input, so the night being scored and its "usual" are matched on
  // one context (camera and window) and cannot disagree about which it is.
  const baseline = sleepBaseline(child.id, input, { nowMs });
  return { score: scoreNight(input, baseline, ageMonthsOn(child.birthday, input.night_date)), input };
}

// The summary for the night that was scored, or null. Its own try/catch: a failing summary must not take the score
// (or the route) with it.
function summaryOf(child, night, score, input) {
  try {
    if (failNextSummary) {
      failNextSummary = false;
      throw new Error('test: the summary was made to fail');
    }
    return selectSummary(night, score, { childId: child?.id, input });
  } catch {
    const now = Date.now();
    if (now - lastSummaryLoggedMs >= LOG_EVERY_MS) {
      lastSummaryLoggedMs = now;
      logger.warn('[sleep] night summary skipped: summarising a night failed');
    }
    return null;
  }
}

// `child`: { id, birthday } (the birthday may be null: then there is no age figure, see scoreNight).
// `night`: the night object the endpoint is about to return, or null (returned as it is).
// `context`: see scoreOf. Ignored for a stored row.
// `storedNight`: OLD NIGHTS ON THE DETAIL PAGE (plan, Design 1). A function returning the night's SAVED row as the
//   endpoint would show it (with the correction overlay, or without for a raw read), or null. It is called only
//   when the fresh night came back `no_data`: the raw samples are kept 30 days, so an older night can no longer be
//   worked out, while its saved row still holds the figures the child's card shows. When that row is `ok`, the
//   score is the SAVED night's and the answer says so with `score_source: 'stored'`, so a page can explain that
//   the timeline is no longer available. Every other key is the fresh night's, unchanged: the saved figures are
//   NOT copied over it (a client that wants them reads the list or `?stored=1`).
//   ⚠️ Any `no_data`, not only an aged-out one: a night whose camera has since been turned off or deleted reads
//   `no_data` the same way from here, and the saved row is the best answer for it too.
// `nowMs`: the clock, one reading for the night and its baseline.
//
// ⚠️ NEVER ALLOWED TO BREAK A SLEEP ROUTE. The score is an extra on an answer that was already complete. Any error
// in it is caught, the night is returned with `score: null`, and one fixed sentence is logged: never the error's
// own text, which can carry a child's id (the same rule as the sensor shadow in sleepAnalysis.js).
export function attachScore(child, night, { context = null, storedNight = null, nowMs = Date.now() } = {}) {
  if (!night || typeof night !== 'object') return night;
  // Hoisted so the catch below knows whether the score was meant to be shown.
  let hidden = false;
  try {
    // The child's "Show sleep score" switch, read fresh on every call (see THE PER-CHILD SWITCH above). Only an
    // explicit 0 hides the score: a child row that cannot be found leaves it on, the column's default. If this read
    // itself throws, the catch below answers `score: null`, which every client shows as nothing.
    const shown = db.prepare('SELECT show_sleep_score FROM children WHERE id = ?').get(child?.id ?? null);
    hidden = Boolean(shown) && shown.show_sleep_score === 0;
    // Never for a night still in progress: it has no score (plan, Design 4), whatever an earlier saved row of the
    // same date says (a window extended after the row was saved, a camera with no data yet; Codex review of #1042).
    let scored = night;
    let fromSaved = false;
    if (night.status === 'no_data' && night.in_progress !== true && typeof storedNight === 'function') {
      const saved = storedNight();
      if (saved && saved.status === 'ok') {
        scored = saved;
        fromSaved = true;
      }
    }
    // Scored whether or not it is shown: the summary's headline is derived from the score's components (phase 3).
    // The cost for a hidden child is the baseline read the switch used to save.
    const { score, input } = scoreOf(child, scored, { context: fromSaved ? null : context, nowMs });
    const summary = summaryOf(child, scored, score, input);
    if (hidden) return { ...night, summary };
    return fromSaved ? { ...night, score, score_source: 'stored', summary } : { ...night, score, summary };
  } catch {
    const now = Date.now();
    if (now - lastLoggedMs >= LOG_EVERY_MS) {
      lastLoggedMs = now;
      logger.warn('[sleep] sleep score skipped: scoring a night failed');
    }
    return hidden ? { ...night, summary: null } : { ...night, score: null, summary: null };
  }
}
