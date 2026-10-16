#!/bin/sh
# shellcheck shell=sh
#
# Source me to get the Node major the project supports onto PATH:   . scripts/use-node.sh
#
# WHY THIS EXISTS (issue #565, #751). The supported Node major is stated once, in `.nvmrc`, and enforced by
# backend/test/node-version-pin.test.js. Some sandboxes that run the tests (the cloud builders) come with an OLDER Node
# (22.x was measured there), and on it the backend suite fails in ways that look unrelated to any change
# (`mock.module is not a function`, `The requested module 'child_process' does not provide an export named 'spawn'`,
# about 18 red tests). This script makes that a one-line fix instead of a misleading red run.
#
# WHAT IT DOES, in order, stopping at the first that works:
#   1. The Node on PATH is already new enough: say so and stop (the normal case on a developer machine and in CI).
#   2. nvm, fnm or volta, if one is installed.
#   3. Download the latest release of that major from nodejs.org into ~/.cache/nightlight-node/<major>, check its
#      SHA-256 against the SHASUMS256.txt published beside it, and put it first on PATH. Linux and macOS, x64 and arm64.
# It never touches the system Node, never uses sudo, and never runs anything it downloaded except `node -v` to confirm.
#
# LIMITS, said plainly: the download path checks integrity against a file from the same host, so it guards against a
# truncated or corrupted download, NOT against a compromised nodejs.org; the project's own CI and Docker image do not use
# this script. It was written on Windows and NOT run on a Linux sandbox when it was added: the first cloud session that
# runs it is the first test, and a failure prints why and leaves PATH unchanged.
#
# Sourced, not executed, because a child process cannot change its parent's PATH. `return` is used, not `exit`, so a
# failure here does not close the caller's shell.

nl_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
nl_want=$(tr -d ' \r\n' < "$nl_root/.nvmrc" 2>/dev/null)
case "$nl_want" in
  '' | *[!0-9]*)
    echo "use-node: $nl_root/.nvmrc must be a bare major version (got '$nl_want')" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

nl_have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$nl_have" -ge "$nl_want" ] 2>/dev/null; then
  echo "use-node: node $(node -v) already satisfies >= $nl_want"
  return 0 2>/dev/null || exit 0
fi
echo "use-node: node is ${nl_have:-missing}, the project needs >= $nl_want; looking for a way to get it"

nl_check() {
  nl_now=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$nl_now" -ge "$nl_want" ] 2>/dev/null
}

# 2. a version manager that is already there
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install "$nl_want" >/dev/null 2>&1 && nvm use "$nl_want" >/dev/null 2>&1
  if nl_check; then echo "use-node: now node $(node -v) (nvm)"; return 0 2>/dev/null || exit 0; fi
fi
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env 2>/dev/null)" && fnm install "$nl_want" >/dev/null 2>&1 && fnm use "$nl_want" >/dev/null 2>&1
  if nl_check; then echo "use-node: now node $(node -v) (fnm)"; return 0 2>/dev/null || exit 0; fi
fi
if command -v volta >/dev/null 2>&1; then
  volta install "node@$nl_want" >/dev/null 2>&1
  if nl_check; then echo "use-node: now node $(node -v) (volta)"; return 0 2>/dev/null || exit 0; fi
fi

# 3. download from nodejs.org
nl_os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64 | amd64) nl_arch=x64 ;;
  aarch64 | arm64) nl_arch=arm64 ;;
  *) nl_arch='' ;;
esac
case "$nl_os" in linux | darwin) ;; *) nl_arch='' ;; esac
if [ -z "$nl_arch" ]; then
  echo "use-node: no download for $(uname -s)/$(uname -m); install Node $nl_want by hand" >&2
  return 1 2>/dev/null || exit 1
fi
for nl_tool in curl tar sha256sum; do
  command -v "$nl_tool" >/dev/null 2>&1 || {
    echo "use-node: needs $nl_tool for the download" >&2
    return 1 2>/dev/null || exit 1
  }
done

nl_base="https://nodejs.org/dist/latest-v${nl_want}.x"
nl_dir="${HOME}/.cache/nightlight-node/${nl_want}"
nl_tmp=$(mktemp -d 2>/dev/null) || nl_tmp="${TMPDIR:-/tmp}/use-node.$$"
mkdir -p "$nl_tmp" "$nl_dir"
if curl -fsSL "$nl_base/SHASUMS256.txt" -o "$nl_tmp/SHASUMS256.txt"; then
  nl_file=$(awk -v suffix="-${nl_os}-${nl_arch}.tar.gz" '$2 ~ suffix"$" {print $2; exit}' "$nl_tmp/SHASUMS256.txt")
  nl_sum=$(awk -v f="$nl_file" '$2 == f {print $1; exit}' "$nl_tmp/SHASUMS256.txt")
  if [ -n "$nl_file" ] && [ -n "$nl_sum" ] && curl -fsSL "$nl_base/$nl_file" -o "$nl_tmp/$nl_file"; then
    if [ "$(sha256sum "$nl_tmp/$nl_file" | awk '{print $1}')" = "$nl_sum" ]; then
      tar -xzf "$nl_tmp/$nl_file" -C "$nl_dir" --strip-components=1
      PATH="$nl_dir/bin:$PATH"
      export PATH
    else
      echo "use-node: SHA-256 of $nl_file does not match SHASUMS256.txt; not using it" >&2
    fi
  else
    echo "use-node: could not fetch $nl_base/$nl_file" >&2
  fi
else
  echo "use-node: could not fetch $nl_base/SHASUMS256.txt (no network access to nodejs.org?)" >&2
fi
rm -rf "$nl_tmp"

if nl_check; then
  echo "use-node: now node $(node -v) (downloaded to $nl_dir)"
  return 0 2>/dev/null || exit 0
fi
echo "use-node: could not get Node $nl_want; node is still $(node -v 2>/dev/null || echo missing). Set it in the sandbox's setup script instead." >&2
return 1 2>/dev/null || exit 1
