// THE FAULTY-MICROPHONE GUARD (issue #904). Pure: no database, no clock, and no import from sleepAnalysis.js
// (see isSpikeOnlyMinute for why the sound threshold is passed in rather than imported).
//
// WHAT IT IS FOR. The nightly sleep analysis counts a minute as active when its `sound_peak` is over SOUND_ACTIVE,
// and `sound_peak` is the loudest single ~200 ms window of the minute (activityTracker.js). So a microphone that
// makes one short loud spike every few seconds, in a silent room, makes EVERY minute active, and a still bed
// reports hours of awake time. Real incident, 2026-10-29: one camera in the developer's own two-camera installation
// was moved, and from then on its microphone banged every few seconds (a known fault of that camera model).
// Its per-minute `sound_peak` median went from ~1.5 dB over ambient to 10-20 dB, 100% of its minutes were over
// SOUND_ACTIVE for 9+ hours, and the night read "awake from 19:34" on both databases while the bed was still. The
// sound ALERT path is a separate detector, unchanged by this (it did alert on that night).
//
// HOW IT TELLS A FAULT FROM A PERSON. Two tests, and neither is enough alone:
//   1. SHAPE, per minute (isSpikeOnlyMinute): loud at its peak, while its 75th percentile stays at the floor. The
//      fault's in-bed minutes had a p75 median of 0.0 dB. But p75 over the ~300 windows of a minute only rises
//      when 76 or more of them (over 15 s) are raised, so a child calling out or whimpering for less than 15 s a
//      minute is "spike-only" too: shape cannot protect a motionless, intermittent cry.
//   2. PERSISTENCE, per window (discountedMinutes): the fault ran all night; a crying episode, however
//      intermittent, does not. A spike-only minute is discounted only inside a window of WINDOW_MIN elapsed
//      minutes that was mostly watched (MIN_WATCHED) and mostly spike-only (WINDOW_FRACTION of its watched minutes).
// A discounted minute's SOUND is ignored by the nightly analysis (onset, wake-ups, awake minutes, the timeline);
// its movement still counts. A minute that is not spike-only is never discounted, even inside a faulty stretch:
// a real cry or a sustained noise raises p75 and keeps counting.
//
// WHERE THE NUMBERS CAME FROM (Phase 0 of #904, 2026-10-30): a read-only measurement over 124 camera-nights on
// fresh copies of the production and staging databases of that one installation (two cameras, 30 days). The rule below
// was the only shape found that qualified every fault night and NO other camera-night on either database. A first
// design (a window of 60-120 minutes, and "no movement" as part of a spike-only minute) was measured and rejected:
// one ordinary night (below) could not be told apart from the fault at any window of 120 minutes or less, and a
// real, alerted cry minute can itself be spike-only. On the 2026-10-29 fault night this rule removes about 96-98%
// of the invented awake time (719 awake minutes become 159-179, which is the movement alone).
//
// ⚠️ CALIBRATED NUMBERS (workspace rule: a number tuned on one room is a hypothesis about every other). The margin
// rests on ONE fault and ONE outlier night in 30 days of data from two cameras in one installation; the guard has not been
// seen on a second faulty microphone. What that means for everyone else is stated beside each constant, and in
// docs/sleep-tracking.md and KNOWN-ISSUES.md.

// A minute is SPIKE-ONLY when its p75 is at or below this (dB over the room's ambient, the same scale as
// `sound_peak`). Phase 0: the fault's in-bed minutes had a p75 median of 0.0 dB, and 4 dB is the value the chosen
// rule was measured with (the measurement tried 0.5-6). It is deliberately below SOUND_ACTIVE (6): a minute whose
// p75 is over SOUND_ACTIVE was loud for more than a quarter of the minute, which is a sustained sound, not a spike.
// For everyone else: a microphone whose quiet floor sits more than 4 dB over its own ambient never produces a
// spike-only minute, so for it the guard does nothing and the night is worked out exactly as before.
export const SPIKE_P75_MAX = 4;

