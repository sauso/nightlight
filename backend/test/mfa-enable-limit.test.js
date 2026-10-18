// Rate-limiting the two-factor confirmation route (POST /api/auth/me/mfa/enable).
//
// The confirmation route takes a signed-in session but not the password, so it now limits wrong codes, like the
// other confirmation routes: 10 wrong codes cancel the pending set-up, and the account allows 30 wrong codes per
// 15 minutes from any number of addresses. Only WRONG codes count.
//
// Real database, real HTTP, real otplib, real bcrypt worker; nothing mocked. Each case was run against the
// routes/auth.js from before this change (a scratch copy) and its comment says how it failed there. The one that
// passes there (nine wrong codes, then the right one) is the lower edge of the cap and says so.
//
// ⚠️ The counter and the limiter are module-level and in memory: every case claims its OWN user, empties that
// user's buckets (resetMfaUserLimit), and asserts the answer to its first request, so a budget spent earlier (in
// this file or by another case) can never be what a case measures (#706). The numbers 10 and 30 are written out
// here on purpose, not imported: a test that reads its expectations from the code under test cannot fail.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, mountRouterTrustingProxy, signToken, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter, resetMfaUserLimit } = await import('../src/routes/auth.js');
const { generateSecret, matchTokenStep } = await import('../src/lib/mfa.js');
const passwordHash = await import('../src/lib/passwordHash.js');
const { generateSync } = await import('otplib');

const PASSWORD = 'hunter22'; // makeUser's default; every set-up call needs it (#765)
const CAP = 10; // wrong codes that cancel a pending set-up
const PER_USER = 30; // wrong codes per user per 15 minutes

const WRONG = "That code didn't match — check your authenticator app and try again.";
const CANCELLED =
  "Too many wrong codes, so this set-up was cancelled. Choose Continue set-up or Start over to get a new key (also check your phone's clock).";
const START_FIRST = 'Start setup first.';
const TOO_MANY = 'Too many attempts - please wait a few minutes and try again.';

let server;
before(async () => { server = await mountRouterTrustingProxy('/api/auth', authRouter); });
after(async () => { await server?.close(); db.close(); cleanupTempDataDirs(); });

// A fresh source address for every request. The confirmation route has no per-address limit, but set-up and
// turning two-factor off do (per source + account, 20), and no case here may be stopped by those. Spreading the
// confirmations over many addresses is also the point: the per-user limit must add them up.
let ipCounter = 0;
const freshIp = () => { ipCounter += 1; return `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`; };

// A caregiver of the case's own, with a fresh session, and its buckets emptied.
function account(id) {
  makeUser(db, { id, username: id, role: 'caregiver' });
  resetMfaUserLimit(id);
  return signToken({ id, username: id, role: 'caregiver', sid: makeSession(db, id) });
}
const post = (path, token, body) =>
  call(`${server.url}/api/auth${path}`, { method: 'POST', token, body, headers: { 'x-forwarded-for': freshIp() } });
const setup = (token, extra = {}) => post('/me/mfa/setup', token, { password: PASSWORD, ...extra });
const enable = (token, code) => post('/me/mfa/enable', token, { code });
const status = (token) => call(`${server.url}/api/auth/me/mfa`, { token });
const row = (id) => db.prepare('SELECT mfa_enabled, mfa_secret, mfa_last_step FROM users WHERE id = ?').get(id);

const rightCode = (secret) => generateSync({ secret });
// A code that is wrong for this secret in every step the server accepts (now, and one step either side).
function wrongCode(secret) {
  for (let n = 0; n < 1000; n += 1) {
    const c = String(n).padStart(6, '0');
    if (matchTokenStep(secret, c) === null) return c;
  }
  throw new Error('no wrong code found');
}

// Sends `n` wrong codes, starting a NEW set-up (restart: true, with the password, as only the owner can) before
// the first and after every 9th, so no one secret reaches the cap of 10: what such a run measures is the per-user
// limit, not the cap. Returns every answer and the secret pending at the end.
async function wrongCodesAcrossSecrets(token, n) {
  const answers = [];
  let secret;
  for (let i = 0; i < n; i += 1) {
    if (i % (CAP - 1) === 0) {
      const s = await setup(token, { restart: true });
      assert.equal(s.status, 200, `set-up before wrong code ${i + 1}: ${JSON.stringify(s.body)}`);
      secret = s.body.secret;
    }
    answers.push(await enable(token, wrongCode(secret)));
  }
  return { answers, secret };
}
const wrongAnswer = { status: 400, body: { error: WRONG } };

