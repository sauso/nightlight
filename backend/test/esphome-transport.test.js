import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openEspHomeClient } from 'esphome-client';
import { MockClient, MockTransport } from 'esphome-client/testing';
import { openDevice, validEsphomeKey } from '../src/lib/esphomeTransport.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const sensor = { key: 1, id: 'sensor-heart_rate', type: 'sensor', objectId: 'heart_rate',
  name: 'Heart Rate', deviceClass: '', unitOfMeasurement: 'bpm' };
const binary = { key: 2, id: 'binary_sensor-presence', type: 'binary_sensor', objectId: 'presence',
  name: 'Presence', deviceClass: 'occupancy' };
const light = { key: 3, id: 'light-lamp', type: 'light', objectId: 'lamp', name: 'Lamp' };

function client(encrypted = true) {
  const mock = new MockClient();
  mock.populateEntities([sensor, binary, light]);
  mock.setHealth({ state: 'connected', encrypted, consecutiveStalls: 0, lastInboundActivityAt: null,
    connectedAtMs: Date.now() });
  return mock;
}

// A hand-built client for what MockClient cannot hold: it keys entities by `type-objectId`, so two entities sharing an
// object_id replace each other there, while the real registry keeps both (entity-registry.js `register`). `on()` returns
// the real shape, a Disposable (esphome-client event-bus.js `on`), not a function.
function fakeClient(entities) {
  const handlers = new Set();
  return {
    handlers,
    health: () => ({ encrypted: true }),
    entitiesByDevice: () => entities,
    snapshot: () => new Map(),
    on: (_event, handler) => { handlers.add(handler); return { [Symbol.dispose]: () => handlers.delete(handler) }; },
    lifecycle: () => (async function* () {})(),
    disconnect() {},
    send(event) { for (const handler of [...handlers]) handler(event); },
  };
}

test('#506 malformed key refuses before opening the library', async () => {
  let calls = 0;
  await assert.rejects(openDevice({ host: '127.0.0.1', port: 6053, key: 'bad' },
    { open: () => { calls++; return client(); } }), { code: 'KEY_INVALID' });
  assert.equal(calls, 0);
  assert.equal(validEsphomeKey(KEY), KEY);
});

test('#506 a configured key needs an affirmative encryption result before telemetry subscription', async () => {
  for (const health of [{ encrypted: false }, { encrypted: undefined }, {}, { isEncrypted: true }]) {
    let subscribed = false;
    let closed = false;
    const fake = { health: () => health, entitiesByDevice: () => [sensor],
      on: () => { subscribed = true; return { [Symbol.dispose]() {} }; }, disconnect: () => { closed = true; } };
    await assert.rejects(openDevice({ host: '127.0.0.1', port: 6053, key: KEY },
      { open: async () => fake }), { code: 'NOT_ENCRYPTED' });
    assert.equal(subscribed, false);
    assert.equal(closed, true);
  }
});

test('#506 read only telemetry, missing flag, ignored kind and no reported device name', async () => {
  const mock = client();
  mock.setDeviceInfo({ name: 'PRIVATE DEVICE NAME', macAddress: 'PRIVATE MAC' });
  const states = [];
  const handle = await openDevice({ host: '127.0.0.1', port: 6053, key: KEY },
    { open: async () => mock, onState: (s) => states.push(s) });
  assert.equal(handle.encrypted, true);
  assert.equal(handle.entities.length, 3);
  assert.equal(handle.entities[2].ignored, true);
  assert.ok(!JSON.stringify(handle).includes('PRIVATE'));
  // The REAL event shape: `entity` is the display name, `key` the numeric device key (see the note in esphomeTransport.js).
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor', state: 0, missingState: true });
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor', state: 72 });
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor', state: NaN });
  mock.emit('telemetry', { entity: 'Presence', key: 2, type: 'binary_sensor', state: true });
  mock.emit('telemetry', { entity: 'Lamp', key: 3, type: 'light', state: true });
  // Guard: the id string the library's MockClient uses is NOT how a real device identifies an entity, and an unknown key is ignored.
  mock.emit('telemetry', { entity: 'sensor-heart_rate', key: 99, type: 'sensor', state: 55 });
  assert.deepEqual(states, [
    { objectId: 'heart_rate', kind: 'sensor', missing: true },
    { objectId: 'heart_rate', kind: 'sensor', value: 72, missing: false },
    { objectId: 'heart_rate', kind: 'sensor', missing: true },
    { objectId: 'presence', kind: 'binary_sensor', value: 1, missing: false },
  ]);
  assert.deepEqual(mock.commands, []);
  handle.close();
});

