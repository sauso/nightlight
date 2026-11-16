// #355, Opus/Codex plan review 2026-11-16: a correction uses the detector's measured
// minute ranges. This module has no database or clock dependency.
//
// The counting rule is DELIBERATELY re-expressed here over runs rather than shared with the
// detector's accumulateMetrics (sleepAnalysis.js), which works on per-minute arrays inside
// computeNightPass and stays there untouched (#355 review, Opus L5: hoisting it bought nothing and
// changed a core file). Over the detector's own span (its onset to the minute its counting stopped,
// `sleep_end_at`) the two give the same five figures, including a run the detector's own wake cuts
// short (fix rounds 2 and 3, Opus M1: the short-piece rule below once dropped such a wake-up, at the
// detector's own wake and then at a corrected wake a minute later). Tests in
// sleep-night-facts.test.js pin that on real nights: "over the detector's own span the figures equal
// the detector's", and "a run cut by the detector's own wake" (an adopted exit cutting a four-minute
// run, and wakes either side of it); the invariant tests pin the rest. Spans a parent moved are where the rules here are
// judgements (stated below).
const WAKE_ACTIVE_MIN = 5; // Keep equal to sleepAnalysis.js's detector threshold.

const minute = (value) => Math.floor(Date.parse(`${value.replace(' ', 'T')}Z`) / 60000);
const sql = (index) => new Date(index * 60000).toISOString().slice(0, 19).replace('T', ' ');
// #355 review (Codex L3): runs are sorted and overlapping or duplicate ones merged first, so one
// continuous wake is one wake-up and wake_count <= awake_minutes holds for ANY input, not only for
// the disjoint, ordered runs computeNight happens to produce.
const mergedRuns = (runs = []) => {
  const sorted = runs.map((run) => [minute(run.start_at), minute(run.end_at)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort(([a, b], [c, d]) => a - c || b - d);
  const merged = [];
  for (const [a, b] of sorted) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
};

export function correctedSpanFigures(basis, onset_at, wake_at) {
  const onset = minute(onset_at);
  const wake = minute(wake_at);
  const start = minute(basis.start_at);
  const end = minute(basis.end_at);
  if (![onset, wake, start, end].every(Number.isFinite) || wake <= onset || end < start) return null;

  const wakeRuns = mergedRuns(basis.wake_runs);
  const gapRuns = mergedRuns(basis.gap_runs);
  const activeRuns = mergedRuns(basis.active_runs);
  // A basis without the detector's onset (none is produced today) treats no minute as pre-onset.
  const detectorOnset = basis.onset_at ? minute(basis.onset_at) : onset;
  // Where the detector's own counting stopped. Fix rounds 2 and 3 (Opus M1): a run that began before
  // it was a counted wake-up for the detector, however short the piece the detector kept, so it stays
  // one whenever the corrected wake is at or after that minute (an onset-only correction, a save that
  // re-sends the detector's wake, or a later wake that cuts the same run a minute or two further on).
  // Accepted limit: this is the FRESH compute's end, while the snapshot is checked against the stored
  // row; on a locked night whose fresh wake has drifted the two can differ by those minutes (the same
  // class as every basis here: measured fresh, validated against storage).
  const detectorEnd = basis.sleep_end_at ? minute(basis.sleep_end_at) : null;
  const wakes = [];
  for (const [a, b] of wakeRuns) {
    const from = Math.max(a, onset);
    const to = Math.min(b, wake);
    if (to <= from) continue;
    const countedByDetector = detectorEnd !== null && a < detectorEnd && wake >= detectorEnd;
    // #355: clipping at onset gives awake time but cannot invent a wake-up at
    // the start of the parent's night. A run cut by a corrected wake counts
    // only if the piece is at least WAKE_ACTIVE_MIN minutes long (#355 review,
    // Opus L2) unless the detector counted that run (above): so a parent's wake
    // EARLIER than the detector's, or a later one cutting a run that began at
    // or after the detector's wake (its morning run). A stated approximation:
    // the detector compares that minimum with a run's ACTIVE minutes, and a
    // clipped piece can hold quiet minutes the detector bridged. Shorter pieces
    // stay awake minutes (a stir).
    if (a < onset || (b > wake && !countedByDetector && to - from < WAKE_ACTIVE_MIN)) continue;
    wakes.push({ start_at: sql(from), end_at: sql(to), minutes: to - from });
  }

  let asleep = 0, awake = 0, unknown = 0, longest = 0, stretch = 0;
  for (let i = onset; i < wake; i++) {
    // #355 review (Opus M1), a judgement, not a measurement: the detector's
    // wake walk starts at its own onset, so a corrected onset EARLIER than
    // that has no wake runs before it. An active minute there (in-bed
    // movement before the detector's put-down) counts as awake and breaks the
    // stretch, but is never a wake-up, because the detector never judged that
    // range for one. Quiet minutes there are asleep; gaps are unknown.
    if (wakeRuns.some(([a, b]) => i >= a && i < b)
        || (i < detectorOnset && activeRuns.some(([a, b]) => i >= a && i < b))) {
      awake++;
      stretch = 0;
    } else if (i < start || i >= end || gapRuns.some(([a, b]) => i >= a && i < b)) {
      // #355/#442: unseen minutes on either side of the basis, or in a gap,
      // are unknown even when the corrected span includes them.
      unknown++;
      stretch = 0;
    } else {
      asleep++;
      stretch++;
      longest = Math.max(longest, stretch);
    }
  }
  return {
    asleep_minutes: asleep, awake_minutes: awake, unknown_minutes: unknown,
    wake_count: wakes.length, longest_stretch_minutes: longest, wakes,
  };
}
