// Caregiver invites (#1094): create an account without a password, re-issue and revoke its invite, check and redeem
// the link, and every way an account still waiting on its invite must NOT sign in.
//
// THE CLAIMS this file holds, each by a test that fails without the code it names (mutants: scripts/mutants.json,
// labels "#1094 invite ..."):
//   * the token is answered once, only its sha256 is stored, and it is in no list, GET answer or log line;
//   * unknown, expired, used, malformed and no-longer-eligible tokens all get the SAME 404 (no enumeration);
//   * single use and race-free: two redeems at once give one winner and ONE bcrypt job (single flight);
//   * everything checked before the bcrypt await is checked again after it, inside one transaction that rolls back on
//     any miss: still unused, still unexpired AT THE TIME AFTER THE AWAIT, still pending, still a caregiver, still the
//     placeholder hash the invite was made with (Opus plan review H1, M1, M4; Codex C2);
//   * a pending account cannot sign in by any path: /login (even with a password its hash really matches), /login/mfa,
//     or a session that already exists (C1); adminCount and PUT /users/:id never let a pending account be the admin;
//   * the public routes share one failures-only limiter, and invite hashes are capped across tokens (M2, C3); both
//     bounds are released when a hash FAILS (the worker stopped mid-hash), not only when it succeeds (review M-2);
//   * a second redeem of the same token while the first hashes answers 409 invite_in_progress, not the dead-link 404
//     (review L1), and the Users list calls an invite open only when /invite/check would accept it (review L2);
//   * a password that is not valid text (an unpaired UTF-16 surrogate) never reaches bcrypt on any route: a sign-in
//     answers like a wrong password, counted; a route that sets a password answers 400; the invite is not spent.
//
// HOW THE "MEANWHILE" CASES WORK. The redeem awaits a bcrypt hash in the shared worker thread (lib/passwordHash.js).
// duringTheHash() sends a request, waits until its hash job has been SUBMITTED (passwordWorkerStats), then changes the
// database or moves the clock synchronously, while that job is provably still pending: the route can resume only after
// the worker answers, and that answer is handled on this same event loop. Each case asserts the job was still pending,
// so none can pass because the change came too late.
//
// THE FIXTURE IS HOSTILE where it matters. A pending account's placeholder is a hash of random bytes nobody knows, so
// a login test against it passes whether or not the guard exists. The login-guard case plants a hash of a password the
// test KNOWS on a pending account (M3).
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import bcrypt from 'bcryptjs';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, mountRouterTrustingProxy, signToken, call,
} from './helpers/harness.js';
import { stripCommentsAndStrings } from './helpers/sourceScan.js';

useTempDataDir();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: db } = await import('../src/db.js');
const {
  default: authRouter, resetInviteAttemptLimits, INVITE_FAILURES_PER_WINDOW,
} = await import('../src/routes/auth.js');
const { purgeOldInvites } = await import('../src/middleware/auth.js');
const passwordHash = await import('../src/lib/passwordHash.js');
const { FREE_FAILURES } = await import('../src/lib/accountThrottle.js');
const { logger } = await import('../src/lib/logger.js');
const { generateSecret } = await import('../src/lib/mfa.js');
const { generateSync } = await import('otplib');

const DAY = 24 * 60 * 60 * 1000;
const ADMIN_PW = 'admin-password-1';
const CHOSEN = 'chosen-password-1';
const INVALID = { error: 'invite_invalid' };
const SLOWED = { error: 'Too many attempts - please wait a few minutes and try again.' };
const WRONG_LOGIN = { error: 'Incorrect username or password' };

let server;
before(async () => { server = await mountRouterTrustingProxy('/api/auth', authRouter); });
after(async () => {
  mock.timers.reset();
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const tokenFor = (id) => {
  const u = userRow(id);
  return signToken({ id, username: u.username, role: u.role, sid: makeSession(db, id) });
};

let adminToken;
let carerToken;
beforeEach(() => {
  mock.timers.reset();
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run(); // and, through the foreign key, every user_invites row
  makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin', password: ADMIN_PW });
  makeUser(db, { id: 'u-carer', username: 'carer', role: 'caregiver', password: 'carer-password' });
  adminToken = tokenFor('u-admin');
  carerToken = tokenFor('u-carer');
  // The limiter's store is module-level and shared across cases, like every limiter here.
  resetInviteAttemptLimits();
});

const api = (method, p, { body, token, headers } = {}) => call(`${server.url}/api/auth${p}`, { method, body, token, headers });
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const inviteRow = (token) => db.prepare('SELECT * FROM user_invites WHERE token_hash = ?').get(sha256(token));
const invitesOf = (id) => db.prepare('SELECT * FROM user_invites WHERE user_id = ?').all(id);
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const check = (token, headers) => api('POST', '/invite/check', { body: { token }, headers });
const redeem = (token, password = CHOSEN, headers) => api('POST', '/invite/redeem', { body: { token, password }, headers });
const login = (username, password, ip = nextIp()) =>
  api('POST', '/login', { body: { username, password }, headers: { 'x-forwarded-for': ip } });
const stats = () => passwordHash.passwordWorkerStats();

// Every sign-in from its own source address, so the per-source login limiters (module-level, 20 per account and
// source) never engage and cannot make a case pass for the wrong reason.
let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `10.94.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

// Through the real route (a cost-10 placeholder hash, ~80 ms).
async function createInvite(body = {}) {
  const res = await api('POST', '/users', { token: adminToken, body: { username: 'newcarer', first_name: 'Robin', invite: true, ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

// A pending account with an open invite, straight into the database: no cost-10 hash, and any timestamps. The
// placeholder is a real (cheap) bcrypt hash of a string no test types, and the invite is bound to it, as the route does.
let plantSeq = 0;
function plantPending({ role = 'caregiver', hash, expiresInMs = 7 * DAY, usedAt = null, mfaSecret = null } = {}) {
  plantSeq += 1;
  const id = `u-pend-${plantSeq}`;
  const username = `pend${plantSeq}`;
  const placeholder = hash ?? bcrypt.hashSync(`unknowable-${plantSeq}-${randomBytes(8).toString('hex')}`, 4);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, password_set, mfa_enabled, mfa_secret) VALUES (?, ?, ?, ?, 0, ?, ?)'
  ).run(id, username, placeholder, role, mfaSecret ? 1 : 0, mfaSecret);
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO user_invites (id, user_id, token_hash, placeholder_hash, created_by, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, 'u-admin', ?, ?, ?)`
  ).run(`inv-${plantSeq}`, id, sha256(token), placeholder, utc(Date.now()), utc(Date.now() + expiresInMs), usedAt);
  return { id, username, token, placeholder };
}

