import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const manager = await import('../src/lib/esphomeManager.js');
const { openDevice } = await import('../src/lib/esphomeTransport.js');
const { logger } = await import('../src/lib/logger.js');
after(() => { manager.stopEsphomeSampler(); manager.stopEsphome(); db.close(); cleanupTempDataDirs(); });

const entity = (object_id, kind) => ({ object_id, kind, name: object_id, device_class: null,
  unit: null, state_class: null, entity_category: null, ignored: false });
const read = () => db.prepare('SELECT e.object_id, r.* FROM esphome_readings r JOIN esphome_entities e ON e.id = r.entity_id ORDER BY r.bucket, e.id').all();
const connected = { state: 'connected', encrypted: false, error_code: null, error: null };
const turn = () => new Promise((resolve) => setImmediate(resolve));
// One fresh, enabled device; every earlier device is disabled so refreshEsphome opens only this one.
const onlyDevice = (name) => {
  manager.stopEsphome();
  db.prepare('UPDATE esphome_devices SET enabled = 0').run();
  return Number(db.prepare("INSERT INTO esphome_devices (name, host) VALUES (?, '127.0.0.1')").run(name).lastInsertRowid);
};
const fakeOpen = (entities) => {
  const hooks = {};
  const open = async (_config, callbacks) => {
    Object.assign(hooks, callbacks);
    callbacks.onEntities(entities);
    callbacks.onConnection(connected);
    return { close() {} };
  };
  return { hooks, open };
};

test('#506 numeric buckets preserve missing updates and binary values only while connected', async () => {
  db.prepare("INSERT INTO esphome_devices (name, host, enabled) VALUES ('Neutral unit', '127.0.0.1', 1)").run();
  let now = 1000000 * 60000;
  let hooks;
  const open = async (_config, callbacks) => {
    hooks = callbacks;
    callbacks.onEntities([entity('rate', 'sensor'), entity('presence', 'binary_sensor')]);
    callbacks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() {} };
  };
  manager.refreshEsphome({ open, clock: () => now });
  await Promise.resolve();
  const event = (objectId, kind, value, missing = false) => hooks.onState({ objectId, kind, value, missing });
  event('rate', 'sensor', 0, true);
  event('rate', 'sensor', NaN);
  event('presence', 'binary_sensor', 1);
  now += 60000;
  event('rate', 'sensor', 10);
  assert.equal(read().length, 0, 'incoming updates must never write the database');
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().map((r) => [r.object_id, r.bucket, r.last, r.n, r.nmiss]), [
    ['rate', 1000000, null, 0, 2], ['presence', 1000000, 1, 1, 0],
  ]);

  event('rate', 'sensor', 20);
  event('rate', 'sensor', 15);
  now += 60000;
  manager.flushEsphomeMinute(now);
  const second = read().filter((r) => r.bucket === 1000001);
  assert.deepEqual(second.map((r) => [r.object_id, r.last, r.mean, r.min, r.max, r.n, r.nmiss]), [
    ['rate', 15, 15, 10, 20, 3, 0], ['presence', 1, 1, 1, 1, 0, 0],
  ]);
  manager.flushEsphomeMinute(now);
  assert.equal(read().length, 4, 'a duplicate tick must not duplicate a bucket');

  now += 60000;
  event('presence', 'binary_sensor', 0);
  assert.equal(read().filter((r) => r.bucket === 1000002).length, 0);
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === 1000002).map((r) => r.object_id), ['presence'],
    'silent numeric minutes are gaps');
  assert.equal(read().find((r) => r.bucket === 1000002).last, 1,
    'a new binary state cannot rewrite the preceding minute');

  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === 1000003).map((r) => [r.last, r.n]), [[0, 1]]);

  hooks.onConnection({ state: 'disconnected', encrypted: false, error_code: 'CLOSED', error: 'The device closed the connection.' });
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.equal(read().filter((r) => r.bucket === 1000004).length, 0, 'nothing carries across a drop');
});

