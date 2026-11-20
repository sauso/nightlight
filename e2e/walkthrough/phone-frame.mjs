// Draws the front-page README screenshots inside a phone frame, all the same size.
//
// Why a script and not a one-off: the README table shows three screenshots side by side, and a bare screenshot of
// a web page next to two others reads as three different-sized rectangles (the table column widths follow the
// headings, not the pictures). A frame of one fixed size around each makes them match and looks like a phone.
// The three source PNGs are all captured at the same viewport (390 x 844 CSS px, 2x), so the frame fits exactly.
//
// Run it AFTER a screenshot refresh (e2e/README.md, "Refreshing the documentation screenshots"):
//   node e2e/walkthrough/phone-frame.mjs
// It reads docs/screenshots/<name>.png and writes docs/screenshots/framed/<name>.png (transparent outside the
// phone, so it works on GitHub's light and dark themes). Pass other names as arguments to frame other screens.
// WALK_CHROMIUM optionally points at a browser executable when Playwright's own browser is not installed.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { chromium } = createRequire(path.join(here, '..', 'playwright', 'package.json'))('playwright');

const names = process.argv.slice(2).length ? process.argv.slice(2) : ['live-mobile', 'child-mobile', 'review-mobile'];
const outDir = path.join(root, 'docs', 'screenshots', 'framed');
fs.mkdirSync(outDir, { recursive: true });

// The screenshots are taken at this viewport (walkthrough/capture.mjs, PHONE); the frame is built around it.
const SCREEN = { width: 390, height: 844 };

const page_html = (dataUri) => `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: transparent; }
  /* Room around the phone for the side buttons, which sit outside its edge. */
  .wrap { display: inline-block; padding: 6px; }
  .phone {
    position: relative; box-sizing: border-box;
    width: ${SCREEN.width + 24}px; height: ${SCREEN.height + 64}px; padding: 32px 12px;
    border-radius: 58px; background: #14141b; border: 2px solid #34343f;
  }
  /* Speaker slot and camera in the top bezel; nothing overlaps the app's own header. */
  .phone::before { content: ""; position: absolute; top: 14px; left: 50%; width: 64px; height: 6px; margin-left: -32px; border-radius: 3px; background: #2a2a34; }
  .phone::after { content: ""; position: absolute; top: 12px; left: 50%; margin-left: 50px; width: 9px; height: 9px; border-radius: 50%; background: #22222b; box-shadow: inset 0 0 0 2px #2d2d38; }
  .screen { width: ${SCREEN.width}px; height: ${SCREEN.height}px; border-radius: 32px; overflow: hidden; background: #fff; }
  .screen img { display: block; width: ${SCREEN.width}px; height: ${SCREEN.height}px; }
  /* Side buttons: volume on the left, power on the right. */
  .btn { position: absolute; width: 4px; border-radius: 2px; background: #2a2a34; }
  .vol1 { left: -5px; top: 150px; height: 56px; }
  .vol2 { left: -5px; top: 222px; height: 56px; }
  .pwr { right: -5px; top: 190px; height: 84px; }
</style>
<div class="wrap" id="frame">
  <div class="phone">
    <div class="btn vol1"></div><div class="btn vol2"></div><div class="btn pwr"></div>
    <div class="screen"><img id="shot" src="${dataUri}" alt=""></div>
  </div>
</div>`;

const browser = await chromium.launch(process.env.WALK_CHROMIUM ? { executablePath: process.env.WALK_CHROMIUM } : {});
try {
  for (const name of names) {
    const src = path.join(root, 'docs', 'screenshots', `${name}.png`);
    if (!fs.existsSync(src)) throw new Error(`missing ${src}`);
    const png = fs.readFileSync(src);
    // PNG header: width at bytes 16-19, height at 20-23. Refuse a screenshot that is not 390 x 844 at 2x, so a
    // changed capture size shows up here instead of as a stretched picture inside the frame.
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    if (w !== SCREEN.width * 2 || h !== SCREEN.height * 2) {
      throw new Error(`${name}.png is ${w}x${h}; expected ${SCREEN.width * 2}x${SCREEN.height * 2} (capture.mjs PHONE viewport at 2x)`);
    }
    const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 600, height: 1100 } });
    const page = await ctx.newPage();
    await page.setContent(page_html(`data:image/png;base64,${png.toString('base64')}`));
    await page.waitForFunction(() => document.getElementById('shot').complete && document.getElementById('shot').naturalWidth > 0);
    await page.locator('#frame').screenshot({ path: path.join(outDir, `${name}.png`), omitBackground: true });
    await ctx.close();
    console.log(`framed ${name}`);
  }
} finally {
  await browser.close();
}
