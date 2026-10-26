#!/usr/bin/env bash
# Media isolation (#553, phases 1 and 2b), proven against the real image.
#
# With media isolation ASKED FOR (since #553 phase 4 that is the DEFAULT: no variable is set in the on-cases below; only
# NIGHTLIGHT_MEDIA_ISOLATION=0 turns it off, backend/entrypoint.sh, "Media isolation") the start-up
# script dry-runs the chain as root and, if it works, starts the app through `setpriv` with CAP_SETUID, CAP_SETGID and
# CAP_KILL as ambient capabilities; the app then starts every ffmpeg, ffprobe and MediaMTX through media-exec.sh as the
# media user (uid:gid 1700:1700, no capabilities). If the dry run fails it starts the usual way (su-exec), says why in
# ONE warning line, and GET /api/about reports mediaIsolation "off". This script checks both halves:
#   six      the documented hardening (six capabilities + no-new-privileges): node runs as PUID:PGID with CapEff 0xe0
#            (setuid, setgid, kill) and NoNewPrivs 1; every media process runs as 1700:1700 with only group 1700, all
#            four Cap* sets 0 and NoNewPrivs 1; healthy, HLS from the synthetic camera, About says "on", the dry run
#            left no temporary folder, and `docker stop` is clean; and, phase 2b, THE LAYOUT (check_media_layout):
#              - the ring fills, an on-demand recording is made by the media user and served from the open descriptor
#                (200, 206 for a range and a suffix, 416, HEAD, the thumbnail), the modes and owners are the documented
#                ones, no setgid bit anywhere;
#              - AS THE MEDIA USER (docker exec -u 1700): the database, its log, .jwt_secret, private/ and the data directory
#                cannot be opened or listed (the control: the app user reads them); it writes in its leaf and cannot
#                rename .ring, the leaf or the clips folder, nor create anything beside them;
#              - a symbolic link and a hard link under a clip's name, pointing at the database, are answered 404, the
#                database is not served, and deleting the recording removes the link and leaves the database;
#              - a newline in a ring file's name is ignored and logged, and the cuts that follow succeed;
#              - `docker stop` exits 0 and a recording still running is cut and saved.
#            NOT DRIVEN: a timelapse. It needs a child, a sleep window and a night's frames, none of which the synthetic
#            camera can fake in a short run; its folders are covered by backend/test/media-layout.test.js and the
#            timelapse unit tests, not by this script.
#   default  plain Docker defaults: the same;
#   control  the NEGATIVE CONTROL, in the same run: the kill switch, NIGHTLIGHT_MEDIA_ISOLATION=0. FFmpeg and MediaMTX then run as the app's own uid,
#            and that uid reads the database, which is exactly what the denials above would be worthless without;
#   nokill   the six capabilities WITHOUT KILL: the dry run fails, the container still starts the usual way and
#            serves HLS, the one warning names the failed drop, About says "off", and nothing runs as 1700;
#   puid     PUID=1700: isolation is refused before any dry run, the same fallback, and the warning says why.
# A negative case that does NOT see its signature fails this script, as hardened.sh's controls do.
#
#   bash e2e/media-isolation.sh            # all five
#   bash e2e/media-isolation.sh six        # or default, control, nokill, puid: one part only
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
# The exact failure of the app's drop without KILL (setpriv's own words, seen in CI run 40177805392), not merely "the
# dry run failed": any other launch failure must not pass this control.
NOKILL_REASON='with CAP_SETUID, CAP_SETGID and CAP_KILL (exit 127: setpriv: apply capabilities'
PUID_REASON="PUID or PGID is $MEDIA_ID"

