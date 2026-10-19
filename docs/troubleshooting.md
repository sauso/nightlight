# Troubleshooting

Start with `docker logs -f nightlight` and [known issues](../KNOWN-ISSUES.md).

- **Camera says “No signal”:** test the RTSP stream in VLC first. If VLC cannot play it, verify the camera URL, credentials and firmware.
- **App says “Can't reach Nightlight”:** confirm the server is running and the phone is on a network that can reach it. The app retries automatically; **Try again** is also available.
- **Page loads but video doesn't:** verify the phone is on the same LAN for local WebRTC, or review [remote access](networking.md).
- **Camera disconnected after sleep or Wi-Fi switching:** pull down on the dashboard to reconnect. If all devices show the camera offline, check the camera and logs.
- **Android background audio stops:** allow Nightlight unrestricted battery use in Android app settings.
- **Compatibility mode fails but WebRTC works:** camera audio timestamps or codec handling may be involved; try a camera firmware update and consult [known issues](../KNOWN-ISSUES.md).

For advanced MediaMTX path diagnostics, run:

```bash
docker exec nightlight wget -qO- http://127.0.0.1:9997/v3/paths/list
```

An empty `items` list when cameras are configured can indicate state drift; restarting the container may reconcile the paths.

If a problem persists, [open an issue](https://github.com/sauso/nightlight/issues) with sanitized logs and relevant camera details. Never publish passwords or private video.

## More troubleshooting

- **Camera shows "No signal"**: double check the RTSP URL works with a tool like VLC
  (Media → Open Network Stream) first — if VLC can't play it, the app won't either.
- **The app shows "Can't reach Nightlight" instead of the sign-in screen**: the app could not get an answer
  from the server (it is restarting, off, or this device is not on the home network), so it does not know
  whether you are signed in and does not ask for a password that could not be checked anyway. It retries
  by itself (after 5 seconds, then 10, 20, and every 30 seconds from then on) and you can press **Try again**
  at any time; once the server answers you land in the app, or on the sign-in screen if you really were signed
  out. Your sign-in is kept while it retries. Only a server that answers "not signed in" shows the sign-in screen,
  and so does **Sign out**, at once.
- **Video won't connect from a phone but the pages load fine**: confirm the device is on
  the same LAN (for Low latency mode) — see [Remote / internet access](remote-access.md#remote--internet-access-watching-from-outside-your-home-network) if it's
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
  a feature of the native apps, not the browser/PWA — see [Mobile apps](mobile.md#mobile-apps-android--ios).)
- **A camera says "No signal" only in Compatibility mode**: usually the camera sending bad
  audio timestamps, which can stall the HLS pipeline. Nightlight resamples/rewrites camera
  timestamps to ride through this, but if it persists, power-cycle or update that camera's
  firmware. See [`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).
- **Checking whether MediaMTX has registered your cameras**: its API is loopback-only (not
  reachable directly from a browser), so check it from inside the container:
  ```bash
  docker exec nightlight wget -qO- http://127.0.0.1:9997/v3/paths/list
  ```
  An empty `"items":[]` with cameras added in the app means MediaMTX and the app's database
  have drifted apart — restarting the container re-syncs them automatically (see the
  startup log line "Reconciled N camera path(s)...").
- **Checking logs**: see the [Logs](operations.md#logs) section — `docker logs -f nightlight`.

For a catalogue of understood quirks (camera glitches, WebRTC reconnects, the watchdog's
recovery window) with what each one means and whether it needs any action, see
[`KNOWN-ISSUES.md`](../KNOWN-ISSUES.md).
