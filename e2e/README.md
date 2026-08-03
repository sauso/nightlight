# Nightlight end-to-end tests

Test infrastructure — **not** part of the production deployment. Runs the real
app image against a synthetic RTSP camera so the whole pipeline (transcoder →
MediaMTX → WHEP/HLS) is exercised with no camera hardware. See
`planning/documentation-and-e2e-testing-scope.md` for the phased plan.

## Pieces

- `fakecam/mediamtx.yml` — a standalone MediaMTX that generates a test
  pattern + tone on demand and serves it as `rtsp://fakecam:8554/test`.
- `docker-compose.e2e.yml` — the app image (`sauso/nightlight:dev`) + the fake
  camera on a bridge network, app published on `:4000`, ephemeral (tmpfs) data
  so every run is a clean first-run.
- `prove.sh` — Phase 1 gate: brings the stack up, drives the real create-admin
  flow, adds the synthetic camera through the real API, and confirms playable
  HLS frames come out the far end. Run this before writing/trusting Playwright.

## Run (needs a Docker host)

```bash
cd e2e
./prove.sh            # up → prove → down
./prove.sh --keep     # leave it running to poke at http://localhost:4000
```

Playwright specs (Phase 2) and the CI workflow (Phase 4) build on this same
stack — added in later phases.
