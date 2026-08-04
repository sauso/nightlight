const { test, expect } = require('@playwright/test');
const { CAMERA, ensureSyntheticCamera } = require('./helpers');

// Documentation screenshots, generated as a byproduct of the suite so they stay in
// sync with the real UI (see planning/documentation-and-e2e-testing-scope.md). Written
// to ./screenshots (gitignored); CI uploads them as the `docs-screenshots` artifact,
// and the good ones are committed under docs/screenshots/. Also a light smoke test —
// each shot asserts the screen actually rendered before capturing.
const SHOTS = 'screenshots';

test('capture documentation screenshots', async ({ page }) => {
  await ensureSyntheticCamera(page);

  // The live dashboard with a camera tile.
  await page.goto('/');
  await expect(page.locator('.camera-tile', { hasText: CAMERA.name }).first()).toBeVisible();
  await page.waitForTimeout(1500); // let the tile settle
  await page.screenshot({ path: `${SHOTS}/dashboard.png` });

  // The add-camera form (filled with example values, not saved).
  await page.goto('/#/cameras');
  await page.getByRole('button', { name: '+ Add camera' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Nursery cam');
  await page.getByLabel('Camera IP address').fill('192.168.1.50');
  await page.getByLabel('RTSP port').fill('554');
  await page.getByLabel('Stream path', { exact: true }).fill('/Streaming/Channels/101');
  await page.screenshot({ path: `${SHOTS}/add-camera.png` });

  // The settings screen. Settings is a hub of sub-pages now; General holds the app
  // name / theme / etc. and is the closest equivalent to the old single settings page.
  await page.goto('/#/settings/general');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/settings.png`, fullPage: true });
});
