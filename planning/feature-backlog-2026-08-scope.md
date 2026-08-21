# Feature Backlog (Aug 2026) — Scope

A curated set of *new* feature ideas (nothing already shipped or already deferred — Chromecast,
cry-classification, passkeys, LL-HLS are on the books elsewhere). Each is specced to the point a build
could start, grouped by how much it reuses existing infrastructure. Ordered roughly by value-for-effort.

> Status: PLAN ONLY — an idea backlog, not a commitment. Pick items to promote to their own build.

On-demand recording is specced separately in `on-demand-recording-scope.md`.

---

## A. Builds on the shipped sleep + climate + clips data (cheap, high value)

### A1. Weekly sleep digest ★ (recommended first)
**Problem:** the app computes sleep nightly (`sleepAnalysis.js`) but the value is buried in per-night
detail — parents want a "how did the week go" glance.
**Approach:** a weekly aggregation over the existing per-night summaries per child: total/avg sleep,
avg wake count, best/worst night, trend vs the prior 7 days. Delivered as (a) a **card on the child's
detail page** ("This week") and (b) an **optional Sunday-night push** via the existing push providers
(FCM/Pushover) — reuses the notification plumbing and the sleep tables; no new capture.
**Schema:** none required (aggregate on read); optionally cache a `weekly_sleep_summary` row if the
query is heavy.
**Settings:** per-user opt-in for the weekly push + send-day/time.
**Effort:** small. **Open Q:** email delivery too, or push-only (no mail transport today → push-only v1).

### A2. Auto-surfaced climate correlations ★ (recommended)
**Problem:** we're currently eyeballing "do warm nights = more wakes" by hand. Turn it into a feature.
**Approach:** with `sensor_readings` (temp/humidity, per-minute) and wake events already stored, run a
simple correlation over a rolling window per child: bucket nights by avg/max room temp and compare wake
counts, surfacing a plain-language insight — *"Renz woke 3× on nights over 23 °C vs 0.8× otherwise."*
Show as an **insight card** on the child detail / sleep view; only render when the signal is
meaningful (min sample size, min effect). Correlational, clearly labelled — **not** a medical claim.
**Schema:** none (read-time query); optionally persist computed insights for the digest (A1).
**Effort:** small–medium (the stats + guardrails against spurious findings). **Open Q:** which
environmental factors beyond temp (humidity, day-of-week, nap-that-day).

### A3. Nightly sleep timelapse ("memories")
**Problem:** a delightful keepsake from footage we already have access to.
**Approach:** condense a night into a ~30s timelapse. Sample frames (snapshot endpoint or the segmenter
ring) at intervals across the night window, assemble with one FFmpeg pass. Store like a clip
(reuse `CLIPS_DIR` + `ClipPlayerModal`); a "Last night's timelapse" card on child detail.
**Schema:** reuse `detection_events` with `type='timelapse'` + `clip_*`, or a small `timelapse` table.
**Effort:** medium (frame sampling cadence + assembly job + retention). **Open Q:** sample from live
snapshots (cheap, lower quality at night) vs the recording ring (needs the buffer running all night).
Ties naturally to on-demand recording's always-on buffer. Consider `clip_pinned` so keepers survive.

---

## B. Alert quality-of-life (small, reuses notification plumbing)

### B1. Quick snooze / mute per camera
**Problem:** scheduled quiet-hours exist, but there's no fast "we're doing bath time, mute Renz for
30 min" for a one-off.
**Approach:** a per-camera transient mute with an expiry timestamp (`muted_until`); the alert
fan-out checks it alongside the existing quiet-hours gate. One button on the tile → 15/30/60-min /
"until I turn it back on" options.
**Schema:** `cameras.muted_until` (or a small in-memory map + persisted field to survive restart).
**Effort:** small. **Open Q:** mute scope — this camera, this child, or everything.

