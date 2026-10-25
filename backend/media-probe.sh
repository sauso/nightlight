#!/bin/sh
# The dry run of media isolation (#553). backend/entrypoint.sh starts it, as root, through the app's OWN launcher:
#   setpriv $APP_DROP -- /bin/sh media-probe.sh app <media-exec.sh> <media id> <app uid>
# so this runs as the app, with exactly the capabilities the app will have. From there it starts a media process
# through the SAME media-exec.sh the app's spawnChild uses, and checks what the kernel actually gave it:
#   - the media process runs as <media id> (uid and gid, all four of each) with ONLY that group;
#   - CapInh, CapPrm, CapEff and CapAmb are all zero, and NoNewPrivs is 1;
#   - it cannot read a 0600 file the app just made (and CAN read a 0644 one beside it, the control that proves the
#     folder was reachable, so the first check is not passing for the wrong reason);
#   - it cannot setpriv back to the app's uid, or to root;
#   - the programs the app really starts (ffmpeg, ffprobe, MediaMTX) run under the wrapper as the media user, so a
#     binary the media user cannot execute switches isolation off here instead of failing every camera later
#     (review of PR #869);
#   - the wrapper keeps the pid it was started with (media-exec.sh `exec`s), and the app can kill that pid (CAP_KILL
#     across uids: the app signals its media children on every stop).
# Output: the LAST line is MEDIA-PROBE-OK (exit 0), or a line `MEDIA-PROBE-FAIL <reason>` (exit 1). The entrypoint
# switches isolation on only for the first, and prints the reason for the second.
# It leaves nothing behind: its one temporary folder (mktemp -d, so $TMPDIR or /tmp) is removed on every exit path,
# and the process it starts for the kill check is killed by that check, or ends by itself within 10 s.
# No `set -e`: every step checks its own status, so a failure is always a FAIL line, never a silent stop.

fail() {
  printf 'MEDIA-PROBE-FAIL %s\n' "$*"
  exit 1
}

# One field of /proc/<pid>/status, its values joined by single spaces ("Uid:\t99\t99\t99\t99" -> "99 99 99 99").
# Read with the shell's own `read`, not a command such as `id`: nothing on PATH can answer for the kernel here.
status_field() {
  _want="$2:"
  while IFS= read -r _line; do
    case "$_line" in
      "$_want"*)
        # Unquoted on purpose: splits the tab-separated values into words.
        # shellcheck disable=SC2086
        set -- ${_line#"$_want"}
        printf '%s' "$*"
        return 0
        ;;
    esac
  done < "/proc/$1/status"
  return 1
}

# As the media user, started by app_probe below through media-exec.sh.
media_probe() {
  dir=$1 media_id=$2 app_uid=$3
  four="$media_id $media_id $media_id $media_id"
  got=$(status_field $$ Uid) || fail "a media process could not read its own status"
  [ "$got" = "$four" ] || fail "a media process ran as uid '$got', expected $media_id"
  got=$(status_field $$ Gid)
  [ "$got" = "$four" ] || fail "a media process ran as gid '$got', expected $media_id"
  got=$(status_field $$ Groups)
  [ "$got" = "$media_id" ] || fail "a media process had the groups '$got', expected only $media_id"
  for f in CapInh CapPrm CapEff CapAmb; do
    got=$(status_field $$ "$f")
    [ "$got" = 0000000000000000 ] || fail "a media process kept capabilities ($f $got)"
  done
  got=$(status_field $$ NoNewPrivs)
  [ "$got" = 1 ] || fail "a media process has NoNewPrivs '$got', expected 1"
  cat "$dir/anyone" >/dev/null 2>&1 \
    || fail "a media process could not read a file every user may read in $dir, so the next check would prove nothing"
  if cat "$dir/app-only" >/dev/null 2>&1; then
    fail "a media process could read a file only the app may read"
  fi
  for u in "$app_uid" 0; do
    if setpriv --reuid="$u" -- true >/dev/null 2>&1; then
      fail "a media process could switch to uid $u"
    fi
  done
  printf 'MEDIA-CHILD-OK\n'
}

