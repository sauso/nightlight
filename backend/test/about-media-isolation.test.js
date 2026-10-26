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

// WHY isolation is off, as the entrypoint exported it (MEDIA_ISOLATION_REASON, and MEDIA_ISOLATION_CAUSE for a fallback),
// added next to mediaIsolation. The About page warns admins for `fallback` and `id-clash`.
//
// THE POINT OF THESE TESTS: this route is readable by a caregiver, so NO value from the environment may be echoed. The
// environment supplies codes; the sentence comes from a table in the server. A marker planted in every variable must
// never appear in the response (a review found the first design echoed the entrypoint's free-text warning, which can
// name a leftover file or a folder with a person's name in it).
describe('GET /api/about: mediaIsolationReason and mediaIsolationDetail', () => {
  const NAMES = ['MEDIA_ISOLATION_REASON', 'MEDIA_ISOLATION_CAUSE', 'MEDIA_ISOLATION_DETAIL'];
  const savedVars = Object.fromEntries(NAMES.map((k) => [k, process.env[k]]));
  const put = (isolation, reason, cause) => {
    for (const [k, v] of [['MEDIA_ISOLATION', isolation], ['MEDIA_ISOLATION_REASON', reason], ['MEDIA_ISOLATION_CAUSE', cause]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(savedVars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  const get = async () => (await call(`${srv.url}/api/about`, { token })).body;

  const CAUSES = ['probe-failed', 'probe-timeout', 'missing-capability', 'layout-failed', 'top-level-leftover', 'bad-ids', 'other'];

  test('each fallback cause maps to its own fixed sentence, and the sentences are all different', async () => {
    const seen = new Set();
    for (const cause of CAUSES) {
      put('off', 'fallback', cause);
      const b = await get();
      assert.equal(b.mediaIsolation, 'off');
      assert.equal(b.mediaIsolationReason, 'fallback');
      assert.equal(typeof b.mediaIsolationDetail, 'string', cause);
      assert.ok(b.mediaIsolationDetail.length > 10 && b.mediaIsolationDetail.length < 200, cause);
      seen.add(b.mediaIsolationDetail);
    }
    assert.equal(seen.size, CAUSES.length, 'two causes share a sentence');
  });

  test('a cause that is not on the list (arbitrary text, a path, a name with spaces, a newline) is `other`, and is NEVER echoed', async () => {
    put('off', 'fallback', 'other');
    const generic = (await get()).mediaIsolationDetail;
    const MARKER = 'MARKER-7f3a';
    for (const bad of [
      `${MARKER}`, `/home/Alice Smith/data ${MARKER}`, `backup-20261001-0100.db ${MARKER}`, `probe-failed\n${MARKER}`,
      'Probe-Failed', ' probe-failed', '', 'constructor', '__proto__', 'toString', undefined,
    ]) {
      put('off', 'fallback', bad);
      const b = await get();
      assert.equal(b.mediaIsolationReason, 'fallback', JSON.stringify(bad));
      assert.equal(b.mediaIsolationDetail, generic, JSON.stringify(bad));
      assert.ok(!JSON.stringify(b).includes(MARKER), `a value from the environment was echoed: ${JSON.stringify(bad)}`);
    }
  });

  test('the old free-text variable is ignored: a planted MEDIA_ISOLATION_DETAIL never appears', async () => {
    process.env.MEDIA_ISOLATION_DETAIL = 'MARKER-detail /home/Alice Smith';
    for (const [reason, cause] of [['fallback', 'probe-failed'], ['id-clash', undefined], ['disabled', undefined]]) {
      put('off', reason, cause);
      const b = await get();
      assert.ok(!JSON.stringify(b).includes('MARKER-detail'), reason);
    }
  });

  test('`id-clash` has its own fixed sentence (it tells the admin what to change); `disabled` and `root` have none', async () => {
    put('off', 'id-clash', undefined);
    let b = await get();
    assert.equal(b.mediaIsolationReason, 'id-clash');
    assert.match(b.mediaIsolationDetail, /PUID or PGID is 1700/);
    for (const reason of ['disabled', 'root']) {
      // A cause left in the environment must not give a deliberate off a sentence.
      put('off', reason, 'probe-failed');
      b = await get();
      assert.equal(b.mediaIsolationReason, reason);
      assert.equal(b.mediaIsolationDetail, null, `${reason}: detail must be null`);
    }
  });

  test('on: both are null, even if the environment still carries a reason and a cause', async () => {
    put('on', 'fallback', 'probe-failed');
    const b = await get();
    assert.equal(b.mediaIsolation, 'on');
    assert.equal(b.mediaIsolationReason, null);
    assert.equal(b.mediaIsolationDetail, null);
  });

  test('an unknown or unset reason is null, with no detail', async () => {
    for (const bad of ['Fallback', 'FALLBACK', 'other', '', ' fallback', 'constructor', undefined]) {
      put('off', bad, 'probe-failed');
      const b = await get();
      assert.equal(b.mediaIsolationReason, null, JSON.stringify(bad));
      assert.equal(b.mediaIsolationDetail, null, JSON.stringify(bad));
    }
  });

  test('the existing fields are untouched (additive)', async () => {
    put('off', 'fallback', 'probe-failed');
    const b = await get();
    for (const k of ['version', 'gitSha', 'gitRef', 'buildTime', 'stunServers', 'publicBaseUrl', 'mediaIsolation', 'dataLayout', 'layoutConflict']) {
      assert.ok(k in b, `${k} went missing`);
    }
  });
});
