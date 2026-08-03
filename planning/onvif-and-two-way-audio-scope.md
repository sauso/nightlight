# Nightlight: ONVIF Discovery + Two-Way Audio — Scope Document

Status: **Phase 1 built** (ONVIF add-by-IP, not multicast discovery — see the Phase 1 notes for
why and what was learned against the real Sonoff). **Phase 2 (capability check) is also built** —
`probeOnvifCamera()` runs `GetAudioOutputConfigurations` at add time and records
`backchannel_supported` (`yes`/`no`/`unknown`), surfaced in the camera UI. **Phase 3 (two-way audio)
is BUILT and shipped in 0.7.0 (2026-08-03):** a tap-to-talk toggle on supported cameras, on a
Hikvision **ISAPI** backend (not the originally-planned approach — see "Phase 3 — implementation
findings & revised approach" below), with per-camera web-login credentials and a Verify button.
Confirmed working on the **Hikvision DS-2CD2386G2-ISU/SL**. No further two-way-audio phases are
outstanding; other backends (generic ONVIF backchannel / Dahua) remain possible future work only if
a non-Hikvision camera needs it.

> **Correction (2026-07-27): don't shop by "Profile T."** The audio backchannel
> needed for two-way talk is a *conditional* ONVIF feature that appears in *some*
> Profile S **and** *some* Profile T devices — plenty of Profile T cameras still
> expose no audio output. So the thing to confirm before buying a Phase 3 test
> camera is **explicit audio-backchannel support**, not the profile label:
> the device answers `GetAudioOutputConfigurations`, and its RTSP accepts the
> backchannel `Require: www.onvif.org/ver20/backchannel` header with a G.711
> output. Verify up front with ONVIF Device Manager or an `ffmpeg`/`onvif` probe.
> Brands that tend to implement it well: **Amcrest/Dahua-based** and
> **Hikvision**; Reolink is hit-or-miss per model, so verify that specific model.

Do not start implementation from this document alone — treat it as the
starting brief, confirm current repo structure first (file paths below are
best-guess based on prior conversation, not verified against the live repo).

---

## Why two phases before any two-way audio work

ONVIF compliance varies a lot across camera hardware. Most budget/generic
cameras that advertise "ONVIF" only implement Profile S (one-way
video+audio streaming) - the audio backchannel needed for two-way talk is a
much less commonly implemented part of the spec, more often found on
higher-end security-brand cameras (Hikvision, Dahua, Reolink, Axis) than
generic nursery cameras. Phases 1-2 are low-risk and valuable on their own
regardless of what phase 3 turns out to be feasible on. Phase 3 should only
be attempted against a camera already confirmed (via phase 2's capability
check) to actually support it.

---

## Phase 1 — ONVIF camera discovery

**Goal:** replace manual RTSP URL entry when adding a camera with automatic
LAN discovery.

**Approach:**
- Use ONVIF WS-Discovery (UDP multicast probe) to find ONVIF-compliant
  devices on the local network.
- Node library candidates: `onvif` or `onvif-nvt` (evaluate both for
  maintenance activity/API ergonomics before committing).
- For each discovered device, query its media profiles (`GetProfiles`) to
  retrieve the RTSP stream URI(s) and basic capabilities.
- **Docker networking note:** WS-Discovery multicast requires the container
  to be on the host's network - confirm this works under the existing
  `--network host` deploy mode before assuming it "just works"; multicast
  UDP does not reliably traverse Docker's default bridge networking.

**UI/UX:**
- "Add camera" flow gains a "Scan for cameras" option alongside manual entry.
- Scan results show discovered device name/IP; selecting one auto-fills the
  RTSP path instead of requiring it to be typed in.
- Manual entry stays available as a fallback for non-ONVIF or undiscoverable
  cameras.

**Data model:**
- Add fields to the camera record: `onvif_capable` (bool), `discovery_source`
  (`manual` | `onvif`), ONVIF device service address (for later capability
  queries in phase 2).

**Risk:** low. Discovery either succeeds or fails per camera; doesn't affect
already-configured cameras using the existing manual flow.

### Phase 1 implementation notes (2026-07-27 — what actually shipped)

Built as **add-by-IP, not multicast WS-Discovery.** Probing the real setup showed
multicast is the wrong primary mechanism here:
- **WS-Discovery multicast doesn't cross VLANs** (it's L2; needs IGMP/PIM, not just
  unicast routing). The owner's cameras and Nightlight instances live on different VLANs
  (camera on VLAN3, prod on VLAN1, staging on VLAN10), so a scan only ever finds
  same-VLAN cameras. **Unicast add-by-IP works across the routed network.** Multicast
  scan was intentionally dropped (can be added later purely as a same-VLAN convenience).

