import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: router } = await import('../src/routes/setup.js');
const { demoGuard } = await import('../src/middleware/demoMode.js');
const { logger } = await import('../src/lib/logger.js');
const CAMERA = '11111111-1111-4111-8111-111111111111';
let server;
let admin;
let otherAdmin;
let caregiver;
const request = (path = '', { method = 'GET', body, token = admin } = {}) =>
  call(`${server.url}/api/setup${path}`, { method, body, token });

before(async () => { server = await mountRouter('/api/setup', router, { middleware: [demoGuard] }); });
beforeEach(() => {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare("UPDATE setup_state SET status = 'not_started', active_step = 'welcome', row_version = 0 WHERE id = 'app'").run();
  const a = makeUser(db, { id: 'a', username: 'admin-a', role: 'admin' });
  const b = makeUser(db, { id: 'b', username: 'admin-b', role: 'admin' });
  const c = makeUser(db, { id: 'c', username: 'caregiver', role: 'caregiver' });
  admin = signToken({ id: a.id, sid: makeSession(db, a.id), role: a.role });
  otherAdmin = signToken({ id: b.id, sid: makeSession(db, b.id), role: b.role });
  caregiver = signToken({ id: c.id, sid: makeSession(db, c.id), role: c.role });
});
after(async () => { await server.close(); db.close(); cleanupTempDataDirs(); });

test('only an admin reaches each setup endpoint, and GET has the agreed shape', async () => {
  // WHY: a caregiver token carries a live session but must not read or attest setup state.
  const paths = [
    ['', 'GET'], ['/progress', 'PATCH'], ['/monitor-tests', 'POST'],
    ['/monitor-tests/11111111-1111-4111-8111-111111111111/confirm', 'POST'], ['/complete', 'POST'],
  ];
  for (const [path, method] of paths) {
    assert.equal((await request(path, { method, token: null })).status, 401);
    assert.equal((await request(path, { method, token: caregiver })).status, 403);
  }
  const got = await request();
  assert.equal(got.status, 200);
  assert.deepEqual(Object.keys(got.body).sort(), ['status', 'activeStep', 'flowVersion', 'rowVersion', 'steps', 'readiness'].sort());
  assert.deepEqual(got.body.steps, ['welcome', 'children', 'camera', 'monitor_test', 'caregivers', 'remote', 'review']);
  assert.deepEqual(got.body.readiness.missing, ['CHILD', 'CAMERA', 'PLAYBACK']);
  const raw = await fetch(`${server.url}/api/setup`, { headers: { authorization: `Bearer ${admin}` } });
  assert.match(raw.headers.get('cache-control'), /private.*no-store/);
  assert.match(raw.headers.get('vary'), /Authorization/i);
});

test('progress rejects stale versions and malformed bodies; completion needs proof or explicit limited choice', async () => {
  // WHY: a forged version or an omitted limited choice cannot turn incomplete setup into completed.
  assert.equal((await request('/progress', { method: 'PATCH', body: { activeStep: 'children', expectedRowVersion: 0, extra: 1 } })).status, 400);
  const moved = await request('/progress', { method: 'PATCH', body: { activeStep: 'children', expectedRowVersion: 0 } });
  assert.equal(moved.body.status, 'in_progress');
  assert.equal((await request('/progress', { method: 'PATCH', body: { activeStep: 'camera', expectedRowVersion: 0 } })).status, 409);
  const refused = await request('/complete', { method: 'POST', body: {} });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: 'Complete the missing setup steps first.', code: 'NOT_READY', missing: ['CHILD', 'CAMERA', 'PLAYBACK'] });
  assert.equal((await request('/complete', { method: 'POST' })).body.code, 'NOT_READY');
  assert.deepEqual((await request('/complete', { method: 'POST', body: { limited: true } })).body, { status: 'completed_limited' });
});

test('optional progress steps are accepted and unknown steps are rejected', async () => {
  const caregivers = await request('/progress', { method: 'PATCH', body: { activeStep: 'caregivers', expectedRowVersion: 0 } });
  assert.equal(caregivers.status, 200);
  const remote = await request('/progress', { method: 'PATCH', body: { activeStep: 'remote', expectedRowVersion: 1 } });
  assert.equal(remote.body.activeStep, 'remote');
  assert.equal((await request('/progress', { method: 'PATCH', body: { activeStep: 'unknown', expectedRowVersion: 2 } })).status, 400);
});

test('a stored old step still reads after the flow grows', async () => {
  db.prepare("UPDATE setup_state SET active_step = 'camera' WHERE id = 'app'").run();
  assert.equal((await request()).body.activeStep, 'camera');
});

