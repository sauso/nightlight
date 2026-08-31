# Nightlight — Roadmap

The single list of **open** work. If something isn't here, it's either shipped (see `CHANGELOG.md`)
or a deliberate non-goal (§6).

**Ground rule:** this file tracks *intent*. `CHANGELOG.md` is the record of what actually shipped —
when the two disagree, the changelog is right. Update this file in the same commit that changes the
plan, and **delete an item from here the moment it ships** — cutting a release is the checkpoint where
that gets verified (see the `release` skill's roadmap gate). An item that turns out not to be worth
building goes to §4 *with the evidence*, so it doesn't get re-proposed later.

> **History note:** `planning/` previously held 12 per-feature scope docs, most describing work that had
> already shipped — several still headed "Not started" months after release, and one
> (`ux-refresh-v2-scope.md`) specifying a nav that was built and then abandoned. They were deleted in
> favour of this file (2026-08-24), and `on-demand-recording-scope.md` followed once that feature
> shipped in 0.25.0. The full text of each remains in git history if the design reasoning is ever needed.

**Status vocabulary:** `NEXT` (agreed, ready to start) · `SPECCED` (design settled, unbuilt) ·
`IDEA` (worth doing, not committed) · `HELD` (blocked or waiting on something).

---

## 1. Next up

### 1.1 Fix Raffa's bed-zone discrimination — `CLOSED` (shipped in 0.27.0; kept for the diagnosis)
**Closed 2026-08-29.** Four consecutive owner-confirmed mornings on the re-aimed camera: 05:09
(08-25), 05:53 (08-27), 05:54 (08-28) and 05:20 (08-29), every one exact. The framing question is
settled — re-aiming plus redrawing `detect_zone` fixed it. ⚠️ The false `into_bed` events this section
originally blamed on Raffa's framing later appeared on **Renz's** camera too, so that failure mode was
never per-camera; it is tracked in 1.2 and its own cause (a bed zone cutting through a sleeping child)
was fixed by enlarging the zone. **Kept rather than deleted because the diagnosis below is the worked
example of "moving a camera without redrawing the zone makes detection worse, not better".**

**It was a camera-framing problem, not a code problem.**

On the night of 2026-08-24→25 there was **no `out_of_bed` transition anywhere near Raffa's real 06:10
exit** (the last one was 01:22), and the detector then logged three *false* `into_bed` events after he
was already out (06:33, 06:43, 06:56). Bed-zone motion kept registering until 07:02 despite the bed
being empty from 06:10. Transition peaks are also much weaker than Renz's (0.013–0.037 vs up to 0.2).

The zone covers ~19.5% of the frame, much of it bare wall, and misses most of the bed — so "inside the
bed" and "outside the bed" aren't actually distinguishable for that camera.

**Work:** re-aim the camera so the bed fills more of the frame and the floor beside it is visible, then
**redraw `detect_zone`** — it is stored as normalised frame fractions, so *moving the camera without
redrawing points the zone at the wrong things and makes out-of-bed detection worse, not better*. The
grid picker (paint the cells covering the bed) can follow a diagonal bed that the old rectangles
couldn't. Then review a few mornings against ground truth.

**Update 2026-08-27.** Second clean night in a row: Raffa's wake came out at **05:53, owner-confirmed
exact**, and his put-down at 19:11 matched an observed 19:10. The re-aim worked. But the false
`into_bed` events this section blamed on Raffa's framing turned up on **Renz's** camera the same night
(four of them), so that failure mode is **not** a per-camera framing problem — see 1.2. Close 1.1 on
the framing question; the classifier is tracked separately.

### 1.2 Harden the bed-transition classifier — `NEXT`
**Most of this shipped in 0.27.0. What remains is items 1 and 3 below.** 0.26.0 stopped the timeline
*claiming* things this detector can't support (only the two adopted transitions are drawn, everything
else is "movement outside the bed"). That was a containment; 0.27.0 fixed several of the underlying
causes — the slow-link exit rule, the outside-channel threshold, the settling-episode marker, and the
empty-bed onset guard.

**Measured after 0.27.1, against owner ground truth (2026-08-28):** Renz exact on both onset (20:17)
and wake (05:29); Raffa's marker exact (in@19:51), wake exact (05:20), wake count exact (0), onset 18
minutes after his mother left the room. That is the best the classifier has ever measured — but it is
two children on one night, which is why this stays `NEXT` rather than closing.

⚠️⚠️ **0.27.0 shipped the empty-bed guard BROKEN and the numbers above were staging-only.** The guard
thresholded the *maximum* in-bed peak; prod's samples for the same empty room held one 0.0045 blip and
cleared it, so prod still reported that night as 16:56. Fixed in 0.27.1 by counting *minutes* of
movement rather than magnitude. **Two rules came out of it and both are now standing practice: an A/B
must run against BOTH databases, because prod and staging run independent detectors against the same
cameras and their `activity_samples` are different data; and "is anyone in this bed" is a question
about how OFTEN it moves, never how hard.**

