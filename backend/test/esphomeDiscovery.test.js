import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverEsphomeDevices } from '../src/lib/esphomeDiscovery.js';

function network() {
  let callback, stopped = 0, destroyed = 0, type;
  const bonjour = { find(options, cb) { type = options.type; callback = cb; return { stop() { stopped++; } }; },
    destroy() { destroyed++; } };
  return { bonjour, emit: (record) => callback?.(record), get type() { return type; },
    get stopped() { return stopped; }, get destroyed() { return destroyed; } };
}
const scan = (net, options = {}) => discoverEsphomeDevices({ createBonjour: () => net.bonjour,
  timeoutMs: 5, ...options });

test('only ESPHome service records produce candidates; names and TXT are cleaned (#1071)', async () => {
  const net = network();
  const pending = scan(net);
  assert.equal(net.type, 'esphomelib');
  net.emit({ addresses: ['192.168.1.2'], name: 'living-room-sensor', port: 6053,
    txt: { friendly_name: ` Room\u202e\u200b\x00 ${'x'.repeat(100)}`, board: 'esp32', version: '2026.1' } });
  const result = await pending;
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].name, `Room ${'x'.repeat(55)}`);
  assert.equal(result.candidates[0].board, 'esp32');
  assert.equal(result.candidates[0].version, '2026.1');
  assert.equal(net.stopped, 1);
  assert.equal(net.destroyed, 1);
});

test('a fake that emits only Thingino records yields no ESPHome results (#1071)', async () => {
  const other = discoverEsphomeDevices({ createBonjour: () => ({
    find({ type }, cb) { if (type === 'thingino') cb({ addresses: ['192.168.1.3'] }); return { stop() {} }; },
    destroy() {},
  }), timeoutMs: 5 });
  assert.equal((await other).candidates.length, 0);
});

test('rejects non-literal LAN IPv4, caps results and keeps saved devices (#1071)', async () => {
  const net = network();
  const pending = scan(net, { existingHosts: new Set(['10.0.0.1:6054']) });
  net.emit({ addresses: ['8.8.8.8', 'fd00::1', '010.0.0.1', '10.0.0.1'], port: 6054, txt: {} });
  for (let i = 2; i <= 25; i++) net.emit({ addresses: [`10.0.0.${i}`], port: 6053, txt: {} });
  const result = await pending;
  assert.equal(result.dropped, 3);
  assert.equal(result.candidates.length, 20);
  assert.equal(result.candidates[0].alreadyAdded, true);
  assert.equal(result.candidates[0].name, 'ESPHome device at 10.0.0.1');
  assert.equal(result.candidates[0].port, 6054);
});

test('encryption requires a nonempty api_encryption value and saved address plus port (#1071)', async () => {
  const net = network();
  const pending = scan(net, { existingHosts: new Set(['10.0.0.1:6053']) });
  net.emit({ addresses: ['10.0.0.1'], port: 6054, txt: { api_encryption: '', api_encryption_supported: '1' } });
  net.emit({ addresses: ['10.0.0.2'], port: 6053, txt: { api_encryption_supported: '1' } });
  net.emit({ addresses: ['10.0.0.3'], port: 6053, txt: { api_encryption: '1' } });
  net.emit({ addresses: ['10.0.0.4'], host: 'living-room-sensor.local', port: 0,
    txt: { board: 'a'.repeat(10000), version: {}, friendly_name: {} } });
  net.emit({ addresses: ['10.0.0.1'], port: 6053, txt: {} });
  const { candidates } = await pending;
  assert.equal(candidates[0].alreadyAdded, true);
  assert.equal(candidates[0].encrypted, undefined);
  assert.equal(candidates[1].encrypted, undefined);
  assert.equal(candidates[2].encrypted, true);
  assert.equal(candidates[3].port, 6053);
  assert.equal(candidates[3].board, undefined);
  assert.equal(candidates[3].version, undefined);
  assert.equal(candidates[3].name, 'living-room-sensor.local');
});

test('abort and failure close an owned browser but preserve a shared Bonjour (#1071)', async () => {
  const owned = network();
  const controller = new AbortController();
  const pending = scan(owned, { signal: controller.signal, timeoutMs: 30000 });
  controller.abort();
  await pending;
  assert.equal(owned.stopped, 1);
  assert.equal(owned.destroyed, 1);
  const shared = network();
  await discoverEsphomeDevices({ createBonjour: () => { throw new Error('should reuse'); },
    reuseBonjour: shared.bonjour, timeoutMs: 5 });
  assert.equal(shared.stopped, 1);
  assert.equal(shared.destroyed, 0);
  const broken = network();
  const result = await discoverEsphomeDevices({ createBonjour: () => ({
    find() { throw new Error('failed'); }, destroy: broken.bonjour.destroy,
  }), timeoutMs: 5 });
  assert.deepEqual(result.sourceErrors, [{ source: 'mdns', code: 'DISCOVERY_FAILED' }]);
  assert.equal(broken.destroyed, 1);
});
