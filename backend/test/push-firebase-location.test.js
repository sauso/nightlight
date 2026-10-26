// #553 phase 2a: where lib/push.js looks for the two Firebase files. Once the start-up move has run they are in
// DATA_DIR/private/; the admin still drops them at the TOP of the data directory (docs/notifications.md), where they
// must work at once, without a restart. So the place is resolved on every call: private/ first, then the top level.
// Real files in a temp DATA_DIR; only the client config is read here (getClientConfig, validatePushSetup), so
// firebase-admin is never loaded.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const dataDir = useTempDataDir();
delete process.env.FIREBASE_CREDENTIALS;
delete process.env.FIREBASE_CLIENT_CONFIG;
const { getClientConfig, validatePushSetup } = await import('../src/lib/push.js');
after(() => cleanupTempDataDirs());

const clientConfig = (appId) => JSON.stringify({
  client: [{ client_info: { mobilesdk_app_id: appId }, api_key: [{ current_key: 'key' }] }],
  project_info: { project_id: 'proj', project_number: '123' },
});
const inPrivate = (f) => path.join(dataDir, 'private', f);
const atTop = (f) => path.join(dataDir, f);

test('#553 a file that appears in private/ AFTER start is found (resolved per call), and private/ wins over the top', () => {
  assert.equal(getClientConfig(), null, 'precondition: no file anywhere yet');
  fs.writeFileSync(inPrivate('google-services.json'), clientConfig('from-private'));
  assert.equal(getClientConfig()?.appId, 'from-private');
  fs.writeFileSync(atTop('google-services.json'), clientConfig('from-top'));
  assert.equal(getClientConfig()?.appId, 'from-private', 'the top-level copy won');
  fs.rmSync(inPrivate('google-services.json'));
  assert.equal(getClientConfig()?.appId, 'from-top', 'a file dropped at the top must work at once');
  fs.rmSync(atTop('google-services.json'));
});

test('#553 the service-account key is found in private/ too (validatePushSetup, the "enable push" check)', () => {
  assert.match(validatePushSetup().error, /firebase-service-account\.json\) is missing/);
  fs.writeFileSync(inPrivate('firebase-service-account.json'), JSON.stringify({ project_id: 'proj', private_key: 'k' }));
  fs.writeFileSync(inPrivate('google-services.json'), clientConfig('app'));
  assert.deepEqual(validatePushSetup(), { ok: true });
});
