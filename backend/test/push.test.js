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
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, makeUser } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { activePushTokens } = await import('../src/lib/push.js');

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
