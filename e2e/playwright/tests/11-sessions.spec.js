const { test, expect } = require('@playwright/test');

// Signing in, and signing out — including out from under somebody else.
//
// ★ WHY THIS LAYER. Every request re-checks that the session's row still exists in the database
// (middleware/auth.js), and that design exists for exactly one reason: so "sign out this device" and
// "delete this caregiver" take effect on the NEXT request rather than whenever a 30-day token happens
// to expire. `auth-middleware.test.js` already proves the middleware rejects a token whose row is
// gone. What it cannot prove is the half that makes the feature real: that a browser sitting on the
// dashboard, holding a token that was valid a moment ago, actually notices and ends up back at the
// login screen. That is a client/server seam — the server returns 401, `lib/api.js` has to turn it
// into a redirect — and only a real browser can see both halves at once.
//
// ★ It also covers the ordinary login form, which nothing else did. `01-first-run` drives the
// CREATE-ADMIN path, which is a different form on the same screen; until now no test ever signed in
// with a username and a password.

const CAREGIVER = { username: 'e2e-sessions-kid', password: 'sessions-pw-12345', first_name: 'Sessions' };

test.describe.configure({ mode: 'serial' });

let token = null;
let caregiverId = null;
let caregiverToken = null; // the session the login-form test creates, reused rather than re-bought

// ⚠️ Visiting '/' NAVIGATES. Resolve before opening any screen under test (the trap from 08).
async function auth(page) {
  if (!token) {
    await page.goto('/');
    token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ⚠️⚠️ `browser.newContext()` INHERITS THE PROJECT'S `storageState` — the signed-in admin saved by
// 01-first-run. A context opened without saying otherwise therefore arrives ALREADY LOGGED IN, and a
// test that meant to exercise the login form silently lands on the dashboard instead. Both helpers
// below start from an explicitly EMPTY state for that reason.
const EMPTY_STATE = { cookies: [], origins: [] };

// A browser that has never signed in.
const signedOutContext = (browser) => browser.newContext({ storageState: EMPTY_STATE });

// A browser signed in as somebody specific, with the token in localStorage exactly where the app puts
// it — so it boots signed-in, the way a phone left open on the dashboard would be.
async function signedInContext(browser, jwt) {
  const ctx = await browser.newContext({ storageState: EMPTY_STATE });
  await ctx.addInitScript(([t]) => window.localStorage.setItem('nightlight_token', t), [jwt]);
  return ctx;
}

test('a caregiver can sign in through the login form', async ({ page, browser }) => {
  // Create the account through the API (the UI for that is 12's subject), then use the REAL form.
  const created = await page.request.post('/api/auth/users', {
    ...(await auth(page)),
    data: { ...CAREGIVER, role: 'caregiver' },
  });
  expect(created.ok(), `creating the caregiver failed: ${created.status()}`).toBeTruthy();
  caregiverId = (await created.json()).id;

  const ctx = await signedOutContext(browser);
  const view = await ctx.newPage();
  await view.goto('/');
  await view.getByLabel('Username').fill(CAREGIVER.username);
  await view.getByLabel('Password').fill(CAREGIVER.password);
  await view.getByRole('button', { name: 'Sign in' }).click();

  // Landing on the dashboard is the assertion: the token was issued, stored, and accepted.
  await expect(view.getByRole('link', { name: 'Live' }), 'signing in should land on the app').toBeVisible();
  const stored = await view.evaluate(() => localStorage.getItem('nightlight_token'));
  expect(stored, 'signing in should store a session token').toBeTruthy();
  // Kept for the revocation test below to reuse — a session this test already paid for. See the login
  // budget note in 13-two-factor.spec.js: these three files share 20 login attempts for the whole run.
  caregiverToken = stored;
  await ctx.close();
});

test('the wrong password is refused, and says so without naming the account', async ({ browser }) => {
  const ctx = await signedOutContext(browser);
  const view = await ctx.newPage();
  await view.goto('/');
  await view.getByLabel('Username').fill(CAREGIVER.username);
  await view.getByLabel('Password').fill('not-the-password');
  await view.getByRole('button', { name: 'Sign in' }).click();

  // One message for both "no such user" and "wrong password", deliberately — a different message for
  // each turns the login form into a way to find out which usernames exist.
  await expect(view.getByText('Incorrect username or password')).toBeVisible();
  expect(await view.evaluate(() => localStorage.getItem('nightlight_token'))).toBeFalsy();
  await ctx.close();
});

test('my own sessions are listed, with this device marked', async ({ page }) => {
  await auth(page);
  await page.goto('/#/account');
  await expect(page.getByText('Signed in on')).toBeVisible();
  // The admin is signed in on exactly this browser, and the app has to know WHICH row is the one
  // you're reading it from — that's what makes "sign out this device" mean something different from
  // the rows above it.
  await expect(page.getByText(/\(this device\)/)).toBeVisible();
});

test('changing my password signs my OTHER devices out and keeps this one', async ({ page, browser }) => {
  // Both halves matter and they pull in opposite directions: leaving other sessions alive defeats the
  // point (you change your password precisely because a device is lost), and killing your own would
  // sign you out of the screen you just used. A regression in either direction — dropping the
  // `id != ?` or the `user_id = ?` from the DELETE — breaks exactly one of these two assertions.
  // Two live sessions for the same account. One is the session the login-form test already bought —
  // see the login budget note in 13-two-factor.spec.js — so only the second is paid for here.
  const keepToken = caregiverToken;
  const second = await page.request.post('/api/auth/login', {
    data: { username: CAREGIVER.username, password: CAREGIVER.password },
  });
  const otherToken = (await second.json()).token;
  expect(keepToken, 'the two sessions must really be different ones').not.toBe(otherToken);

  const ctx = await signedInContext(browser, keepToken);
  const view = await ctx.newPage();
  await view.goto('/#/account');
  await view.getByRole('button', { name: 'Change my password' }).click();
  await view.getByLabel('Current password').fill(CAREGIVER.password);
  await view.getByLabel('New password', { exact: true }).fill('sessions-pw-CHANGED');
  await view.getByLabel('Confirm new password').fill('sessions-pw-CHANGED');
  await view.getByRole('button', { name: 'Update password' }).click();

  await expect(view.getByText('Password updated ✓')).toBeVisible();

  // The device that made the change is still signed in...
  const stillMine = await ctx.request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${keepToken}` },
  });
  expect(stillMine.status(), 'the device that changed the password must stay signed in').toBe(200);

  // ...and the other one is not.
  const evicted = await ctx.request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${otherToken}` },
  });
  expect(evicted.status(), 'every OTHER device must be signed out').toBe(401);

  // ★ ...and NOBODY ELSE'S session was touched. Added after an adversarial review pointed out that
  // the two assertions above do not actually pin the `user_id = ?` half of that DELETE: without it,
  // `DELETE FROM sessions WHERE id != ?` still keeps the changer's session and still evicts the other
  // device, so both pass — while quietly signing out every other ACCOUNT in the house. It was caught
  // only as collateral damage in a later test, which reads as an unrelated failure. This is the
  // assertion that fails in place, for the right reason.
  const admin = await page.request.get('/api/auth/me', await auth(page));
  expect(admin.status(), 'one person changing their password must not sign everyone else out').toBe(200);

  // The old password no longer opens the account — which is the evidence the stored hash really
  // changed, rather than the request merely returning 200. (Only this direction is checked, not a
  // fresh login with the NEW password: the login budget is tight, and a password that had failed to
  // change would still be accepted here, so this is the assertion that can actually fail.)
  const oldPw = await ctx.request.post('/api/auth/login', {
    data: { username: CAREGIVER.username, password: CAREGIVER.password },
  });
  expect(oldPw.status(), 'the old password must stop working').toBe(401);

  // `keepToken` survived the change — proved above — so the revocation test below inherits it rather
  // than buying another session.
  caregiverToken = keepToken;
  await ctx.close();
});

