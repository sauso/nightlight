# Changelog

All notable changes to Nightlight (server + web app) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [Semantic Versioning](https://semver.org/). While on 0.x: minor bumps for new
features, patch bumps for fixes. History before 0.1.0 exists only as git history —
0.1.0 is the first tracked release, not the first release.

## [Unreleased]

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

[Unreleased]: https://github.com/sauso/nightlight/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/sauso/nightlight/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sauso/nightlight/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sauso/nightlight/releases/tag/v0.1.0
