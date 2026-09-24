# Nightlight end-to-end tests

Test infrastructure — **not** part of the production deployment. Runs the real
app image against a synthetic RTSP camera so the whole pipeline (transcoder →
MediaMTX → WHEP/HLS) is exercised with no camera hardware. See
`planning/ROADMAP.md` §2.4 for the remaining phases.

## Pieces

- `fakecam/mediamtx.yml` — a standalone MediaMTX that generates a test
  pattern + tone on demand and serves it as `rtsp://fakecam:8554/test`.
- `docker-compose.e2e.yml` — the app image (`sauso/nightlight:dev`) + the fake
  camera on a bridge network, app published on `:4000`, ephemeral (tmpfs) data
  so every run is a clean first-run.
- `prove.sh` — Phase 1 gate: brings the stack up, drives the real create-admin
  flow, adds the synthetic camera through the real API, and confirms playable
  HLS frames come out the far end. Run this before writing/trusting Playwright.
- `playwright/` — Phase 2 UI suite (first-run → login, add camera → live tile,
  audio toggle, settings). Runs as an in-compose service (`test` profile) using
  the official Playwright image, so it needs no host Node.
- `test.sh` — brings up a fresh stack and runs the Playwright suite in-network.
  The report + traces land in `playwright/playwright-report` and
  `playwright/test-results`.

## Run (needs a Docker host)

```bash
cd e2e
./prove.sh            # Phase 1: pipeline prove-out (up → prove → down)
./test.sh             # Phase 2: Playwright UI suite (up → test → down)
./prove.sh --keep     # leave it running to poke at http://localhost:4000
```

Heads-up: the Playwright image is ~1.9 GB. Run this on a machine with room —
GitHub-hosted runners (where CI runs it, see `.github/workflows/e2e.yml`) are
the intended venue; a small Docker vdisk (e.g. Unraid's default 40 GB, already
full of other images) can run out of space pulling it.

CI (`.github/workflows/e2e.yml`) runs both phases on `ubuntu-latest`, on a
dev → main PR, nightly on dev, and on manual dispatch.

## Upgrading Playwright

Move the exact `@playwright/test` version in `playwright/package.json` and the
`mcr.microsoft.com/playwright` image tag in `docker-compose.e2e.yml` together.
The backend `dependency-hygiene.test.js` guard checks that they match. On a
Dependabot PR, push the matching image bump to that PR before merging it.
`playwright/package-lock.json` is gitignored because the container creates it
on each run; the exact Playwright pin determines the package versions.

## Refreshing the documentation screenshots

`playwright/tests/05-screenshots.spec.js` captures the app's main screens (as a byproduct
of the suite) into `playwright/screenshots/` (gitignored). CI uploads them as the
**`docs-screenshots`** artifact. To refresh the images used in [docs/](../docs/README.md):

1. Trigger an e2e run (a dev → main PR, the nightly, or a manual dispatch once the workflow
   is on the default branch).
2. Download the **`docs-screenshots`** artifact from that run
   (`gh run download <run-id> --name docs-screenshots --dir docs/screenshots`).
3. Commit the updated PNGs under `docs/screenshots/`.

They're committed (not generated at doc-view time) so they render on GitHub.
