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
# the same in the tests, where those tools are stubbed. stat -L: judge the directory the chown would change, as
# `chown` (no -h) does, if DATA_DIR is a symlink.
# ⚠️ TRADE-OFF, stated plainly: a file or folder DEEPER in the tree that has the wrong owner while all of the
# above are right (say a clip restored as root into a correctly-owned data directory) is no longer repaired at
# start. Before #567 it was. Run `chown -R <PUID>:<PGID> <data dir>` on the host, or change PUID/PGID once and
# back, to force a full pass. (The mode tightening below still walks the whole tree on every start; it only
# reads, it does not rewrite.)
NEEDS_CHOWN=
for f in . babymonitor.db babymonitor.db-wal babymonitor.db-shm .jwt_secret; do
  if [ -e "$DATA_DIR/$f" ] && [ "$(stat -L -c %u:%g "$DATA_DIR/$f" 2>/dev/null)" != "$PUID:$PGID" ]; then
    NEEDS_CHOWN="$f"
    break
  fi
done
if [ -n "$NEEDS_CHOWN" ]; then
  printf '[entrypoint] ownership of %s is not %s:%s; fixing the whole data directory\n' "$DATA_DIR/$NEEDS_CHOWN" "$PUID" "$PGID"
  chown -R nightlight:nightlight "$DATA_DIR"
else
  printf '[entrypoint] data directory already owned by %s:%s; not walking it\n' "$PUID" "$PGID"
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

exec su-exec nightlight "$@"
