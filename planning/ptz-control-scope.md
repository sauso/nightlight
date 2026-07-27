# Nightlight: PTZ Camera Control — Scope Document

Status: **Implemented (on `dev` / staging) as of 2026-07-27.** Built on the ONVIF add-by-IP
work (`onvif-and-two-way-audio-scope.md`). The design below is largely what shipped, with
one deliberate change: movement uses **fixed-duration "nudges"** rather than raw press-to-
release continuous move — see the implementation note under "Interaction model" below.

### What shipped (2026-07-27)

- **Capability + creds captured at ONVIF add time** (`ptz_supported`, plus the ONVIF
  credentials and media profile token in `onvif_*` columns), so control reconnects without
  re-querying. `probeOnvifCamera()` sets `ptz` from the profile's `PTZConfiguration`.
- **`ptzNudge()` in `lib/onvif.js`** (start → hold `PTZ_NUDGE_MS` → stop in one call) via
  `POST /api/cameras/:id/ptz/nudge` (any signed-in user). Fixed-distance per press, so it's
  consistent regardless of tap/network timing, and self-stopping (plus a `continuousMove`
  timeout backstop) so it can't run past the limit.
- **`CameraTile.jsx`**: a move button (only when `ptz_supported`), a D-pad overlay,
  hold-to-repeat nudges. Uses the proven inject-paths ONVIF approach (skip capabilities, hit
  `/onvif/ptz_service`). Pan/tilt only for now — zoom/presets not built (see below).
- The **runaway/consistency problems** that surfaced in testing (press-to-release timing +
  per-request latency) are exactly why it became nudge-based. If a nudge feels too big/small,
  tune `PTZ_NUDGE_MS` (currently 200ms).

Not built yet: **optical zoom** (only offer if a camera reports a real zoom axis — distinct
from the tile's existing double-tap digital zoom) and **presets**. Both remain as below.

---

## Goal

In-app pan/tilt (and zoom, where the camera actually has it) for cameras that
support PTZ — so you can reposition a camera from the Nightlight UI instead of
the manufacturer's app. Aimed at nursery use: reframe the cot, follow a toddler
who's climbed out, etc. One-handed and usable at night is the bar.

---

## UX

**Entry point:** a **PTZ icon in the tile's overlay control row, next to the
stream-mode (Compatibility/Low-latency) icon.** It is shown **only on cameras
whose capability check reports PTZ support** — never on fixed cameras (same
gating pattern as the two-way-audio badge). Tapping it toggles a control
overlay; tapping it again (or outside) dismisses.

**The control overlay:** a compact D-pad of directional arrows
(up / down / left / right; diagonals optional if the camera supports simultaneous
pan+tilt) centered over the video, plus:
- a **center/home** button (ONVIF `GotoHomePosition`, or a home preset),
- **zoom +/- buttons ONLY when the camera reports optical zoom** (see "Zoom vs
  the existing digital zoom" below),
- (later) **presets** — recall saved positions.

**Interaction model — hold-to-move:**
- Press-and-hold an arrow → ONVIF `ContinuousMove` in that direction; release →
  `Stop`. This is the natural, fluid model (matches the eWeLink app).
- **Safety — preventing a runaway pan is the single most important requirement.**
  A dropped "release" (finger slides off, pointer-cancel, the tab backgrounds,
  a network blip on the Stop call) must never leave the camera panning forever.
  Mitigations, all of them:
  - Send `Stop` on `pointerup`, `pointerleave`, `pointercancel`, and on
    `visibilitychange` to hidden.
  - A **max-duration failsafe**: auto-`Stop` after N seconds of continuous move
    regardless (a held arrow re-issues to keep going).
  - Retry/confirm the `Stop` call; a failed Stop is a bug worth surfacing.
- **Fallback for cameras without ContinuousMove:** tap-to-nudge via
  `RelativeMove` by a fixed step. Detect support during the capability check.

**Where it's usable:** support the overlay both on the grid tile and in
fullscreen. Fullscreen is where it'll actually get used (bigger targets, one
hand) — make sure the overlay and hold-to-move gestures work there, not just on
the small tile. Note the tile already has a **double-tap digital zoom** gesture;
the PTZ overlay's presence must not break or conflict with it (e.g. arrow
presses shouldn't register as tile taps — reuse the existing `closest('button')`
guard in `CameraTile.jsx`).

