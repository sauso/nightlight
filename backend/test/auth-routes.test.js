// routes/auth.js — login, MFA, session issuance, password change. Issue #263.
//
// THE DEFECT THIS FILE EXISTS FOR. An adversarial audit mutation-tested the backend at ~99% line
// coverage on core logic and found **8 auth mutants surviving**, because this file — login, the second
// factor, and every session the app ever issues — had NO TEST FILE AT ALL. Two of the survivors:
//
//   * login skipping the bcrypt check entirely, issuing a valid 30-day token for ANY password
//   * MFA accepting any code, removing the second factor
//
// Both passed a green 389-test suite. Coverage measures execution; mutation testing measures
// discrimination, and nothing here was being discriminated because nothing here was being executed.
//
// ⚠️ WRITTEN MUTATION-FIRST, NOT COVERAGE-FIRST. Every case below exists because a specific mutant
// survived without it — the mutants are listed against each describe. A test written to "cover a
// route" tends to assert the happy path, which is exactly what let `if (!bcrypt.compareSync(...))`
// survive being deleted.
//
// ⚠️ AND THE FIXTURE IS HOSTILE. The repo's recurring trap (four confirmed instances, see #263) is a
// test whose NAME states an invariant while its fixture guarantees the invariant cannot be violated.
// So: real bcrypt hashes rather than stubs, a real TOTP secret, and the no-leak scan derives its
// field list from `PRAGMA table_info` rather than a list anyone typed.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { useTempDataDir, cleanupTempDataDirs, mountRouter, call, makeSession, signToken } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter } = await import('../src/routes/auth.js');
const { generateSecret, keyUri } = await import('../src/lib/mfa.js');
// The app verifies with otplib v13's verifySync; generate with the SAME library so the fixture cannot
// drift from the implementation it is testing.
const { generateSync } = await import('otplib');
const totp = (secret) => generateSync({ secret });

let server;
const PASSWORD = 'correct-horse-battery';
// A marker planted in every free-text column that could carry a secret out. If any of these strings
// appears in a response, something is leaking that column verbatim.
const MARKER = 'leak-marker-4f2a';

before(async () => { server = await mountRouter('/api/auth', authRouter); });
after(async () => { await server?.close(); db.close(); cleanupTempDataDirs(); });

