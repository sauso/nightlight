// #548 (async bcrypt on request paths) and #550 (TOTP replay, per-user MFA limit).
//
// Every case here was written to FAIL on the code before this change; the comment on each says how that
// was shown. Nothing is mocked: real database, real HTTP, real otplib, real bcryptjs.
//
// ⚠️ The limiters are module-level with in-memory stores, so cases that exhaust a budget claim their own
// user (and source address) rather than sharing alice/bob.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, mountRouterTrustingProxy, signToken, call,
} from './helpers/harness.js';

useTempDataDir();
const require = createRequire(import.meta.url);
const otplib = require('otplib');
const bcrypt = require('bcryptjs');

const { default: db } = await import('../src/db.js');
const { default: authRouter, resetMfaUserLimit } = await import('../src/routes/auth.js');
const { generateSecret, matchTokenStep, generateBackupCodes } = await import('../src/lib/mfa.js');
const passwordHash = await import('../src/lib/passwordHash.js');

let server;
before(async () => { server = await mountRouterTrustingProxy('/api/auth', authRouter); });
after(async () => { await server?.close(); db.close(); cleanupTempDataDirs(); });

let ipCounter = 0;
// A fresh source address per call site, so the per-IP limiters never confound what a case asserts.
const freshIp = () => `198.51.100.${(ipCounter += 1)}`;

const post = (path, body, { ip = freshIp(), token } = {}) =>
  call(`${server.url}/api/auth${path}`, { method: 'POST', body, token, headers: { 'x-forwarded-for': ip } });

const mfaToken = (id) => signToken({ id, purpose: 'mfa' }, { expiresIn: '5m' });
const codeAtOffset = (secret, offsetSec = 0) =>
  otplib.generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSec });
// A code that is wrong for this secret in every accepted step.
function wrongCode(secret) {
  for (let n = 0; n < 1000; n += 1) {
    const c = String(n).padStart(6, '0');
    if (matchTokenStep(secret, c) === null) return c;
  }
  throw new Error('no wrong code found');
}

function mfaUser(id, extra = {}) {
  makeUser(db, { id, username: id, role: 'caregiver', password: 'correct-horse' });
  const secret = generateSecret();
  db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?').run(secret, id);
  if (extra.backupHashes) db.prepare('UPDATE users SET mfa_backup_codes = ? WHERE id = ?').run(extra.backupHashes, id);
  resetMfaUserLimit(id);
  return secret;
}

beforeEach(() => {
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
});

const lastStep = (id) => db.prepare('SELECT mfa_last_step AS s FROM users WHERE id = ?').get(id).s;
const sessionToken = (id, role = 'caregiver') => signToken({ id, username: id, role, sid: makeSession(db, id) });

// Sends a request whose handler awaits bcrypt, and runs `meanwhile()` while that handler is provably
// parked on its await (review of #720). No sleeps and no "the compare probably takes long enough":
//   1. a slow job of the test's own (cost 12, ~300 ms) goes into the ONE worker first;
//   2. the request is sent, and the test waits until the worker has received a job after the blocker.
//      The worker answers in order, so while that newest job is pending the handler has reached its
//      await and cannot resume;
//   3. `meanwhile()` runs (a database change, or a real request that does not use the worker), and the
//      helper checks the request is still unanswered afterwards, so a case can never pass because the
//      interference came too late.
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