What shipped (library: `onvif@^0.8.1`, classic `Cam` API):
- `backend/src/lib/onvif.js` `probeOnvifCamera({host, port, username, password})` →
  `{ rtspUrl, suggestedName, video:{codec,width,height}, audio:{codec}, onvifDeviceUrl }`.
- `POST /api/cameras/onvif-probe` (admin, read-only) — creates nothing; the normal
  `POST /api/cameras` still adds.
- `cameras` table gained `discovery_source` (`manual`|`onvif`), `onvif_capable`,
  `onvif_device_url` (so Phase 2/PTZ can reconnect).
- Add-camera modal gained an "Auto-fill from ONVIF" block; manual entry stays.

**Resilient-client learnings (from the sonoff-hack Sonoff — a deliberately awkward test
case).** Its `onvif_simple_server` is a rough ONVIF citizen; a naive client fails on it:
- It **faults (`ter:ActionFailed`) on `GetCapabilities`/`GetServices`** — even
  unauthenticated — which is what the library's normal `connect()` calls, so connect
  fails outright. Fix: on connect failure, skip capabilities and hit the **media service
  directly** at a known path (`/onvif/media_service`), then `GetProfiles`/`GetStreamUri`.
- `GetStreamUri` returns a **host-less URI with bogus embedded creds**
  (`rtsp://hack:hack@/av_stream/ch0`). Fix: trust only the **path**; rebuild the URL from
  the **IP we connected to** + the **credentials the user supplied**. Verified: the
  rebuilt `rtsp://<user>:<pass>@<ip>:554/av_stream/ch0` streams H264 1080p + G.711 audio.
- Its ONVIF creds and RTSP creds can differ; never assume the stream URI's creds are usable.

A compliant camera should just work via the normal connect path (no fallback needed).

---

## Phase 2 — Backchannel capability check (read-only)

**Goal:** know, per camera, whether it actually supports two-way audio
before building any feature around it.

**Approach:**
- Query `GetAudioOutputConfigurations` (and related capability endpoints) via
  ONVIF on cameras already added/discovered.
- Store the result: `backchannel_supported` (`yes` | `no` | `unknown` -
  `unknown` for cameras added manually pre-ONVIF, or where the query itself
  fails/times out).
- Surface this as a simple badge in the camera settings UI - purely
  informational at this stage, no audio functionality yet.

**Risk:** low - read-only capability query, no behavior change to existing
streams.

---

## Phase 3 — Two-way audio

**Goal:** push-to-talk audio from the app to a camera's speaker, for
cameras confirmed (via phase 2) to support it.

**Proposed architecture** (leverages existing MediaMTX infrastructure rather
than introducing a separate audio pipeline):

```
Browser mic (getUserMedia)
  --> WHIP ingest into MediaMTX (MediaMTX supports WHIP as an ingest
      protocol, not just serving streams out - confirm the pinned
      MediaMTX version in the Docker setup actually supports this)
  --> a dedicated ffmpeg leg per camera, forwarding the WHIP-ingested
      audio into that camera's ONVIF backchannel RTSP endpoint
      (typically expects G.711 PCMU/PCMA - confirm per camera)
```

