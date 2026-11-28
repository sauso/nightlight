// Signing in a TV by code (#1237, phase 2 of the Android TV app, the pairing protocol; planning/tv-pairing-design.md §4,
// §5, §10). The routes are POST /api/auth/device/start, /poll (both public), /pending, /approve and /deny (signed in),
// plus `tv: true` on /login and /login/mfa (a TV's password sign-in). The TV session they make (kind 'tv') and what it
// may reach are tv-session.test.js's; that file also walks every route as a TV minted by a real pairing.
//
// THE CLAIMS, each with the test below that fails without it (mutants: scripts/mutants.json, "#1237 pairing ..."):
//   - the device_code is answered once and only its sha256 is stored                     "start ... only the sha256"
//     (and no GET returns device_hash: secrets-never-returned.test.js plants a marker in it)
//   - user codes: the alphabet, 8 symbols, any case, dash or spaces; a taken code is
//     drawn again                                                                          "codes", "collision"
//   - the label: control and bidi characters gone, one line, at most 40 characters        "sanitiseLabel", "start"
//   - single use, by SEQUENTIAL replay (the handler is synchronous, so a "simultaneous"
//     race test could not fail)                                                            "single use"
//   - approve and deny exclude each other; a denied pairing is never collected            "exclude each other"
//   - expiry on the JavaScript clock, a second either side; a clock moved back             "expiry", "clock moved back"
//   - THE ONE GUARANTEE AT CLAIM, isLiveSessionId(approved_by_session) + password_set,
//     with the session and the pairing LEFT IN PLACE (the disable route would delete both
//     first, so it cannot isolate the claim-time check)                                    "the one guarantee"
//   - a sign-out, a revoke, a password change or reset made from ANOTHER session cancel an
//     approval; the same change from the approving session does not (stated exception)    "cancel", "exception"
//   - a refused claim answers `denied` at once and leaves the row marked                   "refused claim"
//   - the poll answers 200 to everything; unknown, expired and collected are one `expired` "always HTTP 200"
//   - slow_down is kept in the row, per pairing                                            "slow_down"
//   - the caps count live rows only; own-bucket eviction; global eviction from the fullest
//     bucket; approved rows are never evicted; a TV that reloads 3 times still starts      "the caps"
//   - 5 live TV sessions per account, at approve and again at the claim                    "the cap of 5"
//   - pending, approve and deny: a uniform 404; a failures-only limit per user; refused to
//     a TV session                                                                          "pending, approve, deny"
//   - the audit lines at approve and at claim, never a secret                               "audit"
//   - `tv: true` on /login (with and without two-factor) makes a TV session, and the
//     second step cannot change it                                                          "password sign-in"
//   - disabling the approver deletes its pairings; removing it cascades                     "disabling or removing"
//   - the demo blocks all five routes                                                       demoMode.test.js "#1237"
//   - every route's gate                                                                    route-permissions.test.js
//
// "NOW" is the JavaScript clock (the routes read utcText(Date.now())), so the boundary cases move it with node:test's
// mock timers; SQLite's datetime('now') does not move, so a route that used it would fail them.
//
// NOT COVERED HERE (stated, not hidden): any screen (the next change: the TV's pairing page and its password form, the
// approval page, the Settings card); a real TV, remote or phone; a TV behind a reverse proxy (the limiters' shared key
// without TRUST_PROXY is a documented limit, not something a unit test can show); two server processes (the app is one).
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, mountRouterTrustingProxy, signToken, call,
} from './helpers/harness.js';
import { stripCommentsAndStrings } from './helpers/sourceScan.js';

useTempDataDir();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { default: db } = await import('../src/db.js');
const {
  default: authRouter, createSession, resetTvPairingLimits, resetPasswordThrottles, resetMfaUserLimit,
  setUserCodeSourceForTest, purgeTvPairings,
} = await import('../src/routes/auth.js');
const {
  USER_CODE_ALPHABET, newUserCode, normaliseUserCode, displayUserCode, newDeviceCode, deviceCodeHash, sanitiseLabel,
} = await import('../src/lib/tvPairing.js');
const passwordHash = await import('../src/lib/passwordHash.js');
const { logger } = await import('../src/lib/logger.js');
const { generateSecret } = await import('../src/lib/mfa.js');
const { generateSync } = await import('otplib');

const MINUTE = 60 * 1000;
const ADMIN_PW = 'admin-password-1';
const CARER_PW = 'carer-password-1';
// The user agents, and what describeDevice makes of them.
const TV_UA = 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TV_DEVICE = 'Chrome on Android';
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const PHONE_DEVICE = 'Safari on iPhone';
// The answers, typed here (not read from the code under test).
const INVALID = { error: 'pair_invalid' };
const EXPIRED = { status: 'expired' };
const PENDING = { status: 'pending' };
const DENIED = { status: 'denied' };
const SLOW_DOWN = { status: 'slow_down' };
const TOO_MANY = { error: 'Too many attempts - please wait a few minutes and try again.' };
const PUBLIC_USER_KEYS = ['created_at', 'first_name', 'id', 'last_name', 'mfa_enabled', 'photo', 'role', 'username'];
const CODE_SHAPE = /^[BCDFGHJKMNPQRSTVWXYZ]{4}-[BCDFGHJKMNPQRSTVWXYZ]{4}$/;

let server;
before(async () => { server = await mountRouterTrustingProxy('/api/auth', authRouter); });
after(async () => {
  mock.timers.reset();
  setUserCodeSourceForTest(null);
  await server?.close();
  db.close();
  cleanupTempDataDirs();
});

const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const api = (method, p, { body, token, headers } = {}) => call(`${server.url}/api/auth${p}`, { method, body, token, headers });

