// #553 phase 1: GET /api/about reports `mediaIsolation`, 'on' or 'off', ADDED to the response (nothing else changes).
// It is what backend/entrypoint.sh decided and exported as MEDIA_ISOLATION, read per request: 'on' only for exactly
// "on", anything else (unset included, which is every start outside the image) is 'off'. Real HTTP, real router.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, call, mountRouter } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: aboutRoutes } = await import('../src/routes/about.js');

const saved = process.env.MEDIA_ISOLATION;
let srv;
let token;
before(async () => {
  makeUser(db, { id: 'u-iso', username: 'iso-user', role: 'caregiver' });
  token = signToken({ id: 'u-iso', username: 'iso-user', role: 'caregiver', sid: makeSession(db, 'u-iso') });
  srv = await mountRouter('/api/about', aboutRoutes);
});
afterEach(() => { if (saved === undefined) delete process.env.MEDIA_ISOLATION; else process.env.MEDIA_ISOLATION = saved; });
after(async () => { await srv.close(); cleanupTempDataDirs(); });

describe('#553 GET /api/about: mediaIsolation', () => {
  test('"on" when the entrypoint exported MEDIA_ISOLATION=on, and the existing fields are all still there', async () => {
    process.env.MEDIA_ISOLATION = 'on';
    const res = await call(`${srv.url}/api/about`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.mediaIsolation, 'on');
    for (const k of ['version', 'gitSha', 'gitRef', 'buildTime', 'stunServers', 'publicBaseUrl']) {
      assert.ok(k in res.body, `${k} went missing (the change must be additive)`);
    }
  });

  test('"off" for "off", for anything that is not exactly "on", and when it is not set at all', async () => {
    for (const v of ['off', 'ON', '1', 'true', '', undefined]) {
      if (v === undefined) delete process.env.MEDIA_ISOLATION; else process.env.MEDIA_ISOLATION = v;
      const res = await call(`${srv.url}/api/about`, { token });
      assert.equal(res.body.mediaIsolation, 'off', JSON.stringify(v));
    }
  });
});
