#!/usr/bin/env bash
# Media isolation (#553, phase 1), proven against the real image.
#
# With NIGHTLIGHT_MEDIA_ISOLATION=1 (an INTERNAL switch for now: backend/entrypoint.sh, "Media isolation") the start-up
# script dry-runs the chain as root and, if it works, starts the app through `setpriv` with CAP_SETUID, CAP_SETGID and
# CAP_KILL as ambient capabilities; the app then starts every ffmpeg, ffprobe and MediaMTX through media-exec.sh as the
# media user (uid:gid 1700:1700, no capabilities). If the dry run fails it starts the usual way (su-exec), says why in
# ONE warning line, and GET /api/about reports mediaIsolation "off". This script checks both halves:
#   six      the documented hardening (six capabilities + no-new-privileges): node runs as PUID:PGID with CapEff 0xe0
#            (setuid, setgid, kill) and NoNewPrivs 1; every media process runs as 1700:1700 with only group 1700, all
#            four Cap* sets 0 and NoNewPrivs 1; healthy, HLS from the synthetic camera, About says "on", the dry run
#            left no temporary folder, and `docker stop` is clean;
#   default  plain Docker defaults: the same;
#   nokill   the six capabilities WITHOUT KILL: the dry run fails, the container still starts the usual way and
#            serves HLS, the one warning names the failed drop, About says "off", and nothing runs as 1700;
#   puid     PUID=1700: isolation is refused before any dry run, the same fallback, and the warning says why.
# A negative case that does NOT see its signature fails this script, as hardened.sh's controls do.
#
#   bash e2e/media-isolation.sh            # all four
#   bash e2e/media-isolation.sh six        # or default, nokill, puid: one part only
#   bash e2e/media-isolation.sh teardown   # remove whatever a killed run left behind
#
# The helpers (waits, the /proc reads, the camera + HLS check, the clean-stop check) are hardened.sh's, SOURCED, with
# this script's own project name and host port, so the two never collide and a container is checked the same way.
# Needs a LINUX Docker host (the process checks read the host's /proc). CI: the `media-isolation` job in
# .github/workflows/e2e.yml, on an image built from the checked-out commit.
set -euo pipefail

export HARDENED_PROJECT=${MEDIA_ISO_PROJECT:-nightlight-media-iso}
export E2E_HARDENED_PORT=${E2E_MEDIA_ISO_PORT:-4200}   # NOT 4000 (Playwright) and NOT 4100 (hardened.sh)
# shellcheck source=hardened.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hardened.sh"

# ── Expectations ─────────────────────────────────────────────────────────────────────────────────
MEDIA_ID=1700                       # backend/media-exec.sh, the Dockerfile's nlmedia, entrypoint.sh's MEDIA_ID
APP_CAPEFF=00000000000000e0         # CAP_SETGID 6 + CAP_SETUID 7 + CAP_KILL 5 = 0x40 + 0x80 + 0x20
NO_CAPS=0000000000000000
ON_LINE='[entrypoint] media isolation on:'
OFF_LINE='[entrypoint] warning: media isolation is off:'
# What the start-up script says for each fallback (backend/entrypoint.sh, the MEDIA_REASON texts). Specific on
# purpose: a loose pattern would let an unrelated failure pass the control.
NOKILL_REASON='the dry run could not start the app as uid'
PUID_REASON="PUID or PGID is $MEDIA_ID"

# ── Start ────────────────────────────────────────────────────────────────────────────────────────
start_iso_app() { # name volume six|default|nokill [puid]
  local name=$1 vol=$2 kind=$3 puid=${4:-$APP_PUID} cap leave_out=
  local -a flags=()
  case "$kind" in
    six | nokill)
      if [ "$kind" = nokill ]; then leave_out=KILL; fi
      flags=(--cap-drop=ALL)
      while read -r cap; do flags+=("--cap-add=$cap"); done < <(caps_without "$leave_out")
      flags+=("--security-opt=$NO_NEW_PRIVS")
      ;;
    default) ;;
    *) die "unknown kind '$kind'" ;;
  esac
  docker run -d --name "$name" --label "$LABEL" --label "$ROLE_APP" \
    --network "$NET" -p "127.0.0.1:$PORT:4000" \
    -e TZ=UTC -e "PUID=$puid" -e "PGID=$APP_PGID" -e NIGHTLIGHT_MEDIA_ISOLATION=1 \
    --stop-timeout 30 \
    -v "$vol:/app/data" \
    "${flags[@]}" \
    "$IMAGE" >/dev/null
}