// Every TV and phone from an address of its own unless a case says otherwise, so a limiter or a bucket cap never
// decides a case it is not about.
let ipSeq = 0;
const nextIp = () => { ipSeq += 1; return `10.96.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

const start = (body = { label: 'Living room TV' }, { ip = nextIp(), ua = TV_UA } = {}) =>
  api('POST', '/device/start', { body, headers: { 'x-forwarded-for': ip, 'user-agent': ua } });
const poll = (deviceCode, { ip = nextIp(), ua = TV_UA } = {}) =>
  api('POST', '/device/poll', { body: { device_code: deviceCode }, headers: { 'x-forwarded-for': ip, 'user-agent': ua } });
const codeRoute = (step) => (who, userCode, ua = PHONE_UA) =>
  api('POST', `/device/${step}`, { token: who.token, body: { user_code: userCode }, headers: { 'user-agent': ua, 'x-forwarded-for': nextIp() } });
const pending = codeRoute('pending');
const approve = codeRoute('approve');
const deny = codeRoute('deny');
const login = (body) => api('POST', '/login', { body, headers: { 'x-forwarded-for': nextIp(), 'user-agent': TV_UA } });

async function started(body, opts) {
  const res = await start(body, opts);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}
async function approved(who, pairing) {
  const res = await approve(who, pairing.user_code);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const pairingRows = () => db.prepare('SELECT * FROM tv_pairings ORDER BY created_at, rowid').all();
const pairingOf = (pairing) => db.prepare('SELECT * FROM tv_pairings WHERE device_hash = ?').get(sha256(pairing.device_code));
const sessionRow = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
const tvSessionsOf = (userId) => db.prepare("SELECT * FROM sessions WHERE user_id = ? AND kind = 'tv'").all(userId);

// An ordinary signed-in session and its token, as /login mints them.
function userSession(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const sid = makeSession(db, userId);
  return { sid, token: signToken({ id: userId, username: u.username, role: u.role, sid }) };
}
// A TV session made by hand, through the real createSession (for the cap and the allowlist cases).
function handMadeTv(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const sid = createSession(userId, TV_UA, { kind: 'tv', label: 'An older TV' });
  return { sid, token: signToken({ id: userId, username: u.username, role: u.role, sid }) };
}

// A pairing written straight into the table, at any time and in any state (the caps and the hostile cases).
let plantSeq = 0;
function plantPairing({ bucket = 'planted', createdMs = Date.now(), ttlMs = 10 * MINUTE, approvedBy = null, deniedMs = null } = {}) {
  plantSeq += 1;
  const deviceCode = newDeviceCode();
  const id = `pair-${plantSeq}`;
  const userCode = newUserCode();
  db.prepare(
    `INSERT INTO tv_pairings (id, device_hash, user_code, label, client_bucket, device, created_at, expires_at,
                              user_id, approved_by_session, approved_from, approved_at, denied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, sha256(deviceCode), userCode, `Planted ${plantSeq}`, bucket, TV_DEVICE, utc(createdMs), utc(createdMs + ttlMs),
    approvedBy?.userId ?? null, approvedBy?.sid ?? null, approvedBy ? PHONE_DEVICE : null, approvedBy ? utc(createdMs) : null,
    deniedMs === null ? null : utc(deniedMs)
  );
  return { id, device_code: deviceCode, user_code: displayUserCode(userCode) };
}
const exists = (planted) => !!db.prepare('SELECT 1 FROM tv_pairings WHERE id = ?').get(planted.id);

// The JavaScript clock on a whole second, so "a second before / at the expiry" is exact (the times are whole seconds).
function freezeClock() {
  const t0 = Math.floor(Date.now() / 1000) * 1000;
  mock.timers.enable({ apis: ['Date'], now: t0 });
  return t0;
}

let carerPhone;
let adminPhone;
beforeEach(() => {
  mock.timers.reset();
  setUserCodeSourceForTest(null);
  db.prepare('DELETE FROM tv_pairings').run();
  db.prepare('DELETE FROM push_tokens').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM users').run();
  makeUser(db, { id: 'u-admin', username: 'admin', role: 'admin', password: ADMIN_PW });
  makeUser(db, { id: 'u-carer', username: 'carer', role: 'caregiver', password: CARER_PW });
  carerPhone = userSession('u-carer');
  adminPhone = userSession('u-admin');
  // Module-level stores, shared across cases like every limiter here.
  resetTvPairingLimits();
  resetPasswordThrottles('u-admin', 'admin');
  resetPasswordThrottles('u-carer', 'carer');
  resetMfaUserLimit('u-carer');
});

// ---- the codes and the label (lib/tvPairing.js) -----------------------------------------------------------------------

describe('★ #1237 pairing: codes', () => {
  test('the alphabet is the design\'s 20 symbols: no vowel, no digit, no L, no repeat', () => {
    assert.equal(USER_CODE_ALPHABET, 'BCDFGHJKMNPQRSTVWXYZ');
    assert.equal(new Set(USER_CODE_ALPHABET).size, 20);
    assert.doesNotMatch(USER_CODE_ALPHABET, /[AEIOUL0-9]/);
  });

  test('newUserCode takes 8 symbols, each from draw(20), and refuses a draw outside the alphabet', () => {
    const order = [0, 19, 1, 18, 2, 17, 3, 16];
    const asked = [];
    const code = newUserCode((n) => { asked.push(n); return order[asked.length - 1]; });
    assert.equal(code, 'BZCYDXFW');
    assert.deepEqual(asked, Array(8).fill(20));
    for (const bad of [20, -1, 1.5, Number.NaN, '3', undefined]) {
      assert.throws(() => newUserCode(() => bad), /draw answered/, String(bad));
    }
  });

  test('the real draw: every code is 8 symbols of the alphabet, and every symbol turns up', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const code = newUserCode();
      assert.match(code, /^[BCDFGHJKMNPQRSTVWXYZ]{8}$/);
      for (const ch of code) seen.add(ch);
    }
    assert.equal(seen.size, 20, `symbols that never came up: ${[...USER_CODE_ALPHABET].filter((c) => !seen.has(c))}`);
  });

  test('normaliseUserCode: any case, a dash of any kind and spaces are one code; anything else is no code', () => {
    for (const typed of ['BCDF-GHJK', 'bcdf-ghjk', 'BCDFGHJK', ' bcdf ghjk ', 'Bcdf\u2013Ghjk', 'B C D F G H J K', 'bcdf\tghjk']) {
      assert.equal(normaliseUserCode(typed), 'BCDFGHJK', JSON.stringify(typed));
    }
    for (const typed of ['BCDF-GHJ', 'BCDF-GHJKM', 'ACDF-GHJK', 'BCDF-GHJ0', 'BCDL-GHJK', 'BCDF_GHJK', '', 12345678, null, undefined, ['BCDFGHJK']]) {
      assert.equal(normaliseUserCode(typed), null, JSON.stringify(typed));
    }
    assert.equal(displayUserCode('BCDFGHJK'), 'BCDF-GHJK');
  });

  test('★ normaliseUserCode refuses letters that upper-case INTO the alphabet: the long s, the st and ff ligatures', () => {
    // Written as code points, so no editor can swap them for look-alikes. (Review of PR 1b, Codex and Opus.)
    const longS = String.fromCodePoint(0x17f);
    const st = String.fromCodePoint(0xfb05);
    const ff = String.fromCodePoint(0xfb00);
    // The precondition that makes this a test: upper-casing maps each of them onto letters of the alphabet.
    assert.equal(`BCDF-GHJ${longS}`.toUpperCase(), 'BCDF-GHJS');
    assert.equal(`BCDF-GH${st}`.toUpperCase(), 'BCDF-GHST');
    assert.equal(`BCDF-GH${ff}`.toUpperCase(), 'BCDF-GHFF');
    for (const typed of [`BCDF-GHJ${longS}`, `bcdf-ghj${longS}`, `BCDF-GH${st}`, `BCDF-GH${ff}`, `${longS}sss-ssss`]) {
      assert.equal(normaliseUserCode(typed), null, `${JSON.stringify(typed)} was taken for a code`);
    }
    // Exactly spaces and dash punctuation are taken out: not the minus sign, not a zero-width space.
    for (const cp of [0x2212, 0x200b]) {
      assert.equal(normaliseUserCode(`BCDF${String.fromCodePoint(cp)}GHJK`), null, `U+${cp.toString(16)}`);
    }
  });

  test('★ sanitiseLabel takes out what draws nothing; an emoji family keeps its joiners; a label of nothing visible is null', () => {
    // Code points, not literals: these characters are invisible in an editor (review of PR 1b, Codex and Opus).
    const cp = (...points) => String.fromCodePoint(...points);
    assert.equal(sanitiseLabel(`Living${cp(0x200b)} room${cp(0x2060)} TV`), 'Living room TV', 'a zero-width space or word joiner survived');
    assert.equal(sanitiseLabel(`TV${cp(0xe0001, 0xe0068, 0xe0069, 0xe007f)}`), 'TV', 'tag characters (hidden text) survived');
    assert.equal(sanitiseLabel(`T${cp(0xad)}V`), 'TV', 'a soft hyphen survived');
    for (const filler of [0x115f, 0x1160, 0x3164, 0xffa0]) {
      assert.equal(sanitiseLabel(`T${cp(filler)}V`), 'TV', `the Hangul filler U+${filler.toString(16)} survived`);
    }
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    assert.equal(sanitiseLabel(`${family} TV`), `${family} TV`, 'the joiners of an emoji family were taken out');
    for (const blank of [cp(0x200b, 0x200b), cp(0x3164), cp(0x2060, 0x200d), `${cp(0xe0020)} ${cp(0x115f)}`, cp(0x200d, 0x200d)]) {
      assert.equal(sanitiseLabel(blank), null, `an invisible label was kept: ${JSON.stringify(blank)}`);
    }
  });

  test('a device code is 32 random bytes in base64url, stored as its sha256', () => {
    const a = newDeviceCode();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, newDeviceCode());
    assert.equal(deviceCodeHash(a), sha256(a));
  });

  test('sanitiseLabel: one line, no control or bidi character, no lone surrogate, at most 40 characters, trimmed', () => {
    assert.equal(sanitiseLabel('  Living\nroom\r\n\tTV  '), 'Living room TV');
    assert.equal(sanitiseLabel('Living\u0000 room\u007f TV\u0085\u009b'), 'Living room TV');
    // A right-to-left override would show "VT moor gniviL" as something else; every bidi control goes.
    assert.equal(sanitiseLabel('\u202EVT moor gniviL\u202C'), 'VT moor gniviL');
    assert.equal(sanitiseLabel('a\u061Cb\u200Ec\u200Fd\u202Ae\u202Bf\u202Dg\u2066h\u2067i\u2068j\u2069k'), 'abcdefghijk');
    assert.equal(sanitiseLabel('TV\u2028two\u2029three'), 'TV two three');
    assert.equal(sanitiseLabel('TV \ud800 room'), 'TV room');
    // 40 characters, counted in code points: an emoji is one, and is never cut in half.
    assert.equal(sanitiseLabel('x'.repeat(41)), 'x'.repeat(40));
    assert.equal(sanitiseLabel('😀'.repeat(41)), '😀'.repeat(40));
    assert.equal(sanitiseLabel(`${'x'.repeat(39)} y`), 'x'.repeat(39), 'the clamp leaves a trailing space');
    // Every script is kept as typed.
    assert.equal(sanitiseLabel('Τηλεόραση σαλονιού'), 'Τηλεόραση σαλονιού');
    assert.equal(sanitiseLabel('居間のテレビ'), '居間のテレビ');
    for (const empty of ['', '   ', '\n\t', '\u202E\u202C']) assert.equal(sanitiseLabel(empty), null, JSON.stringify(empty));
  });
});

