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
| `TZ` | yes | yes | segment file names and log times use the container's zone (the app's own times follow Settings → General) |
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

**What the allowlist does not do:**

- **It is not a sandbox.** It narrows what a child *inherits*: what a bug that discloses the child's own
  memory or environment (in a demuxer, a crash report or log output) could expose, and what a command run by a
  MediaMTX hook inherits from MediaMTX. Taken alone it does not stop a child reading the backend's own
  environment through the process table (`/proc` on Linux), `JWT_SECRET` included, or the files on disk.
- **The separation that does is [media isolation](#media-isolation-the-layout-and-the-fence-553-phases-2b-and-4-on-by-default)**
  (#553), which is **on by default**: the children run as a second operating-system user (uid 1700, no
  capabilities), so a child a camera took over cannot read the database, `.jwt_secret` or the app's
  `/proc/<pid>/environ`. (An earlier version of this page said a separate user was considered and not done; the
  owner reversed that on 2026-10-25.) With isolation **off** (`NIGHTLIGHT_MEDIA_ISOLATION=0`, or a host where it
  cannot start) the children run as the backend's user and everything in the first bullet applies in full.
  The limits of isolation are listed at the end of that section.

Keep cameras on their own VLAN, as [docs/cameras.md](cameras.md) advises.

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
- A MediaMTX that stays alive but stops answering its API is restarted too, after 3 minutes of silence
  (`lib/mediamtxApiWatchdog.js`, #479: a probe every 30 s, a doubling backoff of 3, 6, 12, 24, then 30
  minutes, back to 3 after 5 minutes of answers; local MediaMTX only; Camera history gets one row per
  enabled camera, and the camera paths are reconciled as soon as the new MediaMTX is up).
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
  the start already running, nor merges different addresses: an edit with a new address gets a start of its
  own with that address. The narrow stale-row limit (#780) is at the end of this list.
- A stop (switching the camera off, deleting it, shutting down) reaches a start that is queued or part-way
  through: it launches nothing and finishes quietly, logging `start abandoned …` at INFO. The stop itself
  never waits in the queue, which keeps shutdown inside its 9 s bound; shutdown does wait for a stop that is
  already in progress, in parallel with the others. The other way round, a start waits for a stop of the same
  camera that is still in progress, for at most that stop's 3 s fallback: until the old process exits, or until
  SIGKILL is sent to one that ignored SIGTERM. After the SIGKILL the old process is gone within a moment, not
  instantly, so the new FFmpeg can start while it is still exiting; a process that survives SIGKILL (stuck in
  the kernel) is not waited for at all. Deliberately: waiting on, or giving up the start for, a process that
  cannot be killed would leave the camera down for good.
- While a start is queued or running, the camera counts as running for the reconcile pass, which therefore
  does not queue another one behind it.
- Known cost: a request now waits for every start ahead of it to finish. Each start is bounded (the old
  process's stop 3 s, the audio probe 9 s, the MediaMTX checks 5 s and 10 s: about 27 s at the very worst),
  so an edit with a new address that arrives while one other start of the same camera is running, with
  MediaMTX timing out throughout, can take about 70 s before it answers (its own checks included; worked out
  from those bounds, not measured), under Cloudflare's 100 s proxy limit. With more starts ahead of it (a
  watchdog's and the reconcile pass's at once) it can take longer than that.
- An edit with a new address first registers the MediaMTX path, then saves the camera row, then queues
  the transcoder start (#780). An ONVIF backchannel re-probe usually finishes in under 1 s, but a hanging
  camera can delay that restart by about 25 s. A failed path registration still answers 502 without saving,
  and a failed save, including a stale child assignment that answers 409, does not start the transcoder with
  the new address. Registering the MediaMTX path can still briefly interrupt its publisher. A camera disabled
  or deleted during the probe cannot be started by the edit after it resumes. If the transcoder start rejects,
  the route answers 500 after saving the whole edited row. It skips the subsequent sub-stream, detector and
  clip-ring steps and `subscribeAllCameraTopics`; a changed MQTT topic is not subscribed until the MQTT
  client reconnects. Reconcile and the watchdogs can restart the camera from the saved row because
  `isRunning` is false after a rejected start.
- During that probe, a second camera save can finish first (#787). The waiting save now preserves each
  column it did not change from the latest row; its own changed columns win, including a changed address
  or talk/ONVIF credentials. A sub-stream path entered against an unchanged main address follows a newer
  main address. Deletion during the probe or transcoder start answers 404. A request re-sending a column's
  old value cannot be distinguished from leaving it untouched, so it preserves a newer value in that column.
  Credential pairs can still be mixed across overlapping saves: when one save leaves a password blank,
  its talk or ONVIF username can come from one save and the password from the other because the merge is per column.
- Known limit (#780): the transcoder never reads the database. A watchdog or reconcile pass that fetched
  the old camera row before the edit's write can queue its stale-address start after the edit's start;
  it then runs last. The window is the other reader's own wait after fetching the row, not just the time
  between the edit's write and queue: the camera watchdog can await MediaMTX status for up to 5 s, and
  the audio watchdog can await that status plus a 6 s audio-flow probe. Reconcile reads all camera rows
  before looping, though its `isRunning` check usually prevents a duplicate start. This window remains
  open for several seconds in a stalled case (not measured). Fully closing it would require the transcoder
  to re-read the address when its queued start runs; that is outside this fix.

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

The JWT signing secret is auto-generated and persisted to `DATA_DIR/private/.jwt_secret` if
`JWT_SECRET` isn't set — deliberately avoiding a hardcoded fallback, since this image is
publicly distributed and a baked-in secret would be a shared key across every install. A secret that
cannot be saved is logged as an error (every restart would otherwise sign everyone out, silently).


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

better-sqlite3, WAL mode, `DATA_DIR/private/babymonitor.db` (default `/app/data/private/`; the top-level
`DATA_DIR/babymonitor.db` on an install the start-up move has not reached: see "Where the data lives" below). Schema is created with
`CREATE TABLE IF NOT EXISTS`, and columns added after initial release are migrated by hand at
the bottom of `db.js` (`PRAGMA table_info` + conditional `ALTER TABLE`) — there is no migration
framework. Follow this same pattern for new columns: check `table_info`, `ALTER TABLE` if
missing, keep it idempotent.

**`sleep_nights.scoring_context` records what produced a stored night** (#361, design in
`planning/361-scoring-context.md`). A stored night used to keep the answer (times, minutes, status) but not the
question, so any later re-score silently used today's camera and settings. Every store (`computeAndStoreNight`,
through `upsertNight`, in the same statement as the numbers, including the re-stores of a provisional night)
now writes a small JSON string: `v` (the JSON's own version, `1`), `camera_id` (the id of the camera the night
was scored from, `null` when none was enabled; never its name, address or credentials), `tz` (the app timezone
used, or `UTC` when none is set), `window` (`start`/`end` as `HH:MM`, the window actually used, so a malformed
saved time is stored as the `19:00` it scored with) and `algo` (`SCORING_ALGO` in `lib/sleepAnalysis.js`). It is
written for every status, `off` and `no_data` included. Its readers are the admin Recompute's stored-settings
option, the sleep detail page's `context=auto` and the morning review (all below); otherwise it is one more key, a string, on the
endpoints that return the raw stored row
(`GET /api/children/:id/sleep`, `GET /api/children/:id/sleep/:date?stored=1`, and `GET
/api/children/:id/sleep/live` when it serves last night's saved row). Nights stored before the column existed read `NULL` ("unknown provenance"): there is no automatic
backfill, and a legacy row stays `NULL` until it is next successfully re-stored (the nightly job, or a review
save, re-storing a provisional last night; or an admin Recompute). A final row is never re-stored by the nightly job, so its context, like its
numbers, stays as written. **`SCORING_ALGO` is bumped by hand**, in the same commit as any change to a threshold
or rule that changes what `computeNight` returns for the same inputs (not for refactors, and not the app
version). Known limit: nothing enforces the bump; the golden test in `backend/test/scoring-context.test.js`
fails when `computeNight`'s output for its one fixture night moves, which is a reminder, not a guarantee.

**`computeNight` can re-score a night with a stored context** (#361 step 2; tests in
`backend/test/scoring-context-replay.test.js`). `computeNight(childId, nightDate, { context })` takes a context, and
`parseScoringContext` makes one from a stored `scoring_context` (string or object): it returns `null`, and never
throws, for anything the writer could not have produced (a `v` other than `1`, a missing or extra key, a camera id
that is not a string or `null`, an empty or over-long `algo`, a timezone `Intl` refuses, a window part that is not
digits, a colon and digits; a stored `25:00` is accepted, because a night really was scored with it). With a context,
the timezone, the window and the scored camera come from it: the camera is looked up by id whichever child owns it
now and whether or not it is enabled; `camera_id: null` stays `no_data`; a camera that no longer exists is `no_data`
with `scoring.problem: 'camera_deleted'`, never a fallback to today's main camera. The result then gains `scoring:
{ source: 'stored', algo, current_algo, algo_differs, problem }`; without a context it is exactly what it was, with
no `scoring` key (golden test). `currentScoringContext(childId)` is the one definition of today's settings, and the
stored JSON is built from it, byte for byte what step 1 wrote. What a context does **not** replay: the rules (one
implementation runs, today's; `algo_differs` marks a night saved under other rules), tracking on/off (`off` still
comes first), room climate and the alert list (today's cameras), who owned the camera when (samples are read by
camera id and time, so a camera moved to another child inside the span a night reads, window start - 3 h to window
end + 3 h, replays with that child's activity), and the child's EARLIER stored nights. Since #700 (`SCORING_ALGO`
'2') the departure scan's lead test reads those live (`sleep_nights` rows with an earlier `night_date`, `ok` with a
wake, the newest 14; never the night's own row or a later one), so back-filling, recomputing or deleting an earlier
night can change a later night's replay while its samples, transitions and context are identical. Its finding is
the additive result key `wake_unconfirmed`, which is never stored.

**The admin Recompute is one caller** (#361 step 3; tests in `backend/test/recompute-stored-context.test.js`, the
dialog in `frontend/src/components/RecomputeNight.jsx`). `GET /api/children/:id/sleep/:date?context=stored` reads the
row's `scoring_context` and parses it (no row, `NULL` or unparseable: `400` with `reason: 'no_stored_context'`, never a
silent fall back to today's settings); `context=current` or no `context` is today's settings; `context=auto` is the
detail page's (next paragraph); any other value is a `400` before anything is computed. A read passes the context to `computeNight` and lays a correction over the
answer as usual, unless `raw=1`. With `store=1` (admin), `computeAndStoreNight(childId, date, { allowDowngrade: false,
context })` stores it, and `scoringContextFor` writes the replayed camera, timezone and window with the CURRENT
`SCORING_ALGO` (the numbers came from today's rules). Refusals, in order: `reviewed` (locked), `stored_camera_missing`
(a replay whose camera was deleted is never stored, whatever `allowDowngrade` says), `would_downgrade`,
`would_blank_notified_wake`; before any of them the route answers `409 context_changed` when `expect_context` is not the
row's current string (the dialog echoes what it was shown, so a re-save from another phone cannot be overwritten with
numbers nobody previewed). `?stored=1` adds `contexts` (`scoringContextChoice`: `stored_state`, both contexts, `differs`
on camera, timezone or effective window, live camera names). The detail page and the morning review (below) also pass
one; every other caller (the nightly job, the review's store-first, `/sleep/live`, the demo seed) passes none, so the
nightly job re-stores a provisional last night with today's settings: a stated limit, pinned by a test.

**The sleep detail page shows a finished night with its saved settings** (#361 step 4a; tests in
`backend/test/display-stored-context.test.js`, the page in `frontend/src/pages/SleepDetail.jsx`, its URL builder in
`frontend/src/lib/nightView.js`). `computeNightForDisplay(childId, nightDate, { includeTimeline, mode })` in
`lib/sleepAnalysis.js` is the one place that decides. In mode `'auto'` it replays the saved row's context iff the child
tracks sleep, a row exists, the WALL CLOCK has reached that row's own `window_end`, the night is not in progress
under today's window (`currentNightDate`: a window end moved later after the save keeps it live, as the card and
`/sleep/live` show it), the context parses and `scoringContextChoice(...).differs`; otherwise it is the plain
`computeNight`. It does not use the job's "final" test
(the row's own `computed_at` past the evidence horizon, #351) on purpose: a night locked by a correction before the
horizon, and a row whose later passes are refused (`would_downgrade`, the #361 case of a camera turned off after the
first pass), are never written again after the horizon, so that test would show them with today's settings for ever
while the card shows the saved row. Whenever the replay would apply, the answer gains `scoring_view: { applied, stored,
current, camera_names, algo_differs }` in mode `'auto'` (`applied: 'stored'`) AND in mode `'current'` (`applied:
'current'`); otherwise there is no new key. Route: `context=auto` (reads only; an admin `store=1` with it is a `400`, a
caregiver's `store=1` is a read and honours it) calls mode `'auto'`; `context=current` and no `context` call mode
`'current'`, so a page from before this change (which sends no `context`) is unchanged except for that added key;
`context=stored` is the forced replay above, without `scoring_view`. The page sends `context=auto`, keeps the person's
switch to today's (`'current'`) for that child and night only, and the Recompute dialog, when the page shows the saved
settings, reads its own today's baseline (`?context=current&raw=1`).

**The morning review uses the same settings as the detail page** (#361 step 4b; tests in
`backend/test/review-stored-context.test.js`). `displayContextFor(childId, nightDate)` in `lib/sleepAnalysis.js`
returns the detail page's decision (the same rules as `computeNightForDisplay`'s mode `'auto'`, no rule of its own)
as `{ context, key }`, or `null` for today's settings. `lib/sleepReviews.js` uses that one answer for everything
the review reads: `getNightReview`'s `computed` (a replay with the context), and `transitionsFor`, which is the
saved zone's noon to noon over the child's enabled cameras plus the saved camera ONLY while its `child_id` is still
this child (a camera moved to another child, or deleted, contributes nothing: its events are not this child's to
show or label). That one list is what the page shows, what a save's frame ids and verdicts are checked against, and
the card's count. The route passes the context to `reportableSpanMs(childId, date, context)`, so an echoed time is
trusted in the span it was computed in. `GET /review/:date` adds `settings: { key, tz }` (`key` the exact
`scoring_context` string when the saved settings are used, else `''`); a `PUT` carrying `settings_key` answers
`409 settings_changed`, before anything is written, when the key it would compute now differs, and one without it
(a page from before) is not checked. Typed times keep today's zone (`localHmToUtcSql`), the zone the page shows.
Not covered by the key: a night with no usable saved context, whose key is `''` before and after a settings change.

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

That is the start with [media isolation](#media-isolation-the-layout-and-the-fence-553-phases-2b-and-4-on-by-default)
OFF. Isolation is on by default, and then the entrypoint dry-runs the whole chain and, if it passes, starts the app
through `setpriv` instead of `su-exec`: still as `PUID:PGID`, but with `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL`
kept as ambient capabilities and `no-new-privileges`, so it can start every ffmpeg, ffprobe and MediaMTX as the
media user (uid:gid 1700:1700, no capabilities) and signal them. The app is still never root at start, but unlike the
`su-exec` start it **can become root** (or any uid) while it runs; see the limits at the end of the isolation
section. If the dry run fails the start is the `su-exec` one above, with one warning and `MEDIA_ISOLATION=off`;
the container never refuses to start because of it.

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

### Where the data lives: `DATA_DIR/private/` (#553 phase 2a)

The database (with `-wal`/`-shm`), `.jwt_secret`, the two Firebase files, the two snapshot folders and online
backups live in `DATA_DIR/private/`, always `0700` and owned by `PUID:PGID` (explicit chmod: the umask never decides
it). Why: media isolation (on by default) opens `DATA_DIR` to a media group so that FFmpeg can run as a separate user, and a folder only
the app can enter protects even a file inside it whose own mode is too open.

- **`lib/dataPaths.js` owns every one of these paths, and only RESOLVES** (lstat and a folder listing, never a
  write): the database is `private/babymonitor.db` if it exists, else the top-level one if THAT exists (an install the
  move has not reached; a second, empty database is never created next to real data), else `private/` for a fresh
  install. A secret file is looked up `private/` first; the Firebase files too, falling back to the top level where
  the admin drops them (re-resolved on every call in `lib/push.js`, so a dropped file works without a restart); a
  snapshot folder follows its database's place. `db.js`, `middleware/auth.js`, `lib/push.js`,
  `lib/detectionEvents.js`, `lib/bedTransitions.js`, `lib/demoSeed.js`, `lib/dataDirModes.js` and the console
  scripts (`src/scripts/consoleDb.js`: resolve, `fileMustExist`, never create) all go through it. The writers that
  can make `private/` (`db.js` on a fresh install, `auth.js` before a new secret, the move tool) use its one
  `ensurePrivateDir`.
- **The app never moves anything.** The one-way move is `src/scripts/migrate-private-layout.js`, which
  `entrypoint.sh` runs on every start in the FOREGROUND, as the app user (`su-exec`), after its ownership and mode
  steps and before either `exec` of the app (so nothing else has the database open). Independent passes, each
  deciding from lstat: the database (open with `fileMustExist`, `PRAGMA journal_mode=DELETE`, which fails while
  another connection holds it, then `BEGIN EXCLUSIVE` held until after the rename, then require that no
  `-wal`/`-shm`/`-journal` is beside it, set aside any companion already in `private/` with no private database (it
  would be replayed over the one moving in), then ONE rename of the `.db`; a 30 s budget applies before the rename
  only), `.jwt_secret` (only without `JWT_SECRET`), the Firebase files (only when their `FIREBASE_*` variable is
  unset), the snapshot folders (only once the database is in `private/`; an empty private one is removed first), and
  leftovers (`backup-*.db`, companions with no database). A symbolic link is never moved. `private/` always wins: a
  top-level copy is moved into `private/legacy-<date>-<time>/` as a unit (the `.db` first, then its companions and its
  snapshot folders into the same folder; an orphaned companion joins the newest such folder whose database lacks it),
  never deleted or merged. Exit codes 0 / 10 (something left at the top level) / 11 (something set aside) become one
  `[entrypoint] private layout:` line; no exit code stops the container. Two containers on one data directory are not
  supported.
- **The entrypoint's preflight** (guarded under `set -e`): creates `private/`, gives it to `PUID:PGID` only when it is
  not theirs, chmods it `700` every start, and re-owns by name the top-level items the move takes when one has the
  wrong owner (never the clip tree, #567; skipped when the full walk ran). The ownership sentinels and the modes line
  cover both layouts.
- **About and the diagnostics bundle** add `dataLayout` (as opened) and `layoutConflict` (any `private/legacy-*`, or
  two databases). Tests: `data-paths.test.js`, `migrate-private-layout.test.js` (real better-sqlite3, temp dirs),
  `console-scripts-layout.test.js`, `entrypoint-private-layout.test.js` (stubs, also on BusyBox) and
  `entrypoint-private-layout-real.test.js`; the real-image upgrade from the last release, the rollback and the
  two-copies case are `e2e/private-layout.sh` (the `private-layout` job in `e2e.yml`).

### Media isolation: the layout and the fence (#553 phases 2b and 4; on by default)

**State today.** Isolation is **asked for at every start** (since phase 4) unless `NIGHTLIGHT_MEDIA_ISOLATION` is `0`,
`off` or `false` (any capitals); it is read only by `entrypoint.sh`. Asking is not getting: the entrypoint, as root,
dry-runs the chain and, if anything fails (PUID 0, PUID/PGID 1700, a leftover at the top level, a missing capability, a
share that ignores `chmod`, rootless Docker), starts the old way with `MEDIA_ISOLATION=off` and one warning. When it
passes, ffmpeg, ffprobe and MediaMTX run as uid:gid 1700:1700 through `media-exec.sh`, and `MEDIA_ISOLATION=on`. The
statements elsewhere on this page that the children run as the same user describe the OFF state. Going from ON back to
OFF re-owns the media-written files once (#871). User-facing summary: [operations.md](operations.md#media-isolation).

**Roles of the capabilities with isolation on.** The app keeps `CAP_SETUID` and `CAP_SETGID` (to start each child as the
media user through `setpriv`) and `CAP_KILL` (to signal children that are now another uid), as ambient capabilities.
`CHOWN`, `DAC_OVERRIDE` and `FOWNER` stay root's, for the start-up script only. Every child gets none, and
`no-new-privileges` is set on the app and on every child; the bounding set is never trimmed (that needs `CAP_SETPCAP`,
which the six-capability hardening does not grant).

**What it does not stop (state these plainly wherever isolation is described):**

- **The app is not confined.** It holds `SETUID`/`SETGID`/`KILL`, so a compromised app can become uid 0 inside the
  container, and, if the data share is not mounted `nosuid`, create setuid files there. The target is the
  camera-facing programs, not the app.
- **One uid for all media processes.** A taken-over ffmpeg can signal or `ptrace` the others (MediaMTX, other
  cameras' ffmpeg); there is no per-camera separation.
- **MediaMTX's API on `127.0.0.1:9997` and its RTSP port `127.0.0.1:8554` have no password.** A taken-over media process
  can add, change or remove stream paths and read or publish a camera's stream. It cannot learn a camera's address or
  password from them: MediaMTX is never given one (every path is registered as publisher-only and FFmpeg pulls the
  camera itself; `backend/test/mediamtx-never-given-credentials.test.js` pins that, and it was read back from a real
  MediaMTX). A password on the API would not close this while the media programs share one user, because a process of
  that user can already signal or `ptrace` MediaMTX, and MediaMTX needs the check material in a file it can read.
- **Camera passwords are on ffmpeg's command line** (`/proc/<pid>/cmdline`), readable by anything in the container, and
  they are in that ffmpeg's memory. Whether another media process can read that memory depends on the host kernel: with
  Yama's `ptrace_scope` at 1 or higher (the default on many Linux distributions) it cannot (measured: `/proc/<pid>/mem`
  of a sibling answered `EACCES`), so only the command line leaks; on a kernel without Yama, such as Unraid's
  (`/proc/sys/kernel/yama/ptrace_scope` does not exist there), the kernel rules for processes of one user allow the read
  (not tried on that host). So moving the password off the command line (#883: FFmpeg can take its input from a list on
  stdin, tried) would not close the exposure on such a host, and is not done. The real fix would be a separate user for
  each camera's ffmpeg, a large change that is not planned.
- **Some hosts cannot do it** (rootless Docker/Podman, SMB/ACL shares that ignore `chmod`, NFS `root_squash`, PUID/PGID
  1700, missing capabilities) and run with isolation off and a warning.
- **The camera VLAN advice stands**: isolation limits what a bad stream can reach; it does not make an exposed camera safe.

**The rule:** a folder the app writes into is never one the media user can write into, and the media user can never rename
a folder the app trusts. `src/lib/mediaLayout.js` makes the folders (`ensureClipsFolder`, lazily, by the code that needs
them, each with an `fchmod`/`fchown` on a descriptor opened `O_NOFOLLOW|O_DIRECTORY`, because existing folders are `0700`):

| Kind | Where | Owner:group, mode |
| --- | --- | --- |
| traverse | `CLIPS_DIR`, `.ring`, `timelapse`, `.concat`, `.timelapse-frames` and the folders below the last two | app:media, `0750` |
| leaf (the only media-writable places) | `.ring/<camera>`, `<camera>`, `timelapse/<child>` | app:media, `1770` (sticky) |
| input files | concat lists, timelapse frames (`writeInputFile`, `O_EXCL`, group set on the descriptor before any content) | app:media, `0640` |
| app-only | `CLIPS_DIR/.app` (the writability probe), `private/` | app, `0700` |

No setgid bit anywhere (the Unraid kernel drops it without `CAP_FSETID`, measured; the share does not inherit a group
either): the media process has group 1700 as its primary group, so its files get it without inheritance, and the app sets
the group of everything it makes. The sticky bit stops the media user deleting or replacing the app's files in a leaf; a leaf is
app-owned so the app can always remove what is in it. Files that existed before stay app-owned `0600`.

**Every read, serve and delete of a media-written file goes through `src/lib/mediaFiles.js`.** It opens with
`O_NOFOLLOW|O_NONBLOCK`, `fstat`s the descriptor and requires a regular file with `nlink === 1` (hard-link defence:
`fs.protected_hardlinks` is 0 on the owner's host, measured), and checks that the real path of the file's parent is the
expected folder. `serveMediaFile` serves from that descriptor (Range, 206/416, 304, HEAD, ETag/Last-Modified as
`res.sendFile` did; the tests compare the two request by request), never reopening by path. `unlinkMediaFile` is a flat
`unlink`; `removeLeafDir` sweeps a leaf one name at a time and never recurses; `safeSegmentNames` accepts only
`seg-YYYYMMDD-HHMMSS.mkv`, because a segment list becomes a concat list read with `-safe 0` where a newline in a name
adds directives. `statMediaFile` is an `lstat`, so a link's target is never counted. `test/media-files-fence.test.js` reads the
source and fails if a `sendFile`/`download` or a path-based read, stat or delete appears in a file that handles the clips
folder without a `fence-ok`/`app-only` comment saying why.

**What the entrypoint adds (ON path only; the OFF path is the old one):** it refuses isolation while the database, a backup,
a snapshot folder, `.jwt_secret` (unless `JWT_SECRET`) or a Firebase file (unless named by its env var) is still at the
top level; sets the data directory to group 1700 / `0710` and the clips folder (and the folders above it inside the data
directory; only the top of an external mount, never a walk, #567) to `0750`, refusing a folder another uid owns; confines
the tighten walk to `private/` and the top-level files while isolation is asked for (and runs the full walk after all if
it ends off); and runs the dry run, folders included, in the BACKGROUND with a 30 s deadline (`BusyBox timeout` around
`$(...)` cannot stop a probe stuck on a stalled mount). `media-probe.sh` is the probe: it builds a probe folder with
every kind of folder above in each real mount and lets the media user try to misuse each.

Tests: `media-files.test.js`, `media-layout.test.js`, `media-files-fence.test.js`, `entrypoint-media-isolation.test.js`
(stubs, also on BusyBox), `entrypoint-media-isolation-real.test.js` (root, real `setpriv`, wrong layouts the probe must
refuse), the shell mutants in `scripts/entrypoint-umask.mutants.sh`, and `e2e/media-isolation.sh` (the image, as uid 1700).
Not covered: a real timelapse assembly (needs a child, a sleep window and a night of frames).

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
Settings → Recording, General and MQTT, the Gotify, ntfy and Pushover pages and the caregiver form therefore store what is different from the saved values in `sessionStorage`
(`lib/formDraft.js`, kept in step by `lib/useFormDraft.js`) and restore it on mount. Rules that must hold:
**no secret is ever written** (each form passes an allow-list of fields, credential-named keys are dropped
even if allowed, a value that is a URL with credentials in it is dropped whatever its key, and a camera
password is lost on reload by design); a draft is **per signed-in user**, expires
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