# ── Process checks (read from the host's /proc, never through docker exec: see process_tree) ────
# One row per process under tini, then a verdict. `mode` is `on` (node keeps exactly setuid/setgid/kill, every other
# process is the media user with nothing) or `off` (every process under tini runs as the app with no capabilities,
# as before #553). `media-exec.sh` (or `sh`) and `setpriv` are the wrapper's own stages between spawn() and the exec
# into the program: a fresh ffprobe can be caught there. They are not judged, but one that is STILL there two seconds
# later is a wrapper that did not exec, and fails.
check_iso_processes() { # container on|off app_uid app_gid
  local c=$1 mode=$2 auid=$3 agid=$4 root pid st name uid gid groups inh prm eff amb bnd nnp bad=0 names=" " n=0
  local -a transient=()
  root=$(docker inspect -f '{{.State.Pid}}' "$c")
  [ -n "$root" ] && [ "$root" != 0 ] || die "$c is not running"
  [ -d "/proc/$root" ] || die "container PID $root is not visible in this host's /proc: run this on a Linux Docker host"
  printf '      %-8s %-10s %-20s %-20s %-10s %-17s %-17s %-17s %-17s %-3s\n' PID NAME UID GID GROUPS CAPINH CAPPRM CAPEFF CAPAMB NNP
  while read -r pid; do
    st=$(cat "/proc/$pid/status" 2>/dev/null) || continue
    name=$(status_field "$st" Name)
    if [ "$name" = MainThread ] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qE '(^| |/)node( |$)'; then
      name=node
    fi
    uid=$(status_field "$st" Uid); gid=$(status_field "$st" Gid); groups=$(status_field "$st" Groups)
    inh=$(status_field "$st" CapInh); prm=$(status_field "$st" CapPrm); eff=$(status_field "$st" CapEff)
    amb=$(status_field "$st" CapAmb); bnd=$(status_field "$st" CapBnd); nnp=$(status_field "$st" NoNewPrivs)
    printf '      %-8s %-10s %-20s %-20s %-10s %-17s %-17s %-17s %-17s %-3s\n' "$pid" "$name" "$uid" "$gid" "$groups" "$inh" "$prm" "$eff" "$amb" "$nnp"
    [ "$pid" = "$root" ] && continue   # tini: root by design (hardened.sh, check_processes)
    n=$((n + 1))
    case "$name" in
      # A script's process name is the script's own file name (media-exec.sh), or sh, depending on the kernel.
      sh | setpriv | media-exec.sh) transient+=("$pid:$name"); continue ;;
    esac
    names="$names$name "
    if [ "$mode" = off ] || [ "$name" = node ]; then
      [ "$uid" = "$auid $auid $auid $auid" ] || { bad=1; info "^ Uid is '$uid', expected $auid everywhere"; }
      [ "$gid" = "$agid $agid $agid $agid" ] || { bad=1; info "^ Gid is '$gid', expected $agid everywhere"; }
    fi
    if [ "$mode" = off ]; then
      [ "$eff" = "$NO_CAPS" ] || { bad=1; info "^ CapEff is $eff, expected $NO_CAPS (su-exec keeps none)"; }
    elif [ "$name" = node ]; then
      [ "$eff" = "$APP_CAPEFF" ] || { bad=1; info "^ CapEff is $eff, expected $APP_CAPEFF (setuid, setgid, kill)"; }
      [ "$nnp" = 1 ] || { bad=1; info "^ NoNewPrivs is '$nnp', expected 1"; }
      case " $groups " in *" $MEDIA_ID "*) ;; *) bad=1; info "^ the app is not in the media group $MEDIA_ID" ;; esac
    else
      [ "$uid" = "$MEDIA_ID $MEDIA_ID $MEDIA_ID $MEDIA_ID" ] || { bad=1; info "^ Uid is '$uid', expected $MEDIA_ID everywhere"; }
      [ "$gid" = "$MEDIA_ID $MEDIA_ID $MEDIA_ID $MEDIA_ID" ] || { bad=1; info "^ Gid is '$gid', expected $MEDIA_ID everywhere"; }
      [ "$groups" = "$MEDIA_ID" ] || { bad=1; info "^ Groups is '$groups', expected only $MEDIA_ID"; }
      for v in "$inh" "$prm" "$eff" "$amb"; do
        [ "$v" = "$NO_CAPS" ] || { bad=1; info "^ a capability set is $v, expected $NO_CAPS"; break; }
      done
      [ "$nnp" = 1 ] || { bad=1; info "^ NoNewPrivs is '$nnp', expected 1"; }
    fi
  done < <(process_tree "$root")
  for want in node mediamtx ffmpeg; do
    case "$names" in *" $want "*) ;; *) bad=1; info "no $want process under tini" ;; esac
  done
  if [ ${#transient[@]} -gt 0 ]; then
    sleep 2
    local t tp tn
    for t in "${transient[@]}"; do
      tp=${t%%:*}; tn=${t#*:}
      if [ "$(cat "/proc/$tp/comm" 2>/dev/null)" = "$tn" ]; then bad=1; info "pid $tp is still '$tn' after 2 s: a wrapper that did not exec"; fi
    done
  fi
  [ "$bad" = 0 ] || die "process check failed (above)"
  if [ "$mode" = on ]; then
    ok "$n processes: node as $auid:$agid with CapEff $APP_CAPEFF and NoNewPrivs 1; every media process as $MEDIA_ID:$MEDIA_ID, group $MEDIA_ID only, no capabilities, NoNewPrivs 1"
  else
    ok "$n processes: everything under tini runs as $auid:$agid with no capabilities (the usual start)"
  fi
}

# The dry run's mktemp -d folder must be gone (media-probe.sh removes it on every exit path).
check_no_probe_leftovers() { # container
  local left
  left=$(docker exec "$1" sh -c 'ls -d /tmp/tmp.* 2>/dev/null || true')
  [ -z "$left" ] || die "the dry run left something behind in /tmp: $left"
  ok "the dry run left no temporary folder in /tmp"
}

# ── The parts ────────────────────────────────────────────────────────────────────────────────────
iso_on_case() { # part name, kind (six|default)
  local part=$1 kind=$2 vol="$PROJECT-$1-data" c="$PROJECT-$1" log
  cleanup_apps
  new_volume "$vol"
  start_fakecam
  start_iso_app "$c" "$vol" "$kind"
  healthy_or_die "$c" "$part"
  camera_and_hls "$c"
  check_iso_processes "$c" on "$APP_PUID" "$APP_PGID"
  check_media_isolation_reported on
  check_no_probe_leftovers "$c"
  stop_app "$c"
  log=$(save_log "$c")
  show_startup "$log"   # every [entrypoint] line, the media isolation ones included
  grep -qF "$ON_LINE" "$log" || die_log "$log" "$part: no '$ON_LINE' line"
  if grep -qF "$OFF_LINE" "$log"; then die_log "$log" "$part: the start-up script also said isolation is off"; fi
  check_clean_stop "$c" "$log" "$part"
  docker rm "$c" >/dev/null
}

phase_six() {
  say "SIX: NIGHTLIGHT_MEDIA_ISOLATION=1 under the documented hardening (--cap-drop=ALL + ${HARDENING_CAPS[*]}, $NO_NEW_PRIVS)"
  iso_on_case six six
  say "SIX PASSED"
}

phase_default() {
  say "DEFAULT: NIGHTLIGHT_MEDIA_ISOLATION=1 with Docker's default capabilities"
  iso_on_case default default
  say "DEFAULT PASSED"
}

# A fallback: the container starts the usual way, says why once, reports off, and still streams.
iso_off_case() { # part name, kind, puid, expected reason, app uid
  local part=$1 kind=$2 puid=$3 reason=$4 auid=$5 vol="$PROJECT-$1-data" c="$PROJECT-$1" log warn
  cleanup_apps
  new_volume "$vol"
  start_fakecam
  start_iso_app "$c" "$vol" "$kind" "$puid"
  healthy_or_die "$c" "$part (expected to start the usual way)"
  camera_and_hls "$c"
  check_iso_processes "$c" off "$auid" "$APP_PGID"
  check_media_isolation_reported off
  log=$(save_log "$c")
  show_startup "$log"
  if grep -qF "$ON_LINE" "$log"; then die_log "$log" "$part: the start-up script switched isolation ON"; fi
  [ "$(grep -cF "$OFF_LINE" "$log")" = 1 ] || die_log "$log" "$part: expected exactly ONE '$OFF_LINE' line"
  warn=$(grep -F "$OFF_LINE" "$log")
  case "$warn" in
    *"$reason"*) ok "$part: one warning, with the reason: ${warn#*"$OFF_LINE" }" ;;
    *) die_log "$log" "$part: the warning does not give the expected reason ('$reason'): $warn" ;;
  esac
}

