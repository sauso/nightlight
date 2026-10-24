#!/usr/bin/env bash
# The OPTIONAL container hardening (#553 part b), proven against the real image.
#
# Starts the image the way docs/operations.md, "Hardening the container (optional)", tells people to:
# every Linux capability dropped except the six the start-up script needs, plus no-new-privileges, with
# PUID=99/PGID=100 so the hand-over from root to the app user really happens (the Playwright stack runs as
# PUID=0 and never exercises it). Then:
#   green  the hardened container works: healthy, streams, the MFA recovery command works, it stops cleanly,
#          and a second container on the same data directory starts again;
#   k      KILL left out:         the stop is no longer clean;
#   d      DAC_OVERRIDE left out: the MFA recovery command fails, and the SECOND container on the same data
#                                 directory does not start;
#   f      FOWNER left out:       the start-up script cannot make the data directory owner-only.
# A control that does NOT see its failure fails this script. That is what shows each capability is needed,
# and that the green checks can tell a working container from a broken one.
#
#   bash e2e/hardened.sh            # all: green, then the K, D and F controls
#   bash e2e/hardened.sh green      # or k, d, f: one part only
#   bash e2e/hardened.sh teardown   # remove whatever a killed run left behind
#
# Needs a LINUX Docker host: the process checks read the container's processes from the host's /proc
# (Docker Desktop keeps them inside its VM). CI runs this in the `hardened` job of .github/workflows/e2e.yml,
# on an image built from the checked-out commit. Locally, build first (`docker build -t sauso/nightlight:dev .`)
# or this tests the last published :dev image.
#
# Own containers, network, volumes and host port, all labelled with the project name, so it never collides
# with the Playwright stack (nightlight-e2e, port 4000) and a teardown removes exactly what it made.
set -euo pipefail

E2E_DIR=$(cd "$(dirname "$0")" && pwd)

# ── Settings ─────────────────────────────────────────────────────────────────────────────────────
IMAGE=${NIGHTLIGHT_IMAGE:-sauso/nightlight:dev}     # same default and override as docker-compose.e2e.yml
PORT=${E2E_HARDENED_PORT:-4100}                     # NOT 4000: the Playwright stack may hold that
PROJECT=${HARDENED_PROJECT:-nightlight-hardened}
BASE="http://127.0.0.1:$PORT"
NET="$PROJECT-net"
FAKECAM="$PROJECT-fakecam"
LABEL="nightlight.e2e.project=$PROJECT"
ROLE_APP="nightlight.e2e.role=app"
# Keep equal to the fakecam service in docker-compose.e2e.yml (same image, same config file).
FAKECAM_IMAGE=bluenviron/mediamtx:latest-ffmpeg
APP_PUID=99
APP_PGID=100

# ── THE capability list ──────────────────────────────────────────────────────────────────────────
# ⚠️ ONE list here, kept in step BY HAND with the two other places that state it:
#   - docker-compose.yml: the commented-out cap_drop / cap_add / security_opt block;
#   - docs/operations.md, "Hardening the container (optional)": the Unraid Extra Parameters line and the
#     compose lines.
# Change all three together, and EXPECT_CAPBND below with them.
# Why these six and no others: the plan review of #553 part b walked backend/entrypoint.sh line by line. What
# each one is for, and what breaks without it, is in the docker-compose.yml comment and in that docs section.
HARDENING_CAPS=(CHOWN DAC_OVERRIDE FOWNER KILL SETUID SETGID)
NO_NEW_PRIVS='no-new-privileges=true'

