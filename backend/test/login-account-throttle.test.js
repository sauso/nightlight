// The per-account password throttle at the ROUTE level (#553).
//
// THE CLAIM: a caller that names a fresh source address on every request (X-Forwarded-For, which index.js trusts from
// loopback by default) cannot get more than FREE_FAILURES wrong guesses at one account. Every limiter that existed
// before this keyed on `ip|account`, so such a caller never met a limit. The throttle's own rules (delays, decay,
// eviction) are pinned in account-throttle.test.js; this file is about the wiring: the four routes that check a
// password, the shapes of the answers, and the ways out.
//
// ⚠️ Every request here comes from a source address of its own (nextIp), so the per-source limiters, whose stores are
// module-level and carry across cases, never engage and cannot make a case pass for the wrong reason. The throttles
// are module-level too: beforeEach empties them for the two accounts.
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, mountRouterTrustingProxy, signToken, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  default: authRouter, resetMfaUserLimit, resetPasswordThrottles, throttledPasswordCheck,
} = await import('../src/routes/auth.js');
const { FREE_FAILURES, BASE_DELAY_MS, createAccountThrottle } = await import('../src/lib/accountThrottle.js');

let server;
before(async () => { server = await mountRouterTrustingProxy('/api/auth', authRouter); });
after(async () => {
  mock.timers.reset();
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  mock.timers.reset();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  makeUser(db, { id: 'u-a', username: 'alice', role: 'admin', password: 'correct-horse' });
  makeUser(db, { id: 'u-b', username: 'bob', role: 'caregiver', password: 'correct-horse' });
  resetMfaUserLimit('u-a');
  resetMfaUserLimit('u-b');
  resetPasswordThrottles('u-a', 'alice');
  resetPasswordThrottles('u-b', 'bob');
  resetPasswordThrottles('', 'ghost');
  resetPasswordThrottles('u-c', 'Carol');
});

let n = 0;
const nextIp = () => { n += 1; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };

const login = (username, password = 'wrong-password', ip = nextIp()) =>
  call(`${server.url}/api/auth/login`, {
    method: 'POST', body: { username, password }, headers: { 'x-forwarded-for': ip },
  });

const sessionFor = (id, username, role) => signToken({ id, username, role, sid: makeSession(db, id) });

const WRONG = 'Incorrect username or password';
const SLOWED = 'Too many attempts - please wait a few minutes and try again.';

async function tally(count, attempt) {
  const seen = { passed: 0, throttled: 0, other: [] };
  for (let i = 0; i < count; i++) {
    const res = await attempt(i);
    if (res.status === 429) seen.throttled += 1;
    else if (res.status === 401 || res.status === 400) seen.passed += 1; // reached the password check
    else seen.other.push(res.status);
  }
  return seen;
}

