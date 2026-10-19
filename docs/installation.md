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
