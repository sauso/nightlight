const { test, expect } = require('@playwright/test');
const { ensureSyntheticCamera } = require('./helpers');

// Modal is shared by a dozen screens, and its layout lives in CSS (.modal-overlay / .modal-card) so a
// media query can reach it — inline styles would win over the stylesheet and the desktop rules would
// silently never apply. These guard that contract:
//   - on a phone it is still a SHEET hugging an edge;
//   - on a desktop window a normal modal stays narrow (a confirmation must not stretch to 1000px);
//   - a modal that opts in with `wide` centres and grows — that's what the video player uses, so a clip
//     isn't played in a 440px box on a large screen.
//
// The wide case applies the class directly rather than opening a player, because the test fixture has no
// recorded clip or timelapse to play. It's the same CSS rule the player relies on.

async function openConfirmModal(page) {
  await page.goto('/#/cameras');
  await page.getByRole('button', { name: 'Remove' }).first().click();
  await expect(page.locator('.modal-card')).toBeVisible();
}

test('modal is a sheet on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ensureSyntheticCamera(page);
  await openConfirmModal(page);

  const box = await page.locator('.modal-card').boundingBox();
  const vp = page.viewportSize();
  expect(box.y).toBeLessThan(60); // placement="top": pinned to the top edge
  expect(box.width).toBeLessThanOrEqual(vp.width);
});

test('on desktop a normal modal stays narrow but a wide one centres and grows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ensureSyntheticCamera(page);
  await openConfirmModal(page);

  const narrow = await page.locator('.modal-card').boundingBox();
  expect(narrow.width).toBeLessThanOrEqual(441);

  await page.locator('.modal-overlay').evaluate((el) => el.classList.add('modal-overlay--wide'));
  const wide = await page.locator('.modal-card').boundingBox();
  const vp = page.viewportSize();
  expect(wide.width).toBeGreaterThan(900);
  expect(Math.abs((wide.y + wide.height / 2) - vp.height / 2)).toBeLessThan(40); // vertically centred
});
