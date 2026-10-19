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
