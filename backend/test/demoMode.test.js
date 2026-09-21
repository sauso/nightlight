// demoGuard is the only thing standing between "read-only public demo" and "public admin access
// to a real running app" once the demo account is admin (see planning/ROADMAP.md and
// middleware/demoMode.js's own comments for the full context). Two invariants matter more than
// the rest, both found only by adversarial design review, not by the original design:
//
//   1. GET is not automatically safe. GET /children/:id/sleep/:date?store=1 performs a real
//      database write (computeAndStoreNight) — the server side of the admin "Recompute this
//      night" feature. A test suite that only tried mutating verbs would never have caught this.
//   2. The mutation allowlist must be EXACT-ROUTE, not a /api/auth prefix allow — that prefix
//      also covers password change, MFA enrolment and user CRUD, all of which must stay blocked
//      even though the demo account is admin and could otherwise reach every one of them.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountRouter, call } from './helpers/harness.js';

const { demoGuard, isDemoModeActive } = await import('../src/middleware/demoMode.js');
const { Router } = await import('express');

let server;
let hits;

before(async () => {
  const router = Router();
  const record = (name) => (_req, res) => {
    hits[name] = (hits[name] || 0) + 1;
    res.json({ hit: name });
  };

  router.post('/api/auth/login', record('login'));
  router.post('/api/auth/login/mfa', record('login-mfa'));
  router.post('/api/auth/logout', record('logout'));
  router.post('/api/auth/media-token', record('media-token'));
  router.post('/api/auth/setup', record('setup')); // real route, same prefix, NOT allowlisted
  router.put('/api/auth/me/password', record('change-password'));
  router.delete('/api/cameras/cam-1', record('delete-cam'));
  router.put('/api/settings', record('put-settings'));
  router.get('/api/diagnostics', record('diagnostics'));
  router.get('/api/logs', record('logs'));
  router.delete('/api/logs', record('delete-logs'));
  router.get('/api/auth/sessions', record('sessions'));
  router.get('/api/auth/sessions/all', record('sessions-all'));
  router.get('/api/children/:id/sleep/:date', (req, res) => {
    // Mirrors the real route's shape closely enough to test the guard: only reports a "store"
    // hit when the query flag the real handler treats as a write is present.
    if (req.query.store === '1') hits.store = (hits.store || 0) + 1;
    else if (req.query.stored === '1') hits.stored = (hits.stored || 0) + 1;
    else hits['sleep-read'] = (hits['sleep-read'] || 0) + 1;
    res.json({ ok: true });
  });
  router.get('/api/cameras', record('list-cameras'));
  router.get('/api/health', record('health'));

  // Mounted at '/' with demoGuard as global middleware, matching index.js's real registration
  // order (after express.json(), before every router) rather than nesting demoGuard inside a
  // sub-router, which would rebase req.path and defeat the exact-path assertions below.
  server = await mountRouter('/', router, { middleware: [demoGuard] });
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  hits = {};
  delete process.env.DEMO_MODE;
});

describe('isDemoModeActive', () => {
  test('is true only for the exact string "true"', () => {
    process.env.DEMO_MODE = 'true';
    assert.equal(isDemoModeActive(), true);
  });

  test('is false when unset, "false", "1", or differently cased', () => {
    delete process.env.DEMO_MODE;
    assert.equal(isDemoModeActive(), false);
    for (const v of ['false', '1', 'TRUE', 'yes']) {
      process.env.DEMO_MODE = v;
      assert.equal(isDemoModeActive(), false);
    }
  });
});

