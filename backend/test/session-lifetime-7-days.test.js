// How long a sign-in lasts, with SESSION_TTL_DAYS=7 (the shortest value offered). #562 bullet 7.
//
// WHY A FILE OF ITS OWN. The setting is read ONCE, when middleware/auth.js is imported, so a value other
// than the default needs a process that sets it BEFORE that import (the same top-level-await pattern as
// MEDIAMTX_API in webrtcSessions.test.js). No mock.module: middleware/auth.js is in the test:core list,
// and mocking a core module hides it from the coverage gate.
//
// WHY 7 AND NOT ANOTHER VALUE. The point of this file is to kill an implementation that still has 30
// written somewhere: every boundary here (7 days +/- 1 minute) is accepted at 30, so a path that ignores
// the setting fails. Each path is checked separately: the request check, the media token, the talk
// socket's verifyToken, push, the live-view sweep, the purge, the two session lists and the token minted
// at login. Fixture rules are the same as session-lifetime.test.js (fresh tokens, created_at aged,
// last_seen_at recent, +/- 1 minute, never to the second).
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

process.env.SESSION_TTL_DAYS = '7';
useTempDataDir();

// The logger is spied on BEFORE middleware/auth.js loads, so the start-up line it writes on import is seen.
const { logger } = await import('../src/lib/logger.js');
const info = mock.method(logger, 'info');
const warn = mock.method(logger, 'warn');

const { default: db } = await import('../src/db.js');
const {
  requireAuth, requireAuthQueryOrHeader, verifyToken, isLiveSessionId, purgeExpiredSessions, SESSION_TOKEN_TTL_DAYS,
} = await import('../src/middleware/auth.js');
const startupLines = info.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith('[auth]'));
const startupWarnings = warn.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.startsWith('[auth]'));
info.mock.restore();
warn.mock.restore();

const { default: authRouter } = await import('../src/routes/auth.js');
const { activePushTokens } = await import('../src/lib/push.js');
const { sessionsToKick } = await import('../src/lib/webrtcSessions.js');
const { Router } = await import('express');

let server;
let api;
let admin;
let carer;

before(async () => {
  const router = Router();
  router.get('/session', requireAuth, (req, res) => res.json({ sid: req.user.sid }));
  router.get('/media', requireAuthQueryOrHeader, (req, res) => res.json({ sid: req.user.sid }));
  server = await mountRouter('/t', router);
  api = await mountRouter('/api/auth', authRouter);
});

after(async () => {
  await server?.close();
  await api?.close();
  db.close();
  cleanupTempDataDirs();
  delete process.env.SESSION_TTL_DAYS;
});

beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin', password: 'hunter22-long' });
  carer = makeUser(db, { id: 'u-c', username: 'carer', role: 'caregiver' });
});

// created 7 days ago, nudged by +/- 1 minute; last_seen_at 10 minutes ago (recent: a last_seen_at reading
// would accept it).
function aged(userId, nudge) {
  const sid = makeSession(db, userId);
  db.prepare("UPDATE sessions SET created_at = datetime('now', '-7 days', ?), last_seen_at = datetime('now', '-10 minutes') WHERE id = ?")
    .run(nudge, sid);
  return sid;
}
const PAST = '-1 minute'; // 7 days + 1 minute old: past the lifetime
const INSIDE = '+1 minute'; // 7 days - 1 minute old: inside it
const sessionToken = (user, sid) => signToken({ id: user.id, username: user.username, role: user.role, sid });
const mediaToken = (user, sid) => signToken({ id: user.id, username: user.username, role: user.role, sid, purpose: 'media' }, { expiresIn: '12h' });
const addPush = (token, userId, sid) =>
  db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run(token, userId, sid, 'android');

describe('SESSION_TTL_DAYS=7 is read at start', () => {
  test('the lifetime in effect is 7 days', () => {
    assert.equal(SESSION_TOKEN_TTL_DAYS, 7);
  });

  test('start-up logged the value in effect, once, as info (it is not the default)', () => {
    assert.equal(startupLines.length, 1, `start-up lines: ${JSON.stringify(startupLines)}`);
    assert.match(startupLines[0], /sign-ins last 7 days/);
    assert.deepEqual(startupWarnings, [], 'a valid value must not be logged as a warning');
  });
});