test('legacy install is reported without a redirect flag or progress mutation', async () => {
  // WHY: pre-existing installations use a manual Settings entry, never an automatic handoff.
  db.prepare("UPDATE setup_state SET status = 'legacy_completed', active_step = 'review' WHERE id = 'app'").run();
  const got = await request();
  assert.equal(got.body.status, 'legacy_completed');
  assert.equal(got.body.activeStep, 'review');
  assert.ok(!('redirect' in got.body));
  assert.equal((await request('/progress', { method: 'PATCH', body: { activeStep: 'welcome', expectedRowVersion: 0 } })).status, 409);
  assert.equal(db.prepare("SELECT status, active_step FROM setup_state WHERE id = 'app'").get().active_step, 'review');
});

test('a camera proof is session-bound and leaks no camera field in responses or logs', async () => {
  // WHY: a credential-like marker in every camera TEXT column exposes accidental row spreading.
  db.prepare("INSERT INTO children (id, name) VALUES ('child', 'a child')").run();
  db.prepare('INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES (?, ?, ?, ?, ?)')
    .run(CAMERA, 'a camera', 'rtsp://camera', 'child', 'path');
  const marker = 'SECRET_SETUP_MARKER';
  const logCount = logger.getRecent().length;
  const protectedColumns = db.prepare('PRAGMA table_info(cameras)').all()
    .filter((column) => /TEXT/i.test(column.type) && !['id', 'child_id', 'mediamtx_path', 'created_at'].includes(column.name));
  for (const column of protectedColumns) db.prepare(`UPDATE cameras SET ${column.name} = ? WHERE id = ?`).run(`${marker}_${column.name}`, CAMERA);
  const started = await request('/monitor-tests', { method: 'POST', body: { cameraId: CAMERA } });
  assert.equal(started.status, 200);
  assert.equal((await request()).body.readiness.playbackAttested, false);
  const early = await request('/complete', { method: 'POST', body: {} });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'NOT_READY');
  assert.deepEqual(early.body.missing, ['PLAYBACK']);
  assert.deepEqual(Object.keys(started.body).sort(), ['testId', 'expiresAt'].sort());
  const path = `/monitor-tests/${started.body.testId}/confirm`;
  assert.equal((await request(path, { method: 'POST', body: { cameraId: CAMERA }, token: otherAdmin })).status, 409);
  assert.deepEqual((await request(path, { method: 'POST', body: { cameraId: CAMERA } })).body, { ok: true });
  assert.equal((await request(path, { method: 'POST', body: { cameraId: CAMERA } })).status, 409);
  const got = await request();
  assert.equal(got.body.readiness.ready, true);
  const completed = await request('/complete', { method: 'POST', body: {} });
  assert.deepEqual(completed.body, { status: 'completed' });
  for (const response of [started, got, completed]) assert.doesNotMatch(JSON.stringify(response.body), /SECRET_SETUP_MARKER/);
  for (const line of logger.getRecent().slice(logCount)) assert.doesNotMatch(line, /SECRET_SETUP_MARKER/);
});

test('completion rejects non-boolean limited choices', async () => {
  for (const limited of ['false', 0]) {
    const response = await request('/complete', { method: 'POST', body: { limited } });
    assert.equal(response.status, 400);
  }
});

test('demo mode blocks each write even for an admin, but still permits GET', async () => {
  // WHY: the demo account itself is admin, so the role gate alone does not make it read-only.
  process.env.DEMO_MODE = 'true';
  try {
    assert.equal((await request()).status, 200);
    for (const [path, method] of [['/progress', 'PATCH'], ['/monitor-tests', 'POST'], ['/monitor-tests/11111111-1111-4111-8111-111111111111/confirm', 'POST'], ['/complete', 'POST']]) {
      assert.equal((await request(path, { method, body: {} })).status, 403);
    }
  } finally { delete process.env.DEMO_MODE; }
});

test('monitor tests have a separate budget from password login', async () => {
  // WHY: repeatedly checking video must not lock an admin out of the account.
  const { default: express } = await import('express');
  const { default: authRouter } = await import('../src/routes/auth.js');
  const combined = express.Router();
  combined.use('/setup', router);
  combined.use('/auth', authRouter);
  const extra = await mountRouter('/api', combined);
  try {
    for (let i = 0; i < 20; i++) {
      const result = await call(`${extra.url}/api/setup/monitor-tests`, {
        method: 'POST', token: admin, body: { cameraId: '22222222-2222-4222-8222-222222222222' },
      });
      assert.equal(result.status, 404);
    }
    const login = await call(`${extra.url}/api/auth/login`, {
      method: 'POST', body: { username: 'admin-a', password: 'hunter22' },
    });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
  } finally { await extra.close(); }
});
