// GHSA-6p7j-w59r-m3hr: an already-open talk-back WebSocket kept forwarding audio after its session
// was revoked, its account was deleted, or its media token expired — the upgrade handshake was the
// ONLY point verifyToken was ever called. Fixed by talkSocket.js's TALK_REVALIDATE_MS timer, which
// re-runs the exact same check on an interval for as long as the socket stays open.
//
// ⚠️ startTalkSession is mocked (`node:test`'s `mock.module`) — a real one opens a network connection
// to the camera's ONVIF/Hikvision backchannel, which doesn't exist in this environment. This is the
// one deliberate exception to "no mocks, real everything else" in this suite: auth/session state
// (the actual subject of this bug) is 100% real — real DB, real sessions, real JWTs, real
// verifyToken — only the camera-side transport is faked, the same way ffmpeg spawns are avoided
// elsewhere via an emptied PATH rather than by faking application logic.
import { test, describe, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import jwt from 'jsonwebtoken';
import { useTempDataDir, makeUser, makeSession, makeCamera } from './helpers/harness.js';

useTempDataDir();

const fakeSession = { write: mock.fn(), close: mock.fn(async () => {}) };
let startFails = false;
mock.module('../src/lib/twoWayAudio.js', {
  namedExports: {
    startTalkSession: async () => {
      if (startFails) throw new Error('camera unreachable');
      return fakeSession;
    },
    talkConfigured: () => true,
  },
});

const { default: db } = await import('../src/db.js');
const { handleTalkConnection, TALK_REVALIDATE_MS } = await import('../src/lib/talkSocket.js');

const JWT_SECRET = process.env.JWT_SECRET;
const signMedia = (userId, sessionId, opts = {}) =>
  jwt.sign({ id: userId, sid: sessionId, purpose: 'media' }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '12h',
    ...opts,
  });

// A minimal fake matching exactly what handleTalkConnection calls: .on/.send/.close, EventEmitter
// for message/close/error so the handler's own listeners can be driven directly.
function fakeWs() {
  const em = new EventEmitter();
  em.send = mock.fn();
  em.close = mock.fn();
  return em;
}

const AUDIO = Buffer.from([1, 2, 3, 4]);
const camera = () => makeCamera(db, { id: 'cam-1', name: 'Nursery' });

beforeEach(() => {
  fakeSession.write.mock.resetCalls();
  fakeSession.close.mock.resetCalls();
  startFails = false;
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM cameras').run();
});