test('#506 category guesses use class before entity name', () => {
  const guess = manager.guessEsphomeCategory;
  assert.equal(guess({ device_class: 'occupancy', name: 'heart rate' }), 'occupancy');
  assert.equal(guess({ name: 'Heart Rate' }), 'heart_rate');
  assert.equal(guess({ name: 'Respiratory Rate' }), 'respiratory_rate');
  assert.equal(guess({ name: 'Breath Rate' }), 'respiratory_rate');
  assert.equal(guess({ name: 'Target Number' }), 'target_number');
  assert.equal(guess({ device_class: 'illuminance' }), 'illuminance');
  assert.equal(guess({ device_class: 'distance' }), 'distance');
  assert.equal(guess({ name: 'Unknown sensor' }), null);
});

test('#506 retention removes old buckets and retired entities in bounded statements', async () => {
  const id = db.prepare('SELECT id FROM esphome_entities WHERE object_id = ?').get('rate').id;
  db.prepare('UPDATE esphome_entities SET active = 0 WHERE id = ?').run(id);
  db.prepare('INSERT INTO esphome_readings (entity_id, bucket, n) VALUES (?, ?, 1)')
    .run(id, 2000000 - 1441);
  db.prepare("UPDATE settings SET esphome_retention_days = 1 WHERE id = 'app'").run();
  await manager.pruneEsphome(2000000 * 60000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings WHERE entity_id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_entities WHERE id = ?').get(id).n, 0);
});

test('#506 initial transient failure retries; a wrong key stays final until config changes', async () => {
  const transientId = Number(db.prepare("INSERT INTO esphome_devices (name, host) VALUES ('Retry unit', '127.0.0.1')").run().lastInsertRowid);
  const permanentId = Number(db.prepare("INSERT INTO esphome_devices (name, host, encryption_key) VALUES ('Key unit', '127.0.0.1', 'saved')").run().lastInsertRowid);
  const calls = new Map();
  const open = async (config, hooks) => {
    const id = config.key ? permanentId : transientId;
    calls.set(id, (calls.get(id) || 0) + 1);
    if (id === permanentId) throw Object.assign(new Error('private device text'), { name: 'EncryptionKeyInvalidError' });
    if (calls.get(id) === 1) throw Object.assign(new Error('private device text'), { name: 'ConnectionRefusedError' });
    hooks.onEntities([]);
    hooks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() {} };
  };
  manager.refreshEsphome({ open, retryMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.get(transientId), 2);
  assert.equal(calls.get(permanentId), 1);
  const status = new Map(manager.esphomeStatus().map((s) => [s.id, s]));
  assert.equal(status.get(transientId).state, 'connected');
  assert.equal(status.get(permanentId).error_code, 'KEY_WRONG');
  db.prepare("UPDATE esphome_devices SET encryption_key = 'changed' WHERE id = ?").run(permanentId);
  manager.refreshEsphome({ open, retryMs: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.get(permanentId), 2, 'a changed key must reopen a final failure');
  const lines = JSON.stringify(logger.getRecent().filter((line) => String(line).includes('[esphome]')));
  assert.ok(!lines.includes('private device text') && !lines.includes('127.0.0.1') && !lines.includes('saved'));
  manager.stopEsphome();
});

test('#506 a child purge closes live entity IDs before another minute can write them', async () => {
  db.prepare('UPDATE esphome_devices SET enabled = 0').run();
  db.prepare("INSERT INTO children (id, name) VALUES ('child-live', 'Sample')").run();
  const deviceId = Number(db.prepare("INSERT INTO esphome_devices (name, host, child_id) VALUES ('Assigned unit', '127.0.0.1', 'child-live')").run().lastInsertRowid);
  let now = 3000000 * 60000;
  let oldClosed = false;
  let opens = 0;
  let hooks;
  const open = async (_config, callbacks) => {
    opens++;
    hooks = callbacks;
    callbacks.onEntities([entity('rate', 'sensor')]);
    callbacks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() { if (opens === 1) oldClosed = true; } };
  };
  manager.refreshEsphome({ open, clock: () => now });
  await new Promise((resolve) => setImmediate(resolve));
  const oldId = db.prepare('SELECT id FROM esphome_entities WHERE device_id = ?').get(deviceId).id;
  hooks.onState({ objectId: 'rate', kind: 'sensor', value: 9, missing: false });
  db.transaction(() => {
    db.prepare('DELETE FROM esphome_entities WHERE id = ?').run(oldId);
    db.prepare('UPDATE esphome_devices SET child_id = NULL WHERE id = ?').run(deviceId);
    db.prepare("DELETE FROM children WHERE id = 'child-live'").run();
  })();
  manager.reconcileEsphomeChildDeletion('child-live', { open, clock: () => now });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(oldClosed, true);
  assert.equal(opens, 2);
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings WHERE entity_id = ?').get(oldId).n, 0);
  assert.equal(db.prepare('SELECT child_id FROM esphome_devices WHERE id = ?').get(deviceId).child_id, null);
  manager.stopEsphome();
});

test('#506 discovery records at most 200 entities and logs the cap once', async () => {
  db.prepare('UPDATE esphome_devices SET enabled = 0').run();
  const deviceId = Number(db.prepare("INSERT INTO esphome_devices (name, host) VALUES ('Many entities', '127.0.0.1')").run().lastInsertRowid);
  let hooks;
  const open = async (_config, callbacks) => {
    hooks = callbacks;
    callbacks.onEntities(Array.from({ length: 205 }, (_, i) => entity(`sensor_${i}`, 'sensor')));
    callbacks.onConnection({ state: 'connected', encrypted: false, error_code: null, error: null });
    return { close() {} };
  };
  const before = logger.getRecent().filter((line) => line.includes(`device #${deviceId} entity limit reached`)).length;
  manager.refreshEsphome({ open });
  await new Promise((resolve) => setImmediate(resolve));
  hooks.onEntities(Array.from({ length: 205 }, (_, i) => entity(`sensor_${i}`, 'sensor')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_entities WHERE device_id = ? AND active = 1').get(deviceId).n, 200);
  assert.equal(logger.getRecent().filter((line) => line.includes(`device #${deviceId} entity limit reached`)).length - before, 1);
  manager.stopEsphome();
});

test('#506 a binary sensor keeps its missing count, with a carried value and without one', async () => {
  onlyDevice('Binary unit');
  let now = 4000000 * 60000;
  const { hooks, open } = fakeOpen([entity('door', 'binary_sensor'), entity('motion', 'binary_sensor')]);
  manager.refreshEsphome({ open, clock: () => now });
  await turn();
  hooks.onState({ objectId: 'door', kind: 'binary_sensor', value: 1, missing: false });
  now += 60000;
  manager.flushEsphomeMinute(now);
  hooks.onState({ objectId: 'door', kind: 'binary_sensor', missing: true });
  hooks.onState({ objectId: 'door', kind: 'binary_sensor', missing: true });
  hooks.onState({ objectId: 'motion', kind: 'binary_sensor', missing: true });
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === 4000001).map((r) => [r.object_id, r.last, r.n, r.nmiss]),
    [['door', 1, 0, 2], ['motion', null, 0, 1]]);
  manager.stopEsphome();
});

test('#506 a flush two or more minutes late leaves a gap; one boundary late writes the minute normally', async () => {
  onlyDevice('Stall unit');
  const B = 5000000;
  let now = B * 60000;
  const { hooks, open } = fakeOpen([entity('occupied', 'binary_sensor'), entity('level', 'sensor')]);
  manager.refreshEsphome({ open, clock: () => now });
  await turn();
  hooks.onState({ objectId: 'occupied', kind: 'binary_sensor', value: 1, missing: false });
  hooks.onState({ objectId: 'level', kind: 'sensor', value: 7, missing: false });
  // One boundary late, even at the very end of the next minute: the ended minute is written.
  now = (B + 1) * 60000 + 59000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === B).map((r) => [r.object_id, r.last, r.n]),
    [['occupied', 1, 1], ['level', 7, 1]]);
  // The next flush arrives three boundaries late (an event-loop stall). Nothing can vouch for those minutes.
  now = (B + 4) * 60000 + 5;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket > B && r.bucket < B + 4), [],
    'a stalled flush carried a binary value into minutes it cannot vouch for');
  // Collection resumes normally after the gap, carry included.
  hooks.onState({ objectId: 'level', kind: 'sensor', value: 9, missing: false });
  now = (B + 5) * 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === B + 4).map((r) => [r.object_id, r.last, r.n]),
    [['occupied', 1, 0], ['level', 9, 1]]);
  manager.stopEsphome();
});

