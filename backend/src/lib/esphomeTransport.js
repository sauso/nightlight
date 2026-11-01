import { openEspHomeClient } from 'esphome-client';

// The library defaults to console output, including its own key-failure text. Never forward it.
const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sentences = Object.freeze({
  KEY_INVALID: 'The encryption key must be a base64 value of 32 bytes.',
  KEY_WRONG: 'The encryption key was rejected by the device.',
  KEY_NEEDED: 'The device requires an encryption key.',
  REFUSED: 'The device refused the connection.',
  TIMEOUT: 'The device did not respond in time.',
  CLOSED: 'The device closed the connection.',
  HEARTBEAT: 'The device stopped responding.',
  NOT_ENCRYPTED: 'The device did not encrypt the connection.',
  FRAME: 'The device sent an unreadable frame.',
  OTHER: 'Could not talk to the device.',
});

export function esphomeError(code) {
  const safe = Object.hasOwn(sentences, code) ? code : 'OTHER';
  return Object.assign(new Error(sentences[safe]), { code: safe });
}

export function classifyEsphomeError(error) {
  if (error?.code && Object.hasOwn(sentences, error.code)) return esphomeError(error.code);
  switch (error?.name) {
    case 'EncryptionKeyInvalidError': return esphomeError('KEY_WRONG');
    case 'EncryptionRequiredError':
    case 'EncryptionKeyMissingError': return esphomeError('KEY_NEEDED');
    case 'ConnectionRefusedError': return esphomeError('REFUSED');
    case 'ConnectionTimeoutError':
    case 'NoiseHandshakeTimeoutError':
    case 'TimeoutError':
    case 'AbortError': return esphomeError('TIMEOUT');
    case 'ConnectionClosedByPeerError': return esphomeError('CLOSED');
    case 'HeartbeatStalledError': return esphomeError('HEARTBEAT');
    case 'FrameTooLargeError':
    case 'BufferOverflowError':
    case 'DecodingError': return esphomeError('FRAME');
    default: return esphomeError('OTHER');
  }
}

export function validEsphomeKey(key) {
  if (key == null || key === '') return null;
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(key) ||
      Buffer.from(key, 'base64').length !== 32) throw esphomeError('KEY_INVALID');
  return key;
}

export function publicEsphomeEntity(entity) {
  return {
    object_id: entity.objectId, kind: entity.type, name: entity.name || null,
    device_class: entity.deviceClass || null, unit: entity.unitOfMeasurement || null,
    state_class: entity.stateClass ?? null, entity_category: entity.entityCategory ?? null,
    ignored: !['sensor', 'binary_sensor'].includes(entity.type) ||
      entity.entityCategory === 2 || entity.disabledByDefault === true,
    // Set by openDevice when a later entity repeats an earlier one's object_id, or when two kinds share one key
    // (`shared_key`; see `refreshEntities`).
    duplicate: false,
    shared_key: false,
  };
}

// esphome-client 2.0.0's `client.on()` returns a Disposable (`{ [Symbol.dispose]() }`, event-bus.js `on`), on the real
// client and on its MockClient alike, not a function. The first version called it as a function, which threw (swallowed)
// and left the telemetry listener attached after close (#506 review, L4). Accept both shapes.
function dispose(subscription) {
  if (typeof subscription === 'function') subscription();
  else subscription?.[Symbol.dispose]?.();
}

