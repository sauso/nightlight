// Auth middleware — the app's security boundary, so these are the highest-value tests in the suite.
//
// Two invariants matter more than the rest, because each was a deliberate fix and each is silent when
// broken (everything keeps working; the door is just unlocked):
//
//   1. A MEDIA token must never authenticate an API request. It's a video/image-only capability that
//      rides in URL query params, so if it could also read the API, one leaked HLS URL would be account
//      access.
//   2. A FULL SESSION token must never be accepted from a query string. Query strings leak into proxy
//      and CDN access logs, browser history and Referer headers. Only the short-lived media capability
//      may travel that way; a session token is header-only.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { requireAuth, requireAdmin, requireAuthQueryOrHeader, verifyToken } = await import('../src/middleware/auth.js');
const { Router } = await import('express');

let server;
let admin;
let caregiver;
let adminSid;
let caregiverSid;

before(async () => {
  const router = Router();
  router.get('/session', requireAuth, (req, res) => res.json({ user: req.user.username, role: req.user.role }));
  router.get('/admin-only', requireAuth, requireAdmin, (_req, res) => res.json({ ok: true }));
  router.get('/media', requireAuthQueryOrHeader, (req, res) => res.json({ user: req.user.username }));
  server = await mountRouter('/t', router);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  caregiver = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminSid = makeSession(db, admin.id);
  caregiverSid = makeSession(db, caregiver.id);
});

const sessionToken = (user, sid) => signToken({ id: user.id, username: user.username, role: user.role, sid });
const mediaToken = (user, sid) => signToken({ id: user.id, username: user.username, role: user.role, sid, purpose: 'media' });

// --- requireAuth: happy path ------------------------------------------------------------------