# KILL left out: the app's drop asks for CAP_KILL as an ambient capability, which the bounding set no longer holds, so
# setpriv refuses (#553 spike, run 3: "apply capabilities: Operation not permitted", exit 127). The stop is NOT checked:
# without KILL tini cannot signal the app either (hardened.sh, control K).
phase_nokill() {
  say "NOKILL: NIGHTLIGHT_MEDIA_ISOLATION=1, the six capabilities without KILL; the dry run must fail and the app start as before"
  iso_off_case nokill nokill "$APP_PUID" "$NOKILL_REASON" "$APP_PUID"
  docker rm -f "$PROJECT-nokill" >/dev/null
  say "NOKILL PASSED"
}

# PUID=1700: the app would BE the media user. Refused before any dry run; everything runs as 1700, as before #553 it
# would have for that PUID. Plain defaults, so the stop can be checked too.
phase_puid() {
  local c="$PROJECT-puid" log
  say "PUID: NIGHTLIGHT_MEDIA_ISOLATION=1 with PUID=$MEDIA_ID; isolation must be refused and the app start as before"
  iso_off_case puid default "$MEDIA_ID" "$PUID_REASON" "$MEDIA_ID"
  stop_app "$c"
  log=$(save_log "$c")
  check_clean_stop "$c" "$log" "puid"
  docker rm "$c" >/dev/null
  say "PUID PASSED"
}