# ── Start ────────────────────────────────────────────────────────────────────────────────────────
start_iso_app() { # name volume six|default|nokill|plain [puid]   (plain = Docker defaults and the kill switch NIGHTLIGHT_MEDIA_ISOLATION=0: isolation off; the others set NO switch, so they run the DEFAULT)
  local name=$1 vol=$2 kind=$3 puid=${4:-$APP_PUID} cap leave_out=
  local -a flags=() switch=()
  case "$kind" in
    six | nokill)
      if [ "$kind" = nokill ]; then leave_out=KILL; fi
      flags=(--cap-drop=ALL)
      while read -r cap; do flags+=("--cap-add=$cap"); done < <(caps_without "$leave_out")
      flags+=("--security-opt=$NO_NEW_PRIVS")
      ;;
    default) ;;
    plain) switch=(-e NIGHTLIGHT_MEDIA_ISOLATION=0) ;;
    *) die "unknown kind '$kind'" ;;
  esac
  docker run -d --name "$name" --label "$LABEL" --label "$ROLE_APP" \
    --network "$NET" -p "127.0.0.1:$PORT:4000" \
    -e TZ=UTC -e "PUID=$puid" -e "PGID=$APP_PGID" "${switch[@]}" \
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
      # Off must be the start as before #553: the media group only ever comes from the isolated start's --groups.
      case " $groups " in *" $MEDIA_ID "*) bad=1; info "^ the media group $MEDIA_ID is among its groups with isolation off" ;; esac
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
    ok "$n processes: everything under tini runs as $auid:$agid with no capabilities and no group $MEDIA_ID (the usual start)"
  fi
}

# The dry run's mktemp -d folder must be gone (media-probe.sh removes it on every exit path).
check_no_probe_leftovers() { # container
  local left
  left=$(docker exec "$1" sh -c 'ls -d /tmp/tmp.* 2>/dev/null || true')
  [ -z "$left" ] || die "the dry run left something behind in /tmp: $left"
  ok "the dry run left no temporary folder in /tmp"
}

# ── The media layout, proven AS THE MEDIA USER (#553 phase 2b) ──────────────────────────────────
# The container's own view: `docker exec -u 1700:1700` is a process with the media user's ids, so what it cannot open or
# change is what a compromised ffmpeg cannot. (`docker exec` cannot add the media process's NoNewPrivs and empty capability
# sets, which check_iso_processes reads from /proc; here the question is file access, which depends on the ids only.)
DATA=/app/data
CLIPS=$DATA/clips   # CLIPS_DIR is not set in these runs: the default, under the data directory
SQLITE_MAGIC='SQLite format 3'
as_media() { local c=$1; shift; docker exec -u "$MEDIA_ID:$MEDIA_ID" "$c" "$@"; }
as_app() { local c=$1; shift; docker exec -u "$APP_PUID:$APP_PGID" "$c" "$@"; }
as_root() { local c=$1; shift; docker exec -u 0 "$c" "$@"; }

# "mode uid:gid" of a path, as root (DAC_OVERRIDE or not, root can stat).
mode_of() { as_root "$1" stat -c '%a %u:%g' "$2"; }
expect_mode() { # container, path, "mode uid:gid", why
  local got
  got=$(mode_of "$1" "$2") || die "cannot stat $2 in $1"
  [ "$got" = "$3" ] || die "$2 is '$got', expected '$3' ($4)"
}

# GET with curl: sets HTTP_CODE and HTTP_HEADERS (lower-cased) and writes the body to $1.
HTTP_CODE=
HTTP_HEADERS=
http() { # body file, curl args...
  local body=$1 hdr; shift
  hdr=$(mktemp)
  HTTP_CODE=$(curl -sS -m 60 -o "$body" -D "$hdr" -w '%{http_code}' "$@") || { rm -f "$hdr"; die "curl failed: $*"; }
  HTTP_HEADERS=$(tr 'A-Z' 'a-z' < "$hdr" | tr -d '\r')
  rm -f "$hdr"
}
header() { printf '%s\n' "$HTTP_HEADERS" | sed -n "s/^$1: *//p" | head -n 1; }
num_field() { sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -n 1; }

# Poll for a command to succeed, up to $1 seconds.
wait_until() { # seconds, what, command...
  local t=$1 what=$2 i; shift 2
  for i in $(seq 1 "$t"); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "timed out after ${t}s waiting for: $what"
}

logs_have() { docker logs "$1" 2>&1 | grep -qF -- "$2"; } # container, text

ring_has_segments() { # container, how many
  local n
  n=$(as_root "$1" sh -c "ls '$CLIPS/.ring/$CAMERA_ID' 2>/dev/null | grep -c '^seg-[0-9]*-[0-9]*\\.mkv\$'" || true)
  [ "${n:-0}" -ge "$2" ]
}
can_record() { curl -fsS -m 15 "$BASE/api/cameras" -H "Authorization: Bearer $AUTH_TOKEN" | grep -q '"can_record":true'; }