# ── Expectations: everything the CI log is compared against, in one place ────────────────────────
# Bounding set of tini and every process under it. Bits CHOWN 0, DAC_OVERRIDE 1, FOWNER 3, KILL 5, SETGID 6,
# SETUID 7: 0x01 + 0x02 + 0x08 + 0x20 + 0x40 + 0x80 = 0xeb. The BOUNDING set, not CapEff, on purpose: the app
# has CapEff 0 after su-exec's setuid() even with Docker's default capabilities, so an empty CapEff proves
# nothing about the hardening (plan review of #553 part b, item 2).
EXPECT_CAPBND=00000000000000eb
EXPECT_DATA_MODE=700
EXPECT_DATA_OWNER="$APP_PUID:$APP_PGID"
# The preseeded folder and file (new_volume) have group/other bits, so the first start's mode walk must find
# them: a 0 would mean the walk checked nothing.
MIN_FOUND_FIRST_BOOT=1
# backend/src/index.js, shutdown(): the first thing the app logs after SIGTERM reaches it.
SHUTDOWN_LINE='Shutting down - stopping transcoders and MediaMTX.'
# tini, when it cannot forward the stop signal: "[FATAL tini (1)] Unexpected error when forwarding signal: ...".
TINI_FATAL='FATAL tini'
# backend/entrypoint.sh, the mode walk's warning.
TIGHTEN_WARNING='could not tighten'
ALREADY_OWNED_LINE="data directory already owned by $EXPECT_DATA_OWNER"
# The second start can only print this if root could look inside the owner-only data directory.
DB_MODE_TOKEN='babymonitor.db=600'
# docs/mfa.md, "Recovery": the console failsafe. The run creates an admin without two-factor.
MFA_LIST_OK='No users have two-factor enabled.'
# Control D, the SECOND start without DAC_OVERRIDE. Seen in CI (runs of 2026-10-24): a NEW container's
# `usermod -u` re-owns its home (/app, owned by the build-time uid) with a walk that cannot open the owner-only
# /app/data, and exits 12 with exactly this line, before the entrypoint's own ownership check can matter. The plan
# review had predicted the entrypoint's ownership line instead, which does not happen (without search permission the
# directory simply is not found), so only this one signature is accepted: a loose pattern would let an unrelated
# start-up failure pass the control (Codex review).
D_SIGNATURE_RE='usermod: Failed to change ownership of the home directory'
# Bounded waits, in seconds. The image's HEALTHCHECK first runs 30 s after start (120 s start period).
HEALTHY_TIMEOUT=200
READY_TIMEOUT=120
EXIT_TIMEOUT=90

# ── Output (same shape as prove.sh) ──────────────────────────────────────────────────────────────
say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mOK\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
info() { printf '      %s\n' "$*"; }
die_log() { # log file, message
  printf '  ---- last 40 lines of %s ----\n' "$1"
  tail -n 40 "$1" 2>/dev/null | sed 's/^/  | /' || true
  die "$2"
}

usage() {
  printf 'usage: bash e2e/hardened.sh [all|green|k|d|f|teardown]   (default: all)\n' >&2
}