# As the app, started by the entrypoint through the app's own launcher.
app_probe() {
  media_exec=$1 media_id=$2 app_uid=$3
  got=$(status_field $$ Uid) || fail "the app could not read its own status"
  [ "$got" = "$app_uid $app_uid $app_uid $app_uid" ] || fail "the app's drop did not take: it ran as uid '$got', expected $app_uid"

  dir=$(mktemp -d) || fail "could not create a temporary folder"
  # The two named files, then the folder: nothing recursive.
  trap 'rm -f -- "$dir/app-only" "$dir/anyone"; rmdir -- "$dir"' EXIT
  # The media user may enter the folder but not list it; one file only the app may read, one anyone may.
  chmod 711 "$dir" || fail "could not set up the temporary folder"
  ( umask 077 && printf 'app only\n' > "$dir/app-only" ) || fail "could not write the probe files"
  ( umask 022 && printf 'anyone\n' > "$dir/anyone" ) || fail "could not write the probe files"
  # Belt and braces against an unusual umask: these two modes are the whole point of the check.
  { chmod 600 "$dir/app-only" && chmod 644 "$dir/anyone"; } || fail "could not set the probe files' modes"

  # `env -i PATH=...`: the environment the app's spawnChild gives a child is an allowlist (childEnv.js), not the
  # entrypoint's whole environment; PATH is the part media-exec.sh needs (it finds setpriv by it).
  out=$(env -i PATH="$PATH" "$media_exec" /bin/sh "$0" media "$dir" "$media_id" "$app_uid" 2>&1)
  case "$out" in
    *MEDIA-PROBE-FAIL*) printf '%s\n' "$out" | grep '^MEDIA-PROBE-FAIL ' | head -n 1; exit 1 ;;
    *MEDIA-CHILD-OK*) ;;
    *) fail "a media process could not be started through $media_exec ($(printf '%s\n' "$out" | sed '/^$/d' | tail -n 1))" ;;
  esac

  # The real programs, under the wrapper, as the media user: the names the app's spawn sites use (spawnChild's
  # callers), found on PATH as they will be. Each asked only for its version, which needs no camera and no file.
  # Exit 127 (not found) or 126 (not executable) from setpriv, or anything else non-zero, is a failure.
  for prog in ffmpeg:-version ffprobe:-version mediamtx:--version; do
    name=${prog%%:*}
    env -i PATH="$PATH" "$media_exec" "$name" "${prog#*:}" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] || fail "the media user cannot run $name (exit $rc)"
  done

  # PHASE 2 HOOK (#553): the shared-folder probe goes here. For each media mount the entrypoint passes: the media user
  # writes a file in its leaf folder, the app reads it, opens it without following links and unlinks it.

  # The kill check. `$!` is the pid of the job, i.e. of media-exec.sh: it has become the media process only if the
  # wrapper exec'd (into setpriv, which switches to the media uid and execs `sleep`). Wait for that uid on that pid,
  # then kill it as the app. About 5 s in 0.1 s steps: normally the first look already sees it. A `sleep` without
  # fractions (some minimal systems) falls back to whole seconds, counted as ten steps, so the budget stays ~5 s.
  env -i PATH="$PATH" "$media_exec" sleep 10 >/dev/null 2>&1 &
  pid=$!
  i=0
  while :; do
    got=$(status_field "$pid" Uid 2>/dev/null) || got=gone
    [ "${got%% *}" = "$media_id" ] && break
    if [ "$i" -ge 50 ]; then
      kill "$pid" 2>/dev/null
      fail "the media wrapper did not keep the pid it was started with (pid $pid runs as uid '${got%% *}'): does media-exec.sh exec?"
    fi
    if sleep 0.1 2>/dev/null; then i=$((i + 1)); else sleep 1; i=$((i + 10)); fi
  done
  kill "$pid" 2>/dev/null || fail "the app could not signal a media process (is CAP_KILL missing?)"
  wait "$pid"
  rc=$?
  [ "$rc" -gt 128 ] || fail "the media process the app signalled ended with status $rc, not by the signal"

  printf 'MEDIA-PROBE-OK\n'
}

case "${1:-}" in
  app) shift; app_probe "$@" ;;
  media) shift; media_probe "$@" ;;
  *) fail "usage: media-probe.sh app <media-exec.sh> <media id> <app uid>" ;;
esac
