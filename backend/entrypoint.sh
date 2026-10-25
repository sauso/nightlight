#!/bin/sh
set -e

# Same pattern LinuxServer.io's images use: the container starts as root (needed for
# the steps below), adjusts a pre-baked non-root user to whatever UID/GID you specify,
# fixes ownership of the data directory to match, then drops privileges entirely and
# execs the real app - which never runs as root at any point after this script exits.
#
# Defaults to 99/100 - Unraid's own "nobody"/"users" convention - rather than the more
# generic 1000/1000 seen elsewhere, since that's what actually matches an Unraid box's
# own file ownership out of the box. Override with PUID/PGID if you need something else.
PUID=${PUID:-99}
PGID=${PGID:-100}
DATA_DIR=${DATA_DIR:-/app/data}

# PUID=0 (#555) is accepted and `usermod -o -u 0` makes the "nightlight" user another uid 0, so the app, FFmpeg
# and MediaMTX would run as root, which this script exists to avoid and docs/architecture.md says never happens.
# It is a WARNING only, on purpose: refusing to start, or quietly substituting 99, would stop or re-own the data
# of an install that has run as 0 for years (an owner decision, listed in the PR), and a baby monitor must not
# fail to start over it. Matches 0, 00, 000 ...; a non-number is left to usermod to reject, as before.
case "$PUID" in
  ''|*[!0-9]*) ;;
  *)
    # Digits only, so "nothing left once the zeros are removed" means zero (no bash-only 10#, this is sh).
    if [ -z "$(printf '%s' "$PUID" | tr -d 0)" ]; then
      printf '[entrypoint] warning: PUID=0 runs the app as root. Set PUID to a non-zero user id (the default is 99); the app is meant never to run as root\n' >&2
    fi
    ;;
esac

# --- Who can read the data directory (#549) ---------------------------------------------------
# The database holds every secret the app has, in plaintext by design (camera passwords, provider
# tokens, MFA secrets, sessions), and the snapshots and clips show a child's bedroom. The FILE MODE
# is the only thing between them and every other account on the host, and until #549 everything
# here was created 0644 / 0755: readable by all of them. docs/operations.md, "Who can read the data
# directory", is the user-facing half of this block.
#
# UMASK: default 077 (owner only). Name and meaning follow the LinuxServer.io images Unraid users
# already know. Accepted: 3 or 4 octal digits whose OWNER digit is 0 (0[0-7][0-7] or 00[0-7][0-7]):
# a mask with an owner bit (0277, 0700, 0777) would create files the app itself cannot open, so it
# is refused like any other typo. Blank or unset = the default, silently (Unraid passes a cleared
# template field as an empty string; PORT behaves the same way). Anything else = ONE warning and the
# default: a typo must never stop a baby monitor starting (the same rule as TRUST_PROXY,
# src/lib/trustProxy.js), and failing safe means failing to private, not to world-readable.
DEFAULT_UMASK=077
case "${UMASK:-}" in
  '') UMASK=$DEFAULT_UMASK ;;
  0[0-7][0-7]) ;;
  # 0077 -> 077: one spelling, so the "only at 077" test below is a single comparison.
  00[0-7][0-7]) UMASK=${UMASK#0} ;;
  *)
    # printf, not echo: dash's echo interprets backslashes in the value it is handed.
    printf '[entrypoint] warning: UMASK=%s is not valid (3 or 4 octal digits with an owner digit of 0, e.g. 077 or 022); using %s\n' "$UMASK" "$DEFAULT_UMASK" >&2
    UMASK=$DEFAULT_UMASK
    ;;
esac

CURRENT_UID=$(id -u nightlight)
CURRENT_GID=$(id -g nightlight)

if [ "$PGID" != "$CURRENT_GID" ]; then
  groupmod -o -g "$PGID" nightlight
fi

if [ "$PUID" != "$CURRENT_UID" ]; then
  usermod -o -u "$PUID" nightlight
fi

