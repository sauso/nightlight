// One person's typo must not lock the household out — issue #248.
//
// THE DEFECT. The login limiter keyed on `req.ip`, and behind the reverse proxy the README documents,
// `req.ip` is the PROXY: index.js trusted X-Forwarded-For only from loopback, and SWAG reaches
// Nightlight by its LAN IP. So every remote user shared one 20-per-15-minutes bucket. Twenty failed
// attempts from anywhere locked EVERY remote user out for fifteen minutes, on an app whose whole point
// is checking on a sleeping child. It also made the control weaker than it looked: the attacker's
// budget and the household's were the same budget.
//
// ⚠️ THE FIRST DESCRIBE RUNS EVERY REQUEST FROM ONE IP ON PURPOSE. That is the un-configured
// production shape — an installation that has not set TRUST_PROXY, where every remote user genuinely
// does arrive as the proxy's address. If the fix only worked once TRUST_PROXY was set, it would not
// have fixed the reported problem.
//
// ⚠️ AND THE LIMITERS ARE MODULE-LEVEL WITH AN IN-MEMORY STORE, so their state carries across every
// case in this file. The spray case alone burns the whole 100-per-IP perClient budget. Any case added
// after it must claim its own source address or it will 429 for reasons unrelated to what it asserts.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, mountRouter, mountRouterTrustingProxy,
  signToken, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { generateSecret, verifyToken } = await import('../src/lib/mfa.js');

let server;

before(async () => {
  server = await mountRouter('/api/auth', authRouter);
});
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  makeUser(db, { id: 'u-a', username: 'alice', role: 'admin', password: 'correct-horse' });
  makeUser(db, { id: 'u-b', username: 'bob', role: 'caregiver', password: 'correct-horse' });
});

const login = (username, password = 'wrong-password') =>
  call(`${server.url}/api/auth/login`, { method: 'POST', body: { username, password } });

// Burn a whole per-account budget with failed attempts.
async function exhaust(username, n = 21) {
  let last;
  for (let i = 0; i < n; i++) last = await login(username);
  return last;
}

describe('the login limiter isolates accounts (#248)', () => {
  test('★ hammering one account does NOT lock out another from the same IP', async () => {
    // THE test this file exists for. Every request here comes from the same source address, which is
    // exactly what an un-configured reverse proxy produces.
    const blocked = await exhaust('alice');
    assert.equal(blocked.status, 429, 'the per-account limit never engaged — nothing is being limited');

    const other = await login('bob');
    assert.notEqual(other.status, 429, "one account's failed logins locked a different account out");
    assert.equal(other.status, 401, `expected a normal auth failure for the other account, got ${other.status}`);
  });

  test('the exhausted account really is blocked, even with the RIGHT password', async () => {
    // Anti-vacuous companion: if the limiter were not engaging at all, the case above would pass for
    // entirely the wrong reason. A correct password must still be refused while the budget is spent.
    await exhaust('alice');
    const res = await call(`${server.url}/api/auth/login`, {
      method: 'POST',
      body: { username: 'alice', password: 'correct-horse' },
    });
    assert.equal(res.status, 429, 'the block lifted for a correct password — the limiter is not the thing refusing');
  });

  test('username casing cannot be used as a second budget', async () => {
    // `Alice` and `alice` are the same account, so they must share one bucket — otherwise the limit is
    // trivially multiplied by retyping the name differently.
    await exhaust('alice');
    const res = await login('ALICE');
    assert.equal(res.status, 429, 're-casing the username opened a fresh budget');
  });

  test('a spray across many usernames is still capped from one source', async () => {
    // Per-account keying on its own would let one source try 20 passwords against every account it can
    // name. The looser per-client limit is what stops that, and it has to actually engage.
    let sawBlock = false;
    for (let i = 0; i < 130 && !sawBlock; i++) {
      const res = await login(`nobody-${i}`);
      if (res.status === 429) sawBlock = true;
    }
    assert.ok(sawBlock, 'an unlimited spray across distinct usernames was never capped');
  });

  test('setup does not spend the login budget', async () => {
    // /setup is first-run only and 400s once a user exists, so it cannot be used for guessing — and
    // sharing the counter meant an install's very first action spent part of the household's login
    // allowance.
    await exhaust('alice');
    const res = await call(`${server.url}/api/auth/setup`, {
      method: 'POST',
      body: { username: 'someone', password: 'a-long-enough-password' },
    });
    assert.notEqual(res.status, 429, 'setup was refused because login attempts had exhausted a shared budget');
    assert.equal(res.status, 400, 'expected the normal "already completed" refusal');
  });
});

