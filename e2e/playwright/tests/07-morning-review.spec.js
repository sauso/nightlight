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
  // The card carries the one thing it is asking about (when they got up), so a person can answer without
  // opening anything. It no longer quotes the fell-asleep time or an event count.
  await expect(page.getByText(/We think they got up at /)).toBeVisible();
});

test('correcting a night records MY times and shows them back', async ({ page }) => {
  await page.goto(childPage);
  await page.getByText('Was last night right?').click();

  // ⚠️ The CARD shows the STORED night, while this screen RECOMPUTES from camera activity. The seeded night
  // has no activity behind it (see seed-review-night.mjs for why one cannot), so the recompute returns
  // status 'no_data' and the screen has nothing to confirm: it opens straight into its time field, with the
  // bedtime disclosure already open so both times can be given. On a real night the detector has a wake,
  // the screen asks "Up at … Is that right?" with "That's right" / "Not quite", and that path is covered by
  // the unit tests (frontend/test/MorningReview.test.jsx) and, over the wire, by the wake-only test below.
  // Pinning one of the two screens here would make this a statement about the fixture, not the flow.
  await expect(page.getByText(/didn.t work out when they got up/)).toBeVisible();

  // By LABEL, not position: "In bed" sits above "Fell asleep" in the disclosure, so positional locators
  // would type the asleep time into "In bed".
  await page.getByLabel('Fell asleep', { exact: true }).fill('20:15');
  await page.getByLabel('Got up for the day', { exact: true }).fill('06:05');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // ★ The prompt must become a RECEIPT, not simply vanish. A save that shows nothing is
  // indistinguishable from one that failed — exactly what was reported before the receipt existed.
  //
  // ⚠️ It now appears on the SLEEP DETAIL screen, not the child's page: saving returns you to the night
  // you just corrected, so a backlog of older nights can be worked through without re-picking the date
  // every time. THIS ASSERTION IS WHY THAT CHANGE IS SAFE — the first attempt at it moved the
  // navigation and dropped the receipt, and this line is what caught it. Both frontend unit suites
  // stayed green throughout, because each screen passed its own tests; only crossing the seam saw it.
  await expect(page).toHaveURL(/\/sleep\?date=.*saved=1/);
  await expect(page.getByText('Thanks — that’s recorded')).toBeVisible();
  // ⚠️ '6:05', not '06:05'. The card formats with Intl `hour: 'numeric'`, which does NOT zero-pad,
  // so a single-digit hour loses its leading zero on the way to the screen even though the value the
  // person typed and the value stored are both 06:05. Asserting the padded form fails against a
  // perfectly correct app.
  // The receipt says only what was answered, in the order it happens: asleep, then up.
  await expect(page.getByText(/You said asleep 20:15, up at 6:05/)).toBeVisible();

  // ⚠️ And the CHILD page must have changed too. Asserting the prompt is absent from the sleep screen
  // would be trivially true — it never appears there — so the check goes where it means something: back
  // on the page that asked the question, the prompt must now be the receipt. Without this the suite
  // would happily pass while the morning card still asked a question already answered.
  await page.goto(childPage);
  await expect(page.getByText('Thanks — that’s recorded')).toBeVisible();
  await expect(page.getByText('Was last night right?')).toHaveCount(0);
});

test('the correction survives a reload, so it really reached the server', async ({ page }) => {
  // The assertion that matters. Everything above could pass on client-side state alone; only a fresh
  // load proves the round trip completed and the server is the one telling us these times.
  await page.goto(childPage);
  await expect(page.getByText('Thanks — that’s recorded')).toBeVisible();
  await expect(page.getByText(/You said asleep 20:15, up at 6:05/)).toBeVisible();
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
  // form fields, not merely be displayed on the card. The asleep time sits in the disclosure, which opens
  // by itself because an answer to it is on record.
  const onset = page.getByLabel('Fell asleep', { exact: true });
  const wake = page.getByLabel('Got up for the day', { exact: true });
  await expect(onset).toHaveValue('20:15');
  await expect(wake).toHaveValue('06:05');

  await onset.fill('19:45');
  await wake.fill('05:30');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.getByText(/You said asleep 19:45, up at 5:30/)).toBeVisible();
  await expect(page.getByText(/You said asleep 20:15, up at 6:05/)).toHaveCount(0);
});