// ---- start -------------------------------------------------------------------------------------------------------

describe('★ #1237 pairing: POST /device/start', () => {
  test('answers the codes once; only the device code\'s sha256 is stored, with the sanitised label, the TV\'s device and its bucket, for ten minutes', async () => {
    const t0 = freezeClock();
    const res = await start({ label: '  Living\nroom\u202E TV\u0000 ' }, { ip: '10.97.1.2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body).sort(), ['device_code', 'expires_in', 'interval', 'user_code']);
    assert.match(res.body.device_code, /^[A-Za-z0-9_-]{43}$/);
    assert.match(res.body.user_code, CODE_SHAPE);
    assert.equal(res.body.expires_in, 600);
    assert.equal(res.body.interval, 3);
    const rows = pairingRows();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.device_hash, sha256(res.body.device_code));
    assert.equal(row.user_code, res.body.user_code.replace('-', ''));
    assert.equal(row.label, 'Living room TV');
    assert.equal(row.device, TV_DEVICE);
    assert.equal(row.client_bucket, '10.97.1.2');
    assert.equal(row.created_at, utc(t0));
    assert.equal(row.expires_at, utc(t0 + 10 * MINUTE));
    for (const col of ['user_id', 'approved_by_session', 'approved_from', 'approved_at', 'denied_at', 'last_poll_at']) {
      assert.equal(row[col], null, col);
    }
    // The device code itself is in no column.
    for (const [col, value] of Object.entries(row)) {
      assert.ok(!String(value).includes(res.body.device_code), `tv_pairings.${col} holds the device code`);
    }
    // Two starts never share a code.
    const other = await started();
    assert.notEqual(other.device_code, res.body.device_code);
    assert.notEqual(other.user_code, res.body.user_code);
  });

  test('a label is optional; one that is not text is a 400 and starts nothing', async () => {
    for (const body of [{}, { label: null }, { label: '  ' }]) {
      const res = await start(body);
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(pairingOf(res.body).label, null);
    }
    const noBody = await api('POST', '/device/start', { headers: { 'x-forwarded-for': nextIp() } });
    assert.equal(noBody.status, 200, JSON.stringify(noBody.body));
    assert.equal(pairingOf(noBody.body).label, null);
    const before = pairingRows().length;
    for (const label of [42, true, ['TV'], { name: 'TV' }]) {
      const res = await start({ label });
      assert.equal(res.status, 400, JSON.stringify(label));
      assert.deepEqual(res.body, { error: 'label must be text.' });
    }
    assert.equal(pairingRows().length, before);
  });

  test('★ a user code another pairing holds is drawn again; ten taken draws in a row fail and store nothing', async () => {
    const first = await started();
    const taken = normaliseUserCode(first.user_code);
    const draws = [taken, taken, 'MNPQRSTV'];
    setUserCodeSourceForTest(() => draws.shift());
    const second = await started();
    assert.equal(second.user_code, 'MNPQ-RSTV');
    assert.equal(draws.length, 0);
    assert.equal(pairingOf(first).user_code, taken, 'the first pairing was changed');
    setUserCodeSourceForTest(() => taken);
    const stuck = await start();
    assert.equal(stuck.status, 500);
    assert.equal(pairingRows().length, 2);
  });

  test('★ every start first deletes the expired and the denied pairings; live ones stay', async () => {
    const now = Date.now();
    const expired = plantPairing({ createdMs: now - 11 * MINUTE });
    const expiredApproved = plantPairing({ createdMs: now - 11 * MINUTE, approvedBy: { userId: 'u-carer', sid: carerPhone.sid } });
    const denied = plantPairing({ createdMs: now - MINUTE, deniedMs: now - 30_000 });
    const live = plantPairing({ createdMs: now - MINUTE });
    const liveApproved = plantPairing({ createdMs: now - MINUTE, approvedBy: { userId: 'u-carer', sid: carerPhone.sid } });
    await started();
    assert.equal(exists(expired), false, 'an expired pairing outlived a start');
    assert.equal(exists(expiredApproved), false, 'an expired approved pairing outlived a start');
    assert.equal(exists(denied), false, 'a denied pairing outlived a start');
    assert.ok(exists(live) && exists(liveApproved), 'a start deleted a live pairing');
    // The daily backstop deletes the same rows and nothing else.
    const again = plantPairing({ createdMs: now - 11 * MINUTE });
    assert.equal(purgeTvPairings(), 1);
    assert.equal(exists(again), false);
    assert.ok(exists(live));
  });

  test('index.js pin: the pairing purge also runs at start and daily', () => {
    // index.js boots the app and cannot be imported, so this reads its source (on tokens, not exact text).
    const raw = fs.readFileSync(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
    const code = stripCommentsAndStrings(raw);
    assert.match(raw, /import \{[^}]*\bpurgeTvPairings\b[^}]*\} from '\.\/routes\/auth\.js';/);
    assert.match(code, /^purgeTvPairings\(\);\r?$/m, 'the pairing purge no longer runs at start');
    assert.match(code, /safeInterval\('', 24 \* 60 \* 60 \* 1000, purgeTvPairings\)/, 'the pairing purge is no longer daily');
  });
});

