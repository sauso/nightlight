// #765: POST /me/mfa/setup is idempotent while an enrolment is pending, so a page reload mid-set-up (a phone
// returning from its authenticator app) can show the SAME secret instead of replacing the one the person has
// already added to their authenticator. Real database, real HTTP, real otplib; nothing mocked.
//
// How each case was shown to fail: run against the old route (a new secret on every call) the "same secret",
// "resumed" and "last step untouched" cases fail; with the `restart` handling removed the restart case fails.
// The review-round cases (the password on every call, its limiter, the re-reads after the awaits, a password
// change discarding a pending set-up, a legacy pending secret) each say what they fail without.
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
const { isLegacySecret } = await import('../src/lib/mfa.js');
const passwordHash = await import('../src/lib/passwordHash.js');
const { generateSync } = await import('otplib');

// makeUser's default password: every set-up call needs it (review of #765).
const PASSWORD = 'hunter22';

let server;
let token;
let adminToken;
before(async () => {
  server = await mountRouterTrustingProxy('/api/auth', authRouter);
  makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  adminToken = signToken({ id: 'u-admin', username: 'admin', role: 'admin', sid: makeSession(db, 'u-admin') });
});
after(async () => { await server?.close(); db.close(); cleanupTempDataDirs(); });

// A fresh source address per request unless a case names one: set-up is rate limited per source + account
// (the same in-memory buckets as turning two-factor off), and every case here reuses the account 'u-pend', so
// without this the cases would spend one shared budget and 429 each other in file order.
let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1)}`;

const row = () => db.prepare("SELECT mfa_enabled, mfa_secret, mfa_last_step FROM users WHERE id = 'u-pend'").get();
// Sends the right password unless the body overrides it; `{ password: undefined }` sends none at all (JSON drops it).
const setup = (body = {}, { ip = freshIp(), as = token } = {}) =>
  call(`${server.url}/api/auth/me/mfa/setup`, {
    method: 'POST', token: as, body: { password: PASSWORD, ...body }, headers: { 'x-forwarded-for': ip },
  });
const resume = (opts) => setup({}, opts);
const enable = (code) => call(`${server.url}/api/auth/me/mfa/enable`, { method: 'POST', token, body: { code } });
const status = () => call(`${server.url}/api/auth/me/mfa`, { token });

// Sends a request whose handler awaits bcrypt and runs `meanwhile()` while it is provably parked there. A copy
// of the helper in mfa-replay-and-async-bcrypt.test.js (see its comment): a slow job of the test's own goes
// into the one worker first, so once the request's own job is queued behind it the handler cannot resume.
async function whileHandlerAwaitsBcrypt(send, meanwhile) {
  const blocker = passwordHash.hash('blocker', 12);
  const submittedBefore = passwordHash.passwordWorkerStats().submitted;
  let settled = false;
  const response = send().finally(() => { settled = true; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { submitted, pending } = passwordHash.passwordWorkerStats();
    if (submitted > submittedBefore && pending > 0) break;
    if (settled || Date.now() > deadline) throw new Error('the request never reached its bcrypt call while the blocker was running');
    await new Promise((r) => setTimeout(r, 1));
  }
  await meanwhile();
  assert.equal(settled, false, 'precondition: the request finished before the interference, so this case proves nothing');
  await blocker;
  return response;
}

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

    const second = await resume();
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
    const { body } = await resume(); // the reload
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
      const res = await setup({ restart, password: PASSWORD });
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

// Review of #765 (Opus, verified by running; owner's decision): once set-up hands a pending secret back, ANY
// live session of the account (a borrowed unlocked phone) could READ the owner's pending secret, or PLANT one it
// knows (start or restart) for the owner's "Continue set-up" to show and the owner to confirm. Either way it can
// later make valid codes. So every call needs the password. Each case FAILS on a passwordless set-up.
describe('every set-up call needs the account password', () => {
  const REFUSED = [{ password: undefined }, { password: 'not-the-password' }, { password: '' }, { password: null }];

  test('★ a first start without the right password: 400 "Password is incorrect", and nothing is stored (no plant)', async () => {
    for (const body of REFUSED) {
      const res = await setup(body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} started a set-up: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, { error: 'Password is incorrect' });
    }
    assert.equal(row().mfa_secret, null, 'a refused start stored a secret');
    const ok = await setup({});
    assert.equal(ok.status, 200, 'the right password starts it');
    assert.equal(row().mfa_secret, ok.body.secret);
  });

  test('★ a resume or a restart without the right password: 400, the secret is in no part of the answer, nothing rotates', async () => {
    const first = await setup({});
    for (const extra of [{}, { restart: true }]) {
      for (const body of REFUSED) {
        const res = await setup({ ...extra, ...body });
        assert.equal(res.status, 400, `${JSON.stringify({ ...extra, ...body })}: ${JSON.stringify(res.body)}`);
        assert.deepEqual(res.body, { error: 'Password is incorrect' });
        assert.ok(!JSON.stringify(res.body).includes(first.body.secret));
      }
    }
    assert.equal(row().mfa_secret, first.body.secret, 'a refused call replaced the pending secret');
  });

  test('a session of the account that does not know the password can neither read nor replace the pending secret; the owner can', async () => {
    const first = await setup({});
    const borrowed = signToken({ id: 'u-pend', username: 'pending-user', role: 'caregiver', sid: makeSession(db, 'u-pend') });
    for (const body of [{ password: undefined }, { password: undefined, restart: true }]) {
      const theirs = await setup(body, { as: borrowed });
      assert.equal(theirs.status, 400);
      assert.equal(theirs.body.secret, undefined);
    }
    assert.equal(row().mfa_secret, first.body.secret);
    const mine = await resume();
    assert.equal(mine.status, 200);
    assert.equal(mine.body.secret, first.body.secret);
    assert.equal(mine.body.resumed, true);
  });

  // FAILS WITHOUT the limiter on the route (21 x 400, no 429).
  test('★ set-up calls are limited per source + account (20), whatever their path', async () => {
    const ip = freshIp();
    const statuses = [(await setup({}, { ip })).status, (await setup({ restart: true }, { ip })).status];
    for (let i = 0; i < 19; i += 1) statuses.push((await setup({ password: 'wrong' }, { ip })).status);
    assert.deepEqual(statuses.slice(0, 2), [200, 200]);
    assert.equal(statuses.filter((s) => s === 400).length, 18);
    assert.equal(statuses[20], 429);
    assert.equal((await resume({ ip })).status, 429, 'the right password is refused too: it is the limiter refusing');
    assert.equal((await resume()).status, 200, 'another source is not affected');
  });

  test('the budget is the same one turning two-factor off spends (one budget for guessing this password)', async () => {
    const ip = freshIp();
    await setup({});
    for (let i = 0; i < 10; i += 1) {
      const off = await call(`${server.url}/api/auth/me/mfa/disable`, {
        method: 'POST', token, body: { password: 'wrong' }, headers: { 'x-forwarded-for': ip },
      });
      assert.equal(off.status, 400);
    }
    for (let i = 0; i < 10; i += 1) assert.equal((await setup({ password: 'wrong' }, { ip })).status, 400);
    assert.equal((await setup({ password: 'wrong' }, { ip })).status, 429);
  });
});

// Review of #765 (Codex): set-up reads the row and then awaits (the password check, then the QR). The answer is
// decided from the row as it is AFTER the last await, and a rotation is a compare-and-set. Each case FAILS
// without its guard: the stale secret was handed out, or an active one replaced.
describe('the row changes while set-up awaits', () => {
  // FAILS WITHOUT `AND mfa_enabled = 0` on the rotation (the status is 400 either way, from the re-read; the
  // stored secret is what tells them apart): the restart replaced the ACTIVE secret, a lockout at the code step.
  // A restart, not a start: /me/mfa/enable switches on the PENDING secret, so the secret the rotation compares
  // is unchanged and only the mfa_enabled clause can refuse.
  test('★ two-factor switched on during a RESTART\'s password check: 400 "already on", and the active secret is kept', async () => {
    const pending = (await setup({})).body.secret;
    const res = await whileHandlerAwaitsBcrypt(
      () => setup({ restart: true }),
      // The write that completes /me/mfa/enable for the pending secret.
      () => { db.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = 'u-pend'").run(); },
    );
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Two-factor is already on. Turn it off first to re-enrol.' });
    assert.equal(row().mfa_secret, pending, 'the restart replaced an active secret');
  });

  // FAILS WITHOUT `AND mfa_secret IS ?` on the rotation: the start overwrote the other set-up's secret and
  // answered 200, so the device that stored it holds a key that can never confirm (review of #765).
  test('★ another set-up stored its secret during a START\'s password check: 400 "changed meanwhile", that secret is kept', async () => {
    const OTHER = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const res = await whileHandlerAwaitsBcrypt(
      () => setup({}),
      () => { db.prepare("UPDATE users SET mfa_secret = ? WHERE id = 'u-pend'").run(OTHER); },
    );
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: 'The set-up was changed meanwhile, on this or another device. Try again.' });
    assert.equal(row().mfa_secret, OTHER, 'the start replaced the other set-up\'s secret');
  });

  test('two simultaneous starts: one 200, the other 400, and the stored key is the one the 200 handed out', async () => {
    const results = await Promise.all([setup({}), setup({})]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400], JSON.stringify(results.map((r) => r.body)));
    const loser = results.find((r) => r.status === 400);
    assert.deepEqual(loser.body, { error: 'The set-up was changed meanwhile, on this or another device. Try again.' });
    assert.equal(row().mfa_secret, results.find((r) => r.status === 200).body.secret);
  });

  test('★ two-factor switched on meanwhile: 400 "already on", the now-ACTIVE secret is not handed out', async () => {
    const first = await setup({});
    const res = await whileHandlerAwaitsBcrypt(
      () => resume(),
      // The write that completes /me/mfa/enable for the same secret.
      () => { db.prepare("UPDATE users SET mfa_enabled = 1 WHERE id = 'u-pend'").run(); },
    );
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Two-factor is already on. Turn it off first to re-enrol.' });
    assert.equal(row().mfa_secret, first.body.secret, 'precondition: the enabled secret is the one that was pending');
  });

  test('the pending secret replaced or cleared meanwhile: 400, and neither the old nor the new secret is handed out', async () => {
    for (const change of ["UPDATE users SET mfa_secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' WHERE id = 'u-pend'", "UPDATE users SET mfa_secret = NULL WHERE id = 'u-pend'"]) {
      db.prepare("UPDATE users SET mfa_secret = NULL WHERE id = 'u-pend'").run();
      const first = await setup({});
      const res = await whileHandlerAwaitsBcrypt(() => resume(), () => { db.prepare(change).run(); });
      assert.equal(res.status, 400, `${change}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, { error: 'The set-up was changed meanwhile, on this or another device. Try again.' });
      assert.ok(!JSON.stringify(res.body).includes(first.body.secret));
    }
  });

  test('the requesting session signed out meanwhile: 401, no secret (FAILS without signInEnded in set-up)', async () => {
    await setup({});
    const sid = makeSession(db, 'u-pend');
    const leaving = signToken({ id: 'u-pend', username: 'pending-user', role: 'caregiver', sid });
    const res = await whileHandlerAwaitsBcrypt(
      () => resume({ as: leaving }),
      () => { db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); },
    );
    assert.equal(res.status, 401);
    assert.equal(res.body.secret, undefined);
  });

  // FAILS WITHOUT the signInEnded between the password check and the write: the 401 still comes (from the
  // re-check before the answer), but a secret had been stored for a device that was already signed out.
  test('a START whose session signed out during the password check stores nothing', async () => {
    const sid = makeSession(db, 'u-pend');
    const leaving = signToken({ id: 'u-pend', username: 'pending-user', role: 'caregiver', sid });
    const res = await whileHandlerAwaitsBcrypt(
      () => setup({}, { as: leaving }),
      () => { db.prepare('DELETE FROM sessions WHERE id = ?').run(sid); },
    );
    assert.equal(res.status, 401);
    assert.equal(row().mfa_secret, null, 'a signed-out session stored a set-up secret');
  });
});