describe('#550 a TOTP code cannot be replayed', () => {
  // FAILS ON OLD CODE: before this change a second submission of the same code returned 200 (the issue
  // reproduced [true, true, true]). Proven by running this file against the pre-change routes/auth.js.
  test('★ the same code is accepted once and refused the second time, with the wrong-code response', async () => {
    const secret = mfaUser('replay-1');
    const code = codeAtOffset(secret);
    const first = await post('/login/mfa', { mfaToken: mfaToken('replay-1'), code });
    assert.equal(first.status, 200);
    assert.ok(first.body.token);

    const replay = await post('/login/mfa', { mfaToken: mfaToken('replay-1'), code });
    const wrong = await post('/login/mfa', { mfaToken: mfaToken('replay-1'), code: wrongCode(secret) });
    assert.equal(replay.status, 401);
    assert.deepEqual(replay.body, wrong.body, 'a replay is distinguishable from a wrong code: it leaks that the code was real');
    assert.equal(replay.body.error, 'Incorrect code');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get('replay-1').n, 1, 'the replay minted a session');
  });

  test('the stored step is the step the code belongs to, not the server clock\'s', async (t) => {
    // The clock (Date only; timers run as normal) is frozen in the middle of a 30 s step for this case, so
    // the code, the server's check and the expected value all see the same "now". Unfrozen, a step boundary
    // passing between making the code and the last assertion failed the case for no reason (review of #720).
    const nowMs = Math.floor(Date.now() / 30000) * 30000 + 15000;
    t.mock.timers.enable({ apis: ['Date'], now: nowMs });
    const nowStep = Math.floor(nowMs / 30000);
    const secret = mfaUser('replay-2');
    const prev = codeAtOffset(secret, -30);
    const res = await post('/login/mfa', { mfaToken: mfaToken('replay-2'), code: prev });
    assert.equal(res.status, 200, 'the previous step is within the drift allowance');
    assert.equal(lastStep('replay-2'), matchTokenStep(secret, prev));
    assert.equal(lastStep('replay-2'), nowStep - 1);
  });

  test('an OLDER step is refused after a newer one was accepted; a NEWER one is accepted after an older', async () => {
    const secret = mfaUser('replay-3');
    const next = codeAtOffset(secret, 30);
    const prev = codeAtOffset(secret, -30);
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('replay-3'), code: next })).status, 200);
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('replay-3'), code: prev })).status, 401, 'an older step went through after a newer one');
    // ...and the refusal did not move the stored step backwards.
    assert.equal(lastStep('replay-3'), matchTokenStep(secret, next));

    const secret2 = mfaUser('replay-4');
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('replay-4'), code: codeAtOffset(secret2, -30) })).status, 200);
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('replay-4'), code: codeAtOffset(secret2, 0) })).status, 200, 'a later step must still be accepted');
  });

  test('a wrong code does not advance the stored step', async () => {
    const secret = mfaUser('replay-5');
    await post('/login/mfa', { mfaToken: mfaToken('replay-5'), code: wrongCode(secret) });
    assert.equal(lastStep('replay-5'), null);
  });

  // FAILS ON OLD CODE (no replay check: all six were accepted). What it does NOT prove: that the check has
  // to be a single statement. Nothing awaits between matching the code and the UPDATE today, so a SELECT
  // followed by an UPDATE would pass this too (review of #720). The single statement is what keeps it
  // right if an await is ever added before it, and that rests on the code review, not on this case.
  test('★ two simultaneous submissions of one code: exactly one wins', async () => {
    const secret = mfaUser('race-1');
    const code = codeAtOffset(secret);
    for (let round = 0; round < 3; round += 1) {
      db.prepare('UPDATE users SET mfa_last_step = NULL WHERE id = ?').run('race-1');
      db.prepare('DELETE FROM sessions').run();
      resetMfaUserLimit('race-1');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => post('/login/mfa', { mfaToken: mfaToken('race-1'), code }))
      );
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 401, 401, 401, 401, 401], `round ${round}: ${statuses}`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get('race-1').n, 1);
    }
  });

  test('a database row from before the column existed (NULL step) accepts its first code', async () => {
    const secret = mfaUser('legacy-row');
    assert.equal(lastStep('legacy-row'), null);
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('legacy-row'), code: codeAtOffset(secret) })).status, 200);
  });

  test('clearing MFA resets the step, so a re-enrolled secret does not inherit it', async () => {
    const secret = mfaUser('reset-1');
    await post('/login/mfa', { mfaToken: mfaToken('reset-1'), code: codeAtOffset(secret) });
    assert.notEqual(lastStep('reset-1'), null);

    const session = makeSession(db, 'reset-1');
    const token = signToken({ id: 'reset-1', username: 'reset-1', role: 'caregiver', sid: session });
    const off = await post('/me/mfa/disable', { password: 'correct-horse' }, { token });
    assert.equal(off.status, 200);
    assert.equal(lastStep('reset-1'), null);

    makeUser(db, { id: 'admin-x', username: 'admin-x', role: 'admin', password: 'correct-horse' });
    db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ?, mfa_last_step = 99999999999 WHERE id = ?').run(generateSecret(), 'reset-1');
    const adminToken = signToken({ id: 'admin-x', username: 'admin-x', role: 'admin', sid: makeSession(db, 'admin-x') });
    const cleared = await call(`${server.url}/api/auth/users/reset-1/mfa`, { method: 'DELETE', token: adminToken, headers: { 'x-forwarded-for': freshIp() } });
    assert.equal(cleared.status, 200);
    assert.equal(lastStep('reset-1'), null);
  });
});

