// Issue #546: sendToAll used to hand EVERY deliverable token to one messaging.sendEach() call.
// firebase-admin rejects a list of more than 500 messages before sending anything, so once 501
// tokens were registered every FCM alert for every device failed ("[push] send failed"), and the
// dead rows were never pruned because pruning only ran on a successful response. sendToAll now
// sends in chunks of at most FCM_MAX_BATCH, a failing chunk costs only its own devices, and the
// "alert sent to N/M" line reports the totals.
//
// The Firebase Admin SDK is faked (no network, no credentials), but the fake enforces the REAL
// SDK's limit — it throws on >500 messages exactly as firebase-admin does — so a test here fails
// when the code regresses to one big call instead of merely counting calls.
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, makeUser, makeSession } from './helpers/harness.js';

const dataDir = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { logger } = await import('../src/lib/logger.js');
const { sendToAll, initPush, FCM_MAX_BATCH } = await import('../src/lib/push.js');

// Behaviour of the fake sendEach, replaced per test. Receives (messages, callIndex) and returns
// the per-message results; the default is "everything delivered".
let behave = null;
const calls = []; // the token list of every sendEach call, in order

const sendEach = async (messages) => {
  // Same guard as firebase-admin (its FCM_MAX_BATCH_SIZE): this is the failure #546 reported.
  if (messages.length > 500) {
    throw Object.assign(new Error('messages list must not contain more than 500 items'), {
      code: 'messaging/invalid-argument',
    });
  }
  const callIndex = calls.length;
  calls.push(messages.map((m) => m.token));
  const results = behave ? await behave(messages, callIndex) : messages.map(() => ({ success: true }));
  return {
    responses: results,
    successCount: results.filter((r) => r.success).length,
    failureCount: results.filter((r) => !r.success).length,
  };
};

mock.module('firebase-admin/app', { namedExports: { initializeApp: () => {}, cert: () => ({}) } });
mock.module('firebase-admin/messaging', { namedExports: { getMessaging: () => ({ sendEach }) } });

const insertTokens = (n) => {
  makeUser(db, { id: 'u-1', username: 'alice' });
  const sid = makeSession(db, 'u-1');
  const ins = db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(`tok-${String(i).padStart(5, '0')}`, 'u-1', sid, 'android');
  })();
};

let infoLines;
let errorLines;

beforeEach(async () => {
  db.exec('DELETE FROM push_tokens; DELETE FROM sessions; DELETE FROM users;');
  calls.length = 0;
  behave = null;
  infoLines = [];
  errorLines = [];
  mock.method(logger, 'info', (...a) => infoLines.push(a.join(' ')));
  mock.method(logger, 'error', (...a) => errorLines.push(a.join(' ')));
  if (!fs.existsSync(path.join(dataDir, 'firebase-service-account.json'))) {
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
  }
  assert.equal(await initPush(), true, 'precondition: fake Firebase setup must initialize');
  db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run();
});

const remaining = () => new Set(db.prepare('SELECT token FROM push_tokens').all().map((r) => r.token));

describe('sendToAll batches its FCM sends (#546)', () => {
  test('the batch size is the SDK limit', () => {
    assert.equal(FCM_MAX_BATCH, 500);
  });

  for (const [n, expectedBatches] of [
    [1, [1]],
    [500, [500]],
    [501, [500, 1]],
    [1234, [500, 500, 234]],
  ]) {
    test(`${n} tokens: every token is messaged exactly once in batches of at most 500`, async () => {
      insertTokens(n);
      await sendToAll('Motion', 'Camera detected motion');

      assert.deepEqual(calls.map((c) => c.length), expectedBatches);
      const all = calls.flat();
      assert.equal(all.length, n, 'a token was skipped or messaged twice');
      assert.equal(new Set(all).size, n, 'a token was messaged more than once');
      assert.equal(errorLines.length, 0, `unexpected error log: ${errorLines.join(' | ')}`);
      assert.ok(
        infoLines.includes(`[push] alert sent to ${n}/${n} device(s)`),
        `missing aggregated log line, got: ${infoLines.join(' | ')}`
      );
    });
  }

  test('a failing batch is logged and does not stop the others; the log counts only what was delivered', async () => {
    insertTokens(1234);
    // The middle batch throws (e.g. a network error to FCM).
    behave = (messages, callIndex) => {
      if (callIndex === 1) throw new Error('socket hang up');
      return messages.map(() => ({ success: true }));
    };
    await sendToAll('Motion', 'Camera detected motion');

    assert.deepEqual(calls.map((c) => c.length), [500, 500, 234], 'the batch after the failure was never tried');
    assert.equal(errorLines.length, 1);
    assert.match(errorLines[0], /batch 2\/3 \(500 device\(s\)\).*socket hang up/);
    assert.ok(infoLines.includes('[push] alert sent to 734/1234 device(s)'), infoLines.join(' | '));
    assert.equal(remaining().size, 1234, 'a thrown batch is not evidence of dead tokens: nothing may be pruned');
  });

  test('every batch failing logs each batch and no "alert sent" line', async () => {
    insertTokens(501);
    behave = () => {
      throw new Error('FCM down');
    };
    await sendToAll('Motion', 'Camera detected motion');
    assert.equal(errorLines.length, 2);
    assert.match(errorLines[0], /batch 1\/2 \(500 device\(s\)\)/);
    assert.match(errorLines[1], /batch 2\/2 \(1 device\(s\)\)/, 'the short last batch must report its real size');
    assert.ok(!infoLines.some((l) => l.includes('alert sent')), infoLines.join(' | '));
  });

  test('dead tokens in a LATER batch are pruned by their own row, not by their position in the batch', async () => {
    insertTokens(1100);
    // Local index 100 of batch 2 = global row 600; local index 50 of batch 3 = global row 1050.
    // With a missing offset these would prune rows 100 and 50 (live tokens in batch 1) instead.
    behave = (messages, callIndex) =>
      messages.map((_, i) => {
        if (callIndex === 1 && i === 100) return { success: false, error: { code: 'messaging/registration-token-not-registered' } };
        if (callIndex === 2 && i === 50) return { success: false, error: { code: 'messaging/invalid-registration-token' } };
        // A transient failure must NOT prune the token.
        if (callIndex === 1 && i === 7) return { success: false, error: { code: 'messaging/internal-error' } };
        return { success: true };
      });
    await sendToAll('Motion', 'Camera detected motion');

    const left = remaining();
    assert.equal(left.size, 1098);
    assert.ok(!left.has('tok-00600'), 'the dead token in batch 2 was not removed');
    assert.ok(!left.has('tok-01050'), 'the dead token in batch 3 was not removed');
    assert.ok(left.has('tok-00100') && left.has('tok-00050'), 'a live token from batch 1 was pruned by a later batch (missing offset)');
    assert.ok(left.has('tok-00507'), 'a transient FCM failure must not prune the token');
    assert.ok(infoLines.includes('[push] alert sent to 1097/1100 device(s)'), infoLines.join(' | '));
  });
});
