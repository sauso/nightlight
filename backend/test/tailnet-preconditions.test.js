import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, mountRouter, mountRouterTrustingProxy, call,
} from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: authRouter, setupBlockedByExposedLoopback } = await import('../src/routes/auth.js');
const { firstAdminExists, tailnetEnableBlocker } = await import('../src/lib/tailnetPreconditions.js');
const { setLoopbackExposed } = await import('../src/lib/loopbackExposure.js');
const { applyTrustProxy } = await import('../src/lib/trustProxy.js');
const { passwordWorkerStats } = await import('../src/lib/passwordHash.js');

let server;
let proxyConfigured = false;
before(async () => {
  // Mount the real router over HTTP and install the same Gate A trust wrapper as the app.
  server = await mountRouter('/api/auth', authRouter, {
    middleware: [(req, res, next) => {
      if (!proxyConfigured) {
        applyTrustProxy(req.app);
        proxyConfigured = true;
      }
      next();
    }],
  });
});
afterEach(() => {
  setLoopbackExposed(false);
  db.exec('DELETE FROM sessions; DELETE FROM users');
});
after(async () => {
  setLoopbackExposed(false);
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

const setupBody = { username: 'first-admin', password: 'a-long-enough-password' };
const setup = (headers = {}) => call(`${server.url}/api/auth/setup`, {
  method: 'POST', body: setupBody, headers,
});
const count = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

test('#963 no users or a lone caregiver blocks Tailscale until an admin exists', () => {
  assert.equal(firstAdminExists(db), false);
  assert.deepEqual(tailnetEnableBlocker(db), {
    code: 'no_admin',
    message: 'Create the first admin account on your home network before turning on Tailscale.',
  });
  // A plausible user row is hostile to an implementation that only counts users.
  makeUser(db, { id: 'caregiver-one', username: 'caregiver-one', role: 'caregiver' });
  assert.equal(firstAdminExists(db), false);
  assert.equal(tailnetEnableBlocker(db)?.code, 'no_admin');
  makeUser(db, { id: 'admin-one', username: 'admin-one', role: 'admin' });
  assert.equal(firstAdminExists(db), true);
  assert.equal(tailnetEnableBlocker(db), null);
});

test('#963 exposed loopback setup refuses forged forwarded LAN address without a user or session', async () => {
  const hashesBefore = passwordWorkerStats().submitted;
  try {
    setLoopbackExposed(true);
    const result = await setup({ 'x-forwarded-for': '192.168.1.50' });
    assert.equal(result.status, 403);
    // The refusal must come BEFORE the costly bcrypt hash, or a remote peer can make the server hash
    // for free; the after-hash guard alone would still answer 403 (Codex review of #964).
    assert.equal(passwordWorkerStats().submitted, hashesBefore, 'a refused setup still paid for a password hash');
    assert.deepEqual(result.body, {
      error: 'Finish setup from a device on your home network, not through Tailscale.',
    });
    assert.equal(count('users'), 0);
    assert.equal(count('sessions'), 0);
  } finally {
    setLoopbackExposed(false);
  }
});

test('#963 setup remains available from loopback when the exposure flag is off', async () => {
  const result = await setup();
  assert.equal(result.status, 200);
  assert.equal(result.body.user.role, 'admin');
  assert.equal(count('users'), 1);
});

test('#963 completed setup keeps its existing 400 even while exposed', async () => {
  makeUser(db);
  try {
    setLoopbackExposed(true);
    const result = await setup();
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'Setup already completed' });
    assert.equal(count('users'), 1);
  } finally {
    setLoopbackExposed(false);
  }
});

test('#963 exposed LAN caller is allowed by the setup guard', () => {
  // The harness listens on loopback only; an injected LAN req.ip pins the guard's direction.
  assert.equal(setupBlockedByExposedLoopback(true, '192.168.1.50'), false);
  assert.equal(setupBlockedByExposedLoopback(false, '127.0.0.1'), false);
  // index.js listens with app.listen(PORT), which is dual-stack, so a peer relayed to 127.0.0.1 can arrive
  // as ::ffff:127.0.0.1 (Opus review of #964: a guard comparing only '127.0.0.1' passed every other test).
  for (const loopback of ['127.0.0.1', '::ffff:127.0.0.1', '::1', '0:0:0:0:0:0:0:1']) {
    assert.equal(setupBlockedByExposedLoopback(true, loopback), true, loopback);
  }
});

test('#963 exposed setup from a LAN address is allowed by the route itself', async () => {
  // mountRouterTrustingProxy has no Gate A wrapper, so a forwarded address becomes req.ip: the route, not
  // just the predicate, must let a LAN caller through (Opus review of #964: a refuse-everyone mutant survived).
  const lan = await mountRouterTrustingProxy('/api/auth', authRouter);
  try {
    setLoopbackExposed(true);
    const result = await call(`${lan.url}/api/auth/setup`, {
      method: 'POST', body: setupBody, headers: { 'x-forwarded-for': '192.168.1.50' },
    });
    assert.equal(result.status, 200);
    assert.equal(count('users'), 1);
  } finally {
    setLoopbackExposed(false);
    await lan.close();
  }
});

test('#963 flag turning on during the setup hash refuses the insert', async () => {
  const beforeHash = passwordWorkerStats().submitted;
  try {
    const pendingSetup = setup();
    // The worker's pending counter proves the handler passed its first guard and reached
    // the await. Set the flag in the same event-loop turn before its answer can resume it.
    let inHash = false;
    for (let attempt = 0; attempt < 5000; attempt++) {
      const stats = passwordWorkerStats();
      if (stats.submitted > beforeHash && stats.pending > 0) {
        inHash = true;
        break;
      }
      await new Promise(setImmediate);
    }
    assert.equal(inHash, true, 'setup did not reach the password worker');
    setLoopbackExposed(true);
    const result = await pendingSetup;
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, {
      error: 'Finish setup from a device on your home network, not through Tailscale.',
    });
    assert.equal(count('users'), 0);
    assert.equal(count('sessions'), 0);
  } finally {
    setLoopbackExposed(false);
  }
});