describe('demoGuard — DEMO_MODE off is a true no-op', () => {
  test('unset: a normally-blocked mutation reaches its real handler', async () => {
    const res = await call(`${server.url}/api/cameras/cam-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(hits['delete-cam'], 1);
  });

  test('explicit "false" (not just absent) also reaches the real handler', async () => {
    process.env.DEMO_MODE = 'false';
    const res = await call(`${server.url}/api/cameras/cam-1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(hits['delete-cam'], 1);
  });

  test('unset: the blocked-when-active GETs reach their real handlers', async () => {
    const res = await call(`${server.url}/api/diagnostics`);
    assert.equal(res.status, 200);
    assert.equal(hits.diagnostics, 1);
  });
});

describe('demoGuard — DEMO_MODE=true, mutation allowlist', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  test('POST /api/auth/login passes through', async () => {
    const res = await call(`${server.url}/api/auth/login`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.login, 1);
  });

  test('POST /api/auth/login/mfa passes through', async () => {
    const res = await call(`${server.url}/api/auth/login/mfa`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits['login-mfa'], 1);
  });

  test('POST /api/auth/logout passes through', async () => {
    const res = await call(`${server.url}/api/auth/logout`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.logout, 1);
  });

  test('POST /api/auth/media-token passes through (found missing in design review)', async () => {
    const res = await call(`${server.url}/api/auth/media-token`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits['media-token'], 1);
  });

  test('POST /api/auth/setup — same prefix, NOT allowlisted — is blocked, handler never invoked', async () => {
    const res = await call(`${server.url}/api/auth/setup`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /read-only public demo/);
    assert.equal(hits.setup, undefined);
  });

  test('PUT /api/auth/me/password is blocked despite admin role having access in real life', async () => {
    const res = await call(`${server.url}/api/auth/me/password`, { method: 'PUT' });
    assert.equal(res.status, 403);
    assert.equal(hits['change-password'], undefined);
  });

  test('a generic DELETE elsewhere in the app is blocked, handler never invoked', async () => {
    const res = await call(`${server.url}/api/cameras/cam-1`, { method: 'DELETE' });
    assert.equal(res.status, 403);
    assert.equal(hits['delete-cam'], undefined);
  });

  test('a generic PUT elsewhere in the app is blocked, handler never invoked', async () => {
    const res = await call(`${server.url}/api/settings`, { method: 'PUT' });
    assert.equal(res.status, 403);
    assert.equal(hits['put-settings'], undefined);
  });

  test('a mutation to a path with no route registered anywhere gets 403, not 404', async () => {
    const res = await call(`${server.url}/api/totally-made-up`, { method: 'POST' });
    assert.equal(res.status, 403);
  });
});

describe('demoGuard — DEMO_MODE=true, the one GET that mutates', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  test('GET .../sleep/:date?store=1 is blocked, handler never records a store hit', async () => {
    const res = await call(`${server.url}/api/children/c1/sleep/2026-01-01?store=1`);
    assert.equal(res.status, 403);
    assert.equal(hits.store, undefined);
  });

  test('the same path WITHOUT ?store=1 passes through normally', async () => {
    const res = await call(`${server.url}/api/children/c1/sleep/2026-01-01`);
    assert.equal(res.status, 200);
    assert.equal(hits['sleep-read'], 1);
  });

  test('the read-only sibling ?stored=1 passes through normally', async () => {
    const res = await call(`${server.url}/api/children/c1/sleep/2026-01-01?stored=1`);
    assert.equal(res.status, 200);
    assert.equal(hits.stored, 1);
  });

  // Regression test for a real bug found by adversarial review: an earlier normalize() only
  // stripped a TRAILING slash, so an INTERNAL double slash reached the real handler (Express
  // collapses it when routing) while failing to match this regex (which never saw it collapsed) —
  // reproduced against a real router/DB and confirmed a night could actually be written this way.
  test('an internal double slash cannot bypass the block (regression)', async () => {
    const res = await call(`${server.url}/api/children//c1/sleep/2026-01-01?store=1`);
    assert.equal(res.status, 403);
    assert.equal(hits.store, undefined);
  });

  test('HEAD to the same store=1 path is blocked too, not just GET', async () => {
    const res = await call(`${server.url}/api/children/c1/sleep/2026-01-01?store=1`, { method: 'HEAD' });
    assert.equal(res.status, 403);
    assert.equal(hits.store, undefined);
  });

  // Discriminates RECOMPUTE_STORE_PATH's [^/]+ from a looser .+ — an extra unexpected segment
  // between "children" and "sleep" must NOT match (no route exists there either, so this should
  // 404 via Express's own routing, never a demoGuard 403 — proving the regex didn't over-match it).
  test('an extra path segment does not falsely match the recompute-write pattern', async () => {
    const res = await call(`${server.url}/api/children/c1/extra/sleep/2026-01-01?store=1`);
    assert.equal(res.status, 404);
  });
});