let mfaSecret;

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  mfaSecret = generateSecret();
  // Real hashes. A stubbed compare would let the "skip the bcrypt check" mutant live.
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, first_name, last_name, mfa_enabled, mfa_secret)
     VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`
    // ⚠️ The marker goes in SECRET columns only, never in first_name/last_name. An earlier draft
    // planted it there too and the leak test failed — correctly: those are the user's name and are
    // meant to come back. A marker in a field that is supposed to be returned tests nothing except
    // whether the author knew which fields were secret.
  ).run('u-admin', 'alice', bcrypt.hashSync(PASSWORD, 4), 'admin', 'Alice', 'Anderson');
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role, first_name, last_name, mfa_enabled, mfa_secret)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
  ).run('u-mfa', 'bob', bcrypt.hashSync(PASSWORD, 4), 'caregiver', null, null, mfaSecret);
});

const post = (path, body, token) =>
  call(`${server.url}/api/auth${path}`, { method: 'POST', body, token });
const put = (path, body, token) =>
  call(`${server.url}/api/auth${path}`, { method: 'PUT', body, token });

const sessionsFor = (id) => db.prepare('SELECT * FROM sessions WHERE user_id = ?').all(id);

describe('POST /login — the password is actually checked', () => {
  // MUTANTS THIS KILLS: deleting the `!bcrypt.compareSync(...)` test; inverting it; returning a token
  // before the check; dropping `|| !user` so an unknown username with any password succeeds.

  test('★ a WRONG password is refused, and no session is created', async () => {
    const res = await post('/login', { username: 'alice', password: 'not-the-password' });
    assert.equal(res.status, 401, 'a wrong password was accepted — the bcrypt check is not running');
    assert.equal(res.body.token, undefined, 'a token was issued for a wrong password');
    assert.equal(sessionsFor('u-admin').length, 0, 'a session row was created for a failed login');
  });

  test('the RIGHT password is accepted — the control', async () => {
    // Without this, the case above passes for an implementation that refuses everything.
    const res = await post('/login', { username: 'alice', password: PASSWORD });
    assert.equal(res.status, 200, `a correct password was refused: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.token, 'no token issued for a correct password');
    assert.equal(sessionsFor('u-admin').length, 1, 'a successful login created no session');
  });

  test('an unknown username is refused even with a password that matches someone else', async () => {
    const res = await post('/login', { username: 'nobody-here', password: PASSWORD });
    assert.equal(res.status, 401);
    assert.equal(res.body.token, undefined);
  });

  test('★ an unknown username is refused even against the TIMING-EQUALISER password', async () => {
    // ⚠️ THE DISCRIMINATING INPUT, and the case above does not supply it. To equalise response timing
    // between "no such user" and "wrong password", the route compares against a DUMMY_HASH when the
    // username is unknown — and the string that hash is made from is a literal in the source. So the
    // `|| !user` half of the guard is the only thing standing between that public constant and a
    // successful login. Dropping it survived every other test here; only this input kills it.
    const res = await post('/login', { username: 'nobody-here', password: 'timing-equalizer' });
    assert.equal(res.status, 401, 'the dummy-hash password logged in as a user that does not exist');
    assert.equal(res.body.token, undefined);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0, 'a session was created for a non-existent user');
  });

  test('a non-string username cannot bypass the lookup', async () => {
    // The route guards with `typeof username === 'string'`; without it a crafted object could reach
    // the query. Objects, arrays and null must all be refused rather than throwing a 500.
    for (const username of [{ toString: () => 'alice' }, ['alice'], null, 42, undefined]) {
      const res = await post('/login', { username, password: PASSWORD });
      assert.equal(res.status, 401, `${JSON.stringify(username)} was not refused with 401`);
    }
  });

  test('the issued token names a REAL session row, and identifies the user', async () => {
    const res = await post('/login', { username: 'alice', password: PASSWORD });
    const payload = jwt.decode(res.body.token);
    assert.equal(payload.id, 'u-admin');
    assert.ok(payload.sid, 'the token carries no session id — "sign out this device" could not work');
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(payload.sid);
    assert.ok(row, 'the token names a session that does not exist');
    assert.equal(row.user_id, 'u-admin');
    // Not a media capability: a login token must be usable on the API.
    assert.notEqual(payload.purpose, 'media');
  });
});