⚠️ **The remaining failure mode is the one no amount of threshold work fixes:** the detector cannot
tell a parent's hands leaving the bed from a child climbing out, because motion in two zones is all it
has. That is item 3, and it is the same gap §2.5 (camera occupancy) exists to close from the other
side.

**Two of the three causes below have since been addressed; item 2 has not.** The owner enlarged Renz's
bed zone on 2026-08-27 after spotting in the timelapse that he sleeps with his head outside it, and the
night of 2026-08-27 measured **zero** false `into_bed` events during sleep against four the night
before, with outside-only minutes going 0 → 8. A zone that cuts through the sleeping child was the
upstream cause of the false arrivals, not the classifier's thresholds. Separately the exit rule now has
a slow link window (see the entry under `[Unreleased]`), which fixes the missed unaided climb-out.
What remains is the occupancy state and telling a parent leaving from a child getting out.

**What's wrong**, measured on 2026-08-26 against owner ground truth (nobody entered Renz's room all
night; Raffa put down 19:10, his mother out at 19:19):

- **No occupancy state.** `motionDetector.js` runs the out-of-bed and into-bed detectors as independent
  stateless twins, so nothing stops two arrivals in a row. Renz's night emitted **four consecutive
  `into_bed` with no `out_of_bed` between any of them** — physically impossible, and the cheapest
  possible check isn't there.
- **A child rolling over reads as an arrival.** The false events had bed peaks 0.020–0.042; Raffa's
  *genuine* put-down was 0.014. **Magnitude alone cannot separate them** — a naive floor would delete
  the true positives. What differs is the *outside* channel: a person entering produces a large,
  sustained out-of-zone signal, a stir produces essentially none. Today `into_bed` records only
  `ibPeakCrib` (the bed side), so the discriminating evidence is thrown away at the moment of capture.
- **A parent walking away is indistinguishable from a child climbing out.** Both are "bed moved, then
  outside moved, then bed went quiet". Renz's 18:50 `out_of_bed` was his father leaving the room, and it
  opened a child-out interval that ran until the first false arrival at 23:12.

★★ **MEASURED 2026-08-29, and item 1 now has a hard target.** Across the 238 transitions then stored
on prod, **147 (62%) are the same type twice in a row** with nothing between — Raffa Room 61 of 109
(56%), Renz Room 86 of 129 (67%). You cannot get into a bed you are already in, so at least one of every
pair is wrong. `getImpossibleTransitions()` in `lib/bedTransitions.js` returns them, each naming the
event it contradicts, per camera. **Item 1 should collapse most of those 147, and that is now a number
this work can be scored against rather than an argument.**

★★ **0.29.0 ships the missing evidence: a saved frame at every transition** (`bed_transitions.snapshot`
+ `transition-snapshots/`, 45-day retention in lockstep). Until now the detector recorded *when* it
thought the bed changed with no way to see what it was looking at when it decided. Combined with the
query above, the wrong events now collect themselves with a picture attached — which is both the way to
diagnose item 3 and the only honest test set for §2.5.

⚠️ These bad transitions do **not** currently corrupt reported sleep — the analysis uses episode grouping
and the occupancy guard rather than trusting raw event labels. They are why per-event markers still
cannot be drawn, which is exactly what "done when" below asks for.

★★★ **MEASURED 2026-08-30 — RENZ'S ZONE DOES NOT SIT ON HIS BED, AND NOTHING CHECKS THAT IT DOES.**
Drawn over a real transition snapshot, his painted `detect_zone` is a rough rectangle over the LEFT of
the room. It includes wall and **a curtain that moves**, and it stops at x=62% while the bed runs to
about x=80% — excluding the foot end past where the safety rail stops, which is the gap he climbs out
through. So his exits appear as motion *outside* the bed, the exit rule has no bed motion to link from,
and the curtain manufactures transitions that never happened.

| | body moving in the room (outside ≥ 0.05) | ...with the bed **exactly 0.0000** | linkable |
|---|---|---|---|
| Raffa | 308 min | **5 (2%)** | 97% |
| Renz | 636 min | **41 (6%)** | 77% |

2026-08-29: last bed motion 05:52, bed then **0.0000**, a plain body burst outside at 05:59 (0.070) —
seven minutes later, far outside even the slow window, so no candidate ever opened. Next recorded exit
**07:36** against an observed ~06:00.

⚠️⚠️ **His zone is 38.5% of frame — LARGER than Raffa's 23.4%. Every number said it was fine.** Area and
rect count prove nothing about whether a zone is in the right *place*. This was only visible by drawing
it over a frame, which the transition snapshots now make possible.

★★★ **UPDATE 2026-08-30 — step 0 below is DONE, and every measurement in this section above
is PRE-REPAINT.** Both zones were redrawn over real frames and mirrored prod → staging
(byte-identical: Raffa sha `22feeadf13ca7dc1`, Renz sha `cfa17b32a5368d7f`). Renz went 38.5% →
**22.57%** of frame, Raffa 23.4% → **13.02%**. A **10-day monitor phase runs to ~2026-09-09 as a
HOLDOUT** — those nights are deliberately not tuned on, and the tables above are re-measured at the
end with identical arithmetic. Until then treat the 62% / 38.5% / 23.4% figures and the minute
counts as **historical**, not as the current state.

