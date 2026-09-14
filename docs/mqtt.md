# MQTT

Nightlight can connect to an existing MQTT broker (e.g. one you already run for Home Assistant
or Zigbee2MQTT) for two independent, optional things:

1. **Room temperature/humidity** on a camera tile, from a sensor that publishes readings.
2. **Camera-native motion detection**, for a camera that publishes its own motion events to
   MQTT instead of Nightlight analysing the video stream.

Neither requires the other — use one, both, or neither.

## Connecting to a broker

**Settings → MQTT** (admin only):

| Field | Notes |
|---|---|
| Broker host | Required. IP or hostname. |
| Broker port | Default **1883** if left blank. |
| Username / password | Optional, only if your broker requires auth. |

⚠️ **The connection is always plain `mqtt://` — TLS (`mqtts://`) is not supported.** If your
broker is on a different host than Nightlight, that traffic (including the username/password,
if set) is unencrypted on your LAN. This is fine for a broker running locally on your network;
it's not something to expose across the internet.

Saving reconnects automatically (retry every 5 seconds while down) — no restart needed. The
**Settings** hub shows a status badge next to MQTT:

- **Connected** (green) — broker handshake succeeded.
- **Disconnected** (red) — MQTT is enabled but the broker isn't reachable (wrong host/port,
  broker down, or auth rejected — check the container logs for `[mqtt] Connection error:`).
- **Off** (grey) — MQTT isn't enabled.

A green "Connected" badge only means the broker connection itself is up — it says nothing about
whether any camera's topic is actually being published to. See "Troubleshooting" below.

## Temperature / humidity

On each camera's edit page, set **MQTT topic** to whatever topic your sensor publishes to (e.g.
`zigbee2mqtt/nursery-sensor`). Nightlight subscribes to it and accepts a **JSON payload with
numeric `temperature` and/or `humidity` fields** — nothing else is read from this payload
shape:

```json
{ "temperature": 21.3, "humidity": 47 }
```

Either field alone is fine (`{"humidity": 47}` works with no `temperature` key). Non-numeric
values, or a payload that isn't valid JSON, are silently ignored for this purpose — the reading
just never updates, with no error surfaced in the UI.

**Temperature must be sent in Celsius.** Nightlight stores it as-is and converts for display
only, based on your **Settings → General** temperature unit — there is no unit configuration on
the MQTT side, so a sensor publishing Fahrenheit will show the wrong number.

## Camera-native motion

On a camera's **Motion detection** settings, set the detection source to **"Camera via MQTT"**
and fill in:

| Field | Notes |
|---|---|
| Motion MQTT topic | The topic the camera (or its bridge, e.g. a Sonoff-hack flash) publishes motion events to. |
| Motion value | Optional. Leave blank to auto-recognise common shapes (below); set it if your camera uses something else. |

With **Motion value** left blank, a payload is read as motion-detected if it matches any of
these shapes:

- A plain payload: `ON`, `1`, `true`, `motion`, `active`, `detected`, `start`/`started`, `open`,
  `alarm`, `detect` (case-insensitive).
- JSON with one of these fields set to one of the words above: `motion`, `motion_detected`,
  `motionDetected`, `event`, `state`, `alarm`, `occupancy`, `value`, `status`, `detected` — e.g.
  `{"motion": true}` or `{"state": "ON"}`.
- A word that plainly contains "motion", "detect", or "alarm" anywhere in the payload.

An explicit "off" word (`OFF`, `0`, `false`, `clear`, `stop`/`stopped`, `idle`, `closed`, …)
always wins over an "on" word in the same payload — so a compound value like `motion_stop`
(which contains "motion") is correctly read as **not** motion, not as a false positive.

If you set **Motion value** yourself, only an exact or substring match against that value (or a
JSON field equal to it) counts — the automatic recognition above is skipped entirely for that
camera.

Motion read this way goes through the **same per-camera cooldown and active-hours schedule** as
Nightlight's own frame-diff detection — it isn't a raw firehose of every message.

## Troubleshooting: "connected but no readings"

1. **Confirm the broker is actually publishing on that exact topic.** `mosquitto_sub -h
   <broker> -t '<topic>' -v` (or your broker's own tooling) from another machine on the network.
2. **Check the container log** for `[mqtt] receiving on topic "<topic>" — first message: …` —
   Nightlight logs the first message it sees on each subscribed topic once. If that line never
   appears, the subscription itself isn't matching (topic typo is the usual cause — MQTT topics
   are case-sensitive and exact).
3. **If messages ARE arriving but nothing updates**: check the payload shape against the JSON
   field lists above. A temperature/humidity payload with the numbers as strings (`"21.3"`
   instead of `21.3`) is not read — they must be JSON numbers.
4. Re-saving a camera's MQTT topic (or the broker settings) re-subscribes without needing a
   container restart.

## Related

- **[Camera controls](camera-controls.md)** — the global PTZ and offline-alert settings this
  doesn't cover.