// Sends a request whose handler awaits bcrypt and runs `meanwhile()` while it is provably parked there. A copy of
// the helper in mfa-replay-and-async-bcrypt.test.js (see its comment): a slow job of the test's own goes into the
// one worker first, so once the request's own job is queued behind it the handler cannot resume.
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

describe('10 wrong codes cancel a pending set-up', () => {
  // The lower edge of the cap: PASSES on the old code too (it had no cap), by design. It fails if the cap is
  // lowered or counted one early, which the case below cannot see.
  test('nine wrong codes, then the right one: two-factor goes on', async () => {
    const token = account('cap-nine');
    const first = await setup(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { secret } = first.body;
    for (let i = 1; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(secret)), wrongAnswer, `wrong code ${i}`);
    const ok = await enable(token, rightCode(secret));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.backup_codes.length, 10);
    assert.equal(row('cap-nine').mfa_enabled, 1);
  });

  // FAILS ON THE OLD CODE: the 10th wrong code answered "didn't match" like the nine before it, and the set-up
  // stayed pending however many wrong codes followed.
  test('★ the 10th wrong code cancels it: the old key is gone, a new set-up needs the password, and a new key gets a fresh 10', async () => {
    const token = account('cap-ten');
    const first = await setup(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const old = first.body.secret;
    for (let i = 1; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(old)), wrongAnswer, `wrong code ${i}`);
    db.prepare("UPDATE users SET mfa_last_step = 4242 WHERE id = 'cap-ten'").run();

    assert.deepEqual(await enable(token, wrongCode(old)), { status: 400, body: { error: CANCELLED } }, 'the 10th wrong code did not cancel the set-up');
    assert.deepEqual(row('cap-ten'), { mfa_enabled: 0, mfa_secret: null, mfa_last_step: null });
    assert.equal((await status(token)).body.setup_pending, false);
    assert.deepEqual(await enable(token, rightCode(old)), { status: 400, body: { error: START_FIRST } }, 'the cancelled key still confirms');

    // What makes 10 a bound: a device without the password cannot start another set-up (#765).
    assert.deepEqual(await post('/me/mfa/setup', token, {}), { status: 400, body: { error: 'Password is incorrect' } });
    assert.equal(row('cap-ten').mfa_secret, null, 'a set-up without the password stored a key');

    // The owner, with the password, gets a NEW key (nothing to resume), and its count starts again at 0.
    const next = await setup(token);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.notEqual(next.body.secret, old);
    assert.equal(next.body.resumed, undefined);
    for (let i = 1; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(next.body.secret)), wrongAnswer, `new key, wrong code ${i}`);
    assert.equal((await enable(token, rightCode(next.body.secret))).status, 200);
  });

  // FAILS ON THE OLD CODE (no cap). Also fails if a resume reset the count: then a page reload part-way (#765
  // returns the same key) would start a fresh 10 every time.
  test('★ continuing the set-up (the same key returned) does not reset the count: 5 + 5 cancels it', async () => {
    const token = account('cap-resume');
    const first = await setup(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { secret } = first.body;
    for (let i = 1; i <= 5; i += 1) assert.deepEqual(await enable(token, wrongCode(secret)), wrongAnswer, `wrong code ${i}`);
    const resumed = await setup(token);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.resumed, true, 'precondition: the same set-up was continued');
    assert.equal(resumed.body.secret, secret);
    for (let i = 6; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(secret)), wrongAnswer, `wrong code ${i}`);
    assert.deepEqual(await enable(token, wrongCode(secret)), { status: 400, body: { error: CANCELLED } }, 'the resume reset the count');
    assert.equal(row('cap-resume').mfa_secret, null);
  });

  // FAILS ON THE OLD CODE (no cap: the last wrong code is not a cancel). Also fails if the count were kept per user
  // rather than per key: the first wrong code against the new key would then be the 10th and cancel it.
  test('★ starting over (a new key) starts a new count: 9, start over, 9 more allowed, the 10th on the new key cancels', async () => {
    const token = account('cap-restart');
    const first = await setup(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    for (let i = 1; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(first.body.secret)), wrongAnswer, `first key, wrong code ${i}`);
    const again = await setup(token, { restart: true });
    assert.equal(again.status, 200);
    assert.notEqual(again.body.secret, first.body.secret, 'precondition: a new key');
    for (let i = 1; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(again.body.secret)), wrongAnswer, `new key, wrong code ${i}`);
    assert.deepEqual(await enable(token, wrongCode(again.body.secret)), { status: 400, body: { error: CANCELLED } });
  });

  // FAILS ON THE OLD CODE: all twenty answered "didn't match". The count and the cancel run with no await between
  // them, so requests sent at once cannot all get past the cap before it is counted.
  test('★ twenty wrong codes sent at once: nine "didn\'t match", one cancel, and the other ten find nothing pending', async () => {
    const token = account('cap-burst');
    const first = await setup(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const bad = wrongCode(first.body.secret);
    const answers = await Promise.all(Array.from({ length: 20 }, () => enable(token, bad)));
    const count = (error) => answers.filter((a) => a.status === 400 && a.body.error === error).length;
    assert.deepEqual([count(WRONG), count(CANCELLED), count(START_FIRST)], [9, 1, 10], JSON.stringify(answers));
    assert.equal(row('cap-burst').mfa_secret, null);
  });

  // FAILS ON THE OLD CODE: the 10th wrong code did not cancel anything, and the right code's write landed (200).
  // With the cap, the right code is being confirmed (parked on its backup-code hashing) when the 10th wrong code
  // cancels the key it was checked against; the confirmation's compare-and-set on that key then refuses the write.
  test('★ the 10th wrong code lands while a right code is being confirmed: the confirmation fails safe, two-factor stays off', async () => {
    const token = account('cap-race');
    const first = await setup(token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const { secret } = first.body;
    for (let i = 1; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(secret)), wrongAnswer, `wrong code ${i}`);
    let cancel;
    const res = await whileHandlerAwaitsBcrypt(
      () => enable(token, rightCode(secret)),
      async () => { cancel = await enable(token, wrongCode(secret)); },
    );
    assert.deepEqual(cancel, { status: 400, body: { error: CANCELLED } }, 'precondition: the 10th wrong code cancelled meanwhile');
    assert.deepEqual(res, { status: 400, body: { error: START_FIRST } });
    assert.deepEqual(row('cap-race'), { mfa_enabled: 0, mfa_secret: null, mfa_last_step: null });
    assert.equal(db.prepare("SELECT mfa_backup_codes AS c FROM users WHERE id = 'cap-race'").get().c, null);
  });
});

