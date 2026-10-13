// How long a sign-in lasts, at the DEFAULT (SESSION_TTL_DAYS unset = 30 days). #562 bullet 7.
//
// THE DEFECT. Before #562, a request was bounded only by its token's own `exp`: middleware/auth.js
// checked that the session ROW existed, not how old it was. Push (lib/push.js) and the WebRTC live-view
// sweep (index.js) did check age, each with its own copy of the query. So:
//   * a 12-hour media token minted on day 30 kept HLS, snapshots, clips and talk working for up to 12
//     hours after the session token itself had expired, while the WebRTC view of the same camera had
//     already been closed by the sweep;
//   * a lifetime setting implemented as "change the token's expiresIn" would have left every session
//     older than the new value with working API access (it holds a 30-day token) and dead push and
//     live views: a half-signed-in state.
// Now one condition (sessionAgeCondition) is used by every path, and this file proves each path uses it.
//
// ⚠️ THE FIXTURE IS HOSTILE TO THE OBVIOUS WRONG IMPLEMENTATIONS:
//   * every aged session holds a FRESH token (signed now, 30-day `exp`), so only the row's age can refuse
//     it: an implementation trusting `exp` passes the "accepted" controls and fails the "refused" cases;
//   * sessions are aged with `UPDATE sessions SET created_at`, and last_seen_at is kept RECENT (10 minutes
//     ago), so an implementation that reads last_seen_at instead of created_at accepts what must be refused;
//   * the boundary cases sit at N days +/- 1 MINUTE, not to the second: created_at is whole seconds written
//     before sign() stamps `iat`, so a session may legitimately end up to 1 s before its token's `exp`.
// SQLite's clock is real (fake timers would not move datetime('now')), which is why ages are written into
// the row rather than time being advanced.
//
// A NON-default value needs its own process, because the setting is read once at import: see
// session-lifetime-7-days.test.js, which is what kills a mutant that hard-codes 30 anywhere.
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';
import { stripCommentsAndStrings } from './helpers/sourceScan.js';

