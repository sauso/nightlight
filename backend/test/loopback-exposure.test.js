// #959 real HTTP pins Express's compiled trust function and the login limiter's address key.
// Both tests fail on the old code: forged X-Forwarded-For remains trusted from loopback.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { useTempDataDir, cleanupTempDataDirs, makeUser, call } from './helpers/harness.js';
import { applyTrustProxy } from '../src/lib/trustProxy.js';
import { setLoopbackExposed, isLoopbackExposed, isLoopbackAddress } from '../src/lib/loopbackExposure.js';
import { logger } from '../src/lib/logger.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: authRouter, resetPasswordThrottles } = await import('../src/routes/auth.js');
afterEach(() => setLoopbackExposed(false));
after(() => { db.close(); cleanupTempDataDirs(); });

test('#959 exposure flag logs once per transition and rejects non-loopback addresses', () => {
  // Fails on the old code: the flag and address predicate did not exist.
  const before = logger.getRecent().length;
  setLoopbackExposed(true);
  setLoopbackExposed(true);
  assert.equal(isLoopbackExposed(), true);
  setLoopbackExposed(false);
  setLoopbackExposed(false);
  assert.deepEqual(logger.getRecent().slice(before).map((line) => line.match(/loopback exposed = (true|false)$/)?.[1]), ['true', 'false']);
  for (const addr of ['10.0.0.20', '::ffff:8.8.8.8', '::ffff:7eff:ffff', 'invalid', null]) {
    assert.equal(isLoopbackAddress(addr), false, String(addr));
  }
});

async function listen(app) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('#959 real HTTP toggles forwarded address trust on one live server', async () => {
  const app = express();
  applyTrustProxy(app);
  app.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
  const server = await listen(app);
  const from = () => call(`${server.url}/ip`, { headers: { 'x-forwarded-for': '8.8.8.8' } });
  try {
    assert.deepEqual((await from()).body, { ip: '8.8.8.8', ips: ['8.8.8.8'] });
    setLoopbackExposed(true);
    assert.equal(isLoopbackExposed(), true);
    assert.deepEqual((await from()).body, { ip: '127.0.0.1', ips: [] });
    setLoopbackExposed(false);
    assert.deepEqual((await from()).body, { ip: '8.8.8.8', ips: ['8.8.8.8'] });
  } finally {
    await server.close();
    setLoopbackExposed(false);
  }
});

test('#959 rotating forwarded addresses cannot reopen one login bucket while exposed', async () => {
  const username = 'gate-a-limiter-user';
  const user = makeUser(db, { id: 'gate-a-limiter-user', username, role: 'admin', password: 'correct-password' });
  const app = express();
  applyTrustProxy(app);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = await listen(app);
  const attempt = (number) => call(`${server.url}/api/auth/login`, {
    method: 'POST', body: { username, password: 'wrong-password' },
    headers: { 'x-forwarded-for': `198.51.100.${number}` },
  });
  try {
    setLoopbackExposed(true);
    for (let n = 1; n <= 20; n++) assert.equal((await attempt(n)).status, 401, `exposed attempt ${n}`);
    assert.equal((await attempt(21)).status, 429, '21st forged address escaped the per-address limit');

    // The account throttle is independent of the IP and reaches 30. Reset its spent failures so
    // this control isolates the per-address limiter, using the same username and only 21 attempts.
    resetPasswordThrottles(user.id, username);
    setLoopbackExposed(false);
    for (let n = 22; n <= 41; n++) assert.equal((await attempt(n)).status, 401, `control attempt ${n}`);
    assert.equal((await attempt(42)).status, 401, 'flag-off control unexpectedly used one address bucket');
  } finally {
    await server.close();
    setLoopbackExposed(false);
  }
});
