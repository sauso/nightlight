#!/usr/bin/env bash
# #952: check the real image's listening sockets, including MediaMTX defaults that
# are not written in mediamtx.yml. Build the image first: docker build -t sauso/nightlight:dev .
# Run: bash e2e/listeners.sh [check|loopback-control|teardown]. Uses its own container, volume and host port.
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
  loopback-control) ;;
  *) die 'usage: bash e2e/listeners.sh [check|loopback-control|teardown]' ;;
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
ok 'the Tailscale-off listener allowlist holds'

# #971: setup and sign-in use the real API. The daemon reports running at spawn,
# about 300 ms before its sockets exist (measured 2026-11-03), so wait for an
# owned UDP socket rather than trusting the supervisor state alone.
BASE="http://127.0.0.1:$HOST_PORT"
ADMIN_USER=e2e-listeners
ADMIN_PASSWORD=e2e-listeners-password
setup=$(curl -fsS -m 15 -X POST "$BASE/api/auth/setup" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\",\"first_name\":\"E2E\"}") || die 'first admin setup failed'
setup_token=$(printf '%s' "$setup" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).token||""))')
[ -n "$setup_token" ] || die 'setup did not return a token'
login=$(curl -fsS -m 15 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASSWORD\"}") || die 'admin sign-in failed'
token=$(printf '%s' "$login" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>process.stdout.write(JSON.parse(s).token||""))')
[ -n "$token" ] || die 'sign-in did not return a token'
auth=(-H "Authorization: Bearer $token")
about=$(curl -fsS -m 15 "$BASE/api/about" "${auth[@]}") || die 'could not read media isolation state'
printf '%s' "$about" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{if(JSON.parse(s).mediaIsolation!=="on")process.exit(1)})' \
  || die 'media isolation must be on before the capability proof'
ok 'media isolation is on'
curl -fsS -m 20 -X PUT "$BASE/api/remote-access/tailscale" "${auth[@]}" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null || die 'Tailscale enable failed'

app_uid=$(docker exec "$NAME" id -u nightlight)
app_gid=$(docker exec "$NAME" id -g nightlight)
[ -n "$app_uid" ] && [ -n "$app_gid" ] || die 'could not read remapped app IDs'
tail_pid=''
tail_udp=''
for ((i=0; i<60; i++)); do
  tail_pid=$(docker exec "$NAME" pidof tailscaled 2>/dev/null | awk '{print $1}') || true
  if [ -n "$tail_pid" ]; then
    # BusyBox netstat -p reveals PID/program only to the same uid. Reading it as
    # the app user prevents an unrelated wildcard UDP socket being credited to tailscaled.
    owned=$(docker exec -u "$app_uid:$app_gid" "$NAME" netstat -lntup) || die 'same-uid netstat failed'
    tail_udp=$(printf '%s\n' "$owned" | awk -v pid="$tail_pid" '$1 ~ /^udp/ && $NF == pid "/tailscaled" { print $4 }')
    [ -n "$tail_udp" ] && break
  fi
  sleep 1
done
[ -n "$tail_udp" ] || die 'tailscaled never owned a UDP listener'
printf '%s\n' "$owned" | awk -v pid="$tail_pid" '$1 ~ /^tcp/ && $NF == pid "/tailscaled" {bad=1} END {exit bad}' \
  || die 'tailscaled opened a TCP listener'
ok 'tailscaled owns UDP and no TCP listener'

# The real launch path must pass through app-exec.sh: under isolation the app
# holds ambient capabilities and group 1700, but tailscaled must hold neither.
proc_status=$(docker exec "$NAME" cat "/proc/$tail_pid/status") || die 'could not read tailscaled status'
printf '%s\n' "$proc_status" | awk -v uid="$app_uid" -v gid="$app_gid" '
  /^Uid:/ { if ($2 != uid || $3 != uid || $4 != uid || $5 != uid) bad=1; seen_uid=1 }
  # Opus review of #972 (verified on crafted status files): Groups: alone let a primary gid of 1700 or 0 through.
  /^Gid:/ { if ($2 != gid || $3 != gid || $4 != gid || $5 != gid) bad=1; seen_gid=1 }
  /^Groups:/ { found=0; for (i=2;i<=NF;i++) { if ($i == gid) found=1; if ($i == 1700) bad=1 } if (!found) bad=1; seen_groups=1 }
  /^Cap(Inh|Prm|Eff|Amb):/ { if ($2 !~ /^0+$/) bad=1; caps++ }
  /^NoNewPrivs:/ { if ($2 != 1) bad=1; seen_nnp=1 }
  END { if (bad || !seen_uid || !seen_gid || !seen_groups || caps != 4 || !seen_nnp) exit 1 }
' || die 'tailscaled did not have the app uid, app group, zero capabilities and no-new-privs'
ok 'tailscaled privilege boundary holds'

view=$(curl -fsS -m 15 "$BASE/api/remote-access/tailscale" "${auth[@]}") || die 'Tailscale status failed'
printf '%s' "$view" | node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const x=JSON.parse(s);if(x.blocker!==null||x.host_network?.host!==false)process.exit(1)})' \
  || die 'tailscaled sockets triggered the host-network blocker'
