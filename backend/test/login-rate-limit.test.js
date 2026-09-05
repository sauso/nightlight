// One person's typo must not lock the household out — issue #248.
//
// THE DEFECT. The login limiter keyed on `req.ip`, and behind the reverse proxy the README documents,
// `req.ip` is the PROXY: index.js trusted X-Forwarded-For only from loopback, and SWAG reaches
// Nightlight by its LAN IP. So every remote user shared one 20-per-15-minutes bucket. Twenty failed
// attempts from anywhere locked EVERY remote user out for fifteen minutes, on an app whose whole point
// is checking on a sleeping child. It also made the control weaker than it looked: the attacker's
// budget and the household's were the same budget.
//
// ⚠️ THESE TESTS RUN EVERY REQUEST FROM ONE IP ON PURPOSE. That is the un-configured production shape
// — an installation that has not set TRUST_PROXY, where every remote user genuinely does arrive as the
// proxy's address. If the fix only worked once TRUST_PROXY was set, it would not have fixed the
// reported problem, and these would pass anyway if they varied the source address. Keeping them on a
// single IP is what makes them discriminate.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeUser, mountRouter, call } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter } = await import('../src/routes/auth.js');

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
