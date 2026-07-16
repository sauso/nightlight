# sauso/nightlight

Self-hosted baby monitor with low-latency multi-camera streaming from RTSP cameras.
Installable to your phone's home screen as a standalone app. No cloud, no
subscription, no account anywhere but your own network.

One container includes the app, [MediaMTX](https://github.com/bluenviron/mediamtx)
(RTSP to WebRTC/HLS bridge), and FFmpeg (audio transcoding) together.

### Usage

```bash
docker run -d \
    --name=nightlight \
    --network=host \
    -e PUID=<uid for user> \
    -e PGID=<gid for user> \
    -v <path for config/data>:/app/data \
    sauso/nightlight
```

**Host networking is required** - WebRTC (the low-latency viewing mode) needs it to
work correctly on your LAN.

### Example

```bash
docker run -d \
    --name=nightlight \
    --network=host \
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
- An Unraid template is available - see the GitHub repo below for setup.
- A random session secret is generated and stored in your data directory
  automatically on first run - nothing to configure.

### Links

[GitHub repository](https://github.com/sauso/nightlight) (full README, Unraid
template, reverse proxy config, remote-access setup) | [Report an issue](https://github.com/sauso/nightlight/issues)
