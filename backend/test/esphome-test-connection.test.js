import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { testEsphomeDevice } = await import('../src/lib/esphomeManager.js');
const { openDevice } = await import('../src/lib/esphomeTransport.js');
after(() => { db.close(); cleanupTempDataDirs(); });
const KEY = Buffer.alloc(32, 5).toString('base64');

test('#506 connection test fails closed for an absent encryption flag and stores no readings', async () => {
  let closed = false;
  let subscribed = false;
  const fake = { health: () => ({}), entitiesByDevice: () => [],
    on: () => { subscribed = true; return () => {}; }, disconnect: () => { closed = true; } };
  const result = await testEsphomeDevice({ host: '127.0.0.1', port: 6053, key: KEY },
    { open: (config, options) => openDevice(config, { ...options, open: async () => fake }) });
  assert.deepEqual(result, { ok: false, error_code: 'NOT_ENCRYPTED', error: 'The device did not encrypt the connection.' });
  assert.equal(closed, true);
  assert.equal(subscribed, false);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings').get().n, 0);
});

test('#506 one connection test at a time and abort closes an ignored open attempt', async () => {
  const abort = new AbortController();
  const first = testEsphomeDevice({ host: '127.0.0.1', port: 6053 },
    { signal: abort.signal, open: (config, options) => openDevice(config, { ...options, open: () => new Promise(() => {}) }) });
  const second = await testEsphomeDevice({ host: '127.0.0.1', port: 6053 });
  assert.deepEqual(second, { busy: true });
  abort.abort();
  assert.equal((await first).error_code, 'TIMEOUT');
});