// ⚠️ ADDED IN THE nobody-in-bed FIX ROUND (2026-09-29) — the plan required e2e coverage for the "No one
// was in the bed" happy path and it had not been added when the feature first shipped. Same reasoning
// as the rest of this file: a unit test fakes the server and would agree with itself by construction,
// so only this layer proves the flag survives the client/server round trip the way the times above do.
//
// NOT RUN as part of this fix — this environment has no built `:dev` image / running MediaMTX+backend
// stack to execute Playwright against (see the file header: "Build :dev FIRST — e2e runs the image").
// Written to match the file's existing patterns and reviewed by hand against NightReview.jsx,
// ReviewReceipt.jsx and SleepDetail.jsx's actual copy/selectors, but it has NOT been confirmed to
// actually pass. Run it for real before relying on it.
test('"no one was in the bed" replaces the correction, and undoing it restores the detector\'s night', async ({ page }) => {
  await page.goto(childPage);
  await page.getByText(/You said asleep 19:45, up at 5:30/).click();
  await expect(page.getByLabel('Got up for the day', { exact: true })).toBeVisible();

  // Already-answered, so this opens straight into the time field with the previous times filled in, and
  // the disclosure (which holds the note) is open — the flag link sits under it.
  const flag = page.getByRole('button', { name: 'No one was in the bed' });

  // Layout, measured rather than read from the stylesheet (#754; replaces frontend/test/reviewFieldSpacing.test.js):
  // each field's caption sits ABOVE its input, and the flag button is not flush against the note input.
  // Written but not run where it was added (needs the e2e stack); confirm it before relying on it.
  const note = page.getByLabel('Anything else worth noting');
  const caption = page.locator('label.field', { hasText: 'Anything else worth noting' }).locator('.field__label');
  const noteBox = await note.boundingBox();
  const captionBox = await caption.boundingBox();
  const flagBox = await flag.boundingBox();
  expect(captionBox.y + captionBox.height, 'the caption is above its input, not inline beside it').toBeLessThanOrEqual(noteBox.y + 1);
  expect(flagBox.y - (noteBox.y + noteBox.height), 'the flag button has room under the note input').toBeGreaterThanOrEqual(8);

  await flag.click();

  await expect(page).toHaveURL(/\/sleep\?date=.*saved=1/);
  await expect(page.getByText('Thanks — that’s recorded')).toBeVisible();
  await expect(page.getByText('You said no one was in the bed. Tap to change it.')).toBeVisible();
  // The times just corrected are gone — the flag nulls them server-side, by design (README's stated
  // limit: undoing brings the detector's night back, not whatever was typed before the flag was set).
  await expect(page.getByText(/You said asleep 19:45, up at 5:30/)).toHaveCount(0);

  // Reload — the assertion that matters. Everything above could pass on client-side state alone; only
  // a fresh load proves the flag reached the server and is what is now being read back.
  await page.goto(childPage);
  await expect(page.getByText('You said no one was in the bed. Tap to change it.')).toBeVisible();

  // Reversible: undoing brings the DETECTOR's own night back, not 19:45/05:30.
  await page.getByText('You said no one was in the bed. Tap to change it.').click();
  await expect(page.getByText('You said no one was in the bed.')).toBeVisible();
  await page.getByRole('button', { name: 'Someone was in the bed' }).click();
  await expect(page).toHaveURL(/\/sleep\?date=.*saved=1/);
});

