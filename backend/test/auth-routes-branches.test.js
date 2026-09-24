// routes/auth.js — targeted BRANCH-coverage tests (ROADMAP E2).
//
// WHY THIS FILE EXISTS, SEPARATELY FROM auth-routes.test.js. That file already covers login, MFA and
// the admin-count invariant thoroughly and sits at 99.6% LINE coverage on this file — but only ~74%
// BRANCH coverage. Line coverage only asks "did this statement run"; several either-or conditionals
// here have had exactly ONE of their two sides run in the entire suite, for reasons specific to the
// test harness rather than to the feature (see each describe block below for which side, and why).
// Kept in its own file rather than folded into auth-routes.test.js because several of these need their
// own throwaway fixtures (a demo-guest identity, a temp SQLite trigger) that would otherwise clutter
// that file's existing ones, and because this file's job is "prove the branch is real", not "prove the
// feature works end to end" — different enough questions to earn separate homes.
//
// Every describe block names the exact uncovered branch it targets and is paired with a mutants.json
// entry (label prefixed "#E2 M…") that breaks that specific branch, so `node scripts/mutate.mjs
// --only="#E2"` proves each test actually discriminates rather than merely executing the line.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  useTempDataDir, cleanupTempDataDirs, mountRouter, call, makeUser, makeSession, signToken,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: authRouter } = await import('../src/routes/auth.js');

const PASSWORD = 'irrelevant-password-1';

let server;
before(async () => { server = await mountRouter('/api/auth', authRouter); });
after(async () => {
  await server?.close();
  db.close();
  cleanupTempDataDirs();
  // Belt-and-braces: these are also cleared in beforeEach, but a thrown assertion mid-test could skip
  // that on the NEXT run only if node:test shared env across files (it doesn't — each file is its own
  // process — but a stray env var surviving to the end of THIS file's run is still worth guarding).
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_MAX_GUESTS;
});

beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  // appName()'s fallback test (below) deliberately blanks this; reset it before every test so that
  // test can't leak into whichever one happens to run after it.
  db.prepare("UPDATE settings SET app_name = 'Nightlight' WHERE id = 'app'").run();
  delete process.env.DEMO_MODE;
  delete process.env.DEMO_MAX_GUESTS;
});

const get = (path, token) => call(`${server.url}/api/auth${path}`, { token });
const post = (path, body, token, headers) =>
  call(`${server.url}/api/auth${path}`, { method: 'POST', body, token, headers });
const put = (path, body, token, headers) =>
  call(`${server.url}/api/auth${path}`, { method: 'PUT', body, token, headers });
const del = (path, token) => call(`${server.url}/api/auth${path}`, { method: 'DELETE', token });

function makeAdmin(id, username) {
  db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(id, username, bcrypt.hashSync(PASSWORD, 4), 'admin');
  return { id, username };
}

// Mints a session directly, like auth-routes.test.js's loginAs — these tests are not testing login,
// and several call this several times per test, which would otherwise burn the per-account rate limit.
const tokenFor = (row) => signToken({ id: row.id, username: row.username, role: 'admin', sid: makeSession(db, row.id) });