describe('★ #1237 pairing: the caps on live pairings', () => {
  test('★ a fourth start from one bucket evicts that bucket\'s oldest UNAPPROVED pairing, and nothing in another bucket', async () => {
    const t0 = freezeClock();
    // The other bucket's pairing is the OLDEST unapproved one of all (review of PR 1b): an eviction that forgot the
    // bucket would take it, so this case can tell "this bucket's oldest" from "anybody's oldest".
    const elsewhere = await started({ label: 'Elsewhere' }, { ip: '10.97.2.2' });
    mock.timers.tick(1000);
    const tvs = [];
    for (let i = 0; i < 3; i++) {
      tvs.push(await started({ label: `TV ${i}` }, { ip: '10.97.2.1' }));
      mock.timers.tick(1000);
    }
    await approved(carerPhone, tvs[0]); // the bucket's oldest is approved, so it is passed over
    mock.timers.setTime(t0 + 5000);
    const fourth = await started({ label: 'TV 3' }, { ip: '10.97.2.1' });
    assert.ok(pairingOf(tvs[0]), 'an APPROVED pairing was evicted');
    assert.equal(pairingOf(tvs[1]), undefined, 'the oldest unapproved pairing of the bucket was not evicted');
    assert.ok(pairingOf(tvs[2]) && pairingOf(fourth), 'the wrong pairing was evicted');
    assert.ok(pairingOf(elsewhere), "a start evicted another bucket's pairing");
    assert.equal(pairingRows().filter((r) => r.client_bucket === '10.97.2.1').length, 3);
    // The evicted TV is told its pairing is over (and starts again); the approved one is still collected.
    assert.deepEqual((await poll(tvs[1].device_code)).body, EXPIRED);
    assert.equal((await poll(tvs[0].device_code)).body.status, 'approved');
  });

  test('★ a TV that reloads three times in ten minutes can still start, and its newest code works', async () => {
    freezeClock();
    const reloads = [];
    for (let i = 0; i < 4; i++) {
      reloads.push(await started({ label: 'Living room TV' }, { ip: '10.97.3.1' }));
      mock.timers.tick(2 * MINUTE);
    }
    assert.equal(pairingRows().length, 3);
    assert.deepEqual((await poll(reloads[0].device_code)).body, EXPIRED);
    const newest = reloads[3];
    assert.deepEqual((await poll(newest.device_code)).body, PENDING);
    await approved(carerPhone, newest);
    assert.equal((await poll(newest.device_code)).body.status, 'approved');
  });

  test('a bucket whose three live pairings are all approved refuses a fourth start (429 pair_busy) and evicts nothing', async () => {
    const approvedBy = { userId: 'u-carer', sid: carerPhone.sid };
    const held = [1, 2, 3].map(() => plantPairing({ bucket: '10.97.4.1', approvedBy }));
    const res = await start(undefined, { ip: '10.97.4.1' });
    assert.equal(res.status, 429, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: 'pair_busy' });
    assert.ok(held.every(exists));
    assert.equal(pairingRows().length, 3);
  });

  test('only LIVE pairings count toward the bucket cap: expired and denied ones hold no slot', async () => {
    const now = Date.now();
    const bucket = '10.97.5.1';
    for (let i = 0; i < 2; i++) plantPairing({ bucket, createdMs: now - 11 * MINUTE });
    for (let i = 0; i < 2; i++) plantPairing({ bucket, deniedMs: now });
    const live = [plantPairing({ bucket }), plantPairing({ bucket })];
    await started(undefined, { ip: bucket });
    assert.ok(live.every(exists), 'a live pairing was evicted although the bucket held only two live ones');
    assert.equal(pairingRows().filter((r) => r.client_bucket === bucket).length, 3);
  });

  test('★ at 20 live pairings a start takes the oldest unapproved pairing of the FULLEST bucket, never an approved one', async () => {
    const t0 = freezeClock();
    const at = (s) => t0 - 9 * MINUTE + s * 1000;
    const approvedBy = { userId: 'u-carer', sid: carerPhone.sid };
    // The oldest row of all is in a bucket with ONE row: "oldest" alone would take it.
    const lonely = plantPairing({ bucket: 'lonely', createdMs: at(0) });
    const full = [];
    for (let b = 0; b < 6; b++) {
      for (let j = 0; j < 3; j++) {
        // The very first row of the full buckets is approved: it must be passed over.
        full.push(plantPairing({ bucket: `full-${b}`, createdMs: at(10 + b * 3 + j), approvedBy: b === 0 && j === 0 ? approvedBy : null }));
      }
    }
    const pair = plantPairing({ bucket: 'pair', createdMs: at(1) });
    assert.equal(pairingRows().length, 20);
    const fresh = await started(undefined, { ip: '10.97.6.1' });
    assert.ok(pairingOf(fresh));
    assert.equal(exists(full[1]), false, 'the oldest unapproved pairing of the fullest buckets was not the one taken');
    assert.ok(exists(full[0]), 'an approved pairing was evicted');
    assert.ok(exists(lonely) && exists(pair), 'a pairing of a less full bucket was taken');
    assert.equal(full.filter(exists).length, 17);
    assert.equal(pairingRows().length, 20);
  });

  test('★ below 20 live pairings a start from a new bucket evicts nothing: 19 waiting, the 20th fits', async () => {
    // Every bucket is under its own cap of 3, so only the global cap could evict here, and it must not until 20.
    const held = [];
    for (let i = 0; i < 19; i++) held.push(plantPairing({ bucket: `under-${i % 10}` }));
    const fresh = await started(undefined, { ip: '10.97.6.2' });
    assert.ok(pairingOf(fresh));
    assert.deepEqual(held.filter((p) => !exists(p)).map((p) => p.id), [], 'a start under the global cap evicted a pairing');
    assert.equal(pairingRows().length, 20);
  });

  test('at 20 live pairings with nothing to evict (all approved), a start is refused with 429 pair_busy', async () => {
    const approvedBy = { userId: 'u-carer', sid: carerPhone.sid };
    for (let i = 0; i < 20; i++) plantPairing({ bucket: `held-${i % 7}`, approvedBy });
    const res = await start();
    assert.equal(res.status, 429, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: 'pair_busy' });
    assert.equal(pairingRows().length, 20);
  });
});

