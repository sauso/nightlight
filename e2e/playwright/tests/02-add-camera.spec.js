const { test, expect } = require('@playwright/test');
const { CAMERA } = require('./helpers');

// The core flow: add a camera through the real form, then confirm it actually goes
// live on the grid — i.e. frames from the synthetic source made it all the way
// through the pipeline and into the browser's <video>.
test('add a camera through the UI and see it go live on the grid', async ({ page }) => {
  await page.goto('/#/cameras');

  await page.getByRole('button', { name: '+ Add camera' }).click();
  await page.getByLabel('Name', { exact: true }).fill(CAMERA.name);
  await page.getByLabel('Camera IP address').fill(CAMERA.rtsp_host);
  await page.getByLabel('RTSP port').fill(CAMERA.rtsp_port);
  await page.getByLabel('Stream path', { exact: true }).fill(CAMERA.rtsp_path);
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  // The on-demand source can be cold on the very first connect, tripping the pre-save
  // stream validation; the UI then offers "Save anyway". Take it if it shows up —
  // otherwise the save already succeeded.
  const saveAnyway = page.getByRole('button', { name: 'Save anyway' });
  try {
    await saveAnyway.waitFor({ state: 'visible', timeout: 8000 });
    await saveAnyway.click();
  } catch {
    /* validated on the first try */
  }

  // Modal closes on a successful save.
  await expect(page.getByLabel('Camera IP address')).toBeHidden();

  // On the dashboard the tile appears and its video plays (currentTime advances) —
  // WebRTC if it connects, HLS via the auto-fallback if not. Either way, live frames.
  await page.goto('/');
  await expect(page.getByText(CAMERA.name)).toBeVisible();
  const video = page.locator('.card-grid video').first();
  await expect(video).toBeAttached();
  await expect
    .poll(async () => video.evaluate((v) => v.currentTime).catch(() => 0), {
      timeout: 45_000,
      message: 'the tile video should start playing',
    })
    .toBeGreaterThan(0);
});