# ── Docker helpers ───────────────────────────────────────────────────────────────────────────────
teardown() {
  local -a ids=()
  mapfile -t ids < <(docker ps -aq --filter "label=$LABEL" 2>/dev/null || true)
  [ ${#ids[@]} -eq 0 ] || docker rm -f "${ids[@]}" >/dev/null 2>&1 || true
  mapfile -t ids < <(docker volume ls -q --filter "label=$LABEL" 2>/dev/null || true)
  [ ${#ids[@]} -eq 0 ] || docker volume rm -f "${ids[@]}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

# Each part starts from no app container, so a part that failed half-way cannot hold the port for the next.
cleanup_apps() {
  local -a ids=()
  mapfile -t ids < <(docker ps -aq --filter "label=$LABEL" --filter "label=$ROLE_APP")
  [ ${#ids[@]} -eq 0 ] || docker rm -f "${ids[@]}" >/dev/null 2>&1 || true
}

is_running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

caps_without() { # [capability to leave out] -> one capability per line
  local cap
  for cap in "${HARDENING_CAPS[@]}"; do
    [ "$cap" = "${1:-}" ] || printf '%s\n' "$cap"
  done
}

# A fresh data volume, preseeded like an install from before #549 (or a restore made as root): a root-owned
# folder and file with the old 755 / 644 modes. The first hardened start must re-own them (CHOWN) and take
# group/other access off them (FOWNER), so the mode walk has real work and its count cannot be a vacuous 0.
new_volume() {
  docker volume rm -f "$1" >/dev/null 2>&1 || true
  docker volume create --label "$LABEL" "$1" >/dev/null
  docker run --rm --network none --label "$LABEL" --entrypoint sh -v "$1:/app/data" "$IMAGE" \
    -c 'umask 022 && mkdir -p /app/data/preseed && echo old > /app/data/preseed/old-file'
}

# "mode uid:gid" of the data directory, read by a throwaway container (the volume's host path is root-only).
data_dir_stat() {
  docker run --rm --network none --label "$LABEL" --entrypoint stat -v "$1:/app/data" "$IMAGE" \
    -c '%a %u:%g' /app/data
}

start_fakecam() {
  if is_running "$FAKECAM"; then return 0; fi
  docker rm -f "$FAKECAM" >/dev/null 2>&1 || true
  docker run -d --name "$FAKECAM" --label "$LABEL" --network "$NET" --network-alias fakecam \
    -v "$E2E_DIR/fakecam/mediamtx.yml:/mediamtx.yml:ro" "$FAKECAM_IMAGE" >/dev/null
  ok "synthetic camera started (rtsp://fakecam:8554/test)"
}

# The app, hardened: the full set, or (for a control) the same set minus ONE capability.
start_app() { # name volume [capability to leave out]
  local name=$1 vol=$2 skip=${3:-} cap
  local -a flags=(--cap-drop=ALL)
  if [ -n "$skip" ]; then
    case " ${HARDENING_CAPS[*]} " in *" $skip "*) ;; *) die "unknown capability '$skip'" ;; esac
  fi
  while read -r cap; do flags+=("--cap-add=$cap"); done < <(caps_without "$skip")
  flags+=("--security-opt=$NO_NEW_PRIVS")
  # --stop-timeout 30: the same grace production declares (docker-compose.yml, the Unraid template), so a
  # clean stop here is a clean stop there.
  docker run -d --name "$name" --label "$LABEL" --label "$ROLE_APP" \
    --network "$NET" -p "127.0.0.1:$PORT:4000" \
    -e TZ=UTC -e "PUID=$APP_PUID" -e "PGID=$APP_PGID" \
    --stop-timeout 30 \
    -v "$vol:/app/data" \
    "${flags[@]}" \
    "$IMAGE" >/dev/null
}

save_log() { # container -> path of its saved log
  docker logs "$1" >"$LOG_DIR/$1.log" 2>&1 || true
  printf '%s' "$LOG_DIR/$1.log"
}

# The start-up script's lines and anything that looks like a permission failure, for the CI log.
show_startup() {
  grep -E '^\[entrypoint\]|could not tighten|Permission denied|Operation not permitted|usermod|su-exec|FATAL tini' "$1" \
    | head -n 20 | sed 's/^/      | /' || true
}

STOP_SECS=0
EXIT_CODE=
stop_app() { # container -> sets STOP_SECS and EXIT_CODE
  local t0=$SECONDS
  docker stop "$1" >/dev/null
  STOP_SECS=$((SECONDS - t0))
  EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$1")
}

# ── Bounded waits ────────────────────────────────────────────────────────────────────────────────
# 0 = Docker reports healthy, 1 = deadline, 2 = the container exited, 3 = Docker reports unhealthy.
wait_healthy() {
  local c=$1 end=$((SECONDS + HEALTHY_TIMEOUT)) st
  while [ $SECONDS -lt "$end" ]; do
    is_running "$c" || return 2
    st=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$c")
    case "$st" in
      healthy) return 0 ;;
      unhealthy) return 3 ;;
    esac
    sleep 3
  done
  return 1
}

# 0 = /api/health answers, 1 = deadline, 2 = the container exited.
wait_ready() {
  local c=$1 end=$((SECONDS + READY_TIMEOUT))
  while [ $SECONDS -lt "$end" ]; do
    is_running "$c" || return 2
    if curl -fsS -m 3 "$BASE/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# 0 = the container exited, 1 = still running at the deadline, 3 = it answered /api/health (it started).
wait_exit() {
  local c=$1 end=$((SECONDS + EXIT_TIMEOUT))
  while [ $SECONDS -lt "$end" ]; do
    is_running "$c" || return 0
    if curl -fsS -m 3 "$BASE/api/health" >/dev/null 2>&1; then return 3; fi
    sleep 2
  done
  return 1
}

healthy_or_die() { # container, what
  local rc=0
  wait_healthy "$1" || rc=$?
  case $rc in
    0) ok "$2: Docker reports healthy" ;;
    2) die_log "$(save_log "$1")" "$2: the container exited before it was healthy" ;;
    3) die_log "$(save_log "$1")" "$2: Docker reports unhealthy" ;;
    *) die_log "$(save_log "$1")" "$2: not healthy within ${HEALTHY_TIMEOUT}s" ;;
  esac
}

