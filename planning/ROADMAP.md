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

### 1.2 Report a night where nobody was in the bed — `SHIPPED` (on dev, 2026-08-26)
A fifth status `empty` — "No one in the bed" — now sits alongside `off` / `no_data` / `no_sleep` / `ok`,
and is deliberately a different statement from `no_data` ("we couldn't see"). Surfaced on the child
page, the sleep detail page and in the nightly report push. The night is stored with no onset/wake and
no durations: inventing "11h06m asleep, 0 wakes" for an empty bed was the bug.

**Rule, chosen from the 2026-08-25 A/B** (Renz away = empty bed, Raffa in his, same night, same house,
same firmware) measured against **17 occupied prod nights**. All three must hold:
`max in-bed motion_peak < 0.10` **and** `wake_count == 0` **and** `awake_minutes == 0`.

| signal | empty | occupied floor | separation |
|---|---|---|---|
| max in-bed `motion_peak` | 0.0163 | 0.2883 (usually ~1.0) | **18x** |
| `wake_count` | 0 | >= 1 every night | clean |
| `awake_minutes` | 0 | >= 10 every night | clean |

No occupied night on record trips even one of the three. **The "no `into_bed` all window" discriminator
this section originally proposed was tested and DISCARDED** — it would have flagged Raffa's genuinely
occupied night as empty, because his put-downs happened at 19:14-19:28 and his window opens at 19:30,
so the count *inside the window* was zero. A child is usually put to bed before the window opens;
transition counts inside the window are not a sound occupancy signal. Magnitude is.

⚠️ **n = 1 for the empty case.** The separation is large, but one empty night is one sample — hence the
conservative 0.10 threshold. Keep an eye on the occupied floor (0.2883) as more nights accumulate.

### 1.2a Bedtime is not a fixed time — `SHIPPED` (on dev, 2026-08-26)
Sleep that started **before** the window opened was clipped to the window edge, under-reporting an early
night. The analysis timeline now begins `ONSET_LOOKBEHIND_MS` (3h) before the window, and an early onset
is adopted only when anchored to a real `into_bed` put-down **and** the sleep continues into the window
(no awakening in between, which is what excludes an afternoon nap), **and** those minutes were actually
observed (the settle minute has a sample; the stretch is >= 50% covered).

Costs nothing to collect: a framediff-**alerting** camera is never window-gated and already samples 24/7
— measured at ~1437 of a possible 1440 rows/camera/day, ~10.7 MB at the 30-day retention. Only the
activity-only leg (MQTT-source / alerts-off cameras) is gated, and it now opens the same 3h early via
`childSamplingActiveNow` rather than running all day.

**Trap worth remembering:** a minute with no sample is treated as *quiet* for continuity, so the
lookbehind before sampling starts is one long fake quiet run. Searching it for "the first quiet run"
always lands on the start of a data gap — the search must be anchored on the put-down instead. The first
implementation had exactly this bug and was silently inert.

### 1.3 Promote shadow sleep onset/wake to authoritative — `SHIPPED` (on dev, 2026-08-26)
**Done.** `USE_TRANSITION_TIMES` in `sleepAnalysis.js` makes the transition-derived onset/wake the
authoritative `onset_at`/`wake_at`; the movement-only figures are preserved in new `onset_at_algo` /
`wake_at_algo` columns so the two methods stay comparable (and the promotion stays revertible by one
flag). Adoption happens BEFORE the metrics, so durations measure to the real departure rather than
leaving "asleep" counting minutes after the child had already left the bed.

