// X-Forwarded-For handling and the /hls proxy path, pinned across the proxy-addr 2.0.7 -> 2.0.8 bump
// (GHSA-jqcg-44mw-7w3h) and for any later move of http-proxy-middleware.
//
// The login limiter keys on `req.ip`, and Express derives `req.ip` from X-Forwarded-For through
// proxy-addr using the TRUST_PROXY value. So "who counts as a trusted proxy" decides which bucket a
// request lands in. Those rules had no test that went through real Express and a real socket.
//
// ★ ONLY THE `::/1` CASE FAILS ON THE OLD PACKAGE. Run against proxy-addr 2.0.7 it gets the forged
// address back (proven by swapping the lockfile in and re-running); the others pin behaviour that was
// already right and must stay right.
//
// ⚠️ The /hls block mounts the SAME options index.js passes to createProxyMiddleware, against a real
// local upstream. index.js cannot be imported (it spawns MediaMTX and FFmpeg), so the options are
// duplicated here: it pins the library's behaviour at the installed version, not index.js's wiring.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { useTempDataDir, cleanupTempDataDirs, makeUser, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { applyTrustProxy } = await import('../src/lib/trustProxy.js');

const listen = (app) => new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const close = (s) => new Promise((r) => s.close(r));
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;

// An app whose trust proxy comes from the REAL applyTrustProxy, so the env-value parsing is in play.
async function appWith(trustProxyEnv, mount) {
  const app = express();
  applyTrustProxy(app, trustProxyEnv);
  app.use(express.json());
  mount(app);
  return listen(app);
}

const echoIp = (app) => app.get('/ip', (req, res) => res.json({ ip: req.ip }));
const ipSeenBy = async (server, xff) => (await call(`${urlOf(server)}/ip`, { headers: { 'x-forwarded-for': xff } })).body.ip;

describe('req.ip under each TRUST_PROXY value (peer is always 127.0.0.1)', () => {
  const servers = [];
  after(async () => { for (const s of servers) await close(s); });
  const make = async (env) => { const s = await appWith(env, echoIp); servers.push(s); return s; };

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
    // genuinely covers 127.0.0.1.
    assert.equal(await ipSeenBy(await make('::ffff:7f00:0/104'), '203.0.113.7'), '203.0.113.7');
  });

  test('TRUST_PROXY=false: the forwarded header never wins', async () => {
    assert.equal(await ipSeenBy(await make('false'), '203.0.113.7'), '127.0.0.1');
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
    for (let i = 0; i < 21; i++) await attempt(trusted, '192.0.2.10');
    const other = await attempt(trusted, '192.0.2.11');
    assert.equal(other.status, 401, `expected a normal auth failure for a different client, got ${other.status}`);
  });
});

describe('/hls proxy path (same options as index.js)', () => {
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
