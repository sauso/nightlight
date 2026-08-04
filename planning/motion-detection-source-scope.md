# Nightlight: Motion Detection Source (frame-diff vs camera-native/MQTT) — Scope Document

Status: **Design only — not built.** Current motion detection is the server-side **frame-diff**
detector shipped in 0.8.0 (see `motion-sound-push-notifications-scope.md` and
`backend/src/lib/motionDetector.js`). This document captures the decision to **keep frame-diff as the
universal default and add MQTT camera-native events as an optional per-camera source**, most likely in
the **next release**. ONVIF events were considered and deferred.

> **Decision (2026-08-04):** go down the **frame-diff + MQTT** path. Frame-diff stays as the
> works-on-any-camera baseline; MQTT becomes an opt-in per-camera detection source that offloads
> detection to cameras that can do it themselves (thingino / sonoff-hack and similar). We are **not**
> ripping out frame-diff, and we are **not** doing ONVIF events for now.

Do not start implementation from this document alone — confirm current repo structure first (file
paths below are best-guess from the design discussion, verify against the live repo).

---

## The problem

Frame-diff detection works on **any** RTSP camera but has real costs: it decodes and diffs each
camera's stream **on the server** (mitigated but not eliminated by sampling the low-res sub-stream),
and a naive pixel delta is prone to false triggers (IR day/night switching, shadows, lighting
changes) and currently watches the whole frame (a crib-zone picker is still a planned follow-up).

Many cameras can detect motion **themselves**, on their own SoC — often with hardware motion vectors,
built-in zones/sensitivity, and sometimes PIR or audio triggers — and announce it. Consuming those
events instead would cost the server ~nothing and generally be more accurate. The catch is that
camera-native detection only exists on **some** cameras, so it can't be the only path.

## Options considered

| | **Frame-diff (today)** | **Camera-native → MQTT** | **Camera-native → ONVIF events** |
|---|---|---|---|
| Works on which cameras | **Any RTSP camera** | Only cams running suitable firmware (thingino = Ingenic SoCs; sonoff-hack = specific Sonoffs) | Many commercial cams (Hikvision/Reolink/Dahua); thingino also exposes an ONVIF motion sensor |
| Server CPU | Decode + diff **per camera** | **~Zero** (camera's SoC detects) | ~Zero |
| Detection quality | Dumb pixel delta; false triggers on IR/shadow/light; whole-frame for now | ISP motion vectors, usually on-camera zones/sensitivity, sometimes PIR/audio | Camera's own detector, zones configured on-camera |
| Latency | Sample cadence + confirm delay | Immediate | Immediate-ish |
| Extra infrastructure | None | An MQTT broker — **which Nightlight already connects to** (temp/humidity) | None (reuses ONVIF) |
| Implementation cost | Already built | **Low — plumbing already exists** (see below) | Higher (PullPoint subscriptions, per-vendor quirks, flaky on cheap cams) |

**Why MQTT over ONVIF events for us:** ONVIF events are the more *universal* camera-native path (no
custom firmware), but PullPoint event subscription is fiddly, quality varies wildly per vendor, and
cheap cameras implement it poorly (our test Sonoff already faults on `GetCapabilities`). MQTT, by
contrast, reuses infrastructure we already have and is a clean fit for the thingino/sonoff-class
cameras in this deployment. ONVIF events remain possible future work if a well-behaved ONVIF camera
makes it worthwhile.

## Why MQTT is cheap to add here

Nightlight **already** has the MQTT plumbing, currently used only for room temperature/humidity:

- Broker connection + config in `Settings → MQTT` (`settings.mqtt_*`, `lib/mqttClient.js`).
- A per-camera `cameras.mqtt_topic` and a subscribe loop.
- A `client.on('message')` handler that today parses `{temperature, humidity}` payloads.

Adding motion is largely: **recognize a motion signal in that same handler and fire the same
downstream the frame-diff detector already fires** — `recordDetectionEvent(...)` + `sendToAll(...)`
(see `lib/detectionEvents.js`, `lib/push.js`). No new subsystem.

## Design sketch (for the next release — not final)

- **Per-camera "detection source"**: a select on the camera edit form — `Nightlight (frame
  difference)` | `Camera via MQTT`. Default stays frame-diff.
- **When a camera is set to MQTT source:**
  - Do **not** start its frame-diff detector (this is where the CPU saving comes from).
  - Subscribe to that camera's motion topic and, on a matching payload, call the shared
    record-event + push path. Reuse the existing per-camera **cooldown** so repeated MQTT events
    don't spam alerts.
- **Config surface**: broker already lives in Settings. Per-camera needs a **motion topic** and a
  small **"what counts as motion" matcher** — thingino's motion topic/payload is different from a
  temp/humidity reading, so we can't just reuse the existing `mqtt_topic` blindly (it may need its
  own field, or a payload rule like `motion == true` / a configured topic suffix). Nail down the
  exact thingino + sonoff-hack topic/payload shapes before building.
- **Downstream is identical** to frame-diff: same `detection_events` rows, same `Recent alerts`
  panel, same push (still gated by the admin `push_enabled` switch added on 2026-08-04).
- **Coexistence**: a camera uses exactly one source at a time; frame-diff remains the fallback and
  the default for any camera that can't self-detect.

## Open questions to resolve before building

1. **Exact thingino / sonoff-hack motion topic + payload** (confirm on the real cameras — thingino
   `send2mqtt`/`mosquitto_pub` output, and whether a retained/last-will state is involved).
2. **Config model**: reuse `mqtt_topic` vs add a dedicated `motion_mqtt_topic` + matcher. The temp
   topic and motion topic may differ per camera, so probably a separate field.
3. **Broker dependency UX**: MQTT source requires `Settings → MQTT` enabled + reachable; the camera
   form should make that prerequisite obvious and degrade gracefully if the broker is down.
4. **De-dupe / debounce**: apply the same confirm/cooldown semantics as frame-diff so a chatty camera
   doesn't flood alerts.
5. **Optional later**: ONVIF-event source as a third option for capable cameras; a crib-zone picker
   (still relevant to frame-diff regardless).

## Hardware context

This deployment has a **sonoff-hack** camera (MQTT-capable) and **Hikvision** cameras (ISAPI/ONVIF
events). So both non-frame-diff paths are technically usable here, but MQTT via the existing broker is
the cleanest first extension.