describe('POST /login: a guesser who changes address on every request is held to the free guesses', () => {
  test('★ THE FIX: 40 guesses, each from a new address, 30 are checked and the rest are refused', async () => {
    // Without the throttle every one of the 40 reaches the password check (a fresh `ip|account` bucket each time).
    const seen = await tally(40, () => login('alice'));
    assert.deepEqual(seen.other, []);
    assert.equal(seen.passed, FREE_FAILURES, 'a different number of guesses reached the password check');
    assert.equal(seen.throttled, 40 - FREE_FAILURES);
  });

  test('★ the refusal is the usual 429 body, with a Retry-After of at least a second', async () => {
    for (let i = 0; i < FREE_FAILURES; i++) await login('alice');
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ username: 'alice', password: 'wrong-password' }),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { error: SLOWED });
    const wait = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= BASE_DELAY_MS / 1000, `Retry-After was ${wait}`);
  });

  test('★ the right password is refused too while the delay runs (that is what a delay is)', async () => {
    for (let i = 0; i < FREE_FAILURES; i++) await login('alice');
    const res = await login('alice', 'correct-horse');
    assert.equal(res.status, 429);
  });

  test('★ it ends by itself: once the delay has passed the right password signs in', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    for (let i = 0; i < FREE_FAILURES; i++) await login('alice');
    assert.equal((await login('alice', 'correct-horse')).status, 429);
    mock.timers.tick(BASE_DELAY_MS + 1000);
    const res = await login('alice', 'correct-horse');
    assert.equal(res.status, 200, 'the account stayed locked after the delay');
    assert.ok(res.body.token);
  });

  test('★ a different account is not slowed', async () => {
    for (let i = 0; i < FREE_FAILURES + 5; i++) await login('alice');
    const res = await login('bob', 'correct-horse');
    assert.equal(res.status, 200);
  });

  test('★ the key is the name EXACTLY as the lookup uses it: a retyped name neither spends nor refills alice\'s guesses', async () => {
    // `Alice` matches no row (the lookup is exact), so guesses at it reach no account. Folding case made them
    // share alice's budget, which both let an outsider slow her with names that are not hers and, worse, let a good
    // sign-in under one spelling reset another account's count.
    for (let i = 0; i < FREE_FAILURES; i++) await login('Alice');
    assert.equal((await login('alice', 'correct-horse')).status, 200, 'a re-cased name spent alice\'s guesses');
  });

  test('★ a good sign-in as ALICE does not refill alice\'s guesses (two rows, two accounts)', async () => {
    // The Codex finding on #868, verified by running: alice and ALICE are separate users (the column is UNIQUE, not
    // NOCASE). With one folded key a good sign-in as ALICE reset the count, so alternating them gave unlimited guesses.
    makeUser(db, { id: 'u-c', username: 'ALICE', role: 'caregiver', password: 'other-horse' });
    for (let i = 0; i < FREE_FAILURES - 1; i++) await login('alice');
    assert.equal((await login('ALICE', 'other-horse')).status, 200);
    const seen = await tally(5, () => login('alice'));
    assert.equal(seen.passed, 1, 'a sign-in as another account refilled alice\'s guesses');
    assert.equal(seen.throttled, 4);
  });

  test('★ a name that does not exist is throttled exactly like one that does (no way to tell them apart)', async () => {
    const real = await tally(FREE_FAILURES + 3, () => login('alice'));
    const ghost = await tally(FREE_FAILURES + 3, () => login('ghost'));
    assert.deepEqual(ghost, real, 'an unknown name behaved differently from a real one');
    assert.equal(ghost.passed, FREE_FAILURES);
  });

  test('★ a correct sign-in resets the account', async () => {
    for (let i = 0; i < FREE_FAILURES - 1; i++) await login('alice');
    assert.equal((await login('alice', 'correct-horse')).status, 200);
    const seen = await tally(FREE_FAILURES, () => login('alice'));
    assert.equal(seen.passed, FREE_FAILURES, 'the earlier failures were still counted after a good sign-in');
  });

  test('★ PARALLEL guesses cannot slip past the gate before any failure is recorded', async () => {
    // 60 requests at once, each from its own address. Hashing is asynchronous, so a check made AFTER the compare
    // would let all 60 through; the throttle reserves the attempt before the first await.
    const results = await Promise.all(Array.from({ length: 60 }, () => login('alice')));
    const checked = results.filter((r) => r.status === 401).length;
    const refused = results.filter((r) => r.status === 429).length;
    assert.equal(checked, FREE_FAILURES, 'more guesses than the free ones were checked in parallel');
    assert.equal(checked + refused, 60);
  });

  test('a body with no usable username shares one bucket and cannot starve a real account', async () => {
    const seen = await tally(FREE_FAILURES + 3, () => call(`${server.url}/api/auth/login`, {
      method: 'POST', body: { password: 'x' }, headers: { 'x-forwarded-for': nextIp() },
    }));
    assert.equal(seen.passed, FREE_FAILURES);
    assert.equal((await login('alice', 'correct-horse')).status, 200);
  });

});

