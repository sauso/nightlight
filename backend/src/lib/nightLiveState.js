// ★ THE LIVE STATE OF A NIGHT STILL IN PROGRESS (sleep score plan, phase 4): "asleep since 8:05 PM", "awake since
// 2:10 AM", "not asleep yet", or "unknown". PURE: no database, no clock of its own (the caller passes `nowMs`), no
// imports, so a unit test loads it without opening a database.
//
// liveState(night, nowMs, facts) returns { state, since } for a night computeNight says is in progress, else null.
//   night   the fresh night object (computeNight's): reads `in_progress`, `status`, `onset_at`, `wake_at`, `as_of`.
//   nowMs   the clock, for the staleness check only.
//   facts   the night's PARSED `summary_facts` (sleepAnalysis.js parseSummaryFacts), or null. Handed in, not parsed
//           here, so this file needs no import: parseSummaryFacts lives in a module that opens the database.
// `since` is a UTC time in the form the database stores, 'YYYY-MM-DD HH:MM:SS', like `onset_at` and `wake_at` beside
// it (the browser puts it in the home zone), or null.
//
// ★ READS EXISTING FIELDS ONLY. `computeNight` has no "now" state of its own, and none is added: `wake_at` is non-null
// only when a wake run touches the LAST elapsed minute, so on its own it is not a current-state field (a child awake at
// 2:10 and quiet again at 2:20 has wake_at null at 2:25). The counted wakes in `summary_facts` carry each wake's start
// and length, which is what the rest of the state is worked out from.
//
// THE RULES, in the order they are tried (each a decision, not an accident):
//   1. Not an in-progress night: null. A finished night has a final wake time and no "right now".
//   2. `as_of` unreadable or older than `stale_after_min` before `nowMs`: `unknown`. Never a state the data cannot
//      back. (On /sleep/live as_of is the moment of the read, so this fires for a night object that was held and
//      shown later, a clock that disagrees, or a client of another route; it is the one bound that keeps a stale
//      answer from being presented as current.)
//   3. No onset yet: `not_asleep_yet`, since null. A night with NO camera data at all (`no_data`) is the exception:
//      "not asleep yet" would be a claim about a room nobody watched, so it is `unknown`.
//   4. `wake_at` non-null: `awake`, since wake_at (the wake run reaches the last elapsed minute, or the bed-transition
//      rule saw the child leave the bed).
//   5. No counted-wakes list to read (an older or unreadable `summary_facts`): `unknown`. Without it the last wake
//      cannot be placed, and "asleep since the onset" could be hours wrong.
//   6. HYSTERESIS: the last counted wake ENDED less than `wake_gap_min + 1` minutes before `as_of`: `awake`, since
//      that wake's START. A wake only counts once it is >= 5 active minutes and bridges quiet gaps of up to
//      `wake_gap_min` minutes (sleepAnalysis.js WAKE_GAP_MIN), so a child who has been quiet for 3 minutes can still
//      start the same wake again; calling them asleep then would flip the state back and forth through one restless
//      spell. The extra minute covers the last minute's row, which lands ~7 s after the minute ends: until then that
//      minute is missing and reads as quiet, so a poll in that gap would otherwise say "asleep" for a child who is
//      awake right now.
//   7. Otherwise `asleep`, since the END of the last counted wake (when they went back to sleep), else the onset.
// Strictly: 4 minutes after a wake ended reads asleep, 3 minutes 59 seconds after it still reads awake.
//
// ⚠️ KNOWN LIMITS, documented in docs/sleep-tracking.md: a camera that went offline is not detected (there is no
// last-sample-age field, and adding one would change computeNight's output); "out of bed" is not told apart from
// "awake"; the state can lag by the client's poll interval.

// Every number here is a judgement, not a measurement: no night set one. A threshold set on one room is a
// hypothesis about every other (CLAUDE.md, "Building for someone else's house").
export const LIVE_STATE_CONFIG = Object.freeze({
  // The quiet gap sleepAnalysis.js bridges inside one awakening: its WAKE_GAP_MIN, duplicated because importing it
  // would pull the database into this file. A test (night-summary.test.js) fails if the two ever differ.
  wake_gap_min: 3,
  // One minute on top of the gap: the missing last-minute row (see rule 6).
  hysteresis_extra_min: 1,
  // The oldest `as_of`, in minutes before the clock, still trusted as "now". Six: a minute's row lands about 7 s
  // after the minute ends, so the data is up to ~1.2 minutes behind the clock at best, and the card re-reads every 3
  // minutes, so an answer can be up to 3 minutes old when it is shown. 1.2 + 3 is about 4.2; one further minute for
  // a poll that was late gives 6 with room to spare, and a night older than that is no longer "right now" however
  // it got here. A starting value; a slower poll would move it.
  stale_after_min: 6,
});

const MIN = 60 * 1000;
const utcMs = (s) => (typeof s === 'string' && s ? Date.parse(`${s.replace(' ', 'T')}Z`) : NaN);
const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

const result = (state, since = null) => ({ state, since });

export function liveState(night, nowMs, facts = null) {
  if (!night || typeof night !== 'object' || night.in_progress !== true) return null;
  const C = LIVE_STATE_CONFIG;

  const asOfMs = utcMs(night.as_of);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(nowMs) || nowMs - asOfMs > C.stale_after_min * MIN) return result('unknown');

  if (!night.onset_at) return result(night.status === 'no_data' ? 'unknown' : 'not_asleep_yet');

  if (night.wake_at) return result('awake', night.wake_at);

  const raw = facts?.sleep?.wakes;
  if (!Array.isArray(raw)) return result('unknown');
  const wakes = [];
  for (const w of raw) {
    const startMs = utcMs(w?.start_at);
    if (!Number.isFinite(startMs) || typeof w.minutes !== 'number' || !Number.isFinite(w.minutes)) return result('unknown');
    wakes.push({ startMs, endMs: startMs + w.minutes * MIN });
  }
  const last = wakes.reduce((a, b) => (a && a.endMs >= b.endMs ? a : b), null);
  if (!last) return result('asleep', night.onset_at);
  if (asOfMs - last.endMs < (C.wake_gap_min + C.hysteresis_extra_min) * MIN) return result('awake', sqlAt(last.startMs));
  return result('asleep', sqlAt(last.endMs));
}
