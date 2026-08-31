const { test, expect } = require('@playwright/test');

// "Recompute this night" — the guard that stops it destroying a good night, and the reason the UI
// cannot reach that guard in the first place.
//
// ★ WHY THIS IS HERE. The feature shipped completely INERT once (PR #222, fixed in #225) through the
// stored-vs-fresh confusion that runs through this whole area: the dialog compared the page's night —
// itself a fresh recompute — against another fresh recompute, so both sides were the same computation
// and it always reported "nothing to change". A button that runs and changes nothing is
// indistinguishable from one that works. Only reading the SAVED row afterwards can separate them.
//
// ★ WHAT THIS SPEC LEARNED, AND WHY IT IS SHAPED THIS WAY. The destructive case — recomputing a night
// whose activity has been pruned, so a scored summary would be replaced by `no_data` — turns out to be
// UNREACHABLE THROUGH THE BROWSER. A no_data night short-circuits SleepDetail to "No sleep data for
// this night" and the recompute button is never rendered. So:
//   * the UI half is asserted as what it is: the destructive path is not offered;
//   * the guard itself is driven through the ROUTE, which is where `allowDowngrade: false` is actually
//     wired (routes/children.js) and therefore where a regression would land. A lib-level unit test of
//     computeAndStoreNight cannot see that wiring, and the browser cannot reach it.
// Writing a browser test for a screen the user can never get to would have been theatre.
const CHILD = { id: 'e2e-recompute-kid', name: 'Recompute Kid' };
const sleepPage = `/#/children/${CHILD.id}/sleep`;

test.describe.configure({ mode: 'serial' });
test.use({ locale: 'en-GB' });

const previousDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

async function auth(page) {
  await page.goto('/');
  const token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  return { headers: { Authorization: `Bearer ${token}` } };
}

// The seeded night's date, derived rather than hard-coded. The page and the seed both key off the
// app's own idea of "last completed night", which moves with the clock: when a sleep window happens to
// be open, /sleep/live reports the night IN PROGRESS and the completed one is the day before.
async function seededDate(page) {
  const h = await auth(page);
  const live = await (await page.request.get(`/api/children/${CHILD.id}/sleep/live`, h)).json();
  return live.scope === 'tonight' ? previousDay(live.night.night_date) : live.night.night_date;
}

// The SAVED summary, read the way the dialog reads it — `?stored=1`, never a fresh compute. That
// distinction is the entire feature, so every assertion here goes through it.
async function savedNight(page, date) {
  const h = await auth(page);
  const res = await page.request.get(`/api/children/${CHILD.id}/sleep/${date}?stored=1`, h);
  expect(res.ok()).toBeTruthy();
  return (await res.json()).night;
}

test('the seeded night really is saved as a scored night', async ({ page }) => {
  // Everything below is meaningless if the fixture is not what it claims, so assert it once, loudly.
  const date = await seededDate(page);
  const night = await savedNight(page, date);
  expect(night, `nothing saved for ${date}`).toBeTruthy();
  expect(night.status).toBe('ok');
  expect(night.asleep_minutes).toBeGreaterThan(0);
});

test('a night the detector cannot score is not offered a recompute', async ({ page }) => {
  // The saved night is scored, but a FRESH compute of it finds nothing (no camera activity underlies
  // the fixture). The page shows the fresh view — so it says there is no data, and deliberately offers
  // no way to overwrite the good saved summary with that emptiness.
  // ⚠️ Resolve the date BEFORE opening the sleep page. `seededDate` authenticates by visiting '/',
  // so calling it mid-test navigates away and detaches everything already located on the page.
  const date = await seededDate(page);

  await page.goto(sleepPage);
  const picker = page.getByLabel('Pick a night');
  await expect(picker).toBeVisible();
  await picker.fill(date);

  await expect(page.getByText(/No sleep data for this night/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recompute this night' })).toHaveCount(0);
});

test('the route REFUSES to replace a scored night with an unscored one', async ({ page }) => {
  // The data-loss guard, driven where it is actually wired. Without it, recomputing a night whose
  // activity had been pruned would blank last night's summary on the one screen a parent checks —
  // silently, and with no way back.
  const date = await seededDate(page);
  const before = await savedNight(page, date);
  expect(before.status, 'the fixture must START scored or this proves nothing').toBe('ok');

  const h = await auth(page);
  const res = await page.request.get(`/api/children/${CHILD.id}/sleep/${date}?store=1&detail=1`, h);

  // 409 with a readable reason, and 4xx rather than 5xx on purpose: a 5xx body is stripped by
  // Cloudflare, so the person would be told nothing at all.
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.error).toMatch(/aged out|left as it is/i);

  const after = await savedNight(page, date);
  expect(after.status, 'a scored night must survive a recompute that found nothing').toBe('ok');
  expect(after.onset_at).toBe(before.onset_at);
  expect(after.wake_at).toBe(before.wake_at);
  expect(after.asleep_minutes).toBe(before.asleep_minutes);
});

test('a caregiver cannot rewrite a stored night, whatever the UI shows them', async ({ page, browser }) => {
  // The frontend hides the button for a caregiver, which a unit test already covers. This asserts the
  // half a unit test cannot: that hiding it is not the only thing standing in the way. This repo has
  // shipped the inverse before — an admin-only route that 403'd every caller, invisible in review.
  //
  // ⚠️ The refusal is SILENT, not a 403. `store=1` is honoured only for an admin (routes/children.js:150);
  // for anyone else the flag is simply dropped and they get an ordinary fresh compute back with a 200.
  // Nothing is written, which is what actually matters — but a caregiver is never TOLD their request
  // was partly ignored. Pinned as it is rather than as one might assume it to be.
  const admin = await auth(page);
  const username = `care-${Date.now()}`;
  const created = await page.request.post('/api/auth/users', {
    ...admin,
    data: { username, password: 'caregiver-pw-123', role: 'caregiver', first_name: 'Care' },
  });
  expect(created.ok(), `could not create a caregiver: ${created.status()}`).toBeTruthy();

  const ctx = await browser.newContext();
  const login = await ctx.request.post('/api/auth/login', { data: { username, password: 'caregiver-pw-123' } });
  expect(login.ok()).toBeTruthy();
  const { token } = await login.json();

  const date = await seededDate(page);
  const before = await savedNight(page, date);

  const res = await ctx.request.get(`/api/children/${CHILD.id}/sleep/${date}?store=1&detail=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status(), 'the store flag is dropped, not rejected — they get a plain read').toBe(200);
  await ctx.close();

  // The assertion that matters: nothing was written. An admin asking the same thing got a 409;
  // a caregiver's attempt does not reach the write at all.
  const after = await savedNight(page, date);
  expect(after.status).toBe('ok');
  expect(after.onset_at).toBe(before.onset_at);
  expect(after.asleep_minutes).toBe(before.asleep_minutes);
});