// The window, in ELAPSED minutes (8 hours), never in watched minutes: a gap in watching (the daily camera reboot,
// a video stall) does not shrink it, so a few spike-only minutes either side of a long outage cannot be joined
// into one faulty stretch. Phase 0: the longest run of spike-only minutes on any non-fault camera-night was 82
// (one ordinary night on the other camera of that installation, 2026-10-08: noise from elsewhere in the home while
// the child was confirmed asleep, with no movement and no alert), and the longest cluster of real alerted sound was 74 minutes. 480 is
// 5.8x and 6.5x those, and the fault filled it.
// For everyone else, these costs. (a) A night IN PROGRESS gets no discount until its timeline holds 480 minutes: the
// timeline starts 3 hours before the window, so that is about 5 hours into the window when the camera was
// recording in the evening (later when it was not), and until then the live "tonight so far" view still reads the
// fault as awake; a completed night is worked out with the guard, (a') unless its window is shorter than 2 hours:
// a completed night's timeline is at most 180 + window + 180 minutes (sleepAnalysis.js ONSET_LOOKBEHIND_MS and
// WAKE_LOOKAHEAD_MS), which reaches 480 only from a 120-minute window on (#904 review round 2; pinned by "a completed
// night whose window is under 2 hours" in sleep-faulty-mic.test.js). (b) The night's timeline runs from 3 hours
// before the window to up to 3 hours after it, so a sleep window that includes the middle of the day can qualify
// on ordinary daytime noise: Phase 0 found the non-fault cameras reaching 0.85-0.91 in some 8-hour windows when
// every hour of the day was looked at. Known limit, in KNOWN-ISSUES.md.
export const WINDOW_MIN = 480;

// The share of a window's WATCHED minutes that must be spike-only. Phase 0: the worst non-fault window reached
// 0.504 (that same ordinary night, 2026-10-08, the same on both databases; the next worst night 0.39), and the fault's weakest
// qualifying window 0.888 (production) and 0.902 (staging). 0.70 sits between the two.
// For everyone else: a microphone that is faulty only part of the time (spikes in fewer than about 70% of the
// minutes of every 8 hours) is not caught and keeps inventing wake-ups, as before; and a home whose ordinary night
// noise is spikier than that installation's could have real sound discounted. A ticking clock or a steady, spiky noise
// that runs all night IS treated like a fault, by design: its sound is not a child.
export const WINDOW_FRACTION = 0.70;

// A window counts only when at least this many of its minutes were WATCHED (the camera delivered video in them:
// sleepAnalysis.js motionSeen). 0.8 x WINDOW_MIN, set together with the three above in Phase 0, not tuned on its
// own. Unwatched minutes count neither as spike-only nor as quiet, so without a floor a window watched for ten
// minutes would be judged on those ten. For everyone else: a camera that drops more than a fifth of its minutes
// all night never qualifies, and its sound counts as before.
export const MIN_WATCHED = 384;

// Is this minute loud ONLY in brief spikes? `soundPeak` and `soundP75` are the minute's `sound_peak` and
// `sound_p75` (dB over ambient). A NULL p75 is NOT spike-only: that is the safe default (the sound keeps counting),
// not a protection anything relies on. p75 has been stored since 2026-09-15 (#433) and samples are kept 30 days,
// so every night that can still be worked out has one; the demo seed writes none, so the demo never exercises this.
//
// No movement condition, on purpose (Phase 0): a minute with movement is active through its movement anyway, and
// requiring stillness dropped the fault's window share from ~0.85 to ~0.6, which removed all the margin.
//
// `soundActive` is SLEEP_THRESHOLDS.SOUND_ACTIVE, passed in by sleepAnalysis.js and never copied here. Importing it
// would be circular (sleepAnalysis.js imports this module) and would make this pure module open the database
// (sleepAnalysis.js opens it at load). It is required: a missing one would silently switch the guard off
// (`x > undefined` is false), so it throws instead.
export function isSpikeOnlyMinute({ soundPeak, soundP75 }, soundActive) {
  if (typeof soundActive !== 'number' || !Number.isFinite(soundActive)) {
    throw new TypeError('isSpikeOnlyMinute: soundActive must be a finite number (SLEEP_THRESHOLDS.SOUND_ACTIVE)');
  }
  return soundPeak != null && soundPeak > soundActive && soundP75 != null && soundP75 <= SPIKE_P75_MAX;
}

