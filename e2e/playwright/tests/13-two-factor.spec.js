const { test, expect } = require('@playwright/test');
const { totp } = require('./totp');

// Two-factor: enrolling through the real screen, then signing in with it.
//
// ★ WHY THIS LAYER. Signing in with 2FA is a TWO-REQUEST handshake with state carried between them:
// /login answers `{ mfaRequired, mfaToken }` instead of a session, the browser holds that short-lived
// token, and /login/mfa exchanges it plus a code for the real session. `mfa.test.js` proves the
// crypto; nothing proved the handshake. A client that dropped the interim token, or sent it to the
// wrong endpoint, would leave every 2FA account unable to sign in — with the unit suite green.
//
// ★ The spec plays the authenticator app itself, using an INDEPENDENT TOTP implementation (./totp.js,
// checked against the RFC 6238 vectors). Importing otplib here would have the server's answer checked
// against the server's own library, which agrees with itself by construction.
//
// ⚠️ Enrolment happens on a THROWAWAY caregiver, never the admin. The whole suite shares one signed-in
// admin via storageState; putting a second factor on that account would change how every later spec
// would have to authenticate, and a failure mid-file would leave it stranded.
//
// ⚠️⚠️ THE LOGIN BUDGET — read this before adding a test here. ONE `loginLimiter` instance covers
// FIVE routes — `/setup`, `/login`, `/login/mfa`, `/me/password` and `/me/mfa/disable` — at **20
// requests per 15 minutes, keyed by `req.ip`** (routes/auth.js). Every request in the e2e stack
// reaches the app from the one Caddy sidecar, so it all keys as a single client and the whole run
// shares one budget: `01-first-run` spends one on `/setup`, then 08, 09, 11, 12 and 13 spend the
// rest, inside a single 15-minute window. Exceeding it produces a 429 in whichever test happens to
// be last — which looks like a bug in that test and is not one. This file is deliberately economical
// for that reason: assertions that would cost a login are made from `/auth/me/mfa` instead wherever
// they can be. (`/me/mfa/disable` is on the limiter but no spec calls it; enrolment — `/me/mfa/setup`
// and `/me/mfa/enable` — is NOT limited, so those are free.)
// **MEASURED after a full run: 17 of the 20 spent with #246's specs present, 16 without** — read it
// yourself with `ratelimit-remaining` on a /login response made THROUGH the proxy; straight to the
// app's published port is a different bucket and will tell you nothing.
// **If you add a login here, take one out.**
//
// ⚠️ The SHARING is an e2e artifact — but do not read that as "production is fine". The app sets
// `trust proxy: 'loopback'`, so `X-Forwarded-For` is honoured only when the proxy connects over
// loopback. README.md's documented remote-access setup has SWAG reaching Nightlight **by LAN IP, not
// by container name**, which is not loopback — so on that topology every remote user in the household
// shares the same 20 attempts, exactly as they do here. Verified against express's `'loopback'` trust
// function: a proxy at 172.18.0.5 or 192.168.1.100 yields `req.ip` = the proxy; only 127.0.0.1 yields
// the real client. Tracked as its own issue rather than worked around here.
//
// ⚠️ Which is also why there is NO test that the limiter itself engages: proving it would mean
// spending the budget it is protecting, and would 429 everything that ran afterwards. It is covered
// where it belongs — as configuration, in review — not here.

const USER = { username: 'e2e-mfa-kid', password: 'mfa-pw-12345678', first_name: 'Mfa' };

test.describe.configure({ mode: 'serial' });

let token = null;
let userId = null;
let userToken = null;
let secret = null;
let backupCodes = [];

