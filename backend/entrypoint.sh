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
#     root is most likely to drop in, and the ones the app cannot run without. Since #553 phase 2a they normally live
#     in private/, so both places are checked, and private/ itself (a `docker exec` as root must not be able to leave a
#     root-owned private/ that locks the app out of its own database). Inside private/ (0700, the app's) root can only
#     look with DAC_OVERRIDE; without it those names read as absent and are skipped (the warning below says so).
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
# The media user's id (#553), needed this early for one reason: with isolation asked for, the data directory carries the
# MEDIA group (media_layout_ok below), and that must not read as "wrong owner" here, or the full walk below would run on
# every start and hand the group of everything beneath it back to PGID, including the folders the media user writes into.
MEDIA_ID=1700
media_layout_ok() {
  [ "$1" = . ] && [ "${NIGHTLIGHT_MEDIA_ISOLATION:-}" = 1 ] \
    && [ "$(stat -L -c %u:%g "$DATA_DIR/." 2>/dev/null)" = "$(canonical_id "$PUID"):$MEDIA_ID" ]
}
NEEDS_CHOWN=
for f in . babymonitor.db babymonitor.db-wal babymonitor.db-shm .jwt_secret private private/babymonitor.db private/babymonitor.db-wal private/babymonitor.db-shm private/.jwt_secret; do
  if [ -e "$DATA_DIR/$f" ] && [ "$(stat -L -c %u:%g "$DATA_DIR/$f" 2>/dev/null)" != "$WANT_OWNER" ] && ! media_layout_ok "$f"; then
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

# --- The private folder (#553 phase 2a) ------------------------------------------------------------
# The database and the app's secrets live in DATA_DIR/private/, a folder that is always 700 and owned by PUID:PGID, so
# that a later phase can open DATA_DIR itself to the media group without exposing them (a 700 folder protects even a
# wrongly permissive file inside it). The MOVE is src/scripts/migrate-private-layout.js, run further down as the app
# user; this part only prepares, as root:
#   - private/ itself: created if missing, given to PUID:PGID only if it is not already theirs, and chmod 700 on every
#     start (the umask must not decide it: UMASK=022 is a supported opt-out, and private/ stays 700 under it too). A
#     private/ that is not a folder is left exactly as it is, with a warning. A private/ that is a symbolic link to a
#     folder (the owner's own arrangement: another disk, say) is used: what it points to is made 700 THROUGH the link
#     (chmod follows it), because left alone a 0755 target let an old 0644 database be renamed into a folder others
#     can read under UMASK=022 (Codex review of PR #870). It is never chown-ed through the link: a root chown through a
#     link the app user could have planted is the classic way to hand root's files to that user; a chmod to 700 can
#     only take access away. A target with the wrong owner gets a warning instead.
#   - the top-level items the tool moves that are not sentinels above, when one has the wrong owner (a restore or a
#     hand-copy as root; most often a Firebase file dropped in as root): the tool runs as the app user and could not
#     move it (a folder's rename into another needs write access to the folder itself). Only these few names, never
#     the clip tree (#567), never through a symbolic link (the tool will not move a link either), and not at all when
#     the full walk above just ran, because it re-owned all of them.
# EVERY step is guarded: under `set -e` a failed mkdir, chown or chmod (no CAP_CHOWN or CAP_FOWNER, a read-only or
# root-squashed share) must never become a container that will not start. Root cannot look inside the 700 private/
# without DAC_OVERRIDE (the optional hardening keeps it; e2e/hardened.sh's control D takes it away).
PRIVATE_DIR="$DATA_DIR/private"
private_warn() { printf '[entrypoint] warning: %s; starting anyway\n' "$1" >&2; }
if [ -L "$PRIVATE_DIR" ] && [ ! -d "$PRIVATE_DIR" ]; then
  private_warn "$PRIVATE_DIR is a symbolic link that does not point to a folder, so nothing can be moved into it"
elif [ -e "$PRIVATE_DIR" ] && [ ! -d "$PRIVATE_DIR" ]; then
  private_warn "$PRIVATE_DIR exists and is not a folder, so nothing can be moved into it; move it out of the way"
