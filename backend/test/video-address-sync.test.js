import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getTailnetAddress, setTailnetAddress, vettedTailnetIPv4 } from '../src/lib/tailnetAddress.js';
import { refreshTailnetAddress, videoAddressPending, createVideoAddressSync } from '../src/lib/videoAddressSync.js';
import { getAdvertisedHosts, getLastAdvertisedHosts, applyWebrtcHostsLive, resetMediaMTXHostsForTest } from '../src/lib/mediamtxProcess.js';

afterEach(() => { setTailnetAddress(null); resetMediaMTXHostsForTest(); });

test('#974 hostile tailnet addresses are rejected and status only clears on evidence', async () => {
  for (const value of ['100.63.1.2', '100.128.1.2', '100.100.100.100.5', ' 100.100.1.2',
    '100.064.1.2', 100100100100, 'fd7a::1']) assert.equal(vettedTailnetIPv4([value]), null);
  assert.equal(vettedTailnetIPv4(['fd7a::1', '100.64.0.1']), '100.64.0.1');
  let state = 'running'; let result = { ok: true, json: { BackendState: 'Running', Self: {
    TailscaleIPs: ['fd7a::1', '100.100.1.2'] } } };
  const refresh = () => refreshTailnetAddress({ status: () => ({ state }), cli: async (verb) => {
    assert.equal(verb, 'status-peerless'); return result;
  } });
  assert.equal(await refresh(), '100.100.1.2');
  result = { ok: false, code: 'invalid_status' }; assert.equal(await refresh(), '100.100.1.2');
  result = { ok: true, json: { BackendState: 'Starting' } }; assert.equal(await refresh(), '100.100.1.2');
  result = { ok: true, json: { BackendState: 'NeedsLogin' } }; assert.equal(await refresh(), null);
  setTailnetAddress('100.100.1.2'); state = 'off'; assert.equal(await refresh(), null);
  setTailnetAddress('100.100.1.2'); state = 'unavailable'; assert.equal(await refresh(), null);
});

test('#974 pending tracks the tailnet host only, not LAN order or removal', () => {
  assert.equal(videoAddressPending('100.64.1.1', ['192.168.1.2', '100.64.1.1']), false);
  assert.equal(videoAddressPending('100.64.1.1', ['100.64.1.1', '192.168.1.3']), false);
  assert.equal(videoAddressPending('100.64.1.1', ['192.168.1.3']), true);
  assert.equal(videoAddressPending(null, ['100.64.1.1']), false);
});

test('#974 advertised hosts preserve operator fallback and live PATCH updates state only on success', async () => {
  setTailnetAddress('100.64.1.2');
  assert.deepEqual(getAdvertisedHosts({ PUBLIC_HOST: 'public.example,100.64.1.2' }, () => ['192.168.1.2']),
    ['public.example', '192.168.1.2', '100.64.1.2']);
  assert.deepEqual(getAdvertisedHosts({ MTX_WEBRTCADDITIONALHOSTS: 'operator.example,100.64.1.2' }, () => []),
    ['operator.example', '100.64.1.2']);
  const env = { PUBLIC_HOST: 'public.example' };
  const requests = [];
  const fake = async (url, options) => { requests.push([url, options]); return { ok: true }; };
  assert.equal(await applyWebrtcHostsLive({ fetchImpl: fake, api: 'http://127.0.0.2:9997', env }), true);
  assert.equal(requests[0][0], 'http://127.0.0.2:9997/v3/config/global/patch');
  assert.equal(requests[0][1].method, 'PATCH');
  assert.deepEqual(JSON.parse(requests[0][1].body), { webrtcAdditionalHosts: getAdvertisedHosts(env) });
  const before = getLastAdvertisedHosts();
  setTailnetAddress('100.64.1.3');
  assert.equal(await applyWebrtcHostsLive({ fetchImpl: async () => ({ ok: false }), api: 'http://127.0.0.2:9997', env }), false);
  assert.deepEqual(getLastAdvertisedHosts(), before);
  assert.equal(await applyWebrtcHostsLive({ fetchImpl: fake, api: 'https://remote.example', env }), false);
  setTailnetAddress(null);
  assert.equal(await applyWebrtcHostsLive({ fetchImpl: fake, api: 'http://127.0.0.2:9997', env }), true);
  assert.equal(getLastAdvertisedHosts().includes('100.64.1.2'), false);
  assert.equal(JSON.parse(requests[1][1].body).webrtcAdditionalHosts.includes('100.64.1.2'), false);
  assert.equal(await applyWebrtcHostsLive({ fetchImpl: fake, api: 'http://127.0.0.2:9997', env: {}, detect: () => [] }), false);
  assert.equal(requests.length, 2);
});

