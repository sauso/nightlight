// #765: POST /me/mfa/setup is idempotent while an enrolment is pending, so a page reload mid-set-up (a phone
// returning from its authenticator app) can show the SAME secret instead of replacing the one the person has
// already added to their authenticator. Real database, real HTTP, real otplib; nothing mocked.
//
// How each case was shown to fail: run against the old route (a new secret on every call) the "same secret",
// "resumed" and "last step untouched" cases fail; with the `restart` handling removed the restart case fails.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, mountRouterTrustingProxy, signToken, call,
} from './helpers/harness.js';

const dataDir = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { generateSync } = await import('otplib');

let server;
let token;
let adminToken;
before(async () => {
  server = await mountRouterTrustingProxy('/api/auth', authRouter);
  makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  adminToken = signToken({ id: 'u-admin', username: 'admin', role: 'admin', sid: makeSession(db, 'u-admin') });
});
after(async () => { await server?.close(); db.close(); cleanupTempDataDirs(); });

const row = () => db.prepare("SELECT mfa_enabled, mfa_secret, mfa_last_step FROM users WHERE id = 'u-pend'").get();
const setup = (body) => call(`${server.url}/api/auth/me/mfa/setup`, { method: 'POST', token, body });
const enable = (code) => call(`${server.url}/api/auth/me/mfa/enable`, { method: 'POST', token, body: { code } });
const status = () => call(`${server.url}/api/auth/me/mfa`, { token });

beforeEach(() => {
  db.prepare("DELETE FROM users WHERE id = 'u-pend'").run();
  makeUser(db, { id: 'u-pend', username: 'pending-user', role: 'caregiver' });
  token = signToken({ id: 'u-pend', username: 'pending-user', role: 'caregiver', sid: makeSession(db, 'u-pend') });
});

describe('POST /me/mfa/setup while an enrolment is pending', () => {
  test('★ a second call returns the SAME secret, uri and qr, marked resumed, and leaves mfa_last_step alone', async () => {
    const first = await setup({});
    assert.equal(first.status, 200);
    assert.equal(first.body.resumed, undefined, 'a fresh secret is not "resumed"');
    db.prepare("UPDATE users SET mfa_last_step = 12345 WHERE id = 'u-pend'").run();

    const second = await setup({});
    assert.equal(second.status, 200);
    assert.equal(second.body.secret, first.body.secret, 'the pending secret was replaced');
    assert.equal(second.body.otpauth_uri, first.body.otpauth_uri);
    assert.equal(second.body.qr, first.body.qr);
    assert.equal(second.body.resumed, true);
    assert.equal(row().mfa_secret, first.body.secret);
    assert.equal(row().mfa_last_step, 12345, 'a resume must not clear the replay guard');
  });

  test('★ a code from the resumed secret confirms through /me/mfa/enable', async () => {
    await setup({});
    const { body } = await setup({}); // the reload
    const res = await enable(generateSync({ secret: body.secret }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.backup_codes.length, 10);
    assert.equal(row().mfa_enabled, 1);
  });

  test('★ restart: true returns a DIFFERENT secret, stores it and clears mfa_last_step', async () => {
    const first = await setup({});
    db.prepare("UPDATE users SET mfa_last_step = 12345 WHERE id = 'u-pend'").run();
    const again = await setup({ restart: true });
    assert.equal(again.status, 200);
    assert.notEqual(again.body.secret, first.body.secret);
    assert.equal(again.body.resumed, undefined);
    assert.equal(row().mfa_secret, again.body.secret);
    assert.equal(row().mfa_last_step, null);
  });

  test('only the boolean true restarts: "true", 1 and false resume', async () => {
    const first = await setup({});
    for (const restart of ['true', 1, false, null]) {
      const res = await setup({ restart });
      assert.equal(res.body.secret, first.body.secret, `restart=${JSON.stringify(restart)} rotated the secret`);
    }
  });

  test('after a start-over, a code for the OLD secret no longer confirms', async () => {
    const first = await setup({});
    const second = await setup({ restart: true });
    assert.notEqual(second.body.secret, first.body.secret);
    const res = await enable(generateSync({ secret: first.body.secret }));
    assert.equal(res.status, 400);
    assert.equal(row().mfa_enabled, 0);
  });

  test('setup on an account with two-factor on is still 400, with or without restart', async () => {
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = 'KEEPME' WHERE id = 'u-pend'").run();
    for (const body of [{}, { restart: true }]) {
      const res = await setup(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Two-factor is already on. Turn it off first to re-enrol.');
    }
    assert.equal(row().mfa_secret, 'KEEPME');
  });
});

describe('a pending secret does not survive the paths that clear two-factor', () => {
  test('turning two-factor off clears it', async () => {
    // Pending, then enabled, then off: the next set-up must be fresh, not a resume of the old key.
    const first = await setup({});
    assert.equal((await enable(generateSync({ secret: first.body.secret }))).status, 200);
    const off = await call(`${server.url}/api/auth/me/mfa/disable`, { method: 'POST', token, body: { password: 'hunter22' } });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const next = await setup({});
    assert.notEqual(next.body.secret, first.body.secret);
    assert.equal(next.body.resumed, undefined);
  });

  test('the admin reset clears a pending secret', async () => {
    const first = await setup({});
    const del = await call(`${server.url}/api/auth/users/u-pend/mfa`, { method: 'DELETE', token: adminToken });
    assert.equal(del.status, 200);
    assert.equal(row().mfa_secret, null);
    assert.equal((await status()).body.setup_pending, false);
    const next = await setup({});
    assert.notEqual(next.body.secret, first.body.secret);
    assert.equal(next.body.resumed, undefined);
  });

  test('the console reset script (--all, and by username) clears a pending secret', async () => {
    const script = fileURLToPath(new URL('../src/scripts/reset-mfa.js', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, DATA_DIR: dataDir }, encoding: 'utf8' });
    await setup({});
    assert.ok(row().mfa_secret);
    const all = run('--all');
    assert.equal(all.status, 0, all.stderr);
    assert.equal(row().mfa_secret, null, '--all left a pending secret behind');
    await setup({});
    const one = run('pending-user');
    assert.equal(one.status, 0, one.stderr);
    assert.equal(row().mfa_secret, null);
  });
});

describe('GET /me/mfa setup_pending', () => {
  test('false with nothing pending, true after setup, false once enabled, and the secret is never in it', async () => {
    assert.equal((await status()).body.setup_pending, false);
    const { body } = await setup({});
    const pending = await status();
    assert.equal(pending.body.setup_pending, true);
    assert.ok(!JSON.stringify(pending.body).includes(body.secret), 'the status response carried the secret');
    assert.equal(pending.body.secret, undefined);
    await enable(generateSync({ secret: body.secret }));
    const on = await status();
    assert.equal(on.body.enabled, true);
    assert.equal(on.body.setup_pending, false);
  });
});
