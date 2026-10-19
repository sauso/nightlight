# Nightlight — self-hosted baby monitor

> **This is the previous README, kept in full while it is split into separate guides.** The [README](../README.md) is now the short introduction; settings, known limits and the sleep-tracking explanation live here for now. Other guides: [documentation hub](README.md).

A mobile-friendly web app for watching multiple RTSP cameras, grouped by child, over your
home network. Live video uses WebRTC (via [MediaMTX](https://github.com/bluenviron/mediamtx))
for sub-second latency — much lower than a typical HLS-based viewer. Use it in any browser,
install it to your home screen as a PWA, or run the companion **native apps for Android and
iOS** ([nightlight-mobile](https://github.com/sauso/nightlight-mobile)) for reliable
background audio and picture-in-picture (see [Mobile apps](#mobile-apps-android--ios)
below). No cloud, no subscription, no account anywhere but your own network.

> **One thing to know about "no cloud".** Nightlight has no cloud service of its own, but by default
> the **Low latency (WebRTC)** live view uses Google's public STUN server
> (`stun.l.google.com:19302`), both in the browser and in the bundled MediaMTX. STUN is how WebRTC
> works out a public address: the browser asks that server, so Google can see the viewer's public IP
> address and when each live view connected. **Watching on your home network needs no STUN**; a viewer
> outside it, behind NAT, may. Set `STUN_SERVERS` to a blank value to use none (nothing then contacts
> Google), or to your own server: see [`STUN_SERVERS`](remote-access.md#stun_servers--which-stun-servers-low-latency-webrtc-uses).
> **Compatibility (HLS)** viewing does not use WebRTC and never contacts a STUN server. Push
> notifications, if you enable a provider, also leave your network: see
> [Push notifications](notifications.md).

> **⚠️ Not a safety device.** Nightlight is a convenience tool, not a safety device. It is
> not a medical device, is not certified for safety monitoring of any kind, and must never
> be used as a substitute for adult supervision. Streams can drop, apps can be killed by
> the operating system, networks fail — never rely on this software to alert you to a
> child in distress.

## Screenshots

See the [visual walkthrough](README.md) for a tour of the main screens (the nursery
dashboard, adding a camera, and settings). The images are captured by the end-to-end test
suite but committed by hand, so they can lag behind the actual UI.

## How it works

- **FFmpeg** pulls each camera's RTSP stream, copies the video through untouched, and
  transcodes just the audio to AAC (many IP cameras send audio as G711, a codec HLS can't
  carry at all — WebRTC can, which is why this only matters for Compatibility/HLS mode).
  The result is published into MediaMTX.
- **MediaMTX** re-publishes that as WebRTC (WHEP) and HLS, which browsers can play
  natively — RTSP itself cannot be played in a browser, so this bridge is required either way.
- **Backend** (Node/Express + SQLite) stores children, cameras, and caregiver accounts,
  and manages both MediaMTX and one FFmpeg process per camera as child processes —
  starting them, restarting on crash, and stopping them when a camera's removed.
- **Frontend** (React) is a mobile-first, installable app: a live dashboard grouped by
  child, plus screens to manage children, cameras, and caregiver accounts. Cameras can be
  added by IP over **ONVIF** (auto-filling the stream details), and PTZ (pan/tilt) cameras
  get on-screen controls — see [Managing cameras](#managing-cameras).

Everything above runs in a **single Docker container**, which needs its own routable IP on your LAN so
WebRTC connects without NAT/ICE headaches (MediaMTX advertises that IP to browsers). The simple default
is **host networking** — the container shares the host's IP — used by the quick start and the Unraid
template. If host mode doesn't suit you (e.g. a port clash with another service), you can instead give
the container its **own dedicated LAN IP**; see [Networking modes](#networking-modes) below.

This is designed for **local network use by default** — see [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network)
below if you want it reachable from outside your home too.

## Quick start

Pull and run directly from Docker Hub:

```bash
docker run -d \
  --name nightlight \
  --network host \
  --restart unless-stopped \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --stop-timeout 30 \
  -e PUID=99 \
  -e PGID=100 \
  -e TZ=UTC \
  -v /path/to/your/data:/app/data \
  sauso/nightlight:latest
```

Nightlight records video three ways — **automatic clips** attached to motion/sound alerts (opt-in per
camera), **wake clips** saved silently when your child wakes up, and **on-demand recordings** you
capture with the Record button. They have different retention rules, so see
[docs/recording.md](recording.md) for all of it and for every setting under *Settings →
Recording*. Video defaults to `<data dir>/clips`; you can point it at your array instead with a
`/recordings` mount + `CLIPS_DIR`.

PUID/PGID control which user/group owns files this container creates in your data
directory - the defaults above (99/100) match Unraid's own "nobody"/"users" convention,
so they're usually already correct there. On another system, find your own with
`id your_username`. Do not set `PUID=0`: it runs the app as root, and the container logs a warning at start
if you do. TZ (e.g. `Australia/Melbourne`) affects log timestamps only -
[full list of values](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

`UMASK` (optional, default `077`) decides who else can read what the container writes there. The
database holds every stored secret (camera passwords, notification tokens) in plaintext, so by
default everything is **owner-only** (files `600`, folders `700`), and each start takes group/other
access off anything that still has it. Range: 3 or 4 octal digits with an owner digit of `0`
(`000`-`077`, e.g. `022` for the old world-readable modes); anything else is ignored with a warning
and `077` is used. **If another user or container reads your data directory, set `UMASK=022`
*before* upgrading** - after one start at `077` the opt-out only affects new files. Known limits:
a default ACL on the host folder overrides it, an external `CLIPS_DIR` mount's existing files are
not tightened, and on a filesystem that ignores `chmod` (a Docker Desktop for Windows bind mount,
a CIFS mount with a fixed `file_mode`) modes cannot change at all, so that filesystem's own access
control is what protects the data. Details, including what this may mean for SMB shares (not
verified) and backups:
[Who can read the data directory](operations.md#who-can-read-the-data-directory).

The `--log-opt` flags cap Docker's own log storage at 10MB × 3 files - without them,
logs default to growing unbounded, which can be a real problem on Unraid specifically
since Docker's storage there is a fixed-size image that can break the whole Docker
service if it fills up.

`--stop-timeout 30` gives Nightlight enough time to stop cleanly. It needs a few seconds
on the way down — an on-demand recording is assembled from the buffer at that point, and
being killed part-way through loses it. Stopping normally takes **1-5 seconds**, so 30 is
deliberately generous — and costs nothing, because the container exits as soon as it's
finished rather than waiting out the timeout. Don't rely on Docker's own default here:
recent versions don't document one, and it has been measured killing the container after
about 4 seconds, which was enough to lose the recording. **If you deployed before this
was added**, add `--stop-timeout 30` yourself (or `stop_grace_period: 30s` under the
service in Compose, or the Unraid template's "Extra Parameters" field). Nothing else breaks
without it — a recording lost this way is marked failed rather than disappearing silently.

Or with Docker Compose:

```bash
cp .env.example .env
# optionally edit .env - see comments in the file; the defaults are fine to start
docker compose up -d
```

Then, from any phone/laptop on the same network, visit `http://<server-ip>:4000`. The
first time you visit, you'll be asked to create the admin account — do this first, from a
trusted device. Then add your children (Children tab), add your cameras (Cameras tab — by
IP via ONVIF, or by RTSP details; see [Managing cameras](#managing-cameras)), and assign
cameras to children.

### Requirements

- Any always-on Linux box on the same network as your cameras (a Raspberry Pi, an Unraid
  server, anything running Docker). Both `amd64` and `arm64` are supported.
- Cameras that expose an RTSP stream (almost all "dumb" IP cameras and most smart cameras
  with a local RTSP option do — check the camera's manual for the RTSP path, usually
  something like `/stream1`).
- **ONVIF is optional but handy**: if a camera supports it, Nightlight can fetch the stream
  details from just its IP, and enable pan/tilt controls on cameras that report PTZ.
- **Capacity has not been measured.** There is no stated or tested limit on the number of
  cameras or viewers, no minimum Raspberry Pi model, RAM or free disk, and no CPU-per-camera
  figure: Nightlight enforces no limit, and none has been benchmarked. What a camera costs depends
  on what you switch on: every camera has its own FFmpeg stream process, and motion analysis, sound
  analysis (sleep tracking uses both) and the recording buffer each add another one. Add cameras
  gradually and watch the host's CPU.
- **Browsers: the automated tests cover desktop Chromium only.** The end-to-end suite runs in
  Chromium (Playwright's "Desktop Chrome" profile) and nothing else. Safari, Firefox, Edge, Samsung
  Internet and the native apps have no automated coverage, and no tested-version list is kept. The
  table under [Installing to your home screen](#installing-to-your-home-screen) describes how each
  platform treats installs; it is not a statement of tested versions.

## Running on Unraid

Nightlight is on the **Community Applications** store. Open the **Apps** tab, search
"nightlight", and click **Install** — every field (network mode, data path, optional
variables) comes pre-filled; double check the **Data Directory** path if you want something
other than the default (`/mnt/user/appdata/nightlight`), then **Apply**.

Prefer to install manually, or want the template before Community Applications' cache picks
up a change? Add it straight from this repo instead:

1. Open the Unraid **Terminal** (or SSH in), then run:
   ```bash
   mkdir -p /boot/config/plugins/dockerMan/templates-user
   wget -O /boot/config/plugins/dockerMan/templates-user/my-nightlight.xml \
     https://raw.githubusercontent.com/sauso/nightlight/main/unraid-template.xml
   ```
2. Docker tab → **Add Container** → **Template** dropdown → select **nightlight**. Every
   field (network mode, data path, optional variables) is pre-filled from the template —
   double check the **Data Directory** path if you want something other than the default
   (`/mnt/user/appdata/nightlight`), then **Apply**.

Either way, this is a single container — no extra plugins needed, Unraid's normal Docker UI
handles it directly.

**Already installed from an older copy of the template?** Check that **Extra Parameters**
(Advanced view, on the container's edit page) contains `--stop-timeout 30`, and add it if
not. Unraid builds the container from the saved template, so a template downloaded before
this was added keeps the old value until you edit it — and without it a recording that was
in progress when the container restarts can be cut short. See the note under
[Quick start](#quick-start) for what it does.

## Networking modes

Nightlight needs its own routable IP on your LAN so WebRTC has no NAT/ICE trouble — MediaMTX advertises
that IP to browsers. There are two supported ways to provide one:

- **Host networking (default, simplest).** The container shares the host's IP (`--network host`, or
  `<Network>host</Network>` in the Unraid template). Nothing to configure — it's what the quick start and
  the template use. The trade-off is that it binds its ports (4000, plus MediaMTX's) directly on the host,
  which clashes if something else there already uses them.
- **A dedicated LAN IP (ipvlan / macvlan).** Put the container on a Docker `ipvlan`/`macvlan` network so it
  gets its **own** address on your LAN, separate from the host. Nightlight auto-detects the container's IP
  and has MediaMTX advertise it, so WebRTC works on the LAN with **no extra configuration** (no `PUBLIC_HOST`
  needed for local viewing). Use this to avoid host-mode port conflicts, or just to keep the app on a tidy
  fixed IP of its own.
  - **On Unraid:** create a custom Docker network on your NIC (e.g. `br0`, or a VLAN like `br0.10`), then in
    the container template set the **Network Type** to that network and give it a fixed IP.
  - **macvlan caveat:** with plain `macvlan`, the **host itself usually can't reach the container** (a Linux
    kernel limitation) — which matters if your reverse proxy (e.g. SWAG) runs on that same host. Use
    **`ipvlan`** (or add a macvlan shim interface) so the host can reach it.

| | Host networking | ipvlan | macvlan |
|---|---|---|---|
| Setup | None — the default | Custom Docker network + fixed IP | Custom Docker network + fixed IP |
| Port collisions with other containers | Possible — shares the host's ports | None — has its own IP | None — has its own IP |
| Host itself can reach the container | Yes (it *is* the host) | Yes | **No** (Linux kernel limitation) — use ipvlan instead if a reverse proxy runs on the host |
| Multiple instances on one host | Awkward — only one can hold port 4000 | Easy — each gets its own IP | Easy — each gets its own IP |

Either way, the app is still served on port **4000** (change it with the `PORT` env var if you need to).
For **remote / internet** access, see [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network) below — that part is the same in both
modes.

### Running more than one instance (e.g. staging + production)

Running two copies on one host is easiest with the **dedicated LAN IP** mode above: give each its own IP
and they can keep the same internal ports without clashing (host networking can't — two host-mode
containers would both try to grab port 4000). Set a different `PORT` on an instance if you'd rather change
its HTTP port instead.

Watching **both remotely in Low latency (WebRTC)** takes one extra step, because each instance's WebRTC
media needs its own UDP port forwarded **1:1** — the port a browser must reach has to match the port
MediaMTX advertises, so a router that *remaps* the port breaks WebRTC:

1. Give each instance a **distinct WebRTC UDP port**: leave one at the default `8189` and set the other
   with the `WEBRTC_UDP_PORT` setting (a bare number between 1 and 65535, **no colon**; blank = `8189`),
   e.g. `WEBRTC_UDP_PORT=8190`. On Unraid it is the **WebRTC UDP Port** field in the container's
   advanced view. An invalid value is ignored with a warning in the log and `8189` is used. (The raw
   MediaMTX override `MTX_WEBRTCLOCALUDPADDRESS` still works for a bind address a bare port cannot
   express and wins if both are set, but you should not need it.)
2. **Forward each 1:1** on your router — external UDP `8189` → instance A's `8189`, external UDP `8190` →
   instance B's `8190` (same number in and out).
3. Set `PUBLIC_HOST` (your public IP or DDNS) on **both**.
4. Put each behind its **own subdomain** in SWAG (e.g. `nursery.example.com`, `nursery-dev.example.com`);
   the HTTP and the WebRTC signalling both ride 443, so the only per-instance forwards are those two UDP
   media ports.

**Compatibility (HLS)** needs none of this — it's all HTTP over 443, so both instances work remotely with
no extra port forwarding.

## Managing cameras

Cameras are added and edited from the **Cameras** tab (admin only). A camera's address is
entered as separate fields — **IP address**, **RTSP port** (usually 554), **stream path**,
and the camera's **username / password**. Nightlight assembles the `rtsp://` URL from those
itself, so the password never appears in a URL on screen.

**Supported cameras** — Nightlight works with **ONVIF / RTSP** cameras in general: video, audio, and —
on ONVIF cameras — pan/tilt and two-way audio. The fully tested and **recommended** option is
**open-firmware [Thingino](https://thingino.com/) cameras** (inexpensive, ONVIF, pan/tilt, two-way
audio); on those, set the camera's audio codec to **G711 (a-law)** for reliable sound (some builds
default to AAC, which not all of them stream well — see `KNOWN-ISSUES.md`). Most other ONVIF cameras
work too, and Hikvision two-way audio (ISAPI) is supported. If a camera won't connect, the **Add
camera** screen can generate a redacted **camera report** to help add support for it. The report is
a JSON file that stays on your device — it holds the camera's address, username, ONVIF result and
stream codecs, with any password replaced by `***`. It is meant to be attached to a GitHub issue, so
it is worth opening and reading before you post it: the redaction covers passwords, not everything a
particular camera's firmware might put in an error message. If you find something sensitive that
shouldn't be there, see [SECURITY.md](../SECURITY.md) for how to report it privately instead.

**Cameras are trusted input.** Nightlight trusts everything a camera sends it: the video and audio
stream, the ONVIF replies and the snapshot images. The stream is parsed by FFmpeg and ffprobe, and
the rest by the server itself, all as the same user that owns the data directory (the database, the
saved secrets and the recordings): nothing separates the media processes from the data on disk. They
are not handed the server's environment: FFmpeg and ffprobe start with only `PATH`, `TZ`, `LANG` and
`LC_ALL`, MediaMTX with the same plus your `MTX_*` overrides
([details](architecture.md#child-process-environment-backendsrclibchildenvjs-553)). That narrows what
a bug in one of them could leak, but it is not a sandbox: running as the same user, a media process that a
camera managed to take over could still read the server's own environment (`JWT_SECRET` included) through
the process table, as well as the files. Cameras are often the least-updated devices on a network, so put them on
**their own VLAN or network segment**, ideally with no route to the internet and no access to your
other devices, and let only the Nightlight host reach them (RTSP, plus ONVIF and the snapshot URL if
you use them). This is advice: Nightlight does not check or enforce it.

**Adding a camera**

- **Via ONVIF (easiest):** type the camera's IP and press **Fetch port & path from ONVIF**.
  Nightlight queries the camera and fills in the port and stream path for you, and detects
  whether it supports pan/tilt and two-way audio. Most cameras answer this without a login;
  if yours needs one, fill in the username/password first. Then make sure the login is
  entered and Save.
- **Manually:** type the IP, port, path, and login yourself (see the camera's manual for its
  RTSP path, e.g. `/stream1`).
- On **Save**, Nightlight briefly tests the stream first and won't store a camera it can't
  reach (wrong login, path, or IP) — it tells you why. If the camera just happens to be
  offline right then, you can choose **Save anyway**.

**Capability badges** — cameras added via ONVIF show badges in the list: **PTZ** and
**Two-way Audio**, green when supported, red when not. (Manually-added cameras show neither,
since their capabilities aren't probed.)

**Pan/tilt (PTZ)** — on cameras that report PTZ, a move button appears on the camera tile
(next to the stream-quality gear). Tap it for an on-screen D-pad: each press nudges the
camera a fixed amount, and holding an arrow keeps it moving; it stops on release and can't
run past the limit.

**Two-way audio (talk-back)** — on cameras that support it, a talk button appears on the tile: hold it
to speak through the camera's speaker. Works with **Hikvision** (over ISAPI — enter the camera's *web*
login when adding) and with **any ONVIF camera that has an audio backchannel** (e.g. Thingino/Sonoff),
which is set up automatically from the ONVIF probe using the camera's own stream login.

**Editing** — Edit shows the same fields. Leave the **password blank to keep the existing
one** — it's never sent back to your browser. Changing the address re-tests the stream, the
same as adding.

**Removing** — Remove asks for confirmation, then stops the stream and **permanently deletes everything for the camera**: its bed transitions and snapshot photos, activity history, alerts with their clips and snapshots, recordings, event log and sensor history. You can add the camera again, but none of that comes back. See [Removing a child or a camera](recording.md#removing-a-child-or-a-camera).

**Assigning to a child** — use the "Assigned to" dropdown on each camera (admin only; a caregiver
sees the assignment as text). It is more than grouping: a camera's nights are tracked only while it is
assigned to a child who has sleep tracking on, so unassigning a camera stops its tracking just as
turning tracking off does.

### Where to put the camera

Nightlight works from **any** camera position: put the camera wherever it fits and you will still get
sleep tracking and motion alerts. A good position makes them **more reliable**, and nothing more than that.
These are suggestions from testing in one household, not guarantees, and not a measured result (a proper
comparison of positions has not been done yet).

- **The suggested view:** looking down at the bed from above, at about **45 degrees**, the way most baby
  monitors are mounted. Have the **whole bed in frame**, and the **doorway or room entry in view as well**
  if you can: seeing who comes in and goes out makes an entry or exit easier to tell from other movement.
- **What to avoid:**
  - **A light that flashes, flickers or changes brightness in view of the bed** (a blinking charger or
    night light, a screen, a light that cycles). Every change lights up pixels in the bed, which can break
    the empty-bed check into short pieces, and a correct morning wake can then read wrong or be missed.
    Cover or move the light, or point the camera so it is out of frame.
  - **A bed zone that overlaps where a parent stands or leans** (for example a camera so low or side-on
    that a person at the bedside covers the bed in the picture). Their movement then counts as movement in
    the bed.
  - **The bed being a tiny part of the frame.** With few pixels on the bed, a real movement is a smaller
    share of the zone and is easier to miss. Fill the frame with the bed, within reason.
- **If you move a camera, paint the bed zone again.** The bed zone (the area the camera watches for
  movement in the bed) is drawn on one particular picture, so after a move it no longer sits on the bed.
  Nothing checks that the zone is on the bed, so look at it over a live picture after any move. Sleep
  nights before and after a move are **not directly comparable**: the zone and the camera's idea of a quiet
  room both change, so a difference in the figures may come from the move, not from the sleep.

## Sleep tracking

Moved to its own page: [Sleep tracking](sleep-tracking.md).

## Adding caregivers

Moved to its own page: [Adding caregivers](caregivers.md).

## Running behind a reverse proxy (e.g. SWAG on Unraid)

Moved to its own page: [Reverse proxy and remote access](remote-access.md).

## Remote / internet access (watching from outside your home network)

Moved to the same page: [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network).

## Installing to your home screen

Moved: [Installing to your home screen](mobile.md#installing-to-your-home-screen).

## Mobile apps (Android & iOS)

Moved: [Mobile apps](mobile.md#mobile-apps-android--ios).

## Logs

Moved: [Logs](operations.md#logs).

## Times and your timezone

Moved: [Times and your timezone](operations.md#times-and-your-timezone).

## Troubleshooting

Moved: [More troubleshooting](troubleshooting.md#more-troubleshooting).

## Building from source

```bash
git clone https://github.com/sauso/nightlight.git
cd nightlight
docker build -t nightlight .
docker run -d --name nightlight --network host --stop-timeout 30 \
  -e PUID=99 -e PGID=100 -v ./data:/app/data nightlight
```

### Running the tests

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

## License

MIT — see `LICENSE`.
