# "Out of Bed" Detection — graduate the prototype (scope)

The log-only crib→outside prototype (in `motionDetector.js`) **validated on staging Renz the night of
2026-08-20**: it fired `OUT OF BED` at 05:03:36 on his real exit, clean through the sleep window. This scopes
the two agreed follow-up builds: **(1) wire it into sleep analysis** (fix the wake-time bug) and **(2) surface
crib-vs-outside + out-of-bed in the frontend**. Both staging-first.

> Status: PLAN. Prototype = dev PR #131 (log-only). See memory `oob-detection-prototype.md` for the run result
> and `prod-sleep-detection-diagnostics.md` for how to read the data.

---

## The problem it fixes (proven, not theoretical)
Motion-based sleep tracking is **blind to a child who leaves**: once Renz climbed out at 05:03 and left frame,
there was **zero motion 05:05→06:18** — identical to a child sleeping. So `sleepAnalysis` scored the empty crib
as sleep (prod `wake_at` 05:53, inside the dead gap; dev showed "back asleep" till ~06:27). The **"out of bed"
event is the missing signal** that the quiet is *absence, not sleep*. The detector already separates in-crib
(`recordMotion`/`motion_level`) from outside-crib (`recordMotionOut`/`motion_out_level`) motion per frame;
the prototype adds the crib→outside **transition** as a discrete event.

---

## Build 1 — wire OOB into sleep analysis (the numbers fix)

**1a. Persist the event (today it's log-only).** When the detector confirms `OUT OF BED`, write a durable
record so `sleepAnalysis` can read it. Recommended: a **`detection_events` row `type='out_of_bed'`** (reuse the
existing table + feed; NO push/clip yet — insert directly or via a lightweight path, not the full
`fireDetectionAlert` fan-out). Alternative considered: a boolean/flag column on `activity_samples` — rejected
because the transition is sub-second and would be lost in the per-minute bucket; the detector's frame-level
event is more precise. Carry a little detail (outside-peak %) for later tuning.

**1b. Consume it in `sleepAnalysis.js`.** During the night window, an `out_of_bed` event means the child left
the crib → **end the asleep stretch there** (score subsequent zero-motion as awake/absent, not sleep) until
motion *resumes in the crib* (a genuine re-settle) or the window closes. Concretely it should fix: `wake_at`
(final wake = the last out-of-bed with no subsequent crib re-settle), `wake_count`, `awake_minutes`,
`longest_stretch`. Re-entry case: child climbs back in → crib motion resumes → may resettle (a new asleep
stretch); handle both.
- VERIFY in code: exact place `sleepAnalysis` decides asleep/awake per minute + how it picks `wake_at`, so the
  OOB override slots in cleanly (it reads `activity_samples`; add an OOB-events read for the same window).

**1c. Gating.** Only let OOB affect sleep **inside the child's sleep window** (avoid daytime/bedtime-routine
fires — the logs showed lots of evening candidates while people were in the room). Overnight behaviour is
already clean, so this is mostly windowing.

## Build 2 — surface it in the frontend (what the owner asked for)

Today the two channels + OOB events are **backend-only**; the sleep timeline shows a flat asleep/awake state.

**2a. Backend — extend the sleep-detail API.** The night-detail response (feeds `SleepDetail.jsx`) should
return the **per-minute activity channels** (`motion_level` vs `motion_out_level`, or peaks) and the
**`out_of_bed` events** for that night. VERIFY: current shape of the sleep-detail endpoint / `sleepAnalysis`
`out` object and add these arrays.

**2b. Frontend — `SleepDetail.jsx` timeline.** Render crib vs room activity distinctly (two-tone / stacked
band under the sleep bar — in-crib one colour, outside-crib another), and drop an **"out of bed" marker**
(icon/dot) at each OOB time, surfaced in the existing hover bubble too ("05:03 — out of bed"). This makes
"he left the cot at 5:03, room empty until 6:27" legible instead of a flat "asleep". Reuse the existing
`.sleep-tl` timeline + hover infra.

