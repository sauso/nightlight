# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nightlight — a self-hosted baby monitor web app. Views multiple RTSP cameras (grouped by
child) over the home network via low-latency WebRTC, installable as a PWA. Runs as a single
Docker container bundling three processes: the Node backend, MediaMTX, and
one FFmpeg process per camera.

Every user-visible change must be recorded under `[Unreleased]` in `CHANGELOG.md` in the
same commit (Keep a Changelog format, semver — see the changelog's own header for the
release procedure). **Add your entry under the EXISTING `### Added`/`### Changed`/`### Fixed`
heading — don't append a second one.** Duplicate headings are invisible in a PR diff and
[Unreleased] collected four of them across #179-#186 before anyone noticed;
`node scripts/check-changelog.mjs` now fails CI on that (structure only — it never touches wording).

> **Privacy: never write a child's name, or any other identifying household detail, into this repo** —
> code, comments, tests, docs, CHANGELOG, commit messages, PR or issue text. This repo is public. Say
> "a child", "child A", or describe the behaviour.

## Definition of done

Every change ships its tests, its docs and its changelog entry **in the same commit as the code** —
see the workspace `CLAUDE.md` for the rule and why it exists. What that means concretely here:

**Tests** live in `backend/test/*.test.js` (Node's built-in runner, no dependencies — keep it that way)
and `frontend/test/**/*.test.{js,jsx}` (vitest + RTL). `test/helpers/harness.js` gives you a real temp
database and real HTTP with **no mocks**; `frontend/test/helpers/render.jsx` renders a screen as
**both** an admin and a caregiver, which is where role-gating bugs hide. On the backend,
`backend/test/route-permissions.test.js` pins every API route's gate (public / signed-in / admin-only and
so on): a new route, or an added or removed `requireAuth`/`requireAdmin`, fails it until you edit its table
on purpose (issue #563; see `docs/architecture.md`, Auth). A fix gets a regression test you have watched
fail without the fix.

**Docs** live in `docs/`, one file per user-facing area (`recording.md`, `notifications.md`, `mfa.md`,
`design-language.md`), with `README.md` for anything that changes setup or deployment, and
`docs/architecture.md` for how the subsystems fit together (update it when you change one). Rules of thumb:
- A new **setting** is documented where its neighbours are, **with its default and its range**.
- When a new thing behaves *differently* from the thing beside it — kept for a different length of
  time, notifies when the other doesn't, appears somewhere else — **say so explicitly**. That contrast
  is what people get wrong, and a table beats prose for it.
- Changing a **settings path or a control's label** means grepping `docs/` and `README.md` for the old
  wording. A doc that names a screen that no longer exists is worse than no doc.

**Comments** carry the **why**, in the code, beside the code — and where a number or a rule came from a
measurement or an incident, they say which. `sleepAnalysis.js` is the reference: it is still readable
after a dozen threshold changes precisely because every constant states the night that set it. Not
"comment every line" — the test is whether the next person can tell a deliberate choice from an accident.

**Before opening a PR:**
```bash
cd backend && npm test && npm run test:core   # suite green + core coverage not regressed
cd ../frontend && npm test
node scripts/check-changelog.mjs              # from the repo root
git show HEAD                                 # READ IT: is the reasoning actually in the code?
```
That last line is not ceremony: a `git checkout --` once silently lost a PR's comments, leaving only
bare index arithmetic with the rationale in the commit message.

**It has to work for someone else.** This image is publicly distributed, and every threshold in
`sleepAnalysis.js` / `bedTransitionRules.js` was measured on **two cameras in one house**. Before
shipping, ask what the change assumes about whoever installs it:
- **Environment** — never hard-code a timezone, offset or locale. Read `settings.timezone` and use the
  DST-safe `zonedToUtc` / `toSqlUtc` in `sleepAnalysis.js`. A review window anchored on a literal
  `04:00Z` once hid every morning transition on a default install (`timezone` defaults to `'UTC'`, and
  that literal is only midday in a single timezone).
- **Per-installation setup** — the detector only sees what the painted `detect_zone` covers, and nothing
  validates that the zone sits on the bed. Area and rect count prove nothing — **draw the zone over a
  transition snapshot and look at it.**
- **Calibrated numbers** — fine to ship, but say which nights set them, and prefer deriving a threshold
  from the room over hard-coding it.

⚠️ If the justification for a value is one night, one camera or one child, write the sentence about
what happens to everyone else. "Known limit, documented" is an acceptable answer; silence is not.

★ **Two shapes of test that look like verification and are not**, both found repeatedly here (#263):
- **The fixture guarantees the invariant the test name claims.** A `describe('defaults')` asserting
  `1 / 30 / 14` one line after its own `beforeEach` wrote exactly those values; a containment test whose
  only assertion was `assert.ok(true, 'no throw')`, which a successful escape also satisfies; a whole
  file deriving its fixtures, loop bounds *and test names* from the constants it was meant to pin. Ask
  what value of the thing under test would make this test fail. If the answer is "none", it is a
  placeholder.
- **The test depends on the machine.** `'../../../../etc/passwd'` as an escape fixture passes on Windows
  because the file is not there, guard or no guard; a fake `ffmpeg` on PATH made four cases green while
  the handler under test ran zero times. Anything that reads `/proc/mounts`, spawns a binary, or asks
  the disk how full it is needs the answer INJECTED — see the `mounts` / `free` seams in
  `lib/clipStorage.js`, and the empty-PATH technique in `spawn-failure.test.js`.

**Review.** Every change gets an adversarial review sized to its risk: core-logic, detection/sleep,
auth and concurrency changes get the most; docs-only changes get a read-through (say which in the PR).
The workspace `CLAUDE.md` has the tiers and the reviewer brief. Point the reviewer at the PR body, tell
it to *falsify* the claims, not confirm them, and to **mutate the source and check the tests actually
kill the mutants** — coverage measures execution; mutation testing measures discrimination.

## Commands

There is no root-level build — `backend/` and `frontend/` are independent npm projects. No linter is
configured in either. `backend/` has a unit test suite (Node's built-in runner, no dependencies);
`frontend/` has its own (Vitest + Testing Library, coverage-gated in CI). End-to-end
coverage lives separately in `e2e/` (Playwright, needs Docker).

**Node 24.** CI, the Docker image and `.nvmrc` are all on Node 24, and `engines` in both `package.json`
files says `>=24` (npm only warns). Only 24 is tested: on Node 22 three backend suites fail
(`detector-observation-wiring`, `transcoder-log-redaction`, `sleepInsights`; the cause was never
established, #565). `backend/test/node-version-pin.test.js` fails if the five places drift apart.

```bash
# Backend (Node/Express, ESM, port 4000)
cd backend && npm install
npm test                     # node --test — unit tests, no container/network needed. Points DATA_DIR
                              # at a temp dir, so it never touches a real database. Prefer this over
                              # replaying logic inside a deployed container: it runs in ~3s and covers
                              # the branches real data can't reach (early bedtime, empty bed).
npm run test:core            # THE CORE-LOGIC COVERAGE GATE. Fails if the modules listed in this
                              # script's --test-coverage-include flags drop below 95% lines. Core
                              # logic must clear that bar BEFORE anything is promoted to production;
                              # CI runs it on every push/PR and the release flow runs it as a gate.
                              # That include list is the DEFINITION of core logic — grow it as
                              # modules qualify, never shrink it to go green.
                              # ⚠️ THE THRESHOLDS ARE AGGREGATES ACROSS THE WHOLE LIST, not per file.
                              # A module at 88% can sit under a green gate. To see one module, read
                              # its own row: npm run test:core 2>&1 | grep -E '^ℹ +<file>\.js'
npm run test:coverage        # full coverage report, no thresholds (for finding the next gap)
npm run test:future          # the same suite with the wall clock a YEAR AHEAD (scripts/clock-shift.mjs, #570):
                              # finds fixtures with a shelf life (the #534 shape) before the calendar does.
                              # NIGHTLIGHT_CLOCK_SHIFT_DAYS=30 (or an ISO instant, to land on a month end or a
                              # DST changeover) changes the amount; NIGHTLIGHT_CLOCK_TZ=America/Los_Angeles the
                              # zone. Moves new Date(), Date.now() and SQLite's datetime('now'); NOT timers.
                              # Weekly in CI (future-clock.yml), not on every PR: its verdict depends on today's
                              # date. A fixture that must stay put should pin its OWN clock, with a comment why.

# Repo-level checks (no install needed, run from the repo root)
node scripts/check-changelog.mjs   # CHANGELOG.md structure: one heading per type per version, in
                                   # Keep a Changelog order, released sections dated. Runs in CI.
node scripts/mutate.mjs            # MUTATION TESTING. Breaks the source one way at a time (the
                                   # catalogue is scripts/mutants.json) and reports any mutant the
                                   # tests fail to kill. NOT in CI — it is slow and it is a tool for
                                   # writing tests, not a gate. Run it when you add tests to core
                                   # logic, and add the mutants your change should be killing.
                                   #   --only=<substring>  just the mutants whose label matches
                                   #   --full              every mutant against the WHOLE suite
                                   #   --list              print the catalogue
                                   #   --check             run NO tests; fail if any `find` no longer
                                   #                       matches exactly once and every namePattern still
                                   #                       selects a test (stale entries, #575, #604). CI runs
                                   #                       this via backend/test/mutants-catalogue.test.js.
                                   #   --timeout=<ms>      per-mutant wall-clock limit (default 5 min,
                                   #                       or an entry's `timeoutMs`). A mutant that
                                   #                       outlives it is killed as a whole process
                                   #                       tree and reported HANG: counted as killed,
                                   #                       listed apart, a weaker kill (#617)
                                   # It restores every file from an in-memory byte copy and verifies
                                   # the round-trip; it never shells out to git. See the header.
                                   # A killed run is undone too: SIGINT/SIGTERM/SIGHUP restore, and a
                                   # journal (scripts/.mutate-restore.json, gitignored) lets the NEXT run
                                   # restore after a hard kill (Windows cannot catch SIGTERM, #599). A
                                   # mutant that runs no test ABORTS the run (#604); line endings in a
                                   # catalogue entry may be LF or CRLF (#597). Frontend mutants
                                   # run vitest with --reporter=json --outputFile=<fresh temp file>
                                   # and read the verdict from that file: vitest 5 does not print
                                   # the report to stdout (#520).
npm start                    # node src/index.js — expects MediaMTX/ffmpeg binaries on PATH,
                              # so in practice this is normally run inside the Docker image
                              # rather than bare on a dev machine

# Frontend (React + Vite, port 5173, proxies /api to :4000)
cd frontend && npm install
npm run dev
npm test                     # vitest run — component tests, coverage-gated in CI (see CI/CD below)
npm run test:coverage        # same suite, with the coverage report printed
                              # Two opt-in stress runs, both weekly in CI (future-clock.yml) and both off by default (#570):
                              #   NIGHTLIGHT_CLOCK_SHIFT_DAYS=365 npm test   clock a year ahead (see backend test:future)
                              #   NIGHTLIGHT_TEST_LATENCY_MS=10 npm test    every mocked request takes 10 ms, which fails a
                              #     test that reads a control or clicks a button BEFORE its data arrived. Wait for the
                              #     VALUE (findByDisplayValue) or the button to ENABLE (enabledButton in helpers/render.jsx),
                              #     not for the element to exist.
npm run build                # outputs to frontend/dist, copied into the image as ./public

# Full stack, matching production.
# --stop-timeout: shutdown finishes an in-flight recording, which needs a few seconds. Docker's own
# default is unspecified and was measured at ~4s — short enough to SIGKILL mid-save (issue #279).
docker build -t nightlight .
docker run -d --name nightlight --network host --stop-timeout 30 \
  -e PUID=99 -e PGID=100 -v ./data:/app/data nightlight
docker logs -f nightlight
```

Because MediaMTX and FFmpeg are spawned as child processes of the backend (see
`backend/src/lib/mediamtxProcess.js` and `transcoder.js`), running `npm start` outside the
Docker image will fail unless both binaries are installed and on `PATH`. When iterating on
backend logic, prefer building and running the Docker image over running `npm start` bare.

## Architecture — the invariants

**The full description is in [`docs/architecture.md`](docs/architecture.md); read the relevant section
before touching that subsystem.** These are the rules that must not be broken:

- **One image, one container**, three processes: the Node backend, MediaMTX, one FFmpeg per camera. The
  container needs its own routable LAN IP so WebRTC has no NAT/ICE problems.
- **Video pipeline order**: FFmpeg → MediaMTX → backend reverse-proxy → frontend. FFmpeg emits **two audio
  tracks** (original codec for WebRTC, AAC for HLS) because WebRTC can't decode AAC and HLS can't carry
  G711. MediaMTX camera paths are **publisher-only** — FFmpeg pushes, MediaMTX never pulls.
- **Camera passwords are never returned to the client.** GET carries address fields, a credential-free
  display URL and `rtsp_has_password`; a blank password on edit means "keep the existing one."
- **Reconciliation only writes to MediaMTX when something is actually broken** — every write forces a
  path reload that disconnects the publisher. Never reconcile unconditionally on a tick.
- **A valid JWT is not enough**: every request also checks that its `sessions` row still exists. The JWT
  secret is generated and persisted, **never a hardcoded fallback** (the image is public).
- **Schema changes are hand-written, idempotent migrations** at the bottom of `db.js` (`PRAGMA table_info`
  + conditional `ALTER TABLE`). There is no migration framework.
- **The app process never runs as root** (entrypoint remaps `PUID`/`PGID`, then `su-exec`).
- **The Settings hub is reachable by caregivers**; every Settings *sub*-route is individually
  `AdminProtected`.
- **The CSP is enforcing.** Never add `unsafe-inline` / `unsafe-eval` to `script-src`; read the inline
  comment above the policy before changing it.

### CI/CD

`.github/workflows/test.yml` runs on every push/PR: `unit` (backend), `core-coverage` (the
>=95% core-logic gate), `frontend` (component tests + coverage gate), `changelog` (structure
check), and `definition-of-done` (a warning-only docs/tests reminder, not a hard gate).

`.github/workflows/docker-publish.yml` is separate — it builds and pushes a multi-arch
(amd64/arm64) image to Docker Hub (`sauso/nightlight`) and runs no tests itself. Which tag it
publishes depends on the ref:
- push to **`dev`** → `:dev` (staging). Does NOT touch `:latest`.
- push to **`main`** or a **`v*` tag** → `:latest` (+ semver tags). This is production.

## Branching and deploy pipeline
See the workspace `CLAUDE.md` for the branch model. In short: work on `dev`, release to
`main` via PR. Two containers run on Unraid:

- **Production** — on a `br0.10` ipvlan network with its own dedicated routable LAN IP (so WebRTC
  works without host networking — MediaMTX advertises that IP), data dir
  `/mnt/user/appdata/nightlight`, container name `nightlight`, runs `sauso/nightlight:latest`.
  Updated only by a release to `main`.
- **Staging** — same setup on the same `br0.10` network (its own dedicated LAN IP, adjacent to
  prod's), separate data dir (`/mnt/user/appdata/nightlight-dev`), container name `nightlight-dev`,
  runs `sauso/nightlight:dev`. Test dev builds here.

Deploys/log-checks are done over SSH to the Unraid host, using the guard script documented in
`planning/deploy-runbook.md`. The actual host/container IP addresses are kept out of this repo — they live in the
agent's private deployment notes, not in version control.

Deploys are **not** automated — after CI publishes an image, pull it and recreate the relevant
container on Unraid (prod pulls `:latest`, staging pulls `:dev`). A push/merge does NOT mean the
change is live. Verify via the Actions tab / Docker Hub tag, then the running container's
`NIGHTLIGHT_GIT_SHA` environment variable (`docker inspect`). Not the
`org.opencontainers.image.revision` label: it exists only on CI-built images.
