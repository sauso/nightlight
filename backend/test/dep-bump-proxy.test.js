// X-Forwarded-For handling and the /hls proxy path, pinned across the proxy-addr 2.0.7 -> 2.0.8 bump
// (GHSA-jqcg-44mw-7w3h) and for any later move of http-proxy-middleware.
//
// The login limiter keys on `req.ip`, and Express derives `req.ip` from X-Forwarded-For through
// proxy-addr using the TRUST_PROXY value. So "who counts as a trusted proxy" decides which bucket a
// request lands in. Those rules had no test that went through real Express and a real socket.
//
// ★ THE req.ip TESTS MARKED ★ FAIL ON THE OLD PACKAGE: run against proxy-addr 2.0.7 (swapped into
// node_modules and re-run) they get the forged address back. The other req.ip tests pin behaviour that was
// already right and must stay right. (In the limiter block ★ marks the case that matters most, not a 2.0.7
// failure: both limiter tests pass on 2.0.7.)
//
// ⚠️ TWO PEER SHAPES, BECAUSE PRODUCTION SEES THE SECOND ONE. index.js calls `app.listen(PORT)` with no
// host, so Node listens on `::` (dual-stack) and an IPv4 client arrives as `::ffff:127.0.0.1`, not
// `127.0.0.1`. proxy-addr 2.0.8 handles that shape on its own code path (it turns the mapped address back
// into IPv4 before comparing). The first block binds 127.0.0.1, so its peer is plain IPv4; the dual-stack
// block listens the way index.js does. Found by review of PR #708: with the first block alone, deleting
// that conversion from proxy-addr, or the cross-family guard in its list-of-ranges matcher, still passed
// every test here.
//
// ⚠️ The /hls block is NOT index.js's /hls route. It mounts createProxyMiddleware with the target,
// changeOrigin and pathRewrite options index.js uses, plus the two header lines of its proxyRes hook,
// against a real local upstream. Not covered: the keepUnderPrefix(proxyRes, '/hls') call in that hook (so
// a redirect's Location is not checked), the requireAuthQueryOrHeader and demo-limiter middleware that
// run before the proxy, and the /live proxy. index.js cannot be imported (it spawns MediaMTX and FFmpeg),
// so this pins the library's behaviour at the installed version, not index.js's wiring.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { useTempDataDir, cleanupTempDataDirs, makeUser, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter, resetPasswordThrottles } = await import('../src/routes/auth.js');
const { applyTrustProxy } = await import('../src/lib/trustProxy.js');

const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
// As index.js does it: no host argument, so Node listens on `::` (dual-stack) wherever the OS allows.
const listenLikeIndex = (app) => new Promise((resolve, reject) => {
  const s = app.listen(0, () => resolve(s));
  s.on('error', reject);
});
const close = (s) => new Promise((r) => s.close(r));
// Always dialled through IPv4 127.0.0.1: on a dual-stack listener that is what makes the peer `::ffff:127.0.0.1`.
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const urlV6Of = (s) => `http://[::1]:${s.address().port}`;

// An app whose trust proxy comes from the REAL applyTrustProxy, so the env-value parsing is in play.
// The value it applied is kept on the server: see assertHonoured below for why the tests check it.
async function appWith(trustProxyEnv, mount, listenFn = listen) {
  const app = express();
  const applied = applyTrustProxy(app, trustProxyEnv);
  app.use(express.json());
  mount(app);
  const s = await listenFn(app);
  s.appliedTrustProxy = applied;
  return s;
}

const echoIp = (app) => app.get('/ip', (req, res) => res.json({ ip: req.ip }));
const ipSeenBy = async (server, xff, url = urlOf(server)) => (await call(`${url}/ip`, { headers: { 'x-forwarded-for': xff } })).body.ip;

// ⚠️ A TRUST_PROXY value that parseTrustProxy rejects falls back to 'loopback', which ALSO trusts the
// loopback peer these tests use, so a "trusted" result can pass for the wrong reason. Every string value
// in these tests is meant to be honoured exactly, so assert that it was (found by review of PR #708: a
// validator that rejected IPv4-mapped ranges left the mapped-range test green).
function assertHonoured(server, env) {
  if (typeof env !== 'string') return;
  // 'true'/'false' become booleans and a bare integer a hop count (trustProxy.js); everything else verbatim.
  const want = env === 'false' ? false : env === 'true' ? true : /^\d+$/.test(env) ? Number(env) : env;
  assert.equal(server.appliedTrustProxy, want, `TRUST_PROXY=${env} was not applied as given (fell back to the default?)`);
}

