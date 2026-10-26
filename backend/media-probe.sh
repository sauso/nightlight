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
#     across uids: the app signals its media children on every stop);
#   - THE FOLDERS (#553 phase 2b), when the entrypoint passes the clips folder and the data directory: on the real mounts,
#     the media user writes a file in a leaf folder and the app reads it, checks it has one name and unlinks it; the media
#     user reads a 0640 file the app wrote and not a 0600 one; it cannot create a file in a folder the app trusts, nor in an
#     app-only folder, nor rename a folder, nor delete a file the app owns in a leaf (sticky bit); and it can neither list the
#     data directory nor enter private/. This is the layout of src/lib/mediaLayout.js, tried before isolation is switched on.
#     The entrypoint runs the whole probe in the BACKGROUND with a deadline, because these steps touch mounts that can stall.
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

# As the media user, in the clips folder's probe folder $1 (made by folders_probe below, which lists what is in it).
media_folders() {
  p=$1 clips=$2
  cat "$p/in-0640" >/dev/null 2>&1 \
    || fail "a media process could not read a 0640 file the app wrote for it in $clips (is the clips folder reachable for the media group?)"
  if cat "$p/in-0600" >/dev/null 2>&1; then
    fail "a media process could read a 0600 file the app wrote in $clips"
  fi
  # A media process writes in a leaf. This is the file the app then reads, counts and removes.
  ( printf 'written by the media user\n' > "$p/leaf/from-media" ) 2>/dev/null \
    || fail "a media process could not create a file in a leaf folder in $clips (the layout of mediaLayout.js is not in place there)"
  # ...and nowhere else: not in the folder that holds the leaf, not in an app-only folder.
  if ( : > "$p/planted" ) 2>/dev/null; then fail "a media process could create a file in a folder the app trusts, in $clips"; fi
  if ( : > "$p/app-only/planted" ) 2>/dev/null; then fail "a media process could create a file in an app-only folder in $clips"; fi
  # ...it cannot rename a folder the app trusts, nor the leaf out from under it...
  if mv "$p/leaf" "$p/leaf-moved" 2>/dev/null; then fail "a media process could rename a leaf folder in $clips"; fi
  if mv "$p" "$p-moved" 2>/dev/null; then fail "a media process could rename a folder the app trusts, in $clips"; fi
  # ...and it cannot delete a file the app owns in a leaf (the sticky bit), even though the folder is group-writable.
  rm -f "$p/leaf/app-file" 2>/dev/null
  [ -e "$p/leaf/app-file" ] || fail "a media process could delete a file the app owns in a leaf folder in $clips (is the sticky bit missing?)"
  printf 'MEDIA-CHILD-OK\n'
}

# As the media user: the data directory is for passing through, not for looking at.
media_data() {
  data=$1
  if ls "$data" >/dev/null 2>&1; then fail "a media process could list the data directory $data"; fi
  if ( cd "$data/private" ) 2>/dev/null; then fail "a media process could enter $data/private"; fi
  if ls "$data/private" >/dev/null 2>&1; then fail "a media process could list $data/private"; fi
  printf 'MEDIA-CHILD-OK\n'
}