else
  if [ ! -d "$PRIVATE_DIR" ]; then
    mkdir "$PRIVATE_DIR" || private_warn "could not create $PRIVATE_DIR"
  fi
  if [ -L "$PRIVATE_DIR" ]; then
    if [ "$(stat -L -c %u:%g "$PRIVATE_DIR" 2>/dev/null)" != "$WANT_OWNER" ]; then
      private_warn "$PRIVATE_DIR is a symbolic link whose target is not owned by $WANT_OWNER; re-own the target on the host (it is not done through a link)"
    fi
  elif [ -d "$PRIVATE_DIR" ]; then
    if [ "$(stat -c %u:%g "$PRIVATE_DIR" 2>/dev/null)" != "$WANT_OWNER" ]; then
      chown nightlight:nightlight "$PRIVATE_DIR" || private_warn "could not give $PRIVATE_DIR to $WANT_OWNER"
    fi
  fi
  if [ -d "$PRIVATE_DIR" ]; then
    chmod 700 "$PRIVATE_DIR" || private_warn "could not make $PRIVATE_DIR owner-only (700)"
    if ! stat "$PRIVATE_DIR/." >/dev/null 2>&1; then
      private_warn "root cannot look inside $PRIVATE_DIR (is DAC_OVERRIDE missing?), so the owners of the files in it were not checked"
    fi
  fi
fi
if [ -z "$NEEDS_CHOWN" ]; then
  for p in "$DATA_DIR/babymonitor.db-journal" "$DATA_DIR/firebase-service-account.json" "$DATA_DIR/google-services.json" \
    "$DATA_DIR/detection-snapshots" "$DATA_DIR/transition-snapshots" "$DATA_DIR"/backup-*.db; do
    # An unmatched backup-*.db stays a literal word, which -e rejects.
    if [ ! -e "$p" ] || [ -L "$p" ]; then continue; fi
    _owner=$(stat -c %u:%g "$p" 2>/dev/null) || continue
    if [ "$_owner" = "$WANT_OWNER" ]; then continue; fi
    printf '[entrypoint] %s is owned by %s, not %s; re-owning it so it can be moved into private/\n' "$p" "$_owner" "$WANT_OWNER"
    chown -R nightlight:nightlight "$p" || private_warn "could not re-own $p"
  done
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
#   - WHEN MEDIA ISOLATION IS ASKED FOR (#553 phase 2b) the walk is CONFINED to private/ and the files directly in the data
#     directory. The media layout needs group access on purpose: the data directory is 0710 and the clips folders 0750 and
#     1770 (src/lib/mediaLayout.js), and a walk over the whole tree would take those bits straight back off on every start
#     and stop recording. What the walk skips is the clip tree, which the layout (not a umask) governs, and which holds no
#     secret. If isolation then turns out to be off after all (the dry run failed), the whole tree is walked at that point.
tighten_all() {
  FOUND=$( { find "$DATA_DIR" ! -type l -perm /077 -print -exec chmod go-rwx {} + || printf '[entrypoint] warning: could not tighten every entry under %s (see the error above); starting anyway\n' "$DATA_DIR" >&2; } | wc -l)
}
TIGHTEN_CONFINED=
if [ "$UMASK" = 077 ] && [ "${NIGHTLIGHT_MEDIA_ISOLATION:-}" = 1 ]; then
  TIGHTEN_CONFINED=1
  FOUND=$( { { find "$DATA_DIR/private" ! -type l -perm /077 -print -exec chmod go-rwx {} +; find "$DATA_DIR" -maxdepth 1 -type f ! -type l -perm /077 -print -exec chmod go-rwx {} +; } || printf '[entrypoint] warning: could not tighten every entry under %s (see the error above); starting anyway\n' "$DATA_DIR" >&2; } | wc -l)
  DONE="existing entries with group/other access found in private/ and at the top level: $FOUND (media isolation asked for: the clip tree is left alone)"
elif [ "$UMASK" = 077 ]; then
  tighten_all
  DONE="existing entries with group/other access found: $FOUND"
else
  DONE="existing entries left as they are (UMASK is not 077)"
fi