## Build 3 — OOB as an alert (LATER, optional)
A dedicated "Renz is out of bed" push. Needs gating so it doesn't fire during supervised bedtime routine
(require a preceding quiet/asleep period, or sleep-window-only). Defer until 1+2 are solid.

---

## Tuning notes from the 2026-08-20 run (starting constants are decent)
- `OOB_LINK_MS=8000`, `OOB_CONFIRM_QUIET_MS=6000`, cooldown 120s, sensitivity 87, crib zone
  `[{"x":0.12,"y":0.357,"w":0.713,"h":0.558}]` (copied from prod). Overnight = clean (only the real 05:03).
- Evening/morning produced many candidates + fires (people in the room) — expected; irrelevant once gated to
  the sleep window for sleep-scoring, but matters for the Build-3 alert.
- Watch: a parent lifting the child OUT (parent-initiated exit) also reads as out-of-bed — fine for
  "night ended" scoring, ambiguous for an unsupervised-exit alert.

## Phasing (tomorrow)
1. Persist `out_of_bed` events from the detector (1a) — verify rows appear on staging Renz.
2. `sleepAnalysis` consumes them (1b/1c) — re-run the night, confirm Renz's wake_at moves to ~05:03.
3. Sleep-detail API returns channels + OOB (2a).
4. Frontend timeline: two-channel band + OOB markers (2b).
5. Watch another staging night; then decide prod (needs prod Renz on a frame-diff activity leg with a zone —
   it already runs the activity-only leg with a zone during the window, so the channels exist; the OOB detector
   code ships dormant and would start emitting once released).

## Edge cases raised 2026-08-21 (owner) — the "into bed" twin
Two real failures the owner hit, both the **mirror of OOB**. They share one fix: a **crib-entry
("into bed") event = an *outside→crib* motion transition** (child placed/climbs into the crib), the twin of
the crib-exit detector. The core ambiguity is unchanged — an **empty quiet crib looks identical to a sleeping
child** — so quiet alone can't mark sleep; only a *transition into* the crib can.

- **A. False onset — "Renz went to bed 8pm but the row shows he was 'in bed' earlier."** `sleepAnalysis`
  scores onset from when motion first goes quiet, so **pre-bedtime quiet (crib still empty, he's not in it
  yet)** reads as asleep. Fix: **don't allow `onset_at` before the first "into bed" event** of the window
  (child actually placed in the crib). Until an into-bed event, crib-zone quiet = *empty*, not *asleep*.
- **B. Held ~30 min then put back down — "will it say back asleep?"** After a wake/OOB the child is out of
  frame (being held); when placed back, crib motion resumes then quiets. Today any return-to-quiet can
  re-score as sleep. Fix: **a re-settle (new asleep stretch) requires an "into bed" event first**, then
  sustained crib quiet — so the 30-min held gap stays *awake*, and sleep only resumes after the genuine
  put-down. This is Build 1b's "re-entry case" made concrete.

Implication: Build 1 should persist **both** `out_of_bed` (crib→outside) **and** `into_bed` (outside→crib)
transitions; `sleepAnalysis` gates onset/wake/re-settle on them. The detector already has both channels
(`motion_level` in-crib, `motion_out_level` outside) — into-bed is the same state machine with the channels
swapped. Validate into-bed on a staging night the same way OOB was (log-only first, line up against real
bedtime + real put-downs).

## Open questions
- Persist OOB as `detection_events type='out_of_bed'` vs a dedicated table — lean detection_events (reuse).
- Re-settle detection (child climbs back in) — how long of crib motion counts as "back asleep".
- Prod rollout: keep OOB log-only until the sleep wiring is trusted, or ship the event persistence dormant?
- Eventually: does "out of bed" belong in the alerts feed as its own type (with the clip)?
