# Building and testing

Clone the repository, then build the combined app and media container:

```bash
git clone https://github.com/sauso/nightlight.git
cd nightlight
docker build -t nightlight .
docker run -d --name nightlight --network host --stop-timeout 30 \
  -e PUID=99 -e PGID=100 -v ./data:/app/data nightlight
```

## Tests

Use **Node 24** (see `.nvmrc`). The test suites depend on Node's module mocking behavior; older versions can produce misleading import errors.

```bash
nvm use
cd backend && npm ci && npm test
cd ../frontend && npm ci && npm test
```

## Project layout

- `backend/` — Express API, SQLite, and FFmpeg/MediaMTX process management
- `frontend/` — React app
- `mediamtx/` — media-server defaults
- `reverse-proxy/` — SWAG example
- `Dockerfile` — combined container image
- `unraid-template.xml` — Unraid template
- `docker-compose.yml` — Compose configuration

Read [architecture](architecture.md), [design language](design-language.md), and [mutation testing](mutation-testing.md) for deeper contributor references.
