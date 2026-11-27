// Disabling and re-enabling an account (#1233): PUT /users/:id/disabled, and every way a disabled account must NOT sign
// in, stay signed in or use an invite.
//
// THE CLAIMS this file holds, each by a test that fails without the code it names (mutants: scripts/mutants.json,
// labels "#1233 ..."; the session-check and push halves are in auth-middleware.test.js, talk-socket.test.js,
// push.test.js and push-public-url.test.js):
//   * disabling ends every session of the account and drops its push registrations, in one transaction; re-enabling
//     brings no session back; the account row is otherwise untouched (history, settings, two-factor, invite kept);
//   * your own account is refused, the body must be the boolean, and asking twice is harmless;
//   * a disabled admin does not count as an admin (adminCount), so the only ENABLED admin cannot step down;
//   * /login: the right password gets 403 ACCOUNT_DISABLED and no session, ONLY after the same compare and throttle as
//     any account; a wrong one gets the generic 401, exactly like an unknown name; a disable that lands while the
//     password is being compared wins;
//   * /login/mfa: an MFA token minted before the disable finishes nothing, and a disable that lands while a backup
//     code is being compared still gets no session (Codex plan review, High);
//   * a disabled account's invite is refused by /invite/check and /invite/redeem with the SAME 404 as any unusable
//     link, also when the disable lands while the link's password is hashing (Codex plan review, Medium);
//   * the new `disabled` key is only in GET /users and the route's own answer, and nothing outside the public fields
//     of a user leaks from either (a fixture derived from PRAGMA table_info(users));
//   * an older database gains the column with every account enabled.
//
// HOW THE "MEANWHILE" CASES WORK: as in auth-invite.test.js. duringTheHash() waits until the request has SUBMITTED its
// bcrypt job to the one worker (passwordWorkerStats), then changes the database while that job is provably still
// pending, so the route can only resume after the change.
import { test, describe, before, after, beforeEach } from 'node:test';
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

useTempDataDir();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: db } = await import('../src/db.js');
const {
  default: authRouter, resetInviteAttemptLimits, resetPasswordThrottles, resetMfaUserLimit,
} = await import('../src/routes/auth.js');
const passwordHash = await import('../src/lib/passwordHash.js');
const { FREE_FAILURES } = await import('../src/lib/accountThrottle.js');
const { generateSecret } = await import('../src/lib/mfa.js');
const { generateSync } = await import('otplib');

const DAY = 24 * 60 * 60 * 1000;
const ADMIN_PW = 'admin-password-1';
const CARER_PW = 'carer-password-1';
const WRONG_LOGIN = { error: 'Incorrect username or password' };
const DISABLED_LOGIN = { error: 'This account is disabled. Ask an admin.', code: 'ACCOUNT_DISABLED' };
const BAD_MFA_TOKEN = { error: 'Invalid verification token' };
const INVALID_INVITE = { error: 'invite_invalid' };
// The keys toPublicUser answers (routes/auth.js). Typed here on purpose: a widened allowlist must fail this file.
const PUBLIC_USER_KEYS = ['id', 'username', 'role', 'first_name', 'last_name', 'created_at', 'mfa_enabled', 'photo'];