describe('throttledPasswordCheck: what each outcome does to the account', () => {
  // The helper every route goes through. Driven directly with a real throttle, because the way a compare throws (the
  // hash worker failing) cannot be provoked through the HTTP routes.
  const fresh = () => createAccountThrottle();

  test('★ a throw while checking is a server fault: it spends no guess and gives the reservation back', async () => {
    const throttle = fresh();
    for (let i = 0; i < FREE_FAILURES * 3; i++) {
      await assert.rejects(throttledPasswordCheck(throttle, 'alice', async () => { throw new Error('worker died'); }), /worker died/);
    }
    assert.equal(throttle.size(), 0, 'a throw left a reservation or a failure behind');
    const ok = await throttledPasswordCheck(throttle, 'alice', async () => false);
    assert.deepEqual(ok, { throttled: false, ok: false }, 'faults must never have turned into a throttle');
  });

  test('a match resets; a miss counts; a throttled answer carries the wait', async () => {
    const throttle = fresh();
    for (let i = 0; i < FREE_FAILURES; i++) {
      assert.deepEqual(await throttledPasswordCheck(throttle, 'alice', async () => false), { throttled: false, ok: false });
    }
    const refused = await throttledPasswordCheck(throttle, 'alice', async () => true);
    assert.equal(refused.throttled, true, 'the verify must not even run while throttled');
    assert.ok(refused.retryAfterSec >= 1);
    assert.deepEqual(await throttledPasswordCheck(throttle, 'bob', async () => true), { throttled: false, ok: true });
  });

  test('the verify is not run at all for a refused attempt (no password hash is spent on it)', async () => {
    const throttle = fresh();
    for (let i = 0; i < FREE_FAILURES; i++) await throttledPasswordCheck(throttle, 'alice', async () => false);
    let ran = 0;
    await throttledPasswordCheck(throttle, 'alice', async () => { ran += 1; return true; });
    assert.equal(ran, 0);
  });
});