// ---- poll ----------------------------------------------------------------------------------------------------------------

describe('★ #1237 pairing: POST /device/poll', () => {
  test('★ always HTTP 200, and one `expired` for an unknown, malformed, expired or already collected code', async () => {
    freezeClock();
    const unknown = newDeviceCode();
    for (const deviceCode of [unknown, 'short', unknown.slice(1), `${unknown}A`, 42, null, ['x'], { a: 1 }, undefined]) {
      const res = await poll(deviceCode);
      assert.equal(res.status, 200, JSON.stringify(deviceCode));
      assert.deepEqual(res.body, EXPIRED, JSON.stringify(deviceCode));
    }
    const noBody = await api('POST', '/device/poll', {});
    assert.equal(noBody.status, 200);
    assert.deepEqual(noBody.body, EXPIRED);
    const old = await started();
    mock.timers.tick(10 * MINUTE);
    assert.deepEqual((await poll(old.device_code)).body, EXPIRED, 'an expired pairing');
    const collected = await started();
    await approved(carerPhone, collected);
    assert.equal((await poll(collected.device_code)).status, 200);
    const again = await poll(collected.device_code);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, EXPIRED, 'a collected pairing');
  });

  test('★ slow_down: a poll under 2 s after the previous one for the same pairing, kept in the row; at 2 s it is pending again', async () => {
    const t0 = freezeClock();
    const tv = await started();
    const other = await started();
    assert.deepEqual((await poll(tv.device_code)).body, PENDING);
    assert.equal(pairingOf(tv).last_poll_at, t0, 'the poll is not recorded in the row');
    // Another TV's state is its own: its first poll is pending although this one just polled.
    assert.deepEqual((await poll(other.device_code)).body, PENDING);
    mock.timers.tick(1999);
    assert.deepEqual((await poll(tv.device_code)).body, SLOW_DOWN);
    assert.equal(pairingOf(tv).last_poll_at, t0 + 1999, 'a slow_down poll is not recorded, so a TV polling too fast is never told again');
    mock.timers.tick(2000);
    assert.deepEqual((await poll(tv.device_code)).body, PENDING);
    // A code that names no pairing leaves nothing behind.
    const before = JSON.stringify(pairingRows());
    await poll(newDeviceCode());
    assert.equal(JSON.stringify(pairingRows()), before);
  });

  test('a clock moved back between two polls is not "too fast"', async () => {
    const t0 = freezeClock();
    const tv = await started();
    assert.deepEqual((await poll(tv.device_code)).body, PENDING);
    mock.timers.setTime(t0 - MINUTE);
    assert.deepEqual((await poll(tv.device_code)).body, PENDING);
  });

  test('★ approved: the approver\'s TV session, in the /login shape with the EFFECTIVE role caregiver and kind tv; the pairing is gone', async () => {
    const tv = await started({ label: 'Living room TV' });
    await approved(adminPhone, tv); // an ADMIN approves
    const res = await poll(tv.device_code);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'approved');
    assert.deepEqual(Object.keys(res.body).sort(), ['status', 'token', 'user']);
    assert.deepEqual(Object.keys(res.body.user).sort(), [...PUBLIC_USER_KEYS, 'kind'].sort());
    assert.equal(res.body.user.id, 'u-admin');
    assert.equal(res.body.user.role, 'caregiver', "an admin's TV was told it is an admin");
    assert.equal(res.body.user.kind, 'tv');
    const claim = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString());
    assert.equal(claim.role, 'caregiver');
    assert.equal(claim.id, 'u-admin');
    const session = sessionRow(claim.sid);
    assert.equal(session.kind, 'tv');
    assert.equal(session.user_id, 'u-admin');
    assert.equal(session.label, 'Living room TV');
    assert.equal(session.paired_by_session, adminPhone.sid);
    assert.equal(session.paired_from, PHONE_DEVICE);
    assert.equal(session.user_agent, TV_UA);
    assert.equal(pairingOf(tv), undefined, 'the collected pairing is still in the table');
    // The token is a working TV sign-in, and only that.
    const me = await api('GET', '/me', { token: res.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.role, 'caregiver');
    assert.equal(me.body.kind, 'tv');
    const sessions = await api('GET', '/sessions', { token: res.body.token });
    assert.equal(sessions.status, 403);
    assert.equal(sessions.body.code, 'TV_SESSION_RESTRICTED');
  });

  test('★ single use, by sequential replay: the same device code again gets `expired` and no second session', async () => {
    const tv = await started();
    await approved(carerPhone, tv);
    assert.equal((await poll(tv.device_code)).body.status, 'approved');
    for (let i = 0; i < 3; i++) {
      const replay = await poll(tv.device_code);
      assert.deepEqual(replay.body, EXPIRED);
    }
    assert.equal(tvSessionsOf('u-carer').length, 1, 'a replayed device code made another session');
  });

  test('★ approve and deny exclude each other, and a denied pairing is never collected', async () => {
    const first = await started();
    await approved(carerPhone, first);
    assert.deepEqual((await deny(carerPhone, first.user_code)).body, INVALID, 'an approved pairing was denied');
    assert.equal((await poll(first.device_code)).body.status, 'approved');

    const second = await started();
    assert.equal((await deny(carerPhone, second.user_code)).status, 200);
    assert.deepEqual((await approve(carerPhone, second.user_code)).body, INVALID, 'a denied pairing was approved');
    const told = await poll(second.device_code);
    assert.equal(told.status, 200);
    assert.deepEqual(told.body, DENIED);

    // Hostile: a row both approved and denied (a refused claim leaves one), by a session that is still live. It must
    // never be collected.
    const both = plantPairing({ approvedBy: { userId: 'u-carer', sid: carerPhone.sid }, deniedMs: Date.now() });
    assert.deepEqual((await poll(both.device_code)).body, DENIED);
    assert.equal(tvSessionsOf('u-carer').length, 1, 'a denied pairing made a session');
  });

  test('★ expiry is the JavaScript clock: a second before it a pairing is approved and collected; at it, neither', async () => {
    const t0 = freezeClock();
    const early = await started();
    mock.timers.setTime(t0 + 10 * MINUTE - 1000);
    await approved(carerPhone, early);
    mock.timers.setTime(t0 + 10 * MINUTE - 1);
    assert.equal((await poll(early.device_code)).body.status, 'approved', 'collected a moment before the expiry');

    mock.timers.setTime(t0);
    const late = await started();
    mock.timers.setTime(t0 + 10 * MINUTE);
    assert.deepEqual((await pending(carerPhone, late.user_code)).body, INVALID);
    assert.deepEqual((await approve(carerPhone, late.user_code)).body, INVALID, 'approved at its expiry');
    assert.deepEqual((await poll(late.device_code)).body, EXPIRED);

    mock.timers.setTime(t0);
    const slow = await started();
    mock.timers.setTime(t0 + 5 * MINUTE);
    await approved(carerPhone, slow);
    mock.timers.setTime(t0 + 10 * MINUTE);
    assert.deepEqual((await poll(slow.device_code)).body, EXPIRED, 'an approval was collected at its expiry');
    assert.equal(tvSessionsOf('u-carer').length, 1);
  });

  test('a clock moved back makes an expired pairing live again until the real time passes its expiry (a stated limit)', async () => {
    const t0 = freezeClock();
    const tv = await started();
    await approved(carerPhone, tv);
    mock.timers.setTime(t0 + 11 * MINUTE);
    assert.deepEqual((await poll(tv.device_code)).body, EXPIRED);
    mock.timers.setTime(t0 + MINUTE);
    assert.equal((await poll(tv.device_code)).body.status, 'approved');
  });
});