**Two pieces of work, and the first is free:**
0. **Repaint the zone** to follow the mattress and exclude the curtain. No code. Do this first, then
   re-measure the table above before building anything — it may move most of the gap on its own.
1b. **Warn when a zone looks wrong.** Nothing today tells anyone their zone excludes the bed; it fails
   silently and looks like a detector problem. Candidates: flag a zone whose area overlaps little of
   where in-bed motion actually occurs, or simply show the zone over a recent frame in settings.
   ★ This is the generalisable half — every installation paints its own zone, and every one of them can
   be wrong in exactly this way.

**Work:**
1. Track believed occupancy; ignore an `into_bed` while already in bed and an `out_of_bed` while already
   out. (Alone this collapses the four arrivals to one.) — **still open**, and still the cheapest win.
   ★ Target: the 147 impossible pairs above.
   ★ This is *inferred* occupancy and needs no model — do it regardless of §2.5, which would supply the
   same fact as independent evidence from the camera. They are complementary; neither waits on the other.
2. Record the outside channel's **peak and duration** alongside each transition — new columns on
   `bed_transitions` — and require substantial outside evidence for `into_bed`, symmetric for
   `out_of_bed`. — **lower priority now**: the zone fix removed the false arrivals this was aimed at,
   and the evidence columns are still worth having, but no longer urgent.
