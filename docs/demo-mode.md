# Demo mode (for hosting a public demo)

> **You almost certainly do not need this.** Demo mode exists so Nightlight's own project can host a
> public, read-only demo that anyone can open without an account. It is not a feature for a normal
> household install — leave `DEMO_MODE` unset. This page is for someone who wants to host a demo of
> their own.
>
> ⚠️ **Never enable demo mode, or run the seed script, against a database that holds real data.** The
> seed script wipes the users, children, cameras, sleep history and alerts it finds and replaces them
> with fictional ones.

Demo mode has no effect unless `DEMO_MODE` is the exact string `true` (not `TRUE`, `1` or `yes`). With
it unset, nothing on this page applies and every endpoint behaves as normal.

## What visitors get

- **No sign-in screen.** The web app calls `POST /api/auth/guest` by itself and signs the visitor in
  as one fixed guest, `demo-guest`. That endpoint ignores its request body, so a caller cannot choose
  who they become, and it answers a plain `404` if demo mode is off or that exact user is missing.
- **The admin view, read-only.** The guest has the `admin` role so visitors can see the whole
  interface, but every write is refused with a `403`, apart from signing in, signing out and asking
  for a media token (the short-lived token the page needs to show snapshots and clips). That includes
  first-run setup, password changes, user management and every settings save.
- **Some things are refused even in the admin view**, with a `403`: the raw log viewer, the diagnostics
  bundle, the lists of signed-in sessions, "Recompute this night → Save the new numbers" (the one
  request that writes while looking like a read), and the talk-back connection.
- **A persistent banner** directly under the header says the demo is read-only and counts down to the
  end of the session. When the countdown ends it shows **Demo ended**, with a **start again** link if
  `DEMO_LOBBY_URL` is set. If the automatic sign-in fails, the sign-in screen offers **Try again**.
  A blocked write shows a calm "read-only demo" message instead of a raw error.
- **No install prompt.** The "add to home screen" prompt is hidden in demo mode.

The guest's password is a deliberate non-bcrypt sentinel, so password login as `demo-guest` always
answers `401` immediately and costs no CPU. Only the guest endpoint can sign that account in.

## Configuration

| Variable / file | Default | Meaning |
|---|---|---|
| `DEMO_MODE` | unset | `true` turns everything on this page on. Any other value, or unset, leaves the app completely normal. |
| `DEMO_ENDS_AT` | — | When the session ends, as an ISO-8601 UTC timestamp, e.g. `2026-09-21T10:20:00.000Z`. Drives the banner countdown and tells the seed how far ahead to generate data. **Compute it fresh on every boot** — a fixed value in a config file is a time in the past after the first run, and the banner would read "Demo ended" forever. |
| `DEMO_MAX_GUESTS` | `25` | Cap on **new** guest sign-ins (see *Capacity* below). Must be a positive whole number; anything else falls back to 25. |
| `DEMO_LOBBY_URL` | unset | Where the banner's **start again** link goes once the demo has ended. Without it the banner just says the demo ended. |
| `DEMO_TIMEZONE` | `UTC` | IANA timezone (e.g. `America/New_York`) used to lay out the fictional sleep history, so "last night" is a real night in that zone. An invalid name stops the seed before it writes anything. |
| `DEMO_ASSET_DIR` | `/app/demo` | Folder containing `loop.mp4` (a short clip) and `loop.jpg` (a still from it). The seed copies them in as the sample recordings, timelapses and alert snapshots, and refuses to run without them. |
| `<DATA_DIR>/.demo-ready` | — | A marker file **your deployment creates**, only after the seed has finished and the fake cameras are publishing. See *Readiness*. |

`DATA_DIR` and `CLIPS_DIR` are the normal Nightlight settings; the seed writes its media under them.

## The status endpoint

`GET /api/auth/status` is public and gains one additive field:

```json
{ "needsSetup": false, "demo": false }
```

on a normal install, and in demo mode:

```json
{ "needsSetup": false, "demo": { "endsAt": "2026-09-21T10:20:00.000Z", "lobbyUrl": null, "ready": true, "full": false } }
```

- `ready` is `true` once the `.demo-ready` file exists. `/api/health` cannot tell you this — it answers
  `ok` as soon as the server is listening, well before the seed and fake cameras are ready — so a
  launcher or lobby that redirects visitors should wait on `demo.ready`.
- `full` is `true` when the number of active guests has reached `DEMO_MAX_GUESTS`, so a lobby can say
  "the demo is full, try again in a few minutes" instead of sending a visitor into a refusal.
- `lobbyUrl` is the configured string, or `null`.

## The seeded data

From the `backend` directory, `node src/lib/demoSeed.js` (with the variables above set) resets the
database and builds:

- the `demo-guest` admin user, and two fictional children (**Avery** and **Riley**), each with one
  camera whose source is `rtsp://127.0.0.1:8555/demo` (you provide that stream — see below);
