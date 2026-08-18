# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nightlight — a self-hosted baby monitor web app. Views multiple RTSP cameras (grouped by
child) over the home network via low-latency WebRTC, installable as a PWA. Runs as a single
Docker container bundling three processes: the Node backend, MediaMTX, and
one FFmpeg process per camera.

Every user-visible change must be recorded under `[Unreleased]` in `CHANGELOG.md` in the
same commit (Keep a Changelog format, semver — see the changelog's own header for the
release procedure).

## Commands

There is no root-level build — `backend/` and `frontend/` are independent npm projects with
no test suite or linter configured in either.

```bash
# Backend (Node/Express, ESM, port 4000)
cd backend && npm install
npm start                    # node src/index.js — expects MediaMTX/ffmpeg binaries on PATH,
                              # so in practice this is normally run inside the Docker image
                              # rather than bare on a dev machine

# Frontend (React + Vite, port 5173, proxies /api to :4000)
cd frontend && npm install
npm run dev
npm run build                # outputs to frontend/dist, copied into the image as ./public

# Full stack, matching production
docker build -t nightlight .
docker run -d --name nightlight --network host -e PUID=99 -e PGID=100 \
  -v ./data:/app/data nightlight
docker logs -f nightlight
```

Because MediaMTX and FFmpeg are spawned as child processes of the backend (see
`backend/src/lib/mediamtxProcess.js` and `transcoder.js`), running `npm start` outside the
Docker image will fail unless both binaries are installed and on `PATH`. When iterating on
backend logic, prefer building and running the Docker image over running `npm start` bare.

## Architecture