# --- Moving the database and secrets into private/ (#553 phase 2a) ---------------------------------
# src/scripts/migrate-private-layout.js, found next to this script (/app/src/... in the image, backend/src/... in a
# checkout). In the FOREGROUND and waited for, as the app user, BEFORE the app starts at the bottom of this script:
# nothing else may have the database open while it moves, and a start-up that stopped waiting at a deadline could start
# the app in the middle of the move (plan review of #553 phase 2a, C1). Its own time limit applies only before its
# point of no return. Its exit code becomes ONE `private layout:` line, and no exit code can stop the container (inside
# an `if`, `set -e` does not apply):
#   0 everything that belongs in private/ is there   10 something stays at the top level this start
#   11 a top-level copy was set aside in private/legacy-*/   anything else: the tool itself failed
# Its own `[private-layout]` lines, just before, say what moved and why anything did not.
PRIVATE_TOOL="$(dirname "$0")/src/scripts/migrate-private-layout.js"
if su-exec nightlight node "$PRIVATE_TOOL"; then PRIVATE_RC=0; else PRIVATE_RC=$?; fi
case "$PRIVATE_RC" in
  0) printf '[entrypoint] private layout: the database and secrets are in %s (or there are none yet)\n' "$PRIVATE_DIR" ;;
  10) private_warn "private layout: something is still at the top of $DATA_DIR this start (the [private-layout] lines above say what and why), and the app uses it there" ;;
  11) private_warn "private layout: a copy at the top of $DATA_DIR was set aside in $PRIVATE_DIR/legacy-*/ because $PRIVATE_DIR already had one, which is the one used (docs/operations.md, \"Two copies of the database\")" ;;
  *) private_warn "private layout: the move into $PRIVATE_DIR did not finish (exit $PRIVATE_RC), and the app uses the files where they are" ;;
esac

# One line to check after an upgrade (`docker logs`; on staging, `hx.sh logs`): the mask, what the
# walk found, and the modes of the files that hold the secrets (read AFTER the chmod and the move, so they show
# whether they took). Each is existence-guarded: on a first
# boot there is no database or .jwt_secret yet, and -wal/-shm come and go with the open database.
# stat -L: if one of them is a symlink, report the file the app actually opens, not the link.
# #553 phase 2a: each is named by its path in the data directory, found by the app's own rule (src/lib/dataPaths.js):
# the database and its companions where the database is (private/ if it is there, else the top level if it is there,
# else private/), .jwt_secret private/ first. private/ itself comes first.
# The app logs its own `[data-dir]` line once it is up, which shows the mask actually REACHED it.
exists_or_link() { [ -e "$1" ] || [ -L "$1" ]; }
if exists_or_link "$PRIVATE_DIR/babymonitor.db"; then DB_AT=private/
elif exists_or_link "$DATA_DIR/babymonitor.db"; then DB_AT=
else DB_AT=private/
fi
m=absent
if [ -e "$PRIVATE_DIR" ]; then m=$(stat -L -c %a "$PRIVATE_DIR" 2>/dev/null) || m=unknown; fi
MODES=" private=$m"
for f in babymonitor.db babymonitor.db-wal babymonitor.db-shm .jwt_secret; do
  r="$DB_AT$f"
  if [ "$f" = .jwt_secret ]; then
    if exists_or_link "$PRIVATE_DIR/$f"; then r="private/$f"; elif exists_or_link "$DATA_DIR/$f"; then r=$f; else r="private/$f"; fi
  fi
  m=absent
  if [ -e "$DATA_DIR/$r" ]; then
    m=$(stat -L -c %a "$DATA_DIR/$r" 2>/dev/null) || m=unknown
  fi
  MODES="$MODES $r=$m"
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
# MEDIA_ID (1700) is set further up, next to the ownership check that needs it.
# Next to this script: /app/media-exec.sh in the image, backend/media-exec.sh in a checkout (the tests). Node finds the
# same file the same way (MEDIA_EXEC_PATH in src/lib/childEnv.js), so the dry run tests what the app will run.
MEDIA_EXEC="$(dirname "$0")/media-exec.sh"
MEDIA_PROBE="$(dirname "$0")/media-probe.sh"
# Normally well under a second; the limit exists so a hung step can never stop the container starting. Since phase 2b the
# dry run touches the media folders, and a stalled network share is the realistic hang: see media_dry_run.
MEDIA_DRY_RUN_TIMEOUT=30
APP_UID=$(canonical_id "$PUID")
APP_GID=$(canonical_id "$PGID")

# The app's start with isolation on: `setpriv $APP_DROP -- <command>`. ONE definition, used by both the dry run and
# the real start, so the dry run cannot pass with an argv the real start does not use. Expanded unquoted ON PURPOSE
# (sh has no arrays): every word is a fixed token or a number checked by is_id before this is ever expanded, so
# splitting on spaces is exact and there is nothing for pathname expansion to match.
APP_DROP="--reuid=$APP_UID --regid=$APP_GID --groups=$APP_GID,$MEDIA_ID --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill --no-new-privs"

