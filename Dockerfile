# Runtime Node tracks the 24 major again. It was previously pinned to 24.18.1 to dodge a hard
# abort: 24.19.0 added per-object environment cleanup hooks to node::ObjectWrap
# (nodejs/node#63642), and better-sqlite3 <= 11 subclassed ObjectWrap, so its wrapped objects
# registered a cleanup hook whose removal path asserted env != nullptr and abort()ed during our
# teardown ("RemoveEnvironmentCleanupHook: Assertion failed: (env) != nullptr"). better-sqlite3
# 13's ground-up N-API rewrite no longer touches node::ObjectWrap, which removes the trigger
# entirely — so the exact pin is no longer needed and the runtime follows node:24-alpine (patch/
# minor within the 24 major), matching how the MediaMTX base is pinned to its major. Verified on
# staging: clean graceful shutdown (exit 0, no abort assertion) on current 24.x with sqlite 13.
# KEEP better-sqlite3 >= 13 while on this tag; if it's ever downgraded below 13, re-pin Node to
# 24.18.1 or the abort at teardown returns.

# --- Stage 1: build the React frontend ---
FROM node:24.18.1-alpine AS frontend-build
WORKDIR /frontend
# npm ci against the committed lockfile, not npm install against version ranges -
# the image gets the exact dependency tree that was tested, instead of whatever
# each range happens to resolve to on the day the image is built.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Stage 2: source of the MediaMTX binary ---
# MediaMTX's official image is built FROM SCRATCH (no OS, no libc dependency at all),
# so its binary is fully static and safe to copy into any other base image as-is -
# this is MediaMTX's own documented pattern for building custom images on top of it.
# Pinning to the major version (not :latest) tracks patch/minor updates automatically
# without risking an unannounced breaking change from a future major version.
FROM bluenviron/mediamtx:1 AS mediamtx-binary

# --- Stage 3: install the backend's production dependencies ---
# Kept separate from the runtime so the compiler toolchain and npm/node-gyp caches this
# needs are thrown away with the stage instead of shipping in the final image (~300MB).
# python3/make/g++ are node-gyp's build toolchain: better-sqlite3 v13 actually ships a
# musl prebuilt binary (prebuilds/linuxmusl-*.node) and loads that, so no compile happens
# today - but keeping the toolchain here means the build still works unchanged if a future
# dependency (or a better-sqlite3 without a matching prebuild) does need to compile.
FROM node:24-alpine AS backend-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# --- Stage 4: combined runtime (app + MediaMTX + FFmpeg) ---
FROM node:24-alpine
WORKDIR /app

# ffmpeg: transcodes camera audio (many IP cameras use G711, which HLS can't carry).
# tini: proper PID 1 - reaps zombie child processes (MediaMTX + one FFmpeg process
#   per camera) and forwards signals correctly, which a plain `node` process won't do
#   on its own, especially with multiple levels of child processes involved.
# shadow: provides usermod/groupmod, used by entrypoint.sh to remap the app user's
#   UID/GID to match PUID/PGID at runtime (BusyBox's built-in tools can't do this).
# su-exec: tiny privilege-drop helper - entrypoint.sh execs into the real app through
#   this once it's finished its (root-only) setup, so the app itself never runs as root.
# tzdata: Alpine doesn't ship timezone data by default - without it, setting TZ has no
#   effect at all (both MediaMTX and Node silently fall back to UTC instead of erroring),
#   since there's no zone database for either to actually look up "Australia/Melbourne" in.
# setpriv (#553, media isolation): util-linux's setpriv, which the entrypoint starts the app with and
#   media-exec.sh starts every ffmpeg/ffprobe/MediaMTX with. BusyBox has a setpriv applet too, but it has no
#   --groups (#553 spike), so the package is required; the check below fails the build if the setpriv on PATH
#   is ever the applet again.
# NOTE: no python3/make/g++ here - the backend-deps stage already produced node_modules,
# and better-sqlite3's addon is a prebuilt binary that loads without any toolchain.
RUN apk add --no-cache ffmpeg tini shadow su-exec tzdata setpriv
RUN setpriv --version | grep -q util-linux

# Placeholder UID/GID - entrypoint.sh remaps this to PUID/PGID (default 99/100) on
# every container start, so the exact values baked in here don't matter, as long as
# they don't collide with anything already in the base image. (The official node:alpine
# images ship their own pre-existing "node" user/group at 1000/1000, which is what this avoided.)
RUN addgroup -g 1500 nightlight && adduser -D -u 1500 -G nightlight -h /app nightlight

