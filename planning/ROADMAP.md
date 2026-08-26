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

### 1.1 Fix Raffa's bed-zone discrimination — `WATCHING` (was `NEXT`; the camera has been re-aimed)
**Largely resolved.** The camera was re-aimed and `detect_zone` redrawn with the grid picker (12 rects,
33.5% of frame). On the very next night (2026-08-25) it emitted a real `out_of_bed` at his true exit and
the wake came out **exactly right (05:09, owner-confirmed) on both prod and staging** — so this is no
longer a blocker for 1.3, which has now shipped. Keep watching a few more mornings before closing it:
one good night on a re-aimed camera is one night. The original diagnosis is kept below.

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
**The remaining piece of the sleep work.** 0.26.0 stopped the timeline *claiming* things this detector
can't support (only the two adopted transitions are drawn, everything else is "movement outside the
bed"). That is a containment, not a fix — the underlying classifier is still wrong often enough that its
per-event output can't be shown.

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

**Work:**
1. Track believed occupancy; ignore an `into_bed` while already in bed and an `out_of_bed` while already
   out. (Alone this collapses the four arrivals to one.)
2. Record the outside channel's **peak and duration** alongside each transition — new columns on
   `bed_transitions` — and require substantial outside evidence for `into_bed`, symmetric for
   `out_of_bed`.
3. Separate "parent leaves" from "child exits". Retrospective is fine: the nightly job runs after the
   night, so an `out_of_bed` followed by continued in-bed micro-motion is a parent leaving.

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

The same confusion must still affect **wake counts** — deliberately left alone, because mid-night the
house is quiet and a cry with no movement is exactly the wake-up a parent wants counted. Worth
measuring before touching: across all nights on record, how many counted wakes are sound-only *and*
simultaneous with noise in the sibling's room? If that number is large, the wake rule needs the same
treatment. If it's small, leave it alone. **Measure first.**

---

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

In the gate today at **96.4% lines**: `db.js`, `middleware/auth.js`, `lib/mfa.js`,
`lib/detectionEvents.js`, `routes/timelapses.js`.

**Still to bring up to the bar and add to the list**, in priority order:
- `routes/cameras.js` (1,036 lines) — the biggest surface, and the one with real authz branching
- `routes/auth.js` (422) — login, the two-step MFA exchange, session lifecycle
- `lib/sleepAnalysis.js` — at 69.5%; the gap is the nightly job and the climate/series helpers
- `lib/clipStorage.js` + `lib/motionDetector.js` — retention maths and zone-mask maths

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

### 2.4 Record a wake without alerting — `BUILT, awaiting release` (on a branch; deliberately NOT in 0.26.0)

**The problem, measured.** Replaying the wake algorithm over all 18 'ok' prod nights (**101 wakes**)
and matching each against the alert feed:

| wake type | wakes | no alert at all | alert fired but no clip |
|---|---|---|---|
| motion + sound | 85 | 40 | **0** |
| motion only | 6 | 6 | **0** |
| sound only | 10 | 8 | **0** |

**53% of wakes produce no alert, so there is nothing to look at in the morning.** The recorder itself
is faultless — zero cases of "alerted but no clip" in 101 wakes; the gap is entirely upstream.

Two causes, and only one of them is a bug:
- **14 wakes fell outside the alert schedule** — all Renz, whose alert window opens 19:30 while his
  *sleep* window opens 19:00. **Config, fixable in-app, no code.**
- **40 fell inside the schedule with alerting armed and nothing fired.** The two subsystems measure
  different things and always will: sleep counts a minute active on any ~200 ms blip above 1% of zone
  or 6 dB, while an alert needs **2–3 seconds sustained**. A child who shifts for a second every minute
  for ten minutes is ten active minutes and never one sustained alert.

**This is deliberately NOT "make it alert more."** Owner, 2026-08-26: *"I don't want to necessarily
send an alert. That actually works fine. But we should have a way to record these and not alert so if
you wake up in the morning and see that they were awake for 5 mins you can see why."* Alerting stays
exactly as tuned; what's missing is **evidence**.

**Almost all the machinery already exists** — this is wiring, not new subsystems:
- `lib/recordings.js` + the `recordings` table already record with **no push and no `detection_events`
  row**, and the table already carries a **`triggered_by`** column to distinguish this from a manual
  recording.
- `clipRecorder.holdRing(cameraId, fromMs)` already protects ring segments from pruning retroactively.
  **This dissolves what looked like the blocker**: the ring is only ~63 s deep, but a hold placed on the
  *first active minute* keeps the wake's opening available until the run qualifies minutes later.
- `SleepDetail`'s wake list already renders an inline clip player per wake (#107) — the natural home,
  and exactly the "see why" surface the owner described.

New work is a **live wake watcher**: `activityTracker` already buckets motion/sound per minute in real
time, so it can apply the same active-minute test as `sleepAnalysis`, `holdRing` on the first active
minute after onset, and cut a recording once the run reaches `WAKE_ACTIVE_MIN`, releasing the hold if
it never does.

**★ DECIDED (owner, 2026-08-26): 30 s clip at the wake's start; stirs are NOT recorded; the 54
already-missed wakes are not being chased.** Built accordingly — `lib/wakeWatcher.js` plus
`captureWakeClip()`/`pruneWakeClips()` in `lib/recordings.js`, a `recordings.kind` column, and a clip
row inside each wake on SleepDetail. 18 tests cover the state machine; the thresholds are IMPORTED from
`sleepAnalysis` (`SLEEP_THRESHOLDS`) so a clip exists exactly when the timeline shows a wake.
★ Writing those tests found a real leak: `activityTracker` only flushes cameras that saw signal, so a
camera going offline mid-run would have held its ring open indefinitely — swept on a timer now
(`sweepStaleRuns`). The original time backstop was unreachable dead code and was removed.

**Original sizing note — bounded clip, not the whole wake.** Average wake is ~19 min and clips run
~172 KiB/s, so recording wakes end to end is **~1.1 GiB/night (~34 GiB at 30-day retention)** — on a
`/app/data` that is already **98% full**. A **30 s clip at the wake's start** answers "why" and costs
**~29 MiB/night (~0.85 GiB retained)**, roughly 40× less. Recommend the bounded clip, with its own
retention/prune path like alert clips, and its own storage guard via `hasMinFreeSpace()`.

Open questions: whether a non-qualifying stir should keep its capture or discard it; whether the hold
needs a hard cap (a wake bridging many gaps can hold ~17 min of ring, ~176 MiB transiently).


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
