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

echo "== Bringing up app + synthetic camera"
"${COMPOSE[@]}" up -d nightlight fakecam

echo "== Waiting for the app to answer"
for i in $(seq 1 60); do
  curl -fsS "http://localhost:${PORT}/api/auth/status" >/dev/null 2>&1 && break
  [ "$i" = 60 ] && { echo "app never answered on :${PORT}"; exit 1; }
  sleep 2
done

echo "== Running Playwright"
"${COMPOSE[@]}" --profile test run --rm playwright