describe('demoGuard — DEMO_MODE=true, blocked GETs (server internals / cross-visitor data)', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  test('GET /api/diagnostics is blocked, handler never invoked', async () => {
    const res = await call(`${server.url}/api/diagnostics`);
    assert.equal(res.status, 403);
    assert.equal(hits.diagnostics, undefined);
  });

  test('GET /api/logs is blocked, handler never invoked', async () => {
    const res = await call(`${server.url}/api/logs`);
    assert.equal(res.status, 403);
    assert.equal(hits.logs, undefined);
  });

  test('DELETE /api/logs is separately blocked via the generic mutation rule', async () => {
    const res = await call(`${server.url}/api/logs`, { method: 'DELETE' });
    assert.equal(res.status, 403);
    assert.equal(hits['delete-logs'], undefined);
  });

  test('GET /api/auth/sessions is blocked — one shared login must not leak cross-visitor data', async () => {
    const res = await call(`${server.url}/api/auth/sessions`);
    assert.equal(res.status, 403);
    assert.equal(hits.sessions, undefined);
  });

  // Regression test — see the matching one in the "one GET that mutates" block above for the full
  // story: an earlier normalize() only stripped a TRAILING slash, so this internal double slash
  // reached the real handler while failing to match GET_BLOCKLIST.
  test('an internal double slash cannot bypass the sessions block (regression)', async () => {
    const res = await call(`${server.url}/api/auth//sessions`);
    assert.equal(res.status, 403);
    assert.equal(hits.sessions, undefined);
  });

  test('GET /api/auth/sessions/all is blocked', async () => {
    const res = await call(`${server.url}/api/auth/sessions/all`);
    assert.equal(res.status, 403);
    assert.equal(hits['sessions-all'], undefined);
  });

  test('HEAD /api/diagnostics is blocked too, not just GET', async () => {
    const res = await call(`${server.url}/api/diagnostics`, { method: 'HEAD' });
    assert.equal(res.status, 403);
    assert.equal(hits.diagnostics, undefined);
  });
});

describe('demoGuard — DEMO_MODE=true, ordinary reads pass through', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  test('an unrelated GET passes through', async () => {
    const res = await call(`${server.url}/api/cameras`);
    assert.equal(res.status, 200);
    assert.equal(hits['list-cameras'], 1);
  });

  test('GET /api/health passes through', async () => {
    const res = await call(`${server.url}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(hits.health, 1);
  });
});

describe('demoGuard — DEMO_MODE=true, query strings cannot bypass or falsely trigger the guard', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  test('an allowlisted POST with an extra query string still passes (req.path, not req.originalUrl)', async () => {
    const res = await call(`${server.url}/api/auth/login?foo=bar`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.login, 1);
  });

  test('a blocked GET with a query string appended is still blocked, not bypassed', async () => {
    const res = await call(`${server.url}/api/diagnostics?x=1`);
    assert.equal(res.status, 403);
    assert.equal(hits.diagnostics, undefined);
  });
});

describe('demoGuard — DEMO_MODE=true, trailing slash / case / double-slash cannot bypass a blocked GET', () => {
  beforeEach(() => { process.env.DEMO_MODE = 'true'; });

  const variants = ['/api/diagnostics/', '/api/diagnostics//', '/API/DIAGNOSTICS', '/Api/Diagnostics'];
  for (const variant of variants) {
    test(`${variant} is still blocked`, async () => {
      const res = await call(`${server.url}${variant}`);
      assert.equal(res.status, 403);
      assert.equal(hits.diagnostics, undefined);
    });
  }
});
