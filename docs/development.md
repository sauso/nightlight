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

The tests need **Node 24** (the version in `.nvmrc`; `engines` in both `package.json` files says `>=24`, and the Docker image and CI use the same). On an older Node the backend suite does not fail in one place with one reason: 16 test files fail in ways that look unrelated (`The requested module 'child_process' does not provide an export named 'spawn'`, `mock.module is not a function`). The cause is that the tests replace modules with `mock.module(name, { exports })`, and Node 22 ignores `exports`, so the mocked module has no named exports to import. `backend/test/node-version-pin.test.js` fails first, with that explanation, when the suite runs on a Node that cannot do it.

```bash
nvm use                      # reads .nvmrc
cd backend && npm ci && npm test
cd ../frontend && npm ci && npm test
```

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