// === L252-266: describeDevice — GET /sessions' device label ===================================
describe('GET /sessions — the device label reflects the real client (branch coverage: describeDevice)', () => {
  // WHY THIS MATTERS: the device label is the ONLY way a signed-in user picks "my old phone" out of
  // a session list to revoke it (see describeDevice's own comment in the source). Getting it wrong
  // isn't cosmetic — it makes "sign out that one device" impossible to use correctly.
  //
  // WHY IT WAS ZERO: every request in the whole suite goes through Node's built-in fetch(), which
  // sends a literal "User-Agent: node" — that matches NONE of describeDevice's twelve os/browser
  // regexes, so every one of them has run zero times despite the file sitting at 99.6% LINE coverage.
  // Only the function's final "no match" fallthrough (not even the explicit `if (!userAgent)` early
  // return — "node" is truthy) has ever executed.
  test('★ real device/browser combinations are labelled correctly, not left as "Unknown"', async () => {
    const admin = makeAdmin('u-dev', 'device-admin');
    const CASES = [
      [
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Safari on iPhone',
        'a real iPhone UA also contains the substring "Mac OS X" — iPhone must be checked before that broader OS pattern',
      ],
      [
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.6045.109 Mobile/15E148 Safari/604.1',
        'Chrome on iPad',
        'the CriOS half of the Chrome OR-condition — Chrome for iOS never carries a "Chrome/" token at all',
      ],
      [
        'Mozilla/5.0 (Android 14; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
        'Firefox on Android',
        'Android must be detected, and Firefox must be checked ahead of the Chrome/Safari branches below it',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
        'Edge on Windows',
        'a real Edge UA ALSO contains "Chrome/" and "Safari/" — Edge must be checked before Chrome or every Edge user reads as Chrome',
      ],
      [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Firefox on Mac',
        'plain desktop Firefox — no Chrome/Safari tokens to interfere',
      ],
      [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Chrome on Windows',
        'the right half of the Chrome OR-condition: "Chrome/" present AND "Chromium" absent',
      ],
      [
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0',
        'Opera on Linux',
        'a real Opera UA also contains "Chrome/" and "Safari/" — Opera must be checked before Chrome',
      ],
      [
        'HeadlessRig/1.0 Chromium/91.0.4472.114 Chrome/91.0.4472.114 Safari/537.36',
        'Unknown browser on Unknown OS',
        'a Chromium-based browser identifying itself as both: the "!/Chromium/" guard on the Chrome check AND ' +
          'the "!/Chrome/" guard on the Safari check must BOTH fire, or this gets mislabelled as one or the other',
      ],
    ];

    for (const [ua, expected, why] of CASES) {
      const login = await call(`${server.url}/api/auth/login`, {
        method: 'POST',
        body: { username: admin.username, password: PASSWORD },
        headers: { 'user-agent': ua },
      });
      assert.equal(login.status, 200, `login failed for UA ${JSON.stringify(ua)}: ${JSON.stringify(login.body)}`);
      const sid = jwt.decode(login.body.token).sid;
      const res = await get('/sessions', login.body.token);
      assert.equal(res.status, 200);
      const session = res.body.find((s) => s.id === sid);
      assert.ok(session, `no session row came back for UA ${JSON.stringify(ua)}`);
      assert.equal(session.device, expected, `${why} — UA: ${JSON.stringify(ua)}`);
    }
  });
});

// === L470-471: POST /users validation ==========================================================
describe('POST /users — the 400 it promises is actually enforced (branch coverage: L470-471)', () => {
  // WHY IT WAS ZERO: the existing suite tests a SUCCESSFUL admin-created account and a DUPLICATE
  // username, but never a too-short/missing password — the sibling checks in /setup and PUT
  // /users/:id both have exactly this case covered; this route's copy of the same guard did not.
  test('★ a sub-8-character password is refused, and no account is created', async () => {
    const admin = makeAdmin('u-create-admin', 'creator');
    const token = tokenFor(admin);
    const res = await post('/users', { username: 'shortpw', password: 'short1' }, token);
    assert.equal(res.status, 400, `a sub-8-char password was accepted: ${JSON.stringify(res.body)}`);
    assert.equal(
      db.prepare('SELECT 1 FROM users WHERE username = ?').get('shortpw'),
      undefined,
      'the account was created despite the short password'
    );
  });
});

