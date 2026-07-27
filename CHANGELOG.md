# Changelog

All notable changes to Nightlight (server + web app) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/). While on 0.x: minor bumps for new
features, patch bumps for fixes. History before 0.1.0 exists only as git history —
0.1.0 is the first tracked release, not the first release.

## [Unreleased]

### Added
- **ONVIF auto-fill when adding a camera.** Enter the camera's IP and ONVIF username/password
  in the Add-camera form and Nightlight connects over ONVIF to fetch the RTSP URL and detected
  codec/resolution automatically, instead of hand-typing the RTSP path. Resilient to minimal
  ONVIF servers (falls back to the media service directly when a camera faults on the usual
  capability calls) and reconstructs the RTSP URL from the camera's IP + your credentials
  rather than trusting the (often wrong) host/creds the camera returns. Manual RTSP entry
  stays available. This is Phase 1 of planned ONVIF support (discovery-by-IP; multicast scan
  intentionally skipped as it can't cross VLANs). See `planning/onvif-and-two-way-audio-scope.md`.

## [0.4.9] - 2026-07-27

### Changed
- A brand-new visitor on a device now starts **muted** rather than unmuted. Muted audio
  autoplays cleanly (no browser gesture needed), and it's the politer default. Returning
  visitors are unaffected — each camera still remembers whatever you last set it to.

### Removed
- The "🔈 Tap for sound" prompt. When a browser blocks unmuted autoplay (no interaction yet
  on the page), the stream now just resumes silently on your first click/tap anywhere
  instead of showing a prompt to dismiss. Combined with the muted default above, most opens
  never hit the block at all.

## [0.4.8] - 2026-07-27

### Fixed
- Camera tiles are now 16:9 (were 16:10), matching the native aspect ratio of virtually all
  IP cameras. The taller tile made `object-fit: cover` crop the left/right edges, which was
  hiding the camera's own on-screen timestamp; at 16:9 the full frame shows.

### Changed
- Softened the camera tile corners a little less aggressively (16px → 10px radius).

## [0.4.7] - 2026-07-27

### Changed
- Leaving Picture-in-Picture now returns you to where you were, not always to fullscreen.
  If you opened PiP from the dashboard, expanding it back drops out of the fullscreen it
  used internally and returns to the dashboard; if you were already fullscreen on a camera,
  it stays fullscreen. (Uses the native PiP-mode signal from nightlight-mobile 0.4.1.)
- Restyled the on-video overlay controls (mute / settings / PiP / fullscreen): dropped the
  grey box, and the icons are now larger and white with a soft black glow, so they read
  cleanly over any footage without a heavy chrome background. Background-listening keeps an
  accent tint to stay distinguishable.

## [0.4.6] - 2026-07-27

### Added
- Background audio can now be **paused and resumed** from the system media controls -
  Android's notification (a Pause/Resume button next to Stop) and iOS's Now Playing
  controls (Control Center / lock screen). Pausing mutes the stream rather than
  disconnecting it, so resuming is instant and stays at the live edge. Both routes share
  one app-wide pause, so it stays consistent. (Android notification button needs
  nightlight-mobile 0.4.1; iOS is frontend-only via the Web Media Session API.)

### Fixed
- In the Android app, the on-video overlay buttons (mute / settings / fullscreen) are now
  hidden while a camera is floating in Picture-in-Picture, where they only obscured the
  small window. Driven by the native PiP-mode signal (nightlight-mobile 0.4.1).

## [0.4.5] - 2026-07-27

### Changed
- Minimizing the app now fully disconnects each camera stream unless it's in Background
  mode, instead of just muting it. Previously a backgrounded app in On/Off audio mode kept
  the WebRTC/HLS connection open — still pulling video and audio over the network and
  decoding it — until the OS eventually froze the WebView, a needless battery and data
  drain. The stream now tears down immediately on minimize (and reconnects on return).
  Background mode is deliberately exempt: keeping the connection alive with the screen off
  is its whole point. Affects both mobile apps.

## [0.4.4] - 2026-07-27

### Fixed
- Picture-in-Picture in the Android app now floats just the camera video instead of the
  whole app UI. Because Android's Activity PiP can only float the entire window, the PiP
  button now fullscreens the tile first (so the window *is* just the video) and then enters
  PiP. Auto-PiP-on-leave is likewise now gated on a camera being fullscreen — pressing Home
  from the grid just backgrounds normally (audio continues via the foreground service),
  while pressing Home from a fullscreen camera floats that camera. Frontend-only; works with
  the existing 0.4.0 APK. (Browser and iOS behavior unchanged — they use the web `<video>`
  PiP API, which already floats a single video.)

## [0.4.3] - 2026-07-27

### Fixed
- Camera timestamp glitches are now corrected at the source: FFmpeg replaces each incoming
  packet's timestamp with the server's arrival time (`-use_wallclock_as_timestamps 1`)
  rather than trusting the camera's own clock. Some cameras (e.g. the Sonoff GK-200MP2-B)
  send jittery/backward audio timestamps and occasional corrupt video timestamps; fixing
  them at the input covers *every* downstream track at once, including the WebRTC copy
  tracks that the HLS-only audio resampler (0.4.1) couldn't reach — so Low latency mode's
  audio flapping is addressed too, not just Compatibility mode. Trade-off: timing is now
  arrival-based, so A/V lip-sync may drift slightly; acceptable for a live monitor.

## [0.4.2] - 2026-07-27

### Fixed
- The camera tile's Picture-in-Picture button now works in the Android app. Android's
  WebView doesn't support the web `<video>` PiP API (which is why the button did nothing
  there, while working in a browser), so it now routes through the native shell's Activity
  PiP instead. Also auto-enters PiP when you leave the app while watching. Pairs with
  nightlight-mobile 0.4.0 — needs that APK; on older APKs it harmlessly falls back to the
  old behavior. (Android floats the whole app window, not a single tile — an OS
  limitation.)