// Unset on purpose: this file is the default. A value leaking in from the shell running the suite would
// make every assertion below about 30 days wrong for a reason that has nothing to do with the code.
delete process.env.SESSION_TTL_DAYS;
useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  parseSessionTtlDays, reportSessionTtl, sessionAgeCondition, isLiveSessionId, purgeExpiredSessions,
  requireAuth, requireAuthQueryOrHeader, verifyToken, SESSION_TOKEN_TTL_DAYS,
  DEFAULT_SESSION_TTL_DAYS, MIN_SESSION_TTL_DAYS, MAX_SESSION_TTL_DAYS,
} = await import('../src/middleware/auth.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { activePushTokens } = await import('../src/lib/push.js');
const { sessionsToKick } = await import('../src/lib/webrtcSessions.js');
const { Router } = await import('express');

const DAY = 24 * 60 * 60;

// ---------------------------------------------------------------------------------------------------
describe('parseSessionTtlDays: the setting\'s parse table (#562)', () => {
  const ok = (raw, days) => assert.deepEqual(parseSessionTtlDays(raw), { days, warning: null }, `${JSON.stringify(raw)}`);
  const refused = (raw) => {
    const r = parseSessionTtlDays(raw);
    assert.equal(r.days, 30, `${JSON.stringify(raw)} must fall back to the default, 30`);
    assert.ok(r.warning, `${JSON.stringify(raw)} fell back silently: an operator's typo must be visible in the log`);
    assert.ok(r.warning.includes(JSON.stringify(raw)), `the warning does not name the value: ${r.warning}`);
    assert.match(r.warning, /from 7 to 30/);
    assert.match(r.warning, /using the default, 30/);
  };

  test('unset and blank mean the default, 30, with no warning', () => {
    ok(undefined, 30);
    ok('', 30);
    ok('   ', 30);
  });

  test('the two ends of the range are accepted: 7 and 30, and a value between', () => {
    ok('7', 7);
    ok('30', 30);
    ok('14', 14);
  });

  test('surrounding spaces are trimmed, and leading zeros are plain decimal digits (" 7 " and "007" are 7)', () => {
    ok(' 7 ', 7);
    ok('007', 7);
  });

  test('★ out of range falls back to 30 with a warning: 6, 31, 0, 1, 365', () => {
    for (const raw of ['6', '31', '0', '1', '365']) refused(raw);
  });

  test('★ anything that is not digits only falls back to 30 with a warning, including what Number() would read', () => {
    // 1e1 and 0x1e are the reason for the digits-only check: Number() reads them as 10 and 30, so a
    // Number()-based parse would quietly accept an exponent or a hex spelling as a lifetime.
    for (const raw of ['3.5', 'abc', '7d', '1e1', '0x1e', '-7', '+7', '7 days', '7,5']) refused(raw);
  });

  test('the range constants are the documented ones', () => {
    // Pinned, because the README, .env.example, docker-compose.yml and the Unraid template all state them.
    assert.deepEqual([MIN_SESSION_TTL_DAYS, MAX_SESSION_TTL_DAYS, DEFAULT_SESSION_TTL_DAYS], [7, 30, 30]);
  });
});

describe('reportSessionTtl: what start-up logs', () => {
  const fakeLog = () => ({ info: mock.fn(), warn: mock.fn() });

  test('the default logs nothing', () => {
    const log = fakeLog();
    reportSessionTtl({ days: 30, warning: null }, log);
    assert.equal(log.info.mock.callCount() + log.warn.mock.callCount(), 0);
  });

  test('a value in effect that is not the default is logged once, as info, with its number', () => {
    const log = fakeLog();
    reportSessionTtl({ days: 7, warning: null }, log);
    assert.equal(log.info.mock.callCount(), 1);
    assert.match(log.info.mock.calls[0].arguments[0], /sign-ins last 7 days/);
    assert.equal(log.warn.mock.callCount(), 0);
  });

  test('a bad value is one warning (not an info line) carrying the parse message', () => {
    const log = fakeLog();
    reportSessionTtl(parseSessionTtlDays('1e1'), log);
    assert.equal(log.warn.mock.callCount(), 1);
    assert.match(log.warn.mock.calls[0].arguments[0], /^\[auth\] SESSION_TTL_DAYS="1e1"/);
    assert.equal(log.info.mock.callCount(), 0);
  });

  test('in this process the setting is unset, so the lifetime is the default, 30', () => {
    assert.equal(SESSION_TOKEN_TTL_DAYS, 30);
  });
});

describe('sessionAgeCondition: the one definition', () => {
  test('reads created_at against the lifetime, qualified by an alias when given', () => {
    assert.deepEqual(sessionAgeCondition(), { sql: "created_at > datetime('now', ?)", params: ['-30 days'] });
    assert.deepEqual(sessionAgeCondition('s'), { sql: "s.created_at > datetime('now', ?)", params: ['-30 days'] });
  });

  test('an alias that is not a plain identifier throws instead of building SQL', () => {
    for (const alias of ['s; DROP TABLE sessions', 's.x', '1s', 's ']) {
      assert.throws(() => sessionAgeCondition(alias), /bad alias/, `${JSON.stringify(alias)} was accepted`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The paths. One router mounts the middleware the app uses; the real auth router serves login and the lists.
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
});

beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin', password: 'hunter22-long' });
  carer = makeUser(db, { id: 'u-c', username: 'carer', role: 'caregiver' });
});

// Ages a session: created `days` days ago, nudged by `nudge` ('+1 minute' / '-1 minute'), with last_seen_at
// 10 minutes ago: RECENT against any lifetime (so reading last_seen_at would accept it) and STALE against the
// 60-second touch throttle (so a request that reached touchSession WOULD rewrite it).
function aged(userId, days, nudge = '+0 minutes') {
  const sid = makeSession(db, userId);
  db.prepare("UPDATE sessions SET created_at = datetime('now', ?, ?), last_seen_at = datetime('now', '-10 minutes') WHERE id = ?")
    .run(`-${days} days`, nudge, sid);
  return sid;
}
const sessionToken = (user, sid) => signToken({ id: user.id, username: user.username, role: user.role, sid });
// A fresh 12-hour media token, exactly what POST /media-token issues: unexpired for the whole test.
const mediaToken = (user, sid) => signToken({ id: user.id, username: user.username, role: user.role, sid, purpose: 'media' }, { expiresIn: '12h' });
const lastSeen = (sid) => db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(sid).last_seen_at;
const addPush = (token, userId, sid) =>
  db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run(token, userId, sid, 'android');

describe('★ at the default, a session ends at its 30th day on EVERY path (#562)', () => {
  test('★ requireAuth refuses a session 30 days + 1 minute old, even with an unexpired token', async () => {
    const sid = aged(admin.id, 30, '-1 minute');
    const r = await call(`${server.url}/t/session`, { token: sessionToken(admin, sid) });
    assert.equal(r.status, 401, 'a session past its lifetime still reached the API');
    assert.equal(r.body.error, 'Invalid or expired session');
  });

  test('requireAuth accepts one 29 days old, and one 30 days - 1 minute old (the controls)', async () => {
    for (const sid of [aged(admin.id, 29), aged(admin.id, 30, '+1 minute')]) {
      const r = await call(`${server.url}/t/session`, { token: sessionToken(admin, sid) });
      assert.equal(r.status, 200, `a session inside its lifetime was refused: ${JSON.stringify(r.body)}`);
    }
  });

  test('★ requireAuthQueryOrHeader refuses it with an unexpired 12 h MEDIA token in ?token=, and with the session token in the header', async () => {
    // The media-token behaviour change: before #562 this answered 200 for up to 12 hours past day 30.
    const sid = aged(admin.id, 30, '-1 minute');
    const viaQuery = await call(`${server.url}/t/media?token=${encodeURIComponent(mediaToken(admin, sid))}`);
    assert.equal(viaQuery.status, 401, 'a media token outlived its session');
    const viaHeader = await call(`${server.url}/t/media`, { token: sessionToken(admin, sid) });
    assert.equal(viaHeader.status, 401);
  });

  test('requireAuthQueryOrHeader accepts a 29-day-old session\'s media token (the control)', async () => {
    const sid = aged(admin.id, 29);
    const r = await call(`${server.url}/t/media?token=${encodeURIComponent(mediaToken(admin, sid))}`);
    assert.equal(r.status, 200);
  });

  test('★ verifyToken (the talk socket\'s check) refuses it, for a session token and a media token', () => {
    const sid = aged(admin.id, 30, '-1 minute');
    assert.equal(verifyToken(sessionToken(admin, sid)), null);
    assert.equal(verifyToken(mediaToken(admin, sid), { purpose: 'media' }), null, 'the talk socket would keep a call open past the session');
    const live = aged(admin.id, 29);
    assert.equal(verifyToken(sessionToken(admin, live))?.sid, live, 'control');
    assert.equal(verifyToken(mediaToken(admin, live), { purpose: 'media' })?.sid, live, 'control');
  });

  test('★ a refused session\'s last_seen_at is not touched (a retrying client must not keep its row alive)', async () => {
    const dead = aged(admin.id, 30, '-1 minute');
    const before = lastSeen(dead);
    await call(`${server.url}/t/session`, { token: sessionToken(admin, dead) });
    await call(`${server.url}/t/media?token=${encodeURIComponent(mediaToken(admin, dead))}`);
    verifyToken(sessionToken(admin, dead));
    assert.equal(lastSeen(dead), before, 'a refused request refreshed last_seen_at');

    // The control: the same fixture IS touched when the session is live, so the assertion above can fail.
    const live = aged(admin.id, 29);
    const was = lastSeen(live);
    await call(`${server.url}/t/session`, { token: sessionToken(admin, live) });
    assert.notEqual(lastSeen(live), was, 'precondition: a live request must refresh a 10-minute-old last_seen_at');
  });

  test('★ activePushTokens: a device whose session is 30 days + 1 minute old gets no push; 29 days does', () => {
    addPush('tok-dead', admin.id, aged(admin.id, 30, '-1 minute'));
    addPush('tok-live', admin.id, aged(admin.id, 29));
    assert.deepEqual(activePushTokens().map((r) => r.token), ['tok-live']);
  });

  test('★ the live-view sweep: isLiveSessionId makes sessionsToKick close a view 30 days + 1 minute old, and keep 29 days', () => {
    const dead = aged(admin.id, 30, '-1 minute');
    const live = aged(admin.id, 29);
    const owners = new Map([['mtx-dead', { sid: dead, recordedAt: 0 }], ['mtx-live', { sid: live, recordedAt: 0 }]]);
    const { toKick } = sessionsToKick([{ id: 'mtx-dead', path: 'cam_a' }, { id: 'mtx-live', path: 'cam_b' }], owners, isLiveSessionId, 1);
    assert.deepEqual(toKick, [{ id: 'mtx-dead', path: 'cam_a' }]);
  });

  test('isLiveSessionId: no id, or an id with no row, is not live', () => {
    for (const sid of [null, undefined, '', 'no-such-session']) assert.equal(isLiveSessionId(sid), false, `${JSON.stringify(sid)}`);
  });

  test('★ purgeExpiredSessions deletes sessions past their lifetime or idle 31 days, and their push tokens; keeps the rest', () => {
    const pastLifetime = aged(admin.id, 30, '-1 minute');
    const inside = aged(admin.id, 29);
    // Idle 32 days, but with a created_at in the FUTURE (a clock that went backwards, a restored backup):
    // only the idle rule can remove it, which is why that rule was kept.
    const idleFuture = makeSession(db, carer.id);
    db.prepare("UPDATE sessions SET created_at = datetime('now', '+1 day'), last_seen_at = datetime('now', '-32 days') WHERE id = ?").run(idleFuture);
    addPush('tok-past', admin.id, pastLifetime);
    addPush('tok-idle', carer.id, idleFuture);
    addPush('tok-inside', admin.id, inside);
    addPush('tok-unbound', admin.id, null); // a pre-migration row: not the purge's business

    assert.equal(purgeExpiredSessions(), 2);

    const ids = db.prepare('SELECT id FROM sessions').all().map((r) => r.id);
    assert.deepEqual(ids, [inside]);
    assert.deepEqual(
      db.prepare('SELECT token FROM push_tokens ORDER BY token').all().map((r) => r.token),
      ['tok-inside', 'tok-unbound'],
      'the purged sessions\' push registrations must go with them (deleted FIRST, while the sessions still exist)'
    );
    assert.equal(purgeExpiredSessions(), 0, 'a second run finds nothing');
  });

  test('★ the purge\'s idle rule is 31 days: a push-only phone idle 29.5 days and a future-dated row idle 30.5 days stay', () => {
    // Review of #696: the case above only pins that an idle rule EXISTS (-32 days goes); '-31 days' could
    // become '-1 days' and it would still pass. A phone that only RECEIVES push never makes a request, so its
    // last_seen_at stays at its sign-in time: it must keep its session and its push token until the lifetime
    // ends, however long it has been idle inside it. Half-day margins either side of each threshold.
    const at = (userId, created, seen) => {
      const sid = makeSession(db, userId);
      db.prepare("UPDATE sessions SET created_at = datetime('now', ?, ?), last_seen_at = datetime('now', ?, ?) WHERE id = ?")
        .run(...created, ...seen, sid);
      return sid;
    };
    const pushOnly = at(admin.id, ['-29 days', '-12 hours'], ['-29 days', '-12 hours']);
    // created_at in the future (a clock that went backwards): only the idle rule applies to these two.
    const idle30 = at(carer.id, ['+1 day', '+0 minutes'], ['-30 days', '-12 hours']);
    const idle31 = at(carer.id, ['+1 day', '+0 minutes'], ['-31 days', '-12 hours']);
    addPush('tok-push-only', admin.id, pushOnly);
    addPush('tok-idle-30', carer.id, idle30);
    addPush('tok-idle-31', carer.id, idle31);

    assert.equal(purgeExpiredSessions(), 1);
    assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map((r) => r.id).sort(), [pushOnly, idle30].sort());
    assert.deepEqual(
      db.prepare('SELECT token FROM push_tokens ORDER BY token').all().map((r) => r.token),
      ['tok-idle-30', 'tok-push-only'],
      'a session the purge keeps must keep its push registration too'
    );
  });

  test('★ GET /sessions and GET /sessions/all do not list a session past its lifetime', async () => {
    const current = makeSession(db, admin.id);
    const dead = aged(admin.id, 30, '-1 minute');
    const inside = aged(admin.id, 29);
    const carersDead = aged(carer.id, 30, '-1 minute');
    const carersLive = aged(carer.id, 29);
    const token = sessionToken(admin, current);

    const own = await call(`${api.url}/api/auth/sessions`, { token });
    assert.equal(own.status, 200);
    assert.deepEqual(own.body.map((s) => s.id).sort(), [current, inside].sort(), `listed: ${JSON.stringify(own.body)}`);

    const all = await call(`${api.url}/api/auth/sessions/all`, { token });
    assert.equal(all.status, 200);
    const listed = all.body.map((s) => s.id);
    assert.deepEqual(listed.slice().sort(), [current, inside, carersLive].sort());
    assert.ok(!listed.includes(dead) && !listed.includes(carersDead));
    assert.equal(all.body.find((s) => s.id === carersLive).username, 'carer', 'the join still names the account');
  });

  test('★ both session lists put the most recently active device first (ORDER BY last_seen_at DESC)', async () => {
    // Review of #696: the case above sorts ids before comparing, so it cannot see the order. Fixed ids,
    // created in the REVERSE of the expected order, so neither insertion (rowid) order nor id order can pass
    // for newest-first. All inside the lifetime; the current session was seen just now (no touch happens).
    const seen = (id, userId, ago) => {
      makeSession(db, userId, { id });
      db.prepare("UPDATE sessions SET created_at = datetime('now', '-1 day'), last_seen_at = datetime('now', ?) WHERE id = ?").run(ago, id);
      return id;
    };
    seen('sess-1', admin.id, '-3 hours');
    seen('sess-2', carer.id, '-1 hour');
    seen('sess-3', admin.id, '-10 minutes');
    const current = seen('sess-4', admin.id, '+0 minutes');
    const token = sessionToken(admin, current);

    const own = await call(`${api.url}/api/auth/sessions`, { token });
    assert.deepEqual(own.body.map((s) => s.id), ['sess-4', 'sess-3', 'sess-1']);
    const all = await call(`${api.url}/api/auth/sessions/all`, { token });
    assert.deepEqual(all.body.map((s) => s.id), ['sess-4', 'sess-3', 'sess-2', 'sess-1']);
  });

  test('★ the token issued at login carries exp - iat = 30 days', async () => {
    const res = await call(`${api.url}/api/auth/login`, { method: 'POST', body: { username: 'admin', password: 'hunter22-long' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { exp, iat } = jwt.decode(res.body.token);
    assert.equal(exp - iat, 30 * DAY);
  });
});

// ---------------------------------------------------------------------------------------------------
// ⚠️ A PIN, NOT A BEHAVIOURAL TEST. index.js cannot be imported (it boots the app), so the one line that hands
// the sweep its liveness rule, and the purge it runs at start and schedules daily, are checked by reading the
// source. It fails if the sweep goes back to an inline query (the copy that drifted) or stops using the shared
// function, or if either purge call goes (review of #696: the start-up call was not pinned).
test('index.js pin: the sweep hands sessionsToKick isLiveSessionId, and the purge from middleware/auth.js runs at start and daily', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8');
  const code = stripCommentsAndStrings(raw);
  assert.match(raw, /import \{[^}]*\bisLiveSessionId\b[^}]*\bpurgeExpiredSessions\b[^}]*\} from '\.\/middleware\/auth\.js';/);
  assert.match(code, /sessionsToKick\(sessions, webrtcSessionOwners, isLiveSessionId, listStartedAt\)/);
  assert.match(code, /^purgeExpiredSessions\(\);\r?$/m, 'the purge no longer runs at start (only after the first day)');
  assert.match(code, /safeInterval\('', 24 \* 60 \* 60 \* 1000, purgeExpiredSessions\)/);
  assert.doesNotMatch(code, /function purgeExpiredSessions/, 'a local purge would shadow the shared one');
  assert.doesNotMatch(raw, /FROM sessions/, 'index.js has its own sessions query again: use middleware/auth.js');
});