ready_or_die() { # container, what
  local rc=0
  wait_ready "$1" || rc=$?
  case $rc in
    0) ok "$2: /api/health answers" ;;
    2) die_log "$(save_log "$1")" "$2: the container exited before /api/health answered" ;;
    *) die_log "$(save_log "$1")" "$2: /api/health did not answer within ${READY_TIMEOUT}s" ;;
  esac
}

# ── Checks ───────────────────────────────────────────────────────────────────────────────────────
# Docker's own record of the flags. The CLI may store a capability as CAP_CHOWN or CHOWN and in any order,
# so both sides drop the prefix and are sorted before comparing.
norm_caps() { sed -e '/^$/d' -e 's/^CAP_//' | tr '[:lower:]' '[:upper:]' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'; }
check_inspect() { # container, expected capabilities...
  local c=$1 want got drop sec
  shift
  want=$(printf '%s\n' "$@" | norm_caps)
  got=$(docker inspect -f '{{range .HostConfig.CapAdd}}{{println .}}{{end}}' "$c" | norm_caps)
  drop=$(docker inspect -f '{{range .HostConfig.CapDrop}}{{println .}}{{end}}' "$c" | norm_caps)
  sec=$(docker inspect -f '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}' "$c" | sed '/^$/d' | tr '\n' ' ')
  [ "$got" = "$want" ] || die "docker inspect: CapAdd is [$got], expected [$want]"
  [ "$drop" = ALL ] || die "docker inspect: CapDrop is [$drop], expected [ALL]"
  case " $sec " in
    *" no-new-privileges=true "* | *" no-new-privileges:true "* | *" no-new-privileges "*) ;;
    *) die "docker inspect: SecurityOpt is [$sec], expected no-new-privileges" ;;
  esac
  ok "docker inspect: CapDrop [$drop], CapAdd [$got], SecurityOpt [${sec% }]"
}

# One field of a /proc/<pid>/status text, its values joined by single spaces ("Uid:\t99\t99\t99\t99" ->
# "99 99 99 99").
status_field() {
  printf '%s\n' "$1" | awk -v k="$2:" '$1 == k { s = ""; for (i = 2; i <= NF; i++) s = s (i > 2 ? " " : "") $i; print s; exit }'
}

