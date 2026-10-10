# Architecture

A developer-facing description of how the pieces fit together. It used to live in `CLAUDE.md`, where it was
loaded on every change; it moved here because most changes touch none of it. `CLAUDE.md` keeps the
**invariants** that must not be broken and points here for the explanation. Update this file when you change
a subsystem it describes.

**Everything ships as one Docker image, one container** — no multi-container orchestration to
reason about. The container needs its own routable LAN IP so WebRTC has no NAT/ICE problems
(MediaMTX advertises that IP to browsers). There are two supported ways to give it one: **host
networking** (the README quick-start default — the container shares the host's IP), or an
**ipvlan network with a dedicated IP**. The Unraid prod + staging deployments both use the latter
(both on `br0.10` — see Branching and deploy pipeline in `CLAUDE.md`); the host-networking path is what an
out-of-the-box `docker run` uses.

## The video pipeline (the core thing to understand before touching camera code)

RTSP cannot be played directly in a browser, and many IP cameras send audio as G711 (a codec
HLS can't carry at all — WebRTC can). This drives a specific pipeline, in order:

1. **FFmpeg** (`backend/src/lib/transcoder.js`, one process per camera) pulls each camera's
   RTSP feed, copies video untouched, and produces **two audio tracks**: track 0 copied as-is
   (for WebRTC, which can't decode AAC), track 1 transcoded to AAC (for HLS, which can't carry
   the original codec). It publishes the result into MediaMTX via RTSP on `127.0.0.1:8554`.
2. **MediaMTX** (`backend/src/lib/mediamtxProcess.js`, spawned as a child process, config baked
   into the image at `mediamtx/mediamtx.yml`) re-publishes that stream as WebRTC (WHEP) and HLS.
   Each camera's path has no pull source configured — it's publisher-only; FFmpeg pushes into
   it rather than MediaMTX pulling the camera directly (`backend/src/lib/mediamtx.js`).
3. **Backend** (`backend/src/index.js`) reverse-proxies `/live` (WHEP) and `/hls` to MediaMTX's
   local ports, and serves the built frontend + REST API on the single public port (4000).
4. **Frontend** picks WebRTC (`WhepPlayer.jsx`, "Low latency") or HLS (`HlsPlayer.jsx`,
   "Compatibility") per camera tile, toggled by the user.

## ONVIF, PTZ, and camera credentials (`backend/src/lib/onvif.js`, `rtspProbe.js`)

Cameras are added/edited by **components** (IP / port / path / username / password), not a
raw RTSP URL. The route layer (`routes/cameras.js`) assembles those into the stored
`rtsp_url` that the transcoder uses, and splits an existing `rtsp_url` back into fields for
the edit form. **The password is never returned to the client** — GET responses carry the
address in fields plus a credential-free display URL and a `rtsp_has_password` flag; on edit,
a blank password means "keep the existing one." Keep that invariant.

- **`lib/onvif.js`** — `onvif@0.8.1` client, deliberately resilient to minimal ONVIF servers
  (the sonoff-hack Sonoff faults on `GetCapabilities`/`GetServices`): it tries the normal
  connect, then falls back to hitting the media service directly at known paths, and
  reconstructs the RTSP URL from the connect host + user's creds + the discovered path (never
  the host/creds the camera returns — often empty/bogus). `probeOnvifCamera()` powers
  add-by-IP (`POST /api/cameras/onvif-probe`) and also reports two-way-audio (`getAudioOutput-
  Configurations`) and PTZ capability. **Discovery is add-by-IP, not multicast** — WS-Discovery
  doesn't cross VLANs.
- **PTZ** — `ptzNudge()` does start → hold `PTZ_NUDGE_MS` → stop in one call, so each press
  moves a fixed distance regardless of tap/network timing (`POST /api/cameras/:id/ptz/nudge`;
  the tile sends one per tap and repeats while held). ONVIF creds for control are the same
  single credential set stored with the camera; capability/creds/profile-token are captured
  at add time (`ptz_supported`, `onvif_*` columns) so control reconnects without re-querying.
- **`lib/rtspProbe.js`** — `validateRtspStream()` (ffprobe over TCP) runs on add/edit so a
  camera that can't be reached (bad creds/path/IP) isn't silently saved; the UI can override
  with `force` for a camera that's just momentarily offline.

## Self-healing / reconciliation (`backend/src/index.js`)

MediaMTX only learns about a camera when it's added/edited through the API, or via periodic
reconciliation. Three independent mechanisms keep the pipeline alive without manual restarts:
- `reconcileCameraPaths()` runs at startup and every 5 minutes: re-creates any MediaMTX path
  that's missing/misconfigured and restarts any camera whose transcoder isn't running. It only
  *writes* to MediaMTX when something is actually wrong, since every write forces a path reload
  that disconnects the current publisher.
- The same pass decides each camera's pixel-diff motion leg through `reconcileMotionLeg()`
  (`lib/motionDetector.js`; it lives there, not inline, because `index.js` spawns MediaMTX at import so
  no test can import it). A frame-diff camera with alerts on runs around the clock; an *activity-only*
  camera (alerts off, or MQTT/ONVIF motion, assigned to a child) runs only while `childSamplingActiveNow`
  (`lib/sleepAnalysis.js`) is open: `ONSET_LOOKBEHIND_MS` before the child's window to `WAKE_LOOKAHEAD_MS`
  (+ the 5-minute reconcile margin) after it, the inference's own span, so the morning departure is
  observed (#353). The lead and tail are absolute milliseconds, so a DST night gives 3 real hours.
- A watchdog (15s interval) tracks how long each camera's MediaMTX path has been "not ready"
  and force-restarts that camera's transcoder past a 30s threshold — a second, independent
  layer of defense beyond FFmpeg's own stream error handling.
- FFmpeg and MediaMTX processes both auto-restart on unexpected exit (`transcoder.js`,
  `mediamtxProcess.js`), and `transcoder.js` also watches for a specific known bad-camera
  symptom ("DTS discontinuity") and proactively restarts rather than let a session run poisoned.

When editing this area, preserve the "only write when actually broken" invariant — an
unconditional reconcile-on-every-tick would cause constant disconnects.

## Auth (`backend/src/middleware/auth.js`, `backend/src/routes/auth.js`)

JWT-based, but a valid JWT alone isn't sufficient — every request also checks a `sessions` row
in SQLite still exists (`backend/src/db.js`). This is what makes "sign out this device" and
"delete this caregiver" take effect immediately rather than waiting for token expiry. Two auth
middlewares exist: `requireAuth` (Bearer header) and `requireAuthQueryOrHeader` (also accepts
`?token=`, needed because Safari's native `<video>` fetches HLS segments itself with no way to
attach headers). Roles are `admin` / `caregiver`; `requireAdmin` gates account/settings management.
`cameras.js` and `children.js` gate the whole router with `router.use(requireAuth)`, which covers only
the routes registered *after* it: cameras.js's four media routes sit above that line on purpose, so
moving a route across it changes who can reach it.

**Every route's gate is pinned** by `backend/test/route-permissions.test.js` (issue #563). It enumerates
the real route table (index.js's registrations read from its source, and every mounted router's actual
`router.stack`), classifies each route as public / optional / media / signed-in / signed-in+admin, and
compares that with a hand-written table in both directions. It then checks over real HTTP that anonymous
callers get 401, an admin's media-scoped token gets 401 on every session route, and a caregiver gets 403
on every admin route. Adding a route, or adding, removing or reordering a `requireAuth`/`requireAdmin`,
fails that test until the table is edited on purpose, which puts every permission change in a diff a
reviewer reads. The split between the roles follows one rule (owner decision 2026-10-10, #538, #542,
#552): a caregiver can watch and act in the moment, but cannot destroy or reconfigure; every route a
caregiver can still reach says why on its line of the table. Role checks made *inside* a handler
(deleting another user's session, the admin-only fields of `GET /api/settings`, and `PUT
/api/children/:id`, where a caregiver may change a child's name, birthday, colour and photo but not
`track_sleep` or the sleep window) are not gates: their own test files cover them
(`children-role-fields.test.js` for the last).

**Stored secrets are never returned, and that is pinned too** (#563's second half),
by `backend/test/secrets-never-returned.test.js`. It finds every column whose *name* marks a credential
(password, secret, token, key, hash, backup code) by reading the schema, so a column added later is covered
without editing the test, and plants a marker in each one. It then asks **every GET route in the app** (the
same enumeration as above) as an anonymous visitor, a caregiver and an admin, and fails if any part of a
marker comes back. The routes that save an integration secret (MQTT, ntfy, Pushover, Gotify) are also
checked for "a blank field keeps the stored secret". The account routes (login, the second factor, MFA
enrolment, user management) are checked against a real account for a password hash, TOTP secret or
backup-code hash in their answers. Masked previews must be exactly `lib/secretMask.js`'s
shape: four characters and six dots, and a secret of eight characters or fewer is masked completely.
Credentials embedded in a URL column (a camera's RTSP or snapshot URL) are not found by a column name; the
camera-specific exposure tests cover those. The validation behind the settings, photo, snooze and MFA-enrolment
routes (documented ranges, `#RRGGBB` colours, known timezones, the 12-hour snooze cap, no second enrolment
while MFA is on) is pinned in `backend/test/input-validation.test.js`.

The JWT signing secret is auto-generated and persisted to `DATA_DIR/.jwt_secret` if
`JWT_SECRET` isn't set — deliberately avoiding a hardcoded fallback, since this image is
publicly distributed and a baked-in secret would be a shared key across every install.

## Data layer (`backend/src/db.js`)

better-sqlite3, single file in `DATA_DIR` (default `/app/data`). Schema is created with
`CREATE TABLE IF NOT EXISTS`, and columns added after initial release are migrated by hand at
the bottom of `db.js` (`PRAGMA table_info` + conditional `ALTER TABLE`) — there is no migration
framework. Follow this same pattern for new columns: check `table_info`, `ALTER TABLE` if
missing, keep it idempotent.

## Runtime identity (`backend/entrypoint.sh`, `Dockerfile`)

Container starts as root, remaps a pre-baked user to `PUID`/`PGID` (default 99/100, Unraid's
"nobody"/"users" convention) via `usermod`/`groupmod`, `chown`s the data dir, then execs the
app via `su-exec` — the app process itself never runs as root. `tini` is PID 1 to reap zombies
from the MediaMTX + per-camera-FFmpeg child process tree and forward signals correctly.

## Frontend structure (`frontend/src/`)

React + react-router, no Redux/state library — three context providers (`AuthContext`,
`SettingsContext`, `CamerasContext` in `lib/`) cover global state. `LiveMonitor.jsx` is the
main dashboard; `pages/` holds the four management screens (Children, Cameras, Account,
Settings). The Settings **hub itself is reachable by caregivers** — its route carries no admin
guard (`App.jsx`) — but it's role-aware internally: admin-only rows are hidden for a caregiver,
and every Settings *sub*-route (general, camera, recording, mqtt, push providers, users, logs,
clips) is individually `AdminProtected`. `lib/api.js` is a thin fetch wrapper that attaches the
JWT and redirects to `#/login` on a 401. Every request also carries a timeout (30 s by default, so a
stalled connection fails with a "took too long to respond" error instead of hanging); a call the server
is allowed to run long (camera probes and saves, recomputing a night, photo uploads, stopping a recording, diagnostics, the clip list and bulk delete) passes
`{ timeoutMs: SLOW_REQUEST_TIMEOUT_MS }` (90 s) as its last argument.

## CSP is enforced — keep it that way

`backend/src/index.js` serves an **enforcing** Content-Security-Policy via helmet (it was
deliberately disabled until 2026-08-24, when it was rolled out report-only across every feature
first, then switched to enforcing). The directives are tuned to this app and the reasoning is in
the inline comment above the policy — read it before changing anything there. Two things that
bite: hls.js needs `worker-src blob:` + `media-src blob:`, and WebRTC's STUN server is gated by
`connect-src`. Never add `unsafe-inline`/`unsafe-eval` to `script-src`; theming is safe because it
uses CSSOM `setProperty`, which CSP doesn't police. Violations are logged to the container log via
`POST /api/csp-report`, so check there if a new dependency breaks.
