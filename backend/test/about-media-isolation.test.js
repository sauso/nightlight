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

// WHY isolation is off, as the entrypoint exported it (MEDIA_ISOLATION_REASON / _DETAIL), added next to mediaIsolation.
// The About page warns admins only for `fallback`; these tests are what keep a bad value from turning into a warning.
describe('GET /api/about: mediaIsolationReason and mediaIsolationDetail', () => {
  const savedReason = process.env.MEDIA_ISOLATION_REASON;
  const savedDetail = process.env.MEDIA_ISOLATION_DETAIL;
  const put = (isolation, reason, detail) => {
    for (const [k, v] of [['MEDIA_ISOLATION', isolation], ['MEDIA_ISOLATION_REASON', reason], ['MEDIA_ISOLATION_DETAIL', detail]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  afterEach(() => {
    for (const [k, v] of [['MEDIA_ISOLATION_REASON', savedReason], ['MEDIA_ISOLATION_DETAIL', savedDetail]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const get = async () => (await call(`${srv.url}/api/about`, { token })).body;

  test('each reason is reported as given; only a fallback carries the detail', async () => {
    put('off', 'fallback', 'the dry run failed');
    let b = await get();
    assert.equal(b.mediaIsolation, 'off');
    assert.equal(b.mediaIsolationReason, 'fallback');
    assert.equal(b.mediaIsolationDetail, 'the dry run failed');
    for (const reason of ['disabled', 'root', 'id-clash']) {
      // A detail the entrypoint never exports for these must not be shown even if it is in the environment.
      put('off', reason, 'stray detail');
      b = await get();
      assert.equal(b.mediaIsolationReason, reason);
      assert.equal(b.mediaIsolationDetail, null, `${reason}: detail must be null`);
    }
  });

  test('on: both are null, even if the environment still carries a reason', async () => {
    put('on', 'fallback', 'stale');
    const b = await get();
    assert.equal(b.mediaIsolation, 'on');
    assert.equal(b.mediaIsolationReason, null);
    assert.equal(b.mediaIsolationDetail, null);
  });

  test('garbage becomes null: an unknown reason, an unset one, and a fallback with no usable detail', async () => {
    for (const bad of ['Fallback', 'FALLBACK', 'other', '', ' fallback']) {
      put('off', bad, 'text');
      const b = await get();
      assert.equal(b.mediaIsolationReason, null, JSON.stringify(bad));
      assert.equal(b.mediaIsolationDetail, null, JSON.stringify(bad));
    }
    put('off', undefined, undefined);
    let b = await get();
    assert.equal(b.mediaIsolationReason, null);
    assert.equal(b.mediaIsolationDetail, null);
    for (const blank of [undefined, '', '  \n ']) {
      put('off', 'fallback', blank);
      b = await get();
      assert.equal(b.mediaIsolationReason, 'fallback');
      assert.equal(b.mediaIsolationDetail, null, JSON.stringify(blank));
    }
  });

  test('the detail is one line of at most 200 characters', async () => {
    put('off', 'fallback', `line one\nline two\u0007${'x'.repeat(300)}`);
    const b = await get();
    assert.equal(b.mediaIsolationDetail.length, 200);
    assert.ok(!/[\u0000-\u001f]/.test(b.mediaIsolationDetail));
    assert.ok(b.mediaIsolationDetail.startsWith('line one line two '));
  });

  test('the existing fields are untouched (additive)', async () => {
    put('off', 'fallback', 'd');
    const b = await get();
    for (const k of ['version', 'gitSha', 'gitRef', 'buildTime', 'stunServers', 'publicBaseUrl', 'mediaIsolation', 'dataLayout', 'layoutConflict']) {
      assert.ok(k in b, `${k} went missing`);
    }
  });
});