### B2. Alert escalation
**Problem:** a wake alert can be missed by the one caregiver who got it.
**Approach:** if a detection alert isn't acknowledged within N minutes, escalate — re-notify and/or
notify a second caregiver (reuses caregivers + Pushover device targeting). "Acknowledge" = opening the
alert / tapping the push, recorded on the event row.
**Schema:** `detection_events.acknowledged_at` (+ who); an escalation timer/job.
**Effort:** medium (ack tracking + timer + escalation policy). **Open Q:** escalation policy config
(who's the backup, how many minutes) — global vs per-child.

---

## C. Fits the self-hosted / Unraid / Home-Assistant world

### C1. Home Assistant integration (MQTT discovery) ★ (recommended — highest owner-fit)
**Problem:** the owner runs Unraid + almost certainly HA; Nightlight already speaks MQTT *inbound*
(motion). Publishing *outbound* lets nursery automations react to Nightlight state.
**Approach:** publish **HA MQTT Discovery** config + state topics for each camera: online/offline
(binary_sensor), last-motion, last-sound, current sleep status, room temp/humidity (from the readings
we store). Reuses the existing MQTT client; a Settings toggle + discovery prefix.
**Schema:** none (publishes existing state).
**Effort:** medium (entity modelling + discovery payloads + availability/LWT). **Open Q:** one device
per camera vs per child; whether to expose *controls* (arm/disarm alerts) not just sensors.

### C2. Remote lullaby / white-noise
**Problem:** two-way *talk* works; the reverse — playing soothing audio out the camera speaker — is a
natural, high-delight extension.
**Approach:** stream a chosen audio file (or loop white noise) to the camera speaker over the same
**ONVIF audio-backchannel** sink that powers two-way talk (`OnvifBackchannelTalk`), transcoded to the
camera's G711 backchannel codec. On-tap from the tile, plus optional scheduled playback.
**Schema:** a small library of built-in sounds; optional per-child schedule.
**Effort:** medium (audio-file → G711 RTP feed; scheduling). **Open Q:** built-in sounds only vs
user-uploaded; loop/duration controls. Only works on cameras with a working backchannel (Thingino ✓).

### C3. Nursery kiosk / wall-tablet mode
**Problem:** a cheap mounted tablet wants a dedicated always-on view, not the full app.
**Approach:** a **dimmed, red-shifted, always-on** route showing one camera + clock + room temp, tap
to wake to full brightness/controls; auto-dim after inactivity; screen-wake-lock. Pure frontend (a new
route + a display mode), no backend.
**Effort:** small–medium (frontend only). **Open Q:** which camera (fixed vs rotate); PWA
fullscreen/wake-lock behaviour on the target tablet.

---

## D. Access / sharing

### D1. Time-limited babysitter link
**Problem:** a sitter needs to watch without a full caregiver account.
**Approach:** a **scoped, expiring, read-only token** granting live view of a single camera (or child)
until an expiry, revocable anytime. Reuses JWT + the `sessions` row model + roles (a new narrow
scope). No settings/management access, no history — just live.
**Schema:** a `guest_grants` row (scope, camera/child, expires_at, revoked) checked by auth middleware.
**Effort:** medium (scoped auth path + a share-link UI + revocation). **Open Q:** whether audio/talk is
included for a guest (probably view-only, no talk).

---

## E. Deliberate non-goal (stated so it doesn't creep in)

### E1. Breathing / roll-over / SIDS-style "safety" detection — **NOT building**
The obvious ask for a baby monitor, and deliberately declined. A self-hosted hobby app must not present
as a **medical/safety device**: false confidence is genuinely dangerous, and the accuracy/liability bar
is far beyond this project. Sleep tracking stays clearly labelled *pattern inference*, never a vitals
or safety claim (consistent with the recording/sleep scope's existing stance). Any mmWave/respiration
hardware tier, if ever, is a separate explicitly-opt-in future and still not marketed as a safety
guarantee.

---

## Suggested first three
**A1 (weekly sleep digest)** + **A2 (climate correlation)** — both nearly free given the data already
collected, and they turn sleep tracking from *data* into *insight*. Plus **C1 (Home Assistant
integration)** — highest fit for this specific deployment. Each is self-contained and shippable via the
normal dev → staging → prod-on-go-ahead flow.