test('★ signing a device out ejects the browser that was using it', async ({ page, browser }) => {
  // The assertion this whole file exists for. Nothing about the revoked browser changes until it next
  // speaks to the server — so the test has it speak, and requires it to end up at the login screen
  // rather than sitting on a dashboard it is no longer entitled to.
  //
  // It runs last because it reuses the session the password test just created: every login in these
  // three files comes out of one shared rate-limit budget (see 13-two-factor.spec.js), and revoking a
  // session necessarily destroys it, so this has to be the last thing done with it.
  const h = await auth(page);
  expect(caregiverToken, 'reuses the session the password test created').toBeTruthy();

  const ctx = await signedInContext(browser, caregiverToken);
  const view = await ctx.newPage();
  await view.goto('/');
  await expect(view.getByRole('link', { name: 'Live' }), 'the caregiver should start signed in').toBeVisible();

  // The admin finds that session in the all-accounts list and ends it. This is the real mechanism
  // behind "revoke a caregiver's access on a device they no longer have".
  const sessions = await (await page.request.get('/api/auth/sessions/all', h)).json();
  const theirs = sessions.find((s) => s.username === CAREGIVER.username);
  expect(theirs, 'the caregiver’s session should be visible to an admin').toBeTruthy();
  expect(theirs.is_current, 'it is certainly not the admin’s own session').toBe(false);
  const killed = await page.request.delete(`/api/auth/sessions/${theirs.id}`, h);
  expect(killed.status()).toBe(204);

  // Now make the revoked browser talk to the server. It has to be turned away.
  await view.reload();
  await expect(
    view.getByRole('button', { name: 'Sign in' }),
    'a browser whose session was revoked must land back at the login screen'
  ).toBeVisible();
  await ctx.close();
});

test.afterAll(async ({ browser }) => {
  if (!token || !caregiverId) return;
  const ctx = await browser.newContext();
  await ctx.request.delete(`/api/auth/users/${caregiverId}`, { headers: { Authorization: `Bearer ${token}` } });
  await ctx.close();
});