# A host PID and all its descendants, the PID itself first, from /proc/<pid>/stat on THIS host. Never through
# `docker exec`: the probe would run inside the container as root and be counted as one of the app's
# processes (plan review of #553 part b, item 2). `docker exec` processes (the health check, ffprobe below)
# are children of the container runtime, not of tini, so they are not in this tree either.
process_tree() {
  local root=$1 d line rest pid ppid cur
  local -A parent=()
  for d in /proc/[0-9]*; do
    { read -r line <"$d/stat"; } 2>/dev/null || continue
    pid=${d#/proc/}
    rest=${line##*") "}   # the name can contain spaces and ')': the fields start after the LAST ") "
    read -r _ ppid _ <<<"$rest"
    parent[$pid]=$ppid
  done
  local -a out=("$root") queue=("$root")
  while [ ${#queue[@]} -gt 0 ]; do
    cur=${queue[0]}
    queue=("${queue[@]:1}")
    for pid in "${!parent[@]}"; do
      if [ "${parent[$pid]}" = "$cur" ]; then
        out+=("$pid")
        queue+=("$pid")
      fi
    done
  done
  printf '%s\n' "${out[@]}"
}

# tini (PID 1) and everything under it: the bounding set is exactly the six and no-new-privileges is set on
# all of them. Everything under tini also runs as PUID:PGID with no group 0. tini itself stays root (uid 0,
# root's groups, 0 among them): it is root BY DESIGN, because the start-up script it runs needs root to
# re-own the data directory, so the uid and group checks start one level down.
check_processes() {
  local c=$1 root pid st name uid gid groups capbnd nnp bad=0 n=0 names=" " want
  root=$(docker inspect -f '{{.State.Pid}}' "$c")
  [ -n "$root" ] && [ "$root" != 0 ] || die "$c is not running"
  [ -d "/proc/$root" ] || die "container PID $root is not visible in this host's /proc: run this on a Linux Docker host (CI does), not Docker Desktop"
  [ "$(cat "/proc/$root/comm" 2>/dev/null)" = tini ] || die "PID $root is '$(cat "/proc/$root/comm" 2>/dev/null)', expected tini"
  printf '      %-8s %-10s %-16s %-17s %-3s %s\n' PID NAME UID CAPBND NNP GROUPS
  while read -r pid; do
    # A short-lived child (an ffprobe the app started) may be gone by now: skip it.
    st=$(cat "/proc/$pid/status" 2>/dev/null) || continue
    name=$(status_field "$st" Name)
    # Node renames its main thread, so /proc/<pid>/status says "MainThread" rather than "node" (seen in the first CI
    # run of this script). The command line is the reliable name for it: node is the process running src/index.js.
    if [ "$name" = MainThread ] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qE '(^| |/)node( |$)'; then
      name=node
    fi
    uid=$(status_field "$st" Uid)
    gid=$(status_field "$st" Gid)
    groups=$(status_field "$st" Groups)
    capbnd=$(status_field "$st" CapBnd)
    nnp=$(status_field "$st" NoNewPrivs)
    n=$((n + 1))
    printf '      %-8s %-10s %-16s %-17s %-3s %s\n' "$pid" "$name" "$uid" "$capbnd" "$nnp" "$groups"
    if [ "$capbnd" != "$EXPECT_CAPBND" ]; then bad=1; info "^ CapBnd is $capbnd, expected $EXPECT_CAPBND"; fi
    if [ "$nnp" != 1 ]; then bad=1; info "^ NoNewPrivs is '$nnp', expected 1"; fi
    [ "$pid" = "$root" ] && continue
    names="$names$name "
    if [ "$uid" != "$APP_PUID $APP_PUID $APP_PUID $APP_PUID" ]; then bad=1; info "^ Uid is '$uid', expected $APP_PUID everywhere"; fi
    if [ "$gid" != "$APP_PGID $APP_PGID $APP_PGID $APP_PGID" ]; then bad=1; info "^ Gid is '$gid', expected $APP_PGID everywhere"; fi
    case " $groups " in *" 0 "*) bad=1; info "^ group 0 is among its groups" ;; esac
  done < <(process_tree "$root")
  for want in node mediamtx ffmpeg; do
    case "$names" in *" $want "*) ;; *) bad=1; info "no $want process under tini" ;; esac
  done
  [ "$bad" = 0 ] || die "process check failed (above)"
  ok "$n processes: CapBnd $EXPECT_CAPBND and NoNewPrivs 1 on all; node, mediamtx and ffmpeg run as $APP_PUID:$APP_PGID with no group 0"
}

# The documented console failsafe (docs/mfa.md, "Recovery") must still work: it runs as root through
# `docker exec` and opens the owner-only database, which needs DAC_OVERRIDE.
check_mfa_recovery() {
  local out
  if ! out=$(docker exec "$1" node src/scripts/reset-mfa.js --list 2>&1); then
    die "reset-mfa.js --list failed under the hardened set: $out"
  fi
  case "$out" in
    *"$MFA_LIST_OK"*) ok "MFA recovery command works: $out" ;;
    *) die "reset-mfa.js --list printed: $out" ;;
  esac
}

# JSON field pluck without a jq dependency (copied from prove.sh; fine for these known-shape responses).
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