// === L544-546 / L676-678: a non-LastAdminError propagates, it is not swallowed =================
describe('a DB-level failure inside keepingAnAdmin propagates as a real error, not a silent success', () => {
  // WHY IT WAS ZERO: every existing test that reaches this catch block deliberately triggers
  // LastAdminError (the 409 case, #441). Nothing has ever exercised the OTHER half — `throw e;` —
  // because nothing in the existing suite can make the wrapped mutate() throw anything else. A real
  // installation could: a full disk, a future CHECK constraint, corruption. There is no way to reach
  // that half through the router's own validation (username/password/role are all pre-checked before
  // the transaction), so this simulates it the only way available without editing src/: a temp SQLite
  // TRIGGER that aborts the specific statement, scoped to one connection and dropped immediately after
  // use. If the `throw e` were ever deleted or swallowed, the handler would fall through to the success
  // response below it — reporting 200/204 for a write that never actually happened.
  test('★ PUT /users/:id: an aborted UPDATE is reported as a real error, and the row is unchanged (L544-546)', async () => {
    const admin = makeAdmin('u-put-trig', 'trig-put-admin');
    const token = tokenFor(admin);
    const MARKER = 'FORCE-DB-FAILURE-PUT';
    db.exec(`
      CREATE TEMP TRIGGER force_users_update_failure
      BEFORE UPDATE ON users
      WHEN NEW.first_name = '${MARKER}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated db failure');
      END;
    `);
    try {
      const res = await put(`/users/${admin.id}`, { first_name: MARKER }, token);
      assert.notEqual(res.status, 200, 'the aborted update was reported as a success');
      assert.notEqual(res.status, 409, 'a non-LastAdminError was mistaken for the admin-count guard');
      assert.equal(res.status, 500, `expected the error to propagate as a 500: ${JSON.stringify(res.body)}`);
      assert.equal(
        db.prepare('SELECT first_name FROM users WHERE id = ?').get(admin.id).first_name,
        null,
        'the row changed despite the statement aborting inside the transaction'
      );
    } finally {
      db.exec('DROP TRIGGER IF EXISTS force_users_update_failure');
    }
  });

  test('★ DELETE /users/:id: an aborted DELETE is reported as a real error, and the account survives (L676-678)', async () => {
    const actor = makeAdmin('u-del-trig-actor', 'trig-del-actor');
    // A SECOND admin, so a 409 here could ONLY mean the forced failure was mistaken for LastAdminError
    // — never the real "last admin" guard, which needs exactly one admin to fire.
    const victim = makeAdmin('u-del-trig-victim', 'trig-del-victim');
    const token = tokenFor(actor);
    db.exec(`
      CREATE TEMP TRIGGER force_users_delete_failure
      BEFORE DELETE ON users
      WHEN OLD.id = '${victim.id}'
      BEGIN
        SELECT RAISE(ABORT, 'simulated db failure');
      END;
    `);
    try {
      const res = await del(`/users/${victim.id}`, token);
      assert.notEqual(res.status, 204, 'the aborted delete was reported as a success');
      assert.notEqual(res.status, 409, 'a non-LastAdminError was mistaken for the admin-count guard (there were two admins)');
      assert.equal(res.status, 500, `expected the error to propagate as a 500: ${JSON.stringify(res.body)}`);
      assert.ok(
        db.prepare('SELECT 1 FROM users WHERE id = ?').get(victim.id),
        'the account was removed even though the statement aborted'
      );
    } finally {
      db.exec('DROP TRIGGER IF EXISTS force_users_delete_failure');
    }
  });
});

