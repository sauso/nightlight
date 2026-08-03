const { test, expect } = require('@playwright/test');

// The `setup` project. Drives the genuine first-run flow (the app gates everything
// behind login; with no users it shows the create-admin form) and saves the resulting
// auth for every other spec. Exercising the real path means these tests survive auth
// changes rather than silently drifting from a seeded DB.
test('first run: create the admin account and land on the empty dashboard', async ({ page }) => {
  await page.goto('/');

  // No users yet -> the login screen is in first-run (setup) mode.
  await expect(page.getByRole('button', { name: 'Create admin account' })).toBeVisible();

  await page.getByLabel('First name').fill('E2E');
  await page.getByLabel('Last name').fill('Tester');
  await page.getByLabel('Username').fill('e2e');
  await page.getByLabel('Password').fill('e2e-admin-pw');
  await page.getByRole('button', { name: 'Create admin account' }).click();

  // Lands on the dashboard, which is empty until a camera is added.
  await expect(page.getByText('No cameras yet')).toBeVisible();

  // Hand the logged-in state to the rest of the suite.
  await page.context().storageState({ path: '.auth/state.json' });
});
