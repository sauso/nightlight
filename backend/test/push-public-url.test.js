// Who may tell the server what its own public address is — the value every household member's alert
// deep link (`nightlight://camera/:id?server=…`) is stamped with.
//
// The address is GLOBAL (one settings cell, plus a "newest device wins" fallback), so it is server
// configuration, not a per-device hint: it is set only from an administrator's device, and whatever is
// stored or read back must be a well-formed web address. What these tests pin:
//   1. only an ADMIN's device can set it — through the stored setting AND through the fallback path,
//      which both have to carry the restriction;
//   2. the role is read from the DATABASE, never from what a token claims;
//   3. whatever is stored or read back is a bare http(s) origin, or nothing.
//
// ⚠️ THE FIXTURES ARE PAIRED. Every "a caregiver cannot…" test has an admin twin that differs ONLY in
// role, so a pass proves the role is what decided the outcome — not the URL, the ordering or a
// missing row. (A previous review in this repo found tests that varied two dimensions at once and so
// pinned neither.)
//
// ⚠️ Fallback ordering is `updated_at DESC`, and SQLite's datetime('now') has one-second resolution:
// two rows inserted by a fast test tie, and a tie is broken arbitrarily — a test could then pass
// because of insertion order rather than the rule. Every ordering-sensitive case sets timestamps
// explicitly.
//
// NOT covered here, and not verifiable from tests: that an address is actually REACHABLE. Nothing in
// the server can know that; see normalizeBaseUrl's comment.
import { test, describe, beforeEach, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

const dataDir = useTempDataDir();

const { default: db } = await import('../src/db.js');
const { registerToken, getPublicBaseUrl, normalizeBaseUrl, sendToAll, initPush } = await import('../src/lib/push.js');
const { default: pushRouter } = await import('../src/routes/push.js');

const GOOD = 'https://nightlight.example';
const EVIL = 'https://evil.example';

const setGlobal = (v) => db.prepare('UPDATE settings SET public_base_url = ? WHERE id = ?').run(v, 'app');
const getGlobal = () => db.prepare('SELECT public_base_url AS v FROM settings WHERE id = ?').get('app').v;
const tokenRow = (t) => db.prepare('SELECT * FROM push_tokens WHERE token = ?').get(t);
const stamp = (token, when) => db.prepare('UPDATE push_tokens SET updated_at = ? WHERE token = ?').run(when, token);
const setRole = (id, role) => db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);

