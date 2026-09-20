// lib/push.js's recipient-selection query. GHSA-q98f: push_tokens.user_id has no FK/cascade, so a
// deleted user's token used to keep receiving alerts (including camera-snapshot image links)
// indefinitely. routes/auth.js's DELETE /users/:id now deletes the matching rows directly
// (auth-routes.test.js covers that); this file is the defense-in-depth half — activePushTokens()
// filters sendToAll's query so an orphaned row, however it got there, can never be delivered to.
//
// sendToAll itself is NOT called here — it needs a real, initialized Firebase Admin SDK (`messaging`
// is module-level state only initPush() sets, from a real service-account credential file), which
// this environment doesn't have and shouldn't need for a pure recipient-selection question. Extracted
// exactly so this could be tested without any of that — see the comment on activePushTokens itself.
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, makeUser, makeSession } from './helpers/harness.js';

const dataDir = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { activePushTokens, sendToAll, initPush, registerToken } = await import('../src/lib/push.js');

// sessionId is now a required-in-spirit third column (see the session-revocation describe block
// below) — every call site here passes one explicitly, including a deliberately nonexistent one for
// the orphan cases, rather than leaving it to default to NULL by omission.
const addToken = (token, userId, sessionId) =>
  db
    .prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)')
    .run(token, userId, sessionId, 'android');

beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
});

describe('★ activePushTokens excludes anything not tied to a live user (GHSA-q98f)', () => {
  test('a token belonging to an existing user with a live session is included', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    const sid = makeSession(db, 'u-1');
    addToken('tok-1', 'u-1', sid);
    assert.deepEqual(activePushTokens().map((r) => r.token), ['tok-1']);
  });

  test('★ THE FIX: a token whose user no longer exists is excluded, even if the row is never cleaned up', () => {
    // No corresponding user is ever inserted — simulates the exact orphan this advisory named, without
    // depending on the delete-route's own cleanup (auth-routes.test.js proves that separately). This
    // is the backstop: even a row that reaches this state some OTHER way must still be unreachable.
    // The session_id is also a nonexistent id, not a live one — sessions.user_id has an FK to users,
    // so a row genuinely orphaned this way (e.g. by a user delete that cascades sessions too) would
    // never have a live session either; a fixture pairing "no user" with "live session" couldn't occur.
    addToken('tok-orphan', 'u-does-not-exist', 'sess-does-not-exist');
    assert.deepEqual(activePushTokens(), [], 'an orphaned token was still selected as a recipient');
  });

  test('a token with no user_id or session_id at all is excluded', () => {
    addToken('tok-null', null, null);
    assert.deepEqual(activePushTokens(), [], 'a token with no owning user was still selected as a recipient');
  });

  test('one orphaned token among several does not suppress delivery to everyone else', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    makeUser(db, { id: 'u-2', username: 'bob' });
    const sid1 = makeSession(db, 'u-1');
    const sid2 = makeSession(db, 'u-2');
    addToken('tok-1', 'u-1', sid1);
    addToken('tok-2', 'u-2', sid2);
    addToken('tok-orphan', 'u-gone', 'sess-does-not-exist');
    const tokens = activePushTokens().map((r) => r.token).sort();
    assert.deepEqual(tokens, ['tok-1', 'tok-2'], 'a single orphan changed who else gets delivered to');
  });
});

describe('★ activePushTokens also excludes anything not tied to a live SESSION', () => {
  test('★ THE FIX: a token whose session has been revoked is excluded, even though its user still exists', () => {
    // The user is real and untouched — only the session is gone (signed out, an admin ending that
    // specific device, a password reset). A filter that only checked user_id (the pre-fix shape)
    // would let this through; this fixture is hostile to exactly that.
    makeUser(db, { id: 'u-1', username: 'alice' });
    addToken('tok-revoked', 'u-1', 'sess-does-not-exist');
    assert.deepEqual(activePushTokens(), [], 'a token whose session was revoked was still selected as a recipient');
  });

  test('a token with no session_id at all (registered before this migration existed) is excluded', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    addToken('tok-legacy', 'u-1', null);
    assert.deepEqual(activePushTokens(), [], 'a pre-migration token with no session_id was still selected as a recipient');
  });

  test("revoking one session doesn't suppress delivery to the same user's other live session", () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    const liveSid = makeSession(db, 'u-1');
    addToken('tok-live', 'u-1', liveSid);
    addToken('tok-revoked', 'u-1', 'sess-does-not-exist');
    assert.deepEqual(activePushTokens().map((r) => r.token), ['tok-live'], "revoking one device changed the household's other device");
  });

  test('★ THE FIX: a session row that still EXISTS but is past its absolute token TTL is excluded (found by review)', () => {
    // A session is only ever pruned by 31 days of INACTIVITY (see db.js's purgeExpiredSessions),
    // not by absolute age — so a row can genuinely outlive its own JWT's cryptographic 30-day
    // lifetime if something keeps touching last_seen_at. A bare `session_id IN (SELECT id FROM
    // sessions)` check (no age condition) would let this through; this fixture is hostile to
    // exactly that gap.
    makeUser(db, { id: 'u-1', username: 'alice' });
    const sid = makeSession(db, 'u-1');
    db.prepare("UPDATE sessions SET created_at = datetime('now', '-45 days') WHERE id = ?").run(sid);
    addToken('tok-expired', 'u-1', sid);
    assert.deepEqual(activePushTokens(), [], 'a token whose session is past its absolute TTL was still selected as a recipient');
  });

  test('a session well within its TTL is still included — the control', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    const sid = makeSession(db, 'u-1');
    db.prepare("UPDATE sessions SET created_at = datetime('now', '-5 days') WHERE id = ?").run(sid);
    addToken('tok-fresh', 'u-1', sid);
    assert.deepEqual(activePushTokens().map((r) => r.token), ['tok-fresh']);
  });
});