// ⚠️ ADDED 2026-09-30 with "in bed" separate from "asleep". The night of 2026-09-29 is why: a child put
// down at 18:49 for a bedtime story fell asleep at 19:13, and the review had no way to say both — its
// only put-down button overwrote the asleep time. This proves the two answers travel separately through
// the real client and server, and both come back on the receipt. Since the one-question review (2026-10-27)
// the frame buttons are gone from the screen and the two times live behind the "Change bedtime or fell-asleep
// time" disclosure; this is the typed path.
//
// NOT RUN when it was written, for the same reason as the test above: no `:dev` stack in that
// environment. Checked by hand against NightReview.jsx / ReviewReceipt.jsx / SleepDetail.jsx copy and
// against the unit tests; run it for real before relying on it.
test('"in bed" and "asleep" are separate answers, and both come back on the receipt', async ({ page }) => {
  await page.goto('/');
  const token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  const headers = { Authorization: `Bearer ${token}` };
  // The seeded night, by the app's own reckoning: the test above left it with no answer, so the card is
  // quiet and the screen is reached directly.
  const nights = await (await page.request.get(`/api/children/${CHILD.id}/sleep?nights=1`, { headers })).json();
  const date = nights.nights[0].night_date;
  await page.goto(`/#/children/${CHILD.id}/review/${date}`);
  // No activity behind the seeded night, so the screen opens on its time field with the disclosure open.
  await page.getByLabel('In bed', { exact: true }).fill('19:40');
  await page.getByLabel('Fell asleep', { exact: true }).fill('20:15');
  await page.getByLabel('Got up for the day', { exact: true }).fill('06:05');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page).toHaveURL(/\/sleep\?date=.*saved=1/);
  await expect(page.getByText(/You said in bed 19:40, asleep 20:15, up at 6:05/)).toBeVisible();

  // Stored as two answers, not one: the put-down never lands in the asleep time.
  const card = await (await page.request.get(`/api/children/${CHILD.id}/review/pending`, { headers })).json();
  expect(card.state).toBe('done');
  expect(card.true_in_bed_at.slice(11)).toBe('19:40:00');
  expect(card.true_onset_at.slice(11)).toBe('20:15:00');
});

// ⚠️ ADDED 2026-10-27 with the one-question review: the screen's "That's right" and its "Not quite" save sent
// ONLY a wake, plus the two `computed_*_at` echoes and the settings key, and every other key is omitted
// (omitted means "keep what is stored" to the server; null would clear). Unit tests fake the server, so this
// is the layer that proves the REAL server accepts that body, stores just the wake, and that both receipts
// (the child's page and the sleep page) say only what was answered.
//
// WHY THE REQUEST IS MADE DIRECTLY INSTEAD OF BY CLICKING "That's right": that button appears only when the
// live recompute finds a wake, which needs an enabled camera with activity samples for the child, and a
// camera row would break the first-run spec's "No cameras yet" (seed-review-night.mjs explains). The body
// below is exactly the one frontend/test/MorningReview.test.jsx asserts the button sends. The re-save at the
// end IS a real click, on the screen a night with a wake opens into.
//
// NOT RUN where it was written (no `:dev` stack): unproven until CI is green.
test('a wake-only answer is stored as just the wake, and both receipts say only that', async ({ page }) => {
  await page.goto('/');
  const token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const kid = 'e2e-wakeonly-kid';
  const nights = await (await page.request.get(`/api/children/${kid}/sleep?nights=1`, { headers })).json();
  const date = nights.nights[0].night_date;
  const view = await (await page.request.get(`/api/children/${kid}/review/${date}`, { headers })).json();

  const res = await page.request.put(`/api/children/${kid}/review/${date}`, {
    headers,
    data: {
      true_wake_local: '06:05',
      computed_onset_at: view.computed.onset_at ?? null,
      computed_wake_at: view.computed.wake_at ?? null,
      settings_key: view.settings.key,
    },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  const card = await (await page.request.get(`/api/children/${kid}/review/pending`, { headers })).json();
  expect(card.state).toBe('done');
  // The wake alone: no asleep or in-bed time was sent, so none is on record as the parent's.
  expect(card.true_wake_at.slice(11)).toBe('06:05:00');
  expect(card.true_onset_at).toBeNull();
  expect(card.true_in_bed_at).toBeNull();

  // The child's page receipt says only what was answered (exact line, so an asleep time cannot hide in it).
  await page.goto(`/#/children/${kid}`);
  await expect(page.getByText('You said up at 6:05. Tap to change it.', { exact: true })).toBeVisible();

  // Reopen, change nothing, save: the screen opens on the stored wake and a re-save sends the wake only, so
  // the receipt on the sleep page is unchanged and still quotes no asleep time.
  await page.getByText('You said up at 6:05. Tap to change it.', { exact: true }).click();
  await expect(page.getByLabel('Got up for the day', { exact: true })).toHaveValue('06:05');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/sleep\?date=.*saved=1/);
  await expect(page.getByText('You said up at 6:05. Tap to change it.', { exact: true })).toBeVisible();
});