describe('#550 a new secret never inherits an old secret\'s step', () => {
  test('★ /me/mfa/setup clears a leftover step (the first code of the new secret must work)', async () => {
    makeUser(db, { id: 'setup-1', username: 'setup-1', role: 'caregiver' });
    db.prepare('UPDATE users SET mfa_last_step = 99999999999 WHERE id = ?').run('setup-1');
    const token = signToken({ id: 'setup-1', username: 'setup-1', role: 'caregiver', sid: makeSession(db, 'setup-1') });
    const res = await post('/me/mfa/setup', {}, { token });
    assert.equal(res.status, 200);
    assert.equal(lastStep('setup-1'), null);
  });
});

describe('#550 per-user MFA attempt limit', () => {
  // FAILS ON OLD CODE: the only MFA limiters were per IP (+account) and per IP, so a guesser rotating
  // source addresses was never stopped: all 35 attempts below came back 401.
  test('★ failures from DIFFERENT addresses add up against one user', async () => {
    const secret = mfaUser('lim-1');
    const bad = wrongCode(secret);
    const statuses = [];
    for (let i = 0; i < 33; i += 1) {
      statuses.push((await post('/login/mfa', { mfaToken: mfaToken('lim-1'), code: bad })).status);
    }
    assert.equal(statuses.filter((s) => s === 401).length, 30, 'the first 30 failures should reach code verification');
    assert.deepEqual(statuses.slice(30), [429, 429, 429], 'the 31st failure from a new address was not stopped');
  });

  test('the exhausted user is blocked even for the right code (it is the limiter refusing)', async () => {
    const secret = mfaUser('lim-2');
    const bad = wrongCode(secret);
    for (let i = 0; i < 30; i += 1) await post('/login/mfa', { mfaToken: mfaToken('lim-2'), code: bad });
    const res = await post('/login/mfa', { mfaToken: mfaToken('lim-2'), code: codeAtOffset(secret) });
    assert.equal(res.status, 429);
  });

  test('another user is unaffected', async () => {
    const secretA = mfaUser('lim-3a');
    const secretB = mfaUser('lim-3b');
    const bad = wrongCode(secretA);
    for (let i = 0; i < 31; i += 1) await post('/login/mfa', { mfaToken: mfaToken('lim-3a'), code: bad });
    const res = await post('/login/mfa', { mfaToken: mfaToken('lim-3b'), code: codeAtOffset(secretB) });
    assert.equal(res.status, 200);
  });

  test('successful sign-ins never spend the budget', async () => {
    const secret = mfaUser('lim-4');
    for (let i = 0; i < 35; i += 1) {
      db.prepare('UPDATE users SET mfa_last_step = NULL WHERE id = ?').run('lim-4');
      const res = await post('/login/mfa', { mfaToken: mfaToken('lim-4'), code: codeAtOffset(secret) });
      assert.equal(res.status, 200, `sign-in ${i + 1} was refused`);
    }
  });

  test('★ a FORGED token naming a user cannot spend that user\'s budget', async () => {
    const secret = mfaUser('lim-5');
    const forged = (await import('jsonwebtoken')).default.sign({ id: 'lim-5', purpose: 'mfa' }, 'not-the-real-secret', { algorithm: 'HS256' });
    for (let i = 0; i < 40; i += 1) await post('/login/mfa', { mfaToken: forged, code: '000000' });
    const res = await post('/login/mfa', { mfaToken: mfaToken('lim-5'), code: codeAtOffset(secret) });
    assert.equal(res.status, 200, 'unsigned tokens drained a real user\'s budget: it is a lockout lever');
  });

  // FAILS WITHOUT resetMfaUserLimit in DELETE /users/:id/mfa: the row was cleared but the in-memory
  // bucket was not, so the user, once re-enrolled, still got 429 for the rest of the window although the
  // docs said an admin reset clears it (review of #720, verified by running).
  test('★ an admin two-factor reset also clears the per-user limit', async () => {
    const secret = mfaUser('lim-d');
    const bad = wrongCode(secret);
    for (let i = 0; i < 30; i += 1) await post('/login/mfa', { mfaToken: mfaToken('lim-d'), code: bad });
    const blocked = await post('/login/mfa', { mfaToken: mfaToken('lim-d'), code: codeAtOffset(secret) });
    assert.equal(blocked.status, 429, 'precondition: the per-user budget is used up');

    makeUser(db, { id: 'admin-d', username: 'admin-d', role: 'admin' });
    const reset = await call(`${server.url}/api/auth/users/lim-d/mfa`, {
      method: 'DELETE', token: sessionToken('admin-d', 'admin'), headers: { 'x-forwarded-for': freshIp() },
    });
    assert.equal(reset.status, 200);
    // The user re-enrols (the write /me/mfa/enable makes) and signs in with the new authenticator.
    const secret2 = generateSecret();
    db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?').run(secret2, 'lim-d');
    const res = await post('/login/mfa', { mfaToken: mfaToken('lim-d'), code: codeAtOffset(secret2) });
    assert.equal(res.status, 200, `still ${res.status} after the admin reset: the per-user bucket was not cleared`);
  });

  test('a signed token of the wrong purpose is not keyed to the user either', async () => {
    const secret = mfaUser('lim-6');
    const media = signToken({ id: 'lim-6', purpose: 'media', sid: 'x' });
    for (let i = 0; i < 40; i += 1) await post('/login/mfa', { mfaToken: media, code: '000000' });
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('lim-6'), code: codeAtOffset(secret) })).status, 200);
  });

  test('the per-source limit is not loosened: one address is still stopped at 20', async () => {
    const secret = mfaUser('lim-7');
    const bad = wrongCode(secret);
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await post('/login/mfa', { mfaToken: mfaToken('lim-7'), code: bad }, { ip })).status);
    assert.equal(statuses.filter((s) => s === 401).length, 20);
    assert.equal(statuses[20], 429);
  });
});

