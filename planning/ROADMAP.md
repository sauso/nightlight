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

### 1.1 Fix Raffa's crib-zone discrimination — `NEXT`
**This is the blocker for 1.2, and it is a camera-framing problem, not a code problem.**

On the night of 2026-08-24→25 there was **no `out_of_bed` transition anywhere near Raffa's real 06:10
exit** (the last one was 01:22), and the detector then logged three *false* `into_bed` events after he
was already out (06:33, 06:43, 06:56). Crib-zone motion kept registering until 07:02 despite the crib
being empty from 06:10. Transition peaks are also much weaker than Renz's (0.013–0.037 vs up to 0.2).

The zone covers ~19.5% of the frame, much of it bare wall, and misses most of the bed — so "inside the
crib" and "outside the crib" aren't actually distinguishable for that camera.

**Work:** re-aim the camera so the cot fills more of the frame and the floor beside it is visible, then
**redraw `detect_zone`** — it is stored as normalised frame fractions, so *moving the camera without
redrawing points the zone at the wrong things and makes out-of-bed detection worse, not better*. The
grid picker (paint the cells covering the cot) can follow a diagonal cot that the old rectangles
couldn't. Then review a few mornings against ground truth.

### 1.2 Promote shadow sleep onset/wake to authoritative — `HELD` (was `NEXT`)
Out-of-bed detection ships today in **shadow mode**: `sleep_nights.onset_at_shadow` / `wake_at_shadow`
are computed from the `bed_transitions` table alongside the live motion+sound numbers, but the headline
figures parents see still come from the old algorithm.

**Why shadow exists:** motion-based tracking is blind to a child who *leaves* — an empty crib and a
sleeping child both read as "no motion". The bed transitions are what distinguish absence from sleep.

**Why this is now HELD rather than NEXT.** The previous plan here was "eyeball it for a few mornings,
then flip a line". Measured against owner ground truth on 2026-08-24→25, shadow wake scored **1 of 3**:
Renz on prod was exact (05:58), Renz on *staging* — same physical camera — was 40 min early, and Raffa
was 53 min late, i.e. **worse than the algorithm it was meant to replace**. Two distinct causes:

- **Knife-edge thresholds.** Staging was missing a single sample minute that prod had, which
  manufactured a 22-minute empty-crib gap (limit 20) with 9 minutes of trailing activity (limit 10).
  Both margins within 2 → accepted. One sample minute flipped the answer for the same camera.
- **Raffa's zone can't tell inside-crib from outside-crib** — see 1.1.

**Mitigation shipped (0.25.0):** a qualifying gap is now only accepted when a real `out_of_bed`
corroborates it within the snap window; otherwise the scan continues to a later gap, and failing that
the algorithm's wake stands. It must be an `out_of_bed` specifically — matching any polarity let an
`into_bed` vouch for a departure. Replayed against that night's real data: Renz prod 05:58 exact, Renz
staging 05:18 → 05:58 exact (the prod/staging divergence is gone), Raffa falls back to the algorithm
(11 min early, rather than 53 min late).

**Remaining work, in order:**
- **1.1 first.** Shadow can't produce a refined time for Raffa at all until his zone emits a real
  `out_of_bed` at the actual exit.
- Then re-check several mornings against ground truth on *both* children before flipping anything.
- When it consistently wins: flip to authoritative (~1 line) and point the nightly sleep-report push at
  the shadow values.
- Consider extending Renz's `sleep_window_end` — it closes 06:30 but real wake-up has been ~07:57.
- Watch edge case **B** (child held ~30 min then put back down): a re-settle must require an
  *into-bed* transition before sustained quiet re-scores as sleep, or the held gap wrongly reads as
  sleep. Edge case **A** (pre-bedtime quiet in an empty crib scoring as early onset) is handled — onset
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

### 2.3 E2E testing — Phase 4 & Phase 5 — `SPECCED`
Phases 1–3 shipped: the synthetic-camera stack, the Playwright UI suite, and auto-generated docs
screenshots, all green in `e2e.yml`.

- **Phase 4 — build the image from the PR commit in CI**, rather than testing whatever the `:dev` tag
  currently points at. Removes a real race between merge and image publish.
- **Phase 5 — Android instrumented tests (Espresso)** in `nightlight-mobile`. Only the Capacitor
  scaffold stub (`ExampleInstrumentedTest.java`) exists today. Local emulators were unusable (no
  nested virt) but **GitHub Linux runners have KVM**, so a CI emulator is realistic. Target the
  genuinely native bits: the foreground service surviving screen-off, and the notification Stop action.

Harder-to-fake features, deliberately deferred within the suite: **two-way audio** (Playwright can fake
a mic and assert the WebSocket connects and bytes flow, but never that the camera physically plays it)
and **PTZ/ONVIF** (needs a camera to respond). **The High/Low selector is testable** — give the
synthetic source a second path and assert the toggle swaps the stream.

---

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