let server;
before(async () => { server = await mountRouterTrustingProxy('/api/auth', authRouter); });
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const sessionsOf = (id) => db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(id).map((r) => r.id);
const tokenFor = (id) => {
  const u = userRow(id);
  return signToken({ id, username: u.username, role: u.role, sid: makeSession(db, id) });
};
const api = (method, p, { body, token, headers } = {}) => call(`${server.url}/api/auth${p}`, { method, body, token, headers });
// Every request from its own source address, so the per-source limiters (module-level) never decide a case.
let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `10.95.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };
const login = (username, password) => api('POST', '/login', { body: { username, password }, headers: { 'x-forwarded-for': nextIp() } });
const setDisabled = (id, disabled, token = adminToken) => api('PUT', `/users/${id}/disabled`, { token, body: { disabled } });
const flagOff = (id) => db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id);
const stats = () => passwordHash.passwordWorkerStats();

// Sends `send()`, waits until it has submitted its bcrypt job, runs `act` while that job is still pending, and returns
// the response. Fails (rather than passing vacuously) if the request ended without hashing.
async function duringTheHash(send, act) {
  const before = stats().submitted;
  let settled = false;
  const pending = send().finally(() => { settled = true; });
  while (!settled && stats().submitted === before) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'the request ended without hashing, so nothing happened "meanwhile"');
  assert.ok(stats().pending > 0, 'the hash had already finished, so this case proves nothing');
  act();
  return pending;
}

let adminToken;
let carerToken;
beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run(); // and, through the foreign key, every user_invites row
  makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin', password: ADMIN_PW });
  makeUser(db, { id: 'u-carer', username: 'alice', role: 'caregiver', password: CARER_PW });
  adminToken = tokenFor('u-admin');
  carerToken = tokenFor('u-carer');
  // Module-level stores, shared across cases like every limiter here.
  resetPasswordThrottles('u-carer', 'alice');
  resetPasswordThrottles('u-admin', 'admin');
  resetMfaUserLimit('u-carer');
  resetInviteAttemptLimits();
});

// ---------------------------------------------------------------------------------------------------------------------

describe('PUT /users/:id/disabled', () => {
  test('★ #1233 disabling signs the account out of every device at once and drops its push registrations', async () => {
    const second = makeSession(db, 'u-carer');
    const addPush = (token, userId, sid) =>
      db.prepare('INSERT INTO push_tokens (token, user_id, session_id, platform) VALUES (?, ?, ?, ?)').run(token, userId, sid, 'android');
    addPush('tok-carer-session', 'u-carer', second);
    addPush('tok-carer-legacy', 'u-carer', null); // tied to the account but to no session (an older registration)
    addPush('tok-admin', 'u-admin', makeSession(db, 'u-admin'));
    assert.equal((await api('GET', '/me', { token: carerToken })).status, 200, 'precondition: the session works');
    assert.equal(sessionsOf('u-carer').length, 2);

    const res = await setDisabled('u-carer', true);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.id, 'u-carer');
    assert.equal(res.body.disabled, true);
    assert.equal(userRow('u-carer').disabled, 1);
    assert.deepEqual(sessionsOf('u-carer'), [], 'a session of the disabled account survived');
    assert.deepEqual(db.prepare('SELECT token FROM push_tokens ORDER BY token').all().map((r) => r.token), ['tok-admin'],
      'a push registration of the disabled account survived, or another account\'s went too');
    assert.equal((await api('GET', '/me', { token: carerToken })).status, 401);
    // The admin who did it is untouched.
    assert.equal((await api('GET', '/me', { token: adminToken })).status, 200);
  });

  test('★ #1233 re-enabling brings no session back: the old token stays refused, a new sign-in works', async () => {
    assert.equal((await setDisabled('u-carer', true)).status, 200);
    const res = await setDisabled('u-carer', false);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.disabled, false);
    assert.equal(userRow('u-carer').disabled, 0);
    assert.equal((await api('GET', '/me', { token: carerToken })).status, 401, 'a session from before the disable came back');
    const signIn = await login('alice', CARER_PW);
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
    assert.ok(signIn.body.token);
  });

  test('★ #1233 the account row is untouched apart from `disabled`: history, settings, two-factor and invite are kept', async () => {
    db.prepare("UPDATE users SET first_name = 'Alice', mfa_enabled = 1, mfa_secret = ?, photo = 'data:image/png;base64,AA' WHERE id = 'u-carer'")
      .run(generateSecret());
    // Every column, from the schema, so a column added later is compared too.
    const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name).filter((n) => n !== 'disabled');
    const pick = (row) => Object.fromEntries(columns.map((c) => [c, row[c]]));
    const before = pick(userRow('u-carer'));
    assert.equal((await setDisabled('u-carer', true)).status, 200);
    assert.deepEqual(pick(userRow('u-carer')), before, 'disabling changed another column of the account');
    assert.equal((await setDisabled('u-carer', false)).status, 200);
    assert.deepEqual(pick(userRow('u-carer')), before, 'enabling changed another column of the account');
  });

  test('#1233 asking twice is harmless: the same answer, the same state', async () => {
    for (const disabled of [true, true, false, false]) {
      const res = await setDisabled('u-carer', disabled);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.disabled, disabled);
      assert.equal(userRow('u-carer').disabled, disabled ? 1 : 0);
    }
  });

  test('★ #1233 your own account cannot be disabled (400), and nothing changes; enabling yourself changes nothing', async () => {
    const res = await setDisabled('u-admin', true);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "You can't disable your own account");
    assert.equal(userRow('u-admin').disabled, 0);
    assert.equal(sessionsOf('u-admin').length, 1, 'a refused self-disable still signed the admin out');
    assert.equal((await api('GET', '/me', { token: adminToken })).status, 200);
    const enable = await setDisabled('u-admin', false);
    assert.equal(enable.status, 200, JSON.stringify(enable.body));
    assert.equal(enable.body.disabled, false);
  });

  test('#1233 the body must be the boolean: anything else is a 400 and changes nothing; an unknown id is a 404', async () => {
    for (const body of [{ disabled: 'true' }, { disabled: 1 }, { disabled: null }, { disabled: [true] }, {}]) {
      const res = await api('PUT', '/users/u-carer/disabled', { token: adminToken, body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} was accepted: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.error, 'disabled must be true or false.');
    }
    assert.equal(userRow('u-carer').disabled, 0);
    assert.equal(sessionsOf('u-carer').length, 1, 'a refused request still signed the account out');
    assert.equal((await setDisabled('nobody', true)).status, 404);
  });

  test('#1233 a caregiver cannot disable anyone (403)', async () => {
    const res = await setDisabled('u-admin', true, carerToken);
    assert.equal(res.status, 403);
    assert.equal(userRow('u-admin').disabled, 0);
  });

  test('#1233 an admin setting a disabled account\'s password does not enable it', async () => {
    assert.equal((await setDisabled('u-carer', true)).status, 200);
    const put = await api('PUT', '/users/u-carer', { token: adminToken, body: { password: 'reset-by-admin-1' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(userRow('u-carer').disabled, 1);
    assert.deepEqual((await login('alice', 'reset-by-admin-1')).body, DISABLED_LOGIN);
  });
});

describe('the admin guard counts ENABLED admins only (adminCount)', () => {
  test('★ #1233 a disabled admin does not count: the only enabled admin cannot step down', async () => {
    makeUser(db, { id: 'u-admin2', username: 'bob', role: 'admin', password: 'admin2-password' });
    assert.equal((await setDisabled('u-admin2', true)).status, 200);
    const refused = await api('PUT', '/users/u-admin', { token: adminToken, body: { role: 'caregiver' } });
    assert.equal(refused.status, 409, `the last enabled admin stepped down: ${JSON.stringify(refused.body)}`);
    assert.equal(userRow('u-admin').role, 'admin');
    // The control: once the other admin is enabled again it counts, and the same change goes through.
    assert.equal((await setDisabled('u-admin2', false)).status, 200);
    const ok = await api('PUT', '/users/u-admin', { token: adminToken, body: { role: 'caregiver' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

describe('/login on a disabled account', () => {
  test('★ #1233 the right password gets 403 ACCOUNT_DISABLED, after the same one compare, and no session', async () => {
    flagOff('u-carer');
    db.prepare('DELETE FROM sessions').run();
    const before = stats().submitted;
    const res = await login('alice', CARER_PW);
    assert.equal(stats().submitted - before, 1, 'the disabled account was answered without the usual compare');
    assert.equal(res.status, 403, `a disabled account signed in: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, DISABLED_LOGIN);
    assert.deepEqual(sessionsOf('u-carer'), []);
    // The control: the same account, enabled again, signs in with the same password.
    db.prepare("UPDATE users SET disabled = 0 WHERE id = 'u-carer'").run();
    assert.equal((await login('alice', CARER_PW)).status, 200);
  });

  test('★ #1233 a WRONG password on a disabled account is the generic 401, exactly like an unknown name, and is counted', async () => {
    flagOff('u-carer');
    const unknown = `nobody-${randomBytes(4).toString('hex')}`;
    for (const [who, name] of [['disabled account', 'alice'], ['unknown name', unknown]]) {
      const before = stats().submitted;
      const res = await login(name, 'a-wrong-guess');
      assert.equal(stats().submitted - before, 1, `${who}: not the same one compare`);
      assert.equal(res.status, 401, `${who}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, WRONG_LOGIN, `${who}: a different body tells the two apart`);
    }
    // Counted like any wrong password: after FREE_FAILURES in all the account is slowed, and the 403 is not reached
    // even with the right password, so the distinct answer cannot be used to dodge the throttle.
    for (let i = 1; i < FREE_FAILURES; i++) await login('alice', 'a-wrong-guess');
    const slowed = await login('alice', CARER_PW);
    assert.equal(slowed.status, 429, `the throttle did not apply to a disabled account: ${JSON.stringify(slowed.body)}`);
  });

  test('★ #1233 with two-factor on, the right password still gets the 403, never an MFA token', async () => {
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = 'u-carer'").run(generateSecret());
    flagOff('u-carer');
    const res = await login('alice', CARER_PW);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, DISABLED_LOGIN);
  });

  test('★ #1233 an account disabled WHILE its password is being compared gets the 403 and no session', async () => {
    db.prepare('DELETE FROM sessions').run();
    const res = await duringTheHash(() => login('alice', CARER_PW), () => flagOff('u-carer'));
    assert.equal(res.status, 403, `a sign-in that started before the disable got a session: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, DISABLED_LOGIN);
    assert.deepEqual(sessionsOf('u-carer'), []);
  });
});