# Set HERE: after the user remap (so /etc/passwd and friends are written exactly as before #549) and
# BEFORE `mkdir -p`, so on a first boot the data directory itself is created with the mask. A umask
# is inherited across su-exec and every fork, so the app and the FFmpeg and MediaMTX processes it
# starts (same uid, #553) create the database, snapshots, clips and recordings with it. SQLite gives
# -wal/-shm the database file's own mode, so they follow the database rather than the mask.
umask "$UMASK"
# ...but a non-default DATA_DIR whose PARENTS do not exist yet gets those parents under 022, in a
# subshell so the mask above stays. Made under 077 they would be root:0700, the chown below only
# re-owns the data directory itself, and the app user could not even reach it (review of #549, PR
# #689). Before #549 they were 0755 too. Only the data directory itself takes the mask.
( umask 022; mkdir -p "$(dirname "$DATA_DIR")" )
mkdir -p "$DATA_DIR"
# --- Ownership of the data directory (#567) ---------------------------------------------------
# This used to be an unconditional `chown -R` on every start. It rewrites every file's inode (so every clip,
# snapshot and recording is touched, and a spinning disk holding many GB of clips spends minutes at boot, which
# also delays the app's self-heal after a restart) to change nothing once ownership is right, which is nearly
# every start. Now the walk happens only when something at the TOP says ownership is not right:
#   - the data directory itself: new install (mkdir above made it root-owned), or PUID/PGID changed (the
#     directory still belongs to the old ids); this is the check that catches the cases the walk exists for;
#   - the database, its -wal/-shm and .jwt_secret, if present: the files a backup restore or a hand-copy as
#     root is most likely to drop in, and the ones the app cannot run without.
# Compared with $PUID:$PGID, not `id nightlight`: the usermod/groupmod above made them the same, and this reads
# the same in the tests, where those tools are stubbed. Compared NUMERICALLY (canonical_id below): stat prints 99,
# so PUID=099 (which usermod reads as uid 99, and entrypoint-puid-root.test.js keeps legitimate) never matched as
# text and walked the tree on every start (post-merge review of PR #701).
# stat -L reports the file a symlink points to (the one the app opens). A symlinked DATA_DIR is judged by its
# TARGET whatever the flag, because the path checked is "$DATA_DIR/.", which resolves through the link. Note that
# this is NOT what the chown below changes: `chown -R` without -H/-L does not follow a top-level link (it re-owns
# the link itself: BusyBox's chown.c switches to lchown for -R without -H in a DESKTOP build such as Alpine's, and
# GNU's default -P does the same; the #549 note further down says it of the chmod walk), so a symlinked DATA_DIR, or a
# symlinked database, whose target has the wrong owner logs "fixing" on every start and stays as it is. Re-own
# the target on the host in that layout.
# ⚠️ TRADE-OFF, stated plainly: a file or folder DEEPER in the tree that has the wrong owner while all of the
# above are right (say a clip restored as root into a correctly-owned data directory) is no longer repaired at
# start. Before #567 it was. Run `chown -R <PUID>:<PGID> <data dir>` on the host, or change PUID/PGID once and
# back, to force a full pass. (The mode tightening below still walks the whole tree on every start; it only
# reads, it does not rewrite.)
# Leading zeros removed by hand, not with $((...)): sh arithmetic reads a leading 0 as OCTAL (099 is an error,
# 010 is 8). Digits only; anything else is compared as written (usermod above has already accepted it).
canonical_id() {
  case "$1" in
    ''|*[!0-9]*) printf '%s' "$1" ;;
    *)
      _cid=$1
      while [ "${_cid#0}" != "$_cid" ]; do _cid=${_cid#0}; done
      printf '%s' "${_cid:-0}"
      ;;
  esac
}
WANT_OWNER="$(canonical_id "$PUID"):$(canonical_id "$PGID")"
NEEDS_CHOWN=
for f in . babymonitor.db babymonitor.db-wal babymonitor.db-shm .jwt_secret; do
  if [ -e "$DATA_DIR/$f" ] && [ "$(stat -L -c %u:%g "$DATA_DIR/$f" 2>/dev/null)" != "$WANT_OWNER" ]; then
    NEEDS_CHOWN="$f"
    break
  fi
done
if [ -n "$NEEDS_CHOWN" ]; then
  printf '[entrypoint] ownership of %s is not %s; fixing the whole data directory\n' "$DATA_DIR/$NEEDS_CHOWN" "$WANT_OWNER"
  chown -R nightlight:nightlight "$DATA_DIR"
else
  printf '[entrypoint] data directory already owned by %s; not walking it\n' "$WANT_OWNER"
fi

