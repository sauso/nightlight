# Nightlight soak stack

A third environment, deliberately separate from prod, staging, and the `../` e2e stack: it runs the
real app image **continuously**, so runtime-plumbing bugs that only surface once the process has been
up for a while — a spawn that fails, a migration transaction, a watchdog crash guard — can be exercised
and broken on purpose. A unit test cannot reach this class of bug. The `../` e2e stack proves out one
clean boot-to-stream pipeline and then tears down; that's a different job.

## Why it exists

Set up 2026-09-03, outside the repo at first, after five PRs landed on `dev` without the app ever once
being run. Since then it has caught, live, in a running container:

- **#257** — a failed ffmpeg spawn used to SIGTERM the whole process group; the soak proved the fix
  survives with `restarts=0` and both legs reporting the real `ENOENT` reason.
- **#274** — its review found that clearing a segmenter's handle without removing it from the map left
  `isSegmenterRunning()` still saying `true`; the soak reproduced the correct behaviour end to end (an
  immediate 409, "This camera isn't buffering yet", instead of a recording row that fails ~20s later
  inside clip extraction).
- **#254** — proved the crash guard is isolated per leg (main vs. sub-stream), not shared: killing
  MediaMTX while a sub-stream is unready throws inside the sub leg's own guard without stopping the main
  leg's force-restart from running right after.
- **#279** — measured the shutdown grace a `docker stop` actually needs (a bare `docker stop` under a
  newer Docker gave ~4s and SIGKILLed a recording in flight); that measurement is why `stop_grace_period`
  is now declared in every compose file and the Unraid template.
- **#297** — confirmed `stopTranscoder` is safe to call on a proc whose spawn just failed, by hiding
  ffmpeg and letting the 15s camera watchdog force-restart into that exact path repeatedly.

It earned a permanent place in the repo for that reason (was `planning/ROADMAP.md` E4).

## ⚠️ Never point this at a real bedroom/nursery camera

Use the bundled synthetic camera, or a dedicated test camera of your own — never a camera watching a
child. A third RTSP puller adds load a resource-constrained camera may not absorb (on this project's own
hardware, the observed failure was an encoder wedge needing a device-side service restart), and losing
the real feed while this stack is mid fault-injection is exactly the outcome nobody wants from a testing
tool.

## Start it

Requires `PUBLIC_HOST` — the LAN IP of the machine running Docker, so MediaMTX can hand out a WebRTC ICE
candidate the browser can actually reach (the container sits on a bridge network, so its own addresses
aren't routable; see the comment in `docker-compose.soak.yml`).

```
cd e2e/soak
PUBLIC_HOST=<this machine's LAN IP> docker compose -f docker-compose.soak.yml up -d
docker compose -f docker-compose.soak.yml logs -f nightlight
```

First run walks the app's own create-admin flow — there is no seeded login, and none belongs in the
compose file. Add a camera pointing at `rtsp://fakecam:8554/test` (open) or
`rtsp://fakecam:8554/secure` (credentials in `../fakecam/mediamtx.yml`, exercises credential handling)
to get a live picture with no real hardware.

Runs on port **4100**, not 4000, so it can sit alongside the `../` e2e stack at the same time; `8189/udp`
is published for WebRTC media — everything else MediaMTX listens on is proxied through the backend on
4000, so that's the only other port that needs to be open.

## Refresh it to a newer image

```
docker compose -f docker-compose.soak.yml pull nightlight
PUBLIC_HOST=<this machine's LAN IP> docker compose -f docker-compose.soak.yml up -d
```

⚠️ **Always `pull` before `up -d --force-recreate`.** A bare `--force-recreate` rebuilds from whatever
image is already sitting in the local cache tagged `:dev`, which can be stale — "resetting to clean"
this way has silently resurrected an old, pre-merge image more than once. `pull` first, every time, no
exception for a quick reset.

`./data` (gitignored) is a real bind mount, not tmpfs, so config and history survive a restart — that
persistence is the point of a soak (`../docker-compose.e2e.yml` deliberately does the opposite, for a
clean first-run on every invocation).

## Stop it

```
docker compose -f docker-compose.soak.yml down        # stops, keeps ./data
```

## Fault-injection recipes

Both target the running `nightlight` container: `docker exec -it <container> sh`.

**Hide `ffmpeg`** — simulates the transcoder binary disappearing:

```
mv /usr/bin/ffmpeg /usr/bin/ffmpeg.hidden
pkill -f "ffmpeg.*cam_"        # kill the running processes so the 5s relaunch has to spawn it
```

Restore: `mv /usr/bin/ffmpeg.hidden /usr/bin/ffmpeg`. Video should heal within about a minute (15s
watchdog); a recording ring that was already down can take up to five (the 5-minute reconcile) — that
asymmetry is expected, not a bug.

**Hide `mediamtx`** — simulates the media server disappearing. Needs a camera with a sub-stream
configured first: the only genuinely bare `upsertPath` call in the codebase is in `subStream.js`, so
with no sub-stream the watchdog path this recipe exercises is never reached.

```
mv $(which mediamtx) /usr/local/bin/mediamtx.hidden
pkill -f mediamtx
```

Restore: `mv /usr/local/bin/mediamtx.hidden $(which mediamtx)`.

A stall-injection relay (`scripts/stall-proxy.mjs`), for simulating a camera going slow rather than
disappearing outright, is planned as part of #373 — it is not part of this stack yet.