test('#974 first address applies with viewers; later address waits, retries with a fake clock, and applies once', async () => {
  let address = '100.64.1.1'; let hosts = []; let time = 0; let viewers = 3; let fail = false;
  let attempts = 0; let counts = 0;
  const sync = createVideoAddressSync({ refresh: async () => {}, getAddress: () => address, getHosts: () => hosts,
    now: () => time, countViewers: async () => { counts++; if (viewers === -1) throw Error('unknown'); return viewers; },
    apply: async () => { attempts++; if (fail) return false; hosts = [address]; return true; } });
  assert.equal(await sync.tick(), true); assert.equal(counts, 0); assert.equal(attempts, 1);
  assert.equal(await sync.tick(), false); assert.equal(attempts, 1);
  address = '100.64.1.2'; assert.equal(await sync.tick(), false); assert.equal(attempts, 1);
  viewers = -1; assert.equal(await sync.tick(), false); assert.equal(attempts, 1);
  viewers = 0; fail = true; assert.equal(await sync.tick(), false); assert.equal(attempts, 2);
  time = 29_999; assert.equal(await sync.tick(), false); assert.equal(attempts, 2);
  time = 30_000; assert.equal(await sync.tick(), false); assert.equal(attempts, 3);
  time = 89_999; assert.equal(await sync.tick(), false); assert.equal(attempts, 3);
  time = 90_000; fail = false; assert.equal(await sync.tick(), true); assert.equal(attempts, 4);
  assert.equal(await sync.tick(), false); assert.equal(attempts, 4);
});

test('#974 the same address returning after a logout and a MediaMTX relaunch is applied again', async () => {
  let address = '100.64.1.1'; let hosts = []; let attempts = 0;
  const sync = createVideoAddressSync({ refresh: async () => {}, getAddress: () => address, getHosts: () => hosts,
    now: () => 0, countViewers: async () => 0, apply: async () => { attempts++; hosts = [address]; return true; } });
  assert.equal(await sync.tick(), true); assert.equal(attempts, 1);
  address = null; assert.equal(await sync.tick(), false); // logged out
  hosts = []; address = '100.64.1.1'; // a relaunch dropped it, then the same node signs in again
  assert.equal(await sync.tick(), true); assert.equal(attempts, 2);
});

test('#974 a failed first-address patch retries despite viewers', async () => {
  let time = 0; let attempts = 0;
  const sync = createVideoAddressSync({ refresh: async () => {}, getAddress: () => '100.64.1.1', getHosts: () => [],
    now: () => time, countViewers: async () => 4, apply: async () => { attempts++; return attempts === 2; } });
  assert.equal(await sync.tick(), false); assert.equal(attempts, 1);
  time = 30_000;
  assert.equal(await sync.tick(), true); assert.equal(attempts, 2);
});

test('#974 Apply now ignores viewers, removes a stale address, and a stopped slow tick never applies', async () => {
  let address = '100.64.1.1'; let hosts = ['old.example', '100.64.1.1']; let calls = 0;
  const sync = createVideoAddressSync({ getAddress: () => address, getHosts: () => hosts,
    countViewers: async () => 7, apply: async () => { calls++; hosts = address ? [address] : ['old.example']; return true; } });
  address = null;
  assert.equal(await sync.applyNow(), true); assert.deepEqual(hosts, ['old.example']); assert.equal(calls, 1);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const slow = createVideoAddressSync({ refresh: () => held, getAddress: () => '100.64.1.2',
    getHosts: () => [], apply: async () => { calls++; return true; } });
  const tick = slow.tick();
  assert.equal(await slow.tick(), false); // No overlapping refreshes.
  slow.stop(); release(); assert.equal(await tick, false); assert.equal(calls, 1);
});
