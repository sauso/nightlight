const { test, expect } = require('@playwright/test');

// The `setup` project. Drives the genuine first-run flow (the app gates everything
// behind login; with no users it shows the create-admin form) and saves the resulting
// auth for every other spec. Exercising the real path means these tests survive auth
// changes rather than silently drifting from a seeded DB.
test('first run: create the admin account and enter the setup guide', async ({ page }) => {
  await page.goto('/');

  // No users yet -> first-run mode: the welcome screen with the steps comes first (owner, 2026-11-06), then the account form.
  await expect(page.getByRole('heading', { name: 'Welcome to Nightlight' })).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.getByRole('button', { name: 'Create admin account' })).toBeVisible();
  await expect(page.getByText('Step 1 of 7')).toBeVisible(); // creating the account is Step 1 (owner, 2026-11-06)

  await page.getByLabel('First name').fill('E2E');
  await page.getByLabel('Last name').fill('Tester');
  await page.getByLabel('Username').fill('e2e');
  await page.getByLabel('Password').fill('e2e-admin-pw');
  await page.getByRole('button', { name: 'Create admin account' }).click();

  // A fresh install enters the optional guide after the first admin signs in.
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Add your child' })).toBeVisible();
  await expect(page.getByText('Step 2 of 7')).toBeVisible();

  // Hand the logged-in state to the rest of the suite.
  await page.context().storageState({ path: '.auth/state.json' });
});
