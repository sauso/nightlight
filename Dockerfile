# --- Stage 1: build the React frontend ---
FROM node:24-alpine AS frontend-build
WORKDIR /frontend
COPY frontend/package.json ./
RUN npm install
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

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/src ./src
COPY --from=frontend-build /frontend/dist ./public

# MediaMTX's config - lives in the image itself, not the data volume. See src/index.js
# for why: the app's own reconciliation re-establishes every camera path on every
# startup regardless, so MediaMTX doesn't need to persist anything here itself.
COPY mediamtx/mediamtx.yml ./mediamtx.yml

COPY backend/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 4000
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
CMD ["node", "src/index.js"]