---

## Zoom vs. the existing digital zoom

The tile already has a **digital** zoom (double-tap to 2.5× and pan around the
frame — purely client-side, `CameraTile.jsx`). PTZ zoom is **optical** (the
camera's lens/sensor) and only exists on some cameras. Keep them distinct:
- Only show PTZ zoom controls when the ONVIF capability check reports a real
  zoom axis. Most nursery pan/tilt cams have none — for those, the existing
  digital zoom is the only zoom and PTZ is pan/tilt only.
- Don't relabel or remove the digital zoom; it's useful on every camera.

---

## Backend

New API endpoints proxying ONVIF PTZ, e.g. `POST /api/cameras/:id/ptz/move`
(direction/speed), `POST /api/cameras/:id/ptz/stop`, `POST .../ptz/home`, and
later `.../ptz/presets` (list / goto / set). All admin-or-caregiver — decide
whether repositioning is a caregiver action (probably yes) vs admin-only.

- Uses the ONVIF PTZ service + a media profile token obtained during discovery.
- **Auth:** ONVIF control operations need WS-UsernameToken auth. Resolve the same
  open question as the two-way-audio doc: are the credentials embedded in the
  camera's RTSP URL reusable for ONVIF, or is a separate stored ONVIF credential
  field needed? Settle this once for both features.
- **Rate-limit** move/stop commands (hold-to-move can otherwise spam), but never
  drop a `Stop`.

## Data model

- `ptz_supported` (`yes` | `no` | `unknown`) — from the capability check, same
  shape as `backchannel_supported`.
- Optionally cache `ptz_has_zoom` (bool) and whether continuous vs relative move
  is supported, so the UI doesn't re-probe on every open.
- (later, for presets) a `camera_ptz_presets` table or reuse the camera's own
  ONVIF-stored presets (prefer the camera's own if reliable — no sync to keep).

---

## Open questions to resolve before starting

- Continuous vs relative move support varies per camera — the capability check
  should record which, so the UI can pick hold-to-move vs tap-to-nudge.
- Pan/tilt **speed**: fixed, or a setting? Start fixed (a sensible medium speed);
  don't over-build.
- Multi-viewer concurrency: two people nudging at once. ONVIF is last-command-
  wins; probably fine, but confirm Stop from one client doesn't strand another.
- Does PTZ movement disrupt the WebRTC/HLS stream (some cameras hiccup the
  encoder while the motor runs)? Test against the real camera; if so, the
  existing reconnect logic should already recover it.

---

## Risk

Low-to-moderate. The controls are additive and gated on capability, so they
never touch fixed cameras or existing streams. The one genuine hazard is a
runaway pan from a missed `Stop` — treat the stop-on-every-release-path +
max-duration failsafe as non-negotiable, and prototype against the real camera
before shipping.

---

## Suggested order of work when starting

1. ONVIF discovery (Phase 1 of the other doc) must exist first — PTZ reuses its
   device service + credentials.
2. Add a PTZ capability check alongside the backchannel check (Phase 2 sibling):
   `ptz_supported`, continuous-vs-relative, has-zoom.
3. Backend PTZ move/stop/home endpoints, prototyped against one real PTZ camera
   (the `sonoff-hack` Sonoff supports PTZ and is a fine test target for this,
   even though it can't do two-way audio).
4. Tile overlay UI (icon + D-pad, hold-to-move with the full Stop-safety set),
   in both tile and fullscreen.
5. Optical zoom (only if a test camera has it) and presets as later additions.
