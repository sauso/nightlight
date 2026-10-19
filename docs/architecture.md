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

## Child process environment (`backend/src/lib/childEnv.js`, #553)

Camera streams are untrusted input, and ffmpeg/ffprobe parse whatever a (possibly compromised) camera
sends. So **no child is handed the backend's environment**. Every ffmpeg, ffprobe and MediaMTX process is
started through `spawnChild()`, which builds the environment from an allowlist; `JWT_SECRET`,
`FIREBASE_CREDENTIALS`, `DATA_DIR`, `PUBLIC_HOST` and everything else the operator set are not passed to a
child. This narrows what a child *inherits*; it does not stop a child reading the backend's own environment
(see "What this does not do" below).

| Variable | ffmpeg / ffprobe | MediaMTX | Why |
|---|---|---|---|
| `PATH` | yes | yes | finds the binary and what it execs |
| `TZ` | yes | yes | segment and log times agree with the app |
| `LANG`, `LC_ALL` | yes | yes | locale only |
| `MTX_*` (operator's own) | **no** | yes | MediaMTX's documented override mechanism, e.g. `MTX_WEBRTCLOCALUDPADDRESS` |
| `MTX_WEBRTCADDITIONALHOSTS` | no | yes | computed by `mediamtxProcess.js` at every launch from `PUBLIC_HOST` and the detected host IPs; it replaces an inherited value whenever that list is non-empty |
| `MTX_WEBRTCLOCALUDPADDRESS` | no | yes | the operator's own value when they set one: it wins, and `WEBRTC_UDP_PORT` is then ignored with a warning; otherwise `:<port>` from a valid `WEBRTC_UDP_PORT`; otherwise unset, so MediaMTX keeps `:8189` from `mediamtx.yml` |
| `HOME`, `LIBVA_*`, `NVIDIA_*`, `HTTP(S)_PROXY`, `LD_LIBRARY_PATH`, `RTSP_*` | no | no | nothing in the app documents or sets them (ffmpeg runs with software decoding; cameras are reached directly on the LAN; `RTSP_*` is MediaMTX's legacy override prefix, which it still reads: use the `MTX_*` spelling) |

A name that is unset in the backend stays unset in the child. A caller-supplied `env` option is ignored.

**To add a variable:** add the name to `ALLOWED_NAMES` in `childEnv.js` with a comment saying which setup
needs it, add a row to the table above, and update `backend/test/child-env.test.js` (it pins the list on
purpose). For a per-launch computed value (MediaMTX's) pass it as `extra` instead. **To add a new spawn
site:** call `spawnChild()`, never `child_process` directly; the source test in `child-env.test.js` fails
on any other import of it under `backend/src`.

**What this does not do:**

- **It is not a sandbox.** The children still run as the same operating-system user as the backend, so a
  child that a camera managed to take over could still read the backend's own environment through the
  process table (`/proc` on Linux), `JWT_SECRET` included. The allowlist narrows what a child *inherits*:
  what a bug that discloses the child's own memory or environment (in a demuxer, a crash report or log
  output) could expose, and what a command run by a MediaMTX hook inherits from MediaMTX.
- **It does not protect the files.** For the same reason a child can read the database and `.jwt_secret`
  from disk. A separate user was considered and not done (#553 (b)).

Keep cameras on their own VLAN, as the README advises.

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

**One start at a time per camera (#478).** The reconcile pass, the camera watchdog, the audio watchdog
and the camera routes (add, an edit with a new address, enable, **Restart stream**, a failed delete putting
the camera back) all start a camera's transcoder through `startTranscoder` (`lib/transcoder.js`), and so
does the optional sub-stream, under its own key. Starts for one camera run one after another, each with its
own arguments: two that overlapped used to both launch FFmpeg and leave one running unseen (two publishers on
one path knock each other off it). Different cameras never wait for each other. What differs from the
neighbouring mechanisms:
- A request identical to one still **waiting** its turn (same address, path and name, no stop in between)
  shares it, so pressing **Restart stream** repeatedly queues one restart, not one per press. It never joins
  the start already running, nor merges different addresses: an edit with a new address always ends with
  that address running.
- A stop (switching the camera off, deleting it, shutting down) reaches a start that is queued or part-way
  through: it launches nothing and finishes quietly, logging `start abandoned …` at INFO. The stop itself
  never waits in the queue, which keeps shutdown inside its 9 s bound.
- While a start is queued or running, the camera counts as running for the reconcile pass, which therefore
  does not queue another one behind it.
- Known cost: a request now waits for every start ahead of it to finish. Each start is bounded (the old
  process's stop 3 s, the audio probe 9 s, the MediaMTX checks 5 s and 10 s: about 27 s at the very worst),
  so an edit with a new address that arrives while one other start of the same camera is running, with
  MediaMTX timing out throughout, can take about 70 s before it answers (its own checks included; worked out
  from those bounds, not measured), under Cloudflare's 100 s proxy limit. With more starts ahead of it (a
  watchdog's and the reconcile pass's at once) it can take longer than that.
- Known limit: the transcoder never reads the database. An edit with a new address starts the new address
  before it saves it, so a watchdog or reconcile start that read the old row in that window queues the old
  address behind the edit's start, and it runs last. This window predates #478 and the queue does not widen
  it.

When editing this area, preserve the "only write when actually broken" invariant — an
unconditional reconcile-on-every-tick would cause constant disconnects.

**Reading readiness without reconciling (`backend/src/lib/recordingReadiness.js`, #394).** The camera
settings page's read-only "Recording and alerts" panel asks `GET /api/cameras/:id/recording-readiness`
(admin only) whether the ring buffer, the detectors and the alert window are up *right now*. The route
only reads: it asks `clipCapture`, `motionDetector`, `onvifMotion`, `soundDetector` and `detectSchedule`
for their own answers and never starts, stops or reconciles anything, so it cannot cause the path
reloads the invariant above is about. It returns booleans and fixed words only. `alerting_now` is false
for a silenced camera, one outside its schedule, and a disabled one (which runs no detector);
`alert_pause_reason` is `null` while alerts fire, else `"silenced"`, `"schedule"` or `"disabled"`
(checked in that order of precedence: disabled, silenced, schedule), computed from the same instant as
`alerting_now`. It is an added field: `alerting_now` is unchanged in meaning for existing clients, and the
panel falls back to guessing the reason from the camera row only if the field is absent. Its one restated
condition, manual recording availability, mirrors `can_record` in `routes/cameras.js`, and
`recording-readiness.test.js` fails if the two disagree.

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

**Password hashing runs off the main loop (#548).** Every bcrypt hash and compare on a request path goes
through `lib/passwordHash.js`, which runs the same `bcryptjs` (cost 10, so existing hashes still verify)
in one persistent worker thread. bcryptjs's own async API does not help: it yields only after 100 ms of
work and a cost-10 compare takes about 82 ms, so `bcrypt.compare` blocked the event loop exactly as
`compareSync` did. Because a handler now yields mid-request, each place that reads a row, awaits, then
writes uses a compare-and-swap or re-checks after the await (login re-reads the whole row, so a reset
password or a just-enabled second factor decides; password change, backup codes; `/setup`;
`/me/mfa/enable`, whose write is bound to MFA still being off AND to the secret its code was checked
against). Every signed-in route that awaits bcrypt and then writes re-checks its own session first
(`signInEnded`: the middleware's `isLiveSessionId` rule) and answers 401 if it ended meanwhile; the two
admin routes that hash (`POST /users`, `PUT /users/:id`) also re-read the caller's live role
(`adminRightsEnded`) and answer 403 if they were demoted meanwhile, so an in-flight request cannot undo a
demotion (#261).
`/me/mfa/enable` also allows one request per user at a time, refused before any hashing, because each
one costs ten hashes in the shared worker. The worker module keeps each worker's pending jobs separately,
so a crashed worker rejects only its own jobs. The TOTP replay check (`users.mfa_last_step`, nullable) is
a single `UPDATE ... WHERE mfa_last_step IS NULL OR mfa_last_step < ?` whose row count is the verdict. The
per-user MFA limiter sits beside the per-source ones in `routes/auth.js` and is keyed on a *verified* MFA
token; the admin MFA reset also empties it. User-facing rules:
[mfa.md](mfa.md#replayed-codes-and-limits-on-guessing-550).
`/me/mfa/enable` (confirming a set-up) has limits of its own, counting wrong codes only (the handler marks a
wrong code in `res.locals.mfaWrongCode`, and the limiter's `requestWasSuccessful` reads it): an in-memory count
per user and pending secret (keyed by a sha256 prefix of the secret, never the secret) cancels the pending set-up
at the 10th wrong code, with no await between the count and the cancel (the count is dropped only after the
cancel's write succeeded); and `mfaEnableUserLimiter`, after `requireAuth` and keyed on the session's user,
allows 30 wrong codes per 15 minutes. The 10 bounds guesses per key, the 30 across keys (a set-up started again
gets a new key and a new 10). No per-source limiter is on that route. `resetMfaEnableLimit` empties both: both
password-change paths, removing the account and the admin MFA reset (through `resetMfaUserLimit`) call it. It
leaves the sign-in second step's per-user bucket alone, so a password change never gives out fresh second-step
guesses. User-facing rules: [mfa.md](mfa.md#confirming-a-set-up-has-limits-of-its-own).

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

A child's **colour** must be `#RRGGBB` and **birthday** a real `YYYY-MM-DD` date (blank still means default /
clear), and an avatar **photo** (child or user) must be a base64 `data:image/jpeg`, `png` or `webp` URL of at
most 90 KB (#555). The photo cap is 90 KB, not the 700 KB it once said, because `express.json()` refuses a body
over its 100 KB default first. For colour, birthday and photo, a value identical to the one stored is accepted
unchecked, so a record saved before the rule can still be edited
(`children-field-validation.test.js`, `input-validation.test.js`).

The JWT signing secret is auto-generated and persisted to `DATA_DIR/.jwt_secret` if
`JWT_SECRET` isn't set — deliberately avoiding a hardcoded fallback, since this image is
publicly distributed and a baked-in secret would be a shared key across every install.


**Client startup (#382).** The SPA decides "signed in" from `/auth/me` and "which form" from `/auth/status`.
Only a **401** from `/auth/me` means signed out. A network failure, a timeout or a 5xx (or a proxy's 502 while
the backend restarts) leaves the stored token alone and shows `ServerUnreachable` ("Can't reach Nightlight")
instead, retried by `lib/useAutoRetry.js` (5 s, 10 s, 20 s, then every 30 s) and by a **Try again** button. A
failed `/auth/status` does the same on the sign-in screen: it no longer guesses "established install" and shows
the sign-in form. The demo's tokenless path and the native app's (same web code, same stored token) are unchanged.
Once someone is signed in, a failed `refresh()` (Account and UserSettings call it after a save) sets the same flag
but keeps the user, so the app stays on screen: `Shell` shows `ServerUnreachable` only while nobody is signed in.
**Sign out** and a 401 on any request clear the flag and cancel the pending retry, and a failed `/auth/me` that
lands after the sign-in has ended (no stored token any more) is ignored, so neither leaves a signed-out device on
"Can't reach Nightlight". On the sign-in screen, once a status check has started the demo's guest sign-in no later
check runs, so a retry timer that comes due in the same moment cannot open a second guest session.

## Data layer (`backend/src/db.js`)

better-sqlite3, single file in `DATA_DIR` (default `/app/data`). Schema is created with
`CREATE TABLE IF NOT EXISTS`, and columns added after initial release are migrated by hand at
the bottom of `db.js` (`PRAGMA table_info` + conditional `ALTER TABLE`) — there is no migration
framework. Follow this same pattern for new columns: check `table_info`, `ALTER TABLE` if
missing, keep it idempotent.

**Deleting a child or a camera is `lib/entityPurge.js`** (#540, #554), and it deletes everything that belongs to
it. Most of the history tables have **no foreign key** to `children` / `cameras` (deliberately: `bed_transitions`,
`activity_samples`, `detection_events`, `camera_events`, `sensor_readings`, `sleep_nights`, `sleep_reviews`), so
the database will not cascade for you. **A new table or column that names a child or camera (`child_id`,
`camera_id`) must be added to `entityPurge.js`**, or `backend/test/entity-purge.test.js` fails: it finds every such
column with `PRAGMA`, fills a row and real files in each, deletes over HTTP and checks nothing is left. The order is
the contract: per file-bearing row, file first and then the row (autocommit, not one transaction, because a rollback
would restore rows whose files were already unlinked); rows with no file go in one transaction, the entity's own row
last, so a failed delete leaves the entity in place to retry. Every stored path is resolved against its real parent
directory and skipped unless it is a regular file inside `CLIPS_DIR`. The whole-folder sweeps (`<cameraId>/`,
`.ring/<cameraId>/`, `timelapse/<childId>/`, `.timelapse-frames/<childId>/`) run only for a UUID-shaped id (the
only kind the app mints; an id like `timelapse` would otherwise name a shared folder), and refuse the whole delete,
before anything is removed, if a parent folder resolves outside the real `CLIPS_DIR` (the camera route runs this
check, `preflightCameraPurge`, before it stops the camera; a purge that still fails part-way restarts it at once). A failed delete answers
**409** with the reason (never 5xx: Cloudflare strips 5xx bodies), and so does a delete while one of the cameras
is recording on demand. A writer that finishes after the delete (a bed-transition frame, an alert photo or clip,
a recording or wake clip) checks that its `UPDATE` still found the row, and deletes the file it wrote if not.

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
  `middleware/auth.js` and the pre-sign-in `/login` steps; and a **403** is honoured only when the error is
  `expose: true`, which is what `res.sendFile` throws for a denied dotfile or a `..` path (a bare
  `{ status: 403 }` from some other library stays a 500). For the reason behind the first exception, a wrong
  *confirmation* password on a signed-in route (`PUT /auth/me/password`, `POST /auth/me/mfa/disable`) answers
  **400**, never 401: the sign-in is still valid, only the typed password is wrong (#697).
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
| tab, zero-width and other format characters (U+200B, U+FEFF, the soft hyphen, the bidirectional controls), and everything else | unchanged |

This also applies to the stack of a 5xx error and to multi-line child-process output: a stack is now one
log line with `\n` where the breaks were, so it reads on a single (long) line in the viewer. A literal
backslash is not doubled, so a typed `\n` looks the same as an escaped newline; that cannot forge a line.
There is no length cap in the logger (child-process lines are capped upstream).

The diagnostics bundle's name replacement (`lib/identityRedaction.js`) reads these escaped lines, so it knows
the escapes without restating them: it calls the logger's own `neutraliseControlChars` on every UTF-16 code
unit once, searches for each name's escaped spelling as well as the name as typed, and treats an escape as a
word boundary. A name that contains a line break (`Name\nTwo`) or follows one (a multi-line error, a stack) is
therefore still replaced and still caught by the bundle's privacy check, and a change to the escaping here
needs no edit there (#539, found in review).

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

`PUID=0` is accepted but logs a warning (`[entrypoint] warning: PUID=0 runs the app as root`) and starts anyway;
refusing it, or substituting the default, is not done (#555, `entrypoint-puid-root.test.js`).

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

**What is in the first download, and what is fetched later (#386).** The entry chunk used to carry every
screen plus hls.js (about 560 kB of its 1,098 kB). Screens are now split by route with `lazyPage()`
(`lib/lazyPage.jsx`), and hls.js is imported only when `HlsPlayer` actually needs it:

| | Loaded with the first page | Fetched on first use |
|---|---|---|
| Screens | Sign-in, the live monitor, the nav bar, the Children, Cameras, Settings hub and Account roots, "Page not found" | Child detail, sleep detail, night review, child settings, camera settings, detection settings, every Settings sub-page, clips, About |
| hls.js | Never | Only by a camera in **Compatibility (HLS)** mode on a browser without native HLS. The default WebRTC view and Safari/iOS (native HLS) never download it |

While a screen's chunk loads, its slot shows "Loading…" with the nav bar and live monitor still on screen. If the
fetch fails (the phone is offline), the slot shows "Couldn't load this screen" with a **Reload** button that
reloads the page; it does not blank the page. It reloads rather than importing again because a browser remembers a
module URL that failed once for the life of the page, so a second import replays the first failure. Only
chunk-fetch failures (recognised by the browsers' "failed to fetch dynamically imported module" messages) are caught
there: a screen whose code loads but throws when it starts, and any other render error
still reach the app-level crash page. A Compatibility (HLS) tile whose hls.js fetch fails shows the same kind of
message with a **Reload** button and stops retrying on its own, for the same reason. If the chunk is an old one that
a new deploy has replaced, the reload is what fixes it too (the app also reloads itself after being backgrounded for
15 s).

**Unsaved form edits survive the background reload (#377).** `App.jsx` reloads the page after 15 s in the
background to repair stale media connections, and that empties React state. The child form, the camera form
and Settings → Recording therefore store what is different from the saved values in `sessionStorage`
(`lib/formDraft.js`, kept in step by `lib/useFormDraft.js`) and restore it on mount. Rules that must hold:
**no secret is ever written** (each form passes an allow-list of fields, credential-named keys are dropped
even if allowed, and a camera password is lost on reload by design); a draft is **per signed-in user**, expires
after 6 hours, and is removed by a successful save, an explicit discard, removing the thing, and sign-out
(an expired sign-in keeps it, so signing back in resumes). "Unsaved" is always derived (form versus last
saved), never a flag set by `onChange`. Forms with an explicit Save show `components/UnsavedNotice.jsx`.
The forms not yet covered are listed in `docs/design-language.md` (§6, Forms with a Save button).

## CSP is enforced — keep it that way

`backend/src/index.js` serves an **enforcing** Content-Security-Policy via helmet (it was
deliberately disabled until 2026-08-24, when it was rolled out report-only across every feature
first, then switched to enforcing). The policy, and every other option index.js passes to helmet,
is built by `backend/src/lib/cspDirectives.js` (#562): index.js cannot be imported by a test, so the
policy lives where `csp-directives.test.js` can serve it and read the header back. The directives
are tuned to this app and the reasoning is in the comment at the top of that file — read it before
changing anything there. Two things that bite: hls.js needs `worker-src blob:` + `media-src blob:`,
and WebRTC's STUN servers are gated by `connect-src`, one entry per server in the `STUN_SERVERS` setting
(`lib/stunServers.js`, #558: the same parse also feeds MediaMTX's config and `GET /api/about` for the browser). Never add `unsafe-inline`/`unsafe-eval` to
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
