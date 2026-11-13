import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCameras, createScanManager } from '../src/lib/cameraDiscovery.js';

function bonjourFixture() {
  const callbacks = {};
  const stopped = [];
  let destroyed = 0;
  return { callbacks, stopped, get destroyed() { return destroyed; },
    find({ type }, callback) { callbacks[type] = callback; return { stop: () => stopped.push(type) }; },
    destroy() { destroyed++; } };
}

test('merges private candidates, sanitises LAN text, and keeps RTSP separate from web port', async () => {
  const bonjour = bonjourFixture();
  const updates = [];
  const resultPromise = discoverCameras({ createBonjour: () => bonjour, timeoutMs: 30,
    existingHosts: new Set(['192.168.1.9']), onCandidate: (item) => updates.push(item),
    wsProbe: async ({ onDevice }) => {
      onDevice({ probeMatches: { probeMatch: { XAddrs: 'http://192.168.1.2/onvif http://example.com/onvif http://8.8.8.8/onvif http://0xc0a80103/onvif' } } });
    } });
  bonjour.callbacks.rtsp({ addresses: ['192.168.1.2'], port: 8554 });
  bonjour.callbacks.thingino({ addresses: ['192.168.1.2', '8.8.8.8', '::1'], name: 'cam-a\u202e\u200b\n',
    port: 80, txt: { product: 'Thingino 1', streamer: '<script>' } });
  bonjour.callbacks.thingino({ addresses: ['192.168.1.9'], name: 'already-added' });
  const result = await resultPromise;
  // A saved camera is kept and marked (#950), not omitted: the screen shows it greyed as "Already added".
  assert.equal(result.candidates.length, 2);
  const saved = result.candidates.find((item) => item.ip === '192.168.1.9');
  assert.equal(saved.alreadyAdded, true);
  assert.equal(saved.name, 'already-added');
  assert.deepEqual(result.candidates[0].sources.sort(), ['mdns', 'onvif']);
  // The flag exists only on a saved camera: a camera that is not saved carries no alreadyAdded field at all.
  assert.equal('alreadyAdded' in result.candidates[0], false);
  assert.equal(updates.some((item) => item.ip === '192.168.1.9' && item.alreadyAdded === true), true);
  assert.equal(result.candidates[0].rtspPort, 8554);
  assert.equal(result.candidates[0].name, 'cam-a');
  assert.equal(result.candidates[0].product, 'Thingino 1');
  assert.equal(result.candidates[0].streamer, undefined);
  assert.ok(result.dropped >= 3);
  assert.equal(result.candidates.some((item) => item.ip === '192.168.1.3'), false);
  assert.equal(updates.length >= 2, true);
  assert.deepEqual(bonjour.stopped.sort(), ['rtsp', 'thingino']);
  assert.equal(bonjour.destroyed, 1);
});

test('one failing source keeps the other; long and empty names are bounded', async () => {
  const bonjour = bonjourFixture();
  const resultPromise = discoverCameras({ createBonjour: () => bonjour, timeoutMs: 20,
    wsProbe: async () => { throw new Error('unavailable'); } });
  bonjour.callbacks.thingino({ addresses: ['10.1.1.4'], name: 'x'.repeat(10000), port: 80 });
  bonjour.callbacks.thingino({ addresses: ['10.1.1.5'], name: '\u200b\u202e' });
  const result = await resultPromise;
  assert.equal(result.candidates[0].name.length, 60);
  assert.equal(result.candidates[0].rtspPort, 554);
  assert.equal(result.candidates[1].name, 'Camera at 10.1.1.5');
  assert.deepEqual(result.sourceErrors, [{ source: 'onvif', code: 'DISCOVERY_FAILED' }]);
});

