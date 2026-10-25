#!/bin/bash
# Mutation check for backend/entrypoint.sh's file-mode block (#549): each mutant breaks the block in ONE named way, and
# backend/test/entrypoint-umask.test.js MUST fail against it (a surviving mutant = a rule the test does not pin).
#
# Why a script of its own: the JS catalogue (scripts/mutants.json, scripts/mutate.mjs) only mutates JS, and the test
# is skipped on Windows (NTFS has no POSIX modes), where it would report every mutant as surviving. So this runs on
# Linux only, as an unprivileged user: in CI (.github/workflows/test.yml, the `unit` job, next to the same test run
# inside node:24-alpine for BusyBox), or by hand: `bash scripts/entrypoint-umask.mutants.sh`.
#
# Mutants run from a temp copy (ENTRYPOINT_UNDER_TEST), never in place. A mutant that does not PARSE (sh -n) is an
# ERROR, never a "kill": a broken script fails every test for the wrong reason (the rule the gate's mutants follow).
#
# #553 added a second block, media isolation's decision, with its own test (backend/test/entrypoint-media-isolation.test.js,
# which also runs unprivileged and reads ENTRYPOINT_UNDER_TEST); its mutants are at the bottom and run against that test.
# #553 phase 2a added a third, the private folder and the move into it (backend/test/entrypoint-private-layout.test.js,
# with a stand-in for the move, so a copied script needs no tool next to it); its mutants are last.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/backend/entrypoint.sh"
TEST="$ROOT/backend/test/entrypoint-umask.test.js"
ISO_TEST="$ROOT/backend/test/entrypoint-media-isolation.test.js"
PRIV_TEST="$ROOT/backend/test/entrypoint-private-layout.test.js"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
KILLED=0; SURVIVED=0

[ "$(uname -s)" = Linux ] || { echo "Linux only: the test is skipped elsewhere, so every mutant would 'survive'"; exit 2; }
[ "$(id -u)" != 0 ] || { echo "run as an unprivileged user: as root the unreadable-subfolder case is skipped"; exit 2; }

run_test() { ENTRYPOINT_UNDER_TEST="$1" node --test --test-reporter=tap "${2:-$TEST}" > "$T/out.tap" 2>&1; }

