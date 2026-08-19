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

# --- Stage 3: combined runtime (app + MediaMTX + FFmpeg) ---
FROM node:24-alpine
WORKDIR /app

# python3/make/g++: needed to compile better-sqlite3's native addon.
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
RUN apk add --no-cache python3 make g++ ffmpeg tini shadow su-exec tzdata

# Placeholder UID/GID - entrypoint.sh remaps this to PUID/PGID (default 99/100) on
# every container start, so the exact values baked in here don't matter, as long as
# they don't collide with anything already in the base image. (The official node:alpine
# images ship their own pre-existing "node" user/group at 1000/1000, which is what this avoided.)
RUN addgroup -g 1500 nightlight && adduser -D -u 1500 -G nightlight -h /app nightlight

COPY --from=mediamtx-binary /mediamtx /usr/local/bin/mediamtx
RUN chmod +x /usr/local/bin/mediamtx

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Drop the base image's bundled npm once install is done. npm is the package manager, not part of
# the running app (the container runs `node src/index.js`; entrypoint.sh only uses su-exec/node) —
# but the copy that ships in node:24-alpine drags in its own vulnerable transitive deps
# (tar/undici/brace-expansion/ip-address DoS + SSRF CVEs) that image scanners (Docker Scout/Trivy)
# flag on an otherwise-clean image. Removing it here clears those findings and trims the attack
# surface. better-sqlite3's native addon is already compiled by this point and loads at runtime
# without npm. NOTE: this must stay AFTER the last `npm ci`; if a later step ever needs npm, move it.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY backend/src ./src
COPY --from=frontend-build /frontend/dist ./public

# MediaMTX's config - lives in the image itself, not the data volume. See src/index.js
# for why: the app's own reconciliation re-establishes every camera path on every
# startup regardless, so MediaMTX doesn't need to persist anything here itself.
COPY mediamtx/mediamtx.yml ./mediamtx.yml

COPY backend/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

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

EXPOSE 4000
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
CMD ["node", "src/index.js"]
