# Nightlight — self-hosted baby monitor

A mobile-friendly web app for watching multiple RTSP cameras, grouped by child, over your
home network. Live video uses WebRTC (via [MediaMTX](https://github.com/bluenviron/mediamtx))
for sub-second latency — much lower than a typical HLS-based viewer. Use it in any browser,
install it to your home screen as a PWA, or run the companion **native apps for Android and
iOS** ([nightlight-mobile](https://github.com/sauso/nightlight-mobile)) for reliable
background audio and picture-in-picture (see [Mobile apps](#mobile-apps-android--ios)
below). No cloud, no subscription, no account anywhere but your own network.

> **⚠️ Not a safety device.** Nightlight is a convenience tool, not a safety device. It is
> not a medical device, is not certified for safety monitoring of any kind, and must never
> be used as a substitute for adult supervision. Streams can drop, apps can be killed by
> the operating system, networks fail — never rely on this software to alert you to a
> child in distress.

## Screenshots

See the [visual walkthrough](docs/README.md) for a tour of the main screens (sign-in, the
nursery dashboard, adding a camera, and settings). Those images are generated automatically
by the end-to-end test suite, so they stay in sync with the actual UI.

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
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  -e PUID=99 \
  -e PGID=100 \
  -e TZ=UTC \
  -v /path/to/your/data:/app/data \
  sauso/nightlight:latest
```

To have Nightlight save short **video clips** of motion/sound detections, see
[docs/recording.md](docs/recording.md) — it's opt-in per camera. Clips default to `<data
dir>/clips`; you can point them at your array instead with a `/recordings` mount + `CLIPS_DIR`.

PUID/PGID control which user/group owns files this container creates in your data
directory - the defaults above (99/100) match Unraid's own "nobody"/"users" convention,
so they're usually already correct there. On another system, find your own with
`id your_username`. TZ (e.g. `Australia/Melbourne`) affects log timestamps only -
[full list of values](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

The `--log-opt` flags cap Docker's own log storage at 10MB × 3 files - without them,
logs default to growing unbounded, which can be a real problem on Unraid specifically
since Docker's storage there is a fixed-size image that can break the whole Docker
service if it fills up.

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
camera** screen can generate a redacted **camera report** to help add support for it.

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

**Removing** — Remove asks for confirmation, then stops the stream and deletes the camera.
You can always add it again.

**Assigning to a child** — use the "Assigned to" dropdown on each camera. (This is just for
grouping the dashboard; any signed-in user can change it.)

## Sleep tracking

Nightlight can estimate each child's overnight sleep from what their cameras already see and
hear — no wearables, no extra hardware. It's a **sleep-pattern guide, not a medical
measurement**, and (like everything here) never a safety device — see the warning at the top.

- **Turn it on per child.** Each child has a **Track sleep** toggle in their settings, with
  their own **bedtime** and **wake time**. Sleep is estimated over exactly that overnight
  window; the background sampler only runs during the window, and turning tracking off stops
  it entirely. A child can have more than one camera — their movement and sound are combined.
- **How it estimates.** Across the night it builds a per-minute movement + sound timeline from
  the child's camera(s): falling still for a sustained stretch reads as falling asleep,
  sustained movement or noise reads as an awakening (brief stirs don't count). If you've drawn
  a **crib zone** on the camera — the same rectangle that scopes motion alerts — it also tracks
  movement **outside** the crib (a parent coming in, or the child climbing out of bed) and shows
  it separately as "in the room" activity, which catches a morning wake where the child has
  already left the cot.
- **At a glance, and live.** Each child's page summarises last night — total sleep, wake-ups,
  longest stretch — and while a night is in progress it updates as **"Tonight · so far"**, so an
  early-morning wake appears within a minute or two rather than only after the window closes.
- **The detail view.** Tap the sleep summary for the full **night timeline**: a to-scale bar of
  asleep / stirring / awake stretches on a real time axis, every wake-up listed with its time
  and length, an "in the room" list, and a date picker to step back through roughly the last
  month of nights.
- **Room temperature (optional).** If a camera reports temperature/humidity over **MQTT** (set
  up under **Settings → MQTT**, e.g. via Zigbee2MQTT — the readings also show on the camera
  tile), the sleep detail overlays the night's room temperature beneath the timeline, aligned to
  the same time axis. After a handful of tracked nights, a **"Sleep & room temperature"** card
  compares wake-ups on the child's warmer vs cooler nights, so you can spot whether a warm room
  tends to mean more waking — a pattern, not a cause.

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

> **iOS background audio:** On iPhone/iPad, background listening (screen off / app minimised) works
> in **Low latency** mode only — its WebRTC audio lets Nightlight fully own the lock screen (camera
> name, artwork, Pause/Play). **Compatibility** is HLS, which iOS runs its own native lock-screen
> session for that we can't reliably control, so Background isn't offered for a Compatibility camera
> on iOS (it was tried and removed for being inconsistent — see [KNOWN-ISSUES.md](KNOWN-ISSUES.md)).
> Compatibility still works for live viewing. Android is unaffected — its background-listening
> service keeps both modes alive.

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

## Mobile apps (Android & iOS)

Beyond the PWA, there are companion **native apps** in a separate repo,
[nightlight-mobile](https://github.com/sauso/nightlight-mobile). They're thin native
shells around this same web UI — the app loads the interface **live from your own server**
rather than bundling it, so any server update applies to the apps automatically with no
reinstall. On first launch you just enter your server's address (like the Home Assistant
app); a "Change server" menu item switches later.

What the native apps add over the browser/PWA:

- **Reliable background listening** — keep hearing a camera with the screen off or the app
  minimised. Android uses a foreground service (with a wake/wifi lock and a battery-
  optimisation exemption); iOS uses a background audio session. Plain in-browser background
  audio is unreliable by comparison. **On iOS this requires a camera in Low latency mode** —
  Compatibility (HLS) can't do reliable background audio on iOS (iOS runs its own native
  lock-screen session for it), so Background is only offered for Low-latency cameras there; see the
  Low latency / Compatibility notes above and [KNOWN-ISSUES.md](KNOWN-ISSUES.md).
- **Pause/Resume from the system controls** — Android's notification and iOS's Now Playing
  (Control Center / lock screen), plus a Stop on Android.
- **Picture-in-Picture** — float a camera in a small always-on-top window while you use
  other apps (Android; the browser has its own PiP too).
- **Battery-friendly** — minimising the app disconnects streams unless a camera is in
  Background mode, so nothing keeps pulling video in the background.
- **Push notifications** — a phone alert when a camera sees motion, even with the app closed
  (Android only for now). See below.

### Push notifications (motion alerts)

Get a **phone notification** when a camera with motion detection sees movement — even when the app is
closed. It's off by default, and the in-app **Settings → Recent alerts** list works with or without
it. There are two ways to set it up (pick one), both configured under **Settings → Push
notifications**:

**Pushover (recommended — simplest, and works on iOS).** A small notification service (the same one
Sonarr/Radarr use). No Firebase project, no Apple Developer account.

1. Install the **Pushover** app on your phone and note your **User Key** (or make a Delivery Group to
   alert several caregivers).
2. Create a Pushover application at [pushover.net/apps/build](https://pushover.net/apps/build) and copy
   its **API Token**.
3. In **Settings → Push notifications → Pushover**, paste the token + your user/group key, **Enable**,
   **Save** (it verifies with Pushover), and **Send test**. Then enable **Motion detection** on a
   camera. Alerts arrive with a **snapshot** of what triggered them.

**Firebase / FCM (Android app only).** Delivers straight to the Nightlight Android app via your own
Firebase project: drop `google-services.json` + a `firebase-service-account.json` service-account key
into your data dir (e.g. `/mnt/user/appdata/nightlight`, keep the key `chmod 600`), then enable it
under **Settings → Push notifications**. Each phone opts in under **Account → Notifications**.

Full walkthrough for both, with troubleshooting: **[docs/notifications.md](docs/notifications.md)**.

**Getting them:**
- **Android** — download the signed APK from the
  [nightlight-mobile Releases](https://github.com/sauso/nightlight-mobile/releases) page and
  sideload it (built and signed automatically in CI on each release).
- **iOS** — no App Store build yet; it's installed by sideloading (e.g. AltStore/Sideloadly
  with a free Apple ID). See the nightlight-mobile repo for the current status and steps.

Both apps are built entirely in GitHub Actions — see the nightlight-mobile repo for how,
and its own `CHANGELOG.md` for per-release notes.

## Logs

Both the app and MediaMTX log to stdout, captured by Docker in the normal way:

```bash
docker logs -f nightlight
```

Docker's own log rotation (already configured in the `docker run`/Compose examples
above, and in the Unraid template's extra parameters) caps total log storage at 10MB × 3
files, so this doesn't grow unbounded - this matters particularly on Unraid, where
Docker's storage is a fixed-size image that can break the whole Docker service if it
fills up. If you deployed before this was added, add `--log-opt max-size=10m --log-opt
max-file=3` yourself (or the Unraid template's "Extra Parameters" field) to get the
same protection.

Timestamps use your container's local time (see the `TZ` variable above) rather than
UTC, so they line up with when you actually remember something happening.

## Troubleshooting

- **Camera shows "No signal"**: double check the RTSP URL works with a tool like VLC
  (Media → Open Network Stream) first — if VLC can't play it, the app won't either.
- **Video won't connect from a phone but the pages load fine**: confirm the device is on
  the same LAN (for Low latency mode) — see "Remote / internet access" above if it's
  actually a different network.
- **A camera shows disconnected for a few seconds after opening the app and doesn't come
  back**: this is usually a stale WebRTC connection on the phone itself, not the camera or
  server — the video connection can get "wedged" after the phone sleeps, switches networks,
  or hands off Wi-Fi/cellular, and won't always re-establish on its own. **Pull down on the
  camera dashboard to reconnect** — this works in the browser and in the mobile apps, and
  rebuilds the connection without a full restart. If a camera is *actually* down, every
  device sees it, not just one — check the Camera history panel (Settings) or the logs
  (below) to tell the two apart.
- **Background listening stops after a while (Android app)**: Android's battery optimisation
  (Doze) will eventually freeze the app and cut its network unless it's exempt. The app asks
  for the exemption the first time you enable Background mode — if you declined, grant it
  manually under Settings → Apps → Nightlight → Battery → Unrestricted. (Background audio is
  a feature of the native apps, not the browser/PWA — see [Mobile apps](#mobile-apps-android--ios).)
- **A camera says "No signal" only in Compatibility mode**: usually the camera sending bad
  audio timestamps, which can stall the HLS pipeline. Nightlight resamples/rewrites camera
  timestamps to ride through this, but if it persists, power-cycle or update that camera's
  firmware. See [`KNOWN-ISSUES.md`](KNOWN-ISSUES.md).
- **Checking whether MediaMTX has registered your cameras**: its API is loopback-only (not
  reachable directly from a browser), so check it from inside the container:
  ```bash
  docker exec nightlight wget -qO- http://127.0.0.1:9997/v3/paths/list
  ```
  An empty `"items":[]` with cameras added in the app means MediaMTX and the app's database
  have drifted apart — restarting the container re-syncs them automatically (see the
  startup log line "Reconciled N camera path(s)...").
- **Checking logs**: see the "Logs" section above — `docker logs -f nightlight`.

For a catalogue of understood quirks (camera glitches, WebRTC reconnects, the watchdog's
recovery window) with what each one means and whether it needs any action, see
[`KNOWN-ISSUES.md`](KNOWN-ISSUES.md).

## Building from source

```bash
git clone https://github.com/sauso/nightlight.git
cd nightlight
docker build -t nightlight .
docker run -d --name nightlight --network host -e PUID=99 -e PGID=100 -v ./data:/app/data nightlight
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