# A umask only shapes NEW files. An install upgraded from before #549 has every file 0644 and every
# folder 0755, so at the default 077 the group/other bits come off whatever still has any. Why each
# part:
#   - ONLY at 077. An opt-out (UMASK=022) must never be re-tightened behind the owner's back, and a
#     custom mask is not reverse-engineered into a chmod: with any other value nothing existing
#     changes. That makes the opt-out one-way (a tightened tree stays tight), which the docs say.
#   - EVERY start, like the chown above and for the same reason: a restore from a backup, or Unraid's
#     "New Permissions" tool run over appdata (it makes a share world-readable), heals on the next start, with
#     no marker file to get out of step. -perm /077 matches only entries that still have a bit to
#     take, so an already-tight tree costs one walk (the chown has just warmed it) and no writes.
#   - "$DATA_DIR" with NO trailing slash: the SAME root the chown -R above walks. A DATA_DIR that is
#     itself a symlink is not re-owned by chown -R (it stops at the link), so it must not be
#     tightened either: files still owned by another uid would become 0600 to THAT uid and lock the
#     app out (review of #549, PR #689). find does not follow a starting-point link either, so such
#     a DATA_DIR is simply left alone; new files in it still get the mask.
#   - ! -type l: chmod follows a symlink, so a link in here pointing at another share or /etc would
#     otherwise change THAT file's mode. (find never descends into a linked folder either.) Hard
#     links and mounts nested inside the data directory ARE walked, exactly as chown -R walks them.
#   - -print BEFORE -exec: counts the entries for the line below. -print is always true, so every
#     entry still reaches chmod. The count is what was FOUND, printed before chmod ran, so the line
#     says "found", not "tightened": a chmod that fails is reported by the warning below, and on a
#     filesystem that ignores chmod (a Docker Desktop for Windows bind mount, say) the same count
#     comes back on every start, which is how that case shows itself.
#   - NEVER fatal under set -e: an unreadable subfolder (a root-squashed network share, say) must not
#     become a container that will not start. A pipeline's status is its last command's (wc), so the
#     walk cannot stop the script; `|| printf` is only there to SAY that it fell short.
if [ "$UMASK" = 077 ]; then
  FOUND=$( { find "$DATA_DIR" ! -type l -perm /077 -print -exec chmod go-rwx {} + || printf '[entrypoint] warning: could not tighten every entry under %s (see the error above); starting anyway\n' "$DATA_DIR" >&2; } | wc -l)
  DONE="existing entries with group/other access found: $FOUND"
else
  DONE="existing entries left as they are (UMASK is not 077)"
fi

# One line to check after an upgrade (`docker logs`; on staging, `hx.sh logs`): the mask, what the
# walk found, and the modes of the files that hold the secrets (read AFTER the chmod, so they show
# whether it took). Each is existence-guarded: on a first
# boot there is no database or .jwt_secret yet, and -wal/-shm come and go with the open database.
# stat -L: if one of them is a symlink, report the file the app actually opens, not the link.
# The app logs its own `[data-dir]` line once it is up, which shows the mask actually REACHED it.
MODES=
for f in babymonitor.db babymonitor.db-wal babymonitor.db-shm .jwt_secret; do
  m=absent
  if [ -e "$DATA_DIR/$f" ]; then
    m=$(stat -L -c %a "$DATA_DIR/$f" 2>/dev/null) || m=unknown
  fi
  MODES="$MODES $f=$m"
done
printf '[entrypoint] umask %s; %s; modes:%s\n' "$UMASK" "$DONE" "$MODES"

# --- Media isolation (#553) ---------------------------------------------------------------------
# Camera streams are untrusted input, and ffmpeg, ffprobe and MediaMTX parse them. With isolation ON they run as a
# second user, the media user (uid:gid 1700:1700, created in the Dockerfile as nlmedia), with no capabilities, so a
# parser bug a camera exploits cannot read what the app's uid can. The app itself then starts through `setpriv`
# instead of `su-exec`, keeping exactly three capabilities as AMBIENT ones: SETUID and SETGID (to start each child as
# the media user, through media-exec.sh) and KILL (to signal those children, which belong to another uid now).
#
# NIGHTLIGHT_MEDIA_ISOLATION is an INTERNAL switch, read only here: 1 asks for isolation, anything else (unset, 0,
# blank, any other text) means off, silently. Off by default ON PURPOSE while #553 is built in phases: until the
# shared-folder layout lands (phase 2), the media user cannot write recordings, clips or timelapses, so only
# streaming works with it on. Not documented for users yet; a later phase flips the default and documents it.
#
# THE RULES (plan review of #553):
#   - Decided HERE, as root, never in the app: Node cannot drop capabilities, so an app-side fallback would hand
#     SETUID/SETGID/KILL to every child. MEDIA_ISOLATION is exported as `on` or `off` on EVERY start, so a value an
#     operator put in the environment never reaches the app.
#   - Before switching it on, a DRY RUN of the whole chain, with the SAME launcher (`setpriv $APP_DROP`, below) and
#     the SAME media-exec.sh the app will use: media-probe.sh, started as the app, starts a media process through
#     media-exec.sh and checks what the kernel actually gave it. Only if every check passes is it on.
#   - Never refuse to start: any failure is `off` plus ONE warning line naming the reason, then the usual su-exec
#     start, exactly as before #553. A failing step cannot abort the script: media_dry_run guards every status itself
#     and is called as an `if` condition (where `set -e` does not apply), and the dry run has a time limit.
#   - PUID=0 keeps isolation off: the app is root there and the PUID=0 setups (the e2e and demo stacks) rely on it.
#   - PUID or PGID equal to the media id (compared numerically, canonical_id) keeps it off: the app would BE the media
#     user, or share its group, and the separation would be nothing.
#   - No bounding-set trimming anywhere: it needs CAP_SETPCAP, which the documented six-capability hardening lacks
#     (#553 spike, run 1). --no-new-privs is set on the app and on every child instead.
MEDIA_ID=1700
# Next to this script: /app/media-exec.sh in the image, backend/media-exec.sh in a checkout (the tests). Node finds the
# same file the same way (MEDIA_EXEC_PATH in src/lib/childEnv.js), so the dry run tests what the app will run.
MEDIA_EXEC="$(dirname "$0")/media-exec.sh"
MEDIA_PROBE="$(dirname "$0")/media-probe.sh"
# Normally well under a second; the limit exists so a hung step can never stop the container starting (phase 2 will
# probe the media folders, and a stalled network share is the realistic hang).
MEDIA_DRY_RUN_TIMEOUT=30
APP_UID=$(canonical_id "$PUID")
APP_GID=$(canonical_id "$PGID")