# Record on demand for a few seconds and stop: prints the recording's id.
record_a_clip() { # container
  local started stopped id
  started=$(curl -fsS -m 30 -X POST "$BASE/api/cameras/$CAMERA_ID/record/start" -H "Authorization: Bearer $AUTH_TOKEN") || die "record/start failed"
  case "$started" in *'"recording":true'*) ;; *) die "record/start did not start a recording: $started" ;; esac
  sleep 8
  stopped=$(curl -fsS -m 120 -X POST "$BASE/api/cameras/$CAMERA_ID/record/stop" -H "Authorization: Bearer $AUTH_TOKEN") || die "record/stop failed"
  id=$(printf '%s' "$stopped" | num_field recording_id)
  [ -n "$id" ] || die "record/stop returned no recording: $stopped"
  printf '%s' "$id"
}

recording_file() { # container, id -> the path of its MP4 inside the container
  local f
  f=$(as_root "$1" sh -c "ls -t '$CLIPS/$CAMERA_ID'/*.mp4 2>/dev/null | head -n 1") || true
  [ -n "$f" ] || die "no MP4 in $CLIPS/$CAMERA_ID after recording $2"
  printf '%s' "$f"
}

# The whole layout, on a running container with isolation ON.
check_media_layout() { # container, part
  local c=$1 part=$2 body rec rec2 f f2 size
  body=$(mktemp)
  say "$part: the media layout, tried as the media user"

  wait_until 90 "the ring to hold 3 segments" ring_has_segments "$c" 3
  ok "the ring fills (segments written by ffmpeg as the media user)"
  wait_until 90 "the camera to report can_record" can_record
  ok "the camera reports it can record"

  # Modes and owners: the data directory is for passing through, the write folders are sticky and the app's.
  expect_mode "$c" "$DATA" "710 $APP_PUID:$MEDIA_ID" "traverse only, the media group"
  expect_mode "$c" "$DATA/private" "700 $APP_PUID:$APP_PGID" "the app's alone"
  expect_mode "$c" "$CLIPS" "750 $APP_PUID:$MEDIA_ID" "list, no write"
  expect_mode "$c" "$CLIPS/.ring" "750 $APP_PUID:$MEDIA_ID" "a folder the app trusts"
  expect_mode "$c" "$CLIPS/.ring/$CAMERA_ID" "1770 $APP_PUID:$MEDIA_ID" "a leaf: sticky, group-writable, app-owned, no setgid bit"
  f=$(as_root "$c" sh -c "ls '$CLIPS/.ring/$CAMERA_ID' | grep '^seg-' | head -n 1")
  [ "$(mode_of "$c" "$CLIPS/.ring/$CAMERA_ID/$f")" = "660 $MEDIA_ID:$MEDIA_ID" ] || die "a ring segment is '$(mode_of "$c" "$CLIPS/.ring/$CAMERA_ID/$f")', expected 660 $MEDIA_ID:$MEDIA_ID (written by the media user, umask 007)"
  ok "modes: data 710, private 700, clips 750, .ring 750, the ring leaf 1770; a segment is 660 $MEDIA_ID:$MEDIA_ID; no setgid bit anywhere"

  # What the media user cannot reach. The control (the app user CAN read them) makes the denial mean something.
  [ "$(as_app "$c" head -c 15 "$DATA/private/babymonitor.db")" = "$SQLITE_MAGIC" ] || die "control: the app user cannot read the database"
  as_app "$c" test -s "$DATA/private/.jwt_secret" || die "control: the app user cannot read .jwt_secret"
  if as_media "$c" cat "$DATA/private/babymonitor.db" >/dev/null 2>&1; then die "the media user READ the database"; fi
  if as_media "$c" cat "$DATA/private/.jwt_secret" >/dev/null 2>&1; then die "the media user READ .jwt_secret"; fi
  if as_media "$c" ls "$DATA/private" >/dev/null 2>&1; then die "the media user LISTED private/"; fi
  if as_media "$c" ls "$DATA" >/dev/null 2>&1; then die "the media user LISTED the data directory"; fi
  if as_media "$c" sh -c "cat $DATA/private/babymonitor.db-wal" >/dev/null 2>&1; then die "the media user read the write-ahead log"; fi
  ok "as the media user: the database, its log, .jwt_secret, private/ and the data directory itself cannot be opened or listed (the app user reads them)"

  # What it can and cannot do in the clips tree.
  as_media "$c" sh -c "touch '$CLIPS/.ring/$CAMERA_ID/leaf-probe' && rm '$CLIPS/.ring/$CAMERA_ID/leaf-probe'" || die "the media user cannot write in its own ring leaf"
  for victim in "$CLIPS/.ring" "$CLIPS/.ring/$CAMERA_ID" "$CLIPS"; do
    if as_media "$c" mv "$victim" "$victim-moved" >/dev/null 2>&1; then die "the media user RENAMED $victim"; fi
  done
  for planted in "$CLIPS/planted" "$CLIPS/.ring/planted" "$CLIPS/.concat/planted"; do
    if as_media "$c" touch "$planted" >/dev/null 2>&1; then die "the media user created $planted in a folder the app trusts"; fi
  done
  if as_media "$c" mkdir "$CLIPS/.ring/evil" >/dev/null 2>&1; then die "the media user made a folder in .ring"; fi
  ok "as the media user: writes in its leaf; cannot rename .ring, the leaf or the clips folder, nor create anything beside them"

  # A name with a newline in the ring must not reach the concat list: it is ignored and logged, and the next recording works.
  as_media "$c" sh -c "cd '$CLIPS/.ring/$CAMERA_ID' && touch \"\$(printf 'seg-20200101-000000.mkv\\nfile hostile')\"" || die "could not plant a hostile ring name"

  # On demand: record, then serve it with the Range requests a <video> makes.
  rec=$(record_a_clip "$c")
  f=$(recording_file "$c" "$rec")
  size=$(as_root "$c" stat -c %s "$f")
  [ "$(mode_of "$c" "$f")" = "660 $MEDIA_ID:$MEDIA_ID" ] || die "the clip is '$(mode_of "$c" "$f")', expected 660 $MEDIA_ID:$MEDIA_ID (ffmpeg wrote it as the media user)"
  expect_mode "$c" "$CLIPS/$CAMERA_ID" "1770 $APP_PUID:$MEDIA_ID" "the clip leaf"
  expect_mode "$c" "$CLIPS/.concat/$CAMERA_ID" "750 $APP_PUID:$MEDIA_ID" "the concat-list folder: the media user reads, never writes"
  http "$body" "$BASE/api/recordings/$rec/video?token=$MEDIA_TOKEN"
  [ "$HTTP_CODE" = 200 ] || die "GET video: $HTTP_CODE"
  [ "$(header content-type)" = video/mp4 ] || die "content-type is '$(header content-type)'"
  [ "$(header content-length)" = "$size" ] || die "content-length is '$(header content-length)', the file is $size"
  [ "$(header accept-ranges)" = bytes ] || die "accept-ranges is '$(header accept-ranges)'"
  [ "$(wc -c < "$body")" = "$size" ] || die "the body is $(wc -c < "$body") bytes, the file is $size"
  [ "$(head -c 8 "$body" | tail -c 4)" = ftyp ] || die "the body is not an MP4"
  http "$body" "$BASE/api/recordings/$rec/video?token=$MEDIA_TOKEN" -H 'Range: bytes=0-99'
  [ "$HTTP_CODE" = 206 ] || die "Range 0-99: $HTTP_CODE"
  [ "$(header content-range)" = "bytes 0-99/$size" ] || die "content-range is '$(header content-range)'"
  [ "$(wc -c < "$body")" = 100 ] || die "Range 0-99 returned $(wc -c < "$body") bytes"
  http "$body" "$BASE/api/recordings/$rec/video?token=$MEDIA_TOKEN" -H 'Range: bytes=-100'
  [ "$HTTP_CODE" = 206 ] && [ "$(header content-range)" = "bytes $((size - 100))-$((size - 1))/$size" ] || die "suffix Range: $HTTP_CODE $(header content-range)"
  http "$body" "$BASE/api/recordings/$rec/video?token=$MEDIA_TOKEN" -H "Range: bytes=$size-"
  [ "$HTTP_CODE" = 416 ] && [ "$(header content-range)" = "bytes */$size" ] || die "Range past the end: $HTTP_CODE $(header content-range)"
  http "$body" -I "$BASE/api/recordings/$rec/video?token=$MEDIA_TOKEN"
  [ "$HTTP_CODE" = 200 ] && [ "$(header content-length)" = "$size" ] || die "HEAD: $HTTP_CODE $(header content-length)"
  http "$body" "$BASE/api/recordings/$rec/thumb?token=$MEDIA_TOKEN"
  [ "$HTTP_CODE" = 200 ] && [ "$(header content-type)" = image/jpeg ] || die "thumbnail: $HTTP_CODE $(header content-type)"
  ok "an on-demand recording ($rec, $size bytes) is made by the media user and served: 200 with its length, 206 for a range and a suffix, 416 past the end, HEAD, and its thumbnail"

  # A symbolic link planted under the clip's name, pointing at the database: refused, and nothing is deleted or overwritten.
  as_media "$c" sh -c "rm -f '$f' && ln -s '$DATA/private/babymonitor.db' '$f'" || die "could not plant the symbolic link"
  http "$body" "$BASE/api/recordings/$rec/video?token=$MEDIA_TOKEN"
  [ "$HTTP_CODE" = 404 ] || die "a symbolic link to the database was answered $HTTP_CODE, expected 404"
  if grep -q "$SQLITE_MAGIC" "$body"; then die "the database was SERVED through a symbolic link"; fi
  [ "$(as_app "$c" head -c 15 "$DATA/private/babymonitor.db")" = "$SQLITE_MAGIC" ] || die "the database changed while a symbolic link pointed at it"
  http "$body" -X DELETE "$BASE/api/recordings/$rec" -H "Authorization: Bearer $AUTH_TOKEN"
  [ "$HTTP_CODE" = 200 ] || die "deleting the recording whose file is a link: $HTTP_CODE"
  if as_root "$c" test -e "$f" -o -L "$f"; then die "the link is still there after the recording was deleted"; fi
  [ "$(as_app "$c" head -c 15 "$DATA/private/babymonitor.db")" = "$SQLITE_MAGIC" ] || die "deleting a recording whose file was a link damaged the database"
  curl -fsS -m 15 "$BASE/api/health" >/dev/null || die "the app stopped answering after the symbolic-link test"
  ok "a symbolic link to the database under a clip's name: 404, the database is not served, deleting the recording removes the link and leaves the database"

  # The media user cannot make a hard link to the database (it cannot reach it)...
  if as_media "$c" ln "$DATA/private/babymonitor.db" "$CLIPS/$CAMERA_ID/hard-by-media" >/dev/null 2>&1; then die "the media user made a hard link to the database"; fi
  # ...and if a host let it (fs.protected_hardlinks is 0 on some), the app still refuses to serve it: planted here by root.
  rec2=$(record_a_clip "$c")
  f2=$(recording_file "$c" "$rec2")
  as_media "$c" rm -f "$f2" || die "could not remove the second clip"
  as_root "$c" ln "$DATA/private/babymonitor.db" "$f2" || die "could not plant the hard link"
  [ "$(as_root "$c" stat -c %h "$DATA/private/babymonitor.db")" = 2 ] || die "precondition: the database has two names"
  http "$body" "$BASE/api/recordings/$rec2/video?token=$MEDIA_TOKEN"
  [ "$HTTP_CODE" = 404 ] || die "a hard link to the database was answered $HTTP_CODE, expected 404"
  if grep -q "$SQLITE_MAGIC" "$body"; then die "the database was SERVED through a hard link"; fi
  http "$body" -X DELETE "$BASE/api/recordings/$rec2" -H "Authorization: Bearer $AUTH_TOKEN"
  [ "$HTTP_CODE" = 200 ] || die "deleting the recording whose file is a hard link: $HTTP_CODE"
  [ "$(as_root "$c" stat -c %h "$DATA/private/babymonitor.db")" = 1 ] || die "the database still has two names after the delete (the link was not the one removed)"
  [ "$(as_app "$c" head -c 15 "$DATA/private/babymonitor.db")" = "$SQLITE_MAGIC" ] || die "the database was damaged by the hard-link test"
  ok "the media user cannot hard-link the database; a hard link planted by root is 404, and the delete removes the link, not the database"

  # The hostile ring name was ignored, logged (once, when the janitor next lists the ring), and the recordings above worked.
  wait_until 60 "the hostile ring name to be reported" logs_have "$c" 'is not a segment name'
  logs_have "$c" '[rec] recording ' || die "no recording was reported"
  as_media "$c" sh -c "cd '$CLIPS/.ring/$CAMERA_ID' && rm -f seg-20200101-000000.mkv*" >/dev/null 2>&1 || true
  ok "a newline in a ring file's name was ignored (and logged); the cuts that followed succeeded"

  rm -f "$body"
}

