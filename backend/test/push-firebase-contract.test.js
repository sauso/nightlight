// Upgrade guard for the real Firebase Admin APIs used by push.js (#455). Every other push test
// mock.module()s firebase-admin, so none of them can notice a version bump that renames or breaks
// initializeApp/cert/getMessaging/sendEach, and a broken push is silent until an alert fails to
// arrive. This file mocks nothing, so it must stay in its own file: mocks are process-wide.
// Initialization validates the service-account key (project_id, client_email and a parseable PEM
// key) but sends nothing and touches no network. firebase-admin validates message shape inside
// sendEach, before its network call, so this test covers neither that validation nor FCM delivery.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const dataDir = useTempDataDir();
const previousCredentials = process.env.FIREBASE_CREDENTIALS;
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.FIREBASE_CREDENTIALS = path.join(dataDir, 'firebase-service-account.json');
fs.writeFileSync(process.env.FIREBASE_CREDENTIALS, JSON.stringify({
  project_id: 'nightlight-contract-test',
  client_email: 'test@nightlight-contract-test.iam.gserviceaccount.com',
  private_key: privateKey,
}));

after(() => {
  if (previousCredentials === undefined) delete process.env.FIREBASE_CREDENTIALS;
  else process.env.FIREBASE_CREDENTIALS = previousCredentials;
  cleanupTempDataDirs();
});

test('T4: real firebase-admin initializes and exposes sendEach for push.js', async () => {
  // Other files can mock firebase-admin process-wide under --test-isolation=none; the mocks do not
  // export SDK_VERSION, so this proves T4 actually loaded the installed SDK.
  const { SDK_VERSION } = await import('firebase-admin/app');
  assert.match(SDK_VERSION, /^\d+\.\d+\.\d+/);
  const { initPush } = await import('../src/lib/push.js');
  assert.equal(await initPush(), true);
  const { getMessaging } = await import('firebase-admin/messaging');
  assert.equal(typeof getMessaging().sendEach, 'function');
});
