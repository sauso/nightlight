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
import { useTempDataDir, makeUser } from './helpers/harness.js';

const dataDir = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { activePushTokens, sendToAll, initPush } = await import('../src/lib/push.js');

const addToken = (token, userId) =>
  db.prepare('INSERT INTO push_tokens (token, user_id, platform) VALUES (?, ?, ?)').run(token, userId, 'android');

beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM users').run();
});

describe('★ activePushTokens excludes anything not tied to a live user (GHSA-q98f)', () => {
  test('a token belonging to an existing user is included', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    addToken('tok-1', 'u-1');
    assert.deepEqual(activePushTokens().map((r) => r.token), ['tok-1']);
  });

  test('★ THE FIX: a token whose user no longer exists is excluded, even if the row is never cleaned up', () => {
    // No corresponding user is ever inserted — simulates the exact orphan this advisory named, without
    // depending on the delete-route's own cleanup (auth-routes.test.js proves that separately). This
    // is the backstop: even a row that reaches this state some OTHER way must still be unreachable.
    addToken('tok-orphan', 'u-does-not-exist');
    assert.deepEqual(activePushTokens(), [], 'an orphaned token was still selected as a recipient');
  });

  test('a token with no user_id at all is excluded', () => {
    addToken('tok-null', null);
    assert.deepEqual(activePushTokens(), [], 'a token with no owning user was still selected as a recipient');
  });

  test('one orphaned token among several does not suppress delivery to everyone else', () => {
    makeUser(db, { id: 'u-1', username: 'alice' });
    makeUser(db, { id: 'u-2', username: 'bob' });
    addToken('tok-1', 'u-1');
    addToken('tok-2', 'u-2');
    addToken('tok-orphan', 'u-gone');
    const tokens = activePushTokens().map((r) => r.token).sort();
    assert.deepEqual(tokens, ['tok-1', 'tok-2'], 'a single orphan changed who else gets delivered to');
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
    addToken('tok-live', 'u-1');
    addToken('tok-orphan', 'u-gone'); // never cleaned up — the exact scenario this fix defends against

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
});
