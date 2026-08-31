#!/usr/bin/env bash
# Phase 2: run the Playwright UI suite against the e2e stack. Brings up the app +
# synthetic camera, runs the tests in the in-network Playwright container, and tears
# the stack down. The Playwright report + traces land in playwright/playwright-report
# and playwright/test-results on the host.
#
#   ./test.sh            # up -> test -> down
#   ./test.sh --keep     # leave the stack up afterwards
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE=(docker compose -f docker-compose.e2e.yml -p nightlight-e2e)
PORT=${E2E_PORT:-4000}
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

cleanup() { [ "$KEEP" = "1" ] || "${COMPOSE[@]}" --profile test down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== Bringing up app + synthetic camera + TLS proxy"
"${COMPOSE[@]}" up -d nightlight fakecam proxy

echo "== Waiting for the app to answer"
for i in $(seq 1 60); do
  curl -fsS "http://localhost:${PORT}/api/auth/status" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "app never answered on :${PORT}"; exit 1; }
  sleep 2
done

# The morning-review spec needs a night to review, and a night is normally produced by the overnight
# job from camera activity. Rather than fabricate hours of activity, seed one completed night directly
# — the spec that uses it tests the REVIEW round trip, not sleep detection, and says so.
echo "== Seeding a reviewable night"
# MSYS_NO_PATHCONV: on a Windows dev box Git Bash rewrites any argument that looks like a Unix path,
# so the container-side /tmp/... becomes C:/Users/... and node cannot find the file. Harmless no-op on
# Linux and in CI, where the variable simply goes unread.
MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" cp seed-review-night.mjs nightlight:/tmp/seed-review-night.mjs
MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T nightlight node /tmp/seed-review-night.mjs

echo "== Running Playwright"
"${COMPOSE[@]}" --profile test run --rm playwright