# The minimum of prove.sh: first-run admin, the synthetic camera added through the real API, playable HLS out
# of the far end. ffprobe runs inside the app container like prove.sh's, as root under the hardened set.
camera_and_hls() {
  local c=$1 setup token add cam media out i
  setup=$(curl -fsS -m 15 -X POST "$BASE/api/auth/setup" \
    -H 'Content-Type: application/json' \
    -d '{"username":"e2e","password":"e2e-admin-pw","first_name":"E2E"}') || die "first-run setup request failed"
  token=$(printf '%s' "$setup" | field token)
  [ -n "$token" ] || die "no token from /auth/setup: $setup"
  ok "first-run admin created"

  for i in $(seq 1 20); do
    out=$(docker exec "$c" ffprobe -v error -rtsp_transport tcp -i rtsp://fakecam:8554/test \
      -show_entries stream=codec_type -of csv=p=0 2>/dev/null || true)
    case "$out" in *video*) ok "synthetic camera is live"; break ;; esac
    if [ "$i" = 20 ]; then die "the synthetic camera never produced a video stream"; fi
    sleep 2
  done

  add=$(curl -fsS -m 60 -X POST "$BASE/api/cameras" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{"name":"E2E Synthetic","rtsp_host":"fakecam","rtsp_port":"8554","rtsp_path":"/test"}') || die "camera add request failed"
  cam=$(printf '%s' "$add" | field mediamtx_path)
  [ -n "$cam" ] || die "camera add failed: $add"
  ok "camera added (mediamtx path $cam)"

  media=$(curl -fsS -m 15 -X POST "$BASE/api/auth/media-token" -H "Authorization: Bearer $token" | field token) || true
  [ -n "$media" ] || die "could not mint a media token"
  for i in $(seq 1 30); do
    out=$(docker exec "$c" ffprobe -v error -i "http://127.0.0.1:4000/hls/$cam/index.m3u8?token=$media" \
      -show_entries stream=codec_type -of csv=p=0 2>/dev/null | tr '\n' ',' || true)
    case "$out" in *video*) ok "HLS serves live media (streams: ${out%,})"; return 0 ;; esac
    if [ "$i" = 30 ]; then die "HLS never produced a video stream"; fi
    sleep 2
  done
}

found_count() { # log -> the count on the start-up script's "found: N" line
  grep -o 'existing entries with group/other access found: *[0-9]*' "$1" | head -n 1 | grep -o '[0-9]*$' || true
}

# A clean stop: Docker's exit code 0, the app's own shutdown line, and tini never complaining.
check_clean_stop() { # container, log, what
  if [ "$EXIT_CODE" != 0 ]; then die_log "$2" "$3: exit code $EXIT_CODE after docker stop, expected 0"; fi
  grep -qF "$SHUTDOWN_LINE" "$2" || die_log "$2" "$3: no '$SHUTDOWN_LINE' line: the app never got the stop signal"
  if grep -qF "$TINI_FATAL" "$2"; then die_log "$2" "$3: a '$TINI_FATAL' line"; fi
  ok "$3: clean stop in ${STOP_SECS}s (exit code 0, the shutdown line, no '$TINI_FATAL')"
}

# ── The four parts ───────────────────────────────────────────────────────────────────────────────
phase_green() {
  local vol="$PROJECT-green-data" c1="$PROJECT-green-1" c2="$PROJECT-green-2" log st found
  say "GREEN: full hardening (--cap-drop=ALL + ${HARDENING_CAPS[*]}, $NO_NEW_PRIVS), PUID=$APP_PUID PGID=$APP_PGID"
  cleanup_apps
  new_volume "$vol"
  start_fakecam

  start_app "$c1" "$vol"
  check_inspect "$c1" "${HARDENING_CAPS[@]}"
  healthy_or_die "$c1" "first start"
  camera_and_hls "$c1"
  check_processes "$c1"
  check_mfa_recovery "$c1"

  stop_app "$c1"
  log=$(save_log "$c1")
  show_startup "$log"
  check_clean_stop "$c1" "$log" "first start"
  found=$(found_count "$log")
  if [ -z "$found" ] || [ "$found" -lt "$MIN_FOUND_FIRST_BOOT" ]; then
    die_log "$log" "first start: the mode walk found '${found:-nothing}', expected at least $MIN_FOUND_FIRST_BOOT (the preseeded entries)"
  fi
  if grep -qF "$TIGHTEN_WARNING" "$log"; then die_log "$log" "first start: '$TIGHTEN_WARNING' warning"; fi
  ok "first start: the mode walk found $found entries and tightened them without a warning"
  st=$(data_dir_stat "$vol")
  [ "$st" = "$EXPECT_DATA_MODE $EXPECT_DATA_OWNER" ] || die "data directory is '$st', expected '$EXPECT_DATA_MODE $EXPECT_DATA_OWNER'"
  ok "data directory: mode $EXPECT_DATA_MODE, owner $EXPECT_DATA_OWNER"
  docker rm "$c1" >/dev/null

  # A NEW container on the same data directory, as an update or an Unraid "Apply" makes: the start-up script
  # now meets an owner-only directory it did not create, which is where DAC_OVERRIDE is needed.
  start_app "$c2" "$vol"
  healthy_or_die "$c2" "second start (same data directory, new container)"
  stop_app "$c2"
  log=$(save_log "$c2")
  show_startup "$log"
  check_clean_stop "$c2" "$log" "second start"
  if grep -qF "$TIGHTEN_WARNING" "$log"; then die_log "$log" "second start: '$TIGHTEN_WARNING' warning"; fi
  grep -qF "$ALREADY_OWNED_LINE" "$log" || die_log "$log" "second start: no '$ALREADY_OWNED_LINE' line"
  grep -qF "$DB_MODE_TOKEN" "$log" || die_log "$log" "second start: no '$DB_MODE_TOKEN' (root could not see into the data directory)"
  ok "second start: ownership already right, root saw $DB_MODE_TOKEN, no warning"
  st=$(data_dir_stat "$vol")
  [ "$st" = "$EXPECT_DATA_MODE $EXPECT_DATA_OWNER" ] || die "data directory is '$st' after the second start"
  docker rm "$c2" >/dev/null
  say "GREEN PASSED"
}