test('#506 entities sharing an object_id are not merged: the first is stored and the log says so once', async () => {
  const deviceId = onlyDevice('Duplicate unit');
  let now = 6000000 * 60000;
  const handlers = new Set();
  // MockClient cannot hold two entities with one object_id (it keys them by type-objectId); the real registry can.
  // The lifecycle repeats discovery once, as a reconnect does, so the log must still appear only once.
  const client = {
    health: () => ({ encrypted: false }),
    entitiesByDevice: () => [{ key: 1, type: 'sensor', objectId: 'temp_1', name: 'Temp 1' },
      { key: 4, type: 'sensor', objectId: 'temp_1', name: 'Temp.1' }],
    snapshot: () => new Map(),
    on: (_event, handler) => { handlers.add(handler); return { [Symbol.dispose]: () => handlers.delete(handler) }; },
    lifecycle: () => (async function* () { yield { kind: 'connect', encrypted: false }; })(),
    disconnect() {},
  };
  const send = (event) => { for (const handler of [...handlers]) handler(event); };
  const lines = () => logger.getRecent().filter((line) => line.includes(`device #${deviceId} duplicate entity id ignored`)).length;
  const before = lines();
  manager.refreshEsphome({ open: (config, options) => openDevice(config, { ...options, open: async () => client }),
    clock: () => now });
  for (let i = 0; i < 5; i++) await turn();
  send({ entity: 'Temp 1', key: 1, type: 'sensor', state: 20 });
  send({ entity: 'Temp.1', key: 4, type: 'sensor', state: 30 });
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === 6000000).map((r) => [r.object_id, r.last, r.mean, r.n]),
    [['temp_1', 20, 20, 1]], 'two entities were averaged into one series');
  assert.equal(lines() - before, 1);
  manager.stopEsphome();
});

