const { defineConfig, devices } = require('@playwright/test');

// The stack shares one backend + DB across the whole run, so tests are serial and
// ordered — the `setup` project drives the real first-run admin creation and saves
// its auth, then the `chromium` project runs the rest already logged in.
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  outputDir: 'test-results',
  use: {
    // In-compose the app is reachable by service name; locally/CI it can be a host port.
    baseURL: process.env.BASE_URL || 'http://localhost:4000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    launchOptions: {
      // Headless Chromium needs a fake mic for any getUserMedia path, and permission to
      // autoplay the (muted) tile video without a user gesture.
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [
    { name: 'setup', testMatch: /first-run\.spec\.js/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /first-run\.spec\.js/,
      use: { ...devices['Desktop Chrome'], storageState: '.auth/state.json' },
    },
  ],
});
