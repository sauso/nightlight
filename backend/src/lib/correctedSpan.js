// #355, Opus/Codex plan review 2026-11-16: a correction uses the detector's measured
// minute ranges. This module has no database or clock dependency.
const WAKE_ACTIVE_MIN = 5; // Keep equal to sleepAnalysis.js's detector threshold.

const minute = (value) => Math.floor(Date.parse(`${value.replace(' ', 'T')}Z`) / 60000);
const sql = (index) => new Date(index * 60000).toISOString().slice(0, 19).replace('T', ' ');

export function correctedSpanFigures(basis, onset_at, wake_at) {
  const onset = minute(onset_at);
  const wake = minute(wake_at);
  const start = minute(basis.start_at);
  const end = minute(basis.end_at);
  if (![onset, wake, start, end].every(Number.isFinite) || wake <= onset || end < start) return null;

  const wakeRuns = basis.wake_runs.map((run) => [minute(run.start_at), minute(run.end_at)]);
  const gapRuns = basis.gap_runs.map((run) => [minute(run.start_at), minute(run.end_at)]);
  const wakes = [];
  for (const [a, b] of wakeRuns) {
    const from = Math.max(a, onset);
    const to = Math.min(b, wake);
    if (to <= from) continue;
    // #355: clipping at onset gives awake time but cannot invent a wake-up at
    // the start of the parent's night. A short wake-end clip is a stir.
    if (a < onset || (b > wake && to - from < WAKE_ACTIVE_MIN)) continue;
    wakes.push({ start_at: sql(from), end_at: sql(to), minutes: to - from });
  }

  let asleep = 0, awake = 0, unknown = 0, longest = 0, stretch = 0;
  for (let i = onset; i < wake; i++) {
    if (wakeRuns.some(([a, b]) => i >= a && i < b)) {
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