describe('★ #1237 pairing: the one guarantee at claim', () => {
  // Each case changes the database DIRECTLY and leaves the approving session's row and the pairing in place: the
  // routes that disable or sign out would delete both first, and could not show that the claim itself checks.
  const cases = [
    ['an approver disabled meanwhile', () => db.prepare("UPDATE users SET disabled = 1 WHERE id = 'u-carer'").run(), true],
    ['an approving session that has ended (its row gone)', () => db.prepare('DELETE FROM sessions WHERE id = ?').run(carerPhone.sid), false],
    ['an approving session past its lifetime', () => db.prepare("UPDATE sessions SET created_at = datetime('now', '-31 days') WHERE id = ?").run(carerPhone.sid), true],
    ['an approver that cannot sign in (password_set = 0)', () => db.prepare("UPDATE users SET password_set = 0 WHERE id = 'u-carer'").run(), true],
  ];
  for (const [what, change, sessionStays] of cases) {
    test(`★ ${what} gets the TV nothing: the poll says denied, and the pairing is marked`, async () => {
      const tv = await started();
      await approved(carerPhone, tv);
      change();
      assert.ok(pairingOf(tv), 'precondition: the pairing is still there');
      if (sessionStays) assert.ok(sessionRow(carerPhone.sid), 'precondition: the approving session is still there');
      const res = await poll(tv.device_code);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, DENIED, `${what}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(tvSessionsOf('u-carer'), [], `${what}: a TV session was made`);
      assert.notEqual(pairingOf(tv).denied_at, null, 'the refused pairing is not marked denied');
    });
  }

  test('★ a refused claim answers `denied` at once and stays denied; the next start clears it', async () => {
    const tv = await started();
    await approved(carerPhone, tv);
    // An unrelated approved pairing, with a device code of its own, by a session that stays live: the refusal must mark
    // only the pairing it refused (review of PR 1b).
    const other = await started();
    await approved(adminPhone, other);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(carerPhone.sid);
    assert.deepEqual((await poll(tv.device_code)).body, DENIED);
    assert.equal(pairingOf(other).denied_at, null, 'a refused claim marked another pairing denied');
    assert.deepEqual((await poll(tv.device_code)).body, DENIED, 'a refused pairing went back to something else');
    const row = pairingOf(tv);
    assert.notEqual(row.approved_at, null, 'the refused claim was not rolled back');
    assert.equal((await poll(other.device_code)).body.status, 'approved', 'the unrelated pairing can no longer be collected');
    await started();
    assert.equal(pairingOf(tv), undefined);
    assert.deepEqual((await poll(tv.device_code)).body, EXPIRED);
  });

  test('★ a sign-out, a revoke, a password change or an admin\'s reset made from ANOTHER session cancel an approval', async () => {
    const paths = {
      'a sign-out of the approving session': (s) => api('POST', '/logout', { token: s.token }),
      'a revoke from another session': (s) => api('DELETE', `/sessions/${s.sid}`, { token: userSession('u-carer').token }),
      'a password change from another session': () => api('PUT', '/me/password', {
        token: userSession('u-carer').token, body: { current_password: CARER_PW, new_password: 'carer-password-2' },
      }),
      "an admin's reset": () => api('PUT', '/users/u-carer', { token: adminPhone.token, body: { password: 'reset-by-admin-1' } }),
    };
    for (const [what, act] of Object.entries(paths)) {
      const phone = userSession('u-carer');
      const tv = await started();
      await approved(phone, tv);
      const done = await act(phone);
      assert.ok(done.status < 300, `${what}: ${done.status} ${JSON.stringify(done.body)}`);
      assert.equal(sessionRow(phone.sid), undefined, `${what}: precondition, the approving session ended`);
      assert.deepEqual((await poll(tv.device_code)).body, DENIED, `${what} did not cancel the approval`);
    }
    assert.deepEqual(tvSessionsOf('u-carer'), []);
  });

  test('★ the stated exception: a password change made FROM the approving session keeps it, and so its approval', async () => {
    const tv = await started();
    await approved(carerPhone, tv);
    const changed = await api('PUT', '/me/password', { token: carerPhone.token, body: { current_password: CARER_PW, new_password: 'carer-password-2' } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal((await poll(tv.device_code)).body.status, 'approved');

    const adminTv = await started();
    await approved(adminPhone, adminTv);
    const reset = await api('PUT', '/users/u-admin', { token: adminPhone.token, body: { password: 'admin-password-2' } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal((await poll(adminTv.device_code)).body.status, 'approved');
  });

  test('★ revoking the session that approved ends the TV a real pairing made; a plain sign-out of it does not', async () => {
    const pairTv = async (phone) => {
      const tv = await started();
      await approved(phone, tv);
      const res = await poll(tv.device_code);
      assert.equal(res.body.status, 'approved');
      return res.body.token;
    };
    const phone = userSession('u-carer');
    const tvToken = await pairTv(phone);
    assert.equal((await api('DELETE', `/sessions/${phone.sid}`, { token: phone.token })).status, 204);
    assert.equal((await api('GET', '/me', { token: tvToken })).status, 401, 'the TV outlived a revoke of the session that paired it');

    const phone2 = userSession('u-carer');
    const tvToken2 = await pairTv(phone2);
    assert.equal((await api('POST', '/logout', { token: phone2.token })).status, 204);
    assert.equal((await api('GET', '/me', { token: tvToken2 })).status, 200, "signing the phone out switched the TV off");
  });
});

describe('★ #1237 pairing: the cap of 5 live TV sessions per account', () => {
  test('★ at 5, approve answers 409 tv_limit and the pairing stays pending; a TV session past its lifetime holds no slot', async () => {
    const tvs = [1, 2, 3, 4, 5].map(() => handMadeTv('u-carer'));
    const tv = await started();
    const refused = await approve(carerPhone, tv.user_code);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: 'tv_limit' });
    assert.equal(pairingOf(tv).approved_at, null, 'a refused approve was written');
    assert.equal((await pending(carerPhone, tv.user_code)).status, 200, 'the pairing is no longer pending');
    // Ordinary sessions and another account's TVs do not count; one of the five aged past the lifetime frees a slot.
    handMadeTv('u-admin');
    db.prepare("UPDATE sessions SET created_at = datetime('now', '-31 days') WHERE id = ?").run(tvs[0].sid);
    await approved(carerPhone, tv);
  });

  test('★ approvals not yet collected count too: one account approves 5 pairings, the 6th is 409 tv_limit, no TV session made', async () => {
    // Review of PR 1b (Opus P2): approving is free and an approved pairing is never evicted, so counting TV sessions
    // alone let one account approve its way into every waiting slot.
    const tvs = [];
    for (let i = 0; i < 6; i++) tvs.push(await started());
    for (let i = 0; i < 5; i++) await approved(carerPhone, tvs[i]);
    const sixth = await approve(carerPhone, tvs[5].user_code);
    assert.equal(sixth.status, 409, JSON.stringify(sixth.body));
    assert.deepEqual(sixth.body, { error: 'tv_limit' });
    assert.equal(pairingOf(tvs[5]).approved_at, null, 'the refused approve was written');
    assert.deepEqual(tvSessionsOf('u-carer'), [], 'a TV session was made');
    // Collecting one turns an approval into a TV session: the account still holds five.
    assert.equal((await poll(tvs[0].device_code)).body.status, 'approved');
    assert.equal((await approve(carerPhone, tvs[5].user_code)).status, 409);
    // Another account's budget is its own.
    await approved(adminPhone, tvs[5]);
  });

  test('★ the claim checks it again: a TV signed in by password after two approvals, the first collected, the second denied', async () => {
    // Three TVs, then two approvals (3 + 1 already approved = 4 at the second one, under the cap). A fourth TV signs in
    // by password before either pairing is collected (a password sign-in is never refused by the cap), so by the claims
    // the account holds 4: the first claim makes the 5th TV session, the second must be refused.
    for (let i = 0; i < 3; i++) handMadeTv('u-carer');
    const a = await started();
    const b = await started();
    await approved(carerPhone, a);
    await approved(carerPhone, b);
    handMadeTv('u-carer');
    assert.equal((await poll(a.device_code)).body.status, 'approved');
    assert.deepEqual((await poll(b.device_code)).body, DENIED);
    assert.equal(tvSessionsOf('u-carer').length, 5);
  });
});

// ---- pending, approve, deny --------------------------------------------------------------------------------------

describe('★ #1237 pairing: pending, approve, deny', () => {
  test('★ pending shows the label, the TV\'s device string and when it asked, and nothing else, for any spelling of the code', async () => {
    const tv = await started({ label: 'Living room TV' });
    const row = pairingOf(tv);
    const code = tv.user_code;
    for (const typed of [code, code.toLowerCase(), code.replace('-', ''), ` ${code.replace('-', ' ')} `, code.replace('-', '\u2013')]) {
      const res = await pending(carerPhone, typed);
      assert.equal(res.status, 200, `${JSON.stringify(typed)}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body, { label: 'Living room TV', device: TV_DEVICE, created_at: row.created_at });
    }
  });

  test('★ one 404 pair_invalid for every code that names nothing answerable, on all three routes', async () => {
    const now = Date.now();
    const used = await started();
    await approved(carerPhone, used);
    await poll(used.device_code);
    const approvedOne = await started();
    await approved(carerPhone, approvedOne);
    const deniedOne = await started();
    await deny(carerPhone, deniedOne.user_code);
    const expired = plantPairing({ createdMs: now - 11 * MINUTE });
    const codes = {
      unknown: displayUserCode(['BCDFGHJK', 'CDFGHJKM'].find((c) => !db.prepare('SELECT 1 FROM tv_pairings WHERE user_code = ?').get(c))),
      collected: used.user_code,
      approved: approvedOne.user_code,
      denied: deniedOne.user_code,
      expired: expired.user_code,
      'too short': 'BCDF-GHJ',
      'not the alphabet': 'ABCD-EFGH',
      empty: '',
      'a number': 12345678,
      'not given': undefined,
    };
    for (const [what, code] of Object.entries(codes)) {
      for (const [route, fn] of [['pending', pending], ['approve', approve], ['deny', deny]]) {
        resetTvPairingLimits(); // this case is about the answer, not the limit
        const res = await fn(carerPhone, code);
        assert.equal(res.status, 404, `${route} ${what}: ${res.status} ${JSON.stringify(res.body)}`);
        assert.deepEqual(res.body, INVALID, `${route} ${what}`);
      }
    }
    assert.equal(pairingOf(approvedOne).approved_by_session, carerPhone.sid, 'a refused approve changed an approved pairing');
    assert.equal(pairingOf(deniedOne).approved_at, null);
  });

  test('★ approve records the approver, the approving session and the device it was approved from', async () => {
    const t0 = freezeClock();
    const tv = await started();
    const res = await approve(carerPhone, tv.user_code.toLowerCase(), PHONE_UA);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { ok: true });
    const row = pairingOf(tv);
    assert.equal(row.user_id, 'u-carer');
    assert.equal(row.approved_by_session, carerPhone.sid);
    assert.equal(row.approved_from, PHONE_DEVICE);
    assert.equal(row.approved_at, utc(t0));
    assert.equal(row.denied_at, null);
  });

  test('★ a TV session is refused all three (403 TV_SESSION_RESTRICTED), and the pairing is untouched', async () => {
    const tvSession = handMadeTv('u-admin');
    const tv = await started();
    const before = pairingOf(tv);
    for (const fn of [pending, approve, deny]) {
      const res = await fn(tvSession, tv.user_code);
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.code, 'TV_SESSION_RESTRICTED');
    }
    assert.deepEqual(pairingOf(tv), before);
  });

  test('★ 20 wrong codes per 15 minutes per user, across the three routes; a right code costs nothing; another user is not affected', async () => {
    const tv = await started();
    for (let i = 0; i < 25; i++) assert.equal((await pending(carerPhone, tv.user_code)).status, 200, `right code ${i}`);
    const wrong = 'BCDF-GHJK' === tv.user_code ? 'CDFG-HJKM' : 'BCDF-GHJK';
    const routes = [pending, approve, deny];
    for (let i = 0; i < 20; i++) {
      const res = await routes[i % 3](carerPhone, wrong);
      assert.equal(res.status, 404, `wrong code ${i}: ${res.status}`);
    }
    const blocked = await pending(carerPhone, tv.user_code);
    assert.equal(blocked.status, 429, 'the 21st attempt was not refused');
    assert.deepEqual(blocked.body, TOO_MANY);
    assert.equal((await approve(carerPhone, tv.user_code)).status, 429, 'approve does not share the budget of pending');
    // Another account has its own budget, and the code still works for it.
    assert.equal((await pending(adminPhone, tv.user_code)).status, 200);
  });

  test('★ the audit lines: approve and claim each write one, with the approver, the TV and where from; never the device code or the token', async () => {
    const tv = await started({ label: 'Living room TV' });
    const pairingId = pairingOf(tv).id;
    await approved(carerPhone, tv);
    const res = await poll(tv.device_code);
    const sid = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString()).sid;
    // Found by the pairing's id, not by position: the buffer is a ring of the last 1000 lines.
    const lines = logger.getRecent().filter((l) => l.includes('[tv-pair]') && l.includes(pairingId));
    const approveLine = lines.find((l) => l.includes('approved by'));
    const claimLine = lines.find((l) => l.includes('signed in as'));
    assert.ok(approveLine, `no approve line in ${JSON.stringify(lines)}`);
    for (const part of ['"carer"', PHONE_DEVICE, '"Living room TV"', TV_DEVICE]) assert.ok(approveLine.includes(part), `the approve line lacks ${part}: ${approveLine}`);
    assert.ok(claimLine, `no claim line in ${JSON.stringify(lines)}`);
    for (const part of ['"carer"', sid, `approved from ${PHONE_DEVICE}`, '"Living room TV"']) assert.ok(claimLine.includes(part), `the claim line lacks ${part}: ${claimLine}`);
    assert.equal(lines.length, 2, `one line at approve and one at claim: ${JSON.stringify(lines)}`);
    const all = logger.getRecent().join('\n');
    for (const secret of [tv.device_code, sha256(tv.device_code), res.body.token]) {
      assert.ok(!all.includes(secret), 'a secret reached the log');
    }
  });
});