3. Separate "parent leaves" from "child exits". Retrospective is fine: the nightly job runs after the
   night, so an `out_of_bed` followed by continued in-bed micro-motion is a parent leaving. — **still
   open, and now the most valuable item.** Measured 2026-08-27: the real put-down at 19:14 was recorded
   as an `out_of_bed` (the parent's hands leaving the bed), so that night had no bedtime `into_bed` at
   all and the drawn marker was 40 minutes adrift. The reported bedtime survived it, but only because
   the sleep analysis no longer depends on the label being right.
4. **New: log-driven tuning is now possible.** The exit rule logs rejected links (`[oob] … link
   rejected`) with the actual gap and outside magnitude, so the real distribution can be read off a
   week of logs rather than guessed. Read it before moving `OOB_LINK_SLOW_MS` or `OOB_SLOW_OUT_MIN`.

**Tune it offline, don't guess.** `bed_transitions` retains 45 days and `activity_samples` 30, so there
is a real corpus already on staging. Add the evidence columns first, then let a week accumulate before
choosing thresholds — the same discipline that produced `EMPTY_BED_MAX_PEAK` and
`MAX_POST_EXIT_ACTIVE_MIN`.

**Done when** a night's per-event markers are trustworthy enough to draw again, i.e. no impossible
sequences across a week and the put-down/departure pair still matches ground truth.

### 1.3 Sound is not a per-room signal — `IDEA`
Fallout from the same night. A bedroom mic hears the whole house: 16 of the 19 sound-active minutes
that were holding Renz's onset an hour late were simultaneously loud in his brother's room, while his
own bed never moved. 0.26.0 handles this for **onset** only (a sound-only minute counts as awake only
once a put-down proves the child is in the bed, and only if that room also moved nearby).

**Partly closed — SHIPPED in 0.27.0.** The first *half hour* after onset now uses the same witness rule,
because
fixing bedtime moved the problem rather than removing it: the noise that had been delaying onset
reappeared immediately as the first wake-up. Across all stored nights that removed exactly three
counted wakes, every one of them 15–22 minutes after onset, and one of them owner-confirmed false
(2026-08-26 Renz, asleep and motionless, nobody in the room).

What is still open is the **rest of the night** — deliberately left alone, because mid-night the house
is quiet and a cry with no movement is exactly the wake-up a parent wants counted. Worth measuring
before touching: across all nights on record, how many counted wakes are sound-only *and* simultaneous
with noise in the sibling's room? If that number is large, the wake rule needs the same treatment. If
it's small, leave it alone. **Measure first.**

---

### 1.4 The ambient sound baseline can freeze — `NEXT`

★★★ **VERIFIED 2026-08-31 in production logs, not inferred.** One camera’s ambient baseline sat at
exactly `-63.5 dB` for **1891 consecutive log lines — 7.9 unbroken hours** — while the room ran
8–12 dB above it. The working camera in the same house shows a dispersed cluster of baseline values
(an EMA hunting a floor); the stuck one shows an isolated spike with no adjacent values at all.

**The mechanism.** `soundDetector.js` takes exactly one of three paths per reading, keyed on `over`
(trailing-average loudness minus baseline), where `margin = marginDb(sound_sensitivity)`:

| `over` | what happens to the baseline |
|---|---|
| `< margin/2` | the EMA tracks the room |
| `[margin/2, margin)` | **nothing at all** |
| `>= margin`, held 45 s | absorbed into the baseline |

The middle band is an **absorbing state**: the only thing that lowers `over` is the baseline rising,
and the baseline only rises in the other two branches. The guard is also one-sided — a room *below*
the baseline always pulls it down — so the floor ratchets toward the quiet level and cannot climb
back. `loudSince` resets on any dip under `margin`, so a source hovering around the margin never
completes the 45 s clock. It is a **step response**: a slow ramp is absorbed fine, an instant step is
not — and a white-noise machine switched on at bedtime against a daytime baseline re-arms it nightly.

⚠⚠ **This is not one house.** The trap band sits *below* the alert margin and *above* sleep’s
`SOUND_ACTIVE`, so it produces no alert, no log line and no error while marking every minute active.
The shipped default `sound_sensitivity = 50` puts the band at 5.5–11.1 dB — squarely where a nursery
white-noise machine or fan lands. Turning sensitivity *down* to reduce alerts moves the band *up*.

★★★ **THE ROOT CAUSE IS DEEPER THAN THE FREEZE, and it decides the fix.** `sound_peak` is the
per-minute **MAXIMUM** of ~300 windows (`activityTracker.js`) measured against a floor that tracks a
**central tendency**, so `max - mean ≈ 2.9σ`: sleep’s 6 dB threshold is really a statement about the
room’s **variance**, not its loudness. Simulated on a stationary, silent room, share of minutes
reading “active”: at σ = 2.0, **36%** with a correctly-tracking EMA and **100%** with a p10 floor.
❌ **Do not just swap the floor** — a low-percentile floor under a MAX recorder is *worse*, and it
reproduces the corruption it was meant to remove. ✅ **Match the statistics**: record a percentile or
mean of the minute’s excursion rather than its max, or define the floor at whatever statistic the
recorder uses. That fixes the freeze and the variance problem together.

**Measured on the affected room**: even with a perfectly healthy baseline it would still read ~41% of
minutes active (against 19% for the other room), so fixing only the freeze is a partial fix.

**Prerequisite work.** `soundDetector.js` has **no tests** and is not in the `test:core` include
list; `handleReading` is a closure inside `launch()` inside `startSoundDetector`, so nothing is
reachable from a test. Extract the reading pipeline behind an injectable clock first.
⚠️ **Tests must discriminate, not merely pass.** “Step the level, assert it decays” is passed by a
2-minute window, by a median floor and by a p90 floor alike. The test that kills all three is
**“a 6-minute continuous cry must stay above `SOUND_ACTIVE`”**, plus asserting the floor’s exact
value at a known time after a known step (which is what pins the window length).

**Held until the monitor phase ends (~2026-09-09)**: the fix changes the input to the frozen sleep
algorithm, and a mid-holdout change to `activityTracker` would perturb the very measurement the
phase exists to take. Documented as a known limitation in `docs/notifications.md` meanwhile.

## 2. Specced, not built

### 2.1 Sub-stream sanity check — warn when "Low" isn't actually low — `SPECCED`
Nothing verifies that a configured `sub_rtsp_url` is actually *smaller* than the main stream. Found on
prod 2026-08-25: one camera's `/ch1` was serving **1920×1080 @ 15fps — identical to its main stream**.
Cause: **the camera's second encoder was disabled, and the firmware answered `/ch1` with the main
stream instead of refusing it.** Nothing anywhere reported a problem. Two silent consequences, neither
of which surfaced in the UI:

- The **Low** quality option delivers the same bitrate as High, so the feature does nothing for that
  camera while looking like it works.
- The motion detector prefers the sub path precisely because it's cheap to decode. Decoding 1080p
  instead of 360p cost **5.9% of a core vs 1.2%** — the single largest FFmpeg line in the container,
  ~5× what it should be.

**The check has to measure the actual stream, not read configuration back.** ONVIF reported
`Profile_1` = 640×360 mapped to `/ch1`, and the camera's own settings page agreed — both described a
substream that wasn't being produced. Only probing the RTSP endpoint revealed it. (This firmware also
reports an identical canned `fps=30, bitrate=5000` for every profile, matching no actual stream, so its
encoder figures can't be trusted as a live read either.)

**Proposal:** probe the sub's resolution when a camera is saved (ffprobe already runs there via
`validateRtspStream`) and store it alongside the main's. If the sub isn't meaningfully smaller, say so
on the camera's detail/diagnostics screen — "this sub-stream is delivering the same resolution as the
main stream; Low won't save bandwidth". A warning, not a block: the fix is on the camera, and refusing
to save would be unhelpful. Worth re-checking periodically rather than only at save time, since someone
can disable the camera's second encoder long after Nightlight was configured — which is exactly what
happened here.

### 2.2 Cry classification — `SPECCED`
Sound detection today alerts on **loudness** (FFmpeg `silencedetect`), not on what the noise *is*. The
agreed staging was always: prove motion+push → add sound presence → tune against real usage → *only
then* evaluate cry-specific classification, informed by how well plain sound detection performs.
Sound detection has been live since 0.12.0, so this is now genuinely evaluable.

Distinguishing a baby crying from a dog barking, a TV or a door slam is a real audio-classification
problem. A spare **USB Coral** may accelerate it, but it must stay **optional and runtime-detected**
with a CPU fallback — the app has to run fully without one, and everything shipped so far is
deliberately Node + FFmpeg only (no Python in the runtime image).

