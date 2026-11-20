# Home Assistant

**Status: experimental.** Nightlight is available as an app for Home Assistant OS, from a separate repository you add by hand. It has not been installed on a real Home Assistant system yet, so please [report what you find](https://github.com/sauso/nightlight-ha-addon/issues).

Home Assistant used to call apps "add-ons". It is the same thing.

## Install

1. In Home Assistant, go to **Settings → Apps** and select **Install app**. (Older versions: **Settings → Add-ons → Add-on store**.)
2. Open the menu at the top right and select **Repositories**.
3. Enter `https://github.com/sauso/nightlight-ha-addon` and select **Add**, or use the button in the [app repository's README](https://github.com/sauso/nightlight-ha-addon#install).
4. Find **Nightlight** in the store, select **Install**, read the **Documentation** tab, then **Start** and **Open Web UI**.

The app lives in its own repository, [sauso/nightlight-ha-addon](https://github.com/sauso/nightlight-ha-addon), and is not part of Home Assistant's own store. Its **Documentation** tab covers first start, ports, backups and restores in more detail than this page.

## What it is

- **The same image as every other install,** pulled prebuilt from `ghcr.io/sauso/nightlight` ([Registries](operations.md#registries)) and pinned to one Nightlight release. Nothing is built on your machine. A new app version appears after each Nightlight release is added to the app repository, so the [weekly base-image refresh](operations.md#the-weekly-rebuild) reaches the `:latest` tag before it reaches the app.
- **Home Assistant OS** on `amd64` or `aarch64` (64-bit Arm). Apps only run on Home Assistant OS. On Home Assistant Container, [install Nightlight with Docker](installation.md) next to it instead.
- **Host networking,** as in the Docker quick start, so finding cameras and low-latency viewing work. Nightlight opens in its own browser tab on port 4000 (`http://<home-assistant-address>:4000`), not inside the Home Assistant sidebar.
- **Private storage.** The database, secrets and recordings live in the app's own storage, behind Nightlight's sign-in. They are not put in Home Assistant's media folder, where every Home Assistant user could browse them.

## Limits of this version

- **Backups pause Nightlight.** Home Assistant stops the app while it archives the database, so the monitor is off for that time. Pick a backup time that suits you; Home Assistant's default automatic backup runs in the early morning.
- **Recordings are not in the app's backups,** so restoring a backup brings back the database and settings but not the recordings. They also share Home Assistant's own disk, which is often an SD card.
- **Uninstalling the app deletes its data,** recordings included. Back up first.
- Settings that exist only as environment variables (such as `PUBLIC_HOST`, `TRUST_PROXY`, `WEBRTC_UDP_PORT` and `UMASK`) can't be changed.
- The bundled Tailscale can't be turned on: it refuses to start under host networking.
- Another app that uses the same ports (4000, or UDP 8189 for low-latency video) will clash with it.
- Not yet tested: a real Home Assistant backup and restore, the watchdog, cameras and video through host networking on Home Assistant OS, and `aarch64` hardware.
