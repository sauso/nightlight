# Nightlight: ONVIF Discovery + Two-Way Audio — Scope Document

Status: **Not started.** This is a planning document to hand to Claude Code
when work actually begins — waiting on acquiring a camera confirmed to
support ONVIF Profile T before starting, since Profile T is the profile most
likely to include the audio backchannel needed for phase 3.

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

## Suggested order of work when starting

1. Phase 1 (discovery) - ships independently, immediate UX value.
2. Phase 2 (capability check) - cheap to add once phase 1 exists, informs
   whether phase 3 is worth pursuing at all for the cameras actually owned.
3. Acquire/confirm the Profile T test camera (already planned).
4. Prototype phase 3 against that one camera only, before deciding whether
   to roll out more broadly.