describe('#548 bcrypt on a request path does not block the event loop', () => {
  // FAILS ON OLD CODE: with compareSync the timer below cannot fire while the compare runs, so the
  // largest gap between ticks was the whole compare (~330 ms at cost 12). ⚠️ It ALSO fails with
  // bcryptjs's own async bcrypt.compare(), which was the first fix tried: that API yields only after
  // 100 ms of work, and measured a ~82 ms gap at cost 10. Only the worker thread passes.
  // The cost factor is raised in the fixture hash (12) so the effect dwarfs scheduling noise; the
  // assertion is on the worst tick gap, not on total time, so a slow CI machine does not flake it.
  test('★ a login attempt leaves the event loop free to run other work', async () => {
    makeUser(db, { id: 'async-1', username: 'async-1', role: 'caregiver' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('pw-for-async-1', 12), 'async-1');
    let maxGap = 0;
    let last = process.hrtime.bigint();
    const timer = setInterval(() => {
      const now = process.hrtime.bigint();
      maxGap = Math.max(maxGap, Number(now - last) / 1e6);
      last = now;
    }, 1);
    const res = await post('/login', { username: 'async-1', password: 'pw-for-async-1' });
    clearInterval(timer);
    assert.equal(res.status, 200);
    assert.ok(maxGap < 60, `the event loop was blocked for ${maxGap.toFixed(0)} ms during one login`);
  });

  // FAILS ON the pre-review code (verified by running): /login re-read only password_hash after the await
  // and branched on mfa_enabled as read BEFORE it, so a password-only sign-in in flight while two-factor was
  // being switched on got a full session without the second factor.
  test('★ two-factor switched on while the password is being checked: the sign-in still asks for the second step', async () => {
    makeUser(db, { id: 'race-a', username: 'race-a', role: 'caregiver', password: 'race-a-password' });
    const res = await whileHandlerAwaitsBcrypt(
      () => post('/login', { username: 'race-a', password: 'race-a-password' }),
      // The write that completes /me/mfa/enable. (The real route cannot be used here: its own hashing
      // would queue behind this sign-in's compare in the one worker.)
      () => { db.prepare('UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = ?').run(generateSecret(), 'race-a'); },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.mfaRequired, true, 'the sign-in did not ask for the second factor that is now on');
    assert.equal(res.body.token, undefined, 'a full session token was issued on the password alone');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get('race-a').n, 0, 'a session was created');
  });

  test('wrong password and unknown user still return the same 401 text', async () => {
    makeUser(db, { id: 'async-2', username: 'async-2', role: 'caregiver', password: 'right-password' });
    const wrongPw = await post('/login', { username: 'async-2', password: 'nope-nope' });
    const noUser = await post('/login', { username: 'no-such-user', password: 'nope-nope' });
    assert.equal(wrongPw.status, 401);
    assert.equal(noUser.status, 401);
    assert.deepEqual(wrongPw.body, noUser.body);
    assert.equal(wrongPw.body.error, 'Incorrect username or password');
  });

  test('★ a password reset that lands DURING the compare does not leave a session behind', async () => {
    // The old synchronous handler could not be interleaved. Here the hash is swapped while the handler is
    // parked on its compare (whileHandlerAwaitsBcrypt; this case used a 120 ms sleep before the review of
    // #720), so the compare itself answers "correct" for the old password; only the re-read after it stands
    // between that and a session minted under a replaced credential.
    makeUser(db, { id: 'async-3', username: 'async-3', role: 'caregiver', password: 'old-password' });
    const res = await whileHandlerAwaitsBcrypt(
      () => post('/login', { username: 'async-3', password: 'old-password' }),
      () => { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync('new-password', 4), 'async-3'); },
    );
    assert.equal(res.status, 401, 'a credential replaced mid-compare still produced a session');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get('async-3').n, 0);
  });

  test('★ two simultaneous uses of one BACKUP code: exactly one wins', async () => {
    // FAILS WITHOUT the compare-and-swap: both requests pass the (now yielding) compare against the same
    // stored list, and both used to be allowed to write it back and sign in.
    const { codes, hashesJson } = await generateBackupCodes(3);
    mfaUser('bk-1', { backupHashes: hashesJson });
    const results = await Promise.all([
      post('/login/mfa', { mfaToken: mfaToken('bk-1'), code: codes[0] }),
      post('/login/mfa', { mfaToken: mfaToken('bk-1'), code: codes[0] }),
      post('/login/mfa', { mfaToken: mfaToken('bk-1'), code: codes[0] }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401]);
    assert.equal(JSON.parse(db.prepare('SELECT mfa_backup_codes AS c FROM users WHERE id = ?').get('bk-1').c).length, 2);
    // A different code still works afterwards.
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('bk-1'), code: codes[1] })).status, 200);
  });

  test('a backup code still works, and is single-use, through the async path', async () => {
    const { codes, hashesJson } = await generateBackupCodes(2);
    mfaUser('bk-2', { backupHashes: hashesJson });
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('bk-2'), code: codes[0].toUpperCase() })).status, 200);
    assert.equal((await post('/login/mfa', { mfaToken: mfaToken('bk-2'), code: codes[0] })).status, 401);
  });

  // The loser gets 400, NOT 401 (review of #720): the web app treats any 401 as "signed out" (#697), and
  // this request's sign-in is fine. Merged as written first, the loser answered 401 and signed the person out.
  test('two simultaneous password changes: one wins, the other gets the wrong-current-password 400', async () => {
    makeUser(db, { id: 'pw-1', username: 'pw-1', role: 'caregiver', password: 'current-password' });
    const sid = makeSession(db, 'pw-1');
    const token = signToken({ id: 'pw-1', username: 'pw-1', role: 'caregiver', sid });
    const put = (new_password) =>
      call(`${server.url}/api/auth/me/password`, {
        method: 'PUT', token, body: { current_password: 'current-password', new_password }, headers: { 'x-forwarded-for': freshIp() },
      });
    const [a, b] = await Promise.all([put('first-new-password'), put('second-new-password')]);
    assert.deepEqual([a.status, b.status].sort(), [200, 400]);
    assert.deepEqual((a.status === 400 ? a : b).body, { error: 'Current password is incorrect' });
    const hash = db.prepare('SELECT password_hash AS h FROM users WHERE id = ?').get('pw-1').h;
    const winner = a.status === 200 ? 'first-new-password' : 'second-new-password';
    assert.ok(bcrypt.compareSync(winner, hash), 'the stored password is not the winning request\'s');
  });

  test('two simultaneous /me/mfa/enable: one wins, the other gets the "already on" 400 and cannot overwrite the backup codes', async () => {
    makeUser(db, { id: 'en-1', username: 'en-1', role: 'caregiver' });
    const secret = generateSecret();
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret, 'en-1');
    const token = signToken({ id: 'en-1', username: 'en-1', role: 'caregiver', sid: makeSession(db, 'en-1') });
    const code = codeAtOffset(secret);
    const results = await Promise.all([
      post('/me/mfa/enable', { code }, { token }),
      post('/me/mfa/enable', { code }, { token }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const winner = results.find((r) => r.status === 200).body.backup_codes;
    const stored = JSON.parse(db.prepare('SELECT mfa_backup_codes AS c FROM users WHERE id = ?').get('en-1').c);
    assert.equal(stored.length, winner.length);
    assert.equal(bcrypt.compareSync(winner[0].replace('-', ''), stored[0]), true, 'the stored codes are not the ones the winner was shown');
  });

  // FAILS WITHOUT the single-flight guard (review of #720, verified by running): every request passed the
  // checks, generated its own ten backup-code hashes in the one worker, and only then lost the
  // compare-and-set, so ten requests cost a hundred hashes (about 8 s of worker time at cost 10).
  test('★ ten simultaneous /me/mfa/enable for one user: one 200, nine refused before any hashing', async () => {
    makeUser(db, { id: 'en-10', username: 'en-10', role: 'caregiver' });
    const secret = generateSecret();
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret, 'en-10');
    const token = sessionToken('en-10');
    const code = codeAtOffset(secret);
    const submittedBefore = passwordHash.passwordWorkerStats().submitted;
    const results = await Promise.all(Array.from({ length: 10 }, () => post('/me/mfa/enable', { code }, { token })));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, ...Array(9).fill(400)]);
    for (const r of results.filter((x) => x.status === 400)) assert.deepEqual(r.body, { error: 'Two-factor is already on.' });
    const hashes = passwordHash.passwordWorkerStats().submitted - submittedBefore;
    assert.equal(hashes, 10, `ten requests caused ${hashes} hashes; one enable's backup codes are 10`);
    // The guard is released when the request ends: turned off again, the account can be enabled again.
    db.prepare('UPDATE users SET mfa_enabled = 0, mfa_backup_codes = NULL WHERE id = ?').run('en-10');
    assert.equal((await post('/me/mfa/enable', { code }, { token })).status, 200, 'the in-flight mark was never released');
  });

  // FAILS WITHOUT the secret in the compare-and-set (review of #720, verified by running): a second set-up
  // stored a new secret during the hashing, and the enable still switched two-factor on, for a secret that
  // no code had been checked against.
  test('★ a new set-up while the enable is hashing: the enable fails and two-factor stays off', async () => {
    makeUser(db, { id: 'en-c', username: 'en-c', role: 'caregiver' });
    const secretA = generateSecret();
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secretA, 'en-c');
    const token = sessionToken('en-c');
    let setup;
    const res = await whileHandlerAwaitsBcrypt(
      () => post('/me/mfa/enable', { code: codeAtOffset(secretA) }, { token }),
      async () => { setup = await post('/me/mfa/setup', {}, { token }); },
    );
    assert.equal(setup.status, 200, 'precondition: the second set-up ran');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'Start setup first.' });
    const row = db.prepare('SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE id = ?').get('en-c');
    assert.equal(row.mfa_enabled, 0, 'two-factor was switched on for a secret no code was checked against');
    assert.equal(row.mfa_secret, setup.body.secret, 'the new set-up\'s secret was overwritten');
    assert.equal(row.mfa_backup_codes, null, 'backup codes were stored for a set-up that did not complete');
  });

  test('two simultaneous /setup requests create one admin, not two', async () => {
    const body = { username: 'first-admin', password: 'a-long-enough-password' };
    const results = await Promise.all([post('/setup', body), post('/setup', body), post('/setup', body)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400, 400]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  });

  test('two simultaneous creates of one username: 201 and a 400, never a 500', async () => {
    makeUser(db, { id: 'adm-c', username: 'adm-c', role: 'admin' });
    const token = signToken({ id: 'adm-c', username: 'adm-c', role: 'admin', sid: makeSession(db, 'adm-c') });
    const create = () =>
      call(`${server.url}/api/auth/users`, {
        method: 'POST', token, body: { username: 'newbie', password: 'a-long-enough-password' }, headers: { 'x-forwarded-for': freshIp() },
      });
    const results = await Promise.all([create(), create()]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 400]);
  });
});