# The app's start with isolation on: `setpriv $APP_DROP -- <command>`. ONE definition, used by both the dry run and
# the real start, so the dry run cannot pass with an argv the real start does not use. Expanded unquoted ON PURPOSE
# (sh has no arrays): every word is a fixed token or a number checked by is_id before this is ever expanded, so
# splitting on spaces is exact and there is nothing for pathname expansion to match.
APP_DROP="--reuid=$APP_UID --regid=$APP_GID --groups=$APP_GID,$MEDIA_ID --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill --no-new-privs"

is_id() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# Sets MEDIA_REASON and returns 1 on any failure; returns 0 only on the probe's own success line AND status 0.
media_dry_run() {
  if _out=$(timeout "$MEDIA_DRY_RUN_TIMEOUT" setpriv $APP_DROP -- /bin/sh "$MEDIA_PROBE" app "$MEDIA_EXEC" "$MEDIA_ID" "$APP_UID" 2>&1); then
    _rc=0
  else
    _rc=$?
  fi
  # PHASE 2 HOOK (#553): the shared-folder check goes here, as more arguments to media-probe.sh (one per media mount:
  # the clip ring, the clips folder, the timelapse folder), so that the media user's write, the app's read and the
  # app's unlink are proven on the real mounts before isolation is switched on.
  if [ "$_rc" = 0 ] && [ "$(printf '%s\n' "$_out" | tail -n 1)" = MEDIA-PROBE-OK ]; then
    return 0
  fi
  MEDIA_REASON=$(printf '%s\n' "$_out" | sed -n 's/^MEDIA-PROBE-FAIL //p' | head -n 1)
  if [ -z "$MEDIA_REASON" ]; then
    # The probe never ran or never finished: the drop to the app user itself failed (a missing capability makes
    # setpriv exit 127, #553 spike run 3), setpriv is not util-linux's, or the time limit hit. Its last line says which.
    MEDIA_REASON="the dry run could not start the app as uid $APP_UID with CAP_SETUID, CAP_SETGID and CAP_KILL (exit $_rc: $(printf '%s\n' "$_out" | sed '/^$/d' | tail -n 1))"
  fi
  return 1
}

MEDIA_ISOLATION=off
MEDIA_REASON=
if [ "${NIGHTLIGHT_MEDIA_ISOLATION:-}" = 1 ]; then
  if ! is_id "$APP_UID" || ! is_id "$APP_GID"; then
    MEDIA_REASON="PUID=$PUID PGID=$PGID are not both numbers"
  elif [ "$APP_UID" = 0 ]; then
    MEDIA_REASON="PUID=0 runs the app as root, and isolation needs a non-root app"
  elif [ "$APP_UID" = "$MEDIA_ID" ] || [ "$APP_GID" = "$MEDIA_ID" ]; then
    MEDIA_REASON="PUID or PGID is $MEDIA_ID, the media user's id, so the app and the media processes would not be separate"
  elif media_dry_run; then
    MEDIA_ISOLATION=on
  fi
fi
export MEDIA_ISOLATION

if [ "$MEDIA_ISOLATION" = on ]; then
  printf '[entrypoint] media isolation on: ffmpeg, ffprobe and MediaMTX run as uid %s, the app as %s:%s\n' "$MEDIA_ID" "$APP_UID" "$APP_GID"
  # su-exec sets HOME to the user's home (/app); setpriv leaves root's. Same value as the su-exec start, so nothing
  # that reads HOME behaves differently with isolation on. "/" is su-exec's own fallback for a user it cannot find.
  HOME=$(awk -F: '$1 == "nightlight" { print $6; exit }' /etc/passwd 2>/dev/null) || HOME=
  export HOME="${HOME:-/}"
  exec setpriv $APP_DROP -- "$@"
fi
if [ -n "$MEDIA_REASON" ]; then
  printf '[entrypoint] warning: media isolation is off: %s; starting the usual way\n' "$MEDIA_REASON" >&2
fi

exec su-exec nightlight "$@"