describe('/login/mfa on a disabled account', () => {
  const mfaStep = (code) => api('POST', '/login/mfa', {
    body: { mfaToken: signToken({ id: 'u-carer', purpose: 'mfa' }, { expiresIn: '5m' }), code },
    headers: { 'x-forwarded-for': nextIp() },
  });

  test('★ #1233 an MFA token minted before the disable finishes nothing: the generic 401, no session', async () => {
    const secret = generateSecret();
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = 'u-carer'").run(secret);
    db.prepare('DELETE FROM sessions').run();
    flagOff('u-carer');
    const refused = await mfaStep(generateSync({ secret }));
    assert.equal(refused.status, 401, `a disabled account finished the second step: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(refused.body, BAD_MFA_TOKEN);
    assert.deepEqual(sessionsOf('u-carer'), []);
    // The control: enabled again, the very same code (it was not spent by the refusal) finishes the sign-in.
    db.prepare("UPDATE users SET disabled = 0 WHERE id = 'u-carer'").run();
    const ok = await mfaStep(generateSync({ secret }));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  test('★ #1233 an account disabled WHILE a backup code is being checked gets no session', async () => {
    // Two backup codes (cheap cost-4 hashes; the compare accepts any cost): the first is the control, the second races.
    const codes = ['aaaa-1111', 'bbbb-2222'];
    const hashes = JSON.stringify(codes.map((c) => bcrypt.hashSync(c.replace('-', ''), 4)));
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_backup_codes = ? WHERE id = 'u-carer'").run(generateSecret(), hashes);
    db.prepare('DELETE FROM sessions').run();
    const control = await mfaStep(codes[0]);
    assert.equal(control.status, 200, `the backup-code fixture does not sign in at all: ${JSON.stringify(control.body)}`);
    const sessionsBefore = sessionsOf('u-carer').length;

    const res = await duringTheHash(() => mfaStep(codes[1]), () => flagOff('u-carer'));
    assert.equal(res.status, 401, `a second step that started before the disable got a session: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, BAD_MFA_TOKEN);
    assert.equal(res.body.token, undefined);
    assert.equal(sessionsOf('u-carer').length, sessionsBefore, 'a session was made for the disabled account');
  });
});

