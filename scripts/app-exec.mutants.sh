#!/bin/sh
# #965: root-only Alpine mutation check for the real app-exec.sh privilege boundary.
# Work on a temporary copy so each mutant is independent and the checkout stays untouched.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/backend/app-exec.sh"
TEST="$ROOT/backend/test/app-exec-real.test.js"
TMP=$(mktemp -d)
chmod 755 "$TMP"
trap 'rm -rf "$TMP"' EXIT
FAIL=0

[ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || { echo 'root on Linux is required'; exit 2; }
run_test() { APP_EXEC_UNDER_TEST="$1" node --test --test-isolation=none --test-reporter=tap "$TEST" > "$TMP/out.tap" 2>&1; }

if ! run_test "$SRC" || ! grep -q '^# skipped 0$' "$TMP/out.tap" || ! grep -q '^# pass 2$' "$TMP/out.tap"; then
  echo 'BASELINE FAILED or skipped'; tail -30 "$TMP/out.tap"; exit 1
fi
echo '  baseline ok (2 tests, none skipped)'

# A comment-only edit must pass, or mutation failures would prove nothing.
sed 's/^# Refuse root/# Refuse root (control)/' "$SRC" > "$TMP/app-exec.sh"
if cmp -s "$SRC" "$TMP/app-exec.sh" || ! sh -n "$TMP/app-exec.sh" || ! run_test "$TMP/app-exec.sh"; then
  echo '  ERROR: control edit failed'; FAIL=1
else echo '  control ok'; fi

mutant() {
  name=$1
  expression=$2
  sed "$expression" "$SRC" > "$TMP/app-exec.sh" || { echo "  ERROR: sed failed: $name"; FAIL=1; return; }
  if cmp -s "$SRC" "$TMP/app-exec.sh"; then echo "  ERROR: unchanged: $name"; FAIL=1; return; fi
  if ! sh -n "$TMP/app-exec.sh"; then echo "  ERROR: does not parse: $name"; FAIL=1; return; fi
  if run_test "$TMP/app-exec.sh"; then echo "  SURVIVED: $name"; FAIL=1
  else echo "  killed: $name"; fi
}

mutant 'inherited capabilities retained' 's/ --inh-caps=-all//'
# No mutant for `--ambient-caps=-all`: it is EQUIVALENT. The kernel drops any ambient capability that is not also in
# the inheritable set (capabilities(7)), so `--inh-caps=-all` already empties it, and the test above, which hands the
# wrapper ambient SETUID/SETGID/KILL, sees CapAmb 0 without the flag (first CI run of this script, #966). The flag stays
# as defence in depth, like media-exec.sh. A "mutant" that cannot change behaviour is documented, not chased.
mutant 'no-new-privs dropped' 's/ --no-new-privs//'
mutant 'supplemental groups retained' 's/ --groups="\$gid"//'
mutant 'uid zero accepted' '/^case "\$1" in /s/^/# /'
mutant 'umask weakened' 's/^umask 077$/umask 022/'
exit "$FAIL"
