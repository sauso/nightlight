const { test, expect } = require('@playwright/test');
const { ensureSyntheticCamera } = require('./helpers');

// Replaces frontend/test/touchTargets.test.js (#754), which read src/index.css as TEXT and pinned selectors and pixel
// values: jsdom does no layout, so it could not see a tap land, and it rejected any equivalent way of building the
// same hit area. This one asks the browser. A tile control is drawn 30px but meant to be tappable over ~44px (#381),
// via an invisible pseudo-element; `elementFromPoint` is what a finger gets, so the check is: a point 20px from the
// control's centre, on each axis, still lands on that control and not on the video or a neighbouring button.
//
// NOT RUN where this was written (it needs the Docker e2e stack, see e2e/README.md): reviewed against CameraTile.jsx
// by hand, not confirmed to pass. Run `e2e/test.sh` before relying on it.
const CONTROLS = ['.mute-btn', '.talk-btn', '.pip-btn', '.settings-btn', '.fullscreen-btn', '.ptz-btn', '.rec-btn'];
const REACH = 20; // a 44px target reaches 22px from its centre; 20 leaves a little slack for sub-pixel layout

test('camera tile controls are tappable 20px beyond their centre, and the tap lands on that control', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // a phone: where the 44px target matters
  await ensureSyntheticCamera(page);
  await page.goto('/');
  const tile = page.locator('.camera-tile').first();
  await expect(tile).toBeVisible();
  await tile.hover();

  let checked = 0;
  for (const sel of CONTROLS) {
    const btn = tile.locator(sel).first();
    if (!(await btn.isVisible())) continue; // some only exist when the camera has the capability / is recording
    const box = await btn.boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    for (const [dx, dy] of [[0, 0], [REACH, 0], [-REACH, 0], [0, REACH], [0, -REACH]]) {
      const hit = await page.evaluate(([x, y, s]) => {
        const el = document.elementFromPoint(x, y);
        const target = document.querySelector(s);
        return !!el && !!target && (el === target || target.contains(el));
      }, [cx + dx, cy + dy, `.camera-tile ${sel}`]);
      expect(hit, `a tap ${dx},${dy}px from the centre of ${sel} must land on it`).toBe(true);
    }
    checked += 1;
  }
  // The mute button always exists on a tile; zero checked would mean the selectors drifted, not that all is well.
  expect(checked).toBeGreaterThan(0);
});
