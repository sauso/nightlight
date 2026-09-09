const { test, expect } = require('@playwright/test');

// The morning review, end to end: the card on a child's page, the screen behind it, and the
// correction coming back.
//
// ★ WHY THIS EXISTS AS AN E2E TEST AND NOT A UNIT TEST. Every defect this feature shipped was a
// CLIENT/SERVER DISAGREEMENT: the card vanished when a response shape changed under a running client;
// the prompt disappeared on save instead of becoming a receipt; the correction was accepted and then
// not displayed. A frontend unit test fakes the server and a backend unit test has no browser, so each
// agrees with itself by construction and neither can see that seam. Only this layer can.
//
// The night under review is seeded by ../seed-review-night.mjs (run from test.sh), so this spec does
// NOT test sleep detection — it tests the review round trip. That is stated in the seed script too.
//
// ⚠️ Times are asserted as WALL CLOCK, exactly as typed. The browser must send the 'HH:MM' a person
// entered and let the server resolve it against the app's configured timezone. Converting in the
// browser would use the PHONE's zone, so a review typed while travelling would disagree with the very
// card it was correcting — silently, in the data every later improvement gets scored against.
const CHILD = { id: 'e2e-review-kid', name: 'Review Kid' };

const childPage = `/#/children/${CHILD.id}`;

// Serial: these steps are one story told in order — the night is seeded once, and answering it changes
// the state the next step starts from.
test.describe.configure({ mode: 'serial' });

// ⚠️ The card renders times through Intl in the VIEWER's locale, so the same stored instant reads
// "20:15" to one person and "8:15 PM" to another. Pinning a 24-hour locale is what makes the
// assertions below deterministic; without it the spec passes or fails on the browser's default.
// It also keeps the check meaningful: the point is that the typed wall clock survives the round trip,
// and that is far easier to see in 24-hour form.
test.use({ locale: 'en-GB' });

test('the card offers last night for review', async ({ page }) => {
  await page.goto(childPage);
  await expect(page.getByText('Was last night right?')).toBeVisible();
  // The card carries the times it is asking about, so a person can answer without opening anything.
  await expect(page.getByText(/We think they fell asleep at .* and got up at /)).toBeVisible();
});

test('correcting a night records MY times and shows them back', async ({ page }) => {
  await page.goto(childPage);
  await page.getByText('Was last night right?').click();

  await expect(page.getByText('What we recorded')).toBeVisible();

  // ⚠️ Either label is legitimate here, and the reason is worth knowing: the CARD shows the STORED
  // night, while this screen RECOMPUTES from camera activity. The seeded night has no activity behind
  // it, so the recompute returns status 'no_data', the screen has no opinion to confirm, and the
  // button reads "Add the times". On a real night the detector does have one and it reads "Not
  // quite…". Pinning a single label would make this a statement about the fixture, not the flow.
  await page.getByRole('button', { name: /Not quite…|Add the times/ }).click();

  // The form appears only once you ask for it. Confirming and correcting are deliberately separate
  // acts, so a time the app guessed is never one reflex tap from being recorded as ground truth.
  await expect(page.getByText('Fell asleep')).toBeVisible();

  await page.locator('input[type="time"]').first().fill('20:15');
  await page.locator('input[type="time"]').nth(1).fill('06:05');
  await page.getByRole('button', { name: 'Save review' }).click();

  // Back on the child's page the prompt must become a RECEIPT, not simply vanish. A prompt that
  // disappears on save is indistinguishable from one that failed — which is exactly what was reported.
  await expect(page.getByText('Thanks — that’s recorded')).toBeVisible();
  // ⚠️ '6:05', not '06:05'. The card formats with Intl `hour: 'numeric'`, which does NOT zero-pad,
  // so a single-digit hour loses its leading zero on the way to the screen even though the value the
  // person typed and the value stored are both 06:05. Asserting the padded form fails against a
  // perfectly correct app.
  await expect(page.getByText(/You said 20:15 to 6:05/)).toBeVisible();
  await expect(page.getByText('Was last night right?')).toHaveCount(0);
});

test('the correction survives a reload, so it really reached the server', async ({ page }) => {
  // The assertion that matters. Everything above could pass on client-side state alone; only a fresh
  // load proves the round trip completed and the server is the one telling us these times.
  await page.goto(childPage);
  await expect(page.getByText('Thanks — that’s recorded')).toBeVisible();
  await expect(page.getByText(/You said 20:15 to 6:05/)).toBeVisible();
});

test('the times came back unconverted, not shifted by the browser timezone', async ({ page }) => {
  // Asked of the API directly, because this is the half a UI assertion cannot separate: if the client
  // had converted on the way in, the stored value would be a different wall clock and the card would
  // still look self-consistent.
  await page.goto('/');
  const token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  const res = await page.request.get(`/api/children/${CHILD.id}/review/pending`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.state).toBe('done');

  // The e2e app runs in UTC, so the wall clock typed and the instant stored coincide and the exact
  // value can be asserted. That is the whole point: had the browser converted on the way in — using
  // the PHONE's zone rather than the app's — these would be some other hour entirely while the card
  // carried on looking self-consistent, which is what makes the bug invisible from the UI alone.
  expect(body.true_onset_at).toBe('2026-08-29 20:15:00'.replace('2026-08-29', body.night_date));
  expect(body.true_wake_at.slice(11)).toBe('06:05:00');
  // ...and the wake belongs to the MORNING AFTER, not the same calendar day. A bare 06:05 sits on the
  // far side of midnight from a 20:15 bedtime, and resolving it to the wrong date would report a
  // night either ~14 hours long or negative.
  expect(body.true_wake_at.slice(0, 10)).not.toBe(body.night_date);
});

test('a recorded night can be corrected again — a mistake is not final', async ({ page }) => {
  await page.goto(childPage);
  await page.getByText('Thanks — that’s recorded').click();

  // Reopening a night you have already answered goes straight into the form with YOUR times already
  // in it — there is nothing left to "confirm", you are changing an answer you gave. This is also a
  // second round trip worth asserting: the correction has to come back out of the server and into the
  // form fields, not merely be displayed on the card.
  const onset = page.locator('input[type="time"]').first();
  const wake = page.locator('input[type="time"]').nth(1);
  await expect(onset).toHaveValue('20:15');
  await expect(wake).toHaveValue('06:05');

  await onset.fill('19:45');
  await wake.fill('05:30');
  await page.getByRole('button', { name: 'Save review' }).click();

  await expect(page.getByText(/You said 19:45 to 5:30/)).toBeVisible();
  await expect(page.getByText(/You said 20:15 to 6:05/)).toHaveCount(0);
});