describe('★ talk-back access is re-checked while the socket stays open (GHSA-6p7j)', () => {
  // ★ THE CALIBRATED VALUE IS PINNED, NOT MERELY REFERENCED. Every other test below ticks by the
  // imported TALK_REVALIDATE_MS constant rather than a literal 15000 — correct for testing the
  // MECHANISM (it can't care what the number is), but it means changing the constant to, say,
  // 300_000 would not fail a single test here, silently widening the exact security window the PR
  // describes as "a bounded, human-noticeable window." Found by adversarial review. This is the one
  // assertion that actually holds the number itself to account.
  test('TALK_REVALIDATE_MS is 15 seconds', () => {
    assert.equal(TALK_REVALIDATE_MS, 15_000);
  });

  test('baseline: a still-authorized connection keeps forwarding audio across a revalidation tick', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const user = makeUser(db, { id: 'u-1', username: 'admin' });
    const sid = makeSession(db, user.id, { id: 's-1' });
    const token = signMedia(user.id, sid);
    const ws = fakeWs();

    const done = handleTalkConnection(ws, camera(), { username: user.username }, token);
    await Promise.resolve(); // let startTalkSession's microtask resolve

    ws.emit('message', AUDIO, true);
    assert.equal(fakeSession.write.mock.callCount(), 1, 'precondition: audio forwards normally');

    t.mock.timers.tick(TALK_REVALIDATE_MS);
    await Promise.resolve();

    assert.equal(ws.close.mock.callCount(), 0, 'a still-valid session must not be closed');
    ws.emit('message', AUDIO, true);
    assert.equal(fakeSession.write.mock.callCount(), 2, 'audio still forwards after a clean tick');
    await done;
  });

  test('★ THE FIX: deleting the session closes an already-open connection and stops forwarding audio', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const user = makeUser(db, { id: 'u-2', username: 'admin' });
    const sid = makeSession(db, user.id, { id: 's-2' });
    const token = signMedia(user.id, sid);
    const ws = fakeWs();

    handleTalkConnection(ws, camera(), { username: user.username }, token);
    await Promise.resolve();
    ws.emit('message', AUDIO, true);
    assert.equal(fakeSession.write.mock.callCount(), 1, 'precondition: audio forwards before revocation');

    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); // the actual advisory reproduction's step

    t.mock.timers.tick(TALK_REVALIDATE_MS);
    await Promise.resolve();

    assert.equal(ws.close.mock.callCount(), 1, 'a revoked session must close the socket');
    ws.emit('message', AUDIO, true);
    assert.equal(
      fakeSession.write.mock.callCount(),
      1,
      'no audio may be forwarded after the session backing the socket was revoked'
    );
  });

  test('★ the revalidation timer is actually cleared on revocation, not just harmlessly idempotent', async (t) => {
    // ⚠️ Found by adversarial review: deleting `clearInterval(revalidateTimer)` from cleanup() left
    // every OTHER test in this file passing, because cleanup()'s own `closed` guard makes a SECOND,
    // unstopped firing of the interval produce no NEW observable side effect (ws.close and
    // fakeSession.write call-counts don't change on a firing that's already a no-op). That means an
    // interval which keeps calling verifyToken -> liveSession against the DB every 15s, forever, after
    // a connection has already ended is invisible to a test that only checks state once after one
    // tick. This spies on clearInterval directly — the actual mechanism the safety property rests on —
    // rather than inferring it from side effects that happen to look the same whether it fired or not.
    t.mock.timers.enable({ apis: ['setInterval'] });
    // Spied AFTER enabling, not before: mock.timers.enable() replaces globalThis.clearInterval with
    // its own mock-aware version — spying first would wrap the native function that's no longer what
    // gets called, and the spy would (falsely) never see a call at all.
    const clearSpy = t.mock.method(globalThis, 'clearInterval');
    const user = makeUser(db, { id: 'u-6', username: 'admin' });
    const sid = makeSession(db, user.id, { id: 's-6' });
    const token = signMedia(user.id, sid);
    const ws = fakeWs();

    handleTalkConnection(ws, camera(), { username: user.username }, token);
    await Promise.resolve();
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    t.mock.timers.tick(TALK_REVALIDATE_MS);
    await Promise.resolve();

    assert.equal(clearSpy.mock.callCount(), 1, 'cleanup() did not clear the revalidation timer');

    // The direct proof the spy alone doesn't give: with the timer actually cleared, ticking well past
    // several more intervals must produce NO further revocation log line — if it were still alive, it
    // would fire again and again, forever, exactly like the mutation this test was written to catch.
    ws.close.mock.resetCalls();
    t.mock.timers.tick(TALK_REVALIDATE_MS * 5);
    await Promise.resolve();
    assert.equal(ws.close.mock.callCount(), 0, 'the timer fired again after cleanup — it was never really cleared');
  });

  test('deleting the account (not just the session row) has the same effect', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const user = makeUser(db, { id: 'u-3', username: 'admin' });
    const sid = makeSession(db, user.id, { id: 's-3' });
    const token = signMedia(user.id, sid);
    const ws = fakeWs();

    handleTalkConnection(ws, camera(), { username: user.username }, token);
    await Promise.resolve();
    ws.emit('message', AUDIO, true);
    assert.equal(fakeSession.write.mock.callCount(), 1, 'precondition: audio forwards before deletion');

    // db.js declares `sessions.user_id ... ON DELETE CASCADE` with `PRAGMA foreign_keys = ON` — so this
    // actually removes the session row too, not just the user row (verified directly: a session
    // present before this DELETE is gone after it). Still a distinct, worthwhile regression test: it's
    // the advisory's own named scenario ("deleting the caregiver's account"), reached through the real
    // delete path an admin actually uses, rather than deleting the session row directly as the test
    // above does. The two tests would only diverge if the cascade were ever removed — at which point
    // this one starts covering the surviving-orphaned-session case its name already promises.
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

    t.mock.timers.tick(TALK_REVALIDATE_MS);
    await Promise.resolve();

    assert.equal(ws.close.mock.callCount(), 1, 'a deleted account must close the socket, not just a deleted session row');
    ws.emit('message', AUDIO, true);
    assert.equal(fakeSession.write.mock.callCount(), 1, 'no audio may be forwarded once the account is gone');
  });

  test('a naturally-expired media token has the same effect, with no revocation action at all', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
    const user = makeUser(db, { id: 'u-4', username: 'admin' });
    const sid = makeSession(db, user.id, { id: 's-4' });
    const token = signMedia(user.id, sid, { expiresIn: '1s' }); // still valid right now
    const ws = fakeWs();

    handleTalkConnection(ws, camera(), { username: user.username }, token);
    await Promise.resolve();
    ws.emit('message', AUDIO, true);
    assert.equal(fakeSession.write.mock.callCount(), 1, 'precondition: token is valid at connect time');

    // Nothing revoked anything — the token's own `exp` claim just elapses with real wall-clock time.
    t.mock.timers.tick(2000); // past the token's 1s expiry
    t.mock.timers.tick(TALK_REVALIDATE_MS);
    await Promise.resolve();

    assert.equal(ws.close.mock.callCount(), 1, 'an expired media token must close the socket');
    ws.emit('message', AUDIO, true);
    assert.equal(fakeSession.write.mock.callCount(), 1, 'no audio may be forwarded once the token has expired');
  });

  test('a camera that fails to start its talk session sends an error and tears down cleanly', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    startFails = true;
    const user = makeUser(db, { id: 'u-5', username: 'admin' });
    const sid = makeSession(db, user.id, { id: 's-5' });
    const token = signMedia(user.id, sid);
    const ws = fakeWs();

    await handleTalkConnection(ws, camera(), { username: user.username }, token);

    assert.equal(ws.send.mock.callCount(), 1, 'the client must be told the session failed to start');
    const sent = JSON.parse(ws.send.mock.calls[0].arguments[0]);
    assert.equal(sent.type, 'error');
    assert.equal(ws.close.mock.callCount(), 1, 'a failed start must still close the socket');

    // The revalidation timer must not survive a failed start either — it was created before
    // startTalkSession was even awaited, so cleanup() clearing it is the only thing that stops it.
    t.mock.timers.tick(TALK_REVALIDATE_MS * 3);
    assert.equal(ws.close.mock.callCount(), 1, 'a cleared timer must not fire again after teardown');
  });
});
