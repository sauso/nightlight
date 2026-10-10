// Limits on POST /api/push/register (issue #546, the second half; the first half — sending in batches
// of 500 — is push-batching.test.js). What these tests pin:
//   1. a token longer than MAX_PUSH_TOKEN_LENGTH is refused with a readable 400 and NOTHING is stored,
//      and one of exactly that length is still accepted (the boundary);
//   2. one account holds at most MAX_PUSH_TOKENS_PER_USER tokens, and a NEW token at the cap is still
//      accepted by retiring that account's OLDEST (never refused — a working phone must not lose alerts);
//   3. re-registering a token the account already has is a no-op for the others (idempotent), even at the cap;
//   4. the cap is per account: another account's tokens are never evicted, whoever registers.
//
// ⚠️ THE FIXTURE IS HOSTILE. The bystander account's rows carry a recognisable marker in EVERY column
// (the column list comes from PRAGMA table_info, never a literal I typed), and the test compares whole
// rows before and after, so a column the cap touched — or a row it removed — cannot hide behind a NULL.
//
// ⚠️ updated_at has ONE-SECOND resolution (datetime('now')), so every ordering-sensitive case seeds
// explicit, distinct timestamps; the tie case is its own test.
//
// NOT covered, and not verifiable from tests: that 4096 / 25 are the right numbers for any house. They are
// generous guesses (see the comment on the constants in lib/push.js), not measurements.
import { test, describe, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { registerToken, MAX_PUSH_TOKEN_LENGTH, MAX_PUSH_TOKENS_PER_USER } = await import('../src/lib/push.js');
const { default: pushRouter } = await import('../src/routes/push.js');

const CAP = MAX_PUSH_TOKENS_PER_USER;

const ownedBy = (userId) =>
  db.prepare('SELECT token FROM push_tokens WHERE user_id = ? ORDER BY token').all(userId).map((r) => r.token);
const countOf = (userId) => db.prepare('SELECT COUNT(*) AS n FROM push_tokens WHERE user_id = ?').get(userId).n;
const rowsOf = (userId) => db.prepare('SELECT * FROM push_tokens WHERE user_id = ? ORDER BY token').all(userId);

// Distinct, ordered timestamps: index 0 is the OLDEST.
const when = (i) => `2026-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;

// A raw row, bypassing registerToken: seeds exactly the state a test needs, with an explicit age.
// EVERY column of the table is filled (marker value unless given), so a hostile row has no NULL to hide in.
const pushColumns = db.prepare('PRAGMA table_info(push_tokens)').all().map((c) => c.name);
function seed(token, userId, updatedAt) {
  const values = { token, user_id: userId, updated_at: updatedAt };
  for (const col of pushColumns) if (!(col in values)) values[col] = `marker-${col}-${token}`;
  db.prepare(`INSERT INTO push_tokens (${pushColumns.join(', ')}) VALUES (${pushColumns.map(() => '?').join(', ')})`)
    .run(...pushColumns.map((c) => values[c]));
}
// n tokens for a user, aged oldest-first: `${prefix}-00` is the oldest.
function seedMany(userId, prefix, n) {
  for (let i = 0; i < n; i++) seed(`${prefix}-${String(i).padStart(2, '0')}`, userId, when(i));
}

after(() => cleanupTempDataDirs());

beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  makeUser(db, { id: 'u-a', username: 'alice', role: 'caregiver' });
  makeUser(db, { id: 'u-b', username: 'bob', role: 'caregiver' });
});

describe('★ POST /api/push/register — token length limit (real router, real authentication)', () => {
  let server;
  let tokenA;
  before(async () => {
    server = await mountRouter('/api/push', pushRouter);
  });
  after(async () => {
    await server.close();
  });
  beforeEach(() => {
    tokenA = signToken({ id: 'u-a', username: 'alice', role: 'caregiver', sid: makeSession(db, 'u-a') });
  });
  const register = (token, tok) =>
    call(`${server.url}/api/push/register`, { method: 'POST', token, body: { token: tok, platform: 'android' } });

  test('control — a normal FCM-sized token registers', async () => {
    const res = await register(tokenA, 'x'.repeat(163));
    assert.equal(res.status, 200);
    assert.equal(countOf('u-a'), 1);
  });

  test('★ THE FIX: a token one character over the limit is refused with a readable 400 and nothing is stored', async () => {
    const res = await register(tokenA, 'x'.repeat(MAX_PUSH_TOKEN_LENGTH + 1));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /token is too long/);
    assert.ok(res.body.error.includes(String(MAX_PUSH_TOKEN_LENGTH)), 'the message must state the limit');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_tokens').get().n, 0);
  });

  test('★ THE FIX (boundary): a token of exactly the limit is accepted', async () => {
    const res = await register(tokenA, 'x'.repeat(MAX_PUSH_TOKEN_LENGTH));
    assert.equal(res.status, 200);
    assert.equal(countOf('u-a'), 1);
  });

  test('★ THE FIX: an over-length token does not evict anything either (rejected before the cap runs)', async () => {
    seedMany('u-a', 'a', CAP);
    const before = rowsOf('u-a');
    const res = await register(tokenA, 'x'.repeat(MAX_PUSH_TOKEN_LENGTH + 1));
    assert.equal(res.status, 400);
    assert.deepEqual(rowsOf('u-a'), before);
  });

  test('control — the existing validation is unchanged: a missing or non-string token is still 400 "token is required"', async () => {
    for (const bad of [undefined, '', 12345, ['a']]) {
      const res = await register(tokenA, bad);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'token is required');
    }
  });
});

describe('★ registerToken — per-account token cap', () => {
  test('control — below the cap nothing is evicted (cap-1 existing + 1 new = cap)', () => {
    seedMany('u-a', 'a', CAP - 1);
    registerToken('a-new', 'android', 'u-a', null, makeSession(db, 'u-a'));
    assert.equal(countOf('u-a'), CAP);
    assert.ok(ownedBy('u-a').includes('a-00'), 'the oldest was evicted although the cap was not reached');
    assert.ok(ownedBy('u-a').includes('a-new'));
  });

  test('★ THE FIX: a NEW token at the cap is accepted and retires exactly the OLDEST one', () => {
    seedMany('u-a', 'a', CAP);
    registerToken('a-new', 'android', 'u-a', null, makeSession(db, 'u-a'));
    assert.equal(countOf('u-a'), CAP, 'the account went over the cap (or the new token was refused)');
    const have = ownedBy('u-a');
    assert.ok(have.includes('a-new'), 'the token just registered must survive');
    assert.ok(!have.includes('a-00'), 'the oldest token must be the one retired');
    assert.ok(have.includes('a-01'), 'only ONE token may be retired per new registration');
  });

  test('★ THE FIX: the retired token is the oldest by updated_at, not by insertion order', () => {
    // Insert order is a-00..a-24, but make a-07 the stalest by age. A cap that evicted "the first row"
    // (rowid order) instead of the least recently updated would retire a-00 here.
    seedMany('u-a', 'a', CAP);
    db.prepare('UPDATE push_tokens SET updated_at = ? WHERE token = ?').run('2025-01-01 00:00:00', 'a-07');
    registerToken('a-new', 'android', 'u-a', null, makeSession(db, 'u-a'));
    const have = ownedBy('u-a');
    assert.ok(!have.includes('a-07'), 'the stalest token was not the one retired');
    assert.ok(have.includes('a-00'));
    assert.equal(have.length, CAP);
  });

  test('★ THE FIX: repeated new registrations never take the account past the cap and keep the newest ones', () => {
    seedMany('u-a', 'a', CAP);
    for (let i = 0; i < 5; i++) {
      registerToken(`n-${i}`, 'android', 'u-a', null, makeSession(db, 'u-a'));
      assert.equal(countOf('u-a'), CAP);
      db.prepare('UPDATE push_tokens SET updated_at = ? WHERE token = ?').run(`2026-02-01 00:00:0${i}`, `n-${i}`);
    }
    const have = ownedBy('u-a');
    for (let i = 0; i < 5; i++) assert.ok(have.includes(`n-${i}`), `n-${i} (recent) was retired`);
    for (let i = 0; i < 5; i++) assert.ok(!have.includes(`a-0${i}`), `a-0${i} (oldest) survived`);
  });

  test('★ THE FIX (idempotence): re-registering a token the account already has, AT the cap, changes nothing else', () => {
    seedMany('u-a', 'a', CAP);
    const sid = makeSession(db, 'u-a');
    const beforeTokens = ownedBy('u-a');
    // The OLDEST token re-registers — the one an eviction would target if re-registering were treated as new.
    registerToken('a-00', 'android', 'u-a', null, sid);
    assert.deepEqual(ownedBy('u-a'), beforeTokens, 'a refresh of an existing token added or removed a row');
    // ... and it is now the freshest, so the NEXT new token retires a different one (a-01), not it.
    registerToken('a-new', 'android', 'u-a', null, sid);
    const have = ownedBy('u-a');
    assert.ok(have.includes('a-00'), 'the refreshed token was evicted straight after being refreshed');
    assert.ok(!have.includes('a-01'));
    assert.equal(have.length, CAP);
  });

  test('★ THE FIX: when every token ties on updated_at, the token just registered still survives and the cap holds', () => {
    // datetime("now") is per-second: a burst of registrations all tie. The new token must never be the loser.
    // Seeded with the database's own "now", so they genuinely share the new token's second (a literal
    // date would make the new token strictly newer and the tie would be imaginary).
    const now = db.prepare("SELECT datetime('now') AS t").get().t;
    for (let i = 0; i < CAP; i++) seed(`t-${String(i).padStart(2, '0')}`, 'u-a', now);
    registerToken('t-new', 'android', 'u-a', null, makeSession(db, 'u-a'));
    assert.equal(countOf('u-a'), CAP);
    assert.ok(ownedBy('u-a').includes('t-new'), 'the token just registered was evicted by a timestamp tie');
  });

  test('★ THE FIX: the cap is per account — another account\'s tokens are untouched (hostile marker in every column)', () => {
    seedMany('u-a', 'a', CAP);
    // The bystander ALSO sits at the cap and is OLDER than every row of the registering account, so an
    // account-blind cap ("evict the oldest rows in the table") would take bystander rows first.
    for (let i = 0; i < CAP; i++) seed(`b-${String(i).padStart(2, '0')}`, 'u-b', `2020-01-01 00:00:${String(i).padStart(2, '0')}`);
    const bystanderBefore = rowsOf('u-b');
    assert.equal(bystanderBefore.length, CAP);
    for (const row of bystanderBefore) {
      for (const col of pushColumns) assert.notEqual(row[col], null, `fixture column ${col} is NULL — not hostile`);
    }

    registerToken('a-new', 'android', 'u-a', null, makeSession(db, 'u-a'));

    assert.deepEqual(rowsOf('u-b'), bystanderBefore, 'the cap touched another account\'s rows');
    assert.equal(countOf('u-a'), CAP);
    assert.ok(!ownedBy('u-a').includes('a-00'));
  });

  test('★ THE FIX: a NEWER bystander does not crowd the registering account out of its own slots', () => {
    // The mirror of the test above. If the "newest N" ranking were taken over the whole table rather than
    // one account, a bystander whose rows are all newer would fill every slot and the registering
    // account would lose all but its new token.
    seedMany('u-a', 'a', CAP);
    for (let i = 0; i < CAP; i++) seed(`b-${String(i).padStart(2, '0')}`, 'u-b', `2030-01-01 00:00:${String(i).padStart(2, '0')}`);
    registerToken('a-new', 'android', 'u-a', null, makeSession(db, 'u-a'));
    assert.equal(countOf('u-a'), CAP, 'the registering account lost tokens it was entitled to keep');
    assert.ok(ownedBy('u-a').includes('a-01'));
    assert.equal(countOf('u-b'), CAP);
  });

  test('★ THE FIX: the bystander registering does not disturb the first account either (symmetric)', () => {
    seedMany('u-a', 'a', CAP);
    const aBefore = rowsOf('u-a');
    registerToken('b-new', 'android', 'u-b', null, makeSession(db, 'u-b'));
    assert.deepEqual(rowsOf('u-a'), aBefore);
    assert.deepEqual(ownedBy('u-b'), ['b-new']);
  });

  test('a token moving from another account to this one at the cap counts against the NEW owner only', () => {
    seedMany('u-a', 'a', CAP);
    seed('shared', 'u-b', when(0));
    registerToken('shared', 'android', 'u-a', null, makeSession(db, 'u-a'));
    assert.equal(countOf('u-a'), CAP);
    assert.ok(ownedBy('u-a').includes('shared'));
    assert.ok(!ownedBy('u-a').includes('a-00'));
    assert.equal(countOf('u-b'), 0, 'the token still has an owner row under the old account');
  });
});
