# sauso/nightlight

Self-hosted baby monitor with low-latency multi-camera streaming from RTSP cameras.
Installable to your phone's home screen as a standalone app. No cloud, no
subscription, no account anywhere but your own network (the optional STUN server
below is the one exception, and can be turned off).

One container includes the app, [MediaMTX](https://github.com/bluenviron/mediamtx)
(RTSP to WebRTC/HLS bridge), and FFmpeg (audio transcoding) together.

### Usage

```bash
docker run -d \
    --name=nightlight \
    --network=host \
    --stop-timeout 30 \
    -e PUID=<uid for user> \
    -e PGID=<gid for user> \
    -v <path for config/data>:/app/data \
    sauso/nightlight
```

Nightlight needs a routable LAN address so WebRTC (the low-latency viewing mode) works
correctly. **Host networking (shown above) is the simplest default** and needs no extra setup; a
dedicated `ipvlan`/`macvlan` address is also supported if you'd rather avoid host-mode port
conflicts — see [Networking modes](https://github.com/sauso/nightlight/blob/main/docs/readme-reference.md#networking-modes) in the
full reference for both options and their trade-offs.

### Example

```bash
docker run -d \
    --name=nightlight \
    --network=host \
    --stop-timeout 30 \
    -e PUID=99 \
    -e PGID=100 \
    -v /mnt/user/appdata/nightlight:/app/data \
    sauso/nightlight
```

### Access application

`http://<host ip>:4000`

On first visit you'll be prompted to create the admin account - do this first, from
a trusted device.

### Notes

- PUID/PGID default to 99/100 (Unraid's own "nobody"/"users" convention) if left
  unset. Find your own with `id <username>` on other systems.
- `UMASK` defaults to `077`: everything in the data directory is owner-only (the
  database holds every stored secret), and each start also tightens existing files.
  Range `000`-`077` (owner digit `0`); an invalid value logs a warning and `077` is
  used. If another user or container reads the data directory, set `-e UMASK=022`
  **before** upgrading - after one start at `077` it only affects new files. Details:
  [Who can read the data directory](https://github.com/sauso/nightlight/blob/main/docs/operations.md#who-can-read-the-data-directory).
- `STUN_SERVERS` (optional) sets the STUN servers for Low Latency (WebRTC), in the browser
  and in the bundled MediaMTX. Unset = Google's public server
  (`stun:stun.l.google.com:19302`); **blank = no STUN at all**, so nothing contacts Google;
  otherwise a comma-separated list of `stun:host[:port]` URLs (anything else is ignored with
  a warning). Viewing on your own network never needs STUN; viewers outside it, behind NAT,
  may. Details: the `STUN_SERVERS` section of the [remote access guide](https://github.com/sauso/nightlight/blob/main/docs/remote-access.md#stun_servers--which-stun-servers-low-latency-webrtc-uses).
- The image has a Docker `HEALTHCHECK` (`GET /api/health`, 2 minute start period). It only
  marks the container healthy/unhealthy; nothing restarts it.
- `CLOUDFLARE_ANALYTICS` is off by default: Cloudflare Web Analytics' beacon, which
  Cloudflare's proxy injects into every page, is blocked by Nightlight's
  Content-Security-Policy. Set `-e CLOUDFLARE_ANALYTICS=1` (or `true`, `yes`, `on`) only
  if you serve Nightlight through Cloudflare with Web Analytics on; blank, `0`, `false`,
  `no` and `off` keep it blocked, and any other value also blocks it and logs a warning.
  It used to be allowed on every install: if you rely on it, set this when you upgrade. Details:
  [`CLOUDFLARE_ANALYTICS`](https://github.com/sauso/nightlight/blob/main/docs/remote-access.md#cloudflare_analytics--cloudflare-web-analytics-through-cloudflares-proxy).
- `--stop-timeout 30` lets Nightlight shut down cleanly - a recording in progress is
  assembled from its buffer as the app stops, and being killed part-way loses it.
  Stopping normally takes a few seconds; the container exits as soon as it's done, so
  the generous timeout costs nothing.
- An Unraid template is available - see the GitHub repo below for setup.
- A random session secret is generated and stored in your data directory
  automatically on first run - nothing to configure.
- `SESSION_TTL_DAYS` (optional) sets how many days a sign-in lasts, counted from
  sign-in: range `7`-`30`, blank = `30` (the default); an invalid value logs a
  warning and `30` is used. A phone is signed out at the same time of day it signed
  in and gets no Nightlight push alerts until it signs in again; lowering the value
  signs out older sign-ins at their next request. Details:
  [How long a sign-in lasts](https://github.com/sauso/nightlight/blob/main/SECURITY.md#how-long-a-sign-in-lasts-and-where-it-is-kept).

### Links

[GitHub repository](https://github.com/sauso/nightlight) (full README, Unraid
template, reverse proxy config, remote-access setup) | [Report an issue](https://github.com/sauso/nightlight/issues)