// -------------------------------------------------------------------------------------------
// Everything below exists because adversarial review of this PR found the suite could not tell the
// shipped code apart from two regressions the change explicitly forbids.

describe('the key really is IP + account, not one or the other', () => {
  // ⚠️ The describe above sends every request from 127.0.0.1, which is the right shape for the
  // un-configured-proxy case — but it means a mutant keying on the USERNAME ALONE passed all of it.
  // That mutant is the targeted-lockout bug the source comment calls unacceptable: a bare username key
  // lets someone lock a specific user out on purpose by failing their login from elsewhere. Proving
  // the IP is part of the key needs two different source addresses, which needs a trusted proxy.
  let proxied;
  before(async () => { proxied = await mountRouterTrustingProxy('/api/auth', authRouter); });
  after(async () => { await proxied?.close(); });

  const from = (ip, username, password = 'wrong-password') =>
    call(`${proxied.url}/api/auth/login`, {
      method: 'POST',
      body: { username, password },
      headers: { 'x-forwarded-for': ip },
    });

  test('★ an attacker cannot lock a real user out of their own account from elsewhere', async () => {
    let last;
    for (let i = 0; i < 21; i++) last = await from('9.9.9.9', 'alice');
    assert.equal(last.status, 429, 'the attacker was never limited — nothing is being tested');

    const victim = await call(`${proxied.url}/api/auth/login`, {
      method: 'POST',
      body: { username: 'alice', password: 'correct-horse' },
      headers: { 'x-forwarded-for': '8.8.8.8' },
    });
    assert.notEqual(victim.status, 429, 'an attacker locked the real user out of their own account');
    assert.equal(victim.status, 200, `the victim should sign in normally, got ${victim.status}`);
  });
});

describe('a blocked account stops consuming the shared client budget', () => {
  // ⚠️ THE ORDER OF THE TWO LIMITERS IS BEHAVIOUR, NOT STYLE, and nothing asserted it. `loginLimiter`
  // is `[loginAccountLimiter, perClientLimiter]`: once the account limiter rejects, express-rate-limit
  // ends the request and the client limiter never runs, so one account's flood costs the shared budget
  // only its own 20. Swap them and every one of those attempts is charged to the client bucket too —
  // so a single account hammered hard drains the household's 100 and locks everyone else out, which is
  // most of issue #248 back again. Mutation testing showed the swap passed every other case in this
  // file.
  let proxied;
  before(async () => { proxied = await mountRouterTrustingProxy('/api/auth', authRouter); });
  after(async () => { await proxied?.close(); });

  test('★ one account hammered far past its limit does not exhaust the client budget', async () => {
    const ip = '198.51.100.7';
    const hit = (username) =>
      call(`${proxied.url}/api/auth/login`, {
        method: 'POST',
        body: { username, password: 'wrong-password' },
        headers: { 'x-forwarded-for': ip },
      });

    // 120 attempts against ONE account — six times its own budget, and beyond the 100 client budget.
    for (let i = 0; i < 120; i++) await hit('alice');

    const other = await call(`${proxied.url}/api/auth/login`, {
      method: 'POST',
      body: { username: 'bob', password: 'correct-horse' },
      headers: { 'x-forwarded-for': ip },
    });
    assert.notEqual(
      other.status,
      429,
      'one account\'s flood drained the shared client budget — the limiters are running in the wrong order'
    );
    assert.equal(other.status, 200, `the other account should sign in normally, got ${other.status}`);
  });
});