// ---- a TV's password sign-in --------------------------------------------------------------------------------------

describe('★ #1237 pairing: a TV\'s password sign-in (`tv: true` on /login)', () => {
  test('★ /login with tv: true makes a TV session: kind tv, its label, the effective role caregiver, the allowlist', async () => {
    const res = await login({ username: 'admin', password: ADMIN_PW, tv: true, label: 'Bedroom\nTV' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body.user).sort(), [...PUBLIC_USER_KEYS, 'kind'].sort());
    assert.equal(res.body.user.role, 'caregiver');
    assert.equal(res.body.user.kind, 'tv');
    const sid = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString()).sid;
    const row = sessionRow(sid);
    assert.equal(row.kind, 'tv');
    assert.equal(row.label, 'Bedroom TV');
    assert.equal(row.paired_by_session, null);
    assert.equal((await api('GET', '/me', { token: res.body.token })).body.kind, 'tv');
    assert.equal((await api('GET', '/users', { token: res.body.token })).body.code, 'TV_SESSION_RESTRICTED');
    // The control: the same sign-in without the flag is the ordinary one it always was.
    const plain = await login({ username: 'admin', password: ADMIN_PW, label: 'ignored' });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.user.role, 'admin');
    assert.equal('kind' in plain.body.user, false);
    for (const tv of [false, null]) {
      const off = await login({ username: 'admin', password: ADMIN_PW, tv });
      assert.equal(off.status, 200);
      assert.equal(off.body.user.role, 'admin', `tv: ${tv}`);
    }
    assert.equal(tvSessionsOf('u-admin').length, 1);
  });

  test('★ with two-factor on, the flag rides in the MFA token: the second step makes the TV session, and its body cannot change that', async () => {
    const secret = generateSecret();
    db.prepare("UPDATE users SET mfa_enabled = 1, mfa_secret = ? WHERE id = 'u-carer'").run(secret);
    const mfaStep = (mfaToken, body = {}) => {
      db.prepare("UPDATE users SET mfa_last_step = NULL WHERE id = 'u-carer'").run(); // one code, two sign-ins
      return api('POST', '/login/mfa', {
        body: { mfaToken, code: generateSync({ secret }), ...body },
        headers: { 'x-forwarded-for': nextIp(), 'user-agent': TV_UA },
      });
    };
    const first = await login({ username: 'carer', password: CARER_PW, tv: true, label: 'Kitchen TV' });
    assert.equal(first.body.mfaRequired, true, JSON.stringify(first.body));
    const second = await mfaStep(first.body.mfaToken, { tv: false, label: 'Something else' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.user.kind, 'tv', 'the second step turned a TV sign-in into an ordinary one');
    assert.equal(second.body.user.role, 'caregiver');
    const sid = JSON.parse(Buffer.from(second.body.token.split('.')[1], 'base64url').toString()).sid;
    assert.equal(sessionRow(sid).kind, 'tv');
    assert.equal(sessionRow(sid).label, 'Kitchen TV', 'the label came from the second step, not the first');
    // The other way round: an ordinary first step stays ordinary, whatever the second step's body says.
    const plain = await login({ username: 'carer', password: CARER_PW });
    const plainSecond = await mfaStep(plain.body.mfaToken, { tv: true });
    assert.equal(plainSecond.status, 200, JSON.stringify(plainSecond.body));
    assert.equal('kind' in plainSecond.body.user, false);
    assert.equal(tvSessionsOf('u-carer').length, 1);
  });

  test('the flag is the boolean only, and the label text: anything else is a 400 before the password is checked, and no session', async () => {
    const stats = () => passwordHash.passwordWorkerStats().submitted;
    const before = stats();
    for (const tv of ['true', 1, {}, ['x']]) {
      const res = await login({ username: 'admin', password: ADMIN_PW, tv });
      assert.equal(res.status, 400, JSON.stringify(tv));
      assert.deepEqual(res.body, { error: 'tv must be true or false.' });
    }
    const badLabel = await login({ username: 'admin', password: ADMIN_PW, tv: true, label: 7 });
    assert.equal(badLabel.status, 400);
    assert.deepEqual(badLabel.body, { error: 'label must be text.' });
    assert.equal(stats(), before, 'a malformed request cost a password compare');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'u-admin'").get().n, 1, 'a session was made');
  });
});

