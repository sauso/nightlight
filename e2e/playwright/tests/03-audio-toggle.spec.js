const { test, expect } = require('@playwright/test');
const { CAMERA, ensureSyntheticCamera } = require('./helpers');

test.beforeEach(async ({ page }) => {
  await ensureSyntheticCamera(page);
});

// The tile's speaker button. In a browser this is a two-state mute toggle
// (muted <-> on); the third "Background listening" state only exists inside the
// native app (it's gated on isNativeApp()), so it's out of scope for Playwright and
// belongs to the Android instrumented tests (Phase 5).
test('speaker button toggles the tile between muted and on', async ({ page }) => {
  await page.goto('/');

  // A brand-new tile on a fresh device defaults to muted.
  const muted = page.getByRole('button', { name: /muted.*tap to unmute/i });
  await expect(muted).toBeVisible();

  // Muted -> On.
  await muted.click();
  const on = page.getByRole('button', { name: `Mute ${CAMERA.name}`, exact: true });
  await expect(on).toBeVisible();

  // On -> Muted.
  await on.click();
  await expect(page.getByRole('button', { name: /muted.*tap to unmute/i })).toBeVisible();
});