describe('req.ip under each TRUST_PROXY value (peer is always 127.0.0.1)', () => {
  const servers = [];
  after(async () => { for (const s of servers) await close(s); });
  const make = async (env) => {
    const s = await appWith(env, echoIp); servers.push(s);
    assertHonoured(s, env);
    return s;
  };

  test('unset: loopback is trusted, so the forwarded client address is used', async () => {
    assert.equal(await ipSeenBy(await make(undefined), '203.0.113.7'), '203.0.113.7');
  });

  test('a range that excludes the peer: X-Forwarded-For is ignored', async () => {
    assert.equal(await ipSeenBy(await make('10.0.0.0/8'), '203.0.113.7'), '127.0.0.1');
  });

  test('★ an IPv6 range that cannot contain an IPv4 peer does not trust it (GHSA-jqcg-44mw-7w3h)', async () => {
    // `::/1` spans only addresses whose first bit is 0 in IPv6 space, so it must not cover the IPv4
    // peer 127.0.0.1. proxy-addr 2.0.7 compared across families and trusted it, which let the client
    // pick its own req.ip. Fails (returns 203.0.113.7) on 2.0.7.
    assert.equal(await ipSeenBy(await make('::/1'), '203.0.113.7'), '127.0.0.1');
  });

  test('a mapped IPv4 range still trusts the matching IPv4 peer', async () => {
    // The fix must not over-correct: ::ffff:7f00:0/104 (hex form: parseTrustProxy's shape check rejects
    // the dotted form and falls back to loopback, which would make this pass for the wrong reason)
    // genuinely covers 127.0.0.1. The fallback is ruled out by checking the applied value, here and in
    // `make` (a validator that rejected mapped ranges passed this test before that check existed).
    const s = await make('::ffff:7f00:0/104');
    assert.equal(s.appliedTrustProxy, '::ffff:7f00:0/104');
    assert.equal(await ipSeenBy(s, '203.0.113.7'), '203.0.113.7');
  });

  test('TRUST_PROXY=false: the forwarded header never wins', async () => {
    assert.equal(await ipSeenBy(await make('false'), '203.0.113.7'), '127.0.0.1');
  });

  test('a hop count, true and the other named ranges give the same answer as before the bump', async () => {
    // The README says these are unchanged by proxy-addr 2.0.8; this passes on 2.0.7 too (checked by
    // swapping it in). 127.0.0.1 is one hop and `true` trusts everyone; linklocal/uniquelocal exclude it.
    const cases = [['1', '203.0.113.7'], ['true', '203.0.113.7'], ['linklocal', '127.0.0.1'], ['uniquelocal', '127.0.0.1']];
    for (const [env, want] of cases) {
      assert.equal(await ipSeenBy(await make(env), '203.0.113.7'), want, `TRUST_PROXY=${env}`);
    }
  });
});