// A raw row, bypassing registerToken entirely: stands in for data written before the checks existed.
const insertLegacyToken = (token, userId, baseUrl, updatedAt) =>
  db
    .prepare('INSERT INTO push_tokens (token, user_id, platform, base_url, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, userId, 'android', baseUrl, updatedAt);

// File-level, not inside any one describe: later describes still need the data directory.
after(() => cleanupTempDataDirs());

beforeEach(() => {
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  setGlobal(null);
  makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin' });
  makeUser(db, { id: 'u-cg', username: 'caregiver', role: 'caregiver' });
});

describe('★ registerToken: only an admin device can set the household public URL', () => {
  test('control — an admin registering with a base URL sets it', () => {
    registerToken('tok-a', 'android', 'u-admin', GOOD, makeSession(db, 'u-admin'));
    assert.equal(getGlobal(), GOOD);
    assert.equal(getPublicBaseUrl(), GOOD);
  });

  test('★ THE FIX: the identical call from a caregiver does NOT set it (nothing stored before)', () => {
    registerToken('tok-c', 'android', 'u-cg', GOOD, makeSession(db, 'u-cg'));
    assert.equal(getGlobal(), null, 'a caregiver registration wrote the global setting');
    assert.equal(getPublicBaseUrl(), null);
  });

  test('★ THE FIX: a caregiver cannot REPLACE an existing value', () => {
    setGlobal(GOOD);
    registerToken('tok-c', 'android', 'u-cg', EVIL, makeSession(db, 'u-cg'));
    assert.equal(getGlobal(), GOOD, 'a caregiver overwrote the household URL');
    assert.equal(getPublicBaseUrl(), GOOD);
  });

  test('an admin CAN replace an existing value — the twin of the test above (changing address is legitimate)', () => {
    setGlobal(GOOD);
    registerToken('tok-a', 'android', 'u-admin', 'https://new-address.example', makeSession(db, 'u-admin'));
    assert.equal(getGlobal(), 'https://new-address.example');
  });

  test("a caregiver's own address is still kept on THEIR token — only the global value is protected", () => {
    registerToken('tok-c', 'android', 'u-cg', GOOD, makeSession(db, 'u-cg'));
    assert.equal(tokenRow('tok-c').base_url, GOOD, "the caregiver's own device lost its snapshot/link base");
  });

  test('★ THE FIX: the role is read from the database at registration — a since-demoted admin cannot set it', () => {
    // Same user id, same call as the control; only the stored role changed underneath it.
    setRole('u-admin', 'caregiver');
    registerToken('tok-a', 'android', 'u-admin', EVIL, makeSession(db, 'u-admin'));
    assert.equal(getGlobal(), null, 'a demoted admin still set the global URL');
  });

  test('a user id with no users row, and a null user id, cannot set it either', () => {
    registerToken('tok-ghost', 'android', 'u-does-not-exist', EVIL, null);
    registerToken('tok-null', 'android', null, EVIL, null);
    assert.equal(getGlobal(), null);
  });
});

describe('★ getPublicBaseUrl: the "newest device" fallback ignores non-admin devices too', () => {
  // The fallback only applies when the global cell is empty, which is the state right after an upgrade.
  const adminTokenWithGlobalCleared = () => {
    registerToken('tok-a', 'android', 'u-admin', GOOD, makeSession(db, 'u-admin'));
    stamp('tok-a', '2026-01-01 00:00:00');
    setGlobal(null);
  };

  test('control — with only an admin device, the fallback finds its address', () => {
    adminTokenWithGlobalCleared();
    assert.equal(getPublicBaseUrl(), GOOD);
  });

  test('★ THE FIX: a NEWER caregiver device does not outrank an older admin device', () => {
    adminTokenWithGlobalCleared();
    registerToken('tok-c', 'android', 'u-cg', EVIL, makeSession(db, 'u-cg'));
    stamp('tok-c', '2026-06-01 00:00:00'); // strictly newer than the admin's
    assert.equal(getPublicBaseUrl(), GOOD, 'a newer caregiver device changed the fallback result');
  });

  test('★ THE FIX: with ONLY a caregiver device, there is no fallback at all', () => {
    registerToken('tok-c', 'android', 'u-cg', EVIL, makeSession(db, 'u-cg'));
    assert.equal(getPublicBaseUrl(), null, 'a caregiver-only household still got a public URL');
  });

  test('★ THE FIX: an admin device whose owner has since been demoted drops out of the fallback', () => {
    adminTokenWithGlobalCleared();
    setRole('u-admin', 'caregiver');
    assert.equal(getPublicBaseUrl(), null);
  });

  test('when several admin devices disagree, the most recently registered one wins (kept from before)', () => {
    // Pins the ordering itself: without this, reversing the sort would change nothing any test sees,
    // because the caregiver filter already leaves only one candidate in every other case.
    // ⚠️ The NEWER row is inserted FIRST. If the older one were inserted first, `ORDER BY rowid DESC`
    // (insertion order) would agree with `ORDER BY updated_at DESC` and this could not tell a real
    // "most recently registered" rule from "last row written" — found by review, it survived before.
    insertLegacyToken('tok-new', 'u-admin', GOOD, '2026-06-01 00:00:00');
    insertLegacyToken('tok-old', 'u-admin', 'https://old-address.example', '2026-01-01 00:00:00');
    assert.equal(getPublicBaseUrl(), GOOD);
  });

  test('a malformed legacy row that is NEWEST does not hide an older valid admin row behind it', () => {
    insertLegacyToken('tok-old-good', 'u-admin', GOOD, '2026-01-01 00:00:00');
    insertLegacyToken('tok-new-bad', 'u-admin', 'javascript:alert(1)', '2026-06-01 00:00:00');
    assert.equal(getPublicBaseUrl(), GOOD);
  });

  test('...however many malformed newer rows there are (no fixed look-back depth)', () => {
    // Five candidates: four malformed and newer, one valid and oldest. A fallback that only looks at
    // the newest few rows returns null here (a review found LIMIT 2 and a slice of 3 both survived
    // fixtures with only three rows).
    insertLegacyToken('tok-1', 'u-admin', GOOD, '2026-01-01 00:00:00');
    insertLegacyToken('tok-2', 'u-admin', 'javascript:alert(1)', '2026-02-01 00:00:00');
    insertLegacyToken('tok-3', 'u-admin', 'ftp://a.example', '2026-03-01 00:00:00');
    insertLegacyToken('tok-4', 'u-admin', 'https://a.example/x', '2026-04-01 00:00:00');
    insertLegacyToken('tok-5', 'u-admin', 'not a url', '2026-05-01 00:00:00');
    assert.equal(getPublicBaseUrl(), GOOD);
  });

  test('a valid but non-canonical legacy fallback row comes back canonicalised', () => {
    // A row written by an older build may hold a trailing slash, an upper-case host or a default port.
    // The stored-global path is already covered; this pins the FALLBACK path returning the canonical
    // form rather than the raw column (a review proposed that mutant and it survived).
    insertLegacyToken('tok-a', 'u-admin', 'HTTPS://Legacy.Example:443/', '2026-06-01 00:00:00');
    assert.equal(getPublicBaseUrl(), 'https://legacy.example');
  });

  test('★ THE FIX: a caregiver-owned row with a VALID address is ignored (role is the only reason)', () => {
    // The address is a perfectly valid origin, so validation cannot be what excludes it — only the role
    // filter can. (An earlier version of this test used a value with a path, which is rejected on
    // shape regardless of role and so could not tell the role filter from the validator.)
    insertLegacyToken('tok-legacy', 'u-cg', EVIL, '2026-06-01 00:00:00');
    assert.equal(getPublicBaseUrl(), null);
  });

  test('★ THE FIX: rows whose owner does not exist, or is NULL, never feed the fallback', () => {
    // push_tokens.user_id has no foreign key, so an orphan is possible. The filter is `IN (admins)`,
    // not `NOT IN (caregivers)`: only the positive form excludes a user that no longer exists.
    insertLegacyToken('tok-orphan', 'u-deleted', EVIL, '2026-06-01 00:00:00');
    insertLegacyToken('tok-null', null, EVIL, '2026-06-02 00:00:00');
    assert.equal(getPublicBaseUrl(), null);
  });

  test('★ the stored global value outranks a DIFFERENT valid admin-device address', () => {
    // Holds a valid global AND a different valid admin device together. With only one present, a
    // fallback-first implementation is indistinguishable from the real one.
    setGlobal(GOOD);
    insertLegacyToken('tok-a', 'u-admin', 'https://some-device-address.example', '2026-06-01 00:00:00');
    assert.equal(getPublicBaseUrl(), GOOD);
  });
});

describe('★ getPublicBaseUrl re-validates the stored global value on read', () => {
  // A row written by an older build (or any other route to the table) is not trusted just because it
  // is already in the database.
  // The last four are forms `new URL()` alone would turn into a valid origin — the earlier lenient
  // validator accepted them on read as well as on write (shown by an adversarial review).
  for (const bad of [
    'javascript:alert(1)', 'data:text/html,x', 'ftp://a.example', 'https://u:p@a.example', 'https://a.example/x', 'garbage',
    'http:legacy.example', 'https://legacy.example?', 'https://legacy.example/a/..', 'https:\\\\legacy.example',
  ]) {
    test(`a stored ${JSON.stringify(bad)} is never returned`, () => {
      setGlobal(bad);
      assert.equal(getPublicBaseUrl(), null);
    });
  }

  test('a valid stored value with a trailing slash still comes back without it (pre-existing behaviour kept)', () => {
    setGlobal('https://nightlight.example/');
    assert.equal(getPublicBaseUrl(), 'https://nightlight.example');
  });

  test('a malformed stored value falls through to a valid admin device rather than to nothing', () => {
    setGlobal('javascript:alert(1)');
    insertLegacyToken('tok-a', 'u-admin', GOOD, '2026-01-01 00:00:00');
    assert.equal(getPublicBaseUrl(), GOOD);
  });
});

describe('★ registerToken drops a malformed base URL instead of storing it — even from an admin', () => {
  const BAD = [
    ['another URL scheme', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,<script>1</script>'],
    ['ftp', 'ftp://a.example'],
    ['credentials in the URL', 'https://user:secret@a.example'],
    ['a path', 'https://a.example/login'],
    ['a query string', 'https://a.example/?next=x'],
    ['not a URL at all', 'not a url'],
    // Forms `new URL()` would silently repair into a valid origin (demonstrated by review). They are
    // safe once repaired, but the documented rule is "dropped", and a client that sends them is not the
    // app this endpoint was written for.
    ['a scheme with no slashes', 'http:evil.example'],
    ['an empty query marker', 'https://evil.example?'],
    ['dot segments in the path', 'https://evil.example/a/..'],
  ];
  for (const [label, bad] of BAD) {
    test(`${label}: neither the token nor the global setting keeps it, but registration still succeeds`, () => {
      setGlobal(GOOD);
      registerToken('tok-a', 'android', 'u-admin', bad, makeSession(db, 'u-admin'));
      assert.ok(tokenRow('tok-a'), 'a bad hint must not cost the device its registration');
      assert.equal(tokenRow('tok-a').base_url, null);
      assert.equal(getGlobal(), GOOD, 'a malformed value replaced the global setting');
    });
  }

  test('a malformed re-register KEEPS the last good per-device value rather than nulling it out', () => {
    const sid = makeSession(db, 'u-cg');
    registerToken('tok-c', 'android', 'u-cg', GOOD, sid);
    registerToken('tok-c', 'android', 'u-cg', 'javascript:alert(1)', sid);
    assert.equal(tokenRow('tok-c').base_url, GOOD);
    registerToken('tok-c', 'android', 'u-cg', undefined, sid);
    assert.equal(tokenRow('tok-c').base_url, GOOD, 'an older app that sends no base URL lost its stored one');
  });

  test('a re-register with a NEW valid address replaces the stored one (a device that moves networks)', () => {
    // Pins which side of the COALESCE wins. Nothing else in this file moves a device's address from one
    // valid value to another, so a flipped COALESCE (old value always wins) would otherwise go unseen.
    const sid = makeSession(db, 'u-cg');
    registerToken('tok-c', 'android', 'u-cg', 'http://192.168.1.100:8080', sid);
    registerToken('tok-c', 'android', 'u-cg', GOOD, sid);
    assert.equal(tokenRow('tok-c').base_url, GOOD, 'a device that changed address kept its old one');
  });

  test('what IS stored is the canonical origin, not the raw string', () => {
    registerToken('tok-a', 'android', 'u-admin', 'HTTPS://Nightlight.Example:443/', makeSession(db, 'u-admin'));
    assert.equal(tokenRow('tok-a').base_url, 'https://nightlight.example');
    assert.equal(getGlobal(), 'https://nightlight.example');
  });
});

describe('normalizeBaseUrl', () => {
  const ACCEPT = [
    ['https://nightlight.example', 'https://nightlight.example'],
    ['https://nightlight.example/', 'https://nightlight.example'],
    ['http://192.168.1.100:8080', 'http://192.168.1.100:8080'],
    ['http://192.168.1.100:8080/', 'http://192.168.1.100:8080'],
    ['HTTPS://Example.COM', 'https://example.com'],
    ['https://a.example:443', 'https://a.example'],
    ['  https://a.example  ', 'https://a.example'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    // Underscore is not valid in a DNS name but a LAN machine name can have one, and a browser
    // happily reports it as its origin.
    ['http://nas_box.local:8080', 'http://nas_box.local:8080'],
    ['HTTP://192.168.1.100', 'http://192.168.1.100'],
    // Single-label hosts are what a home server is usually reached by (a NAS name, localhost), and a
    // five-digit port is legal: both were unpinned until a review proposed mutants that dropped them.
    ['http://tower:8080', 'http://tower:8080'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://a.example:65535', 'http://a.example:65535'],
  ];
  for (const [input, want] of ACCEPT) {
    test(`accepts ${JSON.stringify(input)} as ${want}`, () => assert.equal(normalizeBaseUrl(input), want));
  }

  // Each rejected value trips exactly ONE rule, so removing that rule (and only that rule) is caught.
  const REJECT = [
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: scheme', 'data:text/html,x'],
    ['ftp scheme', 'ftp://a.example'],
    ['file scheme', 'file:///etc/passwd'],
    ['capacitor scheme', 'capacitor://localhost'],
    ['username and password', 'https://u:p@a.example'],
    ['username only', 'https://u@a.example'],
    ['password only', 'https://:p@a.example'],
    ['a path', 'https://a.example/x'],
    ['a query', 'https://a.example/?a=1'],
    ['a fragment', 'https://a.example/#f'],
    ['not a URL', 'not a url'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['a number', 123],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    // ⚠️ Everything below is a form `new URL()` ALONE would turn into a valid origin, which is why the
    // raw string is checked first. An earlier version validated only the parsed result and accepted
    // every one of these (found by an independent review that ran them).
    ['a scheme with no slashes', 'http:evil.example'],
    ['a scheme with one slash', 'http:/example.com'],
    ['a scheme with three slashes', 'http:///example.com'],
    ['backslashes instead of slashes', 'https:\\\\example.com'],
    ['a trailing backslash', 'https://a.example\\'],
    ['a tab inside the host', 'https://exa\tmple.com'],
    ['a newline inside the host', 'https://exam\nple.com'],
    ['a space inside the host', 'https://a b.example'],
    ['an empty query marker', 'https://evil.example?'],
    ['an empty fragment marker', 'https://example.com#'],
    ['dot segments in the path', 'https://evil.example/a/..'],
    ['an encoded dot in the path', 'https://example.com/%2e'],
    ['ws scheme', 'ws://a.example'],
    ['wss scheme', 'wss://a.example'],
    ['an empty port', 'https://a.example:'],
    ['a port above 65535 (the pattern passes it; only the URL parser can reject it)', 'https://a.example:99999'],
    ['an impossible IPv6 literal (same: shape is fine, the parser rejects it)', 'http://[::1::2]'],
    ['an unclosed IPv6 bracket', 'http://[::1'],
    ['characters that can smuggle a parameter', 'https://a&server=x.example'],
    ['a quote in the host', "https://a.example'"],
  ];
  for (const [label, input] of REJECT) {
    test(`rejects ${label}`, () => assert.equal(normalizeBaseUrl(input), null));
  }

  test('length cap sits exactly at 255: 255 accepted, 256 rejected (an off-by-one would show here)', () => {
    // `https://` is 8 chars; three 61-char labels + dots make 186; the last label sets the total.
    const origin = (lastLabelLength) =>
      `https://${['a', 'b', 'c'].map((c) => c.repeat(61)).join('.')}.${'d'.repeat(lastLabelLength)}`;
    assert.equal(origin(61).length, 255);
    assert.equal(normalizeBaseUrl(origin(61)), origin(61));
    assert.equal(origin(62).length, 256);
    assert.equal(normalizeBaseUrl(origin(62)), null);
  });
});

describe('★ POST /api/push/register — real router, real authentication', () => {
  let server;
  let adminToken;
  let cgToken;
  let cgTokenClaimingAdmin;

  before(async () => {
    server = await mountRouter('/api/push', pushRouter);
  });
  after(async () => {
    await server.close();
  });

  // Users/sessions are recreated per test by the top-level beforeEach, so tokens are minted per test.
  beforeEach(() => {
    const aSid = makeSession(db, 'u-admin');
    const cSid = makeSession(db, 'u-cg');
    adminToken = signToken({ id: 'u-admin', username: 'admin', role: 'admin', sid: aSid });
    cgToken = signToken({ id: 'u-cg', username: 'caregiver', role: 'caregiver', sid: cSid });
    // ⚠️ A token that CLAIMS admin for a user the database says is a caregiver — what a demoted admin's
    // still-valid token looks like. The role must come from the database, not from this claim.
    cgTokenClaimingAdmin = signToken({ id: 'u-cg', username: 'caregiver', role: 'admin', sid: cSid });
  });

  const register = (token, body) =>
    call(`${server.url}/api/push/register`, { method: 'POST', token, body: { token: 'fcm-1', platform: 'android', ...body } });

  test('control — an admin session sets the URL', async () => {
    const res = await register(adminToken, { baseUrl: GOOD });
    assert.equal(res.status, 200);
    assert.equal(getPublicBaseUrl(), GOOD);
  });

  test('★ THE FIX: a caregiver session registers successfully but cannot replace the URL', async () => {
    setGlobal(GOOD);
    const res = await register(cgToken, { baseUrl: EVIL });
    assert.equal(res.status, 200, 'registration itself must still succeed for a caregiver');
    assert.equal(res.body.ok, true);
    assert.equal(getPublicBaseUrl(), GOOD, 'a caregiver changed where household alert links point');
    assert.equal(tokenRow('fcm-1').base_url, EVIL, "the caregiver's own device keeps its own address");
  });

  test('★ THE FIX: a token CLAIMING admin for a database-caregiver cannot set it either', async () => {
    // ⚠️ This is an END-TO-END guard over TWO independent layers that each take the role from the
    // database: requireAuth (overrides the token's claim) and registerToken (looks the role up itself).
    // It fails only if BOTH regress. A review confirmed that breaking requireAuth alone leaves it
    // green — correctly, because the outcome is still safe — so the direct "role is read from the
    // database at registration" test above is what pins registerToken's own lookup.
    const res = await register(cgTokenClaimingAdmin, { baseUrl: EVIL });
    assert.equal(res.status, 200);
    assert.equal(getGlobal(), null, 'the role claim inside the token decided authorisation');
  });

  test('★ THE FIX: a caregiver session cannot change the fallback either (global cell empty)', async () => {
    await register(cgToken, { baseUrl: EVIL });
    assert.equal(getPublicBaseUrl(), null);
  });

  test('a malformed baseUrl STRING is accepted (200) and stored nowhere — for a caregiver and an admin alike', async () => {
    // The route must not turn a bad hint into a failed registration: an open client that sends
    // something unexpected must still get its alerts. Both roles, because the drop happens before the
    // admin check and must not depend on it.
    setGlobal(GOOD);
    for (const [who, token] of [['caregiver', cgToken], ['admin', adminToken]]) {
      db.prepare('DELETE FROM push_tokens').run();
      const res = await register(token, { baseUrl: 'javascript:alert(1)' });
      assert.equal(res.status, 200, `${who}: a malformed hint failed the registration`);
      assert.ok(tokenRow('fcm-1'), `${who}: the device was not registered`);
      assert.equal(tokenRow('fcm-1').base_url, null, `${who}: the malformed value was stored on the token`);
      assert.equal(getGlobal(), GOOD, `${who}: the malformed value replaced the global address`);
    }
  });

  test('a non-string baseUrl and a missing baseUrl are accepted and store nothing', async () => {
    setGlobal(GOOD);
    assert.equal((await register(adminToken, { baseUrl: 12345 })).status, 200);
    assert.equal(tokenRow('fcm-1').base_url, null);
    assert.equal((await register(adminToken, {})).status, 200);
    assert.equal(getGlobal(), GOOD);
  });
});

// The reason a caregiver's OWN address is still allowed to be stored: Firebase alerts are built per
// device from that device's own row, so it can only ever reach that same device. Driving the real
// sendToAll (fake Firebase, the same pattern as push.test.js) turns that from a reading of the code
// into something that fails if anyone pairs a token with the wrong row.
describe("★ sendToAll: each device is sent ITS OWN address, never another device's", () => {
  const sendEach = mock.fn(async (messages) => ({
    responses: messages.map(() => ({ success: true })),
    successCount: messages.length,
  }));
  mock.module('firebase-admin/app', { namedExports: { initializeApp: () => {}, cert: () => ({}) } });
  mock.module('firebase-admin/messaging', { namedExports: { getMessaging: () => ({ sendEach }) } });

  test('an admin phone, a caregiver phone and a second caregiver phone with a hostile address', async () => {
    fs.writeFileSync(
      path.join(dataDir, 'firebase-service-account.json'),
      JSON.stringify({ project_id: 'test-project', private_key: 'x' })
    );
    fs.writeFileSync(
      path.join(dataDir, 'google-services.json'),
      JSON.stringify({
        client: [{ client_info: { mobilesdk_app_id: 'app-1' }, api_key: [{ current_key: 'key-1' }] }],
        project_info: { project_id: 'test-project', project_number: '123' },
      })
    );
    assert.equal(await initPush(), true, 'precondition: the fake Firebase setup must initialise');
    db.prepare("UPDATE settings SET push_enabled = 1 WHERE id = 'app'").run();

    // tok-n is a device that never reported an address (an older app). It must get NO address at all —
    // not a neighbour's — which a fixture where every device has one cannot tell apart.
    const own = { 'tok-a': 'https://admin-phone.example', 'tok-c': 'http://192.168.1.100:8080', 'tok-e': EVIL, 'tok-n': null };
    registerToken('tok-a', 'android', 'u-admin', own['tok-a'], makeSession(db, 'u-admin'));
    registerToken('tok-c', 'android', 'u-cg', own['tok-c'], makeSession(db, 'u-cg'));
    registerToken('tok-e', 'android', 'u-cg', own['tok-e'], makeSession(db, 'u-cg'));
    registerToken('tok-n', 'android', 'u-cg', undefined, makeSession(db, 'u-cg'));

    sendEach.mock.resetCalls();
    await sendToAll('Motion', 'Camera detected motion', {}, Buffer.from([0xff, 0xd8, 0xff]));

    assert.equal(sendEach.mock.callCount(), 1, 'sendToAll did not attempt delivery');
    const [messages] = sendEach.mock.calls[0].arguments;
    assert.deepEqual(messages.map((m) => m.token).sort(), ['tok-a', 'tok-c', 'tok-e', 'tok-n'], 'precondition: all four devices are sent to');
    for (const m of messages) {
      const urls = JSON.stringify(m).match(/https?:\/\/[^"\\]+/g) || [];
      if (own[m.token] === null) {
        assert.ok(!('server' in m.data), `${m.token}: a device with no address was given a tap target`);
        assert.equal(m.notification.image, undefined, `${m.token}: a device with no address was given a picture URL`);
        assert.deepEqual(urls, [], `${m.token}: a device with no address had a URL in its message`);
        continue;
      }
      assert.equal(m.data.server, own[m.token], `${m.token}: the tap target is not its own device's address`);
      assert.equal(m.notification.image, `${own[m.token]}/api/push/snapshot/${m.notification.image.split('/').pop()}`, `${m.token}: the picture URL points at another device's address`);
      // Belt and braces: EVERY URL anywhere in the message belongs to this device.
      for (const url of urls) {
        assert.ok(url.startsWith(own[m.token]), `${m.token}: a URL in its message belongs to another device: ${url}`);
      }
    }
  });
});

// Claim: registerToken is the ONLY code that writes settings.public_base_url, so its admin check is the
// only gate there is. That was verified by reading and searching, which does not run again — this does.
// It is deliberately blunt: it fails on ANY new source file that so much as mentions the column, and
// the fix is a decision, not a mechanical edit: is the new writer restricted to an admin, and does it
// validate with normalizeBaseUrl? Then add the file here.
describe('★ nothing but registerToken writes settings.public_base_url', () => {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return walk(full);
      return e.name.endsWith('.js') ? [full] : [];
    });

  // lib/demoSeed.js is on the list deliberately, decided when it was added: it is the offline seed for the
  // read-only public demo, runs once at boot on a freshly wiped database, is never reachable from a
  // request, and only CLEARS the value (sets it to NULL). No caller-supplied address ever reaches it, so
  // it needs neither the admin check nor normalizeBaseUrl.
  test('the column is mentioned only by the schema migration, by lib/push.js and by the offline demo seed', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const scanned = walk(src).map((f) => path.relative(src, f).split(path.sep).join('/'));
    // The scan must actually REACH the directories a writer would live in. Without this a walker that
    // skipped `routes/` (or all subdirectories) would report the same two files and pass.
    for (const mustSee of ['db.js', 'lib/push.js', 'routes/push.js', 'routes/settings.js', 'middleware/auth.js']) {
      assert.ok(scanned.includes(mustSee), `the source scan never reached ${mustSee}`);
    }
    const mentioning = walk(src)
      .filter((f) => fs.readFileSync(f, 'utf8').includes('public_base_url'))
      .map((f) => path.relative(src, f).split(path.sep).join('/'))
      .sort();
    assert.deepEqual(
      mentioning,
      ['db.js', 'lib/demoSeed.js', 'lib/push.js'],
      'a new source file mentions settings.public_base_url — if it WRITES it, it needs an admin check and normalizeBaseUrl, like registerToken; then add it to this list'
    );
  });
});
