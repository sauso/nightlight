// whepOnlyGuard is the fix for GHSA-3h8x-wr97-gv22: /live used to forward every method/sub-path to
// MediaMTX's WebRTC server verbatim, letting any signed-in caregiver send a WHIP publish request
// and hijack another camera's live feed. This guard is a strict ALLOWLIST — only the two exact
// request shapes the real frontend ever sends may pass.
//
// Mounting note: in production this guard lives INSIDE the /live-prefixed chain
// (app.use('/live', requireAuth, whepOnlyGuard, ...)), so Express strips the /live prefix before
// it ever runs — that's why its regexes are written against /<path>/whep, not /live/<path>/whep.
// Unlike demoGuard (mounted at the app root), this test mounts the guard INSIDE the router rather
// than via mountRouter's global `{ middleware }` option, so it experiences the same prefix-
// stripping it gets in production. Using the global option here would test the guard against an
// unstripped path it would never actually see, silently validating nothing real.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mountRouter, call } from './helpers/harness.js';

const { whepOnlyGuard } = await import('../src/middleware/whepOnlyGuard.js');
const { Router } = await import('express');

let server;
let hits;

before(async () => {
  const router = Router();
  router.use(whepOnlyGuard);
  // Stands in for createProxyMiddleware, which is not route-shape-aware — it forwards literally
  // anything that gets past the guard. A real route table here would test Express's own routing,
  // not the guard.
  router.all(/.*/, (_req, res) => {
    hits.downstream = (hits.downstream || 0) + 1;
    res.json({ hit: 'downstream' });
  });
  server = await mountRouter('/live', router);
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  hits = {};
});

describe('whepOnlyGuard — the two real shapes pass through', () => {
  test('POST /live/<path>/whep starts a viewing session', async () => {
    const res = await call(`${server.url}/live/cam_x/whep`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.downstream, 1);
  });

  test('DELETE /live/<path>/whep/<sessionId> ends one', async () => {
    const res = await call(`${server.url}/live/cam_x/whep/sess-123`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(hits.downstream, 1);
  });

  test('the sub-stream path (-sub suffix) is a real value the camera-path segment takes', async () => {
    const res = await call(`${server.url}/live/cam_x-sub/whep`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.downstream, 1);
  });
});

describe('whepOnlyGuard — WHIP is rejected (the actual vulnerability)', () => {
  test('POST .../whip is blocked, never reaches the downstream proxy', async () => {
    const res = await call(`${server.url}/live/cam_x/whip`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(hits.downstream, undefined);
  });

  test('DELETE .../whip/<id> is blocked too', async () => {
    const res = await call(`${server.url}/live/cam_x/whip/sess-123`, { method: 'DELETE' });
    assert.equal(res.status, 403);
    assert.equal(hits.downstream, undefined);
  });
});

describe('whepOnlyGuard — the critical case: PATCH shares DELETE\'s exact path shape', () => {
  test('PATCH /live/<path>/whep/<sessionId> is blocked by method alone', async () => {
    // PATCH and DELETE hit the identical path shape in MediaMTX's own routing (trickle-ICE vs.
    // session cleanup) — path pattern alone cannot tell them apart. This is the one case a
    // pattern-only implementation (checking shape without method) would silently get wrong.
    const res = await call(`${server.url}/live/cam_x/whep/sess-123`, { method: 'PATCH' });
    assert.equal(res.status, 403);
    assert.equal(hits.downstream, undefined);
  });
});

describe('whepOnlyGuard — other methods against real-shaped paths are rejected', () => {
  const methods = ['GET', 'HEAD', 'PUT', 'PATCH'];
  for (const method of methods) {
    test(`${method} /live/cam_x/whep is blocked`, async () => {
      const res = await call(`${server.url}/live/cam_x/whep`, { method });
      assert.equal(res.status, 403);
      assert.equal(hits.downstream, undefined);
    });
  }
});

describe('whepOnlyGuard — shape violations are rejected', () => {
  test('missing camera-path segment', async () => {
    const res = await call(`${server.url}/live/whep`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  test('extra segment before whep', async () => {
    const res = await call(`${server.url}/live/cam_x/extra/whep`, { method: 'POST' });
    assert.equal(res.status, 403);
  });

  test('DELETE on the 2-segment shape (missing session id) is blocked', async () => {
    const res = await call(`${server.url}/live/cam_x/whep`, { method: 'DELETE' });
    assert.equal(res.status, 403);
  });

  test('extra segment after the session id is blocked', async () => {
    const res = await call(`${server.url}/live/cam_x/whep/sess-1/extra`, { method: 'DELETE' });
    assert.equal(res.status, 403);
  });

  test('POST on the 3-segment shape is blocked (wrong method for that shape)', async () => {
    const res = await call(`${server.url}/live/cam_x/whep/sess-123`, { method: 'POST' });
    assert.equal(res.status, 403);
  });
});

describe('whepOnlyGuard — bypass attempts (regression coverage from demoMode.js\'s real bug)', () => {
  test('an internal double slash in a benign position still normalizes and passes', async () => {
    const res = await call(`${server.url}/live/cam_x//whep`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.downstream, 1);
  });

  test('a double slash cannot smuggle a WHIP path past the guard', async () => {
    const res = await call(`${server.url}/live//cam_x/whip`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(hits.downstream, undefined);
  });

  test('case-insensitivity matches Express\'s own default routing', async () => {
    const res = await call(`${server.url}/live/CAM_X/WHEP`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.downstream, 1);
  });

  test('a percent-encoded slash inside the camera-path segment is rejected', async () => {
    // Regression test for the deliberately tightened CAMERA_PATH charset ([a-z0-9_-]+, not a
    // generic [^/]+): Express's path parsing does not decode %2F, but a downstream Go HTTP server
    // (MediaMTX) likely does before its own routing runs — a decode-boundary mismatch between the
    // two layers this guard sits between. With the old permissive charset this would have passed
    // (no literal '/' in the segment); the tightened charset correctly rejects it since '%' isn't
    // in the allowed set.
    const res = await call(`${server.url}/live/cam_x%2Fwhip/whep`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(hits.downstream, undefined);
  });
});

describe('whepOnlyGuard — query strings cannot bypass or falsely trigger the guard', () => {
  test('an allowed request with a query string still passes', async () => {
    const res = await call(`${server.url}/live/cam_x/whep?foo=bar`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(hits.downstream, 1);
  });

  test('a WHIP request with a query string is still blocked', async () => {
    const res = await call(`${server.url}/live/cam_x/whip?foo=bar`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(hits.downstream, undefined);
  });
});
