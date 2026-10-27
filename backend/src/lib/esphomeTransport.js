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
  };
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
    const raw = client.entitiesByDevice(undefined).slice(0, 201);
    const list = raw.map(publicEsphomeEntity);
    known = new Map(raw.flatMap((r, i) => (!list[i].ignored && Number.isInteger(r.key) ? [[r.key, list[i]]] : [])));
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
    try { stopTelemetry?.(); } catch { /* a hostile callback cannot escape shutdown */ }
    try { client?.disconnect(); } catch { /* immediate teardown is best effort */ }
  };
  const report = (state, error = null, encrypted = false) => {
    try { onConnection({ state, encrypted, error_code: error?.code || null, error: error?.message || null }); } catch { /* observer isolation */ }
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
    stopTelemetry = client.on('telemetry', (event) => {
      try {
        if (closed || !accepted) return;
        const entity = known.get(event.key);
        if (!entity) return;
        const raw = event.state;
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
    });
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
            }
          } catch { report('failed', esphomeError('OTHER')); close(); break; }
        }
      } catch { if (!closed) { report('failed', esphomeError('OTHER')); close(); } }
    })();
    report('connected', null, psk ? true : false);
    return { close, entities: discovered.slice(0, 200), encrypted: psk ? true : false };
  } catch (error) {
    close();
    const safe = classifyEsphomeError(error);
    if (!accepted) report('failed', safe);
    throw safe;
  }
}