describe('req.ip when listening like index.js (dual-stack: the IPv4 peer arrives as ::ffff:127.0.0.1)', () => {
  const MAPPED = '::ffff:127.0.0.1';
  const FORGED = '203.0.113.7';
  const NO_DUAL_STACK = 'no ::ffff: peer from a host-less listen on this machine (IPv6 or dual-stack sockets disabled)';
  const NO_V6_LOOPBACK = 'no IPv6 loopback (::1) reachable on a host-less listen on this machine';
  const servers = [];
  // Which peer shapes this machine produces, probed once with TRUST_PROXY=false (nothing is trusted, so
  // req.ip is the raw peer). With IPv6 disabled Node listens on IPv4 only, the peer is plain 127.0.0.1
  // and these tests would only repeat the block above, so they skip and say why rather than pass.
  let mappedPeer = false;
  let nativeV6Peer = false;
  before(async () => {
    const probe = await appWith('false', echoIp, listenLikeIndex);
    servers.push(probe);
    mappedPeer = (await ipSeenBy(probe, FORGED)) === MAPPED;
    try { nativeV6Peer = (await ipSeenBy(probe, FORGED, urlV6Of(probe))) === '::1'; } catch { nativeV6Peer = false; }
  });
  after(async () => { for (const s of servers) await close(s); });
  const make = async (env) => {
    const s = await appWith(env, echoIp, listenLikeIndex); servers.push(s);
    assertHonoured(s, env);
    return s;
  };

  test('control: the default (loopback) trusts the mapped peer, so the forwarded address is used', async (t) => {
    // Without this, a setup where the forwarded address could never reach req.ip would let every
    // "not trusted" test below pass for nothing.
    if (!mappedPeer) return t.skip(NO_DUAL_STACK);
    assert.equal(await ipSeenBy(await make(undefined), FORGED), FORGED);
  });

  test('★ ::/1 does not trust the mapped IPv4 peer (single range)', async (t) => {
    // Kills deleting proxy-addr's mapped-to-IPv4 conversion in its single-range matcher: the mapped
    // address then stays IPv6, sits inside ::/1, and is trusted. The 127.0.0.1-bound test cannot see that.
    if (!mappedPeer) return t.skip(NO_DUAL_STACK);
    assert.equal(await ipSeenBy(await make('::/1'), FORGED), MAPPED);
  });

  test('★ the list 10.0.0.0/8,::/1 does not trust the mapped IPv4 peer (list of ranges)', async (t) => {
    // A list goes through a different matcher from a single range. Kills deleting its cross-family guard
    // or its own mapped-to-IPv4 conversion; no test covered a list at all before this one.
    if (!mappedPeer) return t.skip(NO_DUAL_STACK);
    assert.equal(await ipSeenBy(await make('10.0.0.0/8,::/1'), FORGED), MAPPED);
  });

  test('an IPv4-mapped range of /96 or longer still trusts the mapped peer inside it', async (t) => {
    // The over-correction check, on the peer shape production sees. Also kills the conversion deletion
    // from the other side: without it the mapped peer no longer matches its own mapped range.
    if (!mappedPeer) return t.skip(NO_DUAL_STACK);
    assert.equal(await ipSeenBy(await make('::ffff:7f00:0/104'), FORGED), FORGED);
  });

  test('★ the /96 boundary the README states: ::ffff:0:0/96 trusts the mapped peer, ::ffff:0:0/95 does not', async (t) => {
    // /96 is where a mapped-form range stops covering only IPv4 space (proxy-addr 2.0.8's `>= 96`).
    // 2.0.7 trusted the peer under /95 as well.
    if (!mappedPeer) return t.skip(NO_DUAL_STACK);
    assert.equal(await ipSeenBy(await make('::ffff:0:0/96'), FORGED), FORGED);
    assert.equal(await ipSeenBy(await make('::ffff:0:0/95'), FORGED), MAPPED);
  });

  test('★ a mapped-form range shorter than /96 (::ffff:0:0/80) does not trust the native IPv6 peer ::1, alone or in a list', async (t) => {
    // 2.0.8 never matches a native IPv6 peer against a range written in IPv4-mapped form; ::1 sits inside
    // ::ffff:0:0/80 bit-for-bit and 2.0.7 trusted it. The README states this; this test pins it, through
    // both matchers (a single range and a list each carry their own copy of that guard).
    if (!nativeV6Peer) return t.skip(NO_V6_LOOPBACK);
    // Control on the same path: the default does trust ::1, so the forwarded address can get through.
    const control = await make(undefined);
    assert.equal(await ipSeenBy(control, FORGED, urlV6Of(control)), FORGED);
    for (const env of ['::ffff:0:0/80', '10.0.0.0/8,::ffff:0:0/80']) {
      const s = await make(env);
      assert.equal(await ipSeenBy(s, FORGED, urlV6Of(s)), '::1', `TRUST_PROXY=${env} trusted the native peer ::1`);
    }
  });
});

