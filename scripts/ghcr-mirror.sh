#!/bin/sh
# Copy a published image from Docker Hub to ghcr.io BY DIGEST, so both registries serve the same bytes
# (the multi-arch index with its SBOM and provenance attestations) under the same tags. Docker Hub stays
# the primary; ghcr.io is a mirror. docs/operations.md, "Registries".
#
# Called by docker-publish.yml (job mirror-ghcr after every Docker Hub publish, with DIGEST; job copy-tags
# when the workflow is dispatched with copy_tags, with --resolve) and weekly-rebuild.yml (after it promotes
# :latest or :dev, with DIGEST).
#
# Inputs come from the environment ONLY. The workflows pass them through `env:`, never as `${{ }}` inside
# a `run:` block, so a value can never become shell code; and every value is checked here before any
# command sees it.
#   SRC_REPO  the Docker Hub repository (default sauso/nightlight)
#   DST_REPO  the mirror repository (default ghcr.io/sauso/nightlight)
#   DIGEST    sha256:<64 lower-case hex>, the image index Docker Hub serves. Blank with --resolve.
#   TAGS      tags separated by spaces or newlines: latest, dev, X.Y, X.Y.Z or a 7-40 character short sha.
#             A full reference to SRC_REPO (sauso/nightlight:dev, the form docker/metadata-action lists)
#             is reduced to its tag; a reference to any other repository is refused.
#   FORCE     true lets an existing X.Y.Z tag on DST_REPO move to another digest; blank or false refuses.
#
# Modes:
#   (none)     copy every tag from DIGEST (the image a publish or a promotion just produced).
#   --resolve  no DIGEST: read each tag's digest from SRC_REPO ONCE, then copy that tag from that digest
#              (tags published earlier, or a mirror to repair). Each tag is a separate image.
#   --check    check SRC_REPO, DST_REPO, TAGS and FORCE (not DIGEST), print the bare tags one per line and
#              call nothing else. The workflows use it to fail before logging in, and docker-publish.yml uses
#              it to turn metadata-action's list into bare tags (see the comment there on why).
#
# Exit codes: 0 every tag points at its digest; 1 a registry command failed (including an unreadable
# SRC_REPO tag with --resolve); 2 bad input (nothing was called); 3 refused to move an existing X.Y.Z tag;
# 4 a tag did not read back as its digest. Every tag is attempted even after one fails (a refused release
# tag must not also leave :latest behind); the exit code is the first failure's. Each failure prints the
# command that copies that tag again.
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
if [ $# -eq 1 ]; then
  case $1 in
    --check) MODE=check ;;
    --resolve) MODE=resolve ;;
    *) bad_input 'usage: ghcr-mirror.sh [--check | --resolve], with the inputs in the environment' ;;
  esac