describe('the MFA second step is limited per account too', () => {
  // ⚠️ THIS ROUTE HAD NO PER-ACCOUNT ISOLATION AT ALL. Its body is `{ mfaToken, code }` — no username —
  // and it has no requireAuth, so `req.user` is unset too. The account key was therefore the empty
  // string for EVERY caller: a flat 20-per-IP bucket shared by every account, identical in shape and
  // size to the defect this PR exists to fix, scoped to exactly the users who enabled 2FA.
  //
  // ⚠️ Each case claims its OWN source IP — see the note at the top of this file about limiter state
  // carrying across cases. Sharing 127.0.0.1 here made these 429 for reasons unrelated to the assertion.
  let proxied;
  before(async () => { proxied = await mountRouterTrustingProxy('/api/auth', authRouter); });
  after(async () => { await proxied?.close(); });

  const mfaFrom = (ip, body) =>
    call(`${proxied.url}/api/auth/login/mfa`, { method: 'POST', body, headers: { 'x-forwarded-for': ip } });

  test('★ garbage MFA attempts do not block an unrelated one', async () => {
    const ip = '203.0.113.10';
    let last;
    for (let i = 0; i < 21; i++) last = await mfaFrom(ip, { mfaToken: 'garbage-token', code: '000000' });
    assert.equal(last.status, 429, 'the limiter never engaged for repeated identical bad tokens');

    const other = await mfaFrom(ip, { mfaToken: 'a-completely-different-token', code: '111111' });
    assert.notEqual(other.status, 429, 'an unrelated MFA attempt was blocked by a shared anonymous bucket');
  });

  test('a real MFA token keys on its user, so one account cannot exhaust another', async () => {
    // Two valid, differently-owned MFA tokens must not share a bucket. This is the case that actually
    // matters in production: both of these are tokens a real login handed out.
    const ip = '203.0.113.11';
    const jwtLib = (await import('jsonwebtoken')).default;
    const tokenFor = (id) =>
      jwtLib.sign({ id, purpose: 'mfa' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });

    let last;
    for (let i = 0; i < 21; i++) last = await mfaFrom(ip, { mfaToken: tokenFor('u-a'), code: '000000' });
    assert.equal(last.status, 429, "alice's MFA budget never ran out");

    const bob = await mfaFrom(ip, { mfaToken: tokenFor('u-b'), code: '000000' });
    assert.notEqual(bob.status, 429, "alice's MFA attempts locked bob out of his own second factor");
  });
});

