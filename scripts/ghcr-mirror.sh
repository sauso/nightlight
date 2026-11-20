#!/bin/sh
# Copy a published image from Docker Hub to ghcr.io BY DIGEST, so both registries serve the same bytes
# (the multi-arch index with its SBOM and provenance attestations) under the same tags. Docker Hub stays
# the primary; ghcr.io is a mirror. docs/operations.md, "Registries".
#
# Called by docker-publish.yml (job mirror-ghcr, after every Docker Hub publish), weekly-rebuild.yml
# (after it promotes :latest or :dev) and ghcr-copy.yml (by hand: tags published before the mirror
# existed, or a mirror that failed).
#
# Inputs come from the environment ONLY. The workflows pass them through `env:`, never as `${{ }}` inside
# a `run:` block, so a value can never become shell code; and every value is checked here before any
# command sees it.
#   SRC_REPO  the Docker Hub repository (default sauso/nightlight)
#   DST_REPO  the mirror repository (default ghcr.io/sauso/nightlight)
#   DIGEST    sha256:<64 lower-case hex>, the image index Docker Hub serves
#   TAGS      tags separated by spaces or newlines: latest, dev, X.Y, X.Y.Z or a 7-40 character short sha.
#             A full reference to SRC_REPO (sauso/nightlight:dev, the form docker/metadata-action lists)
#             is reduced to its tag; a reference to any other repository is refused.
#   FORCE     true lets an existing X.Y.Z tag on DST_REPO move to another digest; blank or false refuses.
#
# `--check` checks SRC_REPO, DST_REPO, TAGS and FORCE (not DIGEST), prints the bare tags one per line and
# calls nothing else. The workflows use it to fail before logging in, and docker-publish.yml uses it to
# turn metadata-action's list into bare tags (see the comment there on why it cannot pass the list as is).
#
# Exit codes: 0 every tag points at DIGEST; 1 a registry command failed; 2 bad input (nothing was called);
# 3 refused to move an existing X.Y.Z tag; 4 a tag did not read back as DIGEST. Every tag is attempted
# even after one fails (a refused release tag must not also leave :latest behind); the exit code is the
# first failure's. Each failure prints the command that copies that tag again.
set -eu
# TAGS is split on whitespace below. No pathname expansion, ever: a tag of `*` must be refused, not
# replaced by the names of whatever files are in the working directory.
set -f

SRC_REPO=${SRC_REPO:-sauso/nightlight}
DST_REPO=${DST_REPO:-ghcr.io/sauso/nightlight}
DIGEST=${DIGEST:-}
TAGS=${TAGS:-}
FORCE=${FORCE:-}

bad_input() { echo "ghcr-mirror: $1 (nothing was copied)" >&2; exit 2; }

MODE=mirror
if [ $# -eq 1 ] && [ "$1" = --check ]; then MODE=check
elif [ $# -ne 0 ]; then bad_input 'usage: ghcr-mirror.sh [--check], with the inputs in the environment'
fi

# The character lists are spelt out instead of written as ranges ([a-z]): what a range matches can depend
# on the locale, and these checks are what stands between an input and a command line.
is_hex() { case $1 in ''|*[!0123456789abcdef]*) return 1 ;; esac; return 0; }

valid_digest() {
  case $1 in sha256:*) ;; *) return 1 ;; esac
  [ ${#1} -eq 71 ] && is_hex "${1#sha256:}"
}

# A lower-case repository name with at least one '/', optionally behind a registry host[:port]. It may not
# start with '-' (it would read as an option) and may hold a ':' only in the host part (in the path it
# would read as a tag).
valid_repo() {
  case $1 in
    ''|[-./:]*|*[!abcdefghijklmnopqrstuvwxyz0123456789./_:-]*|*//*|*/|*..*) return 1 ;;
  esac
  case $1 in */*) ;; *) return 1 ;; esac
  case ${1#*/} in *:*) return 1 ;; esac
  return 0
}

# Sets TAG (the bare tag) and KIND for one entry of TAGS, or returns 1.
# KIND=release for X.Y.Z: a pinned version (the Home Assistant add-on pins one) must never change under
#   anyone, so moving it needs FORCE, a person's decision.
# KIND=moving for everything else: latest and dev move by design; X.Y is metadata-action's
#   {{major}}.{{minor}} tag, which follows the newest X.Y.Z, so it moves on every patch release; a short
#   sha is published again when the same commit is built twice (a release's branch and tag runs, a re-run).
classify() {
  TAG=$1
  case $TAG in
    *:*)
      case ${TAG%:*} in "$SRC_REPO"|"docker.io/$SRC_REPO") ;; *) return 1 ;; esac
      TAG=${TAG##*:} ;;
  esac
  case $TAG in
    latest|dev) KIND=moving; return 0 ;;
    *[!0123456789.]*|.*|*.|*..*) ;;
    *.*.*.*) ;;
    *.*.*) KIND=release; return 0 ;;
    *.*) KIND=moving; return 0 ;;
  esac
  if is_hex "$TAG" && [ ${#TAG} -ge 7 ] && [ ${#TAG} -le 40 ]; then KIND=moving; return 0; fi
  return 1
}

valid_repo "$SRC_REPO" || bad_input 'SRC_REPO is not a lower-case repository name such as sauso/nightlight'
valid_repo "$DST_REPO" || bad_input 'DST_REPO is not a lower-case repository name such as ghcr.io/sauso/nightlight'
case $FORCE in ''|false) FORCE=false ;; true) ;; *) bad_input 'FORCE must be true, false or blank' ;; esac

