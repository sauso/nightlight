// "Up between 6:10 and 6:50": the range shown instead of a single wake time when the app has two
// different estimates of when a child got up.
//
// The two estimates already exist on every scored night and neither is new:
//   - `wake_at_algo`: the movement-only wake (the "shadow" figure kept explicitly, sleepAnalysis.js), which
//     does not use the logged bed exits at all;
//   - `wake_at`: the wake the app reports, which also takes the logged exit into account.
// This module only decides whether to SHOW them as a pair. It stores nothing and changes no number:
// `wake_at` and every other field are untouched, and the range rides beside them as an additive field.
//
// WHY 10 MINUTES (RANGE_MIN_MIN). It is the tolerance the scoreboard already calls "right" for a wake time,
// so the range appears exactly when the two estimates disagree by more than the app itself treats as a match.
// A smaller gap would put a range on nights where the two agree for every purpose we measure, and say
// "between 6:36 and 6:41" about a time nobody could tell apart.
//
// WHAT IT IS WORTH, MEASURED (owner's session, 2026-10-27, truth-blind: the range rule was fixed before the
// true times were looked at; 26 design nights from ONE house, an 18-night hold-out kept frozen for a single
// later check). A range showed on 7 nights: 5 of the 12 late nights and 2 of the 13 right ones, and the true
// wake lay inside it (+-5 min) on 3 of those 5 late nights. That is honest, modest coverage: roughly a
// quarter of the late nights get a range that helps, and the rest still show one time.
//
// HOLD-OUT, SCORED ONCE against a bar written before it was looked at (2026-10-27, 18 frozen nights): a range
// on 5 of 18 nights, 3 of them on the 9 RIGHT nights (33%, over the 25% limit), and the true wake inside it on
// 4 of the 5 shown (passed). The false-alarm rate failed, so by the plan the range is used ONLY inside the
// morning review's question (routes/children.js, GET /:id/review/:date), where the person is being asked
// anyway. It is deliberately NOT on the child card, the sleep page or the push: there a range on a night that
// was fine is noise nobody asked for. Do not wire it into those without a new measurement.
//
// KNOWN LIMITS (also in docs/sleep-tracking.md):
//   - A child who stays still has no movement-only estimate (`wake_at_algo` is null), so the worst nights,
//     the ones with no logged exit at the true time, show a single time. 5 of the 12 late nights were like
//     that.
//   - The 10 minutes and the figures above were fitted on one house's cameras and two children; another room
//     may give a different share of nights. Nothing here derives a threshold from the room.
//
// Kept OUT of backend/package.json's test:core list on purpose (it is a pure display rule), and it must stay
// pure: no database, no clock, so the route layer can call it on any night shape.

// The disagreement at which a range is shown, in minutes. Exactly this many minutes => a range; one second
// less => none (the comparison below is in milliseconds, so 9 min 59 s is not rounded up to 10).
export const RANGE_MIN_MIN = 10;

// 'YYYY-MM-DD HH:MM:SS' (UTC, the shape every timestamp in this database uses) -> epoch ms, or NaN for
// anything else, including a non-string and the empty string.
function parseSql(s) {
  if (typeof s !== 'string' || !s) return NaN;
  return Date.parse(`${s.replace(' ', 'T')}Z`);
}

// `night` is any night object as the routes return it (stored row, fresh compute, or overlaid by a parent's
// correction). Returns `{ from, to }` (UTC strings, from <= to) or null.
//
// null in every case where one time is the honest answer:
//   - not a scored night (`status !== 'ok'`): an empty, no-data or no-sleep night has no wake to range over;
//   - `nobody_in_bed`: the parent said so, and asNobodyInBed keeps the detector's times only as `algo_*`;
//   - `corrected`: the parent gave the true time, which replaces both estimates. A range beside it would
//     second-guess the one answer that is known. This reads the OVERLAID night, so the route must call this
//     AFTER applyCorrection, or `corrected` does not exist yet;
//   - `in_progress`: tonight so far. A wake is not final until the window closes (it drifts later through
//     the morning), and a range that moves under someone's eyes tells them nothing;
//   - either time missing or unparsable, or they are less than RANGE_MIN_MIN apart.
export function wakeRange(night) {
  if (!night || night.status !== 'ok') return null;
  if (night.corrected || night.in_progress || night.nobody_in_bed) return null;
  const a = parseSql(night.wake_at_algo);
  const b = parseSql(night.wake_at);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a - b) < RANGE_MIN_MIN * 60000) return null;
  return a < b
    ? { from: night.wake_at_algo, to: night.wake_at }
    : { from: night.wake_at, to: night.wake_at_algo };
}