- fourteen completed nights of sleep history plus, if a 19:00–07:00 night overlaps the demo session,
  tonight's — generated from a fixed pseudo-random sequence and then scored by the app's own night
  computation, so the child cards, the sleep detail page and the charts all agree with each other;
- sixteen motion/sound alerts with snapshots, and one manual recording and one nightly timelapse per
  child;
- a reviewed "last night", so the morning-review prompt doesn't appear as a dead end for a visitor who
  cannot answer it;
- every alert channel off and unconfigured (push, Pushover, ntfy, Gotify, MQTT), motion and sound
  detection off, and clip retention off so nothing seeded is ever swept away.

Live motion sampling is also switched off in demo mode. A looped fake camera would otherwise keep
writing "activity" into the seeded nights and distort them.

Nothing about the seed is tied to a place or a person: the names are generic, times follow
`DEMO_TIMEZONE`, and the data is regenerated relative to the moment of boot, so a demo always looks
current.

## What your deployment has to do

The app does the guest sign-in, the read-only guard, the banner and the seed. It does **not** start
cameras or enforce the deadline — `DEMO_ENDS_AT` only drives what the banner shows, and the app keeps
running after it passes. Whatever launches the container must therefore, **in this order**:

1. Compute `DEMO_ENDS_AT` for this boot, and **start a hard stop for that moment before anything else**
   (a watchdog that stops the container). A seed or startup that hangs must not be able to run past
   the deadline.
2. Run the seed. It wipes the database it is pointed at.
3. Start the fake camera source on `127.0.0.1:8555`, publishing a path called `demo` (the seeded
   cameras point at it), and wait until it is actually publishing.
4. Start Nightlight.
5. Only then create `<DATA_DIR>/.demo-ready`.

Notes for the camera source, which are the parts that are easy to get wrong:

- **Use a second MediaMTX for the fake camera, on loopback only.** It shares the container's network
  namespace with the app's own MediaMTX, so on default settings the two collide on their ports and the
  app's MediaMTX dies on start, leaving no video at all. Bind the fake camera to `127.0.0.1:8555`,
  RTSP over TCP only, and turn every other listener off (API, RTMP, HLS, WebRTC, SRT, metrics, MoQ,
  pprof, playback). Start it with a clean environment so `MTX_*` variables meant for the app's MediaMTX
  don't leak into it.
- **Encode the loop as H.264 baseline, `yuv420p`.** Other profiles or pixel formats play fine on a
  desktop and show a **black screen on phones**, which use hardware decoders. MP4 cannot carry G.711
  audio, so keep AAC in the file and convert to `pcm_mulaw` (8 kHz, mono) when publishing it to RTSP.
- **Override the container's `CMD`, never its `ENTRYPOINT`.** The entrypoint fixes ownership of
  `DATA_DIR` before dropping privileges; skipping it leaves a fresh, root-owned volume unwritable.
- **Get WebRTC reachable** the same way any remote install does — see
  [Remote / internet access](../README.md#remote--internet-access-watching-from-outside-your-home-network)
  in the README. Video is the only part that needs UDP; everything else is ordinary HTTPS.

## Capacity and abuse limits

- **`DEMO_MAX_GUESTS` is an admission check, not a concurrency limit.** A guest counts while their
  session has made a request in the last two minutes. An idle session stays valid, stops counting
  after two minutes, and counts again on its next request without being refused. So clients that ping
  every minute or two keep their slot, and a burst of idle sessions waking at once can briefly push
  the active count above the cap. One guest's token can also open several video viewers.
- **Per-IP limits sit in front of it**, and only apply in demo mode: 600 requests a minute per IP
  across the API and the WebRTC/HLS video routes, and 20 guest sign-ins per 15 minutes per IP.
- **Neither is a capacity guarantee.** They do not bound CPU or bandwidth. Load-test the number of
  viewers you actually intend to serve.
- **Set `TRUST_PROXY` from a measurement, not a guess.** Both per-IP limits key on the client address
  Nightlight sees. If `TRUST_PROXY` is wrong, either every visitor collapses into one address (so one
  busy visitor locks everyone out of the guest endpoint) or a visitor can forge `X-Forwarded-For` to
  dodge the limits. Which value is right depends on your platform's proxy chain — capture the real
  addresses on the running machine, pick the setting, and test with two different clients and a forged
  header. See [`TRUST_PROXY`](../README.md#trust_proxy--telling-nightlight-your-real-client-addresses).

## Known limits

- The guest is a shared identity: every visitor is the same user, so nothing they do is theirs alone,
  and there is no per-visitor history.
- The fake camera loops one clip, so the live view shows no real motion, and the alerts, recordings and
  timelapses are seeded rather than produced live.
- Sleep detection thresholds were calibrated on real cameras in one household. The seeded data is
  shaped to score cleanly under them; it shows what the screens look like, not how accurate detection
  would be in your room.
- Build a demo image from a Nightlight release that contains demo mode (0.33.0 or later), and redeploy
  after later releases — a demo pinned to an old version keeps showing the old app.
