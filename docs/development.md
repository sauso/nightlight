# Building and testing

## Building from source

```bash
git clone https://github.com/sauso/nightlight.git
cd nightlight
docker build -t nightlight .
docker run -d --name nightlight --network host --stop-timeout 30 \
  -e PUID=99 -e PGID=100 -v ./data:/app/data nightlight
```

## Running the tests

The tests need **Node 26** (the supported version in `.nvmrc`; `engines` in both `package.json` files says `>=26`, and CI and the Docker image use 26; Node 24 was supported until release 0.50.0). On an older Node the backend suite does not fail in one place with one reason: 16 test files fail in ways that look unrelated (`The requested module 'child_process' does not provide an export named 'spawn'`, `mock.module is not a function`). The cause is that the tests replace modules with `mock.module(name, { exports })`, and Node 22 ignores `exports`, so the mocked module has no named exports to import. `backend/test/node-version-pin.test.js` fails first, with that explanation, when the suite runs on a Node that cannot do it.
```bash
nvm use                      # reads .nvmrc
cd backend && npm ci && npm test
cd ../frontend && npm ci && npm test
```

## Replaying stored nights after a sleep change

A change to the sleep scoring is judged by replaying real nights with the old code and the new, not by the nights it was written for. `scripts/replay-nights.mjs` does that on a copy of a database. It loads the backend's own scoring, so it shows what the app would do, and it only reads.

Get a snapshot first: `docker exec nightlight node src/scripts/backup-db.js` writes one consistent file while the app runs (see [backing up](operations.md#3-backing-up); never copy `babymonitor.db` alone from a running install, its newest rows sit in the `-wal` file). For the "old" side, make a second checkout of the last release (`git worktree add ../old v0.50.0`) and run `npm ci` in its `backend/`.

```bash
# What did my change move? Prints only the nights that differ, beside what a parent said when they reviewed it.
node scripts/replay-nights.mjs compare ../old/backend backend path/to/snapshot --tz=Europe/London
# The same, comparing the whole result (timeline included) and naming the keys that differ.
node scripts/replay-nights.mjs compare ../old/backend backend path/to/snapshot --whole
# The child card shows the STORED answer, the detail page a FRESH one: which nights disagree by more than 10 minutes?
node scripts/replay-nights.mjs drift backend path/to/snapshot
# One night's wake-related fields and its bed transitions.
node scripts/replay-nights.mjs night backend path/to/snapshot 2026-11-24 --child=1
# "Update past nights" on a copy: preview twice, apply, undo, apply again, with the counts and the time it took.
node scripts/replay-nights.mjs rewrite backend path/to/snapshot
```

Things to know:

- **Run it on every database you have.** Two installs (or production and staging) run separate detectors on the same cameras, so their stored readings differ; a change that is harmless on one has failed on the other before.
- **Times print in UTC unless you pass `--tz`** with an IANA zone. Children are labelled "child 1", "child 2" by creation order; a name is never read.
- **The clock is frozen** at the snapshot file's modification time (pass `--clock=<ISO>` if you copied it without keeping that). Only a night still in progress cares.
- **Only nights that still have minute readings can be replayed.** They are kept 30 days, so on a recent snapshot older nights come back as having no data and show up as unchanged.
- It is not the accuracy score: `scripts/scoreboard.mjs` measures how far the fresh answer is from what a parent said. This one answers "what moved".

## Project layout

```
backend/          Express API + SQLite storage + process supervision for MediaMTX/FFmpeg
frontend/          React mobile-first UI (built into the image at build time)
mediamtx/          Default MediaMTX config (baked into the image - see src/index.js for why)
reverse-proxy/     Example SWAG config for running behind HTTPS
Dockerfile         Single combined image (app + MediaMTX + FFmpeg)
unraid-template.xml   Unraid Community Applications template
docker-compose.yml
```

Read [architecture](architecture.md), [design language](design-language.md), and [mutation testing](mutation-testing.md) for deeper contributor references.
