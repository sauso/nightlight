# Nightlight — Roadmap

The single list of **open** work. If something isn't here, it's either shipped (see `CHANGELOG.md`)
or a deliberate non-goal (§6).

**Ground rule:** this file tracks *intent*. `CHANGELOG.md` is the record of what actually shipped —
when the two disagree, the changelog is right. Update this file in the same commit that changes the
plan, and delete an item from here when it ships.

> **History note (2026-08-24):** `planning/` previously held 12 per-feature scope docs, most of them
> describing work that had already shipped — several still headed "Not started" months after release,
> and one (`ux-refresh-v2-scope.md`) specifying a Live/Alerts/Family/Settings nav that was built and
> then abandoned. They were deleted in favour of this file; the full text of each remains in git
> history if the original design reasoning is ever needed.

**Status vocabulary:** `NEXT` (agreed, ready to start) · `SPECCED` (design settled, unbuilt) ·
`IDEA` (worth doing, not committed) · `HELD` (blocked or waiting on something).

---

## 1. Next up

### 1.1 Promote shadow sleep onset/wake to authoritative — `NEXT`
Out-of-bed detection ships today in **shadow mode**: `sleep_nights.onset_at_shadow` /
`wake_at_shadow` are computed from the `bed_transitions` table alongside the live motion+sound
numbers, but the headline figures parents see still come from the old algorithm. Both shadow values
validated correct on 2026-08-23 (19:37 onset / 06:39 wake), and the wake rule was unit-checked
against real 2026-08-22 data.

**Why shadow exists:** motion-based tracking is blind to a child who *leaves* — an empty crib and a
sleeping child both read as "no motion". The bed transitions are what distinguish absence from sleep.

**Remaining work** — small, deliberately gated on more observation:
- Eyeball shadow vs algorithm on SleepDetail for a few more mornings.
- When shadow consistently wins: flip it to authoritative (~1 line) and point the nightly
  sleep-report push at the shadow values.
- Consider extending Renz's `sleep_window_end` — it closes 06:30 but real wake-up has been ~07:57.
- Watch edge case **B** (child held ~30 min then put back down): a re-settle must require an
  *into-bed* transition before sustained quiet re-scores as sleep, or the held gap wrongly reads as
  sleep. Edge case **A** (pre-bedtime quiet in an empty crib scoring as early onset) is handled — onset
  can't precede the first into-bed event.

Runbook for reading a night's markers: **`sleep-marker-review-runbook.md`**.

### 1.2 Ship the pending security work to prod — `NEXT`
Sitting in `[Unreleased]` on dev/staging, needs a prod release: **CSP enforcement** and the
**media-scoped token** (video/image URLs no longer carry the full 30-day session token). Both were
validated on staging — CSP ran report-only across every feature first and surfaced exactly one
violation (the Cloudflare analytics beacon, now explicitly allowed).

---

## 2. Specced, not built

### 2.1 On-demand recording (manual capture + pre-record buffer) — `SPECCED`
A manual **Record** button with a pre-roll buffer, so you can hit record *after* the moment and still
capture the seconds before it. Full design — including the schema, endpoints, retention/pin behaviour
and phasing — is in **`on-demand-recording-scope.md`** (kept; still accurate against the shipped
0.17.0 recording pipeline).

**The short version:** the pre-roll ring already exists. Event-recording runs a continuous segmenter
per detection-enabled camera writing ~2s segments into a rolling ring; a motion clip is just a concat
over `[t−pre, t+post]`. On-demand is the same extraction with a different trigger and a running end.
The one genuinely new piece is running that ring on cameras where motion detection is **off**
(`ondemand_buffer`, per-camera opt-in — it's a continuous FFmpeg + disk writes, which is not free on
the RAM-starved Thingino cams).

### 2.2 Adaptive stream quality — Phase 1 & Phase 3 — `SPECCED`
Phase 2 (manual High/Low per tile, backed by a per-camera sub-stream path) shipped. Two phases remain:

- **Phase 1 — on-demand sub-stream transcoders.** Today the sub leg runs **continuously**. Starting it
  only while a client is watching Low would fix two real risks: it halves the FFmpeg process/restart
  surface per camera, and — more importantly — it avoids a **second concurrent RTSP pull** from
  cameras that cap simultaneous clients (often 2–4). Main + sub + someone checking in VLC can exhaust
  that cap and break the *main* stream.
  **Cheap de-risking spike:** run a second `-c:v copy` sub transcoder on one camera for a few hours and
  watch for camera RTSP client-limit errors. That one test settles the whole continuous-vs-on-demand
  question for near-zero cost.
- **Phase 3 — automatic quality switching.** Explicitly optional and removable; `Auto` just becomes an
  unavailable option if it's dropped. Detection is the easy part (`RTCPeerConnection.getStats()` gives
  `packetsLost`, `jitter`, frames-dropped). **The hard part is hysteresis** — naive thresholds flap
  between tiers every few seconds, which feels worse than simply being stuck on Low. Requirements:
  asymmetric thresholds (drop fast, recover slowly on sustained evidence), a cooldown after any switch,
  and a per-session switch cap. Every switch costs a reconnect gap, and WebRTC can wedge on reconnect
  on iOS — so keep it conservative.
  **Evaluation bar before keeping it:** does it measurably reduce stuttering without visible flapping?
  If not, remove it and keep the manual selector — that's a fine outcome, not a failure.

### 2.3 Cry classification — `SPECCED`
Sound detection today alerts on **loudness** (FFmpeg `silencedetect`), not on what the noise *is*. The
agreed staging was always: prove motion+push → add sound presence → tune against real usage → *only
then* evaluate cry-specific classification, informed by how well plain sound detection performs.
Sound detection has been live since 0.12.0, so this is now genuinely evaluable.

Distinguishing a baby crying from a dog barking, a TV or a door slam is a real audio-classification
problem. A spare **USB Coral** may accelerate it, but it must stay **optional and runtime-detected**
with a CPU fallback — the app has to run fully without one, and everything shipped so far is
deliberately Node + FFmpeg only (no Python in the runtime image).

### 2.4 E2E testing — Phase 4 & Phase 5 — `SPECCED`
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
and **PTZ/ONVIF** (needs a camera to respond). **Adaptive quality is testable** — give the synthetic
source a second path and assert High/Low swaps the stream.

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
- **otplib 12 → 13 (Dependabot #128)** — `HELD`. A major bump that gates TOTP login; pinned until it can
  be verified end-to-end on staging.

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
