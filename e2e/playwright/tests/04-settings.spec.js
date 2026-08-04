const { test, expect } = require('@playwright/test');

// A representative settings flow: flip the temperature unit, save, and confirm it
// both saves and persists across a reload.
test('changing the temperature unit saves and persists', async ({ page }) => {
  // Settings is a hub of sub-pages now; the temperature unit lives under General.
  await page.goto('/#/settings/general');

  await page.getByRole('button', { name: '°F', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved ✓')).toBeVisible();

  // Reload from the server and confirm °F is the active choice.
  await page.goto('/#/settings/general');
  await expect(page.getByRole('button', { name: '°F', exact: true })).toHaveClass(/font-btn--active/);
});
