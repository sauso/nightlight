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
- `soak/` — a separate, continuously-running third environment for catching runtime-plumbing bugs a single clean e2e run can't reach; see `soak/README.md`.
- `hardened.sh` — the optional container hardening, checked against the real
  image; see [Hardened container check](#hardened-container-check) below.

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
dev → main PR, nightly on dev, and on manual dispatch. A separate `hardened`
job in the same workflow runs `hardened.sh`.

The weekly image rebuild (`.github/workflows/weekly-rebuild.yml`) also runs
`prove.sh --keep` against each rebuilt image before it moves `:latest` or `:dev`,
then signs in with the admin account `prove.sh` creates to check the AAC audio
track. If you change that account or the `--keep` option, update the workflow too.

## Hardened container check

`hardened.sh` starts the image the way
[docs/operations.md](../docs/operations.md#hardening-the-container-optional)
describes: every Linux capability dropped except CHOWN, DAC_OVERRIDE, FOWNER,
KILL, SETUID and SETGID, plus `no-new-privileges`. It runs with `PUID=99` and
`PGID=100`, so the hand-over from root to the app user really happens (the
stack above runs as `PUID=0`), and on a data volume that survives between
starts.

It needs a **Linux** Docker host, because it reads the container's processes
from the host's `/proc` (Docker Desktop keeps them inside its VM). It uses its
own containers, network, volumes and host port (`E2E_HARDENED_PORT`, default
4100), so it can run next to the stack above. Build the image first, or it
tests the last published `:dev`:

```bash
docker build -t sauso/nightlight:dev .
bash e2e/hardened.sh            # everything: green, then K, D and F
bash e2e/hardened.sh green      # one part: green, k, d or f
bash e2e/hardened.sh teardown   # remove whatever a killed run left behind
```

Every container in this script is started with `NIGHTLIGHT_MEDIA_ISOLATION=0`.
Media isolation is on by default, and the assertions below (every process runs
as the app user, a `700` data directory) describe the plain start. The same six
capabilities with isolation on, and the fallbacks, are `media-isolation.sh`
(`bash e2e/media-isolation.sh`), which runs as its own CI job.

`NIGHTLIGHT_IMAGE` picks another image; `HARDENED_LOG_DIR` keeps every
container's log in that folder (CI uploads it as the `hardened-logs` artifact).

| Part | Run with | Passes when | What that proves |
|---|---|---|---|
| green | all six | Healthy; the synthetic camera streams over HLS; tini and every process under it have the six-capability bounding set (`CapBnd 00000000000000eb`) and `NoNewPrivs 1`; node, MediaMTX and FFmpeg run as 99:100 with no group 0; `docker inspect` shows the flags; the two-factor recovery command works; `docker stop` gives exit code 0 and the app's `Shutting down` line; the data directory ends `700` and 99:100 with no `could not tighten`; a second container on the same data starts healthy | The hardened container starts, streams, stops cleanly and restarts on the same data (it does not make a recording; that is on the owner's staging checklist) |
| K | KILL left out | `docker stop` gives a non-zero exit code, a `FATAL tini` line and no `Shutting down` line | Without KILL the stop signal never reaches the app, and the green stop check can tell |
| D | DAC_OVERRIDE left out | The first start works but the two-factor recovery command fails; a second container on the same data exits non-zero with the expected line (`D_SIGNATURE_RE`) | Root needs DAC_OVERRIDE to get into the owner-only data directory, and the green recovery check and second start can tell |
| F | FOWNER left out | A `could not tighten` warning, and the data directory does not end `700` | Without FOWNER existing files keep their group/other access, and the green mode check can tell |

A part fails the script when its expectation does not show, including a
control whose failure does not appear. Every expectation (the capability
list, the bounding-set value, the log lines, the timeouts) is a variable at the
top of the script. The capability list also appears in `docker-compose.yml`
and `docs/operations.md`: change all three together.

## Private folder upgrade check

`private-layout.sh` (#553) proves the one-way move of the database and secrets
into the data directory's `private/` folder
([docs/operations.md](../docs/operations.md#the-private-folder)) on a real
install. It makes that install with the **last release** (pulled from Docker
Hub: `NIGHTLIGHT_OLD_IMAGE`, default `sauso/nightlight:0.43.0`), then starts the
image under test on it. It sources `hardened.sh` for its helpers, with its own
project name and host port (`E2E_PRIVATE_LAYOUT_PORT`, default 4300). Linux
Docker host and network access needed.

```bash
docker build -t sauso/nightlight:dev .
bash e2e/private-layout.sh            # everything: upgrade, puid0, empty
bash e2e/private-layout.sh upgrade    # one part: upgrade, puid0 or empty
bash e2e/private-layout.sh teardown
```

| Part | Passes when |
|---|---|
| upgrade | The old install (a database with a row only in its `-wal`, a `.jwt_secret`, a root-owned Firebase file and backup, alert and bed pictures) is moved into `private/` by the first start under the six-capability hardening: nothing left at the top level, `private/` `700`, secrets `600`, all 99:100, the `.jwt_secret` unchanged, the old session and password still work, the `-wal` row is there, the console scripts and `backup-db.js` work, one `private layout:` line and no warning. A second, new container is a no-op. The old image on the moved data starts empty (the documented rollback statement), and the next start of the new image sets its empty copy aside with one warning while the old session still works. After the documented move-back commands (run as root) the old image has the real data and the old session, and the new image moves it all in again. |
| puid0 | The same upgrade with `PUID=0`. |
| empty | `reset-mfa.js`, `promote-admin.js` and `backup-db.js` run as root on a volume that never started fail and leave it empty. |

`PRIVATE_LAYOUT_LOG_DIR` keeps every container's log (CI uploads it as the
`private-layout-logs` artifact).

## Upgrading Playwright

Move the exact `@playwright/test` version in `playwright/package.json` and the
`mcr.microsoft.com/playwright` image tag in `docker-compose.e2e.yml` together.
The backend `dependency-hygiene.test.js` guard checks that they match. On a
Dependabot PR, push the matching image bump to that PR before merging it.
`playwright/package-lock.json` is gitignored because the container creates it
on each run; the exact Playwright pin determines the package versions.

## Refreshing the documentation screenshots

The walkthrough in [docs/](../docs/README.md#visual-walkthrough) is captured from the real image running a
made-up household, by a script you run on your own machine (no CI run needed):

```
cd e2e/playwright && npm ci && cd ../..     # once: installs Playwright
sh e2e/walkthrough/run.sh                   # default image sauso/nightlight:dev; pass another image as the argument
```

It needs Docker. `run.sh` starts two throwaway containers (nothing touches a real database): one seeded with the
fictional demo household (`backend/src/lib/demoSeed.js`) and turned into a normal writable install by
`walkthrough/prepare.mjs`, and one empty, for the first-run screen. `walkthrough/capture.mjs` drives them and
writes the PNGs into `docs/screenshots/`. Look at the images, update the captions in `docs/README.md` if a screen
changed, and commit the PNGs. If Playwright's own browser is not installed, set `WALK_CHROMIUM` to a Chromium
executable. The video is synthetic (`walkthrough/make-loop.sh`); the image ships no fonts, so it has no caption.

`playwright/tests/05-screenshots.spec.js` still captures a few screens into `playwright/screenshots/` (uploaded by
CI as the `docs-screenshots` artifact), but only as a smoke test that those screens render. The committed images
come from the walkthrough, not from that artifact.
