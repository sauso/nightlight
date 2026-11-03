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

# The app answers /api/health before MediaMTX has bound anything (it is started asynchronously and is
# restarted if it dies), so a MediaMTX that never came up would leave only the app socket and sail
# through the allowlist below. Wait for its expected loopback sockets and the WebRTC media socket first
# (found in the review of PR #953). BusyBox netstat -lntu lists listening TCP and UDP sockets.
has_socket() { # has_socket <tcp|udp> <awk regex for the local address>
  printf '%s\n' "$sockets" | awk -v proto="$1" -v addr="$2" '$1 ~ ("^" proto) && $4 ~ addr { f=1 } END { exit !f }'
}
mediamtx_up=0
for ((i=0; i<60; i++)); do
  sockets=$(docker exec "$NAME" netstat -lntu) || die 'could not inspect listening sockets'
  missing=''
  for p in 8554 8888 8889 9997; do
    has_socket tcp "^127[.][0-9.]+:$p\$" || missing="$missing tcp:$p"
  done
  has_socket udp ':8189$' || missing="$missing udp:8189"
  if [ -z "$missing" ]; then mediamtx_up=1; break; fi
  sleep 1
done
[ "$mediamtx_up" -eq 1 ] || die "MediaMTX sockets never appeared (missing:$missing): the check would prove nothing"
ok 'MediaMTX is listening on its expected sockets'
parsed=$(printf '%s\n' "$sockets" | awk '$1 ~ /^(tcp|udp)/ { n++ } END { print n+0 }')
[ "$parsed" -gt 0 ] || die 'netstat returned no TCP or UDP sockets'

offenders=$(printf '%s\n' "$sockets" | awk -v app_port="$PORT" '
  $1 ~ /^(tcp|udp)/ {
    proto=$1; sub(/[0-9]+$/, "", proto)
    local_addr=$4
    port=local_addr; sub(/^.*:/, "", port)
    # Any loopback address (127/8 or ::1) is unreachable from another host; the planned hardening moves the
    # internal media listeners to 127.0.0.2, so do not hardcode 127.0.0.1 here. (No apostrophes in this
    # comment: it sits inside a single-quoted awk program.)
    if (local_addr ~ /^127[.]/ || local_addr ~ /^(\[::1\]|::1):/) next
    if (proto == "tcp" && port == app_port) next
    if (proto == "udp" && port == "8189") next
    print
  }
')
if [ -n "$offenders" ]; then
  printf 'Unexpected listening sockets:\n%s\n' "$offenders" >&2
  die 'image has an unexpected non-loopback listener'
fi
ok 'every listening socket is loopback-only or an expected app/media port'
