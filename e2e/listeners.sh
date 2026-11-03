#!/usr/bin/env bash
# #952: check the real image's listening sockets, including MediaMTX defaults that
# are not written in mediamtx.yml. Build the image first: docker build -t sauso/nightlight:dev .
# Run: bash e2e/listeners.sh [check|teardown]. Uses its own container, volume and host port.
set -euo pipefail

IMAGE=${NIGHTLIGHT_IMAGE:-sauso/nightlight:dev}
PORT=${E2E_LISTENERS_APP_PORT:-4000}
HOST_PORT=${E2E_LISTENERS_HOST_PORT:-4400}
NAME=nightlight-listeners-app
VOLUME=nightlight-listeners-data
LABEL=nightlight.e2e.project=nightlight-listeners

ok()  { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
die() { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; exit 1; }

teardown() {
  local -a ids=()
  mapfile -t ids < <(docker ps -aq --filter "label=$LABEL" 2>/dev/null || true)
  [ ${#ids[@]} -eq 0 ] || docker rm -f "${ids[@]}" >/dev/null 2>&1 || true
  mapfile -t ids < <(docker volume ls -q --filter "label=$LABEL" 2>/dev/null || true)
  [ ${#ids[@]} -eq 0 ] || docker volume rm -f "${ids[@]}" >/dev/null 2>&1 || true
}

case "${1:-check}" in
  teardown) teardown; exit 0 ;;
  check) ;;
  *) die 'usage: bash e2e/listeners.sh [check|teardown]' ;;
esac

teardown
trap teardown EXIT
docker volume create --label "$LABEL" "$VOLUME" >/dev/null
# mDNS is an optional app discovery socket; disable it to isolate MediaMTX listeners.
docker run -d --name "$NAME" --label "$LABEL" \
  -p "127.0.0.1:$HOST_PORT:$PORT" -e "PORT=$PORT" -e MDNS_ANNOUNCE=false \
  -v "$VOLUME:/app/data" "$IMAGE" >/dev/null

ready=0
for ((i=0; i<120; i++)); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$HOST_PORT/api/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" != true ]; then
    docker logs "$NAME" >&2 || true
    die 'container exited before the app was ready'
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || { docker logs "$NAME" >&2 || true; die 'app did not become ready'; }
ok 'app is ready'

# BusyBox netstat -lntu reports listening TCP and UDP sockets from inside the image.
sockets=$(docker exec "$NAME" netstat -lntu) || die 'could not inspect listening sockets'
parsed=$(printf '%s\n' "$sockets" | awk '$1 ~ /^(tcp|udp)/ { n++ } END { print n+0 }')
[ "$parsed" -gt 0 ] || die 'netstat returned no TCP or UDP sockets'

offenders=$(printf '%s\n' "$sockets" | awk -v app_port="$PORT" '
  $1 ~ /^(tcp|udp)/ {
    proto=$1; sub(/[0-9]+$/, "", proto)
    local_addr=$4
    port=local_addr; sub(/^.*:/, "", port)
    if (local_addr ~ /^127[.]0[.]0[.]1:/) next
    if (proto == "tcp" && port == app_port) next
    if (proto == "udp" && port == "8189") next
    # TODO (#952): UDP 8000/8001 are KNOWN RTSP RTP/RTCP media sockets;
    # tolerate them until the follow-up hardening closes them.
    if (proto == "udp" && (port == "8000" || port == "8001")) next
    print
  }
')
if [ -n "$offenders" ]; then
  printf 'Unexpected listening sockets:\n%s\n' "$offenders" >&2
  die 'image has an unexpected non-loopback listener'
fi
ok 'every listening socket is loopback-only or an expected app/media port'
