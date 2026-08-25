const { test, expect } = require('@playwright/test');
const { CAMERA, ensureSyntheticCamera } = require('./helpers');

// Documentation screenshots, generated as a byproduct of the suite so they stay in sync with the real
// UI. Written to ./screenshots (gitignored); CI uploads them as the `docs-screenshots` artifact, and
// the good ones are committed under docs/screenshots/. Also a light smoke test — each shot asserts the
// screen actually rendered before capturing.
//
// Captured at TWO form factors, because the layout genuinely differs: below 1200px the navigation is a
// bottom tab bar, and at 1200px and up the same component becomes a 220px left sidebar rail (see
// .bottom-nav in index.css). One screenshot can't show both, and the desktop rail is invisible in a
// phone-width shot.
//
// NOTE: deliberately NOT `fullPage`. The navigation is `position: fixed`, and a full-page screenshot
// composites it at the scroll offset rather than pinned to the viewport — which is why the previous
// settings shot had the nav floating across the middle of the page. Viewport-sized captures show the
// fixed chrome where it actually sits. The trade-off is that a long page is cropped to one screen,
// which is honest: that IS what a person sees.
const SHOTS = 'screenshots';

const FORM_FACTORS = [
  { name: 'mobile', width: 390, height: 844 }, // a typical modern phone; bottom tab bar
  { name: 'desktop', width: 1440, height: 900 }, // >= 1200px, so the nav is the sidebar rail
];

for (const ff of FORM_FACTORS) {
  test(`capture documentation screenshots (${ff.name})`, async ({ page }) => {
    await page.setViewportSize({ width: ff.width, height: ff.height });
    await ensureSyntheticCamera(page);

    // The live dashboard with a camera tile.
    await page.goto('/');
    await expect(page.locator('.camera-tile', { hasText: CAMERA.name }).first()).toBeVisible();
    await expect(page.locator('.bottom-nav')).toBeVisible();
    await page.waitForTimeout(1500); // let the tile settle
    await page.screenshot({ path: `${SHOTS}/dashboard-${ff.name}.png` });

    // The add-camera form (filled with example values, not saved).
    await page.goto('/#/cameras');
    await page.getByRole('button', { name: '+ Add camera' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Nursery cam');
    await page.getByLabel('Camera IP address').fill('192.168.1.50');
    await page.getByLabel('RTSP port').fill('554');
    await page.getByLabel('Stream path', { exact: true }).fill('/Streaming/Channels/101');
    await page.screenshot({ path: `${SHOTS}/add-camera-${ff.name}.png` });

    // The settings screen. Settings is a hub of sub-pages now; General holds the app name / theme /
    // etc. and is the closest equivalent to the old single settings page.
    await page.goto('/#/settings/general');
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settings-${ff.name}.png` });
  });
}