**Everything ships as one Docker image, one container** — no multi-container orchestration to
reason about. The container needs its own routable LAN IP so WebRTC has no NAT/ICE problems
(MediaMTX advertises that IP to browsers). There are two supported ways to give it one: **host
networking** (the README quick-start default — the container shares the host's IP), or an
**ipvlan network with a dedicated IP**. The Unraid prod + staging deployments both use the latter
(both on `br0.10` — see Branching and deploy pipeline below); the host-networking path is what an
out-of-the-box `docker run` uses.

### The video pipeline (the core thing to understand before touching camera code)

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

### ONVIF, PTZ, and camera credentials (`backend/src/lib/onvif.js`, `rtspProbe.js`)

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
  doesn't cross VLANs (see `planning/onvif-and-two-way-audio-scope.md`).
- **PTZ** — `ptzNudge()` does start → hold `PTZ_NUDGE_MS` → stop in one call, so each press
  moves a fixed distance regardless of tap/network timing (`POST /api/cameras/:id/ptz/nudge`;
  the tile sends one per tap and repeats while held). ONVIF creds for control are the same
  single credential set stored with the camera; capability/creds/profile-token are captured
  at add time (`ptz_supported`, `onvif_*` columns) so control reconnects without re-querying.
- **`lib/rtspProbe.js`** — `validateRtspStream()` (ffprobe over TCP) runs on add/edit so a
  camera that can't be reached (bad creds/path/IP) isn't silently saved; the UI can override
  with `force` for a camera that's just momentarily offline.

### Self-healing / reconciliation (`backend/src/index.js`)

MediaMTX only learns about a camera when it's added/edited through the API, or via periodic
reconciliation. Three independent mechanisms keep the pipeline alive without manual restarts:
- `reconcileCameraPaths()` runs at startup and every 5 minutes: re-creates any MediaMTX path
  that's missing/misconfigured and restarts any camera whose transcoder isn't running. It only
  *writes* to MediaMTX when something is actually wrong, since every write forces a path reload
  that disconnects the current publisher.
- A watchdog (15s interval) tracks how long each camera's MediaMTX path has been "not ready"
  and force-restarts that camera's transcoder past a 30s threshold — a second, independent
  layer of defense beyond FFmpeg's own stream error handling.
- FFmpeg and MediaMTX processes both auto-restart on unexpected exit (`transcoder.js`,
  `mediamtxProcess.js`), and `transcoder.js` also watches for a specific known bad-camera
  symptom ("DTS discontinuity") and proactively restarts rather than let a session run poisoned.

When editing this area, preserve the "only write when actually broken" invariant — an
unconditional reconcile-on-every-tick would cause constant disconnects.

### Auth (`backend/src/middleware/auth.js`, `backend/src/routes/auth.js`)

JWT-based, but a valid JWT alone isn't sufficient — every request also checks a `sessions` row
in SQLite still exists (`backend/src/db.js`). This is what makes "sign out this device" and
"delete this caregiver" take effect immediately rather than waiting for token expiry. Two auth
middlewares exist: `requireAuth` (Bearer header) and `requireAuthQueryOrHeader` (also accepts
`?token=`, needed because Safari's native `<video>` fetches HLS segments itself with no way to
attach headers). Roles are `admin` / `caregiver`; `requireAdmin` gates account/settings management.

The JWT signing secret is auto-generated and persisted to `DATA_DIR/.jwt_secret` if
`JWT_SECRET` isn't set — deliberately avoiding a hardcoded fallback, since this image is
publicly distributed and a baked-in secret would be a shared key across every install.

### Data layer (`backend/src/db.js`)

better-sqlite3, single file in `DATA_DIR` (default `/app/data`). Schema is created with
`CREATE TABLE IF NOT EXISTS`, and columns added after initial release are migrated by hand at
the bottom of `db.js` (`PRAGMA table_info` + conditional `ALTER TABLE`) — there is no migration
framework. Follow this same pattern for new columns: check `table_info`, `ALTER TABLE` if
missing, keep it idempotent.

### Runtime identity (`backend/entrypoint.sh`, `Dockerfile`)

Container starts as root, remaps a pre-baked user to `PUID`/`PGID` (default 99/100, Unraid's
"nobody"/"users" convention) via `usermod`/`groupmod`, `chown`s the data dir, then execs the
app via `su-exec` — the app process itself never runs as root. `tini` is PID 1 to reap zombies
from the MediaMTX + per-camera-FFmpeg child process tree and forward signals correctly.

### Frontend structure (`frontend/src/`)

React + react-router, no Redux/state library — three context providers (`AuthContext`,
`SettingsContext`, `CamerasContext` in `lib/`) cover global state. `LiveMonitor.jsx` is the
main dashboard; `pages/` holds the four management screens (Children, Cameras, Account,
Settings — the latter is admin-only). `lib/api.js` is a thin fetch wrapper that attaches the
JWT and redirects to `#/login` on a 401.

### CSP is deliberately disabled

`helmet({ contentSecurityPolicy: false })` in `backend/src/index.js` — noted inline as
intentional, not an oversight, because the custom theming feature sets inline styles and WebRTC
needs to reach a STUN server, both of which need carefully tested CSP directives to allow
correctly. Don't silently "fix" this without doing that work.

### CI/CD

`.github/workflows/docker-publish.yml` builds and pushes a multi-arch (amd64/arm64) image to
Docker Hub (`sauso/nightlight`) — no test job exists in CI. Which tag it publishes depends on
the ref:
- push to **`dev`** → `:dev` (staging). Does NOT touch `:latest`.
- push to **`main`** or a **`v*` tag** → `:latest` (+ semver tags). This is production.

## Branching and deploy pipeline
See the workspace `CLAUDE.md` for the branch model. In short: work on `dev`, release to
`main` via PR. Two containers run on Unraid:

- **Production** — on the `br0.10` ipvlan network at `192.168.2.151` (its own routable LAN IP, so
  WebRTC works without host networking — MediaMTX advertises that IP), data dir
  `/mnt/user/appdata/nightlight`, container name `nightlight`, runs `sauso/nightlight:latest`.
  Updated only by a release to `main`. (Note: `192.168.1.100` is the **Unraid host** you SSH into
  for deploys/log-checks — not the prod container's own IP, which is `192.168.2.151`.)
- **Staging** — on the same `br0.10` ipvlan network at `192.168.2.150` (adjacent to prod's `.151`;
  its own LAN IP, same reason as prod), separate data dir (`/mnt/user/appdata/nightlight-dev`),
  container name `nightlight-dev`, runs `sauso/nightlight:dev`. Test dev builds here.

Deploys are **not** automated — after CI publishes an image, pull it and recreate the relevant
container on Unraid (prod pulls `:latest`, staging pulls `:dev`). A push/merge does NOT mean the
change is live. Verify via the Actions tab / Docker Hub tag, then the running container's
`org.opencontainers.image.revision` label.