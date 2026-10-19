# Installing Nightlight

Nightlight runs as a single Docker container on a Linux host that can reach your cameras. It supports `amd64` and `arm64`. Host networking is the simple default; there is a dedicated-IP option if you'd rather avoid port clashes (see [networking](networking.md)).

## What you need

- **An always-on Linux box on the same network as your cameras.** A Raspberry Pi, an Unraid server, anything running Docker.
- **Cameras that expose an RTSP stream.** Almost all plain IP cameras and most smart cameras with a local RTSP option do. Check the camera's manual for the RTSP path, usually something like `/stream1`.
- **ONVIF is optional but handy.** If a camera supports it, Nightlight can fetch the stream details from just its IP, and enable pan/tilt controls on cameras that report PTZ.
- **Capacity has not been measured.** There is no stated or tested limit on the number of cameras or viewers, no minimum Raspberry Pi model, RAM or free disk, and no CPU-per-camera figure: Nightlight enforces no limit, and none has been benchmarked. What a camera costs depends on what you switch on: every camera has its own FFmpeg stream process, and motion analysis, sound analysis (sleep tracking uses both) and the recording buffer each add another one. Add cameras gradually and watch the host's CPU.
- **Browsers: the automated tests cover desktop Chromium only.** The end-to-end suite runs in Chromium (Playwright's "Desktop Chrome" profile) and nothing else. Safari, Firefox, Edge, Samsung Internet and the native apps have no automated coverage, and no tested-version list is kept. The table under [Installing to your home screen](mobile.md#installing-to-your-home-screen) describes how each platform treats installs; it is not a statement of tested versions.

## Unraid

Nightlight is on the **Community Applications** store. Open the **Apps** tab, search "nightlight" and click **Install**. Every field (network mode, data path, optional variables) comes pre-filled. Check the **Data Directory** path if you want something other than the default, `/mnt/user/appdata/nightlight`, then **Apply**.

It's a single container, so no extra plugins are needed; Unraid's normal Docker page handles it.

**Want the template before Community Applications catches up with a change, or prefer to install by hand?** Add it straight from this repo:

1. Open the Unraid **Terminal** (or SSH in) and run:
   ```bash
   mkdir -p /boot/config/plugins/dockerMan/templates-user
   wget -O /boot/config/plugins/dockerMan/templates-user/my-nightlight.xml \
     https://raw.githubusercontent.com/sauso/nightlight/main/unraid-template.xml
   ```
2. Go to **Docker → Add Container**, pick **nightlight** from the **Template** dropdown, check the **Data Directory** path and **Apply**.

**Already installed from an older copy of the template?** Open the container's edit page, switch to the Advanced view, and check that **Extra Parameters** contains `--stop-timeout 30`; add it if not. Unraid builds the container from your saved template, so a template downloaded before this was added keeps the old value until you edit it. Without it, a recording in progress when the container restarts can be cut short. [What the flag does](#what-the-options-do).

## Docker

Pull and run straight from Docker Hub:

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

Replace `/path/to/your/data` with a persistent folder on your host.

### What the options do

**`PUID` and `PGID`** set which user and group own the files the container creates in your data directory. The defaults (99 and 100) match Unraid's own "nobody" and "users", so they are usually already right there. On another system, find your own with `id your_username`. Don't set `PUID=0`: it runs the app as root, and the container logs a warning at start if you do.

**`TZ`** (for example `Australia/Melbourne`) sets the container's own clock zone. It affects log timestamps and the names of the video buffer's segment files, so those agree with the app's logs. It does **not** change the times the app shows: those follow the timezone in **Settings → General** (see [times and your timezone](operations.md#times-and-your-timezone)). [Full list of values](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).

**`UMASK`** (optional, default `077`) decides who else can read what the container writes to your data directory. The database holds every stored secret (camera passwords, notification tokens) in plaintext, so by default everything is **owner-only** (files `600`, folders `700`), and each start takes group and other access off anything that still has it.
- Range: 3 or 4 octal digits with an owner digit of `0` (`000`-`077`, for example `022` for the old world-readable modes). Anything else is ignored with a warning, and `077` is used.
- **If another user or container reads your data directory, set `UMASK=022` *before* upgrading.** After one start at `077`, the opt-out only affects new files.
- Known limits: a default ACL on the host folder overrides it; an external `CLIPS_DIR` mount's existing files are not tightened; and on a filesystem that ignores `chmod` (a Docker Desktop for Windows bind mount, a CIFS mount with a fixed `file_mode`) modes cannot change at all, so that filesystem's own access control is what protects the data.
- Details, including what this may mean for SMB shares (not verified) and backups: [Who can read the data directory](operations.md#who-can-read-the-data-directory).

**`--log-opt`** caps Docker's own log storage at 10 MB × 3 files. Without it, logs grow without limit by default, which can be a real problem on Unraid in particular: Docker's storage there is a fixed-size image, and filling it can break the whole Docker service.

**`--stop-timeout 30`** gives Nightlight enough time to stop cleanly. On the way down, an on-demand recording is assembled from the buffer, and being killed part-way through loses it. Stopping normally takes **1-5 seconds**, so 30 is deliberately generous, and it costs nothing: the container exits as soon as it has finished instead of waiting out the timeout. Don't rely on Docker's own default. Recent versions don't document one, and it has been measured killing the container after about 4 seconds, which was enough to lose the recording.
- **If you deployed before this was added**, add `--stop-timeout 30` yourself (or `stop_grace_period: 30s` under the service in Compose, or the Unraid template's "Extra Parameters" field).
- Nothing else breaks without it. A recording lost this way is marked failed rather than disappearing silently.

**Recordings.** Nightlight records video three ways: **automatic clips** attached to motion and sound alerts (opt-in per camera), **wake clips** saved silently when your child wakes up, and **on-demand recordings** you capture with the Record button. They have different retention rules, so read [recording](recording.md) before moving clips to another mount or setting `CLIPS_DIR`; it also covers every setting under *Settings → Recording*. Video defaults to `<data dir>/clips`. You can point it at your array instead with a `/recordings` mount plus `CLIPS_DIR`.

## Docker Compose

Clone the repository and run:

```bash
cp .env.example .env
# optionally edit .env - see comments in the file; the defaults are fine to start
docker compose up -d
```

The options above apply here too (the Compose file sets the stop timeout for you).

## First sign-in

From any phone or laptop on the same network, open `http://<server-ip>:4000`. The first time you visit, you'll be asked to create the administrator account. **Do this first, from a trusted device.** Then add your children (the Children tab), add your cameras (the Cameras tab, by IP via ONVIF or by RTSP details; see [managing cameras](cameras.md#managing-cameras)) and assign each camera to a child.

## Networking

Host networking is the simplest default, and it is what the quick start and the Unraid template use. A dedicated LAN IP through ipvlan or macvlan can avoid port conflicts. [Networking](networking.md) covers the differences, remote access and running more than one instance.

## When something goes wrong

See [troubleshooting](troubleshooting.md), [known issues](../KNOWN-ISSUES.md) and [operations](operations.md) (backups, upgrades, rollback).
