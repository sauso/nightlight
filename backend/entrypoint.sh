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

CURRENT_UID=$(id -u nightlight)
CURRENT_GID=$(id -g nightlight)

if [ "$PGID" != "$CURRENT_GID" ]; then
  groupmod -o -g "$PGID" nightlight
fi

if [ "$PUID" != "$CURRENT_UID" ]; then
  usermod -o -u "$PUID" nightlight
fi

mkdir -p "$DATA_DIR"
# Runs on every start, not just first install - this is also what makes it safe to
# adopt on an existing deployment: any files left over from an earlier root-only setup
# get fixed up automatically, no separate migration step needed.
chown -R nightlight:nightlight "$DATA_DIR"

exec su-exec nightlight "$@"
