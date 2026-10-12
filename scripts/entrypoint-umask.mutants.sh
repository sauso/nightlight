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
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/backend/entrypoint.sh"
TEST="$ROOT/backend/test/entrypoint-umask.test.js"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
KILLED=0; SURVIVED=0

[ "$(uname -s)" = Linux ] || { echo "Linux only: the test is skipped elsewhere, so every mutant would 'survive'"; exit 2; }
[ "$(id -u)" != 0 ] || { echo "run as an unprivileged user: as root the unreadable-subfolder case is skipped"; exit 2; }

run_test() { ENTRYPOINT_UNDER_TEST="$1" node --test --test-reporter=tap "$TEST" > "$T/out.tap" 2>&1; }

# Baseline: the real script passes, and the run really RAN. A skipped test passes too, so a run with any skip in it,
# or with fewer tests than the file holds, proves nothing about the mutants below.
if ! run_test "$SRC"; then echo "BASELINE FAILED: the unmutated script does not pass"; tail -60 "$T/out.tap"; exit 1; fi
if ! grep -q '^# skipped 0$' "$T/out.tap" || ! grep -q '^# fail 0$' "$T/out.tap"; then
  echo "BASELINE ran with skips or failures"; tail -20 "$T/out.tap"; exit 1
fi
PASS=$(sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' "$T/out.tap")
[ "${PASS:-0}" -ge 20 ] || { echo "BASELINE ran only ${PASS:-0} tests (expected at least 20)"; exit 1; }
echo "  baseline ok ($PASS tests, none skipped)"

mutant() {  # mutant <name> <perl -pe expression>
  local name="$1" expr="$2" f="$T/entrypoint.sh"
  perl -pe "$expr" "$SRC" > "$f" || { echo "  ERROR: bad perl expression: $name"; SURVIVED=$((SURVIVED+1)); return; }
  if cmp -s "$SRC" "$f"; then echo "  ERROR: mutant did not change the file: $name"; SURVIVED=$((SURVIVED+1)); return; fi
  if ! sh -n "$f" 2>/dev/null; then echo "  ERROR: mutant does not PARSE: $name"; SURVIVED=$((SURVIVED+1)); return; fi
  if run_test "$f"; then echo "  SURVIVED: $name"; SURVIVED=$((SURVIVED+1)); else echo "  killed:   $name"; KILLED=$((KILLED+1)); fi
}

# control: a comment edit must not fail the test, proving a failure is the mutation's doing
perl -pe 's/^# --- Who can read the data directory/# --- Who can read the data directory (edited)/' "$SRC" > "$T/entrypoint.sh"
if cmp -s "$SRC" "$T/entrypoint.sh"; then echo "  CONTROL DID NOT APPLY"; SURVIVED=$((SURVIVED+1));
elif run_test "$T/entrypoint.sh"; then echo "  control ok (a comment edit passes)"; else echo "  CONTROL FAILED"; SURVIVED=$((SURVIVED+1)); fi

# --- the mask ---
mutant "the umask is never set (the app inherits Docker's 022)"            's/^umask "\$UMASK"$//'
mutant "the umask is set after mkdir -p (a first-boot data dir is 0755)"   'if (/^umask "\$UMASK"$/) { $_ = "" } s/^(mkdir -p "\$DATA_DIR")$/$1\numask "\$UMASK"/'
mutant "the default is 022"                                                's/^DEFAULT_UMASK=077$/DEFAULT_UMASK=022/'

# --- validation ---
mutant "no validation (any value reaches umask)"                           's/^  0\[0-7\]\[0-7\]\) ;;$/  *) ;;/'
mutant "an owner digit is accepted (700: files the app cannot open)"       's/^  0\[0-7\]\[0-7\]\) ;;$/  [0-7][0-7][0-7]) ;;/'
mutant "0077 is not normalised (the four-digit default skips the tighten)" 's/^  00\[0-7\]\[0-7\]\) UMASK=\$\{UMASK#0\} ;;$/  00[0-7][0-7]) ;;/'
mutant "a blank UMASK warns (a cleared Unraid field)"                      's/^  \x27\x27\) UMASK=\$DEFAULT_UMASK ;;$//'
mutant "an invalid UMASK is replaced silently (no warning)"                's/^    printf .\[entrypoint\] warning: UMASK=.*$/    :/'

# --- the tighten: when ---
mutant "the tighten runs at every mask (the opt-out is re-tightened)"      's/^if \[ "\$UMASK" = 077 \]; then$/if true; then/'
mutant "the 077 guard is inverted"                                         's/^if \[ "\$UMASK" = 077 \]; then$/if [ "\$UMASK" != 077 ]; then/'
mutant "the tighten never runs"                                            's/^if \[ "\$UMASK" = 077 \]; then$/if false; then/'

# --- the tighten: what ---
# (these three are scoped to the TIGHTENED= line, so the comments that mention the same words stay as they are)
mutant "symlinks are followed (! -type l dropped)"                         'if (/^  TIGHTENED=/) { s/ ! -type l// }'
mutant "only group bits are looked at (-perm /077 -> /070)"                'if (/^  TIGHTENED=/) { s/-perm \/077/-perm \/070/ }'
mutant "no -perm filter (every entry is chmod-ed on every start)"          'if (/^  TIGHTENED=/) { s/ -perm \/077// }'
mutant "chmod takes only the group bits (go-rwx -> g-rwx)"                 's/chmod go-rwx/chmod g-rwx/'
mutant "only the visible top level is walked (\"\$DATA_DIR\"/*)"           's/find "\$DATA_DIR\/" /find "\$DATA_DIR"\/* /'
mutant "a symlinked DATA_DIR is skipped (no trailing slash)"               's/find "\$DATA_DIR\/" /find "\$DATA_DIR" /'

# --- the tighten: failure and reporting ---
mutant "nothing is counted (-print dropped)"                               's/ -print -exec / -exec /'
mutant "a failed walk is not reported"                                     's/ \|\| printf .\[entrypoint\] warning: could not tighten.*?>&2;/;/'
mutant "a failed walk stops the container (set -e)"                        's/^  TIGHTENED=.*$/  TIGHTENED=\$(find "\$DATA_DIR\/" ! -type l -perm \/077 -print | wc -l); find "\$DATA_DIR\/" ! -type l -perm \/077 -exec chmod go-rwx {} +/'
mutant "the report is not existence-guarded (a first boot says unknown)"   's/^  if \[ -e "\$DATA_DIR\/\$f" \]; then$/  if true; then/'
mutant "the report line is never printed"                                  's/^printf .\[entrypoint\] umask .*$/:/'

echo "== killed $KILLED, survived/error $SURVIVED"
[ "$SURVIVED" -eq 0 ]