### 2.3 Testing — `IN PROGRESS`

**Target (owner, 2026-08-26): core logic at >= 95% line coverage, checked before promoting to
production. A TARGET, not a hard blocker** — breadth is still being built out, so an uncovered module
does not stop a release. What is enforced is a **ratchet**: `backend/package.json`'s `test:core` script
pins thresholds over an explicit include list, CI runs it on every push and PR
(`.github/workflows/test.yml`), and the `release` skill checks it. It fails only when coverage
*regresses* on a module already in the list. **That include list IS the definition of "core logic" —
extend it as each module reaches the bar, and never shrink it to make the check go green.**

In the gate today at **97.8% lines**: `db.js`, `middleware/auth.js`, `lib/mfa.js`,
`lib/detectionEvents.js`, `routes/timelapses.js`, `lib/wakeWatcher.js`, `lib/bedTransitionRules.js`,
**`lib/sleepAnalysis.js`** (added 2026-08-29 at 99.5% lines / 97.4% functions).

**Tranche A of the sleepAnalysis work is DONE** (84.1% -> 99.5%): `sleepInsights` + `pearson`,
`runNightlySleepJob` + `startSleepJob`, `getStoredNights`, the window gates, and `nightClimate`'s
5-minute series. ★ It found a real bug on the way in — see "daylight saving" below. ★ It also found
the FIXTURES asserting a physical impossibility (a still in-bed minute at a motion peak below any
occupied bed on record, i.e. the empty-bed signature). **When a new guard breaks old tests, check the
fixture is physically possible before touching the code.**

**Tranche B is effectively CLOSED — Tranche A absorbed it.** Six uncovered lines remain and the gate is
met with headroom, so what is left is deliberate, not pending:
1. `lastCompletedNightDate`'s 4-day fallback — unreachable unless every candidate window is still open.
2. `firstQuietRunFrom` returning null (a night that never settles) and `hasAwakening` returning false.
3. **The nightly job's outer try/catch** — knowingly uncovered. Reaching it needs a failure inside
   better-sqlite3, which is not worth faking. ★ **Coverage caught a test of mine claiming to cover this
   and passing for the wrong reason**: it asserted `doesNotThrow` against a garbage sleep window, but
   `parseHm` defaults that to 19:00 so nothing ever threw. Renamed to what it actually verifies. **A
   green test is not evidence the branch ran — read the uncovered-line list, not the tick.**
4. The **multi-camera merge** is now covered incidentally (the climate tests use two cameras). §2.6 still
   deletes it — on design grounds, no longer on coverage grounds.

**Landed alongside this in 0.28.0:** the admin "Recompute this night" control and, more importantly,
the `allowDowngrade` guard in `computeAndStoreNight`. ★ That guard is the worked example of a hazard
that only exists once a feature makes it reachable: `activity_samples` retention (30 days) and the date
picker's range (30 days) are the same number, so the oldest browsable night sits ON the boundary and
recomputing it would have replaced a permanently-kept scored row with `no_data`. Nothing could reach
that path until a person could ask for a recompute. **When adding a control, look for the code path it
newly makes reachable.**

**Still to bring up to the bar and add to the list**, in priority order:
- `routes/cameras.js` (1,036 lines) — the biggest surface, and the one with real authz branching
- `routes/auth.js` (422) — login, the two-step MFA exchange, session lifecycle
- `lib/clipStorage.js` + `lib/motionDetector.js` — retention maths and zone-mask maths

**★ Daylight saving — FOUND AND FIXED 2026-08-29, and worth remembering as a pattern.** `localDateStr`
shifted days by adding 86,400,000 ms and reading the local date off the result. A day is not 24 hours
twice a year, so for Australia/Melbourne it returned the WRONG date for a full hour each time:
spring-forward (00:00-00:59 on 2026-10-05) **skipped** a day, fall-back (23:00-23:59 on 2026-04-05)
**repeated** one. It shipped as a bug in `currentNightDate` only — the live "tonight so far" view would
have vanished for that hour — and the reason is worth knowing: **`currentNightDate` walks only TWO
candidate dates (0..-1), so one bad candidate is fatal, while `lastCompletedNightDate` walks FOUR and
had a spare.** Widening a loop is therefore never a substitute for the date arithmetic being right.
Any future date-window code gets the same treatment: shift the local Y/M/D on the calendar, never the
instant. Both edges are now pinned by tests using `mock.timers`.

**Deliberately NOT in the gate:** the I/O glue — FFmpeg spawning, ONVIF SOAP, MQTT, the four push
senders, RTSP probing. Testing those means asserting that mocks were called with the right arguments,
which passes forever and catches nothing; their real failure mode is "the camera answered with
something odd", which only the e2e stack reproduces.