// ⚠️ Visiting '/' NAVIGATES — resolve before opening any screen under test.
async function auth(page) {
  if (!token) {
    await page.goto('/');
    token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ⚠️⚠️ `browser.newContext()` INHERITS THE PROJECT'S `storageState` — the signed-in admin saved by
// 01-first-run. A context opened without saying otherwise arrives ALREADY LOGGED IN, which silently
// turns a test about signing in into a test about nothing. Start from an explicitly EMPTY state.
const EMPTY_STATE = { cookies: [], origins: [] };

const asUser = () => ({ headers: { Authorization: `Bearer ${userToken}` } });

async function userContext(browser) {
  const ctx = await browser.newContext({ storageState: EMPTY_STATE });
  await ctx.addInitScript(([t]) => window.localStorage.setItem('nightlight_token', t), [userToken]);
  return ctx;
}

test('set up an account to enrol', async ({ page }) => {
  const created = await page.request.post('/api/auth/users', {
    ...(await auth(page)),
    data: { ...USER, role: 'caregiver' },
  });
  expect(created.ok(), `creating the user failed: ${created.status()}`).toBeTruthy();
  userId = (await created.json()).id;

  const login = await page.request.post('/api/auth/login', {
    data: { username: USER.username, password: USER.password },
  });
  expect(login.status()).toBe(200);
  const body = await login.json();
  // Before enrolment there is no second step — this is the baseline the next tests change.
  expect(body.mfaRequired, 'an account without 2FA should sign straight in').toBeFalsy();
  userToken = body.token;
});

test('enrolling through the Account screen turns two-factor on', async ({ browser }) => {
  const ctx = await userContext(browser);
  const view = await ctx.newPage();
  await view.goto('/#/account');

  await expect(view.getByText('Two-factor authentication')).toBeVisible();
  await view.getByRole('button', { name: 'Set up two-factor' }).click();

  // The setup dialog shows a QR and the same secret in typeable form. The manual key is what this
  // test reads, for the same reason a person would: it can't scan a QR code.
  await expect(view.getByRole('img', { name: 'Two-factor setup QR code' })).toBeVisible();
  const manualKey = await view.locator('.field', { hasText: 'Manual key' }).locator('div').last().innerText();
  secret = manualKey.trim();
  expect(secret, 'a base32 secret should be shown to type in by hand').toMatch(/^[A-Z2-7]{16,}$/);

  await view.getByLabel('Enter the 6-digit code to confirm').fill(totp(secret));
  await view.getByRole('button', { name: 'Turn on' }).click();

  // Backup codes are shown exactly once, here, because only their hashes are kept.
  await expect(view.getByRole('button', { name: "I've saved them" })).toBeVisible();
  const codeText = await view.locator('.modal-card').innerText();
  backupCodes = codeText.match(/\b[a-z0-9]{4,}-[a-z0-9]{4,}\b/gi) || [];
  expect(backupCodes.length, 'a set of one-time backup codes should be shown').toBeGreaterThan(0);
  await view.getByRole('button', { name: "I've saved them" }).click();

  // The card now reports the factor as on. Asserted via the backup-code count rather than the literal
  // "On", which is two characters and could match almost anything else on a settings page.
  await expect(view.getByText(/\d+ backup codes? left/)).toBeVisible();
  await ctx.close();
});

test('an enrolled account cannot start a second enrolment', async ({ page }) => {
  // Re-enrolling silently would replace a working secret with a pending one the user hasn't scanned
  // yet, so the factor has to be turned off deliberately first.
  const res = await page.request.post('/api/auth/me/mfa/setup', asUser());
  expect(res.status(), 'starting a second enrolment on an enrolled account must be refused').toBe(400);
  expect((await res.json()).error).toMatch(/already on/i);
});

test('★ signing in now takes two steps, through the real form', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: EMPTY_STATE });
  const view = await ctx.newPage();
  await view.goto('/');

  await view.getByLabel('Username').fill(USER.username);
  await view.getByLabel('Password').fill(USER.password);
  await view.getByRole('button', { name: 'Sign in' }).click();

  // The password alone must NOT produce a session — the whole point of the second factor.
  await expect(view.getByLabel('Verification code')).toBeVisible();
  expect(
    await view.evaluate(() => localStorage.getItem('nightlight_token')),
    'no session token may be stored until the second factor is satisfied'
  ).toBeFalsy();

  // A wrong code is refused and leaves them on the second step, not signed in and not thrown back.
  await view.getByLabel('Verification code').fill('000000');
  await view.getByRole('button', { name: 'Verify' }).click();
  await expect(view.getByText('Incorrect code')).toBeVisible();
  expect(await view.evaluate(() => localStorage.getItem('nightlight_token'))).toBeFalsy();

  // The real code completes the handshake.
  await view.getByLabel('Verification code').fill(totp(secret));
  await view.getByRole('button', { name: 'Verify' }).click();
  await expect(view.getByRole('link', { name: 'Live' }), 'the second factor should complete the sign-in').toBeVisible();
  expect(await view.evaluate(() => localStorage.getItem('nightlight_token'))).toBeTruthy();
  await ctx.close();
});

test('a backup code works once, and only once — and spends only itself', async ({ page }) => {
  // The lost-phone path. It has to work when the authenticator is gone, and it has to be spent
  // afterwards — a backup code that kept working would be a permanent password bypass sitting in
  // whatever note the user saved it to.
  const code = backupCodes[0];
  expect(code, 'the enrolment step should have captured a backup code').toBeTruthy();
  const before = await (await page.request.get('/api/auth/me/mfa', asUser())).json();

  const start = await page.request.post('/api/auth/login', {
    data: { username: USER.username, password: USER.password },
  });
  const { mfaToken } = await start.json();
  expect(mfaToken).toBeTruthy();

  // ★ Folded in here rather than given its own test, to save two requests of the login budget above:
  // `mfaToken` belongs to a browser that has NOT completed the second step, so if it were accepted as
  // ordinary authentication anywhere, the second factor would be decorative.
  const halfWay = await page.request.get('/api/auth/me', { headers: { Authorization: `Bearer ${mfaToken}` } });
  expect(halfWay.status(), 'the half-way token must not open the API').toBe(401);

  const used = await page.request.post('/api/auth/login/mfa', { data: { mfaToken, code } });
  expect(used.status(), 'a backup code should be accepted in place of the authenticator').toBe(200);

  // Same code, a fresh handshake — must now be worthless.
  const start2 = await page.request.post('/api/auth/login', {
    data: { username: USER.username, password: USER.password },
  });
  const again = await page.request.post('/api/auth/login/mfa', {
    data: { mfaToken: (await start2.json()).mfaToken, code },
  });
  expect(again.status(), 'a spent backup code must not work a second time').toBe(401);

  // EXACTLY one was spent. Asserted from the remaining count rather than by burning a second code on
  // another login — cheaper against the rate limit, and a stronger claim: it rules out an
  // implementation that invalidated the whole set on first use, which "a different code still works"
  // would not have distinguished from one that spent two.
  const after = await (await page.request.get('/api/auth/me/mfa', asUser())).json();
  expect(after.backup_codes_remaining, 'using one backup code must spend exactly one').toBe(
    before.backup_codes_remaining - 1
  );
});