describe('★ with SESSION_TTL_DAYS=7, a session ends at its 7th day on EVERY path (#562)', () => {
  test('★ requireAuth: 7 days + 1 minute is refused with an unexpired 30-day token; 7 days - 1 minute is accepted', async () => {
    const dead = await call(`${server.url}/t/session`, { token: sessionToken(admin, aged(admin.id, PAST)) });
    assert.equal(dead.status, 401, 'a session older than SESSION_TTL_DAYS still reached the API');
    const live = await call(`${server.url}/t/session`, { token: sessionToken(admin, aged(admin.id, INSIDE)) });
    assert.equal(live.status, 200, JSON.stringify(live.body));
  });

  test('★ requireAuthQueryOrHeader: a 12 h media token in ?token= ends with its 7-day session', async () => {
    const dead = await call(`${server.url}/t/media?token=${encodeURIComponent(mediaToken(admin, aged(admin.id, PAST)))}`);
    assert.equal(dead.status, 401);
    const live = await call(`${server.url}/t/media?token=${encodeURIComponent(mediaToken(admin, aged(admin.id, INSIDE)))}`);
    assert.equal(live.status, 200);
  });

  test('★ verifyToken (the talk socket): 7 days + 1 minute refused for both token kinds, 7 days - 1 minute accepted', () => {
    const dead = aged(admin.id, PAST);
    assert.equal(verifyToken(sessionToken(admin, dead)), null);
    assert.equal(verifyToken(mediaToken(admin, dead), { purpose: 'media' }), null);
    const live = aged(admin.id, INSIDE);
    assert.equal(verifyToken(sessionToken(admin, live))?.sid, live);
    assert.equal(verifyToken(mediaToken(admin, live), { purpose: 'media' })?.sid, live);
  });

  test('★ activePushTokens: a device whose session is 7 days + 1 minute old gets no push; 7 days - 1 minute does', () => {
    addPush('tok-dead', admin.id, aged(admin.id, PAST));
    addPush('tok-live', admin.id, aged(admin.id, INSIDE));
    assert.deepEqual(activePushTokens().map((r) => r.token), ['tok-live'], 'push still reaches a device the request check signs out');
  });

  test('★ the live-view sweep: isLiveSessionId makes sessionsToKick close a 7 days + 1 minute view and keep 7 days - 1 minute', () => {
    const dead = aged(admin.id, PAST);
    const live = aged(admin.id, INSIDE);
    assert.equal(isLiveSessionId(dead), false);
    assert.equal(isLiveSessionId(live), true);
    const owners = new Map([['mtx-dead', { sid: dead, recordedAt: 0 }], ['mtx-live', { sid: live, recordedAt: 0 }]]);
    const { toKick } = sessionsToKick([{ id: 'mtx-dead', path: 'cam_a' }, { id: 'mtx-live', path: 'cam_b' }], owners, isLiveSessionId, 1);
    assert.deepEqual(toKick, [{ id: 'mtx-dead', path: 'cam_a' }]);
  });

  test('★ purgeExpiredSessions deletes a 7 days + 1 minute session and its push token, keeps 7 days - 1 minute', () => {
    const dead = aged(admin.id, PAST);
    const live = aged(admin.id, INSIDE);
    addPush('tok-dead', admin.id, dead);
    addPush('tok-live', admin.id, live);
    assert.equal(purgeExpiredSessions(), 1);
    assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map((r) => r.id), [live]);
    assert.deepEqual(db.prepare('SELECT token FROM push_tokens').all().map((r) => r.token), ['tok-live']);
  });

  test('★ GET /sessions and /sessions/all list 7 days - 1 minute, not 7 days + 1 minute', async () => {
    const current = makeSession(db, admin.id);
    const dead = aged(admin.id, PAST);
    const inside = aged(admin.id, INSIDE);
    const carersDead = aged(carer.id, PAST);
    const token = sessionToken(admin, current);
    const own = await call(`${api.url}/api/auth/sessions`, { token });
    assert.deepEqual(own.body.map((s) => s.id).sort(), [current, inside].sort());
    const all = await call(`${api.url}/api/auth/sessions/all`, { token });
    const listed = all.body.map((s) => s.id);
    assert.deepEqual(listed.slice().sort(), [current, inside].sort());
    assert.ok(!listed.includes(dead) && !listed.includes(carersDead));
  });

  test('★ the token issued at login carries exp - iat = 7 days', async () => {
    const res = await call(`${api.url}/api/auth/login`, { method: 'POST', body: { username: 'admin', password: 'hunter22-long' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { exp, iat } = jwt.decode(res.body.token);
    assert.equal(exp - iat, 7 * 24 * 60 * 60);
  });
});
