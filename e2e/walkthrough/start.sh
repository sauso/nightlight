#!/bin/sh
# Container command for the documentation walkthrough (see run.sh). Seeds the fictional demo household,
# turns it into a normal writable install (prepare.mjs), then starts the app with a fake camera behind it.
# Throwaway: DATA_DIR is a tmpfs, nothing here touches a real database.
set -eu

export DATA_DIR=/app/data
export DEMO_ASSET_DIR=/app/demo
# The seed lays out "last night" in this zone; UTC is the default install's zone, so the captures show
# what a fresh install shows.
export DEMO_TIMEZONE=UTC
# Only read by the seed (the 14 fictional nights end now). DEMO_MODE is deliberately NOT set: the app runs
# as an ordinary install so the captures can show saving, the review screen and a caregiver's view.
DEMO_ENDS_AT=$(node -e 'console.log(new Date(Date.now() + 3600e3).toISOString())')
export DEMO_ENDS_AT

if [ "${WALKTHROUGH_EMPTY:-}" = "1" ]; then
  # First-run state: no seed, no users, so the app offers the create-admin screen.
  exec node src/index.js
fi

node /app/src/lib/demoSeed.js
node /app/demo/prepare.mjs

env -i PATH="$PATH" HOME=/app TMPDIR=/tmp /usr/local/bin/mediamtx /app/demo/fakecam.yml &
exec node src/index.js