test('abort stops both browsers and destroys an owned Bonjour instance', async () => {
  const bonjour = bonjourFixture();
  const controller = new AbortController();
  const pending = discoverCameras({ createBonjour: () => bonjour, signal: controller.signal,
    wsProbe: async () => {}, timeoutMs: 30000 });
  controller.abort();
  await pending;
  assert.deepEqual(bonjour.stopped.sort(), ['rtsp', 'thingino']);
  assert.equal(bonjour.destroyed, 1);
});

test('an existing announcer instance is browsed but never destroyed', async () => {
  const bonjour = bonjourFixture();
  const result = await discoverCameras({ createBonjour: () => { throw new Error('created another socket'); },
    reuseBonjour: bonjour, wsProbe: async () => {}, timeoutMs: 5 });
  assert.equal(result.sourceErrors.length, 0);
  assert.deepEqual(bonjour.stopped.sort(), ['rtsp', 'thingino']);
  assert.equal(bonjour.destroyed, 0);
});

test('hard timeout releases a hung injected ONVIF source and its browsers', async () => {
  const bonjour = bonjourFixture();
  const result = await discoverCameras({ createBonjour: () => bonjour,
    wsProbe: () => new Promise(() => {}), timeoutMs: 5 });
  assert.equal(result.candidates.length, 0);
  assert.equal(bonjour.destroyed, 1);
});

test('one browser stop throwing still closes the other browser and owned socket', async () => {
  const bonjour = bonjourFixture();
  const find = bonjour.find.bind(bonjour);
  bonjour.find = (options, callback) => {
    const browser = find(options, callback);
    return options.type === 'thingino' ? { stop: () => { throw new Error('stop failed'); } } : browser;
  };
  await discoverCameras({ createBonjour: () => bonjour, wsProbe: async () => {}, timeoutMs: 5 });
  assert.deepEqual(bonjour.stopped, ['rtsp']);
  assert.equal(bonjour.destroyed, 1);
});

test('a browse that throws still destroys the owned Bonjour and keeps the ONVIF results (#945 review)', async () => {
  const bonjour = bonjourFixture();
  bonjour.find = () => { throw new Error('socket already in use'); };
  const result = await discoverCameras({ createBonjour: () => bonjour, timeoutMs: 20,
    wsProbe: async ({ onDevice }) => { onDevice({ probeMatches: { probeMatch: { XAddrs: 'http://192.168.1.2/onvif' } } }); } });
  assert.equal(bonjour.destroyed, 1);
  assert.deepEqual(result.sourceErrors, [{ source: 'mdns', code: 'DISCOVERY_FAILED' }]);
  assert.deepEqual(result.candidates.map((item) => item.ip), ['192.168.1.2']);
});

test('first twenty candidates are kept, with no extra browser records promoted', async () => {
  const bonjour = bonjourFixture();
  const pending = discoverCameras({ createBonjour: () => bonjour, wsProbe: async () => {}, timeoutMs: 5 });
  for (let i = 1; i <= 25; i++) bonjour.callbacks.thingino({ addresses: [`10.0.0.${i}`], name: `cam-${i}` });
  const result = await pending;
  assert.equal(result.candidates.length, 20);
  assert.equal(result.candidates.at(-1).ip, '10.0.0.20');
});

test('a saved camera counts toward the twenty cap and a saved public address is still dropped (#950)', async () => {
  const bonjour = bonjourFixture();
  const pending = discoverCameras({ createBonjour: () => bonjour, wsProbe: async () => {}, timeoutMs: 5,
    existingHosts: new Set(['10.0.0.1', '10.0.0.2', '8.8.8.8']) });
  bonjour.callbacks.thingino({ addresses: ['8.8.8.8'], name: 'public' });
  for (let i = 1; i <= 25; i++) bonjour.callbacks.thingino({ addresses: [`10.0.0.${i}`], name: `cam-${i}` });
  const result = await pending;
  assert.equal(result.candidates.length, 20);
  assert.deepEqual(result.candidates.filter((item) => item.alreadyAdded).map((item) => item.ip), ['10.0.0.1', '10.0.0.2']);
  assert.equal(result.candidates.some((item) => item.ip === '8.8.8.8'), false);
});