test('requireAuth accepts a valid session token and populates req.user', async () => {
  const r = await call(`${server.url}/t/session`, { token: sessionToken(admin, adminSid) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { user: 'admin', role: 'admin' });
});

// --- requireAuth: rejection paths -------------------------------------------------------------

test('requireAuth rejects a request with no Authorization header', async () => {
  const r = await call(`${server.url}/t/session`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Not authenticated');
});

test('requireAuth rejects a malformed Authorization header', async () => {
  // Not "Bearer <token>" — the header is present but unusable, which must read as unauthenticated.
  const r = await call(`${server.url}/t/session`, { headers: { authorization: 'Basic abc123' } });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Not authenticated');
});

test('requireAuth rejects a token signed with the wrong secret', async () => {
  const jwtLib = (await import('node:module')).createRequire(import.meta.url)('jsonwebtoken');
  const forged = jwtLib.sign({ id: admin.id, username: 'admin', role: 'admin', sid: adminSid }, 'not-the-real-secret');
  const r = await call(`${server.url}/t/session`, { token: forged });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid or expired session');
});

test('requireAuth rejects an expired token', async () => {
  const stale = signToken({ id: admin.id, username: 'admin', role: 'admin', sid: adminSid }, { expiresIn: '-1s' });
  const r = await call(`${server.url}/t/session`, { token: stale });
  assert.equal(r.status, 401);
});

test('requireAuth rejects a token whose session row is gone', async () => {
  // This is what makes "sign out this device" and "delete this caregiver" take effect on the NEXT
  // request rather than whenever the token happens to expire.
  const token = sessionToken(admin, adminSid);
  assert.equal((await call(`${server.url}/t/session`, { token })).status, 200);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(adminSid);
  const r = await call(`${server.url}/t/session`, { token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid or expired session');
});

test('requireAuth rejects a token carrying no session id at all', async () => {
  const r = await call(`${server.url}/t/session`, { token: signToken({ id: admin.id, username: 'admin', role: 'admin' }) });
  assert.equal(r.status, 401);
});

test('★ requireAuth rejects a MEDIA token — a leaked media URL must not become account access', async () => {
  const r = await call(`${server.url}/t/session`, { token: mediaToken(admin, adminSid) });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid or expired session');
});

// --- requireAdmin -----------------------------------------------------------------------------

test('requireAdmin allows an admin', async () => {
  const r = await call(`${server.url}/t/admin-only`, { token: sessionToken(admin, adminSid) });
  assert.equal(r.status, 200);
});

test('requireAdmin refuses a caregiver with 403, not 401', async () => {
  // 403 not 401: they ARE authenticated, they're just not allowed — the UI relies on the difference,
  // since a 401 redirects to the login screen.
  const r = await call(`${server.url}/t/admin-only`, { token: sessionToken(caregiver, caregiverSid) });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Admin access required');
});

// --- requireAuthQueryOrHeader -----------------------------------------------------------------

test('requireAuthQueryOrHeader accepts a full session token in the HEADER', async () => {
  const r = await call(`${server.url}/t/media`, { token: sessionToken(admin, adminSid) });
  assert.equal(r.status, 200);
  assert.equal(r.body.user, 'admin');
});

test('requireAuthQueryOrHeader accepts a MEDIA token in the query string', async () => {
  // The reason this middleware exists: Safari's native <video> fetches HLS segments itself and cannot
  // attach an Authorization header.
  const r = await call(`${server.url}/t/media?token=${encodeURIComponent(mediaToken(admin, adminSid))}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.user, 'admin');
});

test('★ requireAuthQueryOrHeader refuses a FULL session token in the query string', async () => {
  // Query strings end up in proxy logs, history and Referer headers. Only the media capability may
  // travel that way — this is the whole point of the header/query split.
  const r = await call(`${server.url}/t/media?token=${encodeURIComponent(sessionToken(admin, adminSid))}`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Invalid or expired session');
});

test('requireAuthQueryOrHeader rejects when no token is supplied anywhere', async () => {
  const r = await call(`${server.url}/t/media`);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'Not authenticated');
});

test('requireAuthQueryOrHeader rejects a media token whose session was revoked', async () => {
  const token = mediaToken(admin, adminSid);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(adminSid);
  const r = await call(`${server.url}/t/media?token=${encodeURIComponent(token)}`);
  assert.equal(r.status, 401);
});

test('requireAuthQueryOrHeader rejects garbage in the query string', async () => {
  const r = await call(`${server.url}/t/media?token=not-a-jwt`);
  assert.equal(r.status, 401);
});

// --- verifyToken (used by the WebSocket upgrade, which has no req/res) -------------------------

test('verifyToken returns the payload for a valid session token', () => {
  const payload = verifyToken(sessionToken(admin, adminSid));
  assert.equal(payload.username, 'admin');
  assert.equal(payload.sid, adminSid);
});

test('verifyToken returns null for null/empty input', () => {
  assert.equal(verifyToken(null), null);
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken(undefined), null);
});

test('verifyToken rejects a media token when no purpose is required', () => {
  // Same rule as requireAuth: without an explicit purpose, a media token is not a session token.
  assert.equal(verifyToken(mediaToken(admin, adminSid)), null);
});

test('verifyToken with purpose "media" accepts a media token and rejects a session one', () => {
  // The talk WebSocket demands a media-scoped capability specifically, because its token is in the URL.
  assert.ok(verifyToken(mediaToken(admin, adminSid), { purpose: 'media' }));
  assert.equal(verifyToken(sessionToken(admin, adminSid), { purpose: 'media' }), null);
});

test('verifyToken rejects a revoked session', () => {
  const token = sessionToken(admin, adminSid);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(adminSid);
  assert.equal(verifyToken(token), null);
});

test('verifyToken rejects a structurally invalid token without throwing', () => {
  assert.equal(verifyToken('....'), null);
  assert.equal(verifyToken('a.b.c'), null);
});

// --- session touch throttling -----------------------------------------------------------------

test('a successful request refreshes last_seen_at only once it is stale', () => {
  // Throttled to a write per 60s so a busy client doesn't write on every single request.
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now', '-10 minutes') WHERE id = ?").run(adminSid);
  const before = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(adminSid).last_seen_at;
  verifyToken(sessionToken(admin, adminSid));
  const after = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(adminSid).last_seen_at;
  assert.notEqual(after, before, 'a stale last_seen_at should be refreshed');

  verifyToken(sessionToken(admin, adminSid));
  const again = db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(adminSid).last_seen_at;
  assert.equal(again, after, 'a fresh last_seen_at should NOT be rewritten');
});