# The media user (#553): ffmpeg, ffprobe and MediaMTX run as it when media isolation is on (media-exec.sh).
# FIXED ids, 1700:1700, never remapped: the container's own business, unlike PUID/PGID. Nothing on the host needs to
# know them; files the media user writes on the data volume show up there with these numbers. The entrypoint
# refuses isolation (and starts as before) if PUID or PGID is 1700. No password, no home, no login shell: nothing
# ever logs in as it.
# The app user is deliberately NOT made a member of nlmedia here. With isolation on, the entrypoint gives the app
# group 1700 explicitly (setpriv --groups=PGID,1700), so it can read and remove what the media processes write
# (media-exec.sh sets umask 007 for that). With it off, the usual su-exec start takes its groups from /etc/group, and
# a membership here would have given the app and every child group 1700 on every install (review of PR #869: CI showed
# `100 100 1700`), which "off changes nothing" must not do.
RUN addgroup -g 1700 nlmedia \
  && adduser -D -H -h /nonexistent -s /sbin/nologin -u 1700 -G nlmedia nlmedia

COPY --from=mediamtx-binary /mediamtx /usr/local/bin/mediamtx
RUN chmod +x /usr/local/bin/mediamtx

# Just the finished dependency tree from the build stage - no npm ci, no toolchain, no
# node-gyp/npm caches. package.json comes along so anything that reads the app version at
# runtime still can.
COPY --from=backend-deps /app/node_modules ./node_modules
COPY backend/package.json ./

# Drop the base image's bundled npm. npm is the package manager, not part of the running app
# (the container runs `node src/index.js`; entrypoint.sh only uses su-exec/node) - but the copy
# that ships in node:24-alpine drags in its own vulnerable transitive deps (tar/undici/
# brace-expansion/ip-address DoS + SSRF CVEs) that image scanners (Docker Scout/Trivy) flag on an
# otherwise-clean image. Removing it clears those findings and trims the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY backend/src ./src
COPY --from=frontend-build /frontend/dist ./public

# MediaMTX's config - lives in the image itself, not the data volume. See src/index.js
# for why: the app's own reconciliation re-establishes every camera path on every
# startup regardless, so MediaMTX doesn't need to persist anything here itself.
COPY mediamtx/mediamtx.yml ./mediamtx.yml

COPY backend/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
# #553: next to the entrypoint ON PURPOSE. The entrypoint finds both beside itself, and src/lib/childEnv.js finds
# media-exec.sh at ../../media-exec.sh from its own location, so the dry run and the app use this one file. Root-owned
# and 0755: the media user can run them and cannot change them. (The app user owns /app itself, its home, so it could
# replace them; an app that holds CAP_SETUID gains nothing by that. Root-owned code the app cannot replace is a later
# phase of #553.)
COPY backend/media-exec.sh backend/media-probe.sh ./
RUN chmod 755 ./media-exec.sh ./media-probe.sh

ENV DATA_DIR=/app/data
# Express behaves differently outside production mode - most importantly, its default
# error handler includes the full stack trace (leaking server file paths) in any 500
# response. This also enables Express's view/route caching.
ENV NODE_ENV=production

# Build provenance, passed by CI (see .github/workflows/docker-publish.yml). The running
# instance reports these on the About page so you can tell exactly which commit/branch it
# was built from - i.e. verify from the app whether staging/prod is on the code you expect,
# without relying on the (only-bumped-at-release) version number.
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_TIME=unknown
ENV NIGHTLIGHT_GIT_SHA=$GIT_SHA
ENV NIGHTLIGHT_GIT_REF=$GIT_REF
ENV NIGHTLIGHT_BUILD_TIME=$BUILD_TIME

VOLUME ["/app/data"]

# Docker (and Unraid's Docker tab) can now tell "container up" from "app not answering" (#567). It asks the
# app's own unauthenticated GET /api/health, with the BusyBox wget the base image already has, on the port the
# app really listens on (PORT, 4000 when unset or blank: the same rule as src/index.js).
# --start-period 120s: MediaMTX, the detectors and the camera reconcile start slowly, and failures inside the
#   period do not count against --retries, so a normal boot is never shown as unhealthy. 120s is a judgment, not
#   a measurement; a slower first boot only shows "starting", then healthy.
# ⚠️ This only LABELS the container. Plain Docker, compose and Unraid do not restart an unhealthy container
#   (only an orchestrator such as Swarm does); `restart: unless-stopped` still acts only on process exit.
#   Not tested: no CI job builds the image and runs this command (docs/operations.md, "Health check").
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-4000}/api/health" || exit 1

EXPOSE 4000
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
CMD ["node", "src/index.js"]
