import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { classifyClient } = await import('../src/lib/remoteAccess.js');
const { createRemoteAccessRouter } = await import('../src/routes/remoteAccess.js');
const { getAdvertisedHosts } = await import('../src/lib/mediamtxProcess.js');

const admin = makeUser(db, { id: 'remote-admin', username: 'remote-admin', role: 'admin' });
const caregiver = makeUser(db, { id: 'remote-caregiver', username: 'remote-caregiver', role: 'caregiver' });
const tokenFor = (user) => signToken({ id: user.id, username: user.username, role: user.role, sid: makeSession(db, user.id) });
const adminToken = tokenFor(admin);
const caregiverToken = tokenFor(caregiver);
after(() => { db.close(); cleanupTempDataDirs(); });

const cases = [
  ['127.0.0.1', 'home'], ['127.255.255.255', 'home'], ['::1', 'home'],
  ['10.0.0.0', 'home'], ['10.255.255.255', 'home'],
  ['172.15.255.255', 'remote'], ['172.16.0.0', 'home'], ['172.31.255.255', 'home'], ['172.32.0.0', 'remote'],
  ['192.168.0.0', 'home'], ['192.168.255.255', 'home'],
  ['169.254.0.1', 'home'], ['fe80::1', 'home'], ['fc00::1', 'home'], ['fd00::1', 'home'],
  ['::ffff:192.168.1.2', 'home'], ['::ffff:100.64.0.1', 'vpn'], ['::ffff:8.8.8.8', 'remote'],
  ['::ffff:7f00:1', 'home'], ['::ffff:c0a8:101', 'home'],
  ['::ffff:6440:1', 'vpn'], ['::ffff:643f:ffff', 'remote'], ['::ffff:808:808', 'remote'],
  ['100.63.255.255', 'remote'], ['100.64.0.0', 'vpn'], ['100.127.255.255', 'vpn'], ['100.128.0.0', 'remote'],
  ['8.8.8.8', 'remote'], ['2606:4700::1111', 'remote'], ['', 'unknown'], ['garbage', 'unknown'],
];
for (const [ip, expected] of cases) {
  test(`classify ${ip || '(empty)'} as ${expected}`, () => assert.equal(classifyClient({ ip }), expected));
}
test('an untrusted forwarded chain cannot identify the caller', () => {
  assert.equal(classifyClient({ ip: '192.168.1.10', forwardedHeaderPresent: true, trustedProxyChain: false }), 'unknown');
  assert.equal(classifyClient({ ip: '100.64.0.1', forwardedHeaderPresent: true, trustedProxyChain: true }), 'vpn');
});

async function withRoute(env, resolver, run, { timeoutMs = 3000, trustProxy = 'loopback' } = {}) {
  const router = createRemoteAccessRouter({ env, resolver, timeoutMs });
  const server = await mountRouter('/api/remote-access', router, {
    middleware: [(req, _res, next) => { req.app.set('trust proxy', trustProxy); next(); }],
  });
  try { await run(server.url); } finally { await server.close(); }
}
const request = (url, options = {}) => call(`${url}/api/remote-access`, { token: adminToken, ...options });
const resolverNever = () => { throw new Error('Unexpected DNS lookup'); };

test('HTTP auth gates and exact empty-configuration response shape', async () => {
  await withRoute({}, resolverNever, async (url) => {
    assert.equal((await call(`${url}/api/remote-access`)).status, 401);
    assert.equal((await request(url, { token: caregiverToken })).status, 403);
    const { status, body } = await request(url);
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['advertised_hosts', 'app_port', 'client', 'public_host_set', 'public_hosts', 'stun', 'trust_proxy', 'webrtc_udp_port']);
    assert.deepEqual(body, {
      app_port: 4000, webrtc_udp_port: 8189, public_host_set: false, public_hosts: [],
      advertised_hosts: getAdvertisedHosts({}),
      stun: { enabled: true, servers: ['stun:stun.l.google.com:19302'] },
      trust_proxy: 'loopback', client: { network: 'home' },
    });
  });
});