describe('an extraneous identity field cannot open a fresh bucket (S06)', () => {
  // Every case gets a unique source IP because all limiter stores live for the lifetime of this
  // module. The two authenticated-action cases also use different users: those routes deliberately
  // share one limiter, keyed by the verified session identity.
  let proxied;
  before(async () => { proxied = await mountRouterTrustingProxy('/api/auth', authRouter); });
  after(async () => { await proxied?.close(); });

  const from = (ip, path, body, token) =>
    call(`${proxied.url}/api/auth${path}`, {
      method: path === '/me/password' ? 'PUT' : 'POST',
      body,
      token,
      headers: { 'x-forwarded-for': ip },
    });

  const enableMfa = (userId) => {
    const secret = generateSecret();
    db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?').run(secret, userId);
    let wrongCodeNumber = 0;
    while (verifyToken(secret, String(wrongCodeNumber).padStart(6, '0'))) wrongCodeNumber += 1;
    return { wrongCode: String(wrongCodeNumber).padStart(6, '0') };
  };

  const mfaTokenFor = (userId, extra = {}) =>
    signToken({ id: userId, purpose: 'mfa', ...extra }, { expiresIn: '5m' });

  const sessionTokenFor = (user) => {
    const sid = makeSession(db, user.id);
    return signToken({ id: user.id, username: user.username, role: user.role, sid });
  };

  test('★ THE FIX: /login/mfa — a fixed extraneous username cannot reopen an exhausted account\'s bucket', async () => {
    const ip = '203.0.113.20';
    const { wrongCode } = enableMfa('u-a');
    const mfaToken = mfaTokenFor('u-a');

    for (let i = 0; i < 20; i++) {
      const attempt = await from(ip, '/login/mfa', { mfaToken, code: wrongCode });
      assert.equal(attempt.status, 401, `attempt ${i + 1} should reach code verification`);
      assert.equal(attempt.body?.error, 'Incorrect code');
    }
    const blocked = await from(ip, '/login/mfa', { mfaToken, code: wrongCode });
    assert.equal(blocked.status, 429, 'the account bucket was not exhausted on attempt 21');

    const spoofed = await from(ip, '/login/mfa', {
      mfaToken,
      code: wrongCode,
      username: 'someone-else',
    });
    assert.equal(spoofed.status, 429, 'an extraneous username opened a fresh MFA budget');
  });

  test('★ THE FIX: /login/mfa — a DIFFERENT extraneous username on every attempt is still ignored', async () => {
    const ip = '203.0.113.21';
    const { wrongCode } = enableMfa('u-a');
    const mfaToken = mfaTokenFor('u-a');

    for (let i = 0; i < 20; i++) {
      const attempt = await from(ip, '/login/mfa', {
        mfaToken,
        code: wrongCode,
        username: `spoof-${i}`,
      });
      assert.equal(attempt.status, 401, `attempt ${i + 1} should reach code verification`);
      assert.equal(attempt.body?.error, 'Incorrect code');
    }
    const blocked = await from(ip, '/login/mfa', {
      mfaToken,
      code: wrongCode,
      username: 'spoof-20',
    });
    assert.equal(blocked.status, 429, 'varying the extraneous username created fresh MFA budgets');
  });

  test('/login/mfa — a genuinely different signed token for the same user still shares one bucket', async () => {
    const ip = '203.0.113.22';
    const { wrongCode } = enableMfa('u-a');

    for (let i = 0; i < 20; i++) {
      const attempt = await from(ip, '/login/mfa', {
        mfaToken: mfaTokenFor('u-a', { nonce: i }),
        code: wrongCode,
      });
      assert.equal(attempt.status, 401, `attempt ${i + 1} should reach code verification`);
      assert.equal(attempt.body?.error, 'Incorrect code');
    }
    const blocked = await from(ip, '/login/mfa', {
      mfaToken: mfaTokenFor('u-a', { nonce: 20 }),
      code: wrongCode,
    });
    assert.equal(blocked.status, 429, 'fresh signed tokens for one user did not share an account bucket');
  });

  test('★ THE FIX: PUT /me/password — an authenticated caller cannot dodge their own limit with an extraneous username', async () => {
    const ip = '203.0.113.23';
    const user = { id: 'u-a', username: 'alice', role: 'admin' };
    const token = sessionTokenFor(user);

    for (let i = 0; i < 20; i++) {
      const attempt = await from(ip, '/me/password', {
        current_password: 'wrong-password',
        new_password: 'new-password-123',
        username: `spoof-${i}`,
      }, token);
      assert.equal(attempt.status, 401, `attempt ${i + 1} should reach current-password verification`);
      assert.equal(attempt.body?.error, 'Current password is incorrect');
    }
    const blocked = await from(ip, '/me/password', {
      current_password: 'wrong-password',
      new_password: 'new-password-123',
      username: 'spoof-20',
    }, token);
    assert.equal(blocked.status, 429, 'varying the extraneous username created fresh password-change budgets');
  });

  test('★ THE FIX: POST /me/mfa/disable — same, with the wrong-password field this route actually reads', async () => {
    const ip = '203.0.113.24';
    const user = { id: 'u-b', username: 'bob', role: 'caregiver' };
    const token = sessionTokenFor(user);

    for (let i = 0; i < 20; i++) {
      const attempt = await from(ip, '/me/mfa/disable', {
        password: 'wrong-password',
        username: `spoof-${i}`,
      }, token);
      assert.equal(attempt.status, 401, `attempt ${i + 1} should reach password verification`);
      assert.equal(attempt.body?.error, 'Password is incorrect');
    }
    const blocked = await from(ip, '/me/mfa/disable', {
      password: 'wrong-password',
      username: 'spoof-20',
    }, token);
    assert.equal(blocked.status, 429, 'varying the extraneous username created fresh MFA-disable budgets');
  });

  // ★ THE FIX (found by adversarial review of this fix): the two tests above prove an extraneous
  // `username` field is ignored, but both vary source IP AND account together between cases — so
  // neither dimension is pinned on its own. A mutant that makes `sessionKey` return a CONSTANT
  // (dropping the session identity entirely) or one that mounts the account limiter BEFORE
  // `requireAuth` (so `req.user` is unset when the key is computed) still passes both of them: each
  // test's 20 attempts still land in one bucket per IP either way. These two tests pin the actual
  // property — that the bucket key genuinely comes from the AUTHENTICATED caller — the same way the
  // existing MFA-bucket test above proves it for `mfaTokenKey` (two different users sharing ONE IP).
  test('★ THE FIX: PUT /me/password — two different accounts sharing one source IP do not share a bucket', async () => {
    const ip = '203.0.113.26';
    const alice = sessionTokenFor({ id: 'u-a', username: 'alice', role: 'admin' });
    const bob = sessionTokenFor({ id: 'u-b', username: 'bob', role: 'caregiver' });
    const attempt = (token) =>
      from(ip, '/me/password', { current_password: 'wrong-password', new_password: 'new-password-123' }, token);

    let last;
    for (let i = 0; i < 20; i++) {
      last = await attempt(alice);
      assert.equal(last.status, 401, `alice's attempt ${i + 1} should reach current-password verification`);
    }
    const aliceBlocked = await attempt(alice);
    assert.equal(aliceBlocked.status, 429, "alice's own budget never ran out");

    const bobsTurn = await attempt(bob);
    assert.notEqual(bobsTurn.status, 429, "alice's exhausted budget blocked bob from his own account, sharing one IP");
    assert.equal(bobsTurn.status, 401, `expected bob's own current-password check to run, got ${bobsTurn.status}`);
  });

  test('★ THE FIX: POST /me/mfa/disable — two different accounts sharing one source IP do not share a bucket', async () => {
    const ip = '203.0.113.27';
    const alice = sessionTokenFor({ id: 'u-a', username: 'alice', role: 'admin' });
    const bob = sessionTokenFor({ id: 'u-b', username: 'bob', role: 'caregiver' });
    const attempt = (token) => from(ip, '/me/mfa/disable', { password: 'wrong-password' }, token);

    let last;
    for (let i = 0; i < 20; i++) {
      last = await attempt(alice);
      assert.equal(last.status, 401, `alice's attempt ${i + 1} should reach password verification`);
    }
    const aliceBlocked = await attempt(alice);
    assert.equal(aliceBlocked.status, 429, "alice's own budget never ran out");

    const bobsTurn = await attempt(bob);
    assert.notEqual(bobsTurn.status, 429, "alice's exhausted budget blocked bob from his own account, sharing one IP");
    assert.equal(bobsTurn.status, 401, `expected bob's own password check to run, got ${bobsTurn.status}`);
  });

  test('/login itself is not newly exposed to a forged mfaToken', async () => {
    const ip = '203.0.113.25';

    for (let i = 0; i < 20; i++) {
      const attempt = await from(ip, '/login', {
        username: 'alice',
        password: 'wrong-password',
        mfaToken: `junk-${i}`,
      });
      assert.equal(attempt.status, 401, `attempt ${i + 1} should reach password verification`);
      assert.equal(attempt.body?.error, 'Incorrect username or password');
    }
    const blocked = await from(ip, '/login', {
      username: 'alice',
      password: 'wrong-password',
      mfaToken: 'junk-20',
    });
    assert.equal(blocked.status, 429, 'varying a forged MFA token created fresh login budgets');
  });
});
