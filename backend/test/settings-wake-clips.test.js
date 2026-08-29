// The wake-clip settings: round-trip, bounds, and admin-only.
//
// The round-trip test earns its place beyond the obvious: settings are saved by one long hand-written
// UPDATE with positional placeholders, so adding a column means adding a `= ?` AND a bind argument in
// the matching position. Get that wrong and better-sqlite3 throws at runtime, on the save path, for
// every setting — not just the new ones. A regex can't check that; a real PUT can.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: settingsRouter } = await import('../src/routes/settings.js');

let server;
let adminToken;
let caregiverToken;

const get = () => db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
const put = (body, token = adminToken) =>
  call(`${server.url}/api/settings`, { method: 'PUT', token, body });

before(async () => {
  server = await mountRouter('/api/settings', settingsRouter);
});

after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  const care = makeUser(db, { id: 'u-c', username: 'nanny', role: 'caregiver' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
  caregiverToken = signToken({ id: care.id, username: care.username, role: 'caregiver', sid: makeSession(db, care.id) });
  db.prepare(
    'UPDATE settings SET wake_clips_enabled = 1, wake_clip_seconds = 30, wake_clip_retention_days = 14 WHERE id = ?'
  ).run('app');
});

describe('defaults', () => {
  test('wake clips are on, 30s, kept 14 days', () => {
    const s = get();
    assert.equal(s.wake_clips_enabled, 1);
    assert.equal(s.wake_clip_seconds, 30);
    assert.equal(s.wake_clip_retention_days, 14);
  });
});

describe('saving', () => {
  test('the three values round-trip', async () => {
    const r = await put({ wake_clips_enabled: false, wake_clip_seconds: 45, wake_clip_retention_days: 7 });
    assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const s = get();
    assert.equal(s.wake_clips_enabled, 0);
    assert.equal(s.wake_clip_seconds, 45);
    assert.equal(s.wake_clip_retention_days, 7);
  });

  test('saving unrelated settings leaves the wake-clip ones alone', async () => {
    // The positional-UPDATE hazard in reverse: a mis-ordered bind would quietly overwrite these with
    // some other field's value.
    await put({ wake_clip_seconds: 45 });
    const r = await put({ app_name: 'Casa' });
    assert.equal(r.status, 200);
    const s = get();
    assert.equal(s.app_name, 'Casa');
    assert.equal(s.wake_clip_seconds, 45, 'an unrelated save must not disturb wake-clip settings');
    assert.equal(s.wake_clips_enabled, 1);
  });

  test('0 days is accepted and means keep forever', async () => {
    const r = await put({ wake_clip_retention_days: 0 });
    assert.equal(r.status, 200);
    assert.equal(get().wake_clip_retention_days, 0);
  });
});

describe('bounds', () => {
  test('a clip shorter than 5s is refused', async () => {
    const r = await put({ wake_clip_seconds: 2 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /between 5 and 120 seconds/);
    assert.equal(get().wake_clip_seconds, 30, 'nothing is saved when validation fails');
  });

  test('a clip longer than 120s is refused — the point is a BOUNDED clip', async () => {
    // Wakes average ~19 minutes; capturing them end to end would be ~1.1 GiB/night.
    const r = await put({ wake_clip_seconds: 1200 });
    assert.equal(r.status, 400);
    assert.equal(get().wake_clip_seconds, 30);
  });

  test('a non-numeric length is refused rather than stored as NaN', async () => {
    const r = await put({ wake_clip_seconds: 'thirty' });
    assert.equal(r.status, 400);
    assert.equal(get().wake_clip_seconds, 30);
  });

  test('retention over a year is refused', async () => {
    const r = await put({ wake_clip_retention_days: 400 });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /0 and 365 days/);
  });

  test('negative retention is refused', async () => {
    assert.equal((await put({ wake_clip_retention_days: -1 })).status, 400);
  });

  test('the bounds are inclusive at both ends', async () => {
    assert.equal((await put({ wake_clip_seconds: 5 })).status, 200);
    assert.equal(get().wake_clip_seconds, 5);
    assert.equal((await put({ wake_clip_seconds: 120 })).status, 200);
    assert.equal(get().wake_clip_seconds, 120);
    assert.equal((await put({ wake_clip_retention_days: 365 })).status, 200);
  });
});

describe('permissions', () => {
  test('a caregiver cannot change recording settings', async () => {
    const r = await put({ wake_clips_enabled: false }, caregiverToken);
    assert.equal(r.status, 403);
    assert.equal(get().wake_clips_enabled, 1, 'unchanged');
  });

  test('an unauthenticated request cannot either', async () => {
    const r = await call(`${server.url}/api/settings`, { method: 'PUT', body: { wake_clips_enabled: false } });
    assert.equal(r.status, 401);
    assert.equal(get().wake_clips_enabled, 1);
  });
});