Verified by diffing against the deployed logic over every stored night: **17 of 20 unchanged**, and
the 3 that moved all moved toward the truth — **2026-08-25 Raffa 06:38 → 05:09 (owner-confirmed exact,
asleep 646 → 557)**, **2026-08-24 Renz 06:53 → 05:58 (owner-confirmed exact)**, and 2026-08-23 Renz
06:50 → 07:40 (no ground truth, but Renz's real wake has been observed ~07:57, so closer).

⚠️ **Caught in review, worth remembering:** converting the exit timestamp to a minute index with
`Math.round` reported 05:10 for an exit recorded at 05:09:31. The reported time must come from the
exact timestamp truncated to its minute; only the metrics index floors.

The history below is kept because it explains why the thresholds are what they are.

### 1.3a How it got here — `HISTORICAL`
Out-of-bed detection ships today in **shadow mode**: `sleep_nights.onset_at_shadow` / `wake_at_shadow`
are computed from the `bed_transitions` table alongside the live motion+sound numbers, but the headline
figures parents see still come from the old algorithm.

**Why shadow exists:** motion-based tracking is blind to a child who *leaves* — an empty bed and a
sleeping child both read as "no motion". The bed transitions are what distinguish absence from sleep.

**Why this is now HELD rather than NEXT.** The previous plan here was "eyeball it for a few mornings,
then flip a line". Measured against owner ground truth on 2026-08-24→25, shadow wake scored **1 of 3**:
Renz on prod was exact (05:58), Renz on *staging* — same physical camera — was 40 min early, and Raffa
was 53 min late, i.e. **worse than the algorithm it was meant to replace**. Two distinct causes:

- **Knife-edge thresholds.** Staging was missing a single sample minute that prod had, which
  manufactured a 22-minute empty-bed gap (limit 20) with 9 minutes of trailing activity (limit 10).
  Both margins within 2 → accepted. One sample minute flipped the answer for the same camera.
- **Raffa's zone can't tell inside-bed from outside-bed** — see 1.1.

**Mitigation shipped (0.25.0):** a qualifying gap is now only accepted when a real `out_of_bed`
corroborates it within the snap window; otherwise the scan continues to a later gap, and failing that
the algorithm's wake stands. It must be an `out_of_bed` specifically — matching any polarity let an
`into_bed` vouch for a departure. Replayed against that night's real data: Renz prod 05:58 exact, Renz
staging 05:18 → 05:58 exact (the prod/staging divergence is gone), Raffa falls back to the algorithm
(11 min early, rather than 53 min late).

**Scorecard update — night of 2026-08-25→26 (ground truth: Raffa out of bed 05:09, never returned):**
shadow was **EXACT on both prod and staging** (05:09), against an algorithm that was 89 minutes late
(06:38). Prod and staging agreed to the minute all night, so the camera re-sync closed the divergence,
and Raffa's zone *did* emit a real `out_of_bed` at his true exit — clearing 1.1's blocker for that night.

**But it survived on a margin of ZERO, which is why this stays HELD.** The accept test allowed <= 10
trailing bed-active minutes; the true departure left exactly 10 on staging and 9 on prod. One more
minute of a parent tidying the bed and the scan would have skipped it and reported the wake ~2h late —
the same knife-edge as before, landing the right way. **Fixed on dev 2026-08-26:** the cap is now 20,
chosen from the measured separation (real exits leave 5-8 trailing minutes; the one corroborated
mid-night impostor on record leaves 31). Verified: no night on record changes its reported wake.
Also disproven while picking it — **gap *length* is not a "this is the terminal one" signal**: mid-sleep
empty runs of 226 and 312 minutes are normal, the latter five hours before the child actually got up.

**Remaining work, in order:**
- **More mornings of ground truth**, on *both* children, now that the margin is comfortable — one exact
  night is one night. 1.1 is no longer a hard blocker but Raffa's zone should be watched.
- When it consistently wins: flip to authoritative (~1 line) and point the nightly sleep-report push at
  the shadow values.
- Consider extending Renz's `sleep_window_end` — it closes 06:30 but real wake-up has been ~07:57.
- Watch edge case **B** (child held ~30 min then put back down): a re-settle must require an
  *into-bed* transition before sustained quiet re-scores as sleep, or the held gap wrongly reads as
  sleep. Edge case **A** (pre-bedtime quiet in an empty bed scoring as early onset) is handled — onset
  can't precede the first into-bed event.

Runbook for reading a night's markers: **`sleep-marker-review-runbook.md`**.

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

### 2.4 Record a wake without alerting — `SPECCED`

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

**★ Decide before building: bounded clip, not the whole wake.** Average wake is ~19 min and clips run
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