is_id() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

# --- The media layout and the dry run (#553 phase 2b) ---------------------------------------------------------
# The folders the media user must traverse, and the one decision of the layout that only root can make: the group of the
# data directory and of the clips folder's top (src/lib/mediaLayout.js says who may write where below that, and the app
# makes the folders under it lazily). TOP LEVEL ONLY and never a recursive walk (#567: the clip tree is not walked on every
# start; an external CLIPS_DIR mount can be terabytes on a spinning disk).
#
# Where the clips folder is, by the app's own rule (src/lib/clipsDir.js): CLIPS_DIR, blank meaning unset, which means
# DATA_DIR/clips; a relative value is relative to the working directory; trailing slashes do not count.
case "$(printf '%s' "${CLIPS_DIR:-}" | tr -d ' \t')" in
  '') CLIPS_ABS="$DATA_DIR/clips" ;;
  *) CLIPS_ABS=${CLIPS_DIR}; case "$CLIPS_ABS" in /*) ;; *) CLIPS_ABS="$PWD/$CLIPS_ABS" ;; esac ;;
esac
while [ "${CLIPS_ABS%/}" != "$CLIPS_ABS" ] && [ "$CLIPS_ABS" != / ]; do CLIPS_ABS=${CLIPS_ABS%/}; done

# Is anything the move into private/ should have taken still at the top level? Prints the first such name and returns 0,
# or returns 1. Isolation is REFUSED while one is there (see the decision below). .demo-ready and the clips folder are
# exempt (neither is a secret). A secret the operator supplies through the environment is exempt too: JWT_SECRET means the
# app never reads .jwt_secret, and FIREBASE_CREDENTIALS / FIREBASE_CLIENT_CONFIG name the file the app reads instead of the
# one in the data directory.
media_toplevel_leftover() {
  for _n in babymonitor.db babymonitor.db-wal babymonitor.db-shm babymonitor.db-journal detection-snapshots transition-snapshots; do
    if exists_or_link "$DATA_DIR/$_n"; then printf '%s' "$_n"; return 0; fi
  done
  if [ -z "${JWT_SECRET:-}" ] && exists_or_link "$DATA_DIR/.jwt_secret"; then printf '.jwt_secret'; return 0; fi
  if [ -z "${FIREBASE_CREDENTIALS:-}" ] && exists_or_link "$DATA_DIR/firebase-service-account.json"; then printf 'firebase-service-account.json'; return 0; fi
  if [ -z "${FIREBASE_CLIENT_CONFIG:-}" ] && exists_or_link "$DATA_DIR/google-services.json"; then printf 'google-services.json'; return 0; fi
  for _n in "$DATA_DIR"/backup-*.db; do
    # An unmatched glob stays a literal word, which exists_or_link rejects.
    if exists_or_link "$_n"; then printf '%s' "${_n##*/}"; return 0; fi
  done
  return 1
}

# One folder the media user must be able to enter and list but not write in: the app's, group = the media group, mode $2.
# Created (owned by the app) when missing. A folder some OTHER uid owns is refused, not taken over: the app could not write
# into it afterwards, and a chgrp of someone else's folder is not ours to do. $3 = "own" skips that check for the data
# directory, whose owner the ownership block above has just settled. Sets MEDIA_REASON and returns 1 on failure.
media_traverse_dir() {
  if [ ! -d "$1" ]; then
    # 022 for any parents (as for DATA_DIR's above); the folder itself is then given to the app.
    { ( umask 022; mkdir -p "$1" ) && chown "$APP_UID:$APP_GID" "$1"; } || { MEDIA_REASON="could not create $1"; return 1; }
  fi
  if [ "${3:-}" != own ] && [ "$(stat -L -c %u "$1" 2>/dev/null)" != "$APP_UID" ]; then
    MEDIA_REASON="$1 is not owned by uid $APP_UID (the app), so the media folders cannot be set up in it; give it to $APP_UID on the host"
    return 1
  fi
  { chgrp "$MEDIA_ID" "$1" && chmod "$2" "$1"; } || { MEDIA_REASON="could not give $1 to the media group (mode $2)"; return 1; }
}