test('#506 an update with no state is a real 0 or false; only the missing flag, NaN or a wrong type is missing', async () => {
  const mock = client();
  const states = [];
  const handle = await openDevice({ host: '127.0.0.1', port: 6053, key: KEY },
    { open: async () => mock, onState: (s) => states.push(s) });
  // The REAL shape of a zero or false: ESPHome leaves default values off the wire and esphome-client copies only the fields
  // that are present, so `state` is absent. MockClient always sends `state`, which is what hid this.
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor' });
  mock.emit('telemetry', { entity: 'Presence', key: 2, type: 'binary_sensor' });
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor', missingState: true });
  mock.emit('telemetry', { entity: 'Presence', key: 2, type: 'binary_sensor', missingState: true });
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor', state: NaN });
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor', state: 'high' });
  assert.deepEqual(states, [
    { objectId: 'heart_rate', kind: 'sensor', value: 0, missing: false },
    { objectId: 'presence', kind: 'binary_sensor', value: 0, missing: false },
    { objectId: 'heart_rate', kind: 'sensor', missing: true },
    { objectId: 'presence', kind: 'binary_sensor', missing: true },
    { objectId: 'heart_rate', kind: 'sensor', missing: true },
    { objectId: 'heart_rate', kind: 'sensor', missing: true },
  ]);
  handle.close();
});

test('#506 entities sharing an object_id: the first is recorded, a later key is ignored and flagged', async () => {
  const first = { key: 1, type: 'sensor', objectId: 'temp_1', name: 'Temp 1' };
  const second = { key: 4, type: 'sensor', objectId: 'temp_1', name: 'Temp.1' };
  // The library appends a re-listed key to its list again; that is the same entity, not a duplicate to report.
  const fake = fakeClient([first, second, first]);
  const states = [];
  const handle = await openDevice({ host: '127.0.0.1', port: 6053, key: KEY },
    { open: async () => fake, onState: (s) => states.push(s) });
  assert.deepEqual(handle.entities.map((e) => [e.object_id, e.ignored, e.duplicate]),
    [['temp_1', false, false], ['temp_1', true, true], ['temp_1', true, false]]);
  fake.send({ entity: 'Temp 1', key: 1, type: 'sensor', state: 20 });
  fake.send({ entity: 'Temp.1', key: 4, type: 'sensor', state: 30 });
  assert.deepEqual(states, [{ objectId: 'temp_1', kind: 'sensor', value: 20, missing: false }],
    'the second entity\'s value reached the first one\'s series');
  handle.close();
});

// #506 review, round 2 (L-a): ESPHome derives the key from the name, not the type, so a binary sensor and a sensor with one
// name share a key, and the library decodes both entities' frames with one of the two types. Nothing can tell them apart.
test('#506 two kinds sharing one key: neither is recorded and no frame for that key produces a reading', async () => {
  const shared = [{ key: 7, type: 'binary_sensor', objectId: 'presence', name: 'Presence' },
    { key: 7, type: 'sensor', objectId: 'presence', name: 'Presence' }];
  const fake = fakeClient([...shared, sensor]);
  const states = [];
  const handle = await openDevice({ host: '127.0.0.1', port: 6053, key: KEY },
    { open: async () => fake, onState: (s) => states.push(s) });
  assert.deepEqual(handle.entities.map((e) => [e.kind, e.object_id, e.ignored, e.duplicate, e.shared_key]), [
    ['binary_sensor', 'presence', true, true, true],
    ['sensor', 'presence', true, true, true],
    ['sensor', 'heart_rate', false, false, false],
  ]);
  // What the library delivers for key 7, labelled with whichever type it registered last: a number, nothing (a zero
  // left off the wire), true. Each would otherwise be a made-up 0, "off" or a missing flag on the wrong entity.
  for (const event of [{ type: 'sensor', state: 1 }, { type: 'sensor' }, { type: 'binary_sensor', state: true }, { type: 'binary_sensor' }])
    fake.send({ entity: 'Presence', key: 7, ...event });
  assert.deepEqual(states, [], 'a frame for the shared key was recorded');
  // The listener itself works: another entity's frame still arrives.
  fake.send({ entity: 'Heart Rate', key: 1, type: 'sensor', state: 61 });
  assert.deepEqual(states, [{ objectId: 'heart_rate', kind: 'sensor', value: 61, missing: false }]);
  handle.close();
});

