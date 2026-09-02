// The ambient-baseline + alert state machine for sound detection, extracted from soundDetector.js so
// it can be tested at all. It is pure: it holds no timers, spawns nothing, and takes `now` as an
// argument, so a whole night can be replayed through it in milliseconds.
//
// ★ WHY THIS EXISTS AS ITS OWN FILE (2026-09-02): this logic shipped inside a closure in
// `startSoundDetector`, unexported and therefore untestable, and it was the ONE file on the sleep
// path that `npm run test:core` did not watch — while `sleepAnalysis.js` downstream sat at 99.5%.
// A verified defect (below) lived there for months. The extraction is the fix's real cost, and the
// reason it is worth paying is that the file is now in the coverage include list.

// Rolling ambient EMA. At ~5 readings/s, alpha 0.01 gives a ~20 s time constant — slow enough that a
// cry doesn't get absorbed before it alerts, fast enough to track a fan/AC/white-noise change.
export const BASELINE_ALPHA = 0.01;

// A level that stays ABOVE THE ALERT MARGIN far longer than any cry burst is treated as a new ambient
// floor (the white-noise machine was switched on, a fan, a running tap, the TV) and folded into the
// baseline so it stops alerting. A cry alerts well before this.
export const REBASELINE_MS = 45000;

// ★★★ THE DEAD-BAND ESCAPE — this constant is the fix for a VERIFIED PRODUCTION DEFECT.
//
// The baseline deliberately does NOT track while the trailing average sits between `margin/2` and
// `margin`, so a cry's ramp-up cannot quietly raise its own baseline and desensitise itself. That
// guard was ONE-SIDED and had no time limit, which made the band an ABSORBING STATE: a reading below
// the baseline always passes `over < margin/2` and pulls the baseline DOWN, while a reading inside the
// band updates nothing — so the baseline could only ever ratchet toward the quiet floor, and once a
// step landed it inside the band it stayed there forever.
//
// Measured on prod 2026-08-31, chasing a reported 7-hour "awake" span that never happened: one
// camera's level log printed `ambient=-63.5` on 1891 CONSECUTIVE lines — one value, to 0.1 dB, for
// 7.9 unbroken hours. An EMA with a 20 s time constant cannot do that. The shape is the proof: the
// healthy camera shows a dispersed cluster (-64.1…-64.7, an EMA hunting a floor); the stuck one shows
// an isolated spike with no adjacent values at all. A white-noise machine switched on at bedtime is
// exactly the near-instant step that traps it, and it re-armed every night. With the baseline frozen
// at the daytime floor, every subsequent minute's excursion was inflated and read as "awake".
//
// The fix restores the property the `>= margin` branch already had and the dead band was simply never
// given: ELEVATION SUSTAINED PAST A PLAUSIBLE-CRY DURATION IS AMBIENT, and tracking resumes. Five
// minutes rather than REBASELINE_MS's 45 s because this band is the QUIET one — a sound too quiet to
// alert is the one most likely to be a fan, but also the one a moderate cry sits in, so the escape is
// deliberately slower than the loud branch's. See the trade-off note on `frozenSince` below.
export const DEAD_BAND_MAX_MS = 300000;

// The baseline used to be seeded from a SINGLE 200 ms window, which meant a relaunch that happened to
// land during a cry seeded the ambient floor AT CRY LEVEL — and the detector relaunches 5 s after any
// ffmpeg exit. 25 windows (~5 s) taken as a MEDIAN rather than a mean so one loud window cannot drag
// the seed; the analyser reports nothing at all until it has them.
export const SEED_WINDOWS = 25;

// Map 1..100 sensitivity to how many dB the trailing-average loudness must exceed the ambient baseline
// by. Higher sensitivity => smaller margin => easier to trigger. ~18 dB (needs a clearly loud sound)
// at 1, ~4 dB (quite sensitive) at 100, ~11 dB at the 50 default. This is compared against the AVERAGE
// over the confirm window, so a pulsing cry (loud on average) clears it even though its quiet moments
// dip below.
export function marginDb(sensitivity) {
  const s = Math.min(100, Math.max(1, sensitivity || 50));
  return 4 + (18 - 4) * ((100 - s) / 99);
}

/**
 * Create the per-camera sound analyser.
 *
 * @param {object} opts
 * @param {number} opts.margin    dB above ambient the trailing average must reach to alert.
 * @param {number} opts.trailN    readings in the trailing average (= the confirm window).
 * @param {number} opts.cooldownMs minimum gap between alerts.
 * @param {number} opts.readingMs how far apart readings arrive (200 ms for a 1600-sample window at
 *   8 kHz). Used ONLY to recognise a gap in the stream — see the staleness reset in `push`.
 *
 * `push(rms, now)` returns, for one loudness window:
 *   { baseline, over, confirmed, recordDb, wouldAlert }
 * where `recordDb` is the excursion to feed the activity timeline (null while seeding), `over` is the
 * trailing average minus the ambient baseline, and `wouldAlert` says the alert rules are satisfied.
 * The CALLER decides whether an alert actually fires (it also has to be inside the quiet-hours
 * schedule) and calls `markAlerted(now)` if it did — the cooldown must only start when a notification
 * really went out, not when one was merely eligible.
 */
