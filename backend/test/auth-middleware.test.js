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
import { test, describe, before, after, beforeEach } from 'node:test';
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

// -------------------------------------------------------------------------------------------
// Authorisation is evaluated NOW, not when the token was minted — issue #261.
//
// The defect: requireAdmin authorised from the `role` claim inside the JWT. Changing a user's role
// wrote to `users` and did nothing to their existing tokens, so a demoted admin kept every admin
// capability until the token expired — up to 30 DAYS. That window includes the routes that set roles,
// so the demoted user could promote themselves back and make the demotion permanent-proof.
//
// Demotion is a security action — a departing carer, an account being locked down. The UI confirmed it
// and nothing said it would not apply for a month.
describe('a role change takes effect on the very next request (#261)', () => {
  const demote = (id) => db.prepare("UPDATE users SET role = 'caregiver' WHERE id = ?").run(id);
  const promote = (id) => db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);

  test('★ a demoted admin loses admin routes immediately, holding the SAME token', async () => {
    const token = sessionToken(admin, adminSid);
    assert.equal((await call(`${server.url}/t/admin-only`, { token })).status, 200, 'precondition: the admin can reach it');

    demote(admin.id);

    const after = await call(`${server.url}/t/admin-only`, { token });
    assert.equal(after.status, 403, 'a demoted admin still reached an admin-only route with their old token');
  });

  test('...and the token still authenticates — demotion is not a logout', async () => {
    // The distinction matters: a demoted user should keep working as a caregiver, not be kicked out
    // mid-feed. Asserting only the 403 above would pass for an implementation that simply killed the
    // session, which is a different behaviour with a different cost.
    const token = sessionToken(admin, adminSid);
    demote(admin.id);
    const res = await call(`${server.url}/t/session`, { token });
    assert.equal(res.status, 200, 'demotion logged the user out instead of reducing their role');
    assert.equal(res.body.role, 'caregiver', 'the response still reported the stale role from the token');
  });

  test('★ a promoted caregiver does NOT stay locked out by a stale token', async () => {
    // The mirror. Same lookup, but the failure would be a privilege ESCALATION rather than a lingering
    // one, so it is asserted separately rather than assumed to follow.
    const token = sessionToken(caregiver, caregiverSid);
    assert.equal((await call(`${server.url}/t/admin-only`, { token })).status, 403);
    promote(caregiver.id);
    assert.equal(
      (await call(`${server.url}/t/admin-only`, { token })).status,
      200,
      'a promotion did not take effect either — the role is not being read live'
    );
  });

  test('a FORGED admin claim is ignored — the database decides', async () => {
    // The strongest form: a caregiver's session with `role: 'admin'` written into the token. Signed
    // with the real secret, so it is a perfectly valid token; only the claim is a lie.
    const forged = signToken({ id: caregiver.id, username: caregiver.username, role: 'admin', sid: caregiverSid });
    const res = await call(`${server.url}/t/admin-only`, { token: forged });
    assert.equal(res.status, 403, 'a role claim in the token was trusted over the user row');
  });

  test('deleting the user invalidates the token immediately', async () => {
    // ⚠️ THIS PASSES BECAUSE OF THE FOREIGN KEY, NOT BECAUSE OF THE JOIN, and an earlier comment here
    // claimed the opposite. `sessions.user_id` is `ON DELETE CASCADE` with `foreign_keys = ON`
    // (db.js), so deleting the user deletes the session and the lookup finds nothing either way.
    // Mutation testing proved it: swapping JOIN for LEFT JOIN — which would let a userless session
    // through with a null role — does not fail this test, because the session no longer exists to be
    // let through. Kept as a real guarantee about deletion; just do not read it as covering the JOIN.
    const token = sessionToken(admin, adminSid);
    db.prepare('DELETE FROM users WHERE id = ?').run(admin.id);
    assert.equal((await call(`${server.url}/t/session`, { token })).status, 401);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(adminSid).n,
      0,
      'the cascade did not fire — this test would then be resting on the JOIN after all, so re-check it'
    );
  });

  test('verifyToken reports the live role too, not the claim', async () => {
    // The WebSocket handshake does not go through requireAuth, so it needs its own assertion —
    // otherwise talk-back authorisation could keep trusting a stale claim after the HTTP path stopped.
    const token = sessionToken(admin, adminSid);
    demote(admin.id);
    assert.equal(verifyToken(token)?.role, 'caregiver', 'verifyToken returned the stale role from the token');
  });
});