// A pending account (#1094) with an open invite, straight into the database, as auth-invite.test.js plants them.
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
function plantPending() {
  const placeholder = bcrypt.hashSync(`unknowable-${randomBytes(8).toString('hex')}`, 4);
  db.prepare("INSERT INTO users (id, username, password_hash, role, password_set) VALUES ('u-pend', 'robin', ?, 'caregiver', 0)").run(placeholder);
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO user_invites (id, user_id, token_hash, placeholder_hash, created_by, created_at, expires_at)
     VALUES ('inv-1', 'u-pend', ?, ?, 'u-admin', ?, ?)`
  ).run(sha256(token), placeholder, utc(Date.now()), utc(Date.now() + 7 * DAY));
  return { token, placeholder };
}
const inviteUsedAt = (token) => db.prepare('SELECT used_at FROM user_invites WHERE token_hash = ?').get(sha256(token))?.used_at;
const check = (token) => api('POST', '/invite/check', { body: { token }, headers: { 'x-forwarded-for': nextIp() } });
const redeem = (token) => api('POST', '/invite/redeem', { body: { token, password: 'chosen-password-1' }, headers: { 'x-forwarded-for': nextIp() } });

describe('the invite of a disabled account', () => {
  test('★ #1233 /invite/check and /invite/redeem refuse a disabled account\'s link with the SAME 404, and the invite is kept', async () => {
    const p = plantPending();
    assert.equal((await setDisabled('u-pend', true)).status, 200, 'a pending account can be disabled too');
    const checked = await check(p.token);
    assert.equal(checked.status, 404, `the check showed a disabled account: ${JSON.stringify(checked.body)}`);
    assert.deepEqual(checked.body, INVALID_INVITE);
    const redeemed = await redeem(p.token);
    assert.equal(redeemed.status, 404, JSON.stringify(redeemed.body));
    assert.deepEqual(redeemed.body, INVALID_INVITE);
    assert.equal(inviteUsedAt(p.token), null, 'the refused redeem spent the invite');
    assert.equal(userRow('u-pend').password_hash, p.placeholder);
    // The Users list does not call it open, by the same rule.
    const listed = (await api('GET', '/users', { token: adminToken })).body.find((u) => u.id === 'u-pend');
    assert.equal(listed.invite_expires_at, null);
    // The control: enabled again, the kept invite works.
    assert.equal((await setDisabled('u-pend', false)).status, 200);
    assert.equal((await check(p.token)).status, 200);
  });

  test('★ #1233 an account disabled WHILE the link\'s password is hashing is not claimed (the whole claim rolls back)', async () => {
    const p = plantPending();
    const res = await duringTheHash(() => redeem(p.token), () => flagOff('u-pend'));
    assert.equal(res.status, 404, `a link set the password of an account disabled meanwhile: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body, INVALID_INVITE);
    const u = userRow('u-pend');
    assert.equal(u.password_hash, p.placeholder, 'the link wrote a password to a disabled account');
    assert.equal(u.password_set, 0);
    assert.equal(inviteUsedAt(p.token), null, 'the refused claim still marked the invite used');
    assert.deepEqual(sessionsOf('u-pend'), []);
  });
});