// FAILS WITHOUT signInEnded in routes/auth.js (review of #720, verified by running): requireAuth checked the
// session when the request arrived, the session was deleted while the handler awaited bcrypt, and the write
// landed anyway. Each case deletes the requesting session while its handler is parked on bcrypt (see
// whileHandlerAwaitsBcrypt), then compares the WHOLE users table, and the sessions left, with what they
// were just after the delete: a route that writes anyway changes one or the other.
describe('#548 a session signed out while its request awaits bcrypt: nothing is written', () => {
  const cases = [
    {
      name: 'PUT /me/password',
      setup: () => makeUser(db, { id: 'g-pw', username: 'g-pw', role: 'caregiver', password: 'current-password' }).id,
      send: (token) => call(`${server.url}/api/auth/me/password`, {
        method: 'PUT', token, body: { current_password: 'current-password', new_password: 'a-new-long-password' }, headers: { 'x-forwarded-for': freshIp() },
      }),
    },
    {
      name: 'POST /me/mfa/disable',
      setup: () => { mfaUser('g-off'); return 'g-off'; },
      send: (token) => post('/me/mfa/disable', { password: 'correct-horse' }, { token }),
    },
    {
      name: 'POST /me/mfa/enable',
      setup: () => {
        makeUser(db, { id: 'g-on', username: 'g-on', role: 'caregiver' });
        db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(generateSecret(), 'g-on');
        return 'g-on';
      },
      send: (token) => post('/me/mfa/enable', {
        code: codeAtOffset(db.prepare('SELECT mfa_secret AS s FROM users WHERE id = ?').get('g-on').s),
      }, { token }),
    },
    {
      name: 'POST /users',
      role: 'admin',
      setup: () => makeUser(db, { id: 'g-adm1', username: 'g-adm1', role: 'admin' }).id,
      send: (token) => call(`${server.url}/api/auth/users`, {
        method: 'POST', token, body: { username: 'made-after-sign-out', password: 'a-long-enough-password' }, headers: { 'x-forwarded-for': freshIp() },
      }),
    },
    {
      name: 'PUT /users/:id',
      role: 'admin',
      setup: () => {
        makeUser(db, { id: 'g-target', username: 'g-target', role: 'caregiver' });
        makeSession(db, 'g-target');
        return makeUser(db, { id: 'g-adm2', username: 'g-adm2', role: 'admin' }).id;
      },
      send: (token) => call(`${server.url}/api/auth/users/g-target`, {
        method: 'PUT', token, body: { password: 'a-new-long-password', first_name: 'Changed' }, headers: { 'x-forwarded-for': freshIp() },
      }),
    },
  ];

  for (const c of cases) {
    test(`${c.name}: answers 401 and writes nothing`, async () => {
      const id = c.setup();
      const sid = makeSession(db, id);
      makeSession(db, id); // a second device: a password change would sign it out
      const token = signToken({ id, username: id, role: c.role || 'caregiver', sid });
      const snapshot = () => ({
        users: db.prepare('SELECT * FROM users ORDER BY id').all(),
        sessions: db.prepare('SELECT * FROM sessions ORDER BY id').all(),
      });
      let before;
      const res = await whileHandlerAwaitsBcrypt(() => c.send(token), () => {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
        before = snapshot();
      });
      assert.equal(res.status, 401, `${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, { error: 'Invalid or expired session' });
      assert.deepEqual(snapshot(), before, 'the write landed after the session had ended');
    });
  }
});

describe('#548 lib/passwordHash.js (the worker)', () => {
  test('hashes are ordinary bcrypt at the same cost, interchangeable with bcryptjs in both directions', async () => {
    const h = await passwordHash.hash('some password', 10);
    assert.match(h, /^\$2[aby]\$10\$/, 'cost factor changed');
    assert.match(await passwordHash.hash('default cost'), /^\$2[aby]\$10\$/, 'the module default cost changed from 10');
    assert.equal(bcrypt.compareSync('some password', h), true);
    assert.equal(await passwordHash.compare('some password', h), true);
    assert.equal(await passwordHash.compare('other', h), false);
    // A hash written by the old synchronous code must still verify.
    assert.equal(await passwordHash.compare('legacy', bcrypt.hashSync('legacy', 10)), true);
  });

  test('a bad argument rejects with an Error instead of hanging', async () => {
    await assert.rejects(passwordHash.hash(12345678, 10), Error);
    // bcryptjs answers false (does not throw) for a malformed stored hash; the worker must pass that through.
    assert.equal(await passwordHash.compare('x', 'not-a-bcrypt-hash-at-all'), false);
  });

  test('★ a killed worker is replaced, and a call in flight is rejected rather than left hanging', async () => {
    await passwordHash.hash('warm up', 4);
    const inFlight = passwordHash.hash('x'.repeat(10), 14);
    await passwordHash.stopPasswordWorker();
    await assert.rejects(inFlight, /worker stopped/);
    const h = await passwordHash.hash('after restart', 4);
    assert.equal(bcrypt.compareSync('after restart', h), true);
  });

  // FAILS WITH one pending map shared by every worker (review of #720, verified by running): a call made
  // between a crashed worker's 'error' and its 'exit' went to the new worker, was rejected by the OLD
  // worker's 'exit' ("worker stopped"), and the new worker stayed ref'd, so the process never exited.
  // Run in a child process because "the process exits by itself" is half of what is checked.
  test('★ a crashed worker fails only its own jobs, and its replacement lets the process exit', () => {
    const script = fileURLToPath(new URL('./fixtures/password-hash/crash-then-call.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(r.error?.code, undefined, `the scenario did not finish by itself (${r.error?.code}): stdout ${r.stdout}`);
    assert.deepEqual(JSON.parse(r.stdout), { crashed: 'fixture worker crashed', next: 'resolved:answer' }, r.stderr);
    assert.equal(r.status, 0, r.stderr);
  });
});