- **Phase 4 — build the image from the commit under test — `SHIPPED` (2026-08-26).** `e2e.yml` now
  builds `sauso/nightlight:dev` from the checked-out commit before bringing the stack up. Previously the
  suite ran whatever the published tag pointed at, so on a dev -> main PR a green run could be proving
  the PREVIOUS build. **The same applies locally**: `bash e2e/test.sh` on its own tests the last
  published image, not your working tree — build first.
- **Phase 5 — front-end testing — `NEXT`.** Target **>= 80% of the front end**, exercised in BOTH roles
  (admin and caregiver), since role gating is real in the UI (`isAdmin` branches in the tiles, camera
  pages and settings) and is exactly where the timelapse-delete bug hid. Two layers: component tests for
  logic and rendering, and role-based Playwright flows for what a person actually does.
- **Phase 6 — Android instrumented tests (Espresso)** in `nightlight-mobile` — `SPECCED`, was Phase 5.
  Only the Capacitor scaffold stub exists. Local emulators were unusable (no nested virt) but **GitHub
  Linux runners have KVM**, so a CI emulator is realistic. Target the genuinely native bits: the
  foreground service surviving screen-off, and the notification Stop action.

Harder-to-fake features, deliberately deferred within the suite: **two-way audio** (Playwright can fake
a mic and assert the WebSocket connects and bytes flow, but never that the camera physically plays it)
and **PTZ/ONVIF** (needs a camera to respond). **The High/Low selector is testable** — give the
synthetic source a second path and assert the toggle swaps the stream.

---

### 2.5 Bed occupancy from the camera — `SPECCED` · *do not build yet, see the gate*

**Why.** Every open item in §1.2 is downstream of one missing fact: **is there actually a child in the
bed?** The detector infers it from motion in two zones, which is why a parent's hands leaving the bed
reads as an exit, a stir reads as an arrival, and an empty bed once reported a flawless 11h06m sleep.
Motion cannot answer the question; a picture can. A generic person-detector cannot either — Raffa
sleeps under a blanket and Renz in a sleep suit, so frequently **only a head is visible**.

**Approach: distil, don't run a VLM.** A vision-language model (Qwen2.5-VL via Ollama) labels frames
**offline, on the owner's desktop**, and is then thrown away. What ships is a MobileNetV3-Small
classifier, **~6 MB ONNX**, ~10 ms per frame, ~2.5 CPU-seconds/day at the rate transitions actually
occur — against the existing detector's ~13,000. The VLM never runs in the container and never could:
`/var/lib/docker` has **6.8 GB free of a fixed 40 GB vdisk** and a 3B model is ~3.5 GB. The Coral is
not a way around this either (int8-only, **8 MB on-chip**).

**Status: the owner is running the labelling lab himself, no deadline.** Full instructions live outside
this repo (Claude artifact, "Bed Occupancy Lab", 6 stages). Nothing here is committed until the gate
below passes.

#### 2.5a The gate — one experiment, before any of this is built

A model trained on Renz and Raffa learns *this* cot, *this* angle, *this* IR illuminator. It would fail
on someone else's camera **confidently**, silently corrupting their sleep data. So the design below
assumes per-install calibration — and that assumption must be tested first:

> Train on Renz + Raffa, then fit a head on the **staging Hikvision** (a third camera, different make,
> different angle, same house). Fit it at 10 / 20 / 40 / 80 labelled frames and plot where accuracy
> stops improving.

That single experiment answers both open questions at once: whether per-install calibration is needed
at all, and **how many frames the wizard should ask for**. The "~20 frames" figure used below is an
estimate, not a measurement — expectation is 40–60, constrained by the empty class. **Do not build the
wizard around a guessed number.**

**Also settled, so it isn't re-proposed:** collecting frames from *other people's* beds is the wrong
move. A handful of extra scenes lands in the dead zone — too varied to master the two cameras we can
actually verify against, and nowhere near the hundreds of distinct scenes real cross-home
generalisation needs. The generalising is already done by MobileNet's ImageNet pretraining (1.2M
photographs); four bedrooms adds nothing on top of that. The variety **worth** having is *within* an
install: both lighting regimes (IR and daylight), a deliberate camera reposition, blanket and
sleep-suit variation, seasons. All of it accumulates for free as nights pass.

#### 2.5b How it works for someone else installing Nightlight

**Split the model in two.** The backbone (MobileNetV3 minus its final layer) ships once, frozen,
identical for everyone; it turns a frame into 576 numbers. The head is a single 576→2 layer — **1,154
numbers, ~5 KB of JSON** — and is the only per-install part.

That split is what makes this shippable: fitting a 1,154-parameter logistic regression on a few dozen
examples is a few hundred gradient steps of plain arithmetic, **well under a second in Node with no new
dependency**. `onnxruntime` is needed for inference anyway, and feature extraction is the same forward
pass. **No Python, no PyTorch, nothing new in the image beyond the backbone.**

**⚠️ Prerequisite: Nightlight stores no images today.** Motion and sound are sampled 24/7 (~1,437
rows/camera/day) but the only JPEGs on disk are alert snapshots — a fresh install has none, and they
would be biased toward "occupied and moving" anyway. Calibration therefore needs its own capture mode:
one snapshot every ~10 min for 2–3 nights, ~250 frames, ~20 MB, using the existing per-camera
`snapshot_url`. Useful asymmetry: **empty frames are trivial** (daytime, before bedtime, after the
morning wake); only the occupied class needs a night.

