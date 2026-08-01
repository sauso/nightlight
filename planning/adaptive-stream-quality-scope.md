# Nightlight: Adaptive Stream Quality — Scope Document

Status: **Not started.** Planning document only, to hand to Claude Code when
work begins. Confirm current repo structure against this document before
starting - file paths below are best-guess from prior conversation, not
verified against the live repo.

---

## The problem, stated precisely

Stuttering on slow/congested connections is currently unavoidable, not just
untuned. The transcoder uses `-c:v copy` (see
`backend/src/lib/transcoder.js`), so exactly one bitrate exists per camera -
whatever the camera itself produces. WebRTC has good congestion control
built in and already *detects* degradation perfectly well; it simply has
nowhere to go. Its only options with a single fixed-bitrate stream are to
buffer or drop frames, which is the stutter being observed.

So the actual goal is **not** "detect slow connections" - it's "give WebRTC
a lower-bitrate option to fall back to."

## Chosen approach

Cameras in use are confirmed to expose sub-streams. Nearly all IP cameras
generate a second, lower-resolution RTSP endpoint in hardware, at no CPU
cost to the server. This means two quality tiers can exist with **zero
server-side transcoding**.

**Explicitly rejected: a server-side transcode ladder.** Real ABR would mean
paying continuous CPU per camera on the Unraid box on top of existing
transcoding load, and would meaningfully complicate the ffmpeg pipeline. Not
worth it when the cameras already provide a second tier for free. Revisit
only if the sub-stream approach proves inadequate in practice.

---

## Phase 1 — Fetch main + sub stream URIs via ONVIF

**Depends on:** ONVIF discovery (see
`planning/onvif-and-two-way-audio-scope.md` phase 1). This work is a natural
extension of it rather than a separate effort - ONVIF's `GetProfiles` call
already enumerates every stream profile a camera exposes, which is exactly
the main/sub stream list needed here. Ideally build these together.

**Approach:**
- From `GetProfiles`, capture *all* stream profiles per camera, not just the
  first/highest - each with its resolution, framerate, and bitrate where the
  camera reports them.
- Classify into quality tiers. Do not assume profile ordering is meaningful
  or consistent across vendors - sort by actual resolution/bitrate rather
  than trusting the order returned.
- Handle the common cases explicitly: a camera exposing exactly two profiles
  (typical: main + sub), more than two, or only one (no sub-stream
  available).

**Data model:**
- Camera records need to hold multiple stream URIs rather than a single
  `mediamtx_path`. Likely a related table (`camera_streams`: camera_id,
  quality_tier, rtsp_uri, resolution, framerate) rather than extra columns,
  since the count varies per camera.
- Migration concern: existing manually-added cameras have exactly one
  stream. They must keep working unchanged - treat a single stream as
  "high tier only, no alternative available."

**MediaMTX implications (confirm before building):**
- Each stream tier needs its own MediaMTX path, so the transcoder
  supervisor now manages more than one ffmpeg process per camera.
- **Open question:** should sub-stream transcoders run continuously
  alongside main, or start on demand when a client actually requests low
  quality? Continuous is simpler and each stream is still `-c:v copy` (cheap),
  but doubles the process count and RTSP connections per camera. Given this
  session already saw one camera misbehave under normal load, worth
  considering whether doubling connections per camera introduces new
  instability. Recommend measuring before committing.

---

## Phase 2 — Manual quality selector

**Goal:** let the user explicitly choose stream quality per camera. Ship
this before any automatic behavior - it is simpler, it is what users often
want anyway ("I'm on hotel wifi, just give me low"), and automatic switching
needs it as its underlying mechanism regardless.

**UI:** the pattern already exists. `CameraTile.jsx` has a settings menu
(the gear button) currently offering "Low latency / Compatibility" for
transport mode. Quality is a separate axis from transport and should be its
own control, not merged into that list.

- Options: `Auto` / `High` / `Low` (with `Auto` only meaningful once phase 3
  exists - until then, default to `High` and offer only High/Low).
- Cameras without a sub-stream should show the control disabled or absent,
  not a Low option that silently does nothing.
- Persist per-camera, per-device in `localStorage`, consistent with how mute
  state is already handled in `CameraTile.jsx` (deliberately per-device
  rather than synced through the backend - a phone on mobile data and a
  wall-mounted tablet on wifi want different answers).

**Switching behavior:** changing quality means tearing down the current
WebRTC/HLS connection and establishing a new one against a different
MediaMTX path. Expect a visible reconnect gap. Worth making that transition
as smooth as possible (e.g. hold the last frame rather than showing a blank
tile) since automatic switching in phase 3 will trigger it without the user
asking.

---

## Phase 3 — Automatic quality switching (optional, removable)

**Explicitly optional.** Build it, evaluate it against real usage, and pull
it out if it doesn't work well. Nothing in phases 1-2 should depend on this
existing - `Auto` simply becomes an unavailable option if this is removed.

**Detection:** `RTCPeerConnection.getStats()` exposes `packetsLost`,
`jitter`, and frames-dropped-per-second. Detection is genuinely the easy
part - these stats reliably indicate degradation.

**The hard part is hysteresis, not detection.** Naive thresholds cause
flapping between tiers every few seconds, which feels considerably worse
than simply being stuck on low quality. Design requirements:
- **Asymmetric thresholds:** drop to low quality quickly (bad experience
  now), recover to high slowly (needs sustained evidence the connection
  actually improved).
- **Cooldown window** after any switch, during which no further switching is
  permitted regardless of stats.
- **A switch is not free** - each one costs a reconnect gap (see phase 2).
  The cost of switching must be weighed against the stutter being avoided;
  switching frequently to chase marginal gains is a net loss.
- Consider capping switches per session/hour as a blunt safety net against
  pathological flapping.

**Evaluation criteria before keeping this:** does it actually reduce
observed stuttering in real use, without producing noticeable
quality-flapping or frequent reconnect gaps? If it can't clear that bar,
remove it and leave the manual selector - which is a perfectly good outcome,
not a failure.

---

## Suggested order of work

1. Phase 1, ideally built together with ONVIF discovery rather than as a
   separate pass over the same `GetProfiles` data.
2. Measure the MediaMTX/transcoder cost of running sub-streams (continuous
   vs on-demand) before finalizing that decision.
3. Phase 2 - ships independently and is immediately useful on its own.
4. Phase 3 only after phases 1-2 are stable, with a genuine willingness to
   remove it if it doesn't earn its place.