# A recording left running when the container is stopped must be saved (the shutdown cut), not lost.
STOP_REC_ID=
start_unfinished_recording() { # container
  local started
  started=$(curl -fsS -m 30 -X POST "$BASE/api/cameras/$CAMERA_ID/record/start" -H "Authorization: Bearer $AUTH_TOKEN") || die "record/start failed"
  STOP_REC_ID=$(printf '%s' "$started" | num_field id)
  [ -n "$STOP_REC_ID" ] || die "no recording id in: $started"
  sleep 6
  ok "a recording ($STOP_REC_ID) is running as the container is stopped"
}
check_recording_saved_on_stop() { # log, volume, part
  grep -qE "\[rec\] recording $STOP_REC_ID ready for" "$1" || die_log "$1" "$3: the recording in progress ($STOP_REC_ID) was not saved on stop"
  local left
  left=$(docker run --rm --network none --label "$LABEL" --entrypoint sh -v "$2:/app/data" "$IMAGE" -c "ls /app/data/clips/$CAMERA_ID/*.mp4 2>/dev/null | wc -l")
  [ "${left:-0}" -ge 1 ] || die "$3: no MP4 in the volume after the stop"
  ok "$3: the recording in progress at docker stop was cut and saved ($left MP4 in the volume)"
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
  check_media_layout "$c" "$part"
  start_unfinished_recording "$c"
  stop_app "$c"
  log=$(save_log "$c")
  show_startup "$log"   # every [entrypoint] line, the media isolation ones included
  grep -qF "$ON_LINE" "$log" || die_log "$log" "$part: no '$ON_LINE' line"
  if grep -qF "$OFF_LINE" "$log"; then die_log "$log" "$part: the start-up script also said isolation is off"; fi
  check_clean_stop "$c" "$log" "$part"
  check_recording_saved_on_stop "$log" "$vol" "$part"
  docker rm "$c" >/dev/null
}