**UX requirements, decided up front rather than left to the implementation:**
- **Push-to-talk only** (hold a button) - not an open/always-on mic. Avoids
  leaving audio hot accidentally and reduces feedback-loop risk.
- **Duck or mute the camera's incoming audio in the UI while talking** -
  walkie-talkie style, to avoid the camera's own mic picking up its own
  speaker output and creating echo/feedback.
- Only offered as an option on cameras phase 2 marked
  `backchannel_supported: yes` - never presented as available on `no` or
  `unknown` cameras.

**Open questions to resolve before starting this phase:**
- Confirm the pinned MediaMTX version actually supports WHIP ingest (not
  just WHEP/output) - check `mediamtx/mediamtx.yml` and the Docker image tag
  in use.
- ONVIF auth handling - most devices require WS-UsernameToken auth for
  control operations; confirm how camera credentials are currently stored
  and whether that's sufficient for ONVIF calls too, or a separate
  credential field is needed.
- Audio codec compatibility per camera - G.711 is the most common
  requirement for ONVIF backchannel, but confirm against the actual test
  camera once acquired.
- Latency expectations - real-time enough for a natural conversation, or is
  some delay acceptable given the reassurance-focused use case (not a full
  duplex call)?

**Risk:** higher - new bidirectional audio pipeline, new failure modes
(codec mismatches, camera-specific quirks), and genuinely dependent on
whether the acquired test camera's Profile T implementation behaves as
advertised. Prototype against one known-good camera before generalizing.

---

## Hardware findings

