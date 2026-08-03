const { expect } = require('@playwright/test');

// The synthetic camera served by the fakecam service (see e2e/fakecam/mediamtx.yml).
const CAMERA = { name: 'E2E Synthetic', rtsp_host: 'fakecam', rtsp_port: '8554', rtsp_path: '/test' };

async function authToken(page) {
  await page.goto('/');
  return page.evaluate(() => localStorage.getItem('nightlight_token'));
}

// Guarantees the synthetic camera exists without depending on another spec having
// added it. Adds it straight through the API (force: true skips the pre-save stream
// check — liveness is proven separately in 02 and in prove.sh) so specs that just
// need "a camera on the grid" are self-contained.
async function ensureSyntheticCamera(page) {
  const token = await authToken(page);
  const headers = { Authorization: `Bearer ${token}` };
  const existing = await (await page.request.get('/api/cameras', { headers })).json();
  if (Array.isArray(existing) && existing.some((c) => c.name === CAMERA.name)) return;
  const res = await page.request.post('/api/cameras', { headers, data: { ...CAMERA, force: true } });
  expect(res.ok(), `adding synthetic camera failed: ${res.status()}`).toBeTruthy();
}

module.exports = { CAMERA, ensureSyntheticCamera };