# ── Main ─────────────────────────────────────────────────────────────────────────────────────────
MODE=${1:-all}
MODE=${MODE,,}
case "$MODE" in
  teardown) teardown; exit 0 ;;
  all) PHASES=(six default nokill puid) ;;
  six | default | nokill | puid) PHASES=("$MODE") ;;
  *) printf 'usage: bash e2e/media-isolation.sh [all|six|default|nokill|puid|teardown]   (default: all)\n' >&2; exit 2 ;;
esac

command -v docker >/dev/null || die "docker is not on PATH"
command -v curl >/dev/null || die "curl is not on PATH"
docker info >/dev/null 2>&1 || die "no Docker daemon answers"

if [ -n "${MEDIA_ISO_LOG_DIR:-}" ]; then
  LOG_DIR=$MEDIA_ISO_LOG_DIR
  mkdir -p "$LOG_DIR"
else
  LOG_DIR=$(mktemp -d)
fi

trap teardown EXIT
teardown

say "Setting up"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
ok "image $IMAGE ($(docker image inspect -f '{{.Id}}' "$IMAGE"))"
docker network create --label "$LABEL" "$NET" >/dev/null
ok "network $NET, host port $PORT, container logs in $LOG_DIR"

# Each part in its own subshell, as in hardened.sh: one that fails does not hide the others' results.
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
  if [ "$rc" = 0 ]; then RESULTS+=("  OK    $phase"); else RESULTS+=("  FAIL  $phase"); FAILED=1; fi
done

say "Summary"
printf '%s\n' "${RESULTS[@]}"
if [ "$FAILED" = 0 ]; then
  say "MEDIA ISOLATION CHECKS PASSED"
else
  say "MEDIA ISOLATION CHECKS FAILED"
  exit 1
fi