test('#506 two kinds sharing one key are both left out, and the log says so once', async () => {
  const deviceId = onlyDevice('Shared key unit');
  let now = 6500000 * 60000;
  const handlers = new Set();
  // The lifecycle repeats discovery once, as a reconnect does, so the line must still appear only once.
  const client = {
    health: () => ({ encrypted: false }),
    entitiesByDevice: () => [{ key: 7, type: 'binary_sensor', objectId: 'presence', name: 'Presence' },
      { key: 7, type: 'sensor', objectId: 'presence', name: 'Presence' },
      { key: 8, type: 'sensor', objectId: 'distance', name: 'Distance' }],
    snapshot: () => new Map(),
    on: (_event, handler) => { handlers.add(handler); return { [Symbol.dispose]: () => handlers.delete(handler) }; },
    lifecycle: () => (async function* () { yield { kind: 'connect', encrypted: false }; })(),
    disconnect() {},
  };
  const send = (event) => { for (const handler of [...handlers]) handler(event); };
  const count = (text) => logger.getRecent().filter((line) => line.includes(`device #${deviceId} ${text}`)).length;
  const before = { shared: count('entity id shared by two kinds, ignored'), duplicate: count('duplicate entity id ignored') };
  manager.refreshEsphome({ open: (config, options) => openDevice(config, { ...options, open: async () => client }),
    clock: () => now });
  for (let i = 0; i < 5; i++) await turn();
  assert.deepEqual(db.prepare('SELECT object_id FROM esphome_entities WHERE device_id = ? AND active = 1').all(deviceId)
    .map((e) => e.object_id), ['distance'], 'an entity whose key is shared by two kinds was recorded');
  send({ entity: 'Presence', key: 7, type: 'sensor' });
  send({ entity: 'Presence', key: 7, type: 'sensor', state: 1 });
  send({ entity: 'Distance', key: 8, type: 'sensor', state: 40 });
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === 6500000).map((r) => [r.object_id, r.last, r.n]), [['distance', 40, 1]]);
  assert.equal(count('entity id shared by two kinds, ignored') - before.shared, 1);
  assert.equal(count('duplicate entity id ignored') - before.duplicate, 0,
    'the line for a first-wins duplicate was logged, but neither entity here is recorded');
  manager.stopEsphome();
});