elif [ $# -ne 0 ]; then bad_input 'usage: ghcr-mirror.sh [--check | --resolve], with the inputs in the environment'
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

if [ "$MODE" = resolve ]; then
  # Each tag is read from SRC_REPO below; a DIGEST here would say one image for all of them.
  [ -z "$DIGEST" ] || bad_input 'DIGEST must be blank with --resolve: each tag is read from SRC_REPO'
else
  valid_digest "$DIGEST" || bad_input 'DIGEST is not sha256: followed by 64 lower-case hex digits'
fi

ERRF=$(mktemp) || { echo 'ghcr-mirror: cannot create a temporary file' >&2; exit 1; }
trap 'rm -f "$ERRF"' EXIT
trap 'exit 1' HUP INT TERM
CR=$(printf '\r')
TAB=$(printf '\t')

# The digest a reference points at, from `imagetools inspect`: the output shape was checked against buildx
# 0.37 (Docker 29.8), where `{{json .Manifest.Digest}}` prints the digest in double quotes with no newline
# (weekly-rebuild.yml reads it the same way). Sets OUT_D, or returns 1 with the message in READ_ERR.
inspect_digest() {
  OUT_D=
  READ_ERR=
  if out=$(docker buildx imagetools inspect "$1" --format '{{json .Manifest.Digest}}' 2>"$ERRF"); then
    out=${out#\"}
    out=${out%\"}
    if valid_digest "$out"; then OUT_D=$out; return 0; fi
    READ_ERR="unexpected answer: $out"
    return 1
  fi
  READ_ERR=$(cat "$ERRF")
  return 1
}

# True only when the WHOLE last inspect error is EXACTLY the registry's not-found for reference $1:
# "ERROR: <reference>: not found", as buildx printed it against a real registry (a Docker Hub reference is
# printed with docker.io/ in front only for an unqualified Docker Hub reference). Trailing spaces, tabs and a CR
# are ignored; nothing else is. A substring match
# would read "...:1.2.3: not found in token scope" or "...@sha256:<digest>: not found" as "the tag is absent", and
# an absent X.Y.Z tag is the one case that is copied without the refusal check.
is_not_found() {
  line=$READ_ERR
  while :; do
    case $line in *' '|*"$TAB"|*"$CR") line=${line%?} ;; *) break ;; esac
  done
  case $line in "ERROR: $1: not found") return 0 ;; esac
  # Buildx adds docker.io/ only to an unqualified Docker Hub name. Accepting it before a host-qualified
  # reference such as ghcr.io/... would turn an unrelated registry error into proof that a release is absent.
  host=${1%%/*}
  case $host in *.*|*:*|localhost) return 1 ;; esac
  case $line in "ERROR: docker.io/$1: not found") return 0 ;; esac
  return 1
}

# Sets CUR to the digest DST_REPO:$1 points at, or to "none" when that tag does not exist yet. Any other answer
# returns 1 (READ_ERR says why): a registry that cannot be read is not evidence that a tag is absent.
read_digest() {
  CUR=
  if inspect_digest "$DST_REPO:$1"; then CUR=$OUT_D; return 0; fi
  if is_not_found "$DST_REPO:$1"; then CUR=none; return 0; fi
  return 1
}

RC=0
SUMMARY=
note() { SUMMARY="$SUMMARY- \`$DST_REPO:$1\`: $2
"; }
# $1 exit code, $2 tag, $3 the short reason (summary), $4 the detail (log).
# The repair is a copy dispatch of docker-publish.yml: it is registered with GitHub (it exists on main), so a
# dispatch from dev runs dev's copy-tags job, which reads the Docker Hub tag at that moment. No --repo: inside a
# run the owner's name prints as *** (it is also a secret's value), so a --repo would not paste; gh takes the
# repository from the checkout it is run in.
fail() {
  echo "ghcr-mirror: $DST_REPO:$2: $3. $4" >&2
  if [ "$1" -eq 3 ]; then
    # Re-running the job would only refuse again.
    echo "ghcr-mirror: to move it anyway: gh workflow run docker-publish.yml --ref dev -f copy_tags=$2 -f force=true" >&2
  else
    echo "ghcr-mirror: to copy it again: re-run this run's failed job if it is the newest publish, or gh workflow run docker-publish.yml --ref dev -f copy_tags=$2" >&2
  fi
  note "$2" "FAILED, $3"
  [ "$RC" -ne 0 ] || RC=$1
}

# Copies DST_REPO:$1 from SRC_REPO@$2 (KIND set by classify).
copy_tag() {
  tag=$1
  want=$2
  if ! read_digest "$tag"; then
    if [ "$KIND" = release ]; then
      # Fail closed: without the current digest there is no way to know whether the copy would move it.
      fail 1 "$tag" 'could not read its current digest, so it was not copied' \
        "A release tag is never moved unchecked. The registry said: $READ_ERR"
      return 0
    fi
    # A moving tag may move anyway, so its old digest is only for the log.
    echo "ghcr-mirror: $DST_REPO:$tag: could not read the current digest ($READ_ERR); copying anyway, it is a moving tag" >&2
    CUR=unknown
  fi
  if [ "$CUR" = "$want" ]; then
    echo "ghcr-mirror: $DST_REPO:$tag already points at $want"
    note "$tag" "already \`$want\`"
    return 0
  fi
  if [ "$KIND" = release ] && [ "$CUR" != none ] && [ "$FORCE" != true ]; then
    fail 3 "$tag" "REFUSED to move it from $CUR to $want" \
      'A release tag is not moved unasked: check which image is right first.'
    return 0
  fi
  PREV=$CUR
  [ "$PREV" != none ] || PREV='a new tag'
  echo "ghcr-mirror: $DST_REPO:$tag: copying $SRC_REPO@$want (was $PREV)"
  # Always FROM THE DIGEST: a tag on Docker Hub can move between the publish (or the read above) and this copy;
  # the digest is the image that was published or read. No retry loop: retrying would widen the window in which
  # an older run could overwrite a newer one, and a failure is loud and has a one-line fix (above).
  if ! docker buildx imagetools create -t "$DST_REPO:$tag" "$SRC_REPO@$want"; then
    fail 1 "$tag" 'the copy failed' 'See the error above.'
    return 0
  fi
  # A single-source `imagetools create` of an index copies it unchanged, digest included (seen against a real
  # registry with an index of 11 attestation manifests; weekly-rebuild.yml relies on the same). Reading the tag
  # back proves it on every run.
  if ! read_digest "$tag" || [ "$CUR" != "$want" ]; then
    fail 4 "$tag" "it read back as ${CUR:-nothing}, not $want" "${READ_ERR:-}"
    return 0
  fi
  echo "ghcr-mirror: $DST_REPO:$tag now points at $want (was $PREV)"
  note "$tag" "copied \`$want\` (was $PREV)"
}

for tag in $LIST; do
  classify "$tag"
  if [ "$MODE" = resolve ]; then
    # ONE read of the Docker Hub tag; the copy uses this digest, never the tag, so what is copied is exactly
    # what this line logs even if the Docker Hub tag moves meanwhile.
    if ! inspect_digest "$SRC_REPO:$tag"; then
      fail 1 "$tag" "could not read $SRC_REPO:$tag, so it was not copied" "The registry said: $READ_ERR"
      continue
    fi
    echo "ghcr-mirror: $SRC_REPO:$tag is $OUT_D"
    copy_tag "$tag" "$OUT_D"
  else
    copy_tag "$tag" "$DIGEST"
  fi
done

printf '%s' "$SUMMARY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### ghcr.io mirror"; echo; printf '%s' "$SUMMARY"; } >> "$GITHUB_STEP_SUMMARY"
fi
exit "$RC"