## [0.4.1] - 2026-07-27

### Fixed
- Compatibility (HLS) mode no longer shows "No signal" when a camera sends jittery or
  briefly-backward audio timestamps. The AAC audio track now runs through an async
  resampler (`aresample=async=1`) that rebuilds a continuous, monotonic timeline, so the
  camera's audio-clock glitches (logged as "Queue input is backward in time") can't stall
  the HLS muxer. Root cause is camera-side (see `KNOWN-ISSUES.md`); this keeps
  Compatibility mode playable through it. Low latency (WebRTC) was unaffected either way.

## [0.4.0] - 2026-07-24

### Added
- **Pull-to-refresh** on the camera dashboard: pull down to rebuild every camera's stream
  connection without restarting the app. This is the fix for a camera that shows
  disconnected on one device and won't come back on its own - a WebRTC connection that's
  wedged "connected" but no longer delivering frames. Crucially it works inside the native
  mobile apps too, where the browser's own pull-to-refresh gesture doesn't exist (so the
  previous "just pull to refresh" advice couldn't actually be followed there). The
  browser's native page-reload pull is suppressed so it can't fire underneath it.

### Changed
- Troubleshooting docs, the Camera history panel, and `KNOWN-ISSUES.md` now point to
  pull-to-refresh (which works everywhere) rather than "close and reopen the app".

## [0.3.0] - 2026-07-24

### Added
- **Camera history** panel in Settings (admin): a persistent, at-a-glance log of camera
  drop-outs, recoveries, and transcoder restarts, so "was that the camera, the server, or
  just my phone?" can be answered from the app instead of by reading `docker logs`. A real
  outage shows up here (every device saw it); a camera stuck on only one phone with nothing
  in the history is that phone's WebRTC connection - reopen the app. Kept for up to 30 days
  and hard-capped so it can't grow the data volume unbounded.
- `KNOWN-ISSUES.md`, a catalogue of understood quirks (camera-firmware glitches, the
  wedged-WebRTC-on-one-device case, the 30s watchdog recovery window, DTS log noise) with
  what each means and whether it needs any action. Linked from the README's Troubleshooting
  section, which also gained a note about the reopen-the-app fix for a stuck camera tile.

## [0.2.5] - 2026-07-24

### Fixed
- The "Add to Home Screen" install banner no longer appears inside the native
  mobile app (it's only meaningful in a browser; the native WebView doesn't
  report standalone display mode, so it was slipping through).

## [0.2.4] - 2026-07-24

### Changed
- The About page's mobile-app GitHub link now points to `sauso/nightlight-mobile`
  (the companion repo was renamed from `nightlight-android` ahead of iOS support).

## [0.2.3] - 2026-07-24

### Security
- Upgraded react-router 6 → 7, clearing a moderate advisory (GHSA-337j-9hxr-rhxg,
  an SSR-only issue that this client-only SPA was never exposed to). No API
  changes were needed - the app uses only React Router's library-mode surface,
  which is unchanged in v7.

## [0.2.2] - 2026-07-24

### Fixed
- A camera glitch could leave two FFmpeg processes fighting over the same
  MediaMTX path indefinitely - MediaMTX lets a new publisher override the
  current one, so each process kicked the other off and restarted, flapping the
  stream every ~10 seconds (observed: 901 restarts over 2.5 hours overnight).
  A crashed process now only restarts itself if it still owns the camera, and
  re-checks ownership when its 5-second restart timer fires.

## [0.2.1] - 2026-07-23

### Added
- "Not a safety device" notice in the README and on the About page: Nightlight is
  not a medical device and never a substitute for adult supervision.

## [0.2.0] - 2026-07-23

### Added
- MQTT can now be switched off in Settings without losing the saved broker
  config - previously the only "off" was clearing the host, and a temporarily
  stopped broker meant endless reconnect attempts in the logs.
- Text filter on the log viewer (case-insensitive, with a match count) - much
  easier to find specific events on a phone.
- About page in the menu: app version, GitHub / changelog / issue links, and a
  way to support the project.

## [0.1.0] - 2026-07-23

### Added
- "Change server" menu item in the hamburger menu, shown only inside the Android app —
  clears the saved server address and returns the native shell to its setup screen
  (pairs with nightlight-android 0.1.0).

### Fixed
- White bar below the bottom navigation on iOS, revealed by Safari's elastic
  overscroll (the page background now extends behind the document).
- Gray placeholder play icon showing on camera tiles before a stream connects in the
  Android app (the WebView's default poster-less video affordance; suppressed with a
  blank poster).
- Returning to the Android app after long background listening no longer forces a full
  reload — the reload-on-return recovery is skipped when the native foreground service
  was holding the connection alive the whole time, so the stream continues unbroken.

### Security
- Camera edit/delete now require the admin role (previously any caregiver could
  repoint a camera's RTSP URL or delete cameras); the RTSP URL, which usually embeds
  the camera's own credentials, is no longer returned to non-admin accounts.
- Changing a password (self-service or admin reset) now signs out the user's other
  devices instead of leaving those sessions valid for up to 30 days.
- Failed logins take constant time whether or not the username exists, so response
  timing no longer confirms valid usernames.
- Express now runs in production mode in the image — error responses no longer include
  stack traces revealing server file paths.
- Correct client IPs behind the reverse proxy (`trust proxy` set to loopback), making
  the login rate limiter count attempts per real client instead of per proxy.
- Sessions idle past the token's own 30-day lifetime are purged daily.
- Docker builds install from committed lockfiles (`npm ci`) for a reproducible,
  auditable dependency tree; vite upgraded 5 → 8 (clears dev-server advisories); both
  packages audit clean.

[Unreleased]: https://github.com/sauso/nightlight/compare/v0.4.9...HEAD
[0.4.9]: https://github.com/sauso/nightlight/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/sauso/nightlight/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/sauso/nightlight/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/sauso/nightlight/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/sauso/nightlight/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/sauso/nightlight/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/sauso/nightlight/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/sauso/nightlight/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/sauso/nightlight/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/sauso/nightlight/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sauso/nightlight/compare/v0.2.5...v0.3.0
[0.2.5]: https://github.com/sauso/nightlight/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/sauso/nightlight/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/sauso/nightlight/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/sauso/nightlight/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sauso/nightlight/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sauso/nightlight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sauso/nightlight/releases/tag/v0.1.0
