# Installing Nightlight

Nightlight runs as a single Docker container on a Linux host with access to your cameras. It supports amd64 and arm64.

## Unraid

Find **Nightlight** in the Community Applications store and select **Install**. Review the data path (default `/mnt/user/appdata/nightlight`) and apply. The template sets the network and other defaults.

To install the repository template manually:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user
wget -O /boot/config/plugins/dockerMan/templates-user/my-nightlight.xml \
  https://raw.githubusercontent.com/sauso/nightlight/main/unraid-template.xml
```

Then go to **Docker → Add Container**, choose the **nightlight** template, review the data directory and apply.

If you installed an older template, ensure **Extra Parameters** contains `--stop-timeout 30` so recordings can finish during shutdown.

## Docker

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

Change the persistent data path, user/group IDs and timezone for your host. Avoid running the application as root (`PUID=0`). The log options limit Docker's log growth; the shutdown timeout allows recording assembly to finish.

For Docker Compose, clone the repository and run:

```bash
cp .env.example .env
# Review .env if you need to change defaults.
docker compose up -d
```

Open `http://<server-ip>:4000` on your LAN, create the admin account from a trusted device, then add children and cameras.

## Storage and permissions

Nightlight stores its database, credentials and other data in the mounted directory. The default `UMASK=077` restricts access to the owning user; filesystems such as CIFS or Windows bind mounts may not honor Unix permissions. If another service needs access, read [data-directory permissions](operations.md#who-can-read-the-data-directory) **before** changing the umask or upgrading. Existing file permissions may need manual repair.

Recording types have different retention rules. Read [recording and storage](recording.md) before moving clips to another mount or setting `CLIPS_DIR`.

## Networking and requirements

Host networking is the simplest default. A dedicated LAN IP through ipvlan/macvlan can avoid port conflicts. See [networking](networking.md) for the differences, remote access, and multiple instances.

Nightlight requires an RTSP-capable camera. ONVIF is optional. There is no published minimum CPU/RAM or tested camera-count limit; add cameras gradually and monitor usage.

## Troubleshooting

See [troubleshooting](troubleshooting.md), [known issues](../KNOWN-ISSUES.md), and [operations](operations.md).

## Quick start (full notes)

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
IP via ONVIF, or by RTSP details; see [Managing cameras](cameras.md#managing-cameras)), and assign
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
  table under [Installing to your home screen](mobile.md#installing-to-your-home-screen) describes how each
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
[Quick start](#quick-start-full-notes) for what it does.