describe('POST /login — an MFA account does NOT get a session from the password alone', () => {
  // MUTANT THIS KILLS: dropping the `if (user.mfa_enabled)` branch, so the first factor alone issues
  // a full session and the second factor is silently skipped for everyone who enabled it.

  test('★ it returns mfaRequired and NO session token', async () => {
    const res = await post('/login', { username: 'bob', password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.mfaRequired, true, 'an MFA account logged straight in on the password alone');
    assert.equal(res.body.token, undefined, 'a session token was issued before the second factor');
    assert.equal(sessionsFor('u-mfa').length, 0, 'a session existed before the second factor was given');
  });

  test('the interim token is scoped to MFA and cannot be used as a session', async () => {
    const { body } = await post('/login', { username: 'bob', password: PASSWORD });
    const payload = jwt.decode(body.mfaToken);
    assert.equal(payload.purpose, 'mfa', 'the interim token is not purpose-scoped');
    assert.equal(payload.sid, undefined, 'the interim token names a session — it would authenticate the API');
  });
});

describe('POST /login/mfa — the code is actually verified', () => {
  // MUTANTS THIS KILLS: accepting any code; skipping the `purpose !== 'mfa'` check; accepting a token
  // for a user who has since turned MFA off; not consuming a backup code.
  const startMfa = async () => (await post('/login', { username: 'bob', password: PASSWORD })).body.mfaToken;

  test('★ a WRONG code is refused, and no session is created', async () => {
    const mfaToken = await startMfa();
    const res = await post('/login/mfa', { mfaToken, code: '000000' });
    assert.equal(res.status, 401, 'any code was accepted — the second factor is not being checked');
    assert.equal(sessionsFor('u-mfa').length, 0);
  });

  test('the RIGHT code is accepted — the control', async () => {
    const mfaToken = await startMfa();
    const code = totp(mfaSecret);
    const res = await post('/login/mfa', { mfaToken, code });
    assert.equal(res.status, 200, `a valid TOTP code was refused: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.token, 'no session token after a correct second factor');
    assert.equal(sessionsFor('u-mfa').length, 1);
  });

  test('a token that is not MFA-scoped is refused', async () => {
    // A full session token must not be exchangeable for another session at this endpoint.
    const login = await post('/login', { username: 'alice', password: PASSWORD });
    const res = await post('/login/mfa', { mfaToken: login.body.token, code: totp(mfaSecret) });
    assert.equal(res.status, 401, 'a session token was accepted as an MFA token');
  });

  test('★ …including a session token belonging to an MFA user, which is the discriminating case', async () => {
    // ⚠️ The case above passes even with the purpose check DELETED, because alice has MFA off, so the
    // route's later `!user.mfa_enabled` test refuses her anyway — it passes for the wrong reason.
    // Killing the mutant needs a session token whose owner DOES have MFA on: then the only thing
    // standing between it and a freshly minted second session is the purpose check itself.
    const start = await post('/login', { username: 'bob', password: PASSWORD });
    const sessionToken = (await post('/login/mfa', { mfaToken: start.body.mfaToken, code: totp(mfaSecret) })).body.token;
    assert.ok(sessionToken, 'precondition: bob is fully logged in');
    const before = sessionsFor('u-mfa').length;

    const res = await post('/login/mfa', { mfaToken: sessionToken, code: totp(mfaSecret) });
    assert.equal(res.status, 401, "an MFA user's own session token was exchanged for another session");
    assert.equal(sessionsFor('u-mfa').length, before, 'a second session was minted from a session token');
  });

  test('a forged MFA token is refused', async () => {
    const forged = jwt.sign({ id: 'u-mfa', purpose: 'mfa' }, 'not-the-real-secret', { algorithm: 'HS256' });
    const res = await post('/login/mfa', { mfaToken: forged, code: totp(mfaSecret) });
    assert.equal(res.status, 401);
  });

  test('garbage in place of a token does not 500', async () => {
    for (const mfaToken of ['', 'not-a-jwt', null, 42]) {
      const res = await post('/login/mfa', { mfaToken, code: '123456' });
      assert.equal(res.status, 401, `${JSON.stringify(mfaToken)} produced ${res.status}`);
    }
  });
});

describe('PUT /me/password — the CURRENT password is required', () => {
  // MUTANTS THIS KILLS: deleting the current-password check (anyone holding a token could change the
  // password); not re-hashing; not revoking other sessions.
  const login = async () => (await post('/login', { username: 'alice', password: PASSWORD })).body.token;

  test('★ a wrong current password is refused, and the stored hash is unchanged', async () => {
    const token = await login();
    const before = db.prepare('SELECT password_hash FROM users WHERE id = ?').get('u-admin').password_hash;
    const res = await put('/me/password', { current_password: 'wrong', new_password: 'a-new-long-password' }, token);
    assert.equal(res.status, 401, 'the current password was not verified');
    const after = db.prepare('SELECT password_hash FROM users WHERE id = ?').get('u-admin').password_hash;
    assert.equal(after, before, 'the password was changed despite the wrong current password');
  });

  test('the right current password changes it, and the NEW one then works — the control', async () => {
    const token = await login();
    const res = await put('/me/password', { current_password: PASSWORD, new_password: 'a-new-long-password' }, token);
    assert.equal(res.status, 200, `a correct change was refused: ${JSON.stringify(res.body)}`);
    // Asserted by logging in, not by reading the hash: that proves the stored value is a usable hash
    // of the new password rather than merely different.
    const relogin = await post('/login', { username: 'alice', password: 'a-new-long-password' });
    assert.equal(relogin.status, 200, 'the new password does not work — the hash was not written correctly');
    const old = await post('/login', { username: 'alice', password: PASSWORD });
    assert.equal(old.status, 401, 'the OLD password still works after a change');
  });

  test('★ every OTHER session is revoked, and the current one survives', async () => {
    // The reason the route does this: changing a password is what someone does when a logged-in
    // device is lost. Leaving those sessions valid for the rest of their 30 days defeats the point.
    const keep = await login();
    await post('/login', { username: 'alice', password: PASSWORD }); // a second device
    assert.equal(sessionsFor('u-admin').length, 2, 'precondition: two sessions');

    await put('/me/password', { current_password: PASSWORD, new_password: 'a-new-long-password' }, keep);

    const left = sessionsFor('u-admin');
    assert.equal(left.length, 1, 'other devices were not signed out by the password change');
    assert.equal(left[0].id, jwt.decode(keep).sid, 'the wrong session survived — the current device was signed out');
  });

  test('a too-short new password is refused before anything is written', async () => {
    const token = await login();
    const res = await put('/me/password', { current_password: PASSWORD, new_password: 'short' }, token);
    assert.equal(res.status, 400);
    assert.equal((await post('/login', { username: 'alice', password: PASSWORD })).status, 200, 'the old password stopped working');
  });
});

describe('POST /me/mfa/disable — the password is required', () => {
  // MUTANT THIS KILLS: dropping the password check, so anyone holding a token can strip the second
  // factor off the account it belongs to.
  test('★ a wrong password leaves MFA enabled', async () => {
    const { body } = await post('/login', { username: 'bob', password: PASSWORD });
    const token = (await post('/login/mfa', { mfaToken: body.mfaToken, code: totp(mfaSecret) })).body.token;
    const res = await post('/me/mfa/disable', { password: 'wrong' }, token);
    assert.equal(res.status, 401, 'MFA was disabled without the password');
    assert.equal(db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get('u-mfa').mfa_enabled, 1);
  });

  test('the right password disables it and clears the secret — the control', async () => {
    const { body } = await post('/login', { username: 'bob', password: PASSWORD });
    const token = (await post('/login/mfa', { mfaToken: body.mfaToken, code: totp(mfaSecret) })).body.token;
    const res = await post('/me/mfa/disable', { password: PASSWORD }, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = db.prepare('SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE id = ?').get('u-mfa');
    assert.equal(row.mfa_enabled, 0);
    assert.equal(row.mfa_secret, null, 'the TOTP secret was left in the row after disabling');
    assert.equal(row.mfa_backup_codes, null);
  });
});

describe('POST /setup — only before there is an account', () => {
  test('★ it is refused once any user exists', async () => {
    const res = await post('/setup', { username: 'intruder', password: 'a-long-enough-password' });
    assert.equal(res.status, 400, 'setup ran again on an installed system — anyone could mint an admin');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE username = ?').get('intruder').c, 0);
  });

  test('on an empty install it creates an ADMIN and a real session — the control', async () => {
    db.prepare('DELETE FROM users').run();
    const res = await post('/setup', { username: 'first', password: 'a-long-enough-password' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get('first');
    assert.equal(row.role, 'admin', 'the first account is not an admin — nobody could administer the app');
    assert.notEqual(row.password_hash, 'a-long-enough-password', 'the password was stored in plain text');
    assert.ok(bcrypt.compareSync('a-long-enough-password', row.password_hash), 'the stored hash does not verify');
    assert.ok(db.prepare('SELECT * FROM sessions WHERE id = ?').get(jwt.decode(res.body.token).sid));
  });

  test('a short password is refused', async () => {
    db.prepare('DELETE FROM users').run();
    const res = await post('/setup', { username: 'first', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 0);
  });
});

describe('★★ no response ever carries a secret column', () => {
  // ⚠️ THE FIELD LIST COMES FROM THE SCHEMA, NOT FROM A LIST I TYPED. This repo's standing rule: a
  // hand-written list cannot catch a column added later, and asserting that it can is itself an
  // unverified claim. The same PRAGMA tripwire caught a real unclassified column in
  // cameras-assign-exposure.test.js on its first run.
  const SECRET_COLUMNS = ['password_hash', 'mfa_secret', 'mfa_backup_codes'];

  test('the schema has no secret-looking column this test does not know about', () => {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    const suspicious = cols.filter((c) => /pass|secret|token|hash|code|key/i.test(c));
    assert.deepEqual(
      suspicious.sort(),
      [...SECRET_COLUMNS].sort(),
      'a secret-looking column was added to `users` and is not covered below — classify it, then extend SECRET_COLUMNS'
    );
  });

  test('★ login, /setup and /me never return one', async () => {
    // Planted values in EVERY secret column, so a leak is unmistakable rather than a judgement call.
    // alice's mfa_secret can hold the marker because she has MFA off — no test verifies a code
    // against it, so it is free to be a tripwire rather than a working secret.
    db.prepare('UPDATE users SET mfa_secret = ?, mfa_backup_codes = ? WHERE id = ?').run(MARKER, MARKER, 'u-admin');
    db.prepare('UPDATE users SET mfa_backup_codes = ? WHERE id = ?').run(MARKER, 'u-mfa');
    const login = await post('/login', { username: 'alice', password: PASSWORD });
    const me = await call(`${server.url}/api/auth/me`, { token: login.body.token });
    const mfaStart = await post('/login', { username: 'bob', password: PASSWORD });

    for (const [name, res] of [['login', login], ['/me', me], ['mfa-start', mfaStart]]) {
      const json = JSON.stringify(res.body);
      for (const col of SECRET_COLUMNS) {
        assert.ok(!json.includes(col), `${name} response names the ${col} column: ${json}`);
      }
      assert.ok(!json.includes(MARKER), `${name} leaked a planted secret value: ${json}`);
      // The hash itself, by shape — bcrypt hashes start $2a$/$2b$.
      assert.doesNotMatch(json, /\$2[aby]\$/, `${name} returned a bcrypt hash`);
    }
  });
});

// -------------------------------------------------------------------------------------------
// The rest of the surface: sessions, user management, media tokens, MFA enrolment. Added so
// routes/auth.js can go into the `test:core` coverage include list — issue #263's root cause 1 is that
// whole modules were absent from that list, "so their absence is invisible in the coverage number."
const makeCaregiver = () =>
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)')
    .run('u-care', 'carol', bcrypt.hashSync(PASSWORD, 4), 'caregiver');

// ⚠️ MINTS A SESSION DIRECTLY rather than calling /login. These cases are not testing login, and
// logging in repeatedly exhausts the per-account rate limiter added for #248 — every case after the
// twentieth got a 401 that had nothing to do with what it was asserting. Using the same signToken
// the middleware verifies keeps them honest without paying that budget.
const loginAs = async (u) => {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(u);
  const sid = makeSession(db, row.id);
  return signToken({ id: row.id, username: row.username, role: row.role, sid });
};

describe('sessions — you see and revoke your own; an admin sees everyone', () => {
  test('GET /sessions returns only your own, and marks the current one', async () => {
    const token = await loginAs('alice');
    await post('/login', { username: 'alice', password: PASSWORD }); // a second device
    const res = await call(`${server.url}/api/auth/sessions`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.equal(res.body.filter((s) => s.is_current).length, 1, 'exactly one session must be marked current');
    assert.equal(res.body.find((s) => s.is_current).id, jwt.decode(token).sid);
  });

  test('★ a caregiver cannot list every account’s sessions', async () => {
    makeCaregiver();
    const res = await call(`${server.url}/api/auth/sessions/all`, { token: await loginAs('carol') });
    assert.equal(res.status, 403, 'a caregiver read every account’s sessions');
  });

  test('an admin can, and it names the account each belongs to', async () => {
    const res = await call(`${server.url}/api/auth/sessions/all`, { token: await loginAs('alice') });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((s) => s.username === 'alice'));
  });

  test('★ a caregiver cannot revoke somebody else’s session', async () => {
    makeCaregiver();
    const victim = await loginAs('alice');
    const attacker = await loginAs('carol');
    const sid = jwt.decode(victim).sid;
    const res = await call(`${server.url}/api/auth/sessions/${sid}`, { method: 'DELETE', token: attacker });
    assert.equal(res.status, 403, 'a caregiver signed another user out');
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid), 'the session was deleted anyway');
  });

  test('but can revoke their OWN — the control', async () => {
    makeCaregiver();
    const token = await loginAs('carol');
    const sid = jwt.decode(token).sid;
    assert.equal((await call(`${server.url}/api/auth/sessions/${sid}`, { method: 'DELETE', token })).status, 204);
    assert.equal(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sid), undefined);
  });

  test('logout ends the current session immediately', async () => {
    const token = await loginAs('alice');
    assert.equal((await post('/logout', {}, token)).status, 204);
    assert.equal((await call(`${server.url}/api/auth/me`, { token })).status, 401, 'the token still worked after logout');
  });
});

describe('user management is admin-only', () => {
  test('★ a caregiver cannot list, create, edit or delete accounts', async () => {
    makeCaregiver();
    const token = await loginAs('carol');
    const attempts = [
      ['GET', '/users', undefined],
      ['POST', '/users', { username: 'x', password: 'a-long-enough-pw' }],
      ['PUT', '/users/u-admin', { username: 'x' }],
      ['DELETE', '/users/u-admin', undefined],
      ['DELETE', '/users/u-mfa/mfa', undefined],
    ];
    for (const [method, p, body] of attempts) {
      const res = await call(`${server.url}/api/auth${p}`, { method, body, token });
      assert.equal(res.status, 403, `${method} ${p} was allowed for a caregiver (got ${res.status})`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 3, 'the account list changed');
  });

  test('an admin can create one, and the password is hashed — the control', async () => {
    const token = await loginAs('alice');
    const res = await post('/users', { username: 'dave', password: 'a-long-enough-pw', role: 'caregiver' }, token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get('dave');
    assert.notEqual(row.password_hash, 'a-long-enough-pw', 'the password was stored in plain text');
    assert.ok(bcrypt.compareSync('a-long-enough-pw', row.password_hash));
    assert.doesNotMatch(JSON.stringify(res.body), /\$2[aby]\$/, 'the response returned a bcrypt hash');
  });

  test('an unknown role cannot be smuggled in — anything but "admin" is a caregiver', async () => {
    const token = await loginAs('alice');
    await post('/users', { username: 'eve', password: 'a-long-enough-pw', role: 'superuser' }, token);
    assert.equal(db.prepare('SELECT role FROM users WHERE username = ?').get('eve').role, 'caregiver');
  });

  test('a duplicate username is refused', async () => {
    const token = await loginAs('alice');
    const res = await post('/users', { username: 'alice', password: 'a-long-enough-pw' }, token);
    assert.equal(res.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE username = ?').get('alice').c, 1);
  });
});

describe('media tokens are scoped, not full sessions', () => {
  test('★ the issued media token carries purpose=media and the same session', async () => {
    // The whole point: a leaked HLS URL must be a video capability, never account access. The
    // middleware enforces that; this pins the token THIS route mints.
    const token = await loginAs('alice');
    const res = await post('/media-token', {}, token);
    assert.equal(res.status, 200);
    const payload = jwt.decode(res.body.token);
    assert.equal(payload.purpose, 'media', 'not purpose-scoped — a leaked URL would be account access');
    assert.equal(payload.sid, jwt.decode(token).sid, 'the media token outlives revoking the session it came from');
    assert.ok(res.body.expires_in > 0 && res.body.expires_in <= 24 * 3600, `implausible TTL: ${res.body.expires_in}`);
  });
});

describe('MFA enrolment', () => {
  test('GET /me/mfa reports state without ever returning the secret', async () => {
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(MARKER, 'u-admin');
    const res = await call(`${server.url}/api/auth/me/mfa`, { token: await loginAs('alice') });
    assert.equal(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes(MARKER), `the TOTP secret leaked: ${JSON.stringify(res.body)}`);
  });

  test('★ enable requires a code that verifies against the pending secret', async () => {
    const token = await loginAs('alice');
    const setup = await post('/me/mfa/setup', {}, token);
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    const wrong = await post('/me/mfa/enable', { code: '000000' }, token);
    assert.notEqual(wrong.status, 200, 'MFA was enabled with a wrong code');
    assert.equal(db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get('u-admin').mfa_enabled, 0);
  });
});

// -------------------------------------------------------------------------------------------
// Gaps found by adversarial review of this PR. Each existed because the file tested a route's
// REFUSAL path (403 for a caregiver) and never its success path — so every rule applied *inside* the
// route was unreachable by any test, and mutating it away left the suite green.
describe('gaps found by review — the success paths nobody reached', () => {
  const admin = async () => loginAs('alice');

  test('★ a backup code is single-use', async () => {
    // F2: no test ever completed /login/mfa with an actual backup code, so a mutant that VERIFIES the
    // code correctly but never persists the consumed list — making it infinitely replayable — left
    // the suite green. That is the whole point of a one-time code.
    const token = await loginAs('alice');
    await post('/me/mfa/setup', {}, token);
    const secret = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get('u-admin').mfa_secret;
    const enable = await post('/me/mfa/enable', { code: totp(secret) }, token);
    assert.equal(enable.status, 200, JSON.stringify(enable.body));
    const [backup] = enable.body.backup_codes;
    assert.ok(backup, 'enabling MFA returned no backup codes');

    const first = await post('/login', { username: 'alice', password: PASSWORD });
    const used = await post('/login/mfa', { mfaToken: first.body.mfaToken, code: backup });
    assert.equal(used.status, 200, `a fresh backup code was refused: ${JSON.stringify(used.body)}`);

    // The same code again must NOT work.
    const second = await post('/login', { username: 'alice', password: PASSWORD });
    const replay = await post('/login/mfa', { mfaToken: second.body.mfaToken, code: backup });
    assert.equal(replay.status, 401, 'a backup code was accepted twice — it is not being consumed');
  });

  test('POST /me/mfa/enable succeeds with a correct code, and hands back backup codes', async () => {
    // F6: the only "enable" case asserted the wrong-code rejection, so everything after the guard —
    // including generating and storing the backup codes — was untested.
    const token = await loginAs('alice');
    await post('/me/mfa/setup', {}, token);
    const secret = db.prepare('SELECT mfa_secret FROM users WHERE id = ?').get('u-admin').mfa_secret;
    const res = await post('/me/mfa/enable', { code: totp(secret) }, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.backup_codes) && res.body.backup_codes.length > 0, 'no backup codes issued');
    const row = db.prepare('SELECT mfa_enabled, mfa_backup_codes FROM users WHERE id = ?').get('u-admin');
    assert.equal(row.mfa_enabled, 1);
    // Stored HASHED, never in the clear — the same standard as the password.
    assert.ok(row.mfa_backup_codes, 'no backup codes stored');
    for (const code of res.body.backup_codes) {
      assert.ok(!row.mfa_backup_codes.includes(code), `backup code ${code} is stored in plain text`);
    }
  });

  test('★ PUT /users/:id sanitises the role, exactly as POST does', async () => {
    // F3: POST /users has a test for this; PUT did not, and dropping its sanitisation left the suite
    // green. An arbitrary role string stored verbatim is a privilege question, not a typo question.
    const token = await admin();
    const res = await put('/users/u-mfa', { role: 'superuser' }, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('u-mfa').role, 'caregiver');
  });

  test('PUT /users/:id can promote and demote, and 404s for a stranger', async () => {
    const token = await admin();
    assert.equal((await put('/users/u-mfa', { role: 'admin' }, token)).status, 200);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('u-mfa').role, 'admin');
    assert.equal((await put('/users/u-mfa', { role: 'caregiver' }, token)).status, 200);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('u-mfa').role, 'caregiver');
    assert.equal((await put('/users/nobody', { role: 'admin' }, token)).status, 404);
  });

  test('PUT /users/:id refuses an empty username, a duplicate, and a short password', async () => {
    const token = await admin();
    assert.equal((await put('/users/u-mfa', { username: '   ' }, token)).status, 400);
    assert.equal((await put('/users/u-mfa', { username: 'alice' }, token)).status, 400, 'a taken username was allowed');
    assert.equal((await put('/users/u-mfa', { password: 'short' }, token)).status, 400);
    // None of those may have changed anything.
    const row = db.prepare('SELECT username FROM users WHERE id = ?').get('u-mfa');
    assert.equal(row.username, 'bob');
  });

  test('★ an admin cannot delete their OWN account', async () => {
    // F4: only the caregiver-403 path was tested, so deleting this guard entirely left the suite
    // green — and an admin removing themselves is how an install ends up with no administrator.
    const token = await admin();
    const res = await call(`${server.url}/api/auth/users/u-admin`, { method: 'DELETE', token });
    assert.equal(res.status, 400, 'an admin deleted their own account');
    assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get('u-admin'), 'the account was removed anyway');
  });

  test('but can delete somebody else — the control', async () => {
    const token = await admin();
    const res = await call(`${server.url}/api/auth/users/u-mfa`, { method: 'DELETE', token });
    assert.equal(res.status, 204);
    assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get('u-mfa'), undefined);
    // The FK cascade must take their sessions with them, or a deleted account keeps working.
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get('u-mfa').c, 0);
  });

  test('an admin can clear a locked-out user’s MFA', async () => {
    const token = await admin();
    const res = await call(`${server.url}/api/auth/users/u-mfa/mfa`, { method: 'DELETE', token });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE id = ?').get('u-mfa');
    assert.equal(row.mfa_enabled, 0);
    assert.equal(row.mfa_secret, null, 'the TOTP secret survived an admin reset');
    assert.equal(row.mfa_backup_codes, null);
  });

  test('PUT /me edits your own name without touching anyone else', async () => {
    // F5: this route had no test at all.
    const token = await loginAs('alice');
    const res = await put('/me', { first_name: '  Alicia  ', last_name: '' }, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get('u-admin');
    assert.equal(row.first_name, 'Alicia', 'the name was not trimmed');
    assert.equal(row.last_name, null, 'an empty string should clear the field, not store ""');
    assert.equal(db.prepare('SELECT first_name FROM users WHERE id = ?').get('u-mfa').first_name, null, 'it edited another account');
  });

  test('PUT /me cannot be used to change your own role', async () => {
    // The route only reads first_name/last_name/photo from the body — assert that, because a future
    // edit that spreads req.body into the UPDATE would be a silent privilege escalation.
    db.prepare("UPDATE users SET role = 'caregiver' WHERE id = ?").run('u-mfa');
    const sid = makeSession(db, 'u-mfa');
    const token = signToken({ id: 'u-mfa', username: 'bob', role: 'caregiver', sid });
    await put('/me', { first_name: 'Bob', role: 'admin' }, token);
    assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get('u-mfa').role, 'caregiver', 'PUT /me changed the caller’s role');
  });
});

// -------------------------------------------------------------------------------------------
// Missing/blank bodies and optional fields. These are the `req.body || {}` and `x?.trim() || null`
// branches — individually dull, collectively most of this file's branch coverage, and the shape a
// real client sends when a form field is simply left empty.
describe('missing and blank fields are handled, not assumed', () => {
  test('every route survives a completely absent body', async () => {
    // A request with no JSON body at all must produce a 4xx, never a 500 from reading a property of
    // undefined. Asserted across the unauthenticated routes, which are the ones an outsider can reach.
    for (const p of ['/login', '/login/mfa', '/setup']) {
      const res = await call(`${server.url}/api/auth${p}`, { method: 'POST' });
      assert.ok(res.status >= 400 && res.status < 500, `${p} returned ${res.status} for an empty body`);
    }
  });

  test('optional name fields may be omitted entirely when creating a user', async () => {
    const token = await loginAs('alice');
    const res = await post('/users', { username: 'frank', password: 'a-long-enough-pw' }, token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = db.prepare('SELECT first_name, last_name FROM users WHERE username = ?').get('frank');
    assert.equal(row.first_name, null);
    assert.equal(row.last_name, null);
  });

  test('blank names are stored as NULL, not as empty strings', async () => {
    // `?.trim() || null` — the difference matters because the UI renders a blank string as a name.
    const token = await loginAs('alice');
    await post('/users', { username: 'gina', password: 'a-long-enough-pw', first_name: '   ', last_name: '' }, token);
    const row = db.prepare('SELECT first_name, last_name FROM users WHERE username = ?').get('gina');
    assert.equal(row.first_name, null);
    assert.equal(row.last_name, null);
  });

  test('PUT /users/:id leaves a field alone when it is not sent', async () => {
    const token = await loginAs('alice');
    await put('/users/u-mfa', { first_name: 'Bobby' }, token);
    await put('/users/u-mfa', { role: 'caregiver' }, token); // no name in this one
    assert.equal(db.prepare('SELECT first_name FROM users WHERE id = ?').get('u-mfa').first_name, 'Bobby',
      'an unrelated update cleared a field it did not mention');
  });

  test('PUT /users/:id with a password resets it and signs that user out elsewhere', async () => {
    const token = await loginAs('alice');
    makeSession(db, 'u-mfa'); // bob is logged in on a device
    assert.ok(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get('u-mfa').c > 0);
    const res = await put('/users/u-mfa', { password: 'a-brand-new-password' }, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get('u-mfa');
    assert.ok(bcrypt.compareSync('a-brand-new-password', row.password_hash), 'the new password does not verify');
    assert.equal(
      db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get('u-mfa').c,
      0,
      'an admin password reset left the user signed in — the old credential outlived itself'
    );
  });

  test('GET /users lists accounts without any secret column', async () => {
    const res = await call(`${server.url}/api/auth/users`, { token: await loginAs('alice') });
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 2);
    assert.doesNotMatch(JSON.stringify(res.body), /\$2[aby]\$/, 'the user list returned a bcrypt hash');
  });

  test('GET /status reports whether setup has happened', async () => {
    const res = await call(`${server.url}/api/auth/status`);
    assert.equal(res.status, 200);
    assert.equal(res.body.needsSetup, false, 'users exist, so setup must not be offered');
  });
});