# K: without KILL, root's tini may not signal the app, which runs as another uid. Expected (from tini's
# source, plan review item 1): tini logs a FATAL line and exits 1 AT ONCE, and the kernel then kills the app.
# So the stop is FAST and an elapsed-time check cannot catch it; the exit code and the two log lines can.
phase_k() {
  local vol="$PROJECT-k-data" c="$PROJECT-k" log
  local -a want=()
  say "CONTROL K: KILL left out; the stop must NOT be clean"
  cleanup_apps
  new_volume "$vol"
  start_app "$c" "$vol" KILL
  mapfile -t want < <(caps_without KILL)
  check_inspect "$c" "${want[@]}"
  ready_or_die "$c" "K control"
  stop_app "$c"
  log=$(save_log "$c")
  info "stop took ${STOP_SECS}s, exit code $EXIT_CODE (time shown for comparison only)"
  if [ "$EXIT_CODE" = 0 ]; then die_log "$log" "K: exit code 0 without KILL, so the green exit-code check proves nothing"; fi
  grep -qF "$TINI_FATAL" "$log" || die_log "$log" "K: no '$TINI_FATAL' line"
  if grep -qF "$SHUTDOWN_LINE" "$log"; then die_log "$log" "K: the app logged '$SHUTDOWN_LINE', so it did get the signal"; fi
  grep -F "$TINI_FATAL" "$log" | head -n 1 | sed 's/^/      | /' || true
  ok "K: exit code $EXIT_CODE, a '$TINI_FATAL' line, no shutdown line"
  docker rm "$c" >/dev/null
  say "CONTROL K PASSED"
}

# D: without DAC_OVERRIDE root cannot enter the owner-only (700) data directory. The FIRST start works (the
# directory is still root's 755 when the script looks); a second, NEW container must not start.
phase_d() {
  local vol="$PROJECT-d-data" c1="$PROJECT-d-1" c2="$PROJECT-d-2" log sig out rc=0
  local -a want=()
  say "CONTROL D: DAC_OVERRIDE left out; the first start works, the second container must NOT start"
  cleanup_apps
  new_volume "$vol"
  start_app "$c1" "$vol" DAC_OVERRIDE
  mapfile -t want < <(caps_without DAC_OVERRIDE)
  check_inspect "$c1" "${want[@]}"
  ready_or_die "$c1" "D control, first start (expected to work)"
  # The docs say root's `docker exec` commands (the backup, the two-factor reset) fail without DAC_OVERRIDE. The
  # command the green run expects to work must fail here, or the green MFA check proves nothing.
  if out=$(docker exec "$c1" node src/scripts/reset-mfa.js --list 2>&1); then
    die "D: reset-mfa.js --list worked without DAC_OVERRIDE: $out"
  fi
  ok "D: the MFA recovery command fails without DAC_OVERRIDE: $(printf '%s\n' "$out" | grep -m 1 -iE 'unable to open|error' || true)"
  stop_app "$c1"
  log=$(save_log "$c1")
  show_startup "$log"
  docker rm "$c1" >/dev/null

  start_app "$c2" "$vol" DAC_OVERRIDE
  wait_exit "$c2" || rc=$?
  case $rc in
    0) ;;
    3) die_log "$(save_log "$c2")" "D: the second start answered /api/health: DAC_OVERRIDE was not needed" ;;
    *) die_log "$(save_log "$c2")" "D: the second start was still running after ${EXIT_TIMEOUT}s" ;;
  esac
  EXIT_CODE=$(docker inspect -f '{{.State.ExitCode}}' "$c2")
  log=$(save_log "$c2")
  show_startup "$log"
  if [ "$EXIT_CODE" = 0 ]; then die_log "$log" "D: the second start exited with code 0"; fi
  sig=$(grep -Em 1 "$D_SIGNATURE_RE" "$log" || true)
  [ -n "$sig" ] || die_log "$log" "D: exited $EXIT_CODE, but no line matches '$D_SIGNATURE_RE'"
  ok "D: the second start exited with code $EXIT_CODE: $sig"
  docker rm "$c2" >/dev/null
  say "CONTROL D PASSED"
}

