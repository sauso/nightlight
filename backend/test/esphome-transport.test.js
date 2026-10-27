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
      on: () => { subscribed = true; return () => {}; }, disconnect: () => { closed = true; } };
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