test('an admin can clear two-factor for someone locked out', async ({ page }) => {
  // Lost authenticator AND lost backup codes. Without this the account is unreachable in a
  // self-hosted app with nobody to ring.
  const before = await (await page.request.get('/api/auth/me/mfa', asUser())).json();
  expect(before.enabled, 'the account must START enrolled or this proves nothing').toBe(true);

  const res = await page.request.delete(`/api/auth/users/${userId}/mfa`, await auth(page));
  expect(res.status()).toBe(200);

  // Asserted from the account's own state rather than by signing in again: a login here would cost one
  // of the 20 shared attempts (see the budget note above), and `enabled: false` is the same fact one
  // step earlier — /login branches on exactly this column. The two-step handshake itself is already
  // covered three tests up.
  const after = await (await page.request.get('/api/auth/me/mfa', asUser())).json();
  expect(after.enabled, 'a reset must clear the second factor').toBe(false);
  expect(after.backup_codes_remaining, 'the old backup codes must go with it').toBe(0);
});

test('★ enrolment refuses a code that does not match the pending secret', async ({ page }) => {
  // ★ ADDED AFTER AN ADVERSARIAL REVIEW, which found that `/me/mfa/enable`'s check —
  // `if (!verifyToken(user.mfa_secret, code)) return 400` — was tested by NOTHING in this repo. The
  // enrolment test above supplies a CORRECT code, so it passes whether or not that check exists;
  // delete the check and a stranger who got hold of a signed-in session could switch two-factor on
  // with any six digits, locking the real owner out of their own account.
  //
  // It runs last because it needs an UN-enrolled account, which is what the reset above just produced.
  // Neither /me/mfa/setup nor /me/mfa/enable is rate limited, so this costs nothing from the login
  // budget.
  const setup = await page.request.post('/api/auth/me/mfa/setup', asUser());
  expect(setup.status()).toBe(200);
  const pending = (await setup.json()).secret;
  expect(pending, 'a fresh enrolment should hand back a new secret').toMatch(/^[A-Z2-7]{16,}$/);

  // A wrong code, chosen deterministically rather than at random. The server tolerates ±1 time step
  // of clock drift, so "wrong" has to mean "not the code for the previous, current OR next step" —
  // a random six digits would pass this test ~999999 times in a million and fail the other time.
  const now = Date.now();
  const accepted = [now - 30_000, now, now + 30_000].map((t) => totp(pending, t));
  let wrong = String((Number(accepted[1]) + 1) % 1_000_000).padStart(6, '0');
  while (accepted.includes(wrong)) wrong = String((Number(wrong) + 1) % 1_000_000).padStart(6, '0');

  const refused = await page.request.post('/api/auth/me/mfa/enable', { ...asUser(), data: { code: wrong } });
  expect(refused.status(), 'a code that does not match the pending secret must be refused').toBe(400);
  // ⚠️ Matched around the apostrophe, not through it: the source uses a straight `'` here while most
  // user-facing strings in this app use a typographic `’`, and a regex that assumes either one fails
  // on a message that is perfectly correct.
  expect((await refused.json()).error).toMatch(/code did.{0,3}t match/i);

  // And the refusal left the factor off, rather than half-on.
  const state = await (await page.request.get('/api/auth/me/mfa', asUser())).json();
  expect(state.enabled, 'a refused code must not enable two-factor').toBe(false);

  // The matching code still works, so the check discriminates rather than refusing everything.
  const ok = await page.request.post('/api/auth/me/mfa/enable', {
    ...asUser(),
    data: { code: totp(pending) },
  });
  expect(ok.status(), 'the correct code must still enrol').toBe(200);
});

test.afterAll(async ({ browser }) => {
  if (!token || !userId) return;
  const ctx = await browser.newContext({ storageState: EMPTY_STATE });
  await ctx.request.delete(`/api/auth/users/${userId}`, { headers: { Authorization: `Bearer ${token}` } });
  await ctx.close();
});