describe('the three routes that ask for the CURRENT password share one per-account budget', () => {
  const putPassword = (token, current, ip = nextIp()) =>
    call(`${server.url}/api/auth/me/password`, {
      method: 'PUT', token, body: { current_password: current, new_password: 'a-brand-new-password' },
      headers: { 'x-forwarded-for': ip },
    });
  const disableMfa = (token, password, ip = nextIp()) =>
    call(`${server.url}/api/auth/me/mfa/disable`, {
      method: 'POST', token, body: { password }, headers: { 'x-forwarded-for': ip },
    });
  const startMfa = (token, password, ip = nextIp()) =>
    call(`${server.url}/api/auth/me/mfa/setup`, {
      method: 'POST', token, body: { password }, headers: { 'x-forwarded-for': ip },
    });

  test('★ THE FIX: /me/password — a new address per guess still stops at the free guesses', async () => {
    const token = sessionFor('u-a', 'alice', 'admin');
    const seen = await tally(40, () => putPassword(token, 'wrong-password'));
    assert.equal(seen.passed, FREE_FAILURES);
    assert.equal(seen.throttled, 40 - FREE_FAILURES);
  });

  test('★ THE FIX: the budget is ONE across /me/password, /me/mfa/setup and /me/mfa/disable', async () => {
    const token = sessionFor('u-a', 'alice', 'admin');
    let passed = 0;
    for (let i = 0; i < 10; i++) { if ((await putPassword(token, 'wrong-password')).status === 400) passed += 1; }
    for (let i = 0; i < 10; i++) { if ((await startMfa(token, 'wrong-password')).status === 400) passed += 1; }
    for (let i = 0; i < 20; i++) { if ((await disableMfa(token, 'wrong-password')).status === 400) passed += 1; }
    assert.equal(passed, FREE_FAILURES, 'the three routes did not draw on one account budget');
    assert.equal((await putPassword(token, 'wrong-password')).status, 429);
  });

  test('★ one account is not slowed by another account\'s guesses', async () => {
    const alice = sessionFor('u-a', 'alice', 'admin');
    const bob = sessionFor('u-b', 'bob', 'caregiver');
    await tally(FREE_FAILURES + 2, () => putPassword(alice, 'wrong-password'));
    const res = await putPassword(bob, 'wrong-password');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Current password is incorrect');
  });

  test('★ a sign-in does NOT refill this budget (so a session holder cannot reset their own guessing)', async () => {
    const token = sessionFor('u-a', 'alice', 'admin');
    await tally(FREE_FAILURES, () => putPassword(token, 'wrong-password'));
    assert.equal((await login('alice', 'correct-horse')).status, 200); // the login throttle is a separate store
    assert.equal((await putPassword(token, 'wrong-password')).status, 429, 'signing in refilled the session budget');
  });

  test('★ a login that is being slowed does not stop the person changing their password from a signed-in device', async () => {
    const token = sessionFor('u-a', 'alice', 'admin');
    await tally(FREE_FAILURES, () => login('alice'));
    assert.equal((await login('alice', 'correct-horse')).status, 429, 'precondition: the sign-in is slowed');

    const changed = await putPassword(token, 'correct-horse');
    assert.equal(changed.status, 200, 'the way out (change the password) was blocked');

    // And the change emptied the login guesses: the new password signs in at once, without waiting.
    const signedIn = await call(`${server.url}/api/auth/login`, {
      method: 'POST', body: { username: 'alice', password: 'a-brand-new-password' }, headers: { 'x-forwarded-for': nextIp() },
    });
    assert.equal(signedIn.status, 200, 'the account stayed slowed after its password was changed');
  });

  test('★ an admin setting a new password empties the account (the "ask an admin" way out)', async () => {
    // Opus review of #868: this reset had no test; deleting it left every test green.
    const admin = sessionFor('u-a', 'alice', 'admin');
    await tally(FREE_FAILURES, () => login('bob'));
    assert.equal((await login('bob', 'correct-horse')).status, 429, 'precondition: bob\'s sign-in is slowed');

    const res = await call(`${server.url}/api/auth/users/u-b`, {
      method: 'PUT', token: admin, body: { password: 'a-brand-new-password' }, headers: { 'x-forwarded-for': nextIp() },
    });
    assert.equal(res.status, 200);
    assert.equal((await login('bob', 'a-brand-new-password')).status, 200, 'the account stayed slowed after an admin reset');
  });

  test('★ the reset uses the name EXACTLY as stored: a name with capitals is emptied by a password change', async () => {
    // Opus review of #868: every fixture was lower-case, so a reset keyed on a lower-cased name (while the sign-in key
    // is exact) silently stopped clearing the count for any account whose name has a capital.
    makeUser(db, { id: 'u-c', username: 'Carol', role: 'caregiver', password: 'correct-horse' });
    const token = sessionFor('u-c', 'Carol', 'caregiver');
    await tally(FREE_FAILURES, () => login('Carol'));
    assert.equal((await login('Carol', 'correct-horse')).status, 429, 'precondition: Carol\'s sign-in is slowed');

    const changed = await call(`${server.url}/api/auth/me/password`, {
      method: 'PUT', token, body: { current_password: 'correct-horse', new_password: 'a-brand-new-password' },
      headers: { 'x-forwarded-for': nextIp() },
    });
    assert.equal(changed.status, 200);
    assert.equal((await login('Carol', 'a-brand-new-password')).status, 200, 'the count for a capitalised name survived a password change');
  });

  test('★ a real account that nobody has mistyped still signs in while a flood of invented names is being checked', async () => {
    // Route level: the real account is tracked in its own table, so invented names (tracked or not) cannot refuse it.
    await tally(FREE_FAILURES + 5, (i) => login(`invented-${i}`));
    assert.equal((await login('bob', 'correct-horse')).status, 200);
  });
});