// Guard (passes on the old query too): the status query was rewritten for speed (#506 review, L7) and must still find the
// newest row across ALL of a device's entities, a retired one included, and report none for a device with no rows.
test('#506 status reports the newest row across a device\'s entities, and none for a device without rows', () => {
  const withRows = onlyDevice('Status unit');
  const empty = onlyDevice('Empty unit');
  const add = db.prepare("INSERT INTO esphome_entities (device_id, object_id, kind, active) VALUES (?, ?, 'sensor', ?)");
  const live = Number(add.run(withRows, 'now_rate', 1).lastInsertRowid);
  const retired = Number(add.run(withRows, 'old_rate', 0).lastInsertRowid);
  const reading = db.prepare('INSERT INTO esphome_readings (entity_id, bucket, n) VALUES (?, ?, 1)');
  reading.run(live, 7000000);
  reading.run(retired, 7000005);
  const status = new Map(manager.esphomeStatus().map((s) => [s.id, s]));
  assert.equal(status.get(withRows).last_row_at, new Date(7000005 * 60000).toISOString());
  assert.equal(status.get(empty).last_row_at, null);
});

test('#506 the minute tick re-aims at the next boundary, so a late tick does not drift and an error does not stop it', () => {
  const slack = manager.msToNextMinute(0) - 60000;
  assert.ok(slack >= 0 && slack < 1000, `the tick is aimed ${slack} ms after the boundary`);
  assert.equal(manager.msToNextMinute(8000000 * 60000 + 30), 60000 - 30 + slack);
  assert.equal(manager.msToNextMinute(8000000 * 60000 + 59999), 1 + slack);
  manager.stopEsphome();
  // Capture the timeouts the loop asks for instead of waiting real minutes. Small clock values keep the prune that start
  // runs from deleting anything.
  const clockAt = { now: 20 * 60000 + 59000, fail: false };
  const clock = () => {
    if (clockAt.fail) { clockAt.fail = false; throw new Error('planted clock failure'); }
    return clockAt.now;
  };
  const asked = [];
  const capture = (run) => {
    const real = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms) => { asked.push({ callback, ms }); return { unref() {} }; };
    try { run(); } finally { globalThis.setTimeout = real; }
  };
  capture(() => manager.startEsphomeSampler({ clock }));
  try {
    assert.deepEqual(asked.map((t) => t.ms), [1000 + slack]);
    // The tick runs 30 ms after its boundary. It must re-arm for the NEXT boundary, not for 60 s after itself, or the
    // lateness accumulates until one tick sees two ended minutes and the stall rule drops both.
    clockAt.now = 21 * 60000 + 30;
    capture(() => asked[0].callback());
    assert.equal(asked[1]?.ms, 60000 - 30 + slack);
    // A throw inside a tick is reported and the loop carries on.
    clockAt.now = 22 * 60000 + slack;
    clockAt.fail = true;
    capture(() => asked[1].callback());
    assert.equal(asked.length, 3, 'an error inside the tick stopped the minute loop');
  } finally {
    manager.stopEsphomeSampler();
  }
  // A tick already due when the sampler stopped does not re-arm.
  capture(() => asked[2].callback());
  assert.equal(asked.length, 3, 'the minute loop re-armed after stop');
});