// ---- disabling or removing the approver --------------------------------------------------------------------------

describe('★ #1237 pairing: disabling or removing the approver', () => {
  test('★ disabling an account deletes the pairings it approved, and no one else\'s', async () => {
    const carers = await started();
    await approved(carerPhone, carers);
    const admins = await started();
    await approved(adminPhone, admins);
    const open = await started();
    const res = await api('PUT', '/users/u-carer/disabled', { token: adminPhone.token, body: { disabled: true } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(pairingOf(carers), undefined, "the disabled account's approved pairing survived");
    assert.ok(pairingOf(admins) && pairingOf(open), "disabling one account deleted another's pairing");
    assert.deepEqual((await poll(carers.device_code)).body, EXPIRED);
  });

  test('★ removing an account removes the pairings it approved (the foreign key cascades)', async () => {
    const carers = await started();
    await approved(carerPhone, carers);
    const admins = await started();
    await approved(adminPhone, admins);
    const res = await api('DELETE', '/users/u-carer', { token: adminPhone.token });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(pairingOf(carers), undefined);
    assert.ok(pairingOf(admins));
  });
});

// ---- the limits on the public routes --------------------------------------------------------------------------------

describe('★ #1237 pairing: the limits on start and poll', () => {
  test('start: 30 per 15 minutes per source address, its own budget (another address, the poll and sign-in are not affected)', async () => {
    const ip = '10.97.9.1';
    for (let i = 0; i < 30; i++) assert.equal((await start(undefined, { ip })).status, 200, `start ${i}`);
    const blocked = await start(undefined, { ip });
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, TOO_MANY);
    assert.equal((await start(undefined, { ip: '10.97.9.2' })).status, 200);
    assert.equal((await poll(newDeviceCode(), { ip })).status, 200);
    const signIn = await api('POST', '/login', { body: { username: 'carer', password: CARER_PW }, headers: { 'x-forwarded-for': ip } });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
  });

  test('poll: 600 per 10 minutes per source address; the limiter\'s 429 is the only error it answers', async () => {
    const ip = '10.97.9.3';
    const code = newDeviceCode();
    for (let i = 0; i < 600; i++) {
      const res = await poll(code, { ip });
      if (res.status !== 200) assert.fail(`poll ${i}: ${res.status}`);
    }
    const blocked = await poll(code, { ip });
    assert.equal(blocked.status, 429);
    assert.deepEqual(blocked.body, TOO_MANY);
    assert.equal((await poll(code, { ip: '10.97.9.4' })).status, 200);
  });
});