phase_six() {
  say "SIX: isolation by default (no switch) under the documented hardening (--cap-drop=ALL + ${HARDENING_CAPS[*]}, $NO_NEW_PRIVS)"
  iso_on_case six six
  say "SIX PASSED"
}

# The negative control: isolation off by the kill switch (NIGHTLIGHT_MEDIA_ISOLATION=0). The process that parses the camera's stream is the app's own uid, so it
# reads the database: the layout checks in the on-cases are about a difference that exists.
phase_control() {
  local c="$PROJECT-control" vol="$PROJECT-control-data" log
  say "CONTROL: NIGHTLIGHT_MEDIA_ISOLATION=0 (isolation off); the media processes are the app's own user, who reads the database"
  cleanup_apps
  new_volume "$vol"
  start_fakecam
  start_iso_app "$c" "$vol" plain
  healthy_or_die "$c" "control"
  camera_and_hls "$c"
  check_iso_processes "$c" off "$APP_PUID" "$APP_PGID"
  check_media_isolation_reported off
  [ "$(as_app "$c" head -c 15 "$DATA/private/babymonitor.db")" = "$SQLITE_MAGIC" ] || die "control: the app's uid cannot read the database"
  ok "isolation off: ffmpeg and MediaMTX run as $APP_PUID:$APP_PGID, and that uid reads the database: the old access, so the media user's denial in the on-cases is a real difference"
  # The old layout is what it was: the data directory is the app's alone, no media group.
  expect_mode "$c" "$DATA" "700 $APP_PUID:$APP_PGID" "off: the data directory is owner-only, as before"
  stop_app "$c"
  log=$(save_log "$c")
  show_startup "$log"
  if grep -qF "$ON_LINE" "$log"; then die_log "$log" "control: isolation went on although the kill switch was set"; fi
  if grep -qF "$OFF_LINE" "$log"; then die_log "$log" "control: a warning about isolation although the kill switch was set"; fi
  check_clean_stop "$c" "$log" "control"
  docker rm "$c" >/dev/null
  say "CONTROL PASSED"
}