describe('★ registerToken rebinds an existing token to whichever session registered it most recently', () => {
  test('★ THE FIX: re-registering the same token under a NEW session updates session_id, not just leaves the old one', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    const oldSid = makeSession(db, 'u-1');
    registerToken('tok-1', 'android', 'u-1', null, oldSid);
    assert.equal(db.prepare('SELECT session_id FROM push_tokens WHERE token = ?').get('tok-1').session_id, oldSid);

    // A logout followed by a fresh sign-in on the same device re-registers under a NEW session id.
    const newSid = makeSession(db, 'u-1');
    registerToken('tok-1', 'android', 'u-1', null, newSid);

    assert.equal(
      db.prepare('SELECT session_id FROM push_tokens WHERE token = ?').get('tok-1').session_id,
      newSid,
      're-registering under a new session left the token bound to the old, now possibly-revoked one'
    );
  });

  test('a re-register with no sessionId (should not happen in practice, but must not crash) clears the binding rather than keeping a stale one', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    const oldSid = makeSession(db, 'u-1');
    registerToken('tok-1', 'android', 'u-1', null, oldSid);
    registerToken('tok-1', 'android', 'u-1', null, null);
    assert.equal(db.prepare('SELECT session_id FROM push_tokens WHERE token = ?').get('tok-1').session_id, null);
  });
});

// ★ THE WIRING GAP an adversarial review found: activePushTokens() itself was thoroughly tested above,
// but nothing proved sendToAll actually CALLS it rather than some other (e.g. the old, unfiltered)
// query — reverting sendToAll's one-line call site back to a bare `SELECT * FROM push_tokens` survived
// every test in this file untouched. Firebase Admin SDK is faked (mock.module on its two dynamic
// imports, matching how initPush() actually loads them) so this can drive the REAL sendToAll end to
// end without needing a live Firebase project — the fake records exactly which tokens it was asked to
// message, which is the one thing a unit test of activePushTokens() alone cannot show.
describe('★ sendToAll actually delivers through activePushTokens, not some other query (GHSA-q98f)', () => {
  const sendEach = mock.fn(async (messages) => ({
    responses: messages.map(() => ({ success: true })),
    successCount: messages.length,
  }));

  mock.module('firebase-admin/app', {
    namedExports: { initializeApp: () => {}, cert: () => ({}) },
  });
  mock.module('firebase-admin/messaging', {
    namedExports: { getMessaging: () => ({ sendEach }) },
  });

  test('★ THE FIX: sendToAll never messages a token whose user has been deleted', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'firebase-service-account.json'),
      JSON.stringify({ project_id: 'test-project', private_key: 'x' })
    );
    fs.writeFileSync(
      path.join(dataDir, 'google-services.json'),
      JSON.stringify({
        client: [{ client_info: { mobilesdk_app_id: 'app-1' }, api_key: [{ current_key: 'key-1' }] }],
        project_info: { project_id: 'test-project', project_number: '123' },
      })
    );
    assert.equal(await initPush(), true, 'precondition: fake Firebase setup must actually initialize');
    db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run();

    makeUser(db, { id: 'u-1', username: 'alice' });
    const liveSid = makeSession(db, 'u-1');
    addToken('tok-live', 'u-1', liveSid);
    addToken('tok-orphan', 'u-gone', 'sess-does-not-exist'); // never cleaned up — the exact scenario this fix defends against

    sendEach.mock.resetCalls();
    await sendToAll('Wake', 'Renz is awake');

    assert.equal(sendEach.mock.callCount(), 1, 'sendToAll did not attempt delivery at all');
    const [messages] = sendEach.mock.calls[0].arguments;
    assert.deepEqual(
      messages.map((m) => m.token),
      ['tok-live'],
      'sendToAll messaged a token belonging to a deleted user — activePushTokens() is not actually wired in'
    );
  });

  // ROADMAP §1.6 added an optional 5th `{ tag }` parameter to sendToAll for the sleep-report follow-up
  // notification. Every OTHER caller (detectionAlert.js, cameraStatusAlert.js, notifySleepReports when
  // batching multiple children) omits it — this pins that omitting it still produces today's exact
  // shape, with no `tag` key and no `apns` key at all, not an `undefined` one.
  test('a caller with no 5th argument gets a message with no tag/apns key at all', async () => {
    db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run();
    makeUser(db, { id: 'u-1', username: 'alice' });
    addToken('tok-1', 'u-1', makeSession(db, 'u-1'));
    sendEach.mock.resetCalls();
    await sendToAll('Motion', 'Camera detected motion');
    const [messages] = sendEach.mock.calls[0].arguments;
    assert.ok(!('tag' in messages[0].android.notification), 'an omitted tag must not appear as a key, not even as undefined');
    assert.ok(!('apns' in messages[0]), 'an omitted tag must not add an apns block at all');
  });

  test('a tag is set on BOTH Android notification.tag and the APNs collapse-id header', async () => {
    db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run();
    makeUser(db, { id: 'u-1', username: 'alice' });
    addToken('tok-1', 'u-1', makeSession(db, 'u-1'));
    sendEach.mock.resetCalls();
    await sendToAll('Sleep report updated', 'Renz: up 07:15', {}, null, { tag: 'sleep_report_renz_2026-07-01' });
    const [messages] = sendEach.mock.calls[0].arguments;
    assert.equal(messages[0].android.notification.tag, 'sleep_report_renz_2026-07-01');
    assert.equal(messages[0].apns.headers['apns-collapse-id'], 'sleep_report_renz_2026-07-01');
  });
});
