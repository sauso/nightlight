# Camera controls

**Settings → Camera controls** (admin only) holds two global settings that apply across every
camera — not per-camera detection settings, which live on each camera's own **Cameras → edit →
Motion detection** page.

## Pan / tilt step size

| Setting | Default | Range |
|---|---|---|
| PTZ step size | 12 | 1–100 |

How far a camera moves per tap of the pan/tilt arrows in the live view. A larger number moves
further per tap. This only affects cameras that support precise relative positioning
(ONVIF `RelativeMove`) — cameras that don't move a fixed amount per tap regardless of this
setting. There's no single right value; it depends on the camera's own pan/tilt hardware and
gearing. 12 suits the common Sonoff pan/tilt cameras this was tuned against — if taps feel too
small or too jumpy on your camera, adjust it and see how it feels.

## Camera-offline alerts

| Setting | Default | Range |
|---|---|---|
| Notify when a camera goes offline | Off | — |
| Offline for longer than (minutes) | 5 | 1–1440 |

Sends a push notification (through whichever providers you've set up under **Settings → Push
notifications**) when a camera stops delivering video for longer than the threshold, and a
second notification when it recovers. A brief blip that clears on its own — shorter than the
threshold — never alerts, and each outage produces exactly one "went offline" notification, not
a repeat per minute it stays down.

The threshold is measured from the first check (every 15 seconds) that couldn't *confirm* the
camera was delivering video, and only a confirmed picture stops it. A check where the streaming
server inside Nightlight (MediaMTX) isn't answering at all counts as one that couldn't confirm it,
so that time counts toward the threshold too. This is different from the
automatic restart, which never fires while the streaming server isn't answering, because it only
acts on a confirmed "no video" (see [KNOWN-ISSUES.md](../KNOWN-ISSUES.md), "Cameras show
connecting/offline and the log has `[guard:mediamtx-api]` lines"). So if the streaming server gets
stuck, you still get this notification, even though nothing was restarted.

This is a global on/off with one global threshold: it applies to every camera the same way,
there's no per-camera override.

## Related

- **[MQTT](mqtt.md)** — the broker connection and per-camera topics this doesn't cover.
- Per-camera motion/sound detection sensitivity, schedule, and detection source (Nightlight
  frame-diff / ONVIF / MQTT) are configured on each camera's own settings page, not here.