# Every tag is checked before the first registry call, so one bad entry means nothing is copied at all.
LIST=
for entry in $TAGS; do
  # The entry is printed after a prefix and holds no newline (TAGS was split on them), so it cannot start
  # a line of its own in the log, where Actions would read it as a workflow command.
  classify "$entry" || bad_input "'$entry' is not latest, dev, X.Y, X.Y.Z or a 7-40 character short sha"
  LIST="$LIST $TAG"
done
[ -n "$LIST" ] || bad_input 'TAGS is empty'

if [ "$MODE" = check ]; then
  for tag in $LIST; do printf '%s\n' "$tag"; done
  exit 0
fi

valid_digest "$DIGEST" || bad_input 'DIGEST is not sha256: followed by 64 lower-case hex digits'

# The re-copy command names the repository only when Actions says which it is (a fork has its own).
REPO_ARG=
case ${GITHUB_REPOSITORY:-} in
  ''|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._/-]*) ;;
  */*) REPO_ARG=" --repo $GITHUB_REPOSITORY" ;;
esac

ERRF=$(mktemp) || { echo 'ghcr-mirror: cannot create a temporary file' >&2; exit 1; }
trap 'rm -f "$ERRF"' EXIT
trap 'exit 1' HUP INT TERM

# Sets CUR to the digest DST_REPO:$1 points at, or to "none" when that tag does not exist yet. Any other
# answer returns 1 with the message in READ_ERR: a registry that cannot be read is not evidence that a tag
# is absent. The output shape was checked against buildx 0.37 (Docker 29.8): `{{json .Manifest.Digest}}`
# prints the digest in double quotes with no newline, and a missing tag fails with
# "ERROR: <reference>: not found" (weekly-rebuild.yml reads the digest the same way).
read_digest() {
  CUR=
  READ_ERR=
  if out=$(docker buildx imagetools inspect "$DST_REPO:$1" --format '{{json .Manifest.Digest}}' 2>"$ERRF"); then
    out=${out#\"}
    out=${out%\"}
    if valid_digest "$out"; then CUR=$out; return 0; fi
    READ_ERR="unexpected answer: $out"
    return 1
  fi
  READ_ERR=$(cat "$ERRF")
  case $READ_ERR in *"$DST_REPO:$1: not found"*) CUR=none; return 0 ;; esac
  return 1
}

RC=0
SUMMARY=
note() { SUMMARY="$SUMMARY- \`$DST_REPO:$1\`: $2
"; }
# $1 exit code, $2 tag, $3 the short reason (summary), $4 the detail (log). ghcr-copy.yml copies whatever
# the Docker Hub tag points at when it runs; `--ref dev` because dev has that workflow first (main gets it
# with the next release).
fail() {
  echo "ghcr-mirror: $DST_REPO:$2: $3. $4" >&2
  if [ "$1" -eq 3 ]; then
    # Re-running the job would only refuse again.
    echo "ghcr-mirror: to move it anyway: gh workflow run ghcr-copy.yml$REPO_ARG --ref dev -f tags=$2 -f force=true" >&2
  else
    echo "ghcr-mirror: to copy it again: re-run the failed job, or gh workflow run ghcr-copy.yml$REPO_ARG --ref dev -f tags=$2" >&2
  fi
  note "$2" "FAILED, $3"
  [ "$RC" -ne 0 ] || RC=$1
}

for tag in $LIST; do
  classify "$tag"
  if ! read_digest "$tag"; then
    if [ "$KIND" = release ]; then
      # Fail closed: without the current digest there is no way to know whether the copy would move it.
      fail 1 "$tag" 'could not read its current digest, so it was not copied' \
        "A release tag is never moved unchecked. The registry said: $READ_ERR"
      continue
    fi
    # A moving tag may move anyway, so its old digest is only for the log.
    echo "ghcr-mirror: $DST_REPO:$tag: could not read the current digest ($READ_ERR); copying anyway, it is a moving tag" >&2
    CUR=unknown
  fi
  if [ "$CUR" = "$DIGEST" ]; then
    echo "ghcr-mirror: $DST_REPO:$tag already points at $DIGEST"
    note "$tag" "already \`$DIGEST\`"
    continue
  fi
  if [ "$KIND" = release ] && [ "$CUR" != none ] && [ "$FORCE" != true ]; then
    fail 3 "$tag" "REFUSED to move it from $CUR to $DIGEST" \
      'A release tag is not moved unasked: check which image is right first.'
    continue
  fi
  PREV=$CUR
  [ "$PREV" != none ] || PREV='a new tag'
  echo "ghcr-mirror: $DST_REPO:$tag: copying $SRC_REPO@$DIGEST (was $PREV)"
  # Always FROM THE DIGEST: a tag on Docker Hub can move between the publish and this copy (another push);
  # the digest is the image this run published. No retry loop: retrying would widen the window in which an
  # older run could overwrite a newer one, and a failure is loud and has a one-line fix (above).
  if ! docker buildx imagetools create -t "$DST_REPO:$tag" "$SRC_REPO@$DIGEST"; then
    fail 1 "$tag" 'the copy failed' 'See the error above.'
    continue
  fi
  # A single-source `imagetools create` of an index is expected to copy it unchanged, digest included
  # (weekly-rebuild.yml relies on the same); reading the tag back proves it on every run.
  if ! read_digest "$tag" || [ "$CUR" != "$DIGEST" ]; then
    fail 4 "$tag" "it read back as ${CUR:-nothing}, not $DIGEST" "${READ_ERR:-}"
    continue
  fi
  echo "ghcr-mirror: $DST_REPO:$tag now points at $DIGEST (was $PREV)"
  note "$tag" "copied \`$DIGEST\` (was $PREV)"
done

printf '%s' "$SUMMARY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### ghcr.io mirror"; echo; printf '%s' "$SUMMARY"; } >> "$GITHUB_STEP_SUMMARY"
fi
exit "$RC"