**The flow:**
1. *"Improve bed detection"* in camera settings — **off by default, clearly optional**.
2. Capture runs 2–3 nights, with a quiet progress banner.
3. **Labelling screen.** Frames are chosen deliberately, not at random: spread across the clock so both
   IR and daylight appear, and roughly balanced between likely-empty and likely-occupied times. Large
   image, two buttons, ~40 taps, about two minutes.
   ★ **The wording is load-bearing: "Is the child in the bed *right now*?"** — not "is a child
   visible?". A parent holding a child beside the bed is `empty`. The owner hit exactly this trap in
   his own labelling; every user will.
4. **Fit, then report honestly.** Hold back a quarter of the labels as an exam the head never sees, and
   show **both error types separately** — a head that always answers "occupied" scores well on an
   imbalanced set and is worthless, since catching the empty case is the entire point.
5. **Shadow for a week.** Log the verdict beside each bed transition, change no reported number, then
   show "agreed with the detector on 94 of 97 transitions" and let the user decide. Same discipline that
   caught the dead sound rule in 0.26.0.

**Guardrails, in from the start:**
- **Veto-only.** Occupancy never *creates* a transition, only suppresses one it disbelieves. A broken
  classifier then costs missed vetoes, never fabricated bedtimes.
- **Fails off.** No calibration, a poor exam score, or a load error → the feature is simply absent and
  behaviour is exactly as today.
- **Recalibration triggers.** A moved camera, a new bed, a cot→bed transition, or a child who has grown
  all invalidate the head. Needs an explicit "recalibrate" action; possibly a drift signal when
  disagreement with confirmed transitions rises.
- **Frames never leave the box**, and say so in the UI. These are pictures of sleeping children.
- **Keep the labelled frames.** Forty JPEGs is nothing, and they make re-fitting after a camera move a
  five-second job instead of another two-night wait.

**⚠️ The data trap, already measured — it would have poisoned the first model.** The 503 stored alert
snapshots are two populations: **362 at 1920×1080 and 141 at 640×360** (the small ones are sub-stream
grabs from when the snapshot URL was broken), while every empty frame grabbed today is a sharp
1920×1080. So **"blurry" predicts "occupied"** with no child involved, and a network always takes the
easy rule. Every image must be forced through a common small size (320×180) before training. Any future
capture path has the same exposure.

**Relationship to §1.2.** Complementary, not a replacement. §1.2 item 1 (believed-occupancy state
machine) is the cheap win and stays worth doing on its own — it needs no model and collapses impossible
sequences immediately. This section is the *independent evidence* that would also close item 3 (parent
leaving vs child climbing out), which motion alone cannot separate.

**Done when** the gate experiment has a number, the shadow week shows agreement on a real corpus, and a
second install can calibrate without help.

### 2.6 Mark the main camera in the camera list — `IDEA` · *small*

All that is left of the old 2.6. **Single-camera sleep analysis shipped in 0.28.0**: sleep is scored
from the child's main camera (enabled, lowest `sort_order`), climate and the alert list stay
multi-camera because they average or list rather than combine, and the sleep detail view names the
camera it measured from.

What is still implicit is the *setting*: the camera list does not mark which camera is the main one, so
the choice lives silently in the drag order. Naming it on the detail view covers the case that matters
(tracing a wrong night to the camera that produced it), which is why this is an idea and not a defect.
⚠️ Only bites a household with two cameras on one child — nobody here has that, so it cannot be
observed locally.

## 3. Idea backlog

Not committed — each is specced far enough to start, ordered by value-for-effort. Suggested first
three: **A1**, **A2**, **C1**.

### A. Builds on the shipped sleep + climate + clips data
- **A1. Weekly sleep digest** — `IDEA` · *small*. Aggregate the existing per-night summaries per child:
  total/avg sleep, avg wake count, best/worst night, trend vs prior 7 days. Delivered as a "This week"
  card on the child page plus an optional Sunday-night push. No schema change (aggregate on read).
- **A2. Auto-surfaced climate correlations** — `IDEA` · *small–medium*. We already eyeball "do warm
  nights mean more wakes" by hand; `sensor_readings` + wake events make it a feature. Bucket nights by
  room temp and compare wake counts: *"Renz woke 3× on nights over 23 °C vs 0.8× otherwise."* Only
  render when the signal clears a minimum sample size and effect. Clearly labelled correlational —
  **never** a medical claim.

### B. Alert quality-of-life
- **B2. Alert escalation** — `IDEA` · *medium*. If an alert isn't acknowledged within N minutes,
  re-notify or notify a second caregiver (reuses caregivers + Pushover device targeting).
  "Acknowledge" = opening the alert / tapping the push, recorded on the event row.
  Needs `detection_events.acknowledged_at` + an escalation timer. **Open:** policy config, global vs
  per-child.