// Review of #765: a password change is "exactly the move someone makes when a logged-in device is lost" (the
// /me/password comment), and that device may have read the pending key, so a pending set-up is discarded with
// the old password. An account whose two-factor is ON keeps its secret: that one is protected by the second
// factor itself. Each "discards" case FAILS without the clearing statement in its route.
describe('a password change discards a pending set-up, and only a pending one', () => {
  const ENABLED_SECRET = 'KRUGS4ZANFZSA2LOEBUGK4TFEBRGKY3BOVZWKIDJ';
  const changeOwn = () => call(`${server.url}/api/auth/me/password`, {
    method: 'PUT', token, body: { current_password: PASSWORD, new_password: 'a-new-long-password' }, headers: { 'x-forwarded-for': freshIp() },
  });
  const adminPut = (body) => call(`${server.url}/api/auth/users/u-pend`, { method: 'PUT', token: adminToken, body });

  test('★ changing your own password clears it (secret and replay step)', async () => {
    await setup({});
    db.prepare("UPDATE users SET mfa_last_step = 4242 WHERE id = 'u-pend'").run();
    const res = await changeOwn();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().mfa_secret, null);
    assert.equal(row().mfa_last_step, null);
    assert.equal((await status()).body.setup_pending, false);
  });

  test('★ an admin password reset clears it', async () => {
    await setup({});
    const res = await adminPut({ password: 'an-admin-set-password' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(row().mfa_secret, null);
    assert.equal(row().mfa_last_step, null);
  });

  test('an admin edit WITHOUT a password leaves a pending set-up alone', async () => {
    const first = await setup({});
    assert.equal((await adminPut({ first_name: 'Renamed' })).status, 200);
    assert.equal(row().mfa_secret, first.body.secret);
  });

  test('★ neither touches an account whose two-factor is ON', async () => {
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_last_step = 777 WHERE id = 'u-pend'").run(ENABLED_SECRET);
    assert.equal((await changeOwn()).status, 200);
    assert.deepEqual(row(), { mfa_enabled: 1, mfa_secret: ENABLED_SECRET, mfa_last_step: 777 });
    assert.equal((await adminPut({ password: 'an-admin-set-password' })).status, 200);
    assert.deepEqual(row(), { mfa_enabled: 1, mfa_secret: ENABLED_SECRET, mfa_last_step: 777 });
  });
});

// Review of #765: a set-up left pending by a version before 0.26.0 holds an 80-bit secret. Resuming it would
// keep a weak key alive through the set-up that should replace it; it is discarded instead. FAILS without the
// isLegacySecret check in resumablePendingSecret: it resumed the legacy key.
describe('a pending LEGACY (80-bit) secret is not resumed', () => {
  test('★ setup_pending is false, and set-up makes a fresh 160-bit secret instead of resuming it', async () => {
    const LEGACY = 'JBSWY3DPEHPK3PXP';
    assert.equal(isLegacySecret(LEGACY), true, 'precondition: the fixture is a legacy secret');
    db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = ?, mfa_last_step = 5 WHERE id = 'u-pend'").run(LEGACY);
    assert.equal((await status()).body.setup_pending, false);
    const res = await setup({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.notEqual(res.body.secret, LEGACY);
    assert.equal(res.body.resumed, undefined);
    assert.equal(isLegacySecret(res.body.secret), false);
    assert.equal(row().mfa_secret, res.body.secret);
    assert.equal(row().mfa_last_step, null);
  });
});
