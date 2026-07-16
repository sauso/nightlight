# --- Stage 1: build the React frontend ---
FROM node:20-alpine AS frontend-build
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
FROM node:20-alpine
WORKDIR /app

# python3/make/g++: needed to compile better-sqlite3's native addon.
# ffmpeg: transcodes camera audio (many IP cameras use G711, which HLS can't carry).
# tini: proper PID 1 - reaps zombie child processes (MediaMTX + one FFmpeg process
#   per camera) and forwards signals correctly, which a plain `node` process won't do
#   on its own, especially with multiple levels of child processes involved.
RUN apk add --no-cache python3 make g++ ffmpeg tini

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

ENV DATA_DIR=/app/data
VOLUME ["/app/data"]

EXPOSE 4000
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/index.js"]