phase_default() {
  say "DEFAULT: isolation by default (no switch) with Docker's default capabilities"
  iso_on_case default default
  say "DEFAULT PASSED"
}

# A fallback: the container starts the usual way, says why once, reports off, and still streams.
iso_off_case() { # part name, kind, puid, expected reason, app uid, [keep: reuse the volume of an earlier ON run]
  local part=$1 kind=$2 puid=$3 reason=$4 auid=$5 keep=${6:-} vol="$PROJECT-$1-data" c="$PROJECT-$1" log warn
  cleanup_apps
  if [ -z "$keep" ]; then new_volume "$vol"; fi
  start_fakecam
  start_iso_app "$c" "$vol" "$kind" "$puid"
  healthy_or_die "$c" "$part (expected to start the usual way)"
  if [ -n "$keep" ]; then
    sign_in_again
    wait_until 120 "the camera's ring to come back" can_record
  else
    camera_and_hls "$c"
  fi
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
#
# #553 phase 2b review of PR #871: the fallback FOLLOWS AN ON RUN on the same volume. The ON run leaves clips owned by the
# media user (1700:1700, 0660) in a tree with the media group; the fallback start runs the app without that group, so
# unless the start-up script gives the tree back to the app, the existing clips cannot be served. Checked here with a
# real clip, through the API.
sign_in_again() {
  local r
  r=$(curl -fsS -m 15 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"username":"e2e","password":"e2e-admin-pw"}') || die "sign-in on the reused volume failed"
  AUTH_TOKEN=$(printf '%s' "$r" | field token)
  [ -n "$AUTH_TOKEN" ] || die "no token from sign-in: $r"
  MEDIA_TOKEN=$(curl -fsS -m 15 -X POST "$BASE/api/auth/media-token" -H "Authorization: Bearer $AUTH_TOKEN" | field token) || true
  [ -n "$MEDIA_TOKEN" ] || die "could not mint a media token"
  ok "signed in again on the reused volume (the earlier ON run's database)"
}

phase_nokill() {
  local c1="$PROJECT-nokill-on" vol="$PROJECT-nokill-data" c="$PROJECT-nokill" rec f body log
  say "NOKILL: an ON run first (to leave media-owned clips), then the default (no switch) with the six capabilities without KILL; the dry run must fail and the app start as before, with the clips still served"
  cleanup_apps
  new_volume "$vol"
  start_fakecam
  start_iso_app "$c1" "$vol" six
  healthy_or_die "$c1" "nokill (the earlier ON run)"
  camera_and_hls "$c1"
  check_media_isolation_reported on
  wait_until 90 "the ring to hold 3 segments" ring_has_segments "$c1" 3
  wait_until 90 "the camera to report can_record" can_record
  rec=$(record_a_clip "$c1")
  f=$(recording_file "$c1" "$rec")
  [ "$(mode_of "$c1" "$f")" = "660 $MEDIA_ID:$MEDIA_ID" ] || die "precondition: the ON run's clip is '$(mode_of "$c1" "$f")', expected 660 $MEDIA_ID:$MEDIA_ID"
  ok "an ON run left a media-owned clip (recording $rec: 660 $MEDIA_ID:$MEDIA_ID)"
  stop_app "$c1"
  docker rm "$c1" >/dev/null

  iso_off_case nokill nokill "$APP_PUID" "$NOKILL_REASON" "$APP_PUID" keep
  log=$(save_log "$c")
  grep -qF 'an earlier start had it on' "$log" || die_log "$log" "nokill: the fallback did not give the media-owned tree back to the app"
  [ "$(mode_of "$c" "$f")" = "600 $APP_PUID:$APP_PGID" ] || die "the clip after the fallback is '$(mode_of "$c" "$f")', expected 600 $APP_PUID:$APP_PGID (the app's, tightened)"
  body=$(mktemp)
  http "$body" "$BASE/api/recordings/$rec/video?token=$MEDIA_TOKEN"
  [ "$HTTP_CODE" = 200 ] || die "the clip made by the ON run is answered $HTTP_CODE after the fallback, expected 200"
  [ "$(head -c 8 "$body" | tail -c 4)" = ftyp ] || die "the clip served after the fallback is not an MP4"
  rm -f "$body"
  ok "after the fallback the clip made while isolation was on is the app's again and is still served (200, an MP4)"
  docker rm -f "$c" >/dev/null
  say "NOKILL PASSED"
}

# PUID=1700: the app would BE the media user. Refused before any dry run; everything runs as 1700, as before #553 it
# would have for that PUID. Plain defaults, so the stop can be checked too.
phase_puid() {
  local c="$PROJECT-puid" log
  say "PUID: isolation by default (no switch) with PUID=$MEDIA_ID; isolation must be refused and the app start as before"
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
  all) PHASES=(six default control nokill puid) ;;
  six | default | control | nokill | puid) PHASES=("$MODE") ;;
  *) printf 'usage: bash e2e/media-isolation.sh [all|six|default|control|nokill|puid|teardown]   (default: all)\n' >&2; exit 2 ;;
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