- **Sonoff GK-200MP2-B (with `sonoff-hack` firmware — github.com/roleoroleo/sonoff-hack):**
  a good **Phase 1–2 dev camera, not a Phase 3 camera.** The hack turns it into a clean
  local ONVIF/RTSP camera (cloud-disabled, PTZ, one-way audio in) and it discovers via
  WS-Discovery, so it's ideal for building/testing discovery and the capability check
  (where it should correctly report `backchannel_supported: no`). But its bundled ONVIF
  server is Profile S-class and implements **no audio backchannel** — confirmed by testing.
  The camera hardware may have a speaker (the stock eWeLink app's intercom), but the only
  path to it is Sonoff's proprietary cloud protocol; the open firmware doesn't bridge
  talkback, and adding it would be camera-firmware work out of scope for this app. So it
  cannot be the two-way-audio prototype target — a confirmed-backchannel camera is still
  needed for Phase 3 (see the shopping note at the top).

- **Hikvision DS-2CD2386G2-ISU/SL (firmware V5.7.19)** — acquired 2026-08-02, the **Phase 3
  prototype camera.** On staging as "Test" at `192.168.5.11`. Live ONVIF probe confirmed a real
  speaker: `GetAudioOutputConfigurations` returns one output with
  `sendPrimacy: www.onvif.org/ver20/HalfDuplex/Auto` (half-duplex = walkie-talkie, which matches
  the push-to-talk + duck-incoming UX). Full ONVIF service set (ver20 media, deviceIO). RTSP is the
  Hikvision scheme `rtsp://<u>:<p>@ip:554/Streaming/Channels/101`.

## Phase 3 — implementation findings & revised approach (2026-08-02)

Probed the real Hikvision above before starting. Two corrections to the Phase 3 plan:

**1. The proposed "ffmpeg leg → RTSP backchannel" does NOT work.** ffmpeg cannot perform the ONVIF
audio backchannel handshake — the backchannel is a *sendonly* media track negotiated inside the
downstream RTSP `DESCRIBE` (`Require: www.onvif.org/ver20/backchannel`), not a normal RTSP
publish/ANNOUNCE. So the generic-ONVIF path needs a **custom RTSP client** (raw DESCRIBE/SETUP/RTP,
or GStreamer), not ffmpeg. (MediaMTX in the image is **v1.19.3**, which *does* support WHIP ingest,
so the browser→server half is fine — it's only the server→camera leg that the plan got wrong.)

**2. Design it as a pluggable "talk sink", because the server→speaker leg is the only camera-specific
part.** The browser→server→G.711 (μ-law 8 kHz) pipeline is identical for every camera — build it
once. Behind it, a `TalkSink` interface with one implementation per camera type, selected by a new
`talk_backend` column on the camera (`hikvision-isapi` | `onvif-backchannel` | `thingino` | `none`),
set at add time from the capability probe. Adding a new camera type is then one new sink, not a
rewrite.

**Sink implementations, easiest first:**
- **`hikvision-isapi`** (this camera, and Hikvision generally) — **CONFIRMED working 2026-08-02.**
  HTTP, not RTSP: `PUT /ISAPI/System/TwoWayAudio/channels/1/open` → stream to `.../audioData` →
  `.../close`. No RTSP backchannel, no ffmpeg leg, no MediaMTX for the talk path. **Much** simpler
  than Path A. Verified live: `GET /ISAPI/System/TwoWayAudio/channels` returns channel `id=1` with
  **`audioCompressionType: G.711ulaw`** (μ-law, 8 kHz mono) — so the backend transcodes the browser
  mic → G.711 μ-law and streams the bytes to `audioData`.
  - **Auth gotcha (important):** ISAPI is HTTP-digest against Hikvision's **web/ISAPI user DB, which
    is SEPARATE from the ONVIF user DB** (ONVIF users live under Network → Integration Protocol →
    ONVIF; web/ISAPI users under System → User Management). The ONVIF-only account we store for the
    camera (used for RTSP + the capability probe) gets `401` on ISAPI even for `deviceInfo`. Fix: a
    **normal web account** was created on the test camera and ISAPI then returns `200`. So the
    Hikvision talk sink needs its **own web/ISAPI credential field**, distinct from the stored
    ONVIF/RTSP creds. (Also note Hikvision's "Illegal Login Lock" — repeated bad logins lock the
    source IP ~30 min; disable under Security → Security Service if it bites during dev.)
- **`onvif-backchannel`** (generic, vendor-neutral) — the custom-RTSP engine from correction #1.
  Harder; build only once a second brand needs it.
- **`thingino`** (open Ingenic firmware, if flashed on a future camera) — its ONVIF is
  `onvif_simple_server` (minimal Profile S, historically **no** backchannel), so it'll likely probe
  as `backchannel: no/unknown` and NOT use the ONVIF path. But it's an open Linux device you control,
  so it exposes a direct audio-in path (an RTSP backchannel *if* the flashed `prudynt` build
  supports two-way audio, else a native audio-play hook — HTTP/MQTT/`audioplay` to the ALSA device).
  Verify on the actual build; often easier than a vendor API since there's no locked permission
  model. If `prudynt` does expose the backchannel, it can reuse the `onvif-backchannel` sink engine.

**Transport for the outbound (talk) audio:** a **WebSocket** (browser mic → PCM/Opus → backend →
transcode to G.711 μ-law → sink) is simpler and lower-latency than routing outbound audio through
WHIP/MediaMTX. Keep MediaMTX for the downstream view only.

**Revised recommendation:** build the shared browser→server→G.711 front end + the `TalkSink`
abstraction, ship the **Hikvision-ISAPI sink first** against `192.168.5.11` to get talk-back working
end-to-end on real hardware, then add `onvif-backchannel` / `thingino` sinks later as needed.

## Suggested order of work when starting

1. Phase 1 (discovery) - ships independently, immediate UX value.
2. Phase 2 (capability check) - cheap to add once phase 1 exists, informs
   whether phase 3 is worth pursuing at all for the cameras actually owned.
3. Acquire/confirm the Profile T test camera (already planned).
4. Prototype phase 3 against that one camera only, before deciding whether
   to roll out more broadly.