// Sends `send()`, waits until it has submitted its bcrypt job, runs `act` while that job is still pending, and returns
// the response. Fails (rather than passing vacuously) if the request ended without hashing.
async function duringTheHash(send, act) {
  const before = stats().submitted;
  let settled = false;
  const pending = send().finally(() => { settled = true; });
  while (!settled && stats().submitted === before) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the request ended without hashing a password, so nothing happened "meanwhile"');
  assert.ok(stats().pending > 0, 'the hash had already finished, so this case proves nothing');
  act();
  return pending;
}

// Holds the ONE password worker busy (a cost-13 hash, several hundred ms), so requests sent now are all still waiting
// on their hashes when the last of them arrives.
const clogWorker = () => passwordHash.hash('clog-the-worker', 13);

// ---------------------------------------------------------------------------------------------------------------------

describe('POST /users with invite: true', () => {
  test('★ makes a pending caregiver and answers the token ONCE; the database holds only its sha256', async () => {
    const before = Date.now();
    const res = await api('POST', '/users', { token: adminToken, body: { username: 'robin', first_name: ' Robin ', last_name: 'Ash', invite: true } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { token, expires_at: expiresAt } = res.body.invite;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/, 'not 32 random bytes in base64url');
    assert.deepEqual(Object.keys(res.body.invite).sort(), ['expires_at', 'token']);
    assert.equal(JSON.stringify(res.body).split(token).length - 1, 1, 'the token is not in the answer exactly once');
    assert.equal(res.body.role, 'caregiver');
    assert.equal(res.body.first_name, 'Robin');
    // 7 days from now, in the API's UTC text format.
    assert.match(expiresAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const expiresMs = Date.parse(`${expiresAt.replace(' ', 'T')}Z`);
    assert.ok(Math.abs(expiresMs - (before + 7 * DAY)) < 5000, `expires_at ${expiresAt} is not 7 days from now`);

    const u = userRow(res.body.id);
    assert.equal(u.password_set, 0);
    assert.match(u.password_hash, /^\$2[aby]\$10\$/, 'the placeholder is not a real cost-10 bcrypt hash');
    const row = inviteRow(token);
    assert.ok(row, 'no invite row under sha256(token)');
    assert.equal(row.user_id, u.id);
    assert.equal(row.placeholder_hash, u.password_hash, 'the invite is not bound to the placeholder it was made with');
    assert.equal(row.used_at, null);
    assert.equal(row.created_by, 'u-admin');
    // Hostile: every column of both rows, from the schema, must be free of the token itself.
    for (const [table, r] of [['user_invites', row], ['users', u]]) {
      for (const { name } of db.prepare(`PRAGMA table_info(${table})`).all()) {
        assert.ok(!String(r[name] ?? '').includes(token), `${table}.${name} holds the token in clear`);
      }
    }
  });

  test('★ the refusals: a password too, an admin role, untyped fields; nothing is created', async () => {
    const cases = [
      [{ username: 'x1', invite: true, password: 'long-enough-1' }, /not both/],
      [{ username: 'x2', invite: true, role: 'admin' }, /only create a caregiver/],
      [{ username: 'x3', invite: true, role: 'boss' }, /only create a caregiver/],
      [{ username: ['x4'], invite: true }, /username is required/],
      [{ username: '   ', invite: true }, /username is required/],
      [{ username: 'x6', invite: true, first_name: 42 }, /must be text/],
      [{ username: 'x7', invite: true, last_name: { a: 1 } }, /must be text/],
    ];
    for (const [body, error] of cases) {
      const res = await api('POST', '/users', { token: adminToken, body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} was not refused: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, error);
    }
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 2, 'a refused invite still created an account');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM user_invites').get().c, 0);
  });

  test('a blank or null password is "no password", so the invite is made', async () => {
    for (const [i, password] of ['', null].entries()) {
      const res = await api('POST', '/users', { token: adminToken, body: { username: `blank${i}`, invite: true, password } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
  });

  test('only the boolean true is an invite: the string "true" takes the password path and is refused for having no password', async () => {
    const res = await api('POST', '/users', { token: adminToken, body: { username: 'sloppy', invite: 'true' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Username and an 8+ character password are required');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'sloppy'").get().c, 0);
  });

  test('a taken username is refused, and a caregiver cannot make an invite (403)', async () => {
    const taken = await api('POST', '/users', { token: adminToken, body: { username: 'carer', invite: true } });
    assert.equal(taken.status, 400);
    assert.equal(taken.body.error, 'That username is already taken');
    const asCarer = await api('POST', '/users', { token: carerToken, body: { username: 'sneaky', invite: true } });
    assert.equal(asCarer.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM user_invites').get().c, 0);
  });
});

describe('POST /invite/check', () => {
  test('★ a usable invite answers whose it is: first name, username and the app name, nothing else', async () => {
    const created = await createInvite({ username: 'robin', first_name: 'Robin' });
    const res = await check(created.invite.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { first_name: 'Robin', username: 'robin', app_name: 'Nightlight' });
  });

  test('★ unknown, expired, used and malformed tokens all get the SAME 404', async () => {
    const expired = plantPending({ expiresInMs: -60_000 });
    const used = plantPending({ usedAt: utc(Date.now() - 60_000) });
    const unknown = randomBytes(32).toString('base64url');
    const live = plantPending();
    const tokens = [
      unknown, expired.token, used.token,
      live.token.slice(0, 42), `${live.token}A`, `${live.token.slice(0, 42)}=`, `${live.token.slice(0, 42)}+`,
      '', 42, null, { token: live.token }, [live.token], undefined,
    ];
    for (const token of tokens) {
      const res = await check(token);
      assert.equal(res.status, 404, `${JSON.stringify(token)} was not refused`);
      assert.deepEqual(res.body, INVALID, `${JSON.stringify(token)} got a different body`);
    }
    // The control: the well-formed live one is accepted, so the 404s above are about the tokens.
    assert.equal((await check(live.token)).status, 200);
  });

  test('★ an invite whose account is no longer a pending caregiver with its placeholder is refused', async () => {
    // Each change the redeem's compare-and-swap re-checks after the hash is also refused up front, so a stale link
    // never costs a bcrypt hash and the page says "not valid" at once.
    const passwordSet = plantPending();
    db.prepare('UPDATE users SET password_set = 1 WHERE id = ?').run(passwordSet.id);
    const promoted = plantPending();
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(promoted.id);
    const rehashed = plantPending();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('set-elsewhere-1', 4), rehashed.id);
    for (const [why, p] of [['password set', passwordSet], ['made an admin', promoted], ['password hash replaced', rehashed]]) {
      const res = await check(p.token);
      assert.equal(res.status, 404, `${why}: the invite still checks as usable`);
      assert.deepEqual(res.body, INVALID);
    }
  });
});

describe('POST /invite/redeem', () => {
  test('★ the caregiver chooses a password and is signed in; the link is then spent', async () => {
    const created = await createInvite({ username: 'robin' });
    const { token } = created.invite;
    const res = await redeem(token, CHOSEN);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body).sort(), ['token', 'user']);
    assert.equal(res.body.user.username, 'robin');
    assert.equal(res.body.user.role, 'caregiver');
    // The session works, exactly like one from /login.
    const me = await api('GET', '/me', { token: res.body.token });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.id, created.id);
    const u = userRow(created.id);
    assert.equal(u.password_set, 1);
    assert.ok(await bcrypt.compare(CHOSEN, u.password_hash), 'the chosen password was not stored');
    assert.match(inviteRow(token).used_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // And they can sign in with it from now on.
    const signIn = await login('robin', CHOSEN);
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    // Spent: a second use, or a check, is the invalid answer.
    assert.deepEqual([(await redeem(token, 'another-password-2')).status, (await check(token)).status], [404, 404]);
    assert.ok(await bcrypt.compare(CHOSEN, userRow(created.id).password_hash), 'a second redeem changed the password');
  });

  test('★ unknown, expired, used and malformed tokens get the same 404, and nothing is written', async () => {
    const expired = plantPending({ expiresInMs: -60_000 });
    const used = plantPending({ usedAt: utc(Date.now() - 60_000) });
    const before = stats().submitted;
    for (const token of [randomBytes(32).toString('base64url'), expired.token, used.token, 'short', 7, null]) {
      const res = await redeem(token);
      assert.equal(res.status, 404, `${JSON.stringify(token)} was not refused`);
      assert.deepEqual(res.body, INVALID);
    }
    // The redeem's OWN up-front check refused them, before bcrypt (review L3): the claim after the hash would give the
    // same 404, so only the work done can tell "refused up front" from "refused after a hash".
    assert.equal(stats().submitted, before, 'a token that cannot be used cost a bcrypt hash');
    for (const p of [expired, used]) {
      assert.equal(userRow(p.id).password_set, 0);
      assert.equal(userRow(p.id).password_hash, p.placeholder);
    }
    assert.equal(inviteRow(expired.token).used_at, null);
  });

  test('★ a password under 8 characters is refused WITHOUT spending the invite', async () => {
    const p = plantPending();
    // Sent as given (not through redeem(), whose default would fill in a missing password).
    for (const body of [{ password: 'short' }, { password: '1234567' }, { password: '' }, { password: 12345678 }, {}]) {
      const res = await api('POST', '/invite/redeem', { body: { token: p.token, ...body } });
      assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted`);
      assert.match(res.body.error, /at least 8 characters/);
    }
    assert.equal(inviteRow(p.token).used_at, null, 'a refused password spent the invite');
    assert.equal(userRow(p.id).password_set, 0);
    // The boundary (review L6): 7 characters was refused above, exactly 8 is accepted.
    assert.equal((await redeem(p.token, 'exactly8')).status, 200, 'the invite no longer worked after a too-short try, or 8 characters is refused');
  });

  test('★ two redeems of one token at the same moment: exactly one wins, and only ONE password is hashed', async () => {
    const p = plantPending();
    const clog = clogWorker();
    const before = stats().submitted;
    const [a, b] = await Promise.all([redeem(p.token, 'first-choice-1'), redeem(p.token, 'second-choice-2')]);
    await clog;
    // The second is told "in progress" (409), not "invalid" (review L1): a double tap must not look like a dead link.
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.status} ${JSON.stringify(a.body)} / ${b.status}`);
    const loser = a.status === 409 ? a : b;
    assert.deepEqual(loser.body, { error: 'invite_in_progress' });
    assert.equal(stats().submitted - before, 1, 'the second request queued a bcrypt job of its own (no single flight)');
    const winner = a.status === 200 ? 'first-choice-1' : 'second-choice-2';
    assert.ok(await bcrypt.compare(winner, userRow(p.id).password_hash));
  });

  test('★ an invite used meanwhile (while this redeem was hashing) is refused, and nothing is overwritten', async () => {
    const p = plantPending();
    const res = await duringTheHash(() => redeem(p.token), () => {
      db.prepare('UPDATE user_invites SET used_at = ? WHERE token_hash = ?').run(utc(Date.now()), sha256(p.token));
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(res.body, INVALID);
    assert.equal(userRow(p.id).password_hash, p.placeholder, 'the password was written although the invite was already used');
    assert.equal(userRow(p.id).password_set, 0);
  });

  test('★ an invite that runs out WHILE its password is hashing is refused: the clock is read again after the await', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const p = plantPending({ expiresInMs: 60_000 });
    const res = await duringTheHash(() => redeem(p.token), () => mock.timers.tick(5 * 60_000));
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(res.body, INVALID);
    assert.equal(inviteRow(p.token).used_at, null);
    assert.equal(userRow(p.id).password_hash, p.placeholder);
  });

  test('the control: the same one-minute invite, with the clock left alone, is redeemed', async () => {
    mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const p = plantPending({ expiresInMs: 60_000 });
    const res = await redeem(p.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test('★ an account made an admin meanwhile is not claimed, and the whole claim rolls back', async () => {
    const p = plantPending();
    const res = await duringTheHash(() => redeem(p.token), () => {
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(p.id);
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.deepEqual(res.body, INVALID);
    const u = userRow(p.id);
    assert.equal(u.password_hash, p.placeholder, 'a link set the password of an admin account');
    assert.equal(u.password_set, 0);
    // Rolled back, not half-done: the invite is not marked used (a plain return in the transaction would commit that).
    assert.equal(inviteRow(p.token).used_at, null, 'the refused claim still marked the invite used');
  });

  test('★ an account given a password meanwhile (password_set = 1) is not claimed', async () => {
    const p = plantPending();
    const res = await duringTheHash(() => redeem(p.token), () => {
      db.prepare('UPDATE users SET password_set = 1 WHERE id = ?').run(p.id);
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(userRow(p.id).password_hash, p.placeholder, 'the link overwrote an account that has a password');
    assert.equal(inviteRow(p.token).used_at, null);
  });

  test('★ a password hash replaced meanwhile is never overwritten by the link', async () => {
    const p = plantPending();
    const elsewhere = bcrypt.hashSync('set-elsewhere-2', 4);
    const res = await duringTheHash(() => redeem(p.token), () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(elsewhere, p.id);
    });
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(userRow(p.id).password_hash, elsewhere, 'the link overwrote a password set while it was hashing');
    assert.equal(inviteRow(p.token).used_at, null);
  });

  test('★ C2: a password an OLDER version set while the account was pending survives the link; an admin then recovers the account', async () => {
    // What an older version does: it knows nothing of password_set or invites, so it writes the hash, signs the
    // account's sessions out, and leaves password_set = 0 and the invite open.
    const p = plantPending();
    const olderHash = bcrypt.hashSync('set-by-older-version', 4);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(olderHash, p.id);
    const res = await redeem(p.token);
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.equal(userRow(p.id).password_hash, olderHash, 'the link replaced a password an admin had set');
    // Still pending on this version, so that password does not sign in either (docs/caregivers.md says so).
    assert.equal((await login(p.username, 'set-by-older-version')).status, 401);
    // The recovery: the admin sets the password again from this version.
    const put = await api('PUT', `/users/${p.id}`, { token: adminToken, body: { password: 'set-again-here-1' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(userRow(p.id).password_set, 1);
    assert.deepEqual(invitesOf(p.id), [], 'the open invite survived the admin setting a password');
    assert.equal((await login(p.username, 'set-again-here-1')).status, 200);
    assert.equal((await redeem(p.token)).status, 404);
  });

  test('★ redeeming signs out every earlier session of the account and drops its push registrations', async () => {
    const p = plantPending();
    // There should be none (a pending account cannot sign in); the redeem makes sure, inside its transaction.
    const oldSid = makeSession(db, p.id);
    db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run('tok-pend', p.id, oldSid, 'android');
    db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run('tok-other', 'u-carer', null, 'android');
    const res = await redeem(p.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sessions = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(p.id).map((s) => s.id);
    assert.ok(!sessions.includes(oldSid), 'a session from before the redeem survived it');
    assert.equal(sessions.length, 1, 'the redeem did not leave exactly its own new session');
    assert.deepEqual(db.prepare('SELECT token FROM push_tokens ORDER BY token').all().map((r) => r.token), ['tok-other']);
  });

  test('★ redeeming empties the account\'s password throttle (L1), so the new password signs in at once', async () => {
    const p = plantPending();
    for (let i = 0; i < FREE_FAILURES; i++) await login(p.username, 'a-wrong-guess');
    assert.equal((await login(p.username, 'a-wrong-guess')).status, 429, 'the throttle never engaged, so this case proves nothing');
    assert.equal((await redeem(p.token, CHOSEN)).status, 200);
    const res = await login(p.username, CHOSEN);
    assert.equal(res.status, 200, `the account stayed throttled after its password was chosen: ${JSON.stringify(res.body)}`);
  });

  test('★ C3: at most 4 invite hashes queue at once, across different tokens; the rest get the limiter\'s 429', async () => {
    const invites = Array.from({ length: 6 }, () => plantPending());
    const clog = clogWorker();
    const before = stats().submitted;
    const results = await Promise.all(invites.map((p) => redeem(p.token)));
    await clog;
    const statuses = results.map((r) => r.status);
    assert.deepEqual([...statuses].sort(), [200, 200, 200, 200, 429, 429], JSON.stringify(statuses));
    assert.equal(stats().submitted - before, 4, 'more than 4 invite hashes were queued at once');
    for (const r of results.filter((x) => x.status === 429)) assert.deepEqual(r.body, SLOWED);
    // The count went back down: a refused one goes through when tried again.
    const refused = invites[statuses.indexOf(429)];
    assert.equal((await redeem(refused.token)).status, 200, 'the in-flight count never came back down');
  });

  // Review M-2: both bounds above are released in `finally`, and a hash that FAILS is the path that needs it. The
  // worker is stopped while a redeem's hash is pending (a real failure the app can meet: a worker that crashes), so
  // the route answers 500 and must still let go of the token and of its slot in the cap.
  const failedRedeem = async (token) => {
    const res = await duringTheHash(() => redeem(token), () => { void passwordHash.stopPasswordWorker(); });
    assert.equal(res.status, 500, `the stopped worker did not fail the redeem: ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  test('★ a redeem whose hash fails releases its token: the same link works when tried again', async () => {
    const p = plantPending();
    await failedRedeem(p.token);
    assert.equal(inviteRow(p.token).used_at, null, 'a failed redeem spent the invite');
    const retry = await redeem(p.token);
    assert.equal(retry.status, 200, `the link stayed locked after a failed hash: ${retry.status} ${JSON.stringify(retry.body)}`);
  });

  test('★ four failed hashes on one link do not use up the cap: another invite still redeems', async () => {
    const a = plantPending();
    const b = plantPending();
    // Four, the cap: had any failure kept its slot, the cap would now be full.
    for (let i = 0; i < 4; i++) await failedRedeem(a.token);
    const other = await redeem(b.token);
    assert.equal(other.status, 200, `the failed hashes kept their slots in the cap: ${other.status} ${JSON.stringify(other.body)}`);
  });

  test('an account that somehow has two-factor on gets the second step, never a session from the link alone', async () => {
    // Not reachable through the API (a pending account cannot sign in to turn two-factor on); planted, because the
    // redeem answers like /login and must not skip a second factor if one is there.
    const p = plantPending({ mfaSecret: generateSecret() });
    const res = await redeem(p.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.mfaRequired, true);
    assert.equal(res.body.token, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(p.id).c, 0);
  });
});

describe('re-issue and revoke (admin)', () => {
  test('★ a new invite replaces the old one: the new link works, the old one is refused', async () => {
    const created = await createInvite({ username: 'robin' });
    const res = await api('POST', `/users/${created.id}/invite`, { token: adminToken });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body), ['invite']);
    assert.match(res.body.invite.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(res.body.invite.token, created.invite.token);
    assert.equal((await check(created.invite.token)).status, 404, 'the old link still works after a new one was made');
    assert.equal(invitesOf(created.id).length, 1);
    assert.equal((await redeem(res.body.invite.token)).status, 200);
  });

  test('★ re-issue is refused for an account with a password, a pending admin, and an unknown id; a caregiver gets 403', async () => {
    const pendingAdmin = plantPending({ role: 'admin' });
    for (const [why, id] of [['has a password', 'u-carer'], ['pending admin', pendingAdmin.id]]) {
      const res = await api('POST', `/users/${id}/invite`, { token: adminToken });
      assert.equal(res.status, 400, `${why}: an invite was made`);
      assert.match(res.body.error, /not chosen its password/);
    }
    assert.deepEqual(invitesOf('u-carer'), [], 'a refused re-issue still made an invite');
    assert.equal((await api('POST', '/users/nobody/invite', { token: adminToken })).status, 404);
    const created = await createInvite({ username: 'robin' });
    assert.equal((await api('POST', `/users/${created.id}/invite`, { token: carerToken })).status, 403);
  });

  test('★ revoking stops the link and leaves the account pending; unknown id 404; a caregiver gets 403', async () => {
    const created = await createInvite({ username: 'robin' });
    assert.equal((await api('DELETE', `/users/${created.id}/invite`, { token: carerToken })).status, 403);
    assert.equal((await check(created.invite.token)).status, 200, 'a refused revoke still stopped the link');
    const res = await api('DELETE', `/users/${created.id}/invite`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, revoked: 1 });
    assert.equal((await check(created.invite.token)).status, 404);
    assert.equal(userRow(created.id).password_set, 0);
    assert.equal((await api('DELETE', '/users/nobody/invite', { token: adminToken })).status, 404);
  });
});

describe('a pending account can never sign in', () => {
  test('★ /login refuses it even with the password its stored hash really matches, exactly like a wrong one, and counts it', async () => {
    // HOSTILE: a hash of a password this test knows, so only the guard can refuse it (M3).
    const p = plantPending({ hash: bcrypt.hashSync('known-pass-123', 4) });
    const before = stats().submitted;
    const res = await login(p.username, 'known-pass-123');
    // AFTER the same compare as any account (review L4): skipping bcrypt for a pending name would make it answer
    // faster, which tells a guesser "this name is waiting on an invite".
    assert.equal(stats().submitted - before, 1, 'a pending account was refused without the same bcrypt compare');
    assert.equal(res.status, 401, `a pending account signed in: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, WRONG_LOGIN);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(p.id).c, 0);
    // Counted like a wrong password: after FREE_FAILURES in all, the account is throttled.
    for (let i = 1; i < FREE_FAILURES; i++) await login(p.username, 'known-pass-123');
    assert.equal((await login(p.username, 'known-pass-123')).status, 429, 'the refused sign-ins were not counted');
  });

  test('★ a session that already exists stops working once its account is pending (requireAuth)', async () => {
    assert.equal((await api('GET', '/me', { token: carerToken })).status, 200, 'the control: the session works');
    db.prepare("UPDATE users SET password_set = 0 WHERE id = 'u-carer'").run();
    const res = await api('GET', '/me', { token: carerToken });
    assert.equal(res.status, 401, 'a session of a pending account still authenticates');
  });

  test('★ /login/mfa refuses an MFA token for a pending account (control: the same for an account with a password)', async () => {
    const secret = generateSecret();
    const pending = plantPending({ mfaSecret: secret });
    const control = plantPending({ mfaSecret: secret });
    db.prepare('UPDATE users SET password_set = 1 WHERE id = ?').run(control.id);
    const step = (id) => api('POST', '/login/mfa', {
      body: { mfaToken: signToken({ id, purpose: 'mfa' }, { expiresIn: '5m' }), code: generateSync({ secret }) },
      headers: { 'x-forwarded-for': nextIp() },
    });
    const refused = await step(pending.id);
    assert.equal(refused.status, 401, `a pending account finished the second step: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.token, undefined);
    const ok = await step(control.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

describe('admin changes to a pending account', () => {
  test('★ it cannot be made an admin, unless the same change gives it a password', async () => {
    const p = plantPending();
    const refused = await api('PUT', `/users/${p.id}`, { token: adminToken, body: { role: 'admin' } });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(refused.body.error, /cannot be an admin/);
    assert.equal(userRow(p.id).role, 'caregiver');
    const withPassword = await api('PUT', `/users/${p.id}`, { token: adminToken, body: { role: 'admin', password: 'admin-chosen-1' } });
    assert.equal(withPassword.status, 200, JSON.stringify(withPassword.body));
    assert.equal(userRow(p.id).role, 'admin');
    assert.equal(userRow(p.id).password_set, 1);
    assert.deepEqual(invitesOf(p.id), [], 'an admin account kept an open invite');
  });

  test('★ an admin setting its password ends the invite: password_set = 1, the link refused, the password signs in', async () => {
    const created = await createInvite({ username: 'robin' });
    const res = await api('PUT', `/users/${created.id}`, { token: adminToken, body: { password: 'set-by-admin-1' } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(userRow(created.id).password_set, 1);
    assert.deepEqual(invitesOf(created.id), []);
    assert.equal((await check(created.invite.token)).status, 404);
    assert.equal((await redeem(created.invite.token)).status, 404);
    assert.equal((await login('robin', 'set-by-admin-1')).status, 200);
  });

  test('a change without a password (a name) leaves the invite working', async () => {
    const created = await createInvite({ username: 'robin' });
    const res = await api('PUT', `/users/${created.id}`, { token: adminToken, body: { first_name: 'Rob' } });
    assert.equal(res.status, 200);
    assert.equal(userRow(created.id).password_set, 0);
    assert.deepEqual((await check(created.invite.token)).body, { first_name: 'Rob', username: 'robin', app_name: 'Nightlight' });
  });

  test('★ a pending admin does not count as an admin: the only real one cannot step down', async () => {
    // Not reachable through the API; a database edited by hand or restored from elsewhere.
    const pendingAdmin = plantPending({ role: 'admin' });
    const refused = await api('PUT', '/users/u-admin', { token: adminToken, body: { role: 'caregiver' } });
    assert.equal(refused.status, 409, `the last admin who can sign in stepped down: ${JSON.stringify(refused.body)}`);
    assert.equal(userRow('u-admin').role, 'admin');
    // The control: once that other admin has a password it counts, and the change goes through.
    db.prepare('UPDATE users SET password_set = 1 WHERE id = ?').run(pendingAdmin.id);
    const ok = await api('PUT', '/users/u-admin', { token: adminToken, body: { role: 'caregiver' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test('removing the account removes its invites', async () => {
    const created = await createInvite({ username: 'robin' });
    assert.equal(invitesOf(created.id).length, 1);
    assert.equal((await api('DELETE', `/users/${created.id}`, { token: adminToken })).status, 204);
    assert.deepEqual(invitesOf(created.id), []);
    assert.equal((await check(created.invite.token)).status, 404);
  });
});

describe('GET /users: where each account\'s invite stands', () => {
  test('★ password_set, invite_expires_at and invite_accepted_at, per account; never the token or a hash', async () => {
    const live = plantPending();
    const expired = plantPending({ expiresInMs: -60_000 });
    const redeemed = plantPending();
    assert.equal((await redeem(redeemed.token)).status, 200);
    const longAgo = plantPending({ expiresInMs: -6 * DAY, usedAt: utc(Date.now() - 8 * DAY) });
    db.prepare('UPDATE users SET password_set = 1 WHERE id = ?').run(longAgo.id);
    const pendingAdmin = plantPending({ role: 'admin' });
    // Review L2 / Codex 2: an invite the link can no longer use is not listed as open. Its account's hash was replaced
    // behind it (what an older version does when it sets a password), so /invite/check refuses it; and a cancelled one.
    const rehashed = plantPending();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('set-by-older-version', 4), rehashed.id);
    assert.equal((await check(rehashed.token)).status, 404, 'precondition: the link is refused by /invite/check');
    const cancelled = plantPending();
    assert.equal((await api('DELETE', `/users/${cancelled.id}/invite`, { token: adminToken })).status, 200);
    const res = await api('GET', '/users', { token: adminToken });
    assert.equal(res.status, 200);
    const by = Object.fromEntries(res.body.map((u) => [u.id, u]));
    const pick = (id) => ({
      password_set: by[id].password_set, invite_expires_at: by[id].invite_expires_at, invite_accepted_at: by[id].invite_accepted_at,
    });
    assert.deepEqual(pick(live.id), { password_set: false, invite_expires_at: inviteRow(live.token).expires_at, invite_accepted_at: null });
    assert.deepEqual(pick(expired.id), { password_set: false, invite_expires_at: null, invite_accepted_at: null });
    assert.deepEqual(pick(redeemed.id), { password_set: true, invite_expires_at: null, invite_accepted_at: inviteRow(redeemed.token).used_at });
    assert.notEqual(by[redeemed.id].invite_accepted_at, null);
    assert.deepEqual(pick(longAgo.id), { password_set: true, invite_expires_at: null, invite_accepted_at: null });
    assert.deepEqual(pick(pendingAdmin.id), { password_set: false, invite_expires_at: null, invite_accepted_at: null });
    assert.deepEqual(pick(rehashed.id), { password_set: false, invite_expires_at: null, invite_accepted_at: null },
      'an invite /invite/check refuses is listed as open');
    assert.deepEqual(pick(cancelled.id), { password_set: false, invite_expires_at: null, invite_accepted_at: null });
    assert.deepEqual(pick('u-carer'), { password_set: true, invite_expires_at: null, invite_accepted_at: null });
    const text = JSON.stringify(res.body);
    for (const p of [live, expired, redeemed, longAgo, pendingAdmin, rehashed, cancelled]) {
      assert.ok(!text.includes(p.token), 'the list carries an invite token');
      assert.ok(!text.includes(sha256(p.token)), 'the list carries a token hash');
    }
    assert.doesNotMatch(text, /\$2[aby]\$/, 'the list carries a bcrypt hash');
  });
});

describe('the limits on the public routes', () => {
  test('★ check and redeem share ONE failures-only bucket: failures on either use it up for both', async () => {
    const ip = nextIp();
    const p = plantPending();
    const junk = () => randomBytes(32).toString('base64url');
    for (let i = 0; i < INVITE_FAILURES_PER_WINDOW - 1; i++) {
      assert.equal((await check(junk(), { 'x-forwarded-for': ip })).status, 404);
    }
    // The last failure comes from the OTHER route: it must land in the same bucket.
    assert.equal((await redeem(junk(), CHOSEN, { 'x-forwarded-for': ip })).status, 404);
    const checkNow = await check(p.token, { 'x-forwarded-for': ip });
    assert.equal(checkNow.status, 429, 'a redeem failure was not counted against check');
    assert.deepEqual(checkNow.body, SLOWED);
    const redeemNow = await redeem(p.token, CHOSEN, { 'x-forwarded-for': ip });
    assert.equal(redeemNow.status, 429, 'redeem is not limited');
    assert.equal(inviteRow(p.token).used_at, null);
    // Another source is not affected.
    assert.equal((await check(p.token, { 'x-forwarded-for': nextIp() })).status, 200);
  });

  test('★ successes do not count: a caregiver reloading the page many times is never limited', async () => {
    const ip = nextIp();
    const p = plantPending();
    for (let i = 0; i < INVITE_FAILURES_PER_WINDOW + 5; i++) {
      const res = await check(p.token, { 'x-forwarded-for': ip });
      assert.equal(res.status, 200, `the ${i + 1}th successful check was refused`);
    }
    assert.equal((await redeem(p.token, CHOSEN, { 'x-forwarded-for': ip })).status, 200);
  });
});

// Found in the review of #1094 (verified by running): bcryptjs's own UTF-8 conversion fails slowly, on the ONE worker
// every sign-in queues on, for a password holding an unpaired UTF-16 surrogate, and the route then answered 500. That
// was reachable without signing in, through /login, and through /invite/redeem (where it also did not spend the invite,
// so it could be repeated). lib/passwordHash.js now refuses one before the worker; these cases go through the routes.
// FAILS WITHOUT THE FIX (verified by removing the guard): every refused case below answered 500 after the slow failure
// and queued a worker job.
describe('a password that is not valid text never reaches bcrypt', () => {
  // An unpaired surrogate (half of a pair, alone) at the start, in the middle and at the end, and a pair in the wrong
  // order (two lone halves). JSON.stringify writes each as a "\udXXX" escape, and the server's parser hands back that
  // lone code unit: exactly what a hostile client can send.
  const NOT_TEXT = ['\uD800abcdefgh', 'abcd\uDC00efgh', 'abcdefgh\uD800', 'abcdefgh\uDE00\uD83D'];
  // A well-formed pair (an emoji) is ordinary text and must keep working.
  const FINE = 'abcdefg😀';
  const REFUSED = { error: 'That password contains characters that cannot be used' };

  test('★ /login answers exactly like a wrong password, counts it, and queues no bcrypt job', async () => {
    makeUser(db, { id: 'u-text', username: 'texttest', role: 'caregiver', password: 'text-password-1' });
    const before = stats().submitted;
    for (const password of NOT_TEXT) {
      const res = await login('texttest', password);
      assert.equal(res.status, 401, `${JSON.stringify(password)}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, WRONG_LOGIN);
    }
    assert.equal(stats().submitted, before, 'a password that is not valid text reached the bcrypt worker');
    // Counted like a wrong password: FREE_FAILURES of them in all, and the account is slowed, even for the right one.
    for (let i = NOT_TEXT.length; i < FREE_FAILURES; i++) await login('texttest', NOT_TEXT[i % NOT_TEXT.length]);
    assert.equal((await login('texttest', 'text-password-1')).status, 429, 'the refused sign-ins were not counted');
  });

  test('★ the invite redeem answers 400 before taking a slot: no bcrypt job, nothing written, the invite still works', async () => {
    const p = plantPending();
    const before = stats().submitted;
    for (const password of NOT_TEXT) {
      const res = await redeem(p.token, password);
      assert.equal(res.status, 400, `${JSON.stringify(password)}: ${res.status} ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, REFUSED);
    }
    assert.equal(stats().submitted, before, 'a password that is not valid text reached the bcrypt worker');
    assert.equal(inviteRow(p.token).used_at, null, 'a refused password spent the invite');
    assert.equal(userRow(p.id).password_hash, p.placeholder);
    // BEFORE the single-flight slot: while a good redeem of the same link is hashing (held behind a slow job), the bad
    // one gets its own 400, not the 409 meant for a second attempt at the same moment.
    const clog = clogWorker();
    let bad;
    const good = await duringTheHash(() => redeem(p.token, FINE), () => { bad = redeem(p.token, NOT_TEXT[1]); });
    await clog;
    const badRes = await bad;
    assert.equal(badRes.status, 400, `the check comes after the single-flight slot: ${badRes.status} ${JSON.stringify(badRes.body)}`);
    assert.deepEqual(badRes.body, REFUSED);
    // The good one, holding an emoji, was redeemed, and signs in.
    assert.equal(good.status, 200, JSON.stringify(good.body));
    assert.equal((await login(p.username, FINE)).status, 200);
  });

  test('★ the routes that set a password answer 400 and queue no bcrypt job; nothing is written', async () => {
    const carerBefore = userRow('u-carer');
    const before = stats().submitted;
    const sends = (password) => [
      ['POST /users', () => api('POST', '/users', { token: adminToken, body: { username: 'texttest', password } })],
      ['PUT /users/:id', () => api('PUT', '/users/u-carer', { token: adminToken, body: { password } })],
      ['PUT /me/password', () => api('PUT', '/me/password', {
        token: carerToken, body: { current_password: 'carer-password', new_password: password }, headers: { 'x-forwarded-for': nextIp() },
      })],
    ];
    for (const password of NOT_TEXT) {
      for (const [route, send] of sends(password)) {
        const res = await send();
        assert.equal(res.status, 400, `${route} ${JSON.stringify(password)}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.deepEqual(res.body, REFUSED, route);
      }
    }
    assert.deepEqual(userRow('u-carer'), carerBefore, 'a refused password changed the account');
    assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'texttest'").get().c, 0);
    // /setup, on an installation with no account yet.
    db.prepare('DELETE FROM users').run();
    const setup = await api('POST', '/setup', { body: { username: 'first-admin', password: NOT_TEXT[2] } });
    assert.equal(setup.status, 400, JSON.stringify(setup.body));
    assert.deepEqual(setup.body, REFUSED);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 0, 'a refused /setup created an account');
    assert.equal(stats().submitted, before, 'a password that is not valid text reached the bcrypt worker');
    // The control: the same route with a well-formed pair works, and that password signs in.
    assert.equal((await api('POST', '/setup', { body: { username: 'first-admin', password: FINE } })).status, 200);
    assert.equal((await login('first-admin', FINE)).status, 200);
  });
});

describe('housekeeping, logs and the schema', () => {
  test('★ purgeOldInvites removes invites used or expired more than 30 days ago, and nothing else', () => {
    const rows = {
      live: plantPending(),
      expiredRecently: plantPending({ expiresInMs: -29 * DAY }),
      expiredLongAgo: plantPending({ expiresInMs: -31 * DAY }),
      usedRecently: plantPending({ usedAt: utc(Date.now() - 29 * DAY), expiresInMs: DAY }),
      usedLongAgo: plantPending({ usedAt: utc(Date.now() - 31 * DAY), expiresInMs: DAY }),
    };
    assert.equal(purgeOldInvites(), 2);
    const left = Object.entries(rows).filter(([, p]) => inviteRow(p.token)).map(([k]) => k).sort();
    assert.deepEqual(left, ['expiredRecently', 'live', 'usedRecently']);
    assert.equal(purgeOldInvites(), 0, 'a second run found more');
  });

  test('index.js pin: the invite purge runs at start and daily', () => {
    // index.js boots the app and cannot be imported, so this reads its source (on tokens, not exact text).
    const raw = fs.readFileSync(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
    const code = stripCommentsAndStrings(raw);
    assert.match(raw, /import \{[^}]*\bpurgeOldInvites\b[^}]*\} from '\.\/middleware\/auth\.js';/);
    assert.match(code, /^purgeOldInvites\(\);\r?$/m, 'the invite purge no longer runs at start');
    assert.match(code, /safeInterval\('', 24 \* 60 \* 60 \* 1000, purgeOldInvites\)/, 'the invite purge is no longer daily');
  });

  test('★ the token is in no log line, on any route, including an answer the body parser refuses', async () => {
    const lines = [];
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => mock.method(console, m, (...args) => { lines.push(args.map(String).join(' ')); }));
    const tokens = [];
    try {
      logger.info('capture-control-line'); // proves the capture sees the logger
      const created = await createInvite({ username: 'robin' });
      tokens.push(created.invite.token);
      await check(created.invite.token);
      await redeem(created.invite.token, 'short');
      const again = await createInvite({ username: 'robin2' });
      tokens.push(again.invite.token);
      const reissued = await api('POST', `/users/${again.id}/invite`, { token: adminToken });
      tokens.push(reissued.body.invite.token);
      // A body the JSON parser refuses, with a token in it: the error path must not log the body either.
      const broken = await fetch(`${server.url}/api/auth/invite/redeem`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"token":"${reissued.body.invite.token}","password":`,
      });
      assert.equal(broken.status, 400);
      await redeem(reissued.body.invite.token, CHOSEN);
      await api('DELETE', `/users/${created.id}/invite`, { token: adminToken });
    } finally {
      for (const s of spies) s.mock.restore();
    }
    const all = [...lines, ...logger.getRecent()].join('\n');
    assert.ok(all.includes('capture-control-line'), 'the capture saw nothing, so its silence proves nothing');
    for (const t of tokens) {
      assert.ok(!all.includes(t), 'an invite token reached the log');
      assert.ok(!all.includes(sha256(t)), 'an invite token hash reached the log');
    }
  });

  test('★ an older database gains password_set = 1 on every account it had, and a restart changes nothing', () => {
    // A separate process per boot (db.js migrates at import, and an ES module is imported once per process), against
    // one database file: boot 1 builds today's schema and takes the column away again, with accounts in it, the way an
    // install from before #1094 holds them; boot 2 is the upgrade.
    const dbJs = pathToFileURL(path.join(HERE, '..', 'src', 'db.js')).href;
    const boot = (dir, script) => execFileSync(
      process.execPath,
      ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\nconst { default: db } = await import(${JSON.stringify(dbJs)});\n${script}`],
      { encoding: 'utf8' }
    ).trim();
    const columns = "console.log(JSON.stringify(db.prepare('PRAGMA table_info(users)').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value }))));";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-invite-mig-'));
    try {
      const oldCols = JSON.parse(boot(dir, `
        db.exec('ALTER TABLE users DROP COLUMN password_set');
        db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'a', 'h1', 'admin'), ('u2', 'b', 'h2', 'caregiver')").run();
        ${columns}`));
      assert.ok(!oldCols.some((c) => c.name === 'password_set'), 'the fixture is not an older database');
      const upgraded = JSON.parse(boot(dir, columns));
      assert.deepEqual(upgraded.filter((c) => c.name !== 'password_set'), oldCols, 'the upgrade changed another users column');
      assert.deepEqual(upgraded.find((c) => c.name === 'password_set'), { name: 'password_set', type: 'INTEGER', notnull: 1, dflt: '1' });
      const rows = JSON.parse(boot(dir, "console.log(JSON.stringify(db.prepare('SELECT id, password_set FROM users ORDER BY id').all()));"));
      assert.deepEqual(rows, [{ id: 'u1', password_set: 1 }, { id: 'u2', password_set: 1 }], 'an existing account was made pending');
      boot(dir, "db.prepare(\"UPDATE users SET password_set = 0 WHERE id = 'u2'\").run();");
      assert.deepEqual(JSON.parse(boot(dir, columns)), upgraded, 'a further boot changed the users schema');
      assert.equal(JSON.parse(boot(dir, "console.log(JSON.stringify(db.prepare(\"SELECT password_set AS s FROM users WHERE id = 'u2'\").get().s));")), 0,
        're-running the migration reset a pending account');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