test('#506 close() removes the telemetry listener: on() returns a Disposable, not a function', async () => {
  const fake = fakeClient([sensor]);
  const handle = await openDevice({ host: '127.0.0.1', port: 6053, key: KEY }, { open: async () => fake });
  assert.equal(fake.handlers.size, 1);
  handle.close();
  assert.equal(fake.handlers.size, 0, 'the telemetry listener outlived close()');
});

test('#506 states the client already holds are recorded on open and on every accepted reconnect', async () => {
  const mock = client(true);
  // Arrived before openDevice attached its listener; the library's latest-state cache (snapshot()) holds them.
  mock.emitState({ entity: 'Presence', key: 2, type: 'binary_sensor', state: true });
  mock.emitState({ entity: 'Heart Rate', key: 1, type: 'sensor', state: 64 });
  const seen = [];
  const handle = await openDevice({ host: '127.0.0.1', port: 6053, key: KEY }, {
    open: async () => mock,
    onState: (s) => seen.push(['state', s.objectId, s.value]),
    onConnection: (c) => seen.push(['connection', c.state]),
  });
  assert.deepEqual(seen, [['connection', 'connected'], ['state', 'presence', 1], ['state', 'heart_rate', 64]],
    'the states held before the listener existed were not recorded (or came before the connected report)');
  seen.length = 0;
  await new Promise((resolve) => setImmediate(resolve));
  mock.emit('lifecycle', { kind: 'disconnect' });
  await new Promise((resolve) => setImmediate(resolve));
  // The real client clears its cache at connect. This one arrives after the library reconnected but before our side has
  // seen the 'connect' event, so the listener drops it; only the replay can record it.
  mock.snapshot().clear();
  mock.emitState({ entity: 'Presence', key: 2, type: 'binary_sensor' });
  mock.emit('lifecycle', { kind: 'connect', encrypted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [['connection', 'disconnected'], ['connection', 'connected'], ['state', 'presence', 0]]);
  handle.close();
});

test('#506 an ignored AbortSignal still bounds a connection test', async () => {
  const abort = new AbortController();
  const pending = openDevice({ host: '127.0.0.1', port: 6053 },
    { signal: abort.signal, open: () => new Promise(() => {}) });
  abort.abort();
  await assert.rejects(pending, { code: 'TIMEOUT' });
});

test('#506 MockTransport confirms the installed client accepts a cancelled open', async () => {
  const transport = new MockTransport();
  const abort = new AbortController();
  const attempt = openDevice({ host: '127.0.0.1', port: 6053 }, {
    signal: abort.signal,
    open: (options) => openEspHomeClient({ ...options, transportFactory: () => transport }),
  });
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(attempt, { code: 'TIMEOUT' });
});

test('#506 a downgraded reconnect is final and cannot deliver telemetry', async () => {
  const mock = client(true);
  const states = [];
  const connection = [];
  const handle = await openDevice({ host: '127.0.0.1', port: 6053, key: KEY }, {
    open: async () => mock,
    onState: (state) => states.push(state),
    onConnection: (status) => connection.push(status),
  });
  await new Promise((resolve) => setImmediate(resolve));
  mock.emit('lifecycle', { kind: 'disconnect' });
  mock.emit('lifecycle', { kind: 'connect', encrypted: false });
  await new Promise((resolve) => setImmediate(resolve));
  mock.emit('telemetry', { entity: 'Heart Rate', key: 1, type: 'sensor', state: 90 });
  assert.equal(states.length, 0);
  assert.equal(connection.at(-1).error_code, 'NOT_ENCRYPTED');
  handle.close();
});