describe('what the answers carry', () => {
  test('★ #1233 GET /users says `disabled` for every account; /me and the sign-in answer do not grow the key', async () => {
    assert.equal((await setDisabled('u-carer', true)).status, 200);
    const list = await api('GET', '/users', { token: adminToken });
    assert.equal(list.status, 200);
    const by = Object.fromEntries(list.body.map((u) => [u.id, u]));
    assert.equal(by['u-carer'].disabled, true);
    assert.equal(by['u-admin'].disabled, false);
    const me = await api('GET', '/me', { token: adminToken });
    assert.deepEqual(Object.keys(me.body).sort(), [...PUBLIC_USER_KEYS].sort(), '/me changed shape');
    const signIn = await login('admin', ADMIN_PW);
    assert.deepEqual(Object.keys(signIn.body.user).sort(), [...PUBLIC_USER_KEYS].sort(), 'the sign-in user changed shape');
  });

  test('★ #1233 hostile: a marker in every users column outside the public fields never comes back from the route or the list', async () => {
    // Derived from the schema, so a column added later is planted too. Only the target's row is planted; the admin
    // making the calls is a normal account.
    const planted = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
      .filter((n) => !PUBLIC_USER_KEYS.includes(n) && n !== 'disabled');
    assert.ok(planted.includes('password_hash') && planted.includes('mfa_secret'), `the schema read found too little: ${planted}`);
    for (const name of planted) {
      db.prepare(`UPDATE users SET ${name} = ? WHERE id = 'u-carer'`).run(`leak-${name}-marker`);
    }
    const answer = await setDisabled('u-carer', true);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.deepEqual(Object.keys(answer.body).sort(), [...PUBLIC_USER_KEYS, 'disabled'].sort());
    const list = await api('GET', '/users', { token: adminToken });
    for (const [where, body] of [['PUT /users/:id/disabled', answer.body], ['GET /users', list.body]]) {
      const text = JSON.stringify(body);
      for (const name of planted) assert.ok(!text.includes(`leak-${name}-marker`), `${where} returned users.${name}`);
    }
  });
});

