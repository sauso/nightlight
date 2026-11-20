# Home Assistant

**Status: in preparation.** A Nightlight add-on for Home Assistant is planned but not available yet. The link to install it will appear on this page when it is ready. Until then, run Nightlight with Docker on another machine ([installation](installation.md)).

## What it will be

- **A custom add-on repository.** You add its address in Home Assistant under **Settings → Add-ons → Add-on store**, then **Repositories** in the menu at the top right, and install Nightlight from the store. It is not part of Home Assistant's own add-on store. *(The repository address will be added here.)*
- **The same image as every other install,** pulled from `ghcr.io/sauso/nightlight` ([Registries](operations.md#registries)) and pinned to a release version. Updates arrive with Nightlight releases, so the [weekly base-image refresh](operations.md#the-weekly-rebuild) reaches the `:latest` tag before it reaches the add-on.
- **Home Assistant OS** on `amd64` or `aarch64` (64-bit Arm).
- **Host networking,** as in the Docker quick start, so finding cameras and low-latency viewing work. Nightlight opens in its own browser tab on port 4000 (`http://<home-assistant-address>:4000`), not inside the Home Assistant sidebar.
- **Experimental at first.** To see it in the store, turn on **Advanced mode** in your Home Assistant user profile. It stays experimental until it has been installed and tested on a real Home Assistant system.

## Planned limits of the first version

- Settings that exist only as environment variables (such as `PUBLIC_HOST`, `TRUST_PROXY`, `WEBRTC_UDP_PORT` and `UMASK`) can't be changed.
- The bundled Tailscale can't be turned on: it refuses to start under host networking.
- Another add-on that uses the same ports (4000, or UDP 8189 for low-latency video) will clash with it.