test('mDNS failure does not discard ONVIF results', async () => {
  const result = await discoverCameras({ createBonjour: () => { throw new Error('bind failed'); },
    wsProbe: async ({ onDevice }) => onDevice({ probeMatches: { probeMatch: {
      XAddrs: 'http://172.16.1.4/onvif', endpointReference: { address: 'cam-a' },
    } } }), timeoutMs: 5 });
  assert.equal(result.candidates[0].ip, '172.16.1.4');
  assert.equal(result.candidates[0].name, 'Camera at 172.16.1.4');
  assert.deepEqual(result.candidates[0].sources, ['onvif']);
  assert.deepEqual(result.sourceErrors, [{ source: 'mdns', code: 'DISCOVERY_FAILED' }]);
});

test('scan manager reuses one active scan and clears its timer', async () => {
  let calls = 0, release;
  const timers = new Set();
  const manager = createScanManager({ discover: () => { calls++; return new Promise((resolve) => { release = resolve; }); },
    setTimer: (fn) => { timers.add(fn); return () => timers.delete(fn); } });
  const first = manager.start();
  const second = manager.start();
  assert.equal(second.scanId, first.scanId);
  assert.equal(second.reused, true);
  await Promise.resolve();
  assert.equal(calls, 1);
  release({ candidates: [], sourceErrors: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.get(first.scanId).done, true);
  assert.equal(timers.size, 0);
  assert.notEqual(manager.start().scanId, first.scanId);
  assert.equal(manager.get('missing'), null);
});

test('scan manager merges updates by id, so two services on one IP stay two entries (#1072)', async () => {
  let release;
  const manager = createScanManager({ discover: ({ onCandidate }) => {
    onCandidate({ id: 'a', ip: '10.0.0.9', port: 6053 });
    onCandidate({ id: 'b', ip: '10.0.0.9', port: 6054 });
    onCandidate({ id: 'a', ip: '10.0.0.9', port: 6053, name: 'updated' });
    onCandidate({ ip: '10.0.0.10' }); // no id: the IP is the key, as before
    onCandidate({ ip: '10.0.0.10', name: 'same host' });
    return new Promise((resolve) => { release = resolve; });
  } });
  const { scanId } = manager.start();
  await Promise.resolve();
  const { candidates } = manager.get(scanId);
  assert.equal(candidates.length, 3);
  assert.equal(candidates.find((c) => c.id === 'a').name, 'updated');
  assert.equal(candidates.find((c) => c.ip === '10.0.0.10').name, 'same host');
  release({ candidates, sourceErrors: [] });
  await new Promise((resolve) => setImmediate(resolve));
});

test('manager hard stop ends a hung scan and prunes expired results', async () => {
  let clock = 1000, fire;
  const manager = createScanManager({ now: () => clock, discover: () => new Promise(() => {}),
    setTimer: (fn) => { fire = fn; return () => { fire = null; }; } });
  const first = manager.start();
  clock += 30000;
  fire();
  assert.equal(manager.get(first.scanId).done, true);
  assert.equal(fire, null);
  const second = manager.start();
  assert.notEqual(second.scanId, first.scanId);
  clock += 300001;
  assert.equal(manager.get(first.scanId), null);
});

test('manager retains at most eight finished scans', async () => {
  let clock = 1000;
  const manager = createScanManager({ now: () => clock,
    discover: async () => ({ candidates: [], sourceErrors: [] }) });
  const ids = [];
  for (let i = 0; i < 9; i++) {
    ids.push(manager.start().scanId);
    await new Promise((resolve) => setImmediate(resolve));
    clock++;
  }
  assert.equal(manager.get(ids[0]), null);
  assert.equal(manager.get(ids[8]).done, true);
});