// Which minutes' sound is discounted. `minutes` is the night's WHOLE timeline, indexed by elapsed minute from its
// first minute (sleepAnalysis.js: 3 hours before the window, through the window, and, for a completed night, the
// post-window span the morning is read from), each entry `null` (not watched, or no row) or `{ spikeOnly }`.
// Returns a boolean array of the same length: true for every spike-only minute inside ANY qualifying window.
//
// THE WINDOW CONVENTION. A window is the minute indices [i, i + WINDOW_MIN), for every i with i + WINDOW_MIN <=
// minutes.length. A window that would run past either end of the timeline is not evaluated: it is not padded, and
// it is not judged on the part that exists. That costs nothing at a completed night's edges (every minute sits in
// many full windows) and is what gives an in-progress night no discount until 480 minutes exist (WINDOW_MIN, cost
// (a)). It qualifies when its watched minutes are >= MIN_WATCHED and spike-only / watched >= WINDOW_FRACTION
// (computed as that division, the arithmetic Phase 0 measured with).
//
// Recovery is automatic: once a microphone is fixed or replaced, the windows after it stop qualifying, and its
// sound counts again. Not at once: a window that still reaches back into the faulty stretch can qualify, so a
// spike-only minute (a short noise, or a short motionless cry) just after a fault can still be discounted. A minute
// that is not spike-only never is.
//
// HOW FAR, derived (the bound is on WATCHED minutes, plus the unwatched ones a window may hold). A discounted
// spike-only minute sits in a window with >= MIN_WATCHED watched minutes of which >= WINDOW_FRACTION are spike-only:
// at least 269 spike-only minutes (ceil(0.70 x 384) = 269; the minute itself is one of them). The rest of the 480,
// at most 480 - 269 = 211 minutes, is quiet or unwatched, and it can sit between the fault's last minute and the
// discounted one: at most 96 unwatched (480 - MIN_WATCHED; unwatched minutes do not count against a window's share,
// the "elapsed, not watched" rule above) and, of the watched ones, at most 3/7 of the spike-only count (0.30 of the
// watched), 115 at 269 spike-only. So after a fault of 268+ spike-only minutes, a spike-only minute can be
// discounted up to 211 + 1 = 212 minutes after the fault's last minute (115 quiet + 96 unwatched in between), and
// by symmetry up to 212 before its first. WITHOUT any gap in watching the window is all watched, needs 336
// spike-only, and the bound is 480 - 336 = 144 quiet minutes in between (1 - WINDOW_FRACTION) x WINDOW_MIN. Checked
// against a run: 269 fault minutes, a 96-minute camera gap, 110 quiet minutes, a 5-minute motionless cry: S = 274 of
// 384 watched = 0.714, so the cry, which begins 207 minutes after the fault's last minute, is discounted.
// Pinned at the edge, and one past it on each of the three limits, by "how far past a fault" in micGuard.test.js.
// O(n) with prefix sums and a difference array; a night's timeline is about 1,500 minutes.
export function discountedMinutes(minutes) {
  if (!Array.isArray(minutes)) throw new TypeError('discountedMinutes: minutes must be an array');
  const n = minutes.length;
  const out = new Array(n).fill(false);
  if (n < WINDOW_MIN) return out;
  // watchedBefore[k] / spikeBefore[k]: how many of minutes [0, k) were watched / spike-only.
  const watchedBefore = new Int32Array(n + 1);
  const spikeBefore = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const m = minutes[k];
    watchedBefore[k + 1] = watchedBefore[k] + (m ? 1 : 0);
    spikeBefore[k + 1] = spikeBefore[k] + (m && m.spikeOnly === true ? 1 : 0);
  }
  // cover[k] > 0 (after the running sum below): minute k lies inside at least one qualifying window.
  const cover = new Int32Array(n + 1);
  for (let i = 0; i + WINDOW_MIN <= n; i++) {
    const watched = watchedBefore[i + WINDOW_MIN] - watchedBefore[i];
    if (watched < MIN_WATCHED) continue;
    if ((spikeBefore[i + WINDOW_MIN] - spikeBefore[i]) / watched < WINDOW_FRACTION) continue;
    cover[i]++;
    cover[i + WINDOW_MIN]--;
  }
  // Only a spike-only minute is ever marked: a real cry or a sustained noise inside a faulty stretch keeps counting.
  let inside = 0;
  for (let k = 0; k < n; k++) {
    inside += cover[k];
    out[k] = inside > 0 && minutes[k] != null && minutes[k].spikeOnly === true;
  }
  return out;
}