describe('the login limiter against forged X-Forwarded-For', () => {
  let untrusted;
  let trusted;
  before(async () => {
    db.prepare('DELETE FROM users').run();
    makeUser(db, { id: 'u-a', username: 'alice', role: 'admin', password: 'correct-horse' });
    const mount = (app) => app.use('/api/auth', authRouter);
    untrusted = await appWith('10.0.0.0/8', mount);
    trusted = await appWith(undefined, mount);
  });
  after(async () => { await close(untrusted); await close(trusted); });

  const attempt = (server, xff) => call(`${urlOf(server)}/api/auth/login`, {
    method: 'POST', body: { username: 'alice', password: 'wrong-password' }, headers: { 'x-forwarded-for': xff },
  });

  test('★ when the peer is not a trusted proxy, rotating the header does not buy fresh attempts', async () => {
    let last;
    for (let i = 0; i < 21; i++) last = await attempt(untrusted, `198.51.100.${i + 1}`);
    assert.equal(last.status, 429, 'rotating X-Forwarded-For evaded the per-account limit');
  });

  test('when the peer IS a trusted proxy, distinct forwarded clients get distinct buckets', async () => {
    // The #248 behaviour: one remote user failing must not lock out another behind the same proxy.
    // The per-ACCOUNT password throttle (#553) is address-blind by design and its store is module-level, so the failures
    // the case above spent on this account would add to this case's and reach its 30; it is emptied here so the
    // per-address buckets are what this case is about. The throttle itself is pinned in login-account-throttle.test.js.
    resetPasswordThrottles('u-a', 'alice');
    for (let i = 0; i < 21; i++) await attempt(trusted, '192.0.2.10');
    const other = await attempt(trusted, '192.0.2.11');
    assert.equal(other.status, 401, `expected a normal auth failure for a different client, got ${other.status}`);
  });
});

// index.js's proxy options for /hls (target, changeOrigin, pathRewrite, the two cache headers), not its
// whole route: keepUnderPrefix, the auth and demo-limiter middleware and /live are not covered (header).
describe('/hls proxy path (createProxyMiddleware with index.js\'s /hls options; not its keepUnderPrefix or auth)', () => {
  let upstream;
  let app;
  let lastUpstreamReq;
  before(async () => {
    upstream = await listen(express().use((req, res) => {
      lastUpstreamReq = { url: req.url, host: req.headers.host, xff: req.headers['x-forwarded-for'] };
      if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: '/cam/index.m3u8' }); return res.end(); }
      res.set({ 'content-type': 'application/vnd.apple.mpegurl', etag: '"abc"', 'cache-control': 'max-age=999' });
      res.end('#EXTM3U\n');
    }));
    const hls = express();
    hls.use('/hls', createProxyMiddleware({
      target: urlOf(upstream),
      changeOrigin: true,
      pathRewrite: { '^/hls': '' },
      on: {
        proxyRes(proxyRes) {
          proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate';
          delete proxyRes.headers['etag'];
        },
      },
    }));
    app = await listen(hls);
  });
  after(async () => { await close(app); await close(upstream); });

  const get = (path) => new Promise((resolve, reject) => {
    http.get(`${urlOf(app)}${path}`, { headers: { 'x-forwarded-for': '203.0.113.9' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });

  test('rewrites /hls away, relays the body, forces no-store and drops the etag', async () => {
    const r = await get('/hls/cam/index.m3u8?token=t');
    assert.equal(r.status, 200);
    assert.equal(r.body, '#EXTM3U\n');
    assert.equal(lastUpstreamReq.url, '/cam/index.m3u8?token=t');
    assert.equal(r.headers['cache-control'], 'no-store, no-cache, must-revalidate');
    assert.equal(r.headers.etag, undefined);
  });

  test('changeOrigin sets the upstream Host to the target', async () => {
    await get('/hls/cam/index.m3u8');
    assert.equal(lastUpstreamReq.host, new URL(urlOf(upstream)).host);
  });

  test('the client X-Forwarded-For reaches the upstream unchanged (pinned so a library change shows up)', async () => {
    // xfwd is not set, so nothing is appended. MediaMTX reads nothing from this header; pinned so an
    // upgrade that starts or stops adding it is a visible diff, not a surprise.
    await get('/hls/cam/index.m3u8');
    assert.equal(lastUpstreamReq.xff, '203.0.113.9');
  });

  test('a redirect from upstream is passed through, not followed', async () => {
    const r = await get('/hls/redirect');
    assert.equal(r.status, 302);
  });
});

after(() => { db.close(); cleanupTempDataDirs(); });