# Every folder from $1 up to (not including) DATA_DIR, for a clips folder inside the data directory; for an external one
# (/recordings, say) only its own top folder, and nothing above it.
media_layout_up_to() {
  case "$1" in
    "$DATA_DIR") return 0 ;;
    "$DATA_DIR"/*) media_layout_up_to "$(dirname "$1")" || return 1 ;;
  esac
  media_traverse_dir "$1" 750
}

# The group of the data directory: 0710, so the media user can pass through it (to reach a clips folder inside) and nothing
# else: it cannot list it, and private/ stays 0700 and the app's alone.
media_prepare_layout() {
  media_traverse_dir "$DATA_DIR" 710 own && media_layout_up_to "$CLIPS_ABS"
}

# Sets MEDIA_REASON and returns 1 on any failure; returns 0 only on the probe's own success line AND status 0.
#
# THE PROBE RUNS IN THE BACKGROUND (the caveat the phase 1 review of PR #869 wrote down for this step). The probe now
# touches the real mounts, and `timeout` around a `$(...)` does not bound that: a probe stuck in uninterruptible sleep (a
# dead network share) ignores the signal, and a child that keeps the pipe open keeps the command substitution waiting after
# `timeout` has given up. So it writes to a file in a temp folder, a marker file says it finished, and this function stops
# waiting at the deadline whatever the probe is still doing, and answers "failed". Abandoning is safe because this is the
# DRY RUN, not the migration: nothing it started changes the data, and isolation simply stays off.
media_dry_run() {
  _dd=$(mktemp -d) || { MEDIA_REASON="could not create a temporary folder for the dry run"; return 1; }
  # stdin, stdout and stderr of the whole background job go to files or /dev/null, so an abandoned probe holds nothing of
  # this script's (not the container's log pipe either) open.
  # (The `|| _r=$?` is not decoration: the subshell inherits `set -e`, and without it a probe that fails would end the
  # subshell before the status is written, which the loop below would read as "never finished".)
  (
    _r=0
    setpriv $APP_DROP -- /bin/sh "$MEDIA_PROBE" app "$MEDIA_EXEC" "$MEDIA_ID" "$APP_UID" "$CLIPS_ABS" "$DATA_DIR" > "$_dd/out" 2>&1 || _r=$?
    echo "$_r" > "$_dd/rc"
  ) > /dev/null 2>&1 < /dev/null &
  _pid=$!
  _i=0
  while [ ! -s "$_dd/rc" ]; do
    if [ "$_i" -ge $((MEDIA_DRY_RUN_TIMEOUT * 10)) ]; then
      kill "$_pid" 2>/dev/null || :
      MEDIA_REASON="the dry run did not finish within $MEDIA_DRY_RUN_TIMEOUT seconds (is a media folder on a stalled share?); it was abandoned"
      return 1
    fi
    # 0.1 s steps; a sleep without fractions (some minimal systems) waits a whole second and counts it as ten steps.
    if sleep 0.1 2>/dev/null; then _i=$((_i + 1)); else sleep 1; _i=$((_i + 10)); fi
  done
  _rc=$(cat "$_dd/rc")
  _out=$(cat "$_dd/out" 2>/dev/null) || _out=
  rm -f -- "$_dd/out" "$_dd/rc"
  rmdir -- "$_dd" 2>/dev/null || :
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
  elif _left=$(media_toplevel_leftover); then
    # A skipped or unfinished move must not become a silent, permanent gap: with the data directory open to the media group,
    # a database or secret still at its top level is protected by nothing but its own mode (docs/operations.md, "Media
    # isolation"). Refused until the move has finished (the [private-layout] lines above say what is stopping it).
    MEDIA_REASON="$_left is still at the top level of $DATA_DIR instead of in private/, so the media user could not be kept away from it; the move into private/ has not finished"
  elif ! media_prepare_layout; then
    : # MEDIA_REASON says which folder and why
  elif media_dry_run; then
    MEDIA_ISOLATION=on
  fi
fi
export MEDIA_ISOLATION

# Isolation was asked for but is off: the confined walk above skipped the clip tree on that promise, so the whole tree is
# tightened now, as it would have been without the switch (the start-up line above said what was skipped).
if [ -n "$TIGHTEN_CONFINED" ] && [ "$MEDIA_ISOLATION" = off ]; then
  tighten_all
  printf '[entrypoint] media isolation is off, so the whole data directory was tightened after all: group/other access found: %s\n' "$FOUND"
fi

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
