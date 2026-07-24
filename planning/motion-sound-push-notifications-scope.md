# Nightlight: Motion/Sound Detection + Push Notifications — Scope Document

Status: **Not started.** Planning document only, to hand to Claude Code when
work begins. Confirm current repo structure against this document before
starting - file paths and library choices below are proposals, not verified
against the live repo.

---

## Core architectural principle

Detection must happen **server-side** (on the Unraid box), not on the phone.
The entire point of this feature is alerting when the app is closed or
backgrounded, so the phone cannot be the thing doing the detecting - it may
not even be running. This is good news for complexity: it means no new
battery/background-service problem on the Android side (that problem is
already solved, for audio, by the existing foreground service). The phone's
job becomes simple: receive a push notification and display it. All the hard
work happens continuously on the server, watching each camera's stream.

---

## The three different problems hiding inside "detect motion or crying"

These are not equally hard - worth treating as three separate, separately
riskable pieces of work rather than one feature:

1. **Motion detection** - easiest. Frame-differencing between consecutive
   video frames, cheap CPU cost, no ML needed, mature/well-understood
   technique.
2. **Voice activity detection ("is there sound at all")** - moderate.
   Established lightweight libraries exist (WebRTC's VAD, Silero VAD) that
   reliably distinguish "something's making noise" from silence, without
   needing to classify *what* the noise is.
3. **Cry-specific classification ("is this a baby crying" vs. a dog barking,
   TV, door slam, adult talking)** - hard. A real audio classification
   problem. Open models exist but accuracy needs real-world tuning against
   actual room acoustics and camera mic quality - not a simple threshold.

**Recommended sequencing: ship 1 and 2 first, skip 3 entirely at first.**
Get the full pipeline (detection → push → phone) working end-to-end on the
easier, more reliable triggers before attempting cry-specific classification,
which is both the hardest part and the part most dependent on audio quality
that's already proven inconsistent across cameras (see below).

---

## Known risk: inherited audio quality problems

This session already found a real firmware issue on one camera (Renz Room)
causing corrupted timestamps/choppy audio, independent of Nightlight's own
code. Any cry-detection feature is only as reliable as the underlying audio
- garbage audio in means garbage detection out. Worth explicitly testing
detection quality per-camera rather than assuming uniform reliability
across the whole camera fleet.

---

## Alert fatigue - a design problem, not just an engineering one

A system that fires on every car door slam or TV noise gets muted within a
week and defeats its own purpose. This needs to be designed deliberately
from the start, not bolted on after the fact:

- Per-camera sensitivity tuning (a camera facing a window needs different
  motion thresholds than one facing a crib away from traffic)
- A cooldown window per camera so continuous crying doesn't produce a
  notification every few seconds
- A short confirmation delay before firing (e.g. motion/sound sustained for
  N seconds) rather than triggering on a single frame/moment, to filter out
  brief spurious triggers

---

## Push delivery mechanism

Actually waking a backgrounded/closed app to show a system notification
requires going through the platform's push service - there's no way around
this; only the OS can do it:
- **Android**: Firebase Cloud Messaging (FCM)
- **iOS**: Apple Push Notification service (APNs)

This is a lightweight dependency - relaying a small "something happened"
message, not video/audio data itself - but it is technically a cloud
service in the loop, worth being conscious of given the project's "no
cloud" positioning, even though it doesn't compromise the promise that
video/audio data itself stays on the user's own server.

**Already in place, unused:** `nightlight-android/android/app/build.gradle`
already references `google-services.json` and applies the Google Services
Gradle plugin - this is boilerplate the Capacitor template includes by
default. The FCM plumbing is dormant but partially present; it needs an
actual `google-services.json` (from a Firebase project you'd create) and
the client-side registration/token-handling code to become functional.

---

## Proposed architecture sketch

```
Per-camera server-side worker (new)
  - reads the same RTSP/stream source already being transcoded
  - motion: frame-diff on a low-res/low-fps sampled copy of the video
    (does not need to touch the existing WebRTC/HLS pipeline - a separate,
    cheap, lower-frequency sample is enough)
  - sound: VAD on the audio stream
  - on sustained detection (past the cooldown/confirmation-delay logic
    above): write an event + push a notification via FCM/APNs

Backend
  - new endpoint(s)/table for per-camera detection settings (enabled,
    sensitivity, cooldown) and an events log (for a "recent alerts" view)
  - stores device push tokens per registered phone

Android/iOS app
  - registers for push tokens on install, sends to backend
  - receives push -> shows system notification -> tapping it opens the app
    to the relevant camera
```

**Open questions to resolve before starting:**
- Where does the detection worker run relative to the existing
  ffmpeg/transcoder processes - same container, separate service? Given the
  existing transcoder is already doing per-camera process supervision, a
  natural fit may be extending that rather than building a fully separate
  system, but confirm against current architecture first.
- CPU budget - running frame-diff + VAD continuously across every camera,
  all the time, on top of existing transcoding load, needs to be checked
  against the Unraid box's actual headroom.
- Notification content/privacy - does the push payload include anything
  camera-identifying, or stay fully generic ("motion detected on a camera,
  open the app for details")? Affects how much is exposed if a push
  notification is visible on a lock screen.
- Firebase project setup is a one-time manual step (create project, get
  `google-services.json`) - same category of "can't fully automate the
  first step" as the Play Store's first manual upload.

---

## Suggested order of work when starting

1. Motion detection + push pipeline end-to-end, on one camera, manually
   verified before enabling broadly - prove the full chain (detect → push →
   phone shows notification → tap opens the right camera) works before
   adding sound detection on top.
2. Add voice activity detection (sound present, not classified) once motion
   + push is solid.
3. Tune cooldown/sensitivity/confirmation-delay against real usage for a
   week or two before considering it "done" - alert fatigue is the failure
   mode most likely to quietly kill this feature's usefulness.
4. Only then evaluate whether cry-specific classification is worth
   attempting, informed by how well plain sound-detection performs in
   practice.