ok 'the network check still reports a private namespace'

# The daemon can add its second IPv6/IPv4 socket after the first one satisfied
# the readiness wait. Refresh the owned set before comparing the final snapshot.
owned=$(docker exec -u "$app_uid:$app_gid" "$NAME" netstat -lntup) || die 'same-uid final netstat failed'
tail_udp=$(printf '%s\n' "$owned" | awk -v pid="$tail_pid" '$1 ~ /^udp/ && $NF == pid "/tailscaled" { print $4 }')
[ -n "$tail_udp" ] || die 'tailscaled lost its UDP listener'
printf '%s\n' "$owned" | awk -v pid="$tail_pid" '$1 ~ /^tcp/ && $NF == pid "/tailscaled" {bad=1} END {exit bad}' \
  || die 'tailscaled opened a TCP listener'

# #971 measurement: userspace tailscaled forwards tailnet traffic to 127.0.0.1.
# In this phase only 127.0.0.2+ loopback is exempt. The app port, media UDP
# port and owned tailscaled UDP sockets are the complete public allowlist.
find_tail_offenders() {
  printf '%s\n' "$sockets" | awk -v app_port="$PORT" -v tail="$tail_udp" '
    BEGIN { n=split(tail, addresses, "\n"); for (i=1;i<=n;i++) tail_address[addresses[i]]=1 }
    $1 ~ /^(tcp|udp)/ {
      proto=$1; sub(/[0-9]+$/, "", proto)
      local_addr=$4; port=local_addr; sub(/^.*:/, "", port)
      if (local_addr ~ /^127[.]0[.]0[.]1:/ || local_addr ~ /^(\[::1\]|::1):/) { print; next }
      if (local_addr ~ /^127[.]0[.]0[.]([2-9]|[1-9][0-9]+):/) next
      if (proto == "tcp" && port == app_port) next
      if (proto == "udp" && port == "8189") next
      if (proto == "udp" && tail_address[local_addr]) next
      print
    }
  '
}
if [ "${1:-check}" = loopback-control ]; then
  docker exec -d "$NAME" node -e "require('net').createServer().listen(46464,'127.0.0.1')" \
    || die 'could not launch the loopback control'
  control_ready=0
  for ((i=0; i<20; i++)); do
    sockets=$(docker exec "$NAME" netstat -lntu) || die 'control netstat failed'
    if has_socket tcp '^127[.]0[.]0[.]1:46464$'; then control_ready=1; break; fi
    sleep 1
  done
  [ "$control_ready" -eq 1 ] || die 'loopback control did not bind'
fi
sockets=$(docker exec "$NAME" netstat -lntu) || die 'final netstat failed'
offenders=$(find_tail_offenders)
if [ -n "$offenders" ]; then
  printf 'Unexpected Tailscale-phase listening sockets:\n%s\n' "$offenders" >&2
  die 'image has an unexpected Tailscale-phase listener'
fi
[ "${1:-check}" != loopback-control ] || die 'loopback control survived the listener check'
ok 'Tailscale-on listener allowlist holds'

# Controls for the UDP rules (Opus and Codex reviews of #972, verified by running: with the ownership match
# removed from both `tail_udp` lines, or UDP exempted on 127.0.0.1, this script still passed).
# Both sockets belong to the APP user (docker exec -u), so `netstat -p` lists them as PID/node. They are
# bound AFTER the main check and `tail_udp` is recomputed from a fresh snapshot, so a broken ownership match
# would credit the unowned wildcard socket to tailscaled and it would vanish from the offenders.
docker exec -d -u "$app_uid:$app_gid" "$NAME" node -e "
  const d = require('dgram');
  d.createSocket('udp4').bind(46465, '0.0.0.0');
  d.createSocket('udp4').bind(46466, '127.0.0.1');
  setTimeout(() => {}, 600000);" || die 'could not launch the UDP controls'
control_ready=0
for ((i=0; i<20; i++)); do
  sockets=$(docker exec "$NAME" netstat -lntu) || die 'UDP control netstat failed'
  if has_socket udp ':46465$' && has_socket udp '^127[.]0[.]0[.]1:46466$'; then control_ready=1; break; fi
  sleep 1
done
[ "$control_ready" -eq 1 ] || die 'UDP controls did not bind'
owned=$(docker exec -u "$app_uid:$app_gid" "$NAME" netstat -lntup) || die 'same-uid control netstat failed'
tail_udp=$(printf '%s\n' "$owned" | awk -v pid="$tail_pid" '$1 ~ /^udp/ && $NF == pid "/tailscaled" { print $4 }')
offenders=$(find_tail_offenders)
printf '%s\n' "$offenders" | grep -q ':46465' || die 'unowned wildcard UDP listener escaped the allowlist'
printf '%s\n' "$offenders" | grep -q ':46466' || die 'UDP listener on 127.0.0.1 escaped the allowlist'
ok 'an unowned wildcard UDP listener and a 127.0.0.1 UDP listener are rejected'
