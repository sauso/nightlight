# Nightlight — self-hosted baby monitor

A mobile-friendly web app for watching multiple RTSP cameras, grouped by child, over your
home network. Live video uses WebRTC (via [MediaMTX](https://github.com/bluenviron/mediamtx))
for sub-second latency — much lower than a typical HLS-based viewer. Installable to your
phone's home screen as a standalone app (PWA). No cloud, no subscription, no account
anywhere but your own network.

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
  child, plus screens to manage children, cameras, and caregiver accounts.

Everything above runs in a **single Docker container** using **host networking**, which is
the simplest and most reliable way to run WebRTC on a local network (no NAT/ICE headaches,
no ports to keep in sync).

This is designed for **local network use by default** — see "Remote / internet access"
below if you want it reachable from outside your home too.

## Quick start

Pull and run directly from Docker Hub:

```bash
docker run -d \
  --name nightlight \
  --network host \
  --restart unless-stopped \
  -v /path/to/your/data:/app/data \
  sauso/nightlight:latest
```

Or with Docker Compose:

```bash
cp .env.example .env
# optionally edit .env - see comments in the file; the defaults are fine to start
docker compose up -d
```

Then, from any phone/laptop on the same network, visit `http://<server-ip>:4000`. The
first time you visit, you'll be asked to create the admin account — do this first, from a
trusted device. Then add your children (Children tab), add each camera's RTSP URL (Cameras
tab), and assign cameras to children.

### Requirements

- Any always-on Linux box on the same network as your cameras (a Raspberry Pi, an Unraid
  server, anything running Docker). Both `amd64` and `arm64` are supported.
- Cameras that expose an RTSP stream (almost all "dumb" IP cameras and most smart cameras
  with a local RTSP option do — check the camera's manual for the RTSP URL format, usually
  something like `rtsp://username:password@192.168.1.50:554/stream1`).

## Running on Unraid

An Unraid Community Applications template is included (`unraid-template.xml`). Until this
is submitted to the official CA feed (at which point it'll be searchable directly from the
Apps tab), install it locally by placing the file where Unraid looks for user templates:

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

This is a single container — no extra plugins needed, Unraid's normal Docker UI handles it
directly.

## Adding caregivers

Once signed in as admin, go to **Account → Add caregiver** to create additional logins (e.g.
for a partner or babysitter). Caregivers can view cameras and manage children/cameras but
can't manage other user accounts or change app-wide settings.

## Running behind a reverse proxy (e.g. SWAG on Unraid)

A ready-to-use config is in `reverse-proxy/nightlight.subdomain.conf`. Copy it to
`swag/config/nginx/proxy-confs/nightlight.subdomain.conf` and replace `UNRAID_LAN_IP`
with your server's actual LAN IP — since this uses `network_mode: host`, SWAG can't reach
it by container name, only by that real IP.

Everything is proxied through a single port (4000): the app, login, all pages, and the
video signaling handshake — no extra ports to open on your router for this part.

## Remote / internet access (watching from outside your home network)

By default this is LAN-only. There are two ways to watch remotely, and each camera tile
has a toggle to switch between them ("Low latency" / "Compatibility"):

**Low latency (WebRTC)** — near-instant video, same as at home. This requires:
1. Set up SWAG as described above (HTTPS for the app itself).
2. Set `PUBLIC_HOST` to your public IP or a DDNS hostname.
3. Forward **UDP port 8189** on your router to your server's LAN IP.

This is a hard requirement of WebRTC, not a workaround — the actual audio/video always
travels over UDP between your browser and MediaMTX, no matter what. A TURN relay server
doesn't change this (it only changes how the *signaling* connects, not the media itself),
so there's no way to get the low-latency mode down to zero UDP ports. This single UDP
port forward is all you need, unless you're behind CGNAT.

**Compatibility (HLS)** — a few seconds of delay, but pure HTTP/TCP, so it rides through
the same port 443 as everything else with **no extra port forwarding at all**. Use this if
you'd rather not forward a UDP port, or if you're ever watching from a network that blocks
outbound UDP (some corporate/public Wi-Fi).

Both modes work automatically once SWAG + `PUBLIC_HOST` are set up — Compatibility mode
needs nothing further, since it's already proxied through the app's normal port.

## Installing to your home screen

The app has a web app manifest and icons, so on both Android (Chrome) and iOS (Safari) you
can add it to your home screen and it'll open full-screen like a native app, with its own
icon — no browser address bar. On Android, use the browser menu → "Add to Home screen" /
"Install app". On iOS, use the Share button → "Add to Home Screen".

Note: for Chrome's automatic install prompt/banner (and the cleanest install experience)
the site generally needs to be served over HTTPS — accessing it as a plain `http://` LAN
address still lets you add it manually from the menu, but you may not get the automatic
install banner. This is one more reason the reverse-proxy/HTTPS setup above is worth doing
if you want the full native-app-like install experience.

## Logs

Both the app and MediaMTX write their logs to files in the data volume instead of Docker's
own log storage, so normal operation doesn't fill up disk over time (this matters
particularly on Unraid, where Docker's storage is a fixed-size image that can break the
whole Docker service if it fills up):

- App logs: `<your data dir>/app.log` (rotates once it passes 5MB)
- MediaMTX logs: `<your data dir>/mediamtx.log` (not auto-rotated — very unlikely to become
  a real problem given your data dir is normal disk/array space rather than Docker's
  constrained image, but worth an occasional glance if disk space is tight)

Since `docker logs` will show little to nothing during normal operation, use these files
(or `docker exec nightlight tail -f /app/data/app.log`) for troubleshooting instead.

## Troubleshooting

- **Camera shows "No signal"**: double check the RTSP URL works with a tool like VLC
  (Media → Open Network Stream) first — if VLC can't play it, the app won't either.
- **Video won't connect from a phone but the pages load fine**: confirm the device is on
  the same LAN (for Low latency mode) — see "Remote / internet access" above if it's
  actually a different network.
- **Checking whether MediaMTX has registered your cameras**: its API is loopback-only (not
  reachable directly from a browser), so check it from inside the container:
  ```bash
  docker exec nightlight wget -qO- http://127.0.0.1:9997/v3/paths/list
  ```
  An empty `"items":[]` with cameras added in the app means MediaMTX and the app's database
  have drifted apart — restarting the container re-syncs them automatically (see the
  startup log line "Reconciled N camera path(s)...").
- **Checking logs**: see the "Logs" section above — `docker logs` shows little during
  normal operation now, so check `app.log` / `mediamtx.log` in your data directory instead.

## Building from source

```bash
git clone https://github.com/sauso/nightlight.git
cd nightlight
docker build -t nightlight .
docker run -d --name nightlight --network host -v ./data:/app/data nightlight
```

## Project layout

```
backend/          Express API + SQLite storage + process supervision for MediaMTX/FFmpeg
frontend/          React mobile-first UI (built into the image at build time)
mediamtx/          Default MediaMTX config (seeded into the data volume on first run)
reverse-proxy/     Example SWAG config for running behind HTTPS
Dockerfile         Single combined image (app + MediaMTX + FFmpeg)
unraid-template.xml   Unraid Community Applications template
docker-compose.yml
```

## License

MIT — see `LICENSE`.