export function createSoundAnalyser({ margin, trailN, cooldownMs, readingMs = 200 }) {
  // ★★★ THE STALENESS WINDOW — the analyser now OUTLIVES an ffmpeg restart (that is the point: the
  // learned floor used to be thrown away every time), and everything else it holds is either
  // wall-clock or positional, so without this the outage itself counts as observed audio.
  //
  // The ordinary restart is not short: RESTART_DELAY_MS is 5 s and `waitForPath` adds up to
  // PATH_GRACE_MS = 45 s, so a 30–50 s hole is routine. Demonstrated 2026-09-02, before this guard:
  // settle quiet, 20 s of a cry above the margin (so `loudSince` is set but the 45 s absorb has not
  // fired), then a 30 s gap, then ONE reading of SILENCE because the child stopped crying during the
  // outage — and the floor jumped from -58.8 to -45.8. The stale 20-reading window still held the
  // pre-outage cry, so `confirmed` was true and `over` was 13 dB on a reading of a silent room, and
  // `now - loudSince` had cleared 45 s purely by sitting in the gap. The floor then sat ~14 dB too
  // high for about a minute: the same corruption this file exists to fix, arriving through the
  // shared-state door instead of the seeding door.
  //
  // So: a gap longer than the trailing window means every reading in that window is older than the
  // window is meant to reach back, and both elapsed-time rules would be measuring silence we never
  // heard. Drop all of it — but KEEP `baseline`, which is the only thing worth carrying across a
  // restart and the reason the analyser is hoisted in the first place.
  const staleMs = Math.max(trailN, 1) * readingMs;

  let baseline = null;
  const seed = [];
  const recent = [];
  let lastPush = 0;
  let loudSince = 0; // start of the current above-margin run (0 = not currently above margin)
  // Start of the current run in which the baseline is NOT tracking. Deliberately NOT cleared merely
  // by being above the margin: a source oscillating across the margin is still continuously elevated,
  // and clearing it there would hand that source the same permanent freeze this constant exists to
  // end (`loudSince` already resets on every dip, which is why an oscillating source is never
  // absorbed by REBASELINE_MS either).
  // It is cleared in exactly three places, and all three are moments when the floor genuinely moved
  // or the evidence expired: the absorb below, the below-band EMA update, and the staleness reset.
  let frozenSince = 0;
  let lastAlert = 0;

  function push(rms, now) {
    // Defence in depth: `soundDetector.handleReading` already drops non-finite readings (true digital
    // silence gives -Infinity) before calling in here, so in production this is unreachable. Kept
    // because the analyser is a public module now and a NaN would poison the baseline permanently.
    if (!Number.isFinite(rms)) return { baseline, over: null, confirmed: false, recordDb: null, wouldAlert: false };

    // A hole in the stream — see `staleMs`. Everything time- or position-dependent goes; the floor stays.
    if (lastPush && now - lastPush > staleMs) {
      recent.length = 0;
      seed.length = 0;
      loudSince = 0;
      frozenSince = 0;
    }
    lastPush = now;

    if (baseline === null) {
      seed.push(rms);
      if (seed.length < SEED_WINDOWS) return { baseline: null, over: null, confirmed: false, recordDb: null, wouldAlert: false };
      const sorted = [...seed].sort((a, b) => a - b);
      baseline = sorted[Math.floor(sorted.length / 2)];
      seed.length = 0;
      return { baseline, over: null, confirmed: false, recordDb: null, wouldAlert: false };
    }

    // Feed loudness-above-ambient into the per-minute activity timeline (independent of the alert
    // margin/cooldown), so sleep tracking sees continuous noise level, not just cry alerts. Measured
    // against the baseline as it stood BEFORE this reading, so a reading never scores itself.
    const recordDb = Math.max(0, rms - baseline);

    // Trailing average over the confirm window. A cry is loud ON AVERAGE across those seconds even as
    // it pulses, so averaging is far more robust than requiring every instant to clear the bar.
    recent.push(rms);
    if (recent.length > trailN) recent.shift();
    const over = recent.reduce((a, b) => a + b, 0) / recent.length - baseline;
    const confirmed = recent.length >= trailN;

    let wouldAlert = false;
    if (confirmed && over >= margin) {
      if (!loudSince) loudSince = now;
      if (!frozenSince) frozenSince = now;
      if (now - loudSince >= REBASELINE_MS) {
        baseline += over; // absorb the elevation into the ambient
        loudSince = 0;
        frozenSince = 0;
        recent.length = 0;
        return { baseline, over, confirmed, recordDb, wouldAlert: false };
      }
      if (now - lastAlert >= cooldownMs) wouldAlert = true;
    } else {
      loudSince = 0;
      if (over < margin * 0.5) {
        // Below the dead band: normal ambient tracking, and the freeze clock is spent.
        baseline += BASELINE_ALPHA * (rms - baseline);
        frozenSince = 0;
      } else {
        // Inside the dead band. Hold the baseline for a plausible cry's length, then give up and
        // track — see DEAD_BAND_MAX_MS. `frozenSince` is NOT reset once tracking resumes, so the
        // baseline climbs continuously to the new floor rather than stepping once every 5 minutes.
        //
        // ⚠️ KNOWN TRADE-OFF, deliberate: a moderate cry that is loud enough to sit in this band but
        // never loud enough to alert, sustained past 5 minutes, now reads as ambient and its recorded
        // excursion decays toward 0. That is a real loss of signal for sleep tracking. It is accepted
        // because (a) the `>= margin` branch above has always done the same thing after only 45 s, so
        // this is the more conservative of the two, and (b) the alternative is the measured 7.9-hour
        // freeze, which corrupts every minute of the night rather than the minutes of one long cry.
        if (!frozenSince) frozenSince = now;
        if (now - frozenSince >= DEAD_BAND_MAX_MS) baseline += BASELINE_ALPHA * (rms - baseline);
      }
    }
    return { baseline, over, confirmed, recordDb, wouldAlert };
  }

  return {
    push,
    /** Called by the detector after an alert has actually been sent, to start the cooldown. */
    markAlerted(now) {
      lastAlert = now;
    },
    /** Current ambient floor in dBFS, or null while seeding. Used by the periodic level log. */
    get baseline() {
      return baseline;
    },
  };
}
