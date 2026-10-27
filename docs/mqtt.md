# MQTT

Nightlight can connect to an existing MQTT broker (e.g. one you already run for Home Assistant
or Zigbee2MQTT) for two independent, optional things:

1. **Room temperature/humidity** on a camera tile, from a sensor that publishes readings.
2. **Camera-native motion detection**, for a camera that publishes its own motion events to
   MQTT instead of Nightlight analysing the video stream.

Neither requires the other — use one, both, or neither.

## Connecting to a broker

**Settings → Integrations → MQTT** (admin only):

| Field | Notes |
|---|---|
| Broker host | Required. IP or hostname, **only** (no `user@`, path or query). Letters, digits, `.`, `-` and `_` are accepted (an internationalised name such as `bücher.example` too), and an IPv6 address goes in square brackets (`[fe80::1]`); spaces before or after the host are removed. Anything else (a space or line break inside the name, `;`, `'`, `%`, `:` and so on) is refused when you press Save, with the reason, and nothing is stored. The reason names the first character that is not allowed (an invisible one by its code, such as `U+00A0`) but never repeats what you typed, so a pasted `mqtt://user:password@broker` does not send the password back or write it to the log. |
| Broker port | Default **1883** if left blank, or **8883** if left blank with **Use TLS** on. Otherwise a whole number from **1 to 65535**; anything else is refused when you press Save, and nothing is stored. |
| Username / password | Optional, only if your broker requires auth. |
| Use TLS (`mqtts://`) | **Off** by default (a plain `mqtt://` connection, as it has always been). Turn on to encrypt the connection, including the username and password. Your broker must have TLS enabled, usually on port 8883. |
| Verify the broker's certificate | Shown when TLS is on. **On** by default. Keep it on: with it off the connection is encrypted, but anyone on your network who answers as the broker is trusted. |
| CA certificate | Shown when TLS is on. Optional PEM text (`-----BEGIN CERTIFICATE-----`). **Blank** trusts the usual public authorities, which suits a broker with a certificate from a public authority. For a broker with a certificate from your own authority, paste **the certificate of the authority that signed it**; for a **self-signed** broker, paste the broker's own certificate. The broker's own certificate works only when it is self-signed: one signed by an authority, pasted here, is refused when connecting. **When filled in, only that certificate is trusted** for this connection (the public list is not used). Up to 10 certificates and 100 000 characters. While **Use TLS** is off this box is hidden and a save leaves the stored certificate as it is. |

⚠️ **Unless you turn on Use TLS, the connection is plain `mqtt://`.** If your broker is on a
different host than Nightlight, that traffic (including the username/password, if set) is
unencrypted on your LAN. That is how every install worked before TLS was added, and **upgrading
changes nothing**: TLS stays off until you turn it on. Plain `mqtt://` is fine for a broker on the
same machine or a network you trust, and it is not something to expose across the internet.

### Using TLS

1. On the broker, enable a TLS listener (Mosquitto: a `listener 8883` with `certfile`, `keyfile`
   and, if you use your own authority, `cafile`).
2. In **Settings → Integrations → MQTT** turn on **Use TLS**, set the port (8883 if you left it blank), and, if the
   certificate is not from a public authority, paste the **CA certificate**.
3. Save. Under the form Nightlight says **Connected over TLS**, or **Not connected** with the reason.

What Nightlight refuses at Save, with the reason shown next to the CA box and nothing stored:
text that is not a certificate; extra text around a certificate; a block that is not a valid
certificate; **a private key** (never paste the key; it is refused by name and never stored or
logged); more than 10 certificates. The certificate itself is not a secret, so it is shown back to
admins in the form. **The password is treated as before: never returned, a blank box keeps the
current one.** The certificate text is never written to the log.

| Reason shown | What it means |
|---|---|
| The broker's certificate is self-signed / its issuer is not trusted | No CA certificate is set: add the one that signed the broker's certificate (or, for a self-signed broker, the broker's own certificate), or (less safely) turn off verification |
| The certificate you added is not a CA that signed the broker's certificate | A CA certificate is set, and it is not the one that signed the broker's (the usual cause: the broker's own certificate pasted when an authority signed it). Paste that authority's certificate |
| The stored CA certificate cannot be used / the stored broker host or port cannot be used | A value already in the database (edited by hand, or saved by an older version) is not usable; MQTT stays off. Replace or clear it and save |
| The broker's certificate has expired / is not valid yet | Renew it on the broker / check the clocks |
| The certificate is not valid for the host name or address entered | Use the name the certificate was issued for (an IP address only works if the certificate lists it) |
| The broker did not answer with TLS | TLS is on here but the port is a plain `mqtt://` listener (usually 1883); use the broker's TLS port |

Turning **Verify** off is a downgrade you should only make knowingly (for example while testing a
self-signed broker): it keeps eavesdroppers out but lets anyone who can answer as the broker in. TLS
protects the connection to the broker; it does **not** change who may publish to a topic, which is
still your broker's access rules (see [Camera-native motion](#camera-native-motion)).

Saving reconnects automatically (retry every 5 seconds while down) — no restart needed. The
**Settings → Integrations** shows a status badge next to MQTT:

- **Connected** (green) — broker handshake succeeded.
- **Disconnected** (red) — MQTT is enabled but the broker isn't reachable (wrong host/port,
  broker down, or auth rejected — check the container logs for `[mqtt] Connection error:`).
- **Off** (grey) — MQTT isn't enabled.

If a broker host or port, or a CA certificate, that is not usable is **already stored** (saved by an older
version, or edited into the database by hand), Nightlight no longer fails to start: it logs
`[mqtt] Not connecting: <reason>`, leaves MQTT off (the badge shows Disconnected, and **Settings → Integrations → MQTT** says
**Not connected** with which value cannot be used, without repeating it) and keeps running. Correct the value
under **Settings → Integrations → MQTT**.

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

⚠️ **An MQTT motion alert is only as trustworthy as your broker's access rules.** Nightlight alerts on
any message on the camera's motion topic that reads as motion; it cannot tell the camera from anything
else that publishes there. Whoever can publish to that topic can raise a false alert (a push and an
entry in the Alerts feed), and because each alert starts the camera's cooldown (60 seconds by
default), a real event that follows within the cooldown raises no alert of its own. The
connection is plain `mqtt://` (above), so the broker password also travels in the clear, and anyone who
reads it can publish as the camera. Nightlight's own frame-diff detection and ONVIF motion take their
signal from the camera itself, not from a broker, so they do not have this weakness. If you use this
source, give each camera its own broker account that may publish only to its own motion topic, and let
no other account publish to it; if your broker cannot do that, prefer one of the other two sources.

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
