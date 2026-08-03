#!/usr/bin/env bash
# Phase 1 prove-out: stand up the e2e stack and confirm a synthetic camera goes
# fully live end-to-end — real first-run admin creation, real camera add (with the
# app's own ffprobe validation), and playable HLS frames out the far end of the
# pipeline (transcoder -> Nightlight's MediaMTX -> HLS). No browser, no hardware.
#
# This is the gate the scope doc requires before any Playwright is written. It's
# also the seed of the CI job later (same compose, same checks).
#
#   ./prove.sh           # up -> prove -> down -v
#   ./prove.sh --keep    # leave the stack running afterwards (for poking at :4000)
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE=(docker compose -f docker-compose.e2e.yml -p nightlight-e2e)
BASE=http://localhost:${E2E_PORT:-4000}
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

cleanup() { [ "$KEEP" = "1" ] || "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }

# JSON field pluck without a jq dependency (fine for these known-shape responses).
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

say "Bringing up the e2e stack"
"${COMPOSE[@]}" up -d
ncexec() { "${COMPOSE[@]}" exec -T nightlight "$@"; }

say "Waiting for the app to answer"
for i in $(seq 1 60); do
  if curl -fsS "$BASE/api/auth/status" >/dev/null 2>&1; then ok "app up ($BASE)"; break; fi
  [ "$i" = 60 ] && die "app never answered on $BASE"
  sleep 2
done

say "First-run: create admin + log in"
SETUP=$(curl -fsS -X POST "$BASE/api/auth/setup" \
  -H 'Content-Type: application/json' \
  -d '{"username":"e2e","password":"e2e-admin-pw","first_name":"E2E"}')
TOKEN=$(printf '%s' "$SETUP" | field token)
[ -n "$TOKEN" ] || die "no token from /auth/setup — got: $SETUP"
ok "admin created, token acquired"

say "Warming the synthetic camera (triggers its on-demand source)"
for i in $(seq 1 20); do
  if ncexec ffprobe -v error -rtsp_transport tcp -i rtsp://fakecam:8554/test \
       -show_entries stream=codec_type -of csv=p=0 2>/dev/null | grep -q video; then
    ok "fakecam RTSP is live (video present)"; break
  fi
  [ "$i" = 20 ] && die "fakecam never produced a video stream"
  sleep 2
done

say "Add the synthetic camera through the real API (with validation)"
ADD=$(curl -fsS -X POST "$BASE/api/cameras" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"E2E Synthetic","rtsp_host":"fakecam","rtsp_port":"8554","rtsp_path":"/test"}')
CAM_PATH=$(printf '%s' "$ADD" | field mediamtx_path)
[ -n "$CAM_PATH" ] || die "camera add failed — got: $ADD"
ok "camera added, mediamtx path: $CAM_PATH"

say "Confirm playable frames out of the pipeline (HLS)"
HLS="$BASE/hls/$CAM_PATH/index.m3u8?token=$TOKEN"
for i in $(seq 1 30); do
  CODECS=$(ncexec ffprobe -v error -i "http://127.0.0.1:4000/hls/$CAM_PATH/index.m3u8?token=$TOKEN" \
             -show_entries stream=codec_type -of csv=p=0 2>/dev/null | tr '\n' ',' || true)
  if printf '%s' "$CODECS" | grep -q video; then
    ok "HLS serving live media (streams: ${CODECS%,})"
    say "PHASE 1 PROVE-OUT PASSED"
    exit 0
  fi
  [ "$i" = 30 ] && die "HLS never produced a video stream at $HLS"
  sleep 2
done
