# #506 — Direct ESPHome temperature/humidity without MQTT (spike write-up)

Status: written research, **no prototype**. Tier T0, docs only. I had no ESPHome device and no network
access to ESPHome's documentation or package registries in this session, so everything about ESPHome below is
from memory and is **unverified** until checked against ESPHome's own docs and a real device. Where I name a
package it is a candidate that needs checking (existence, maintenance, licence, version); no version is asserted.

## 1. How environmental data reaches the app today

All of it comes through MQTT, per camera:

1. **Connection.** `backend/src/lib/mqttClient.js` holds one `mqtt` client (dependency `mqtt` in
   `backend/package.json:26`). Broker host/port/credentials are admin settings (`docs/mqtt.md`, "Connecting
   to a broker"); the URL is built by `mqttBrokerUrl` (`mqttClient.js:~180-215`) and is always plain `mqtt://`
   (`docs/mqtt.md:22`).
2. **Subscription.** Each camera has an optional `mqtt_topic`; `subscribeAllCameraTopics`
   (`mqttClient.js:~38-56`) subscribes to it.
3. **Parse.** A JSON payload with numeric `temperature` and/or `humidity` is accepted
   (`docs/mqtt.md:44-55`); the latest value per topic is kept in an in-memory `Map`
   (`readings`, `mqttClient.js:~13`; `readings.set` at `:307`) with a `receivedAt`. Temperature must already be
   Celsius (`docs/mqtt.md:57-59`).
4. **Live read.** `getReading(topic)` (`mqttClient.js:31`) is used by the camera route that serves the tile
   (`routes/cameras.js:641`, field `mqtt`) and by diagnostics (`routes/diagnostics.js:10`).
5. **History.** `lib/sensorSampler.js` samples `getReading` for every enabled camera with an `mqtt_topic`
   every 5 minutes, only if the reading is under 15 minutes old (`sensorSampler.js:~11-45`), into
   `sensor_readings(camera_id, temperature, humidity, created_at)` (`db.js:154-161`), kept 30 days
   (`sensorSampler.js:~15`). `GET /api/cameras/:id/sensor-history` serves it (`routes/cameras.js:~677`).
6. **Sleep use.** `nightClimate` averages the child's cameras' `sensor_readings` over the night
   (`lib/sleepAnalysis.js:551-590`) into `sleep_nights.avg_temperature/avg_humidity` (`db.js:857-859`,
   `sleepAnalysis.js:2390`), and `sleepInsights` correlates them with wake counts (`sleepAnalysis.js:~2504`).

**Consequence for design:** everything downstream of step 3 keys on `getReading(topic)` and a **camera id**.
A sensor is attached to a *camera* (`cameras.mqtt_topic`), not to a room or a child. Any new provider that
wants to feed history and sleep must either (a) expose the same `{temperature, humidity, receivedAt}` shape
through a `getReading`-like function that `sensorSampler` can ask per camera, or (b) be generalised. (a) is the
smaller change and is recommended for v1.

## 2. What ESPHome offers (all unverified)

### 2.1 Native API (what Home Assistant uses)

* TCP, default port **6053**, enabled by the `api:` component. Protobuf messages with a small framing layer.
* **Two framings:** plaintext (a zero preamble byte, then length and message-type varints) and **Noise**
  encryption (`encryption: key: <base64 32 bytes>` in the device config; Noise_NNpsk0 with a pre-shared key,
  as I recall). Older devices used a legacy `password:` in the `Connect` message; I believe it was deprecated
  and later removed in new ESPHome releases — **needs checking against the current ESPHome release notes**
  before assuming plaintext+password devices exist in the field or will keep working.
* **Flow:** Hello → (Connect/auth for legacy) → `ListEntities` (each sensor reports a numeric `key`, name,
  `unit_of_measurement`, `device_class`) → `SubscribeStates` (device then pushes state changes and a
  current-value snapshot). `device_class` `temperature` / `humidity` is the natural way to pick the right
  entities; a unit check (°C vs °F) is needed because Nightlight stores Celsius.
* **Discovery:** mDNS service `_esphomelib._tcp`; not needed if the admin types a host.
* **Keep-alive:** the protocol has ping messages; a half-dead TCP connection must be detected by us.
* **For us:** push-based (no polling), supports encryption, devices usually already have it enabled (HA uses
  it). The cost is implementing/owning a protobuf client.

### 2.2 Web server component (REST + SSE)

* Needs `web_server:` added to the device config (extra flash/RAM; some small devices omit it). Default HTTP
  port 80; optional username/password (HTTP Basic). **No transport encryption** (plain HTTP).
* Per-entity REST like `GET /sensor/<id>` returning JSON, plus a server-sent-events stream at `/events`
  with state changes. Enough for temperature/humidity, simple to consume with Node's `fetch`/`http`
  (no new dependency). Entity ids differ between web-server versions (v2 vs v3) — **needs checking**.
* **For us:** trivial client, no protobuf. But: user must enable a component many devices don't have, plain
  HTTP, and Basic auth in cleartext on the LAN (worse than the existing MQTT-without-TLS only because
  it's the sensor's own credential rather than the broker's; same class).

### 2.3 Others (not recommended)

* Python `aioesphomeapi` sidecar: the issue says to document, not build. It is the reference client but adds a
  second runtime to a single-container image whose three processes are already a constraint
  (CLAUDE.md, "One image, one container").
* ESPHome publishing to MQTT: already works today through the existing path; it is the baseline we compare to.

## 3. Options

| Option | Effort | Pros | Cons |
|---|---|---|---|
| A. Native API via an npm client | Small-medium | Push, encrypted, likely already enabled | Dependency risk: must check a Node library's maintenance, ESPHome version compatibility, Noise support, reconnect behaviour, install footprint. Candidates exist (I recall `esphome-native-api` and forks) but **I have not verified any of them** |
| B. Own minimal Native API client | Medium-large | No dependency, only the subset | Protobuf schema + Noise handshake (needs a vetted Noise/crypto implementation, Node's `crypto` has X25519/ChaCha20-Poly1305 but not Noise framing); owner of a protocol that ESPHome evolves; security-sensitive code written by us |
| C. Web server REST/SSE | Small | No dependency, easy tests with a fake HTTP server | Needs `web_server:` on the device; plaintext; entity-id differences between versions |
| D. Keep MQTT | None | Works | Needs a broker (the reason for the issue) |

**Recommendation.** Do C first as a small, low-risk provider *behind the provider interface* of §4, because it
adds no dependency and can be fully tested here. In parallel, do a one-evening verification of A: pick one
candidate library, run it against a real device, and judge it on the issue's checklist (maintenance, Noise,
discovery, subscription, reconnect, dependency/audit footprint). Adopt A only if it passes; otherwise ship C
and document the requirement. Avoid B unless A fails *and* C is judged too restrictive — the maintenance and
crypto-review burden is the reason (the issue says the same).

## 4. Shape (small PRs)

1. **PR 1 (T1/T2: schema):** a `sensor provider` seam. Extract from `mqttClient` the `{temperature, humidity,
   receivedAt}` shape and give `sensorSampler` a `getReadingForCamera(camera)` that dispatches by provider.
   MQTT unchanged (golden test: same rows written as today). Settings: a per-camera `sensor_provider` column
   (`mqtt` default, so existing installs are untouched) and provider config (host, port, entity ids, optional
   credentials stored and never returned, like camera passwords).
2. **PR 2 (T1):** the C provider: SSE client with bounded exponential backoff, mark `unavailable` when stale
   (reuse the 15-minute freshness rule at `sensorSampler.js:~11`), unit conversion to Celsius. Tests with a
   local fake web server, including: drop mid-stream, auth failure, malformed JSON, device not answering —
   asserting that camera streaming and the sampler tick are unaffected (the issue's hard requirement).
3. **PR 3 (T1):** settings UI + `docs/` page, admin-only, with a "Test connection" that lists the temperature
   and humidity entities it found.
4. **PR 4 (optional, T2):** native API provider if §3's verification of A passes.
5. A **diagnostics** line per provider (state, last reading age) next to the existing MQTT status.

Credentials: the route-permissions pin and `secrets-never-returned` tests apply (CLAUDE.md, Definition of done);
a new credential column is covered by that test automatically.

## 5. Failure modes to design for

* Device offline / Wi-Fi flaps: must not throw into the process (no unhandled `error` events on sockets),
  must back off (bounded), must mark the source unavailable after the freshness window, and must never block
  the event loop that serves video.
* Half-open TCP (no FIN): needs an application-level timeout/ping.
* Reboots change nothing but reset subscriptions: re-enumerate and re-subscribe on reconnect.
* Entity renamed/removed in the device config: the stored entity id/key no longer matches; show "not found".
* Unit is °F or the entity has no `device_class`: do not guess silently.
* Time: device clocks are irrelevant; stamp readings with the Nightlight clock on receipt.
* Wrong/rotated encryption key (A): surface "authentication failed" without logging the key.
* Several cameras sharing one sensor (as today with a shared MQTT topic): one connection per device, not per camera.
* Security: do not log keys or passwords; any key field must follow the camera-password rule (never returned).

## 6. What could not be verified without hardware (and without docs access)

* Which ESPHome versions still accept plaintext or password auth; the exact Noise handshake details.
* Whether any Node library supports current ESPHome, and its maintenance state, licence and dependencies.
* The web server's current entity-id scheme, SSE event format, and behaviour on small boards under load.
* Real reconnect behaviour, latency, and memory use on the device.
* Whether devices in the wild commonly leave `web_server:` enabled.
* Any claim in sections 2-3 about ESPHome itself.