test('configured literals, DNS A and AAAA, errors, trimming and ports', async () => {
  const calls = [];
  const resolver = async (host, options) => {
    calls.push([host, options]);
    if (host === 'dual.example') return [{ address: '203.0.113.7' }, { address: '2001:db8::7' }];
    throw Object.assign(new Error('must not be returned'), { code: host === 'missing.example' ? 'ENOTFOUND' : host === 'nodata.example' ? 'ENODATA' : 'EAI_AGAIN' });
  };
  const env = { PUBLIC_HOST: ' 203.0.113.7, , 2001:db8::7, dual.example, missing.example, nodata.example, failed.example ', PORT: '5001', WEBRTC_UDP_PORT: '8190', STUN_SERVERS: ' ' };
  await withRoute(env, resolver, async (url) => {
    const { body } = await request(url);
    assert.equal(body.app_port, 5001);
    assert.equal(body.webrtc_udp_port, 8190);
    assert.equal(body.public_host_set, true);
    assert.deepEqual(body.public_hosts, [
      { host: '203.0.113.7', kind: 'ip', addresses: ['203.0.113.7'], error: null },
      { host: '2001:db8::7', kind: 'ip', addresses: ['2001:db8::7'], error: null },
      { host: 'dual.example', kind: 'name', addresses: ['203.0.113.7', '2001:db8::7'], error: null },
      { host: 'missing.example', kind: 'name', addresses: [], error: 'not_found' },
      { host: 'nodata.example', kind: 'name', addresses: [], error: 'not_found' },
      { host: 'failed.example', kind: 'name', addresses: [], error: 'failed' },
    ]);
    assert.deepEqual(calls, ['dual.example', 'missing.example', 'nodata.example', 'failed.example'].map((host) => [host, { all: true, family: 0 }]));
    assert.deepEqual(body.advertised_hosts, getAdvertisedHosts(env));
    assert.deepEqual(body.stun, { enabled: false, servers: [] });
  });
});

test('DNS timeout is bounded, and a list over ten is capped', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `host${i}.example`);
  const calls = [];
  await withRoute({ PUBLIC_HOST: names.join(',') }, (host) => { calls.push(host); return new Promise(() => {}); }, async (url) => {
    const { body } = await request(url);
    assert.equal(body.public_hosts.length, 10);
    assert.deepEqual(body.public_hosts.map((item) => item.host), names.slice(0, 10));
    assert.ok(body.public_hosts.every((item) => item.error === 'timeout' && item.addresses.length === 0));
    assert.deepEqual(calls, names.slice(0, 10));
  }, { timeoutMs: 15 });
});

test('MediaMTX UDP override takes precedence over WEBRTC_UDP_PORT', async () => {
  await withRoute({ WEBRTC_UDP_PORT: '8190', MTX_WEBRTCLOCALUDPADDRESS: ':8191', STUN_SERVERS: 'invalid' }, resolverNever, async (url) => {
    const { body } = await request(url);
    assert.equal(body.webrtc_udp_port, 8191);
    assert.deepEqual(body.stun, { enabled: false, servers: [] });
  });
});

test('query, body and unrelated secrets never become a lookup target or response field', async () => {
  const marker = 'REMOTE_LEAK_MARKER_7f2c';
  const previous = process.env.REMOTE_TEST_SECRET;
  process.env.REMOTE_TEST_SECRET = marker;
  db.prepare("UPDATE settings SET mqtt_password = ? WHERE id = 'app'").run(marker);
  const calls = [];
  try {
    await withRoute({ PUBLIC_HOST: 'configured.example' }, async (host) => { calls.push(host); return [{ address: '203.0.113.9' }]; }, async (url) => {
      const res = await call(`${url}/api/remote-access?host=evil.example&port=1&url=http://evil.example`, { token: adminToken });
      // fetch forbids GET bodies; use Node's HTTP client to prove the route ignores one.
      const queried = await new Promise((resolve, reject) => {
        const data = JSON.stringify({ host: 'body.evil.example', port: 1, url: 'http://evil.example' });
        const req = http.request(`${url}/api/remote-access`, {
          method: 'GET',
          headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
        }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
        });
        req.on('error', reject);
        req.end(data);
      });
      assert.equal(res.status, 200);
      assert.equal(queried.status, 200);
      assert.deepEqual(calls, ['configured.example', 'configured.example']);
      assert.ok(!JSON.stringify(res.body).includes(marker));
      assert.deepEqual(res.body.public_hosts[0].addresses, ['203.0.113.9']);
    });
  } finally {
    if (previous === undefined) delete process.env.REMOTE_TEST_SECRET;
    else process.env.REMOTE_TEST_SECRET = previous;
    db.prepare("UPDATE settings SET mqtt_password = NULL WHERE id = 'app'").run();
  }
});

test('Express proxy trust determines whether a forwarded address is usable', async () => {
  await withRoute({}, resolverNever, async (url) => {
    const { body } = await request(url, { headers: { 'x-forwarded-for': '192.168.1.50' } });
    assert.equal(body.client.network, 'unknown');
    assert.equal(body.trust_proxy, '10.0.0.0/8');
  }, { trustProxy: '10.0.0.0/8' });
  await withRoute({}, resolverNever, async (url) => {
    const { body } = await request(url, { headers: { 'x-forwarded-for': '100.64.0.1' } });
    assert.equal(body.client.network, 'vpn');
  });
});