// #506 review, round 2: on these sensors a heart rate or breathing rate of 0 means "no reading", and most of a night's
// updates can be zeros. They are counted in `nzero` and kept out of mean, min, max and n, so nothing is lost and the
// non-zero readings are not dragged down. A binary 0 ("off") is data and is unchanged.
const zeroRow = (r) => [r.object_id, r.last, r.mean, r.min, r.max, r.n, r.nzero, r.nmiss];
test('#506 numeric zeros are counted in nzero, apart from mean, min, max and n; last keeps them; a binary 0 is still data', async () => {
  onlyDevice('Zero unit');
  const B = 9000000;
  let now = B * 60000;
  const { hooks, open } = fakeOpen([entity('heart', 'sensor'), entity('blank', 'sensor'), entity('patchy', 'sensor'),
    entity('mixed', 'sensor'), entity('lux', 'sensor'), entity('occupied', 'binary_sensor')]);
  manager.refreshEsphome({ open, clock: () => now });
  await turn();
  const send = (objectId, kind, value) => hooks.onState({ objectId, kind, value, missing: false });
  const missing = (objectId) => hooks.onState({ objectId, kind: 'sensor', missing: true });
  // Four beats of 70 bpm and six "no reading" zeros, ending on a zero.
  for (const v of [70, 0, 0, 70, 0, 70, 0, 0, 70, 0]) send('heart', 'sensor', v);
  // Only zeros; then zeros with a missing update after them.
  send('blank', 'sensor', 0); send('blank', 'sensor', 0); send('blank', 'sensor', 0);
  send('patchy', 'sensor', 0); missing('patchy'); send('patchy', 'sensor', 0); missing('patchy');
  // Readings that end on a zero, and 0 lx in a dark room.
  send('mixed', 'sensor', 12); send('mixed', 'sensor', 0); send('mixed', 'sensor', 8); send('mixed', 'sensor', 0);
  send('lux', 'sensor', 0);
  // A binary sensor: on, off, off. The mean is the fraction of updates that were on.
  send('occupied', 'binary_sensor', 1); send('occupied', 'binary_sensor', 0); send('occupied', 'binary_sensor', 0);
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === B).map(zeroRow), [
    ['heart', 0, 70, 70, 70, 4, 6, 0],
    ['blank', 0, null, null, null, 0, 3, 0],
    ['patchy', 0, null, null, null, 0, 2, 2],
    ['mixed', 0, 10, 8, 12, 2, 2, 0],
    ['lux', 0, null, null, null, 0, 1, 0],
    ['occupied', 0, 1 / 3, 0, 1, 3, 0, 0],
  ]);
  // Nothing is lost: every reading is n + nzero, and the overall mean can be rebuilt (docs/esphome.md).
  const heart = read().find((r) => r.bucket === B && r.object_id === 'heart');
  assert.equal(heart.mean * heart.n / (heart.n + heart.nzero), 28);
  // The rules that did not change: a minute with only missing updates is a row with no value, and a silent one is a gap.
  missing('lux');
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === B + 1 && r.object_id !== 'occupied').map(zeroRow),
    [['lux', null, null, null, null, 0, 0, 1]]);
  manager.stopEsphome();
});

test('#506 zeros reach nzero end to end: an update with no state, through the real adapter, into the stored minute', async () => {
  onlyDevice('Rate unit');
  const B = 9100000;
  let now = B * 60000;
  const handlers = new Set();
  const client = {
    health: () => ({ encrypted: false }),
    entitiesByDevice: () => [{ key: 9, type: 'sensor', objectId: 'heart_rate', name: 'Heart rate' }],
    snapshot: () => new Map(),
    on: (_event, handler) => { handlers.add(handler); return { [Symbol.dispose]: () => handlers.delete(handler) }; },
    lifecycle: () => (async function* () {})(),
    disconnect() {},
  };
  manager.refreshEsphome({ open: (config, options) => openDevice(config, { ...options, open: async () => client }),
    clock: () => now });
  for (let i = 0; i < 5; i++) await turn();
  // The real shape of a zero: ESPHome leaves 0.0 off the wire and the library leaves `state` off the event.
  for (let i = 0; i < 10; i++) {
    const event = i < 4 ? { entity: 'Heart rate', key: 9, type: 'sensor', state: 70 } : { entity: 'Heart rate', key: 9, type: 'sensor' };
    for (const handler of [...handlers]) handler(event);
  }
  now += 60000;
  manager.flushEsphomeMinute(now);
  assert.deepEqual(read().filter((r) => r.bucket === B).map(zeroRow), [['heart_rate', 0, 70, 70, 70, 4, 6, 0]],
    'zeros were averaged into the heart rate (the first version stored mean 28, min 0, n 10)');
  manager.stopEsphome();
});