# F: without FOWNER root may not chmod files it does not own, so the mode walk fails (a warning, by design
# not fatal) and the data directory keeps its group/other bits.
phase_f() {
  local vol="$PROJECT-f-data" c="$PROJECT-f" log st mode
  local -a want=()
  say "CONTROL F: FOWNER left out; the data directory must NOT end up owner-only"
  cleanup_apps
  new_volume "$vol"
  start_app "$c" "$vol" FOWNER
  mapfile -t want < <(caps_without FOWNER)
  check_inspect "$c" "${want[@]}"
  ready_or_die "$c" "F control"
  stop_app "$c"
  log=$(save_log "$c")
  show_startup "$log"
  grep -qF "$TIGHTEN_WARNING" "$log" || die_log "$log" "F: no '$TIGHTEN_WARNING' warning"
  st=$(data_dir_stat "$vol")
  mode=${st%% *}
  [ "$mode" != "$EXPECT_DATA_MODE" ] || die "F: the data directory is mode $mode anyway, so the green mode check proves nothing"
  ok "F: '$TIGHTEN_WARNING' warning, data directory left at '$st'"
  docker rm "$c" >/dev/null
  say "CONTROL F PASSED"
}

# ── Main ─────────────────────────────────────────────────────────────────────────────────────────
MODE=${1:-all}
MODE=${MODE,,}
case "$MODE" in
  teardown) teardown; exit 0 ;;
  all) PHASES=(green k d f) ;;
  green | k | d | f) PHASES=("$MODE") ;;
  *) usage; exit 2 ;;
esac

command -v docker >/dev/null || die "docker is not on PATH"
command -v curl >/dev/null || die "curl is not on PATH"
docker info >/dev/null 2>&1 || die "no Docker daemon answers"

if [ -n "${HARDENED_LOG_DIR:-}" ]; then
  LOG_DIR=$HARDENED_LOG_DIR
  mkdir -p "$LOG_DIR"
else
  LOG_DIR=$(mktemp -d)
fi

trap teardown EXIT
teardown   # whatever a killed run left behind

say "Setting up"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
ok "image $IMAGE ($(docker image inspect -f '{{.Id}}' "$IMAGE"))"
docker network create --label "$LABEL" "$NET" >/dev/null
ok "network $NET, host port $PORT, container logs in $LOG_DIR"

# Each part in its own subshell, so one that fails does not hide the others' results. `set -e` is switched
# on INSIDE: errexit is ignored in a subshell used as an `if` condition, so the status is collected after.
RESULTS=()
FAILED=0
for phase in "${PHASES[@]}"; do
  set +e
  (
    set -e
    "phase_$phase"
  )
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then
    RESULTS+=("  OK    $phase")
  else
    RESULTS+=("  FAIL  $phase")
    FAILED=1
  fi
done

say "Summary"
printf '%s\n' "${RESULTS[@]}"
if [ "$FAILED" = 0 ]; then
  say "HARDENED CONTAINER CHECKS PASSED"
else
  say "HARDENED CONTAINER CHECKS FAILED"
  exit 1
fi
