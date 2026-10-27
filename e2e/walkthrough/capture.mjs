// Captures the documentation walkthrough (docs/screenshots/) from the two throwaway containers that run.sh starts.
// Not a test: nothing here asserts behaviour, it only refuses to take a picture of a screen that did not render
// (each waitFor/expect below throws, so a broken UI fails the refresh instead of being committed).
//
// Environment (set by run.sh): WALK_SEEDED, WALK_EMPTY, WALK_OUT. WALK_CHROMIUM optionally points at a browser
// executable when the Playwright-managed one is not installed.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(here, '..', 'playwright', 'package.json'))('playwright');

const SEEDED = process.env.WALK_SEEDED;
const EMPTY = process.env.WALK_EMPTY;
const OUT = process.env.WALK_OUT;
if (!SEEDED || !EMPTY || !OUT) throw new Error('WALK_SEEDED, WALK_EMPTY and WALK_OUT are required (run.sh sets them)');

// Same accounts as prepare.mjs (throwaway, in a container that is deleted afterwards).
const ADMIN = { username: 'sam', password: 'walkthrough-admin-1' };
const CAREGIVER = { username: 'jordan', password: 'walkthrough-care-1' };
const AVERY = 'demo-child-avery';

// Two form factors, because the layout genuinely differs: below 1200 px the navigation is a bottom tab bar and at
// 1200 px and up it is a left rail (see e2e/playwright/tests/05-screenshots.spec.js). Desktop is captured only for
// the two screens where that changes what a person sees.
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

const browser = await chromium.launch(
  process.env.WALK_CHROMIUM ? { executablePath: process.env.WALK_CHROMIUM } : {}
);

async function login(base, who) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(who),
  });
  if (!res.ok) throw new Error(`login as ${who.username} failed: ${res.status}`);
  return (await res.json()).token;
}

async function open(base, form, token) {
  const context = await browser.newContext(form);
  if (token) await context.addInitScript((t) => localStorage.setItem('nightlight_token', t), token);
  const page = await context.newPage();
  const go = (route) => page.goto(`${base}/#${route}`);
  const shot = async (name) => {
    await page.waitForTimeout(400); // let transitions finish
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('captured', name);
  };
  return { context, page, go, shot };
}

// Every <video> on the page has a decoded frame. Without this the tile says "Connecting…" for a few seconds.
const videosPlaying = (page) =>
  page.waitForFunction(
    () => {
      const v = [...document.querySelectorAll('video')];
      return v.length > 0 && v.every((el) => el.readyState >= 2);
    },
    null,
    { timeout: 45_000 }
  );

// 1. First-run admin setup, on an empty install. The password field shows dots, which is the point.
{
  const { context, page, go, shot } = await open(EMPTY, PHONE);
  await go('/');
  await page.getByRole('button', { name: 'Create admin account' }).waitFor();
  await page.getByLabel('First name').fill('Sam');
  await page.getByLabel('Last name').fill('Rivera');
  await page.getByLabel('Username').fill('sam');
  await page.getByLabel('Password').fill('example-password');
  await shot('setup-mobile');
  await context.close();
}

const adminToken = await login(SEEDED, ADMIN);

// 2-3. Live view and the child overview, on a phone and on desktop.
for (const [suffix, form] of [['mobile', PHONE], ['desktop', DESKTOP]]) {
  const { context, page, go, shot } = await open(SEEDED, form, adminToken);
  await go('/');
  await page.locator('.camera-tile').first().waitFor();
  await videosPlaying(page);
  await shot(`live-${suffix}`);
  await go(`/children/${AVERY}`);
  await page.getByText('Last night').first().waitFor();
  await shot(`child-${suffix}`);
  await context.close();
}

// 4-9, phone only. One browser context per admin screen keeps each capture independent.
{
  const { context, page, go, shot } = await open(SEEDED, PHONE, adminToken);

  // The night detail page: the numbers behind the overview card.
  await go(`/children/${AVERY}/sleep`);
  await page.getByText('NIGHT TIMELINE').waitFor();
  await shot('sleep-mobile');

  // The morning review: opened the way a person gets there, from the prompt on the child page.
  await go(`/children/${AVERY}`);
  await page.getByText('Was last night right?').click();
  await page.getByRole('button', { name: 'That’s right' }).waitFor();
  await shot('review-mobile');

  // Recent alerts, scrolled into view on the child page (snapshots come from the seeded alerts).
  await go(`/children/${AVERY}`);
  await page.getByText('Recent alerts').first().waitFor();
  await page.waitForTimeout(1500); // the page reloads its alert list once; scrolling during that detaches the node
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && el.textContent.trim() === 'Recent alerts');
    heading.scrollIntoView({ block: 'start' });
    window.scrollBy(0, -140); // keep the heading clear of the sticky header
  });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await shot('alerts-mobile');

  // The notification providers. Nothing is configured: a fresh install looks exactly like this.
  await go('/settings/push');
  await page.getByText('Pushover').first().waitFor();
  await shot('notifications-mobile');

  // The add-camera form, filled with example values and not saved.
  await go('/cameras');
  await page.getByRole('button', { name: '+ Add camera' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Nursery cam');
  await page.getByLabel('Camera IP address').fill('192.168.1.50');
  await page.getByLabel('RTSP port').fill('554');
  await page.getByLabel('Stream path', { exact: true }).fill('/Streaming/Channels/101');
  await shot('add-camera-mobile');
  await context.close();
}

// 10. What a caregiver sees: Settings holds only their own account and About.
{
  const { context, page, go, shot } = await open(SEEDED, PHONE, await login(SEEDED, CAREGIVER));
  await go('/settings');
  await page.getByText('Caregiver').first().waitFor();
  await shot('caregiver-settings-mobile');
  await context.close();
}

await browser.close();