# Baseline: the real script passes, and the run really RAN. A skipped test passes too, so a run with any skip in it,
# or with fewer tests than the file holds, proves nothing about the mutants below.
baseline() {  # baseline <test file> <minimum number of tests>
  if ! run_test "$SRC" "$1"; then echo "BASELINE FAILED: the unmutated script does not pass $1"; tail -60 "$T/out.tap"; exit 1; fi
  if ! grep -q '^# skipped 0$' "$T/out.tap" || ! grep -q '^# fail 0$' "$T/out.tap"; then
    echo "BASELINE ran with skips or failures ($1)"; tail -20 "$T/out.tap"; exit 1
  fi
  PASS=$(sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' "$T/out.tap")
  [ "${PASS:-0}" -ge "$2" ] || { echo "BASELINE ran only ${PASS:-0} tests of $1 (expected at least $2)"; exit 1; }
  echo "  baseline ok ($PASS tests of $(basename "$1"), none skipped)"
}
baseline "$TEST" 22
baseline "$ISO_TEST" 41
baseline "$PRIV_TEST" 16

mutant() {  # mutant <name> <perl -pe expression> [test file, default the umask test]
  local name="$1" expr="$2" test="${3:-$TEST}" f="$T/entrypoint.sh"
  perl -pe "$expr" "$SRC" > "$f" || { echo "  ERROR: bad perl expression: $name"; SURVIVED=$((SURVIVED+1)); return; }
  if cmp -s "$SRC" "$f"; then echo "  ERROR: mutant did not change the file: $name"; SURVIVED=$((SURVIVED+1)); return; fi
  if ! sh -n "$f" 2>/dev/null; then echo "  ERROR: mutant does not PARSE: $name"; SURVIVED=$((SURVIVED+1)); return; fi
  if run_test "$f" "$test"; then echo "  SURVIVED: $name"; SURVIVED=$((SURVIVED+1)); else echo "  killed:   $name"; KILLED=$((KILLED+1)); fi
}

# control: a comment edit must not fail the test, proving a failure is the mutation's doing
perl -pe 's/^# --- Who can read the data directory/# --- Who can read the data directory (edited)/' "$SRC" > "$T/entrypoint.sh"
if cmp -s "$SRC" "$T/entrypoint.sh"; then echo "  CONTROL DID NOT APPLY"; SURVIVED=$((SURVIVED+1));
elif run_test "$T/entrypoint.sh"; then echo "  control ok (a comment edit passes)"; else echo "  CONTROL FAILED"; SURVIVED=$((SURVIVED+1)); fi

# --- the mask ---
mutant "the umask is never set (the app inherits Docker's 022)"            's/^umask "\$UMASK"$//'
mutant "the umask is set after mkdir -p (a first-boot data dir is 0755)"   'if (/^umask "\$UMASK"$/) { $_ = "" } s/^(mkdir -p "\$DATA_DIR")$/$1\numask "\$UMASK"/'
mutant "the default is 022"                                                's/^DEFAULT_UMASK=077$/DEFAULT_UMASK=022/'
# missing PARENTS of DATA_DIR must be 0755 (review of #549, PR #689): only the data directory itself takes the mask
mutant "the parents of a new DATA_DIR are made under the mask (no 022 step)" 's/^\( umask 022; mkdir -p "\$\(dirname "\$DATA_DIR"\)" \)$//'
mutant "the parents' step loses its 022 (they inherit the mask)"           's/^\( umask 022; mkdir -p /( mkdir -p /'

# --- validation ---
mutant "no validation (any value reaches umask)"                           's/^  0\[0-7\]\[0-7\]\) ;;$/  *) ;;/'
mutant "an owner digit is accepted (700: files the app cannot open)"       's/^  0\[0-7\]\[0-7\]\) ;;$/  [0-7][0-7][0-7]) ;;/'
mutant "0077 is not normalised (the four-digit default skips the tighten)" 's/^  00\[0-7\]\[0-7\]\) UMASK=\$\{UMASK#0\} ;;$/  00[0-7][0-7]) ;;/'
mutant "a blank UMASK warns (a cleared Unraid field)"                      's/^  \x27\x27\) UMASK=\$DEFAULT_UMASK ;;$//'
mutant "an invalid UMASK is replaced silently (no warning)"                's/^    printf .\[entrypoint\] warning: UMASK=.*$/    :/'

# --- the tighten: when ---
# (the walk's own branch is an `elif` since #553 phase 2b: the branch before it is the confined walk for media isolation)
mutant "the tighten runs at every mask (the opt-out is re-tightened)"      's/^elif \[ "\$UMASK" = 077 \]; then$/elif true; then/'
mutant "the 077 guard is inverted"                                         's/^elif \[ "\$UMASK" = 077 \]; then$/elif [ "\$UMASK" != 077 ]; then/'
mutant "the tighten never runs"                                            's/^elif \[ "\$UMASK" = 077 \]; then$/elif false; then/'

# --- the tighten: what ---
# (these are scoped to the FOUND= line, so the comments that mention the same words stay as they are)
mutant "symlinks are followed (! -type l dropped)"                         'if (/^  FOUND=/) { s/ ! -type l// }'
mutant "only group bits are looked at (-perm /077 -> /070)"                'if (/^  FOUND=/) { s/-perm \/077/-perm \/070/ }'
mutant "only other bits are looked at (-perm /077 -> /007)"                'if (/^  FOUND=/) { s/-perm \/077/-perm \/007/ }'
mutant "only other-read is looked at (-perm /077 -> /004)"                 'if (/^  FOUND=/) { s/-perm \/077/-perm \/004/ }'
mutant "no -perm filter (every entry is chmod-ed on every start)"          'if (/^  FOUND=/) { s/ -perm \/077// }'
mutant "the walk stops two levels down (-maxdepth 2: clips/<camera>/x)"     'if (/^  FOUND=/) { s/find "\$DATA_DIR" /find "\$DATA_DIR" -maxdepth 2 / }'
mutant "chmod takes only the group bits (go-rwx -> g-rwx)"                 's/chmod go-rwx/chmod g-rwx/'
mutant "only the visible top level is walked (\"\$DATA_DIR\"/*)"           'if (/^  FOUND=/) { s/find "\$DATA_DIR" /find "\$DATA_DIR"\/* / }'
# PR #689: the walk must start where chown -R starts, so a symlinked DATA_DIR is NOT walked (files behind it may be
# another uid's, and 0600 would lock the app out). A trailing slash would follow the link.
mutant "the walk follows a symlinked DATA_DIR (trailing slash added)"      'if (/^  FOUND=/) { s/find "\$DATA_DIR" /find "\$DATA_DIR\/" / }'

# --- the tighten: failure and reporting ---
mutant "nothing is counted (-print dropped)"                               's/ -print -exec / -exec /'
mutant "a failed walk is not reported"                                     's/ \|\| printf .\[entrypoint\] warning: could not tighten.*?>&2;/;/'
mutant "a failed walk stops the container (set -e)"                        's/^  FOUND=.*$/  FOUND=\$(find "\$DATA_DIR" ! -type l -perm \/077 -print | wc -l); find "\$DATA_DIR" ! -type l -perm \/077 -exec chmod go-rwx {} +/'
mutant "the report is not existence-guarded (a first boot says unknown)"   's/^  if \[ -e "\$DATA_DIR\/\$r" \]; then$/  if true; then/'
mutant "the report follows no link (stat -L -> stat: a linked db shows 777)" 's/stat -L -c %a/stat -c %a/'
mutant "the report line is never printed"                                  's/^printf .\[entrypoint\] umask .*$/:/'

# --- #553 media isolation: the decision (run against entrypoint-media-isolation.test.js) ---
I="$ISO_TEST"
mutant "the switch is never read (isolation can never be asked for)"       's/^if \[ "\$\{NIGHTLIGHT_MEDIA_ISOLATION:-\}" = 1 \]; then$/if false; then/' "$I"
mutant "any non-empty switch value asks for isolation"                     's/^if \[ "\$\{NIGHTLIGHT_MEDIA_ISOLATION:-\}" = 1 \]; then$/if [ -n "\${NIGHTLIGHT_MEDIA_ISOLATION:-}" ]; then/' "$I"
mutant "no dry run: on without proof"                                      's/^  elif media_dry_run; then$/  elif true; then/' "$I"
mutant "the probe's OK line alone is enough (its status ignored)"          's/^  if \[ "\$_rc" = 0 \] && /  if /' "$I"
mutant "the dry run has no deadline (a stalled share would hold the container)" 's/"\$_i" -ge \$\(\(MEDIA_DRY_RUN_TIMEOUT \* 10\)\)/"\$_i" -ge 999999/' "$I"
mutant "PUID=0 is not refused"                                             's/^  elif \[ "\$APP_UID" = 0 \]; then$/  elif false; then/' "$I"
mutant "a PUID/PGID equal to the media id is not refused"                  's/^  elif \[ "\$APP_UID" = "\$MEDIA_ID" \] \|\| \[ "\$APP_GID" = "\$MEDIA_ID" \]; then$/  elif false; then/' "$I"
mutant "ids compared and passed as text (01700, 099)"                      's/^APP_UID=\$\(canonical_id "\$PUID"\)$/APP_UID=\$PUID/' "$I"
mutant "an operator's MEDIA_ISOLATION=on reaches the app"                  's/^MEDIA_ISOLATION=off$/:/' "$I"
mutant "the app's drop loses --no-new-privs"                               's/ --no-new-privs"$/"/' "$I"
mutant "a fallback says nothing"                                           's/^  printf .\[entrypoint\] warning: media isolation is off.*$/  :/' "$I"

# --- #553 phase 2b: the layout steps (run against the same test) ---
mutant "a database or secret left at the top level does not refuse isolation" 's/^  elif _left=\$\(media_toplevel_leftover\); then$/  elif false; then/' "$I"
mutant "the folders are never prepared (data 0710, clips 0750, the media group)" 's/^  elif ! media_prepare_layout; then$/  elif false; then/' "$I"
mutant "the confined tighten is never used (the walk strips the group bits back off)" 's/^if \[ "\$UMASK" = 077 \] && \[ "\$\{NIGHTLIGHT_MEDIA_ISOLATION:-\}" = 1 \]; then$/if false; then/' "$I"
mutant "a refused isolation keeps the CONFINED walk (the clip tree is never tightened)" 's/^if \[ -n "\$TIGHTEN_CONFINED" \] && \[ "\$MEDIA_ISOLATION" = off \]; then$/if false; then/' "$I"
mutant "the probe is not told which folders to try"                        's/ "\$CLIPS_ABS" "\$DATA_DIR" > "\$_dd\/out"/ > "\$_dd\/out"/' "$I"
mutant "a folder another uid owns is taken over (no owner check)"          's/^  if \[ "\$\{3:-\}" != own \] && .*; then$/  if false; then/' "$I"
mutant "the parents between the data directory and a nested CLIPS_DIR are not prepared" 's/^    "\$DATA_DIR"\/\*\) media_layout_up_to .*$/    "\$DATA_DIR"\/*) ;;/' "$I"
mutant "the media group on the data directory reads as wrong ownership (a full walk every start)" 's/ && ! media_layout_ok "\$f"//' "$I"
mutant "the dry run leaves its temporary folder behind"                    's/^  rmdir -- "\$_dd" 2>\/dev\/null \|\| :$/  :/' "$I"

# --- #553 phase 2a: the private folder and the move into it (run against entrypoint-private-layout.test.js) ---
P="$PRIV_TEST"
MOVE='^if su-exec nightlight node "\$PRIVATE_TOOL"; then PRIVATE_RC=0; else PRIVATE_RC=\$\?; fi$'
mutant "the move runs in the background (the app can start mid-move, C1)"  "s/$MOVE/su-exec nightlight node \"\\\$PRIVATE_TOOL\" \\& PRIVATE_RC=0/" "$P"
mutant "the move never runs"                                               "s/$MOVE/PRIVATE_RC=0/" "$P"
mutant "a failed move stops the container (set -e, C8)"                    "s/$MOVE/su-exec nightlight node \"\\\$PRIVATE_TOOL\"; PRIVATE_RC=0/" "$P"
mutant "the move runs as root (no su-exec)"                                's/^if su-exec nightlight node /if node /' "$P"
mutant "exit 10 (something left at the top) says nothing"                  's/^  10\) private_warn .*$/  10) ;;/' "$P"
mutant "exit 11 (a copy set aside) says nothing"                           's/^  11\) private_warn .*$/  11) ;;/' "$P"
mutant "a failed move tool says nothing"                                   's/^  \*\) private_warn "private layout: the move .*$/  *) ;;/' "$P"
mutant "private/ is left to the umask (no chmod 700)"                      's/^    chmod 700 "\$PRIVATE_DIR" \|\| .*$/    :/' "$P"
mutant "private/ is chowned on every start, even when it is right"         's/^    if \[ "\$\(stat -c %u:%g "\$PRIVATE_DIR" 2>\/dev\/null\)" != "\$WANT_OWNER" \]; then$/    if true; then/' "$P"
mutant "a symbolic-link private/'s target is not made 700 (review of #870)" 's/^  if \[ -d "\$PRIVATE_DIR" \]; then$/  if [ -d "\$PRIVATE_DIR" ] && [ ! -L "\$PRIVATE_DIR" ]; then/' "$P"
mutant "a symbolic-link private/ is chown-ed through the link"             's/^  if \[ -L "\$PRIVATE_DIR" \]; then$/  if false; then/' "$P"
mutant "no warning when root cannot look inside private/"                  's/^    if ! stat "\$PRIVATE_DIR\/\." >\/dev\/null 2>&1; then$/    if false; then/' "$P"
mutant "a top-level item owned by root is never re-owned before the move"  's/^if \[ -z "\$NEEDS_CHOWN" \]; then$/if false; then/' "$P"
mutant "the re-own runs even after the full walk"                          's/^if \[ -z "\$NEEDS_CHOWN" \]; then$/if true; then/' "$P"
mutant "the re-own follows a symbolic link"                                's/^    if \[ ! -e "\$p" \] \|\| \[ -L "\$p" \]; then continue; fi$/    if [ ! -e "\$p" ]; then continue; fi/' "$P"
mutant "the modes line ignores a database in private/"                     's/^if exists_or_link "\$PRIVATE_DIR\/babymonitor.db"; then DB_AT=private\/$/if false; then DB_AT=private\//' "$P"
mutant "the modes line looks for .jwt_secret at the top level first"       's/^    if exists_or_link "\$PRIVATE_DIR\/\$f"; then r="private\/\$f"; elif/    if false; then r="private\/\$f"; elif/' "$P"

echo "== killed $KILLED, survived/error $SURVIVED"
[ "$SURVIVED" -eq 0 ]
