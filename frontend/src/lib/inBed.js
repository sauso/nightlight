// "In bed" beside "Asleep" (issue #501): should a night show the put-down as its own time?
//
// Only when it is at least a minute BEFORE the onset. On a bedtime-story night the two are minutes
// apart and the parent wants both — the app used to show only "asleep", which read as a wrong bedtime
// to the person who did the putting down. On most nights there is no gap worth a line, and a second time
// on every card would just be noise.
//
// ⚠️ ONE-DIRECTIONAL, never an absolute difference. `in_bed_at` is the put-down transition's own
// timestamp and carries its real second; `onset_at` is floored to the minute. So on a night where the
// child was asleep the moment they went down, in_bed_at can sit up to 59 s AFTER onset_at — an absolute
// difference would show "In bed 19:47 · Asleep 19:47" there.
//
// ⚠️ NEVER on a night whose ONSET a person corrected. The server's correction overlay (applyCorrection
// in sleepReviews.js) replaces onset_at with the person's time but leaves in_bed_at as the ALGORITHM's
// put-down — the very estimate they just rejected. The one-way check above only catches half of that:
// a corrected onset EARLIER than the stale put-down. A LATER one passed it, and the card read "In bed
// 19:47 · Asleep 20:05" where 19:47 was the computed bedtime the person overrode with a real 20:05
// put-down (found in adversarial code review, 2026-09-25). So "Asleep" stands alone there, the same
// choice this feature makes everywhere: one right time over a pair that may not describe one night.
//
// "Onset corrected" is read as `corrected && onset_at !== algo_onset_at`, from the two fields the
// overlay already sends. A WAKE-only correction leaves onset_at equal to the algorithm's, so the
// put-down still belongs to the same story as the onset and keeps showing. The one case this reads as
// "not corrected" is a person typing exactly the computed onset — where the computed put-down is still
// coherent with it, so showing it is right.
const utcMs = (utc) => Date.parse(`${String(utc).replace(' ', 'T')}Z`);

export function onsetWasCorrected(night) {
  return Boolean(night?.corrected) && night.onset_at !== night.algo_onset_at;
}

export function showsInBed(night) {
  if (!night?.in_bed_at || !night?.onset_at) return false;
  if (onsetWasCorrected(night)) return false;
  return utcMs(night.onset_at) - utcMs(night.in_bed_at) >= 60000;
}
