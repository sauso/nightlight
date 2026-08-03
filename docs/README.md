# Nightlight — visual walkthrough

A quick tour of the app's main screens. For installation, configuration, and the full
feature reference, see the [main README](../README.md).

> The screenshots below are **generated automatically** by the end-to-end test suite
> (`e2e/playwright/tests/05-screenshots.spec.js`), so they stay in sync with the real UI
> rather than drifting. See [e2e/README.md](../e2e/README.md#refreshing-the-documentation-screenshots)
> for how to refresh them.

## Signing in

Nightlight is private to your network and gated behind a login. On first run it prompts you
to create the admin account; after that, caregivers sign in here.

![The Nightlight sign-in screen](screenshots/login.png)

## The nursery dashboard

The home screen is a live grid of camera tiles. Each tile plays low-latency video, shows the
camera's name and which child it's assigned to, and has controls for audio, fullscreen,
picture-in-picture, and stream quality. Tiles can be dragged to reorder them.

![The nursery dashboard with a camera tile](screenshots/dashboard.png)

## Adding a camera

Cameras are added by their address — IP, RTSP port, stream path, and credentials — or
auto-filled by IP over ONVIF. You can also set an optional low-quality sub-stream and
two-way-audio credentials here.

![The add-camera form](screenshots/add-camera.png)

## Settings

Admins can theme the app (name, colors, font), set the timezone and temperature unit, and
connect an MQTT broker to show room temperature/humidity on each tile.

![The settings screen](screenshots/settings.png)
