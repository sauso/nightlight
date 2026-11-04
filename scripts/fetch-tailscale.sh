#!/bin/sh
# #971: a reviewed digest must match before tar sees untrusted vendor bytes.
set -eu
[ "$#" -eq 4 ] || { echo 'usage: fetch-tailscale.sh <amd64|arm64> <version> <sha256> <outdir>' >&2; exit 1; }
arch=$1
version=$2
expected=$3
outdir=$4
case "$arch" in amd64|arm64) ;; *) echo TAILSCALE_UNSUPPORTED_ARCH >&2; exit 1 ;; esac
case "$version" in ''|*[!0-9.]*|.*|*.|*..*) echo 'invalid Tailscale version' >&2; exit 1 ;; esac
case "$expected" in *[!0-9a-f]*) echo 'invalid Tailscale SHA-256' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo 'invalid Tailscale SHA-256' >&2; exit 1; }
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT HUP INT TERM
url="https://pkgs.tailscale.com/stable/tailscale_${version}_${arch}.tgz"
# GNU wget supplies --max-redirect=0; the binary stage installs it explicitly
# because BusyBox wget has no redirect limit option. A changed host is refused.
wget --max-redirect=0 -O "$archive" "$url"
actual=$(sha256sum "$archive")
actual=${actual%% *}
if [ "$actual" != "$expected" ]; then
  printf 'TAILSCALE_DIGEST_MISMATCH expected=%s actual=%s\n' "$expected" "$actual" >&2
  exit 1
fi
prefix="tailscale_${version}_${arch}"
# Inspect the selected entries before extraction: links and missing/duplicate entries fail.
#
# Opus review of #972 (verified by running): BusyBox tar lists a HARD link as a regular-file line ending
# "-> target" (its first column still starts with "-"), so the column test alone let one through. A listing
# line containing " -> " or " link to " is refused too. (Only reachable after the digest matched: defence in depth.)
tar -tvzf "$archive" "$prefix/tailscale" "$prefix/tailscaled" | awk '
  $1 !~ /^-/ { bad=1 }
  / -> / || / link to / { bad=1 }
  END { if (NR != 2 || bad) exit 1 }
'
mkdir -p "$outdir"
tar -xzf "$archive" -C "$outdir" --strip-components=1 "$prefix/tailscale" "$prefix/tailscaled"
[ -f "$outdir/tailscale" ] && [ ! -L "$outdir/tailscale" ] &&
[ -f "$outdir/tailscaled" ] && [ ! -L "$outdir/tailscaled" ] || exit 1
chmod 0755 "$outdir/tailscale" "$outdir/tailscaled"
