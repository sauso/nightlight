const { test, expect } = require('@playwright/test');
const { ensureSyntheticCamera } = require('./helpers');

// Replaces frontend/test/touchTargets.test.js (#754), which read src/index.css as TEXT and pinned selectors and pixel
// values: jsdom does no layout, so it could not see a tap land, and it rejected any equivalent way of building the
// same hit area. This one asks the browser. A tile control is drawn 24-30px but meant to be tappable over 44px (#381),
// via an invisible ::after; `elementFromPoint` is what a finger gets, so the check is: a point REACH px from the
// control's centre, on each axis, still lands on that control and not on the video or a neighbouring button.
// A 44px target reaches 22px from its centre; REACH = 21 leaves 1px for sub-pixel layout and is not to be lowered:
// the old rules were `inset:-7px` on a 30px button and `inset:-10px` on the 24px drag handle, both 44px.
//
// COVERAGE, stated plainly:
//   * REQUIRED and measured (the spec fails if one is missing): Record, Picture-in-Picture, Fullscreen, Mute, Settings,
//     and the drag handle. All exist for every camera the e2e admin can see; Record appears once the camera's ring
//     buffer is up, hence the long wait for it.
//   * NOT covered: Talk (.talk-btn) and PTZ (.ptz-btn). They exist only for a camera with two-way audio / PTZ set up,
//     and the e2e fake camera has neither capability. They are measured below IF they are visible, so a future
//     fixture with those capabilities starts checking them without a change here, but today they are covered by
//     the real-device release checklist (planning/deploy-runbook.md §1.6) only.
//   * RUNS ON: PRs into `main` and nightly (e2e.yml), NOT on PRs into `dev`. A layout regression is caught at the
//     release PR, not at the change that caused it.
//
// NOT RUN where this was written (it needs the Docker e2e stack, see e2e/README.md): reviewed against CameraTile.jsx
// by hand, not confirmed to pass. Run `e2e/test.sh` or dispatch e2e.yml on the branch before relying on it.
const REQUIRED = ['.rec-btn', '.pip-btn', '.fullscreen-btn', '.mute-btn', '.settings-btn', '.drag-handle'];
const CONDITIONAL = ['.talk-btn', '.ptz-btn'];
const REACH = 21;

async function expectTappable(page, el, name) {
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  expect(box, `${name} has a rendered box`).not.toBeNull();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (const [dx, dy] of [[0, 0], [REACH, 0], [-REACH, 0], [0, REACH], [0, -REACH]]) {
    const hit = await el.evaluate((node, [x, y]) => {
      const top = document.elementFromPoint(x, y);
      return !!top && (top === node || node.contains(top));
    }, [cx + dx, cy + dy]);
    expect(hit, `a tap ${dx},${dy}px from the centre of ${name} must land on it`).toBe(true);
  }
}

test('camera tile controls and the drag handle are tappable 21px beyond their centre', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); // a phone: where the 44px target matters
  await ensureSyntheticCamera(page);
  await page.goto('/');
  const tile = page.locator('.camera-tile').first();
  await expect(tile).toBeVisible();
  await tile.hover();

  for (const sel of REQUIRED) {
    const el = tile.locator(sel).first();
    // Record needs the camera's ring buffer to be up (can_record), which can take a while on a cold stack.
    await expect(el, `${sel} must be present on a tile (not optional)`).toBeVisible({ timeout: sel === '.rec-btn' ? 60_000 : 20_000 });
    await expectTappable(page, el, sel);
  }

  for (const sel of CONDITIONAL) {
    const el = tile.locator(sel).first();
    if (await el.isVisible()) await expectTappable(page, el, sel);
  }
});