describe('the schema', () => {
  test('★ #1233 an older database gains disabled = 0 on every account it had, and a restart changes nothing', () => {
    // A separate process per boot (db.js migrates at import, once per process), against one database file: boot 1
    // builds today's schema and takes the column away again, with accounts in it; boot 2 is the upgrade.
    const dbJs = pathToFileURL(path.join(HERE, '..', 'src', 'db.js')).href;
    const boot = (dir, script) => execFileSync(
      process.execPath,
      ['-e', `process.env.DATA_DIR = ${JSON.stringify(dir)};\nconst { default: db } = await import(${JSON.stringify(dbJs)});\n${script}`],
      { encoding: 'utf8' }
    ).trim();
    const columns = "console.log(JSON.stringify(db.prepare('PRAGMA table_info(users)').all().map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value }))));";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-test-disable-mig-'));
    try {
      const oldCols = JSON.parse(boot(dir, `
        db.exec('ALTER TABLE users DROP COLUMN disabled');
        db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'a', 'h1', 'admin'), ('u2', 'b', 'h2', 'caregiver')").run();
        ${columns}`));
      assert.ok(!oldCols.some((c) => c.name === 'disabled'), 'the fixture is not an older database');
      const upgraded = JSON.parse(boot(dir, columns));
      assert.deepEqual(upgraded.filter((c) => c.name !== 'disabled'), oldCols, 'the upgrade changed another users column');
      assert.deepEqual(upgraded.find((c) => c.name === 'disabled'), { name: 'disabled', type: 'INTEGER', notnull: 1, dflt: '0' });
      const rows = JSON.parse(boot(dir, "console.log(JSON.stringify(db.prepare('SELECT id, disabled FROM users ORDER BY id').all()));"));
      assert.deepEqual(rows, [{ id: 'u1', disabled: 0 }, { id: 'u2', disabled: 0 }], 'an existing account was disabled by the upgrade');
      boot(dir, "db.prepare(\"UPDATE users SET disabled = 1 WHERE id = 'u2'\").run();");
      assert.deepEqual(JSON.parse(boot(dir, columns)), upgraded, 'a further boot changed the users schema');
      assert.equal(JSON.parse(boot(dir, "console.log(JSON.stringify(db.prepare(\"SELECT disabled AS d FROM users WHERE id = 'u2'\").get().d));")), 1,
        're-running the migration re-enabled a disabled account');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