### C. Fits the self-hosted / Unraid / Home Assistant world
- **C1. Home Assistant integration (MQTT discovery)** — `IDEA` · *medium*. **Highest fit for this
  deployment.** Nightlight already speaks MQTT *inbound* for motion; publishing HA MQTT Discovery
  config + state topics outbound lets nursery automations react to Nightlight state: online/offline,
  last motion/sound, sleep status, room temp/humidity. Reuses the existing MQTT client.
  **Open:** one device per camera vs per child; whether to expose *controls* (arm/disarm) or sensors only.
- **C2. Remote lullaby / white-noise** — `IDEA` · *medium*. Two-way *talk* works; playing soothing audio
  out the camera speaker is the natural extension, over the same `OnvifBackchannelTalk` sink,
  transcoded to the camera's G711 backchannel codec. Only works on cameras with a working backchannel
  (Thingino ✓). **Open:** built-in sounds vs user-uploaded; loop/duration; scheduling.
- **C3. Nursery kiosk / wall-tablet mode** — `IDEA` · *small–medium, frontend only*. A dimmed,
  red-shifted, always-on route: one camera + clock + room temp, tap to wake to full brightness,
  auto-dim after inactivity, screen wake-lock.

### D. Access / sharing
- **D1. Time-limited babysitter link** — `IDEA` · *medium*. A scoped, expiring, read-only token granting
  live view of one camera/child until expiry, revocable anytime. Reuses the JWT + `sessions` row model
  with a new narrow scope; a `guest_grants` row checked in auth middleware. No settings, no history —
  just live. **Open:** almost certainly view-only (no talk).

---

## 4. Deferred / shelved

Recorded so they don't get re-litigated. Each was considered and consciously parked.

- **Chromecast** — `HELD`. Requires `window.isSecureContext`, so it works only over the HTTPS domain,
  not LAN http; HLS-mode only. The web Cast SDK is **Chrome-browser-only** — it does not work in the
  app's WebView. Undecided: target the browser, or adopt the native Android Cast SDK. Ask before building.
- **Passkeys / WebAuthn** — `HELD`. Deferred behind the shipped TOTP 2FA. Browser-only: can't run over
  LAN-IP http or in the WebView, which is where this app is mostly used.
- **LL-HLS** — `SHELVED`. WebRTC is already sub-second, so the win is small; the cost (fMP4 + HTTP/2 +
  HTTPS-only + proxy work) isn't worth it. Compatibility-mode lag was instead cut by shortening
  MediaMTX segments and addressing camera GOP.
- **otplib 12 → 13 (Dependabot #128)** — `DONE in 0.25.2`, but **closed rather than merged**, because the
  bump alone would have taken the whole server down: v13 removes the `authenticator` singleton, so
  `lib/mfa.js`'s top-level `authenticator.options = {...}` threw a `TypeError` at import, and
  `index.js → routes/auth.js → lib/mfa.js` is the startup path. Ported to the v13 API instead (now
  13.5.0). Two traps worth remembering if this ever comes up again: `epochTolerance` is in **seconds**,
  not time steps (v12's `{window: 1}` is `epochTolerance: 30`), and `epoch` is in seconds too. v13
  enforces a 16-byte minimum secret where v12 generated 10-byte ones — legacy secrets keep working via
  `createGuardrails({ MIN_SECRET_BYTES: 10 })` on the verify path only, deliberately *not* forcing a
  re-enrolment, since locking someone out of their own monitor is worse than an 80-bit secret they
  already hold. New enrolments are 160-bit.
- **Adaptive stream quality, beyond the manual selector** — `CLOSED 2026-08-25, not building`. High/Low
  per tile, remembered per camera, is the finished feature. Both phases once planned on top of it are
  decided against: **on-demand sub-stream transcoders** (measured on prod — the motion detector holds
  the sub path open 24/7 regardless of viewers, so it saves nothing and could cost more; 72h of logs
  showed zero camera client-limit errors) and **automatic quality switching** (every switch costs a
  WebRTC reconnect — this app's worst existing failure mode — to solve a bandwidth problem that hasn't
  occurred on a LAN monitor). The sub-stream reasoning is repeated in `lib/subStream.js`, where anyone
  tempted to build it would actually hit it.

---

## 5. Operational runbooks

Not plans — living procedures, kept alongside this file:
- **`sleep-marker-review-runbook.md`** — pull a night's OOB / into-bed markers, `bed_transitions`, and
  shadow onset/wake off staging. Read-only. Note it deliberately warns that prod is a *different*
  database with different camera IDs — don't cross the two.

---

## 6. Explicit non-goals

### Breathing / roll-over / SIDS-style "safety" detection — **not building**
The obvious ask for a baby monitor, and deliberately declined. A self-hosted hobby app must not present
as a **medical or safety device**: false confidence is genuinely dangerous, and the accuracy and
liability bar is far beyond this project. Sleep tracking stays clearly labelled as *pattern inference*,
never a vitals or safety claim. If mmWave/respiration hardware were ever added, it would be a separate,
explicitly opt-in tier — and still not marketed as a safety guarantee.