describe('30 wrong codes per user per 15 minutes, from any address', () => {
  // FAILS ON THE OLD CODE: the right code after 30 wrong ones was accepted (200); there was no limit to reach.
  test('★ 30 wrong codes over many keys and addresses: the next request is 429 from any address, even with the right code', async () => {
    const token = account('lim-30');
    const { answers, secret } = await wrongCodesAcrossSecrets(token, PER_USER);
    assert.deepEqual(answers[0], wrongAnswer, 'precondition: the first wrong code reached the check, so nothing was spent before this case');
    answers.forEach((a, i) => assert.deepEqual(a, wrongAnswer, `wrong code ${i + 1}: no key may reach the cap here`));

    const blocked = await enable(token, rightCode(secret));
    assert.deepEqual(blocked, { status: 429, body: { error: TOO_MANY } }, 'the right code after 30 wrong ones was not refused by the limit');
    assert.equal(row('lim-30').mfa_enabled, 0, 'two-factor went on past the limit');
    const fresh = await setup(token, { restart: true });
    assert.equal(fresh.status, 200, 'set-up is a different route with its own limit');
    assert.equal((await enable(token, rightCode(fresh.body.secret))).status, 429, 'a new key does not get round the per-user limit');

    // The bucket is the account's own: another account confirms normally.
    const other = account('lim-30-other');
    const otherSetup = await setup(other);
    assert.equal((await enable(other, rightCode(otherSetup.body.secret))).status, 200, 'another account was blocked too');
  });

  // FAILS ON THE OLD CODE: the 31st wrong code answered 400; there was no limit.
  // Also fails if a successful confirmation is counted (the 30th wrong code is then a 429).
  test('★ a successful confirmation spends nothing: 29 wrong codes, the right one (200), then the 30th wrong code is 400 and the 31st 429', async () => {
    const token = account('lim-ok');
    const { answers, secret } = await wrongCodesAcrossSecrets(token, PER_USER - 1);
    assert.deepEqual(answers[0], wrongAnswer, 'precondition: nothing was spent before this case');
    answers.forEach((a, i) => assert.deepEqual(a, wrongAnswer, `wrong code ${i + 1}`));
    const ok = await enable(token, rightCode(secret));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    assert.equal((await post('/me/mfa/disable', token, { password: PASSWORD })).status, 200);
    const again = await setup(token);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await enable(token, wrongCode(again.body.secret)), wrongAnswer, 'wrong code 30: the successful confirmation was counted');
    assert.deepEqual(await enable(token, wrongCode(again.body.secret)), { status: 429, body: { error: TOO_MANY } }, 'wrong code 31 was not stopped');
  });

  // FAILS ON THE OLD CODE: the 31st wrong code answered 400. Also fails if every 400 counts (the first design): the
  // 31st of the forty refusals below is then a 429, and a device that had cancelled the owner's set-up could keep
  // the owner from confirming the next one with refusals that cost it no guess.
  test('★ refusals that needed no guess spend nothing: forty of them, then still 30 wrong codes before the 429', async () => {
    const token = account('lim-free');
    for (let i = 1; i <= 30; i += 1) {
      assert.deepEqual(await enable(token, '123456'), { status: 400, body: { error: START_FIRST } }, `nothing pending, refusal ${i}`);
    }
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = 'lim-free'").run(generateSecret());
    for (let i = 1; i <= 10; i += 1) {
      assert.deepEqual(await enable(token, '123456'), { status: 400, body: { error: 'Two-factor is already on.' } }, `already on, refusal ${i}`);
    }
    db.prepare("UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = 'lim-free'").run();

    const { answers, secret } = await wrongCodesAcrossSecrets(token, PER_USER);
    answers.forEach((a, i) => assert.deepEqual(a, wrongAnswer, `wrong code ${i + 1}`));
    assert.deepEqual(await enable(token, wrongCode(secret)), { status: 429, body: { error: TOO_MANY } });
  });

  // FAILS ON THE OLD CODE at its precondition (the right code after 30 wrong ones was a 200, not a 429), and FAILS
  // if the admin reset leaves this bucket in place (resetMfaUserLimit): the user stays blocked for the rest of the
  // window although the docs say a reset clears it. The 30 wrong codes here are three cancelled set-ups of 10: the
  // answer that cancels a set-up is a wrong code too, and counts.
  test('★ an admin two-factor reset also empties the confirmation budget: the user sets up again and confirms', async () => {
    const token = account('lim-reset');
    makeUser(db, { id: 'lim-admin', username: 'lim-admin', role: 'admin' });
    const adminToken = signToken({ id: 'lim-admin', username: 'lim-admin', role: 'admin', sid: makeSession(db, 'lim-admin') });
    for (let round = 1; round <= 3; round += 1) {
      const s = await setup(token);
      assert.equal(s.status, 200, `round ${round}: ${JSON.stringify(s.body)}`);
      for (let i = 1; i <= CAP - 1; i += 1) assert.deepEqual(await enable(token, wrongCode(s.body.secret)), wrongAnswer, `round ${round}, wrong code ${i}`);
      assert.deepEqual(await enable(token, wrongCode(s.body.secret)), { status: 400, body: { error: CANCELLED } }, `round ${round}`);
    }
    const s = await setup(token);
    assert.equal((await enable(token, rightCode(s.body.secret))).status, 429, 'precondition: 30 wrong codes (the cancels included) spent the budget');

    const reset = await call(`${server.url}/api/auth/users/lim-reset/mfa`, {
      method: 'DELETE', token: adminToken, headers: { 'x-forwarded-for': freshIp() },
    });
    assert.equal(reset.status, 200);
    const next = await setup(token);
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const ok = await enable(token, rightCode(next.body.secret));
    assert.equal(ok.status, 200, `still ${ok.status} after the admin reset: the confirmation budget was not emptied`);
  });
});