// The only library boundary. The returned handle can close and report metadata; it never exposes the client.
export async function openDevice({ host, port, key }, {
  open = openEspHomeClient, signal, onEntities = () => {}, onState = () => {}, onConnection = () => {},
} = {}) {
  const psk = validEsphomeKey(key);
  let client;
  let closed = false;
  let accepted = false;
  let stopTelemetry = null;
  // numeric device key -> recorded entity. A real telemetry event carries `entity` = the entity's DISPLAY NAME and a numeric
  // `key` (read from esphome-client's event builder and seen in the probe's real events), NOT the `kind-object_id` string. The
  // library's own MockClient/mockStateMessage puts that id string in `entity`, so a lookup on it passes every mock-driven test
  // and matches nothing on a real device (found in review, 2026-10-28: it would have recorded no readings at all). The key is
  // the stable identity, so it is rebuilt from every discovery, including after a reconnect.
  let known = new Map();
  const refreshEntities = () => {
    const listed = client.entitiesByDevice(undefined);
    const raw = listed.slice(0, 201);
    const list = raw.map(publicEsphomeEntity);
    // #506 review, round 2 (L-a): ESPHome derives the numeric key from the object_id, not from the type, so a binary_sensor
    // and a sensor both named "Presence" share one key. esphome-client keeps ONE entity per key (entity-registry.js
    // `entitiesByKey`: the later registration wins) and decodes every state frame for that key with that entity's type and
    // schema (esphome-client.js `handleTelemetry`), so nothing on the event says which of the two sent it. Driven through
    // the real client with the binary sensor recorded, the sensor's 0.0 came through with no state and was stored as the
    // binary sensor's "off" (H2 below), and the binary sensor's own "on" came through as a number and was stored as
    // missing: made-up readings. So when one key is listed with two different kinds, BOTH are ignored, flagged `duplicate`
    // and `shared_key` so the manager can log it. The whole list is checked, not only the first 200, because an entity
    // past the cap still sends frames under its key. The same key listed again with the SAME kind is the library
    // re-listing one entity, handled below.
    const kindsByKey = new Map();
    for (const r of listed) {
      if (Number.isInteger(r?.key)) kindsByKey.set(r.key, (kindsByKey.get(r.key) || new Set()).add(r.type));
    }
    // #506 review (M2): ESPHome derives object_id from the entity's name lossily and does not enforce unique names, so two
    // entities with different keys can share an object_id ("Temp 1" and "Temp.1" both become temp_1; esphome-client's
    // entity-registry.js `register` says so and keeps both reachable by key). Both used to map to one object_id here, so
    // their values were averaged into one series. The FIRST recorded entity with an object_id keeps it; a later one with a
    // different key is ignored and flagged so the manager can log it. A repeat of the SAME key is the library re-listing
    // one entity (it appends repeats to its ordered list), not a second entity, so it is skipped without the flag.
    const firstKey = new Map();
    known = new Map();
    raw.forEach((r, i) => {
      const entity = list[i];
      if (!Number.isInteger(r.key)) return;
      if (kindsByKey.get(r.key).size > 1) {
        list[i] = { ...entity, ignored: true, duplicate: true, shared_key: true };
        return;
      }
      if (entity.ignored) return;
      if (!firstKey.has(entity.object_id)) {
        firstKey.set(entity.object_id, r.key);
        known.set(r.key, entity);
        return;
      }
      list[i] = { ...entity, ignored: true, duplicate: firstKey.get(entity.object_id) !== r.key };
    });
    return list;
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const close = () => {
    if (closed) return;
    closed = true;
    controller.abort();
    signal?.removeEventListener('abort', abort);
    try { dispose(stopTelemetry); } catch { /* a hostile callback cannot escape shutdown */ }
    try { client?.disconnect(); } catch { /* immediate teardown is best effort */ }
  };
  const report = (state, error = null, encrypted = false) => {
    try { onConnection({ state, encrypted, error_code: error?.code || null, error: error?.message || null }); } catch { /* observer isolation */ }
  };
  const onTelemetry = (event) => {
    try {
      if (closed || !accepted) return;
      const entity = known.get(event.key);
      if (!entity) return;
      // #506 review (H2): an absent `state` is a real 0 or false, not a missing reading. ESPHome leaves default values off
      // the wire (protobuf: a float 0.0 and a bool false are not serialised), and esphome-client copies a field onto the
      // event only when it is present (telemetry.js `decodeStateFromSchema`: `if (value !== undefined)`). The first version,
      // and the probe that informed this design, treated an absent `state` as NaN and so discarded every zero: a heart rate
      // of 0, 0 lx in a dark room, a target number of 0 when nobody is detected, presence false. The library's MockClient
      // always puts `state` on its events, which is what hid this. "Missing" is now only the device's own `missingState`
      // flag, a non-finite number, or a value that is present with the wrong type.
      const raw = event.state === undefined ? (entity.kind === 'binary_sensor' ? false : 0) : event.state;
      const missing = event.missingState === true ||
        (typeof raw === 'number' && !Number.isFinite(raw)) ||
        (entity.kind === 'sensor' && typeof raw !== 'number') ||
        (entity.kind === 'binary_sensor' && typeof raw !== 'boolean');
      if (missing) onState({ objectId: entity.object_id, kind: entity.kind, missing: true });
      else if (entity.kind === 'binary_sensor' && typeof raw === 'boolean')
        onState({ objectId: entity.object_id, kind: entity.kind, value: raw ? 1 : 0, missing: false });
      else if (entity.kind === 'sensor')
        onState({ objectId: entity.object_id, kind: entity.kind, value: raw, missing: false });
    } catch { /* no device frame can throw into the library's event bus */ }
  };
  // #506 review (L6): states that arrive before the listener exists (the first open) or while `accepted` is false (between
  // the library's reconnect and our lifecycle loop seeing it) were dropped, so a presence flag could stay unknown until it
  // next changed. `client.snapshot()` holds the latest event per entity (esphome-client: a live ReadonlyMap, updated before
  // listeners run and cleared at each connect), so replaying it through the same handler recovers them. It runs only after
  // the 'connected' report, because the manager discards states for a device it does not yet see as connected. Nothing
  // can arrive twice: the replay is synchronous, so no telemetry event is delivered between accepting and replaying.
  const seedFromSnapshot = () => {
    let latest;
    try { latest = client.snapshot?.(); } catch { return; }
    if (!latest || typeof latest.values !== 'function') return;
    for (const event of [...latest.values()]) onTelemetry(event);
  };
  try {
    // #506: a missing encryption flag is a downgrade. Check before the telemetry listener exists.
    const opening = Promise.resolve().then(() => open({ host, port, psk, logger: silent,
      signal: controller.signal, connectTimeoutMs: 30000, maxConstructionRetries: 0 }));
    // Abort bounds even an injected or future open implementation that fails to honour its signal.
    opening.then((late) => { if (controller.signal.aborted) { try { late.disconnect(); } catch {} } }, () => {});
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(esphomeError('TIMEOUT'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try { client = await Promise.race([opening, cancelled]); }
    finally { controller.signal.removeEventListener('abort', onAbort); }
    if (closed || controller.signal.aborted) { try { client.disconnect(); } catch {} throw esphomeError('TIMEOUT'); }
    if (psk && client.health()?.encrypted !== true) {
      close(); report('failed', esphomeError('NOT_ENCRYPTED')); throw esphomeError('NOT_ENCRYPTED');
    }
    accepted = true;
    const discovered = refreshEntities();
    try { onEntities(discovered); } catch { /* observer isolation */ }
    stopTelemetry = client.on('telemetry', onTelemetry);
    // Lifecycle is observed separately because reconnect can change the encryption result.
    void (async () => {
      try {
        for await (const event of client.lifecycle({ signal: controller.signal })) {
          try {
            if (closed) break;
            if (event.kind === 'disconnect') {
              accepted = false;
              report('disconnected', classifyEsphomeError(event.cause));
            } else if (event.kind === 'connect') {
              if (psk && (event.encrypted !== true || client.health()?.encrypted !== true)) {
                accepted = false;
                report('failed', esphomeError('NOT_ENCRYPTED'));
                close();
                break;
              }
              accepted = true;
              try { onEntities(refreshEntities()); } catch { /* observer isolation */ }
              report('connected', null, psk ? true : false);
              seedFromSnapshot();
            }
          } catch { report('failed', esphomeError('OTHER')); close(); break; }
        }
      } catch { if (!closed) { report('failed', esphomeError('OTHER')); close(); } }
    })();
    report('connected', null, psk ? true : false);
    seedFromSnapshot();
    return { close, entities: discovered.slice(0, 200), encrypted: psk ? true : false };
  } catch (error) {
    close();
    const safe = classifyEsphomeError(error);
    if (!accepted) report('failed', safe);
    throw safe;
  }
}