# As the app: build a probe folder in the clips folder with every kind of thing the layout has, let the media user try
# to use them (media_folders), then check what it wrote and remove it all. Named files only, nothing recursive.
folders_probe() {
  media_exec=$1 media_id=$2 clips=$3
  p="$clips/.probe-$"
  PROBE_P=$p
  mkdir -m 750 "$p" 2>/dev/null || fail "the app could not create a folder in the clips folder $clips (is it writable by the app?)"
  # mkdir -m is not cut by the umask; the group is set explicitly (no setgid inheritance anywhere, see mediaLayout.js).
  chgrp "$media_id" "$p" 2>/dev/null || fail "the app could not give a folder in $clips to the media group $media_id (is the app in that group?)"
  mkdir "$p/leaf" "$p/app-only" 2>/dev/null || fail "the app could not create folders in $clips"
  chgrp "$media_id" "$p/leaf" 2>/dev/null && chmod 1770 "$p/leaf" 2>/dev/null && chmod 700 "$p/app-only" 2>/dev/null \
    || fail "the app could not set up the leaf folder in $clips"
  ( umask 027 && printf 'for the media user\n' > "$p/in-0640" ) && chgrp "$media_id" "$p/in-0640" && chmod 640 "$p/in-0640" \
    || fail "the app could not write a file for the media user in $clips"
  ( umask 077 && printf 'app only\n' > "$p/in-0600" ) && chmod 600 "$p/in-0600" \
    || fail "the app could not write a private file in $clips"
  ( umask 027 && printf 'the app owns this\n' > "$p/leaf/app-file" ) && chgrp "$media_id" "$p/leaf/app-file" && chmod 640 "$p/leaf/app-file" \
    || fail "the app could not write a file in the leaf folder in $clips"

  out=$(env -i PATH="$PATH" "$media_exec" /bin/sh "$0" media-folders "$p" "$clips" 2>&1)
  case "$out" in
    *MEDIA-PROBE-FAIL*) printf '%s\n' "$out" | grep '^MEDIA-PROBE-FAIL ' | head -n 1; exit 1 ;;
    *MEDIA-CHILD-OK*) ;;
    *) fail "a media process could not be started in $clips ($(printf '%s\n' "$out" | sed '/^$/d' | tail -n 1))" ;;
  esac

  # What the app can do with what the media process wrote: read it, see that it has ONE name, remove it.
  f="$p/leaf/from-media"
  [ "$(cat "$f" 2>/dev/null)" = 'written by the media user' ] || fail "the app could not read a file the media user wrote in $clips (is the app in the media group?)"
  [ "$(stat -c %h "$f" 2>/dev/null)" = 1 ] || fail "a file the media user wrote in $clips does not have exactly one name"
  [ "$(stat -c %u:%g "$f" 2>/dev/null)" = "$media_id:$media_id" ] || fail "a file the media user wrote in $clips is not owned by $media_id:$media_id"
  rm -f -- "$f" || fail "the app could not remove a file the media user wrote in $clips"
  [ ! -e "$f" ] || fail "a file the media user wrote in $clips is still there after the app removed it"
}

# Everything folders_probe made, by name. Also on every failure path (the EXIT trap), so a refused probe leaves nothing.
folders_cleanup() {
  [ -n "${PROBE_P:-}" ] || return 0
  # Also under the name the media user would have renamed it to: a clips folder it can write to is exactly the fault this
  # probe exists to find, and a refusal must still leave nothing behind.
  for _q in "$PROBE_P" "$PROBE_P-moved"; do
    rm -f -- "$_q/in-0640" "$_q/in-0600" "$_q/leaf/app-file" "$_q/leaf/from-media" "$_q/planted" "$_q/app-only/planted"
    rmdir -- "$_q/leaf" "$_q/app-only" "$_q" 2>/dev/null
  done
  return 0
}

# As the app, then the media user: the data directory is closed to it.
data_probe() {
  media_exec=$1 data=$2
  [ -d "$data/private" ] || fail "$data/private does not exist, so there is nothing to keep the media user out of (the entrypoint makes it)"
  out=$(env -i PATH="$PATH" "$media_exec" /bin/sh "$0" media-data "$data" 2>&1)
  case "$out" in
    *MEDIA-PROBE-FAIL*) printf '%s\n' "$out" | grep '^MEDIA-PROBE-FAIL ' | head -n 1; exit 1 ;;
    *MEDIA-CHILD-OK*) ;;
    *) fail "a media process could not be started to check $data ($(printf '%s\n' "$out" | sed '/^$/d' | tail -n 1))" ;;
  esac
}

# As the app, started by the entrypoint through the app's own launcher.
app_probe() {
  media_exec=$1 media_id=$2 app_uid=$3 clips_dir=${4:-} data_dir=${5:-}
  got=$(status_field $$ Uid) || fail "the app could not read its own status"
  [ "$got" = "$app_uid $app_uid $app_uid $app_uid" ] || fail "the app's drop did not take: it ran as uid '$got', expected $app_uid"

  dir=$(mktemp -d) || fail "could not create a temporary folder"
  # The two named files, then the folder: nothing recursive.
  trap 'rm -f -- "$dir/app-only" "$dir/anyone"; rmdir -- "$dir"; folders_cleanup' EXIT
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

  # The media folders (#553 phase 2b): each real mount the entrypoint passes. The clips folder is where the media user
  # writes (an external CLIPS_DIR is its own mount, and is the one that can differ from the data directory's filesystem);
  # the data directory is the one it must not be able to look into. Skipped only when the caller passes neither (the
  # real-setpriv test of the phase 1 chain does not; the entrypoint always does).
  if [ -n "$clips_dir" ]; then folders_probe "$media_exec" "$media_id" "$clips_dir"; fi
  if [ -n "$data_dir" ]; then data_probe "$media_exec" "$data_dir"; fi

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
  media-folders) shift; media_folders "$@" ;;
  media-data) shift; media_data "$@" ;;
  *) fail "usage: media-probe.sh app <media-exec.sh> <media id> <app uid> [<clips folder> <data directory>]" ;;
esac