// === L24: appName() fallback ====================================================================
describe('appName() falls back to "Nightlight" rather than embedding a blank TOTP issuer (branch coverage: L24)', () => {
  // WHY IT WAS ZERO: db.js seeds settings.app_name = 'Nightlight' for every fresh install (and every
  // test fixture), so the `?.app_name` side of the `||` is truthy in literally every other test that
  // touches this route. The fallback exists for the row-missing / blanked-by-a-future-migration case,
  // and an untested fallback here means an authenticator app could be handed an empty issuer string —
  // which several TOTP apps render as a blank or garbled entry, not a helpful failure.
  test('★ a blank app_name does not reach the authenticator issuer', async () => {
    const admin = makeAdmin('u-mfa-app', 'mfa-app-admin');
    const token = tokenFor(admin);
    db.prepare("UPDATE settings SET app_name = '' WHERE id = 'app'").run();
    const res = await post('/me/mfa/setup', {}, token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // EXACT match on the issuer param, not a substring check: `?.app_name || 'Nightlight'` and a
    // mutated fallback like 'NightlightFallbackBroken' both contain "Nightlight" as a prefix, so an
    // `.includes()` here would pass either one — the whole point of this test is telling them apart.
    assert.match(
      res.body.otpauth_uri,
      /[?&]issuer=Nightlight(&|$)/,
      `expected the issuer to fall back to EXACTLY "Nightlight", got: ${res.body.otpauth_uri}`
    );
  });
});

// === L215-216: demoMaxGuests() fallbacks ========================================================
describe('demoMaxGuests() falls back to a working cap, not a broken 0, on a missing or invalid env var (branch coverage: L215-216)', () => {
  // WHY IT WAS ZERO: every test elsewhere that sets DEMO_MAX_GUESTS sets it to a valid positive
  // integer. Nothing in the suite ever left it unset (hitting the `?? 25` fallback) or set it to
  // something invalid (hitting the `: 25` fallback after `Number.isSafeInteger` rejects it) WHILE
  // actually calling demoMaxGuests(). Both matter: an admin who never sets the var, or who fat-fingers
  // it, must not end up with a demo that is either permanently full (cap resolves to 0 or less) or
  // unbounded — the exact number is pinned at the documented default of 25, not just "some positive
  // number", by seeding exactly 25 active guest sessions and checking the boundary is crossed there.
  function seedDemoGuest() {
    return makeUser(db, { id: 'u-demo-guest', username: 'demo-guest', role: 'admin', password: 'unusable-value-1' });
  }
  function seedActiveGuestSessions(userId, n) {
    for (let i = 0; i < n; i++) {
      db.prepare('INSERT INTO sessions (id, user_id, user_agent) VALUES (?, ?, ?)').run(`demo-sess-${i}`, userId, 'test');
    }
  }

  // BOTH sides of the boundary, not just "25 is full": a fallback of 0 (a permanently full demo) or any
  // cap up to 25 would also make 25 full. Only "24 is NOT full AND 25 IS full" pins the cap at exactly 25
  // (found by the Codex review 2026-09-25: M9-M10 changed 25 to 30, which the one-sided check caught,
  // but a fallback of 0 would have passed it).
  async function assertCapIsExactly25(guestId, why) {
    seedActiveGuestSessions(guestId, 24);
    const below = await get('/status');
    assert.equal(below.status, 200);
    assert.equal(below.body.demo.full, false, `24 active guests must NOT be full (${why}): ${JSON.stringify(below.body)}`);
    db.prepare('INSERT INTO sessions (id, user_id, user_agent) VALUES (?, ?, ?)').run('demo-sess-24', guestId, 'test');
    const at = await get('/status');
    assert.equal(at.status, 200);
    assert.equal(at.body.demo.full, true, `25 active guests must be full (${why}): ${JSON.stringify(at.body)}`);
  }

  test('★ DEMO_MAX_GUESTS unset: the cap is exactly the documented default of 25', async () => {
    process.env.DEMO_MODE = 'true';
    delete process.env.DEMO_MAX_GUESTS;
    await assertCapIsExactly25(seedDemoGuest().id, 'DEMO_MAX_GUESTS unset');
  });

  test('★ DEMO_MAX_GUESTS invalid ("not-a-number"): falls back to exactly 25, not 0', async () => {
    process.env.DEMO_MODE = 'true';
    process.env.DEMO_MAX_GUESTS = 'not-a-number';
    await assertCapIsExactly25(seedDemoGuest().id, 'DEMO_MAX_GUESTS invalid');
  });
});

// === L273: createSession's userAgent fallback ===================================================
describe('createSession stores NULL for a missing User-Agent, not an empty string (branch coverage: L273)', () => {
  // WHY IT WAS ZERO: fetch() always sends SOME User-Agent value in every other test (Node's fetch
  // defaults to "node" when not overridden), so `userAgent || null`'s right side never ran. The
  // difference is real: describeDevice's own `if (!userAgent) return 'Unknown device'` treats an empty
  // string as falsy too, but an empty string stored where NULL was intended is exactly the kind of
  // "looks the same until something greps for NULL" bug this house style calls out.
  test('★ an explicitly empty User-Agent header is stored as NULL', async () => {
    const admin = makeAdmin('u-no-ua', 'no-ua-admin');
    const res = await call(`${server.url}/api/auth/login`, {
      method: 'POST',
      body: { username: admin.username, password: PASSWORD },
      headers: { 'user-agent': '' },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const sid = jwt.decode(res.body.token).sid;
    const row = db.prepare('SELECT user_agent FROM sessions WHERE id = ?').get(sid);
    assert.equal(
      row.user_agent,
      null,
      `expected NULL, got ${JSON.stringify(row.user_agent)} — an empty string is not the same value`
    );
  });
});
