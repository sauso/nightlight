const { test, expect } = require('@playwright/test');

// Caregiver accounts: creating one through the real screen, what that account can and cannot reach,
// and what happens to it when it's deleted.
//
// ★ WHY THIS LAYER. Role gating is enforced in two places that have to agree — the frontend hides a
// control, the server refuses the request — and this repo has shipped a failure in EACH direction.
// An admin-only delete route once 403'd every caller including admins, invisible in review because
// the UI looked right. The inverse (a hidden button whose route was never actually gated) is the same
// bug wearing the other hat. A frontend unit test renders both roles against a mocked server, so it
// can only ever prove the hiding; a backend test has no UI, so it can only prove the refusing.
// Neither can catch the two halves disagreeing, which is the failure that actually ships.
//
// ★ The deletion test is about a database pragma. `sessions` has ON DELETE CASCADE, which only does
// anything because db.js runs `PRAGMA foreign_keys = ON` — a per-connection setting that is easy to
// lose and silent when lost. Without it a deleted caregiver's token keeps working for up to 30 days.

const CAREGIVER = { username: 'e2e-users-kid', password: 'users-pw-12345', first_name: 'Users', last_name: 'Tester' };

test.describe.configure({ mode: 'serial' });

let token = null;
let caregiverId = null;
let caregiverToken = null;

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

const asCaregiver = () => ({ headers: { Authorization: `Bearer ${caregiverToken}` } });

test('an admin creates a caregiver through the real form', async ({ page }) => {
  await auth(page);
  await page.goto('/#/settings/users');
  await page.getByRole('button', { name: 'Add caregiver' }).click();

  await page.getByLabel('First name').fill(CAREGIVER.first_name);
  await page.getByLabel('Last name').fill(CAREGIVER.last_name);
  await page.getByLabel('Username (login)').fill(CAREGIVER.username);
  await page.getByLabel('Password', { exact: true }).fill(CAREGIVER.password);
  // ⚠️ The submit button is ALSO called 'Add caregiver' — the list page's button navigated here and
  // is gone, so the name is unambiguous, but it is a coincidence worth naming rather than tripping over.
  await page.getByRole('button', { name: 'Add caregiver' }).click();

  // Back on the list, with the new account on it — and shown as a caregiver, since the list is where
  // an admin would notice an account that had quietly been given the wrong role.
  await expect(page.getByText(`${CAREGIVER.username} · caregiver`)).toBeVisible();

  const users = await (await page.request.get('/api/auth/users', await auth(page))).json();
  const created = users.find((u) => u.username === CAREGIVER.username);
  expect(created, 'the caregiver should exist after saving the form').toBeTruthy();
  // Role defaults to caregiver, and the form must not quietly mint a second admin.
  expect(created.role).toBe('caregiver');
  caregiverId = created.id;
  // Whatever else a user response carries, it must never carry the password hash.
  expect(JSON.stringify(users)).not.toContain('$2');
});

test('the new caregiver can sign in and use the app', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: CAREGIVER.username, password: CAREGIVER.password },
  });
  expect(login.status(), 'the password typed into the form should be the one that works').toBe(200);
  const body = await login.json();
  caregiverToken = body.token;
  expect(body.user.role).toBe('caregiver');

  // A caregiver is a full user of the monitor — this is a household app, not a permissions system.
  const cameras = await page.request.get('/api/cameras', asCaregiver());
  expect(cameras.status(), 'a caregiver must be able to see the cameras').toBe(200);
});

test('★ the admin screens are refused by the SERVER, not merely hidden', async ({ page }) => {
  // The half a frontend test cannot reach. Each of these backs a control the UI hides from a
  // caregiver; if the hiding were the only thing standing in the way, anyone could just call them.
  const adminOnly = [
    ['GET', '/api/auth/users'],
    ['GET', '/api/auth/sessions/all'],
    ['POST', '/api/cameras'],
    ['DELETE', '/api/cameras/alerts'],
  ];
  for (const [method, path] of adminOnly) {
    const res = await page.request.fetch(path, { method, ...asCaregiver(), data: method === 'POST' ? {} : undefined });
    // 403, not 401: they ARE signed in, they're just not allowed. Getting this wrong sends a
    // legitimate caregiver back to the login screen instead of telling them what happened.
    expect(res.status(), `${method} ${path} should be admin-only`).toBe(403);
  }
});

test('the admin-only screen is not reachable in the caregiver’s browser either', async ({ browser }) => {
  // And the other half, in a real browser: typing the URL in must not render the screen.
  const ctx = await browser.newContext({ storageState: EMPTY_STATE });
  await ctx.addInitScript(([t]) => window.localStorage.setItem('nightlight_token', t), [caregiverToken]);
  const view = await ctx.newPage();
  await view.goto('/#/settings/users');

  // AdminProtected sends them away rather than rendering. Asserting on the absence of the screen's
  // own control, not on where they land, keeps this about the gate rather than the redirect target.
  await expect(view.getByRole('button', { name: 'Add caregiver' })).toHaveCount(0);
  await expect(view.getByRole('link', { name: 'Live' }), 'they should still be signed in, just not here').toBeVisible();
  await ctx.close();
});

test('an admin cannot delete their own account', async ({ page }) => {
  // The last admin deleting themselves would lock everyone out of a self-hosted app with no support
  // desk. 400 with a readable reason, not a silent success.
  const me = await (await page.request.get('/api/auth/me', await auth(page))).json();
  const res = await page.request.delete(`/api/auth/users/${me.id}`, await auth(page));
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/your own account/i);

  const still = await page.request.get('/api/auth/me', await auth(page));
  expect(still.status(), 'the refused delete must not have removed anything').toBe(200);
});

test('★ deleting a caregiver kills their live session immediately', async ({ page, browser }) => {
  // Their token is valid right up to the moment the account goes.
  const before = await page.request.get('/api/auth/me', asCaregiver());
  expect(before.status(), 'the caregiver should be signed in before the delete').toBe(200);

  const ctx = await browser.newContext({ storageState: EMPTY_STATE });
  await ctx.addInitScript(([t]) => window.localStorage.setItem('nightlight_token', t), [caregiverToken]);
  const view = await ctx.newPage();
  await view.goto('/');
  await expect(view.getByRole('link', { name: 'Live' })).toBeVisible();

  const del = await page.request.delete(`/api/auth/users/${caregiverId}`, await auth(page));
  expect(del.status()).toBe(204);

  // The session row went with the account — that is ON DELETE CASCADE doing its job, which depends on
  // `PRAGMA foreign_keys = ON` still being set. Lose the pragma and this token would keep working for
  // the rest of its 30 days with no account behind it.
  const after = await page.request.get('/api/auth/me', asCaregiver());
  expect(after.status(), 'a deleted account’s token must stop working at once').toBe(401);

  // And their open browser is turned away on its next request, not left showing the nursery.
  await view.reload();
  await expect(
    view.getByRole('button', { name: 'Sign in' }),
    'a deleted caregiver’s browser must land back at the login screen'
  ).toBeVisible();
  await ctx.close();

  caregiverId = null; // already gone; afterAll has nothing to do
});

test.afterAll(async ({ browser }) => {
  if (!token || !caregiverId) return;
  const ctx = await browser.newContext({ storageState: EMPTY_STATE });
  await ctx.request.delete(`/api/auth/users/${caregiverId}`, { headers: { Authorization: `Bearer ${token}` } });
  await ctx.close();
});
