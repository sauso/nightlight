# Troubleshooting

Start with `docker logs -f nightlight` and [known issues](../KNOWN-ISSUES.md). Find the symptom below, then check the camera, network or app as directed.

## Video and playback

### Page loads but video doesn't

If video won't connect from a phone but the pages load fine, confirm the device is on the same
LAN for local WebRTC (Low latency mode). If it is on a different network, review
[networking](networking.md) and [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network).

### Compatibility mode fails but WebRTC works

A camera may show "No signal" only in Compatibility mode. This is usually caused by the camera
sending bad audio timestamps, which can stall the HLS pipeline; camera audio timestamps or codec
handling may be involved. Nightlight resamples/rewrites camera timestamps to ride through this,
but if it persists, power-cycle or update that camera's firmware. See
[`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).

## The app and sign-in

### The app shows "Can't reach Nightlight" instead of the sign-in screen

The app could not get an answer from the server (it is restarting, off, or this device is not on
the home network), so it does not know whether you are signed in and does not ask for a password
that could not be checked anyway. Confirm the server is running and the phone is on a network that
can reach it.

It retries by itself (after 5 seconds, then 10, 20, and every 30 seconds from then on), and you
can press **Try again** at any time. Once the server answers, you land in the app or on the sign-in
screen if you really were signed out. Your sign-in is kept while it retries. Only a server that
answers "not signed in" shows the sign-in screen, and so does **Sign out**, at once.

## Cameras

### Camera shows "No signal"

Double check the RTSP URL works with a tool like VLC (Media → Open Network Stream) first. If VLC
cannot play it, the app won't either: verify the camera URL, credentials and firmware.

### A camera shows disconnected after sleep or Wi-Fi switching

If a camera shows disconnected for a few seconds after opening the app and doesn't come back, this
is usually a stale WebRTC connection on the phone itself, not the camera or server. The video
connection can get "wedged" after the phone sleeps, switches networks, or hands off
Wi-Fi/cellular, and won't always re-establish on its own. **Pull down on the camera dashboard to reconnect**.
This works in the browser and in the mobile apps, and rebuilds the connection without
a full restart.

If a camera is actually down, every device sees it, not just one. Check the Camera history panel
(Settings) or the [logs](operations.md#logs) to tell the two apart.

## Audio and background listening

### Background listening stops after a while (Android app)

Android's battery optimisation (Doze) will eventually freeze the app and cut its network unless
it's exempt. The app asks for the exemption the first time you enable Background mode. If you
declined, grant it manually under Settings → Apps → Nightlight → Battery → Unrestricted. Background audio is a feature of the
native apps, not the browser/PWA; see [Mobile apps](mobile.md#mobile-apps-android--ios).

## MediaMTX and the server

### Checking whether MediaMTX has registered your cameras

For advanced MediaMTX path diagnostics, check its API from inside the container. It is loopback-only, so a browser cannot reach it directly:

```bash
docker exec nightlight wget -qO- http://127.0.0.1:9997/v3/paths/list
```

An empty `"items":[]` list when cameras are configured in the app can mean MediaMTX and the app's
database have drifted apart. Restarting the container may reconcile the paths; it re-syncs them
automatically (see the startup log line "Reconciled N camera path(s)...").

### Checking logs

See [Logs](operations.md#logs) for `docker logs -f nightlight` and log rotation.

## Getting help

For a catalogue of understood quirks (camera glitches, WebRTC reconnects, the watchdog's recovery
window), what each means and whether it needs any action, see
[`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md). If a problem persists,
[open an issue](https://github.com/sauso/nightlight/issues) with sanitised logs and relevant
camera details. Never publish passwords or private video.
