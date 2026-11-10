import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ipKeyGenerator } from 'express-rate-limit';
import { useTempDataDir, cleanupTempDataDirs, makeUser, mountRouter, call } from './helpers/harness.js';
import { clientBucketKey, _resetBucketLog } from '../src/lib/clientBucket.js';
import { setLoopbackExposed } from '../src/lib/loopbackExposure.js';
import { logger } from '../src/lib/logger.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { default: authRouter } = await import('../src/routes/auth.js');

let server;
before(async () => { server = await mountRouter('/api/auth', authRouter); });
after(async () => {
  setLoopbackExposed(false);
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});
afterEach(() => { setLoopbackExposed(false); _resetBucketLog(); });

const key = (ip, login, xff) => clientBucketKey({
  ip,
  headers: {
    ...(login !== undefined ? { 'tailscale-user-login': login } : {}),
    ...(xff !== undefined ? { 'x-forwarded-for': xff } : {}),
  },
});

test('without the daemon, spoofed identity never changes IPv4 or IPv6 subnet keys', () => {
  for (const ip of ['192.0.2.7', '2001:db8:1234:5678::9']) {
    assert.equal(key(ip, 'spoofed@example.com'), ipKeyGenerator(ip));
  }
  assert.equal(key('2001:db8:1234:5678::9'), key('2001:db8:1234:5678::a'));
});

test('only exposed loopback uses a case-folded, trimmed peer identity', () => {
  setLoopbackExposed(true);
  assert.equal(key('192.0.2.7', 'a@example.com'), ipKeyGenerator('192.0.2.7'));
  assert.equal(key('::ffff:127.0.0.1', 'a@example.com'), key('127.0.0.1', ' A@EXAMPLE.COM '));
  assert.notEqual(key('127.0.0.1', 'a@example.com'), key('127.0.0.1', 'b@example.com'));
});

test('ten thousand identities occupy at most 64 numeric slots', () => {
  setLoopbackExposed(true);
  const slots = new Set();
  for (let i = 0; i < 10000; i++) {
    const bucket = key('127.0.0.1', `random-${i}@example.com`);
    assert.match(bucket, /^tunnel:(\d|[1-5]\d|6[0-3])$/);
    slots.add(bucket);
  }
  assert.ok(slots.size <= 64);
});

test('missing and invalid identities use the shared address key without throwing', () => {
  setLoopbackExposed(true);
  for (const ip of ['127.0.0.1', '::1']) {
    for (const login of [undefined, '', '   ', ['a@example.com'], 42, {}]) {
      assert.equal(key(ip, login), ipKeyGenerator(ip));
    }
  }
  // A long non-empty string is accepted, but only its first 256 characters are considered.
  assert.equal(key('127.0.0.1', 'a'.repeat(5000)), key('127.0.0.1', 'a'.repeat(256)));
});

test('measurement logs each header combination once and never logs a header value', () => {
  _resetBucketLog();
  const start = logger.getRecent().length;
  setLoopbackExposed(true);
  for (const login of [undefined, 'secret-identity@example.com']) {
    for (const xff of [undefined, '198.51.100.9']) {
      key('127.0.0.1', login, xff);
      key('127.0.0.1', login, xff);
    }
  }
  const lines = logger.getRecent().slice(start).filter((line) => line.includes('[http] tunnel account bucket:'));
  assert.equal(lines.length, 4);
  assert.equal(new Set(lines.map((line) => line.slice(line.indexOf('[http] tunnel account bucket:')))).size, 4);
  for (const line of lines) {
    assert.doesNotMatch(line, /secret-identity|198\.51\.100\.9/);
  }
});

test('real login route separates peers by account while preserving the 100-request tunnel ceiling', async () => {
  makeUser(db, { id: 'bucket-user', username: 'bucket-user', role: 'admin', password: 'correct-password' });
  setLoopbackExposed(true);
  const login = (username, identity, password = 'wrong-password') => call(`${server.url}/api/auth/login`, {
    method: 'POST',
    body: { username, password },
    headers: identity ? { 'tailscale-user-login': identity } : {},
  });
  const peerA = 'a@example.com';
  const peerB = 'b@example.com';
  assert.notEqual(key('127.0.0.1', peerA), key('127.0.0.1', peerB));
  for (let i = 0; i < 20; i++) assert.equal((await login('bucket-user', peerA)).status, 401);
  assert.equal((await login('bucket-user', peerA)).status, 429);
  assert.equal((await login('bucket-user', peerB, 'correct-password')).status, 200);

  for (let i = 0; i < 10; i++) assert.equal((await login('headerless-user', undefined)).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await login('headerless-user', ' ')).status, 401);
  assert.equal((await login('headerless-user', undefined)).status, 429);

  // The account limiter has distinct keys here; only the shared per-client limiter can stop
  // the 101st request across many identities and usernames.
  for (let i = 0; i < 59; i++) {
    assert.equal((await login(`spray-${i}`, `peer-${i}@example.com`)).status, 401);
  }
  assert.equal((await login('spray-last', 'last@example.com')).status, 429);
});
