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
"delete this caregiver" take effect immediately rather than waiting for token expiry. The same lookup
checks the session's age: a session lasts `SESSION_TTL_DAYS` (default 30, range 7-30) from sign-in,
judged by `sessions.created_at`, not by the token's `exp`, so lowering the setting ends older sessions at
their next request even though their tokens say 30 days (#562). One helper, `sessionAgeCondition` in
`middleware/auth.js`, supplies that condition to every place that asks: the request check (and so media
tokens and the talk socket's `verifyToken`), push recipients (`lib/push.js`), the WebRTC live-view sweep
(`isLiveSessionId`), the daily purge (`purgeExpiredSessions`) and the two session lists. Two auth
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
`track_sleep`, the sleep window or, since #655, the primary camera `primary_camera_id`) are not gates: their own test files cover them
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

## API errors (`backend/src/lib/asyncHandler.js`, `backend/src/middleware/errorHandler.js`)

Every API error is JSON in the same shape the routes already use, `{ "error": "<message>" }`, and a
request never goes unanswered. Express 4 ignores the promise an `async` handler returns, so **every
`async` route handler is wrapped in `asyncHandler(...)`**: a rejection (or a throw before the handler's
own `try/catch`) is passed to `next(err)` and ends at `errorHandler`, which is mounted **last** in
`index.js` (after every router and the SPA fallback; Express only delivers an error to handlers
registered after it). `backend/test/async-errors.test.js` walks every router's real stack and fails for an
`async` function registered without the wrapper, so a new route cannot bring the hang back. A handler
that returns a promise without being `async` is not seen by that guard; write route handlers as `async`
and wrap them.

The status follows one rule, because Cloudflare (and some other proxies) replace a 5xx body with their own
page and only a 4xx message reaches the person:

- **4xx: the request was wrong and the person can fix it; the message is readable.** Validate and answer
  a 4xx *before* any write (`PUT /api/cameras/:id` answers 400 `Child not found` for a deleted child,
  like `/assign`). The safety nets behind that: a SQLite foreign-key failure (typically a stale tab
  saving a reference to something another tab deleted) is a 409; an error that carries its own 4xx
  `status`/`statusCode` keeps it (malformed JSON is 400, an oversized body 413, a missing file from
  `res.sendFile` 404) and its message is shown only when the error is marked `expose: true` (the
  `http-errors` / body-parser / `send` convention), capped at 200 characters; otherwise a generic message
  for that status is used. Two exceptions: a **401** on a thrown error is never honoured (the web UI signs
  the user out on any 401, and a library error can carry its upstream's status), so 401 comes only from
  `middleware/auth.js`; and a **403** is honoured only when the error is `expose: true`, which is what
  `res.sendFile` throws for a denied dotfile or a `..` path (a bare `{ status: 403 }` from some other
  library stays a 500).
- **5xx: a server bug.** The response is `500` with a generic message. The real error (message and stack)
  is written to the log with the method and path (never the query string, which can hold a media token) and
  is never sent to the client, because a SQLite message names tables and columns and a stack names source
  files. Errors that already carry a 4xx status are the opposite: **not logged** at all, since anyone,
  signed in or not, can cause them (a malformed `%` escape in a URL, a missing file) and they would fill the
  1000-line in-app log with caller-chosen text.
- If the response has already started streaming when the error happens, Express's default handler closes
  the connection so the client sees a failure rather than a truncated body that looks complete. If the
  reply already finished, the error is only logged.

**Log lines are single lines (`lib/logger.js`, #539).** Every line passes one choke point, which first
redacts credentials and then escapes line breaks and control characters, so a camera name containing a
newline cannot forge a second timestamped line in `docker logs`, the in-app log viewer or the diagnostics
bundle. The escapes are visible text, not removals:

| Character | Written as |
|---|---|
| LF, CR | `\n`, `\r` |
| other C0 controls (including ESC), DEL, the C1 block | `\xNN` (for example ESC is `\x1b`) |
| U+2028, U+2029 (Unicode line / paragraph separators) | `\u2028`, `\u2029` |
| tab, and everything else | unchanged |

This also applies to the stack of a 5xx error and to multi-line child-process output: a stack is now one
log line with `\n` where the breaks were, so it reads on a single (long) line in the viewer. A literal
backslash is not doubled, so a typed `\n` looks the same as an escaped newline; that cannot forge a line.
There is no length cap in the logger (child-process lines are capped upstream).

**Example of "4xx before any write": the morning review's frame ids** (`PUT /api/children/:id/review/:date`,
#522). `true_onset_transition_id`, `true_wake_transition_id` and `true_in_bed_transition_id` each name one
recorded *got into / out of bed* event of that child and that night.

| Sent as | Means |
|---|---|
| key not sent | keep the stored frame (an older page never sends the newer keys) |
| `null` or `""` | no frame; clears a stored one (`""` has meant this since #571). Sent even without its time field, it also clears that moment's stored time (`true_wake_transition_id: null` alone clears the stored wake time; likewise onset and in bed) |
| a positive whole number up to 2^53 - 1, or a string of ASCII digits without a leading zero (`42`, `"42"`) | that event; it must be one of this night's, and the in-bed one a *got into bed* event |
| anything else (`true`, `[42]`, `"0x2a"`, `"42e0"`, `" 42 "`, `"42.0"`, `"042"`, `0`, `-1`, `1.5`, `{}`) | **400**, the key's usual message (`<key> is not an event of this night`, or `... is not a got-into-bed event of this night` for the in-bed one), before anything in the request is written, verdicts included |

One parser, `parseTransitionId` in `lib/sleepReviews.js`, reads the id for both the check and what is stored,
so the two cannot disagree (they did on `""` before #571). Before #522 the shapes in the last row that
`Number()` reads as a real id (`[42]`, `"0x2a"`, `" 42 "` and the like) were accepted and saved as that id.
Pinned by `backend/test/review-in-bed-and-lock.test.js`.

## Runtime identity (`backend/entrypoint.sh`, `Dockerfile`)

Container starts as root, remaps a pre-baked user to `PUID`/`PGID` (default 99/100, Unraid's
"nobody"/"users" convention) via `usermod`/`groupmod`, `chown`s the data dir, then execs the
app via `su-exec` — the app process itself never runs as root. `tini` is PID 1 to reap zombies
from the MediaMTX + per-camera-FFmpeg child process tree and forward signals correctly.

Before the `mkdir`/`chown` it sets the **umask** from `UMASK` (default `077`, validated, #549), so
the data dir, the database (SQLite gives `-wal`/`-shm` the database file's own mode), snapshots,
clips and everything FFmpeg/MediaMTX write are owner-only: a umask is inherited through `su-exec`
and every fork. Missing PARENTS of a non-default `DATA_DIR` are created under `022` (they are
root-owned and `chown` does not reach them, so `0700` would lock the app out). At `077` only, it
then strips group/other bits from existing entries
(`find "$DATA_DIR" ! -type l -perm /077 -exec chmod go-rwx {} +`, every start, never fatal; no
trailing slash, so it starts at the same root `chown -R` does and a symlinked `DATA_DIR` is left
alone, as `chown -R` leaves it) and logs one `[entrypoint] umask …` line with the count it found;
the app logs `[data-dir] app umask …` once it is up (`lib/dataDirModes.js`). User-facing rules and limits: `docs/operations.md`, "Who can read the
data directory". Tests: `entrypoint-umask.test.js` (Linux only) and
`scripts/entrypoint-umask.mutants.sh`, both run in CI.

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
first, then switched to enforcing). The policy, and every other option index.js passes to helmet,
is built by `backend/src/lib/cspDirectives.js` (#562): index.js cannot be imported by a test, so the
policy lives where `csp-directives.test.js` can serve it and read the header back. The directives
are tuned to this app and the reasoning is in the comment at the top of that file — read it before
changing anything there. Two things that bite: hls.js needs `worker-src blob:` + `media-src blob:`,
and WebRTC's STUN server is gated by `connect-src`. Never add `unsafe-inline`/`unsafe-eval` to
`script-src`; theming is safe because it uses CSSOM `setProperty`, which CSP doesn't police.
Violations are logged to the container log via `POST /api/csp-report` (at most 10 a minute), so
check there if a new dependency breaks.

**Cloudflare Web Analytics is opt-in** (#562). Until then `script-src` and `connect-src` allowed
Cloudflare's beacon origins on every install; now they are added only when the operator turns it on:

| `CLOUDFLARE_ANALYTICS` | Allows Cloudflare's Web Analytics beacon (`script-src https://static.cloudflareinsights.com`, `connect-src https://cloudflareinsights.com`). |
|---|---|
| Default | Off: blank or unset. The policy is the one above with neither origin. |
| On | `1`, `true`, `yes` or `on`, trimmed and in any case. The header is then exactly what every install served before #562, and one `[http]` line at start says so. |
| Off | Blank, `0`, `false`, `no`, `off`. |
| Anything else | Off, with one warning in the log at start (a typo fails closed: the beacon stays blocked). |

With it off, a site served through Cloudflare's proxy with Web Analytics on still has the beacon
`<script>` injected into every page by Cloudflare; the browser refuses it, and each refusal arrives
as a `[csp-report]` log line (at most 10 a minute). Either set the variable, or, if the analytics are not wanted, turn off
Web Analytics' automatic setup (the injection) for that site in the Cloudflare dashboard. Not checked
against a real Cloudflare-fronted install.
