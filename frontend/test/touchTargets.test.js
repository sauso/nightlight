// Touch targets on the camera tile (#381): the seven over-video controls and the drag handle.
//
// ⚠️ WHAT THIS DOES AND DOES NOT PROVE. jsdom loads no stylesheet and does no layout, so a test cannot see
// a tap land. This reads the stylesheet's TEXT and asserts the rules the 44px hit areas rest on are there,
// and that the buttons are spaced so those areas do not overlap. It catches a rule being deleted, a number
// being changed, or one button being moved without its neighbour; it does NOT prove the result renders or
// feels right on a phone (not browser-checked in this suite).
//
// Why the arithmetic is asserted and not just the rules: a 30px button grown to 44px by an invisible
// ::after (7px each side) used to sit 8px from its neighbour (a 30 + 8 = 38px pitch), so the two enlarged
// areas would overlap by 6px and a tap in that strip could land on the wrong control (Record instead of
// Mute). The three inner buttons therefore moved from 48px to 54px from the edge.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `process.cwd()` is the frontend folder (vitest runs from there, locally and in CI): under the jsdom
// environment `import.meta.url` is not a file: URL, so the usual relative-to-this-file lookup throws.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\r\n/g, '\n');

// The declarations of the first rule whose selector list is exactly `selectors` (comma separated).
function declarationsOf(selectors) {
  const wanted = selectors.split(',').map((s) => s.trim()).join(',');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim()).join(',');
    if (sel === wanted) return m[2].replace(/\/\*[\s\S]*?\*\//g, '');
  }
  return null;
}
const px = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*(-?\\d+(?:\\.\\d+)?)px`));
  return m ? Number(m[1]) : null;
};

const INSET = 7; // the ::after reaches this far past each edge of a 30px control: 30 + 2*7 = 44
const OVER_VIDEO = ['.mute-btn', '.talk-btn', '.pip-btn', '.settings-btn', '.fullscreen-btn', '.ptz-btn', '.rec-btn'];

describe('★ the over-video controls have a 44px hit area (#381)', () => {
  test('one shared ::after rule covers all seven, invisible, 7px past each edge', () => {
    const body = declarationsOf(OVER_VIDEO.map((s) => `${s}::after`).join(','));
    expect(body, 'a rule whose selector list is exactly the seven buttons\' ::after').not.toBeNull();
    expect(body).toMatch(/content:\s*''/);
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/inset:\s*-7px/);
    // Invisible: a background or border here would draw a visible box around a bare icon.
    expect(body).not.toMatch(/background|border|box-shadow|outline/);
    // ...and still HIT: `pointer-events: none` (or display/visibility hiding) keeps the pseudo-element in
    // the stylesheet but makes it unable to receive a tap, so every assertion above would still pass.
    expect(body).not.toMatch(/pointer-events:\s*none/);
    expect(body).not.toMatch(/display:\s*none/);
    expect(body).not.toMatch(/visibility:\s*hidden/);
  });

  test('★ every one of the seven is itself position:absolute, which is what the ::after positions against', () => {
    for (const sel of OVER_VIDEO) {
      const body = declarationsOf(sel);
      expect(body, `${sel} has its own rule`).not.toBeNull();
      expect(body, `${sel} is positioned`).toMatch(/position:\s*absolute/);
    }
  });

  test('the visible control is still 30px (icons unchanged: only the tappable area grew)', () => {
    for (const sel of OVER_VIDEO.filter((s) => s !== '.rec-btn')) {
      expect(px(declarationsOf(sel), 'width'), `${sel} width`).toBe(30);
      expect(px(declarationsOf(sel), 'height'), `${sel} height`).toBe(30);
    }
    // .rec-btn widens while recording (it shows the elapsed time), so its floor is what is pinned.
    expect(px(declarationsOf('.rec-btn'), 'height')).toBe(30);
    expect(px(declarationsOf('.rec-btn'), 'min-width')).toBe(30);
  });

  test('★★ neighbours are far enough apart that the enlarged areas touch but do not overlap', () => {
    // Outer buttons hug the corner at 10px. The inner one must clear the outer one's edge (10 + 30)
    // by at least 2 * INSET, or their ::after areas overlap.
    const outerRight = px(declarationsOf('.mute-btn'), 'right'); // top row, right
    expect(outerRight).toBe(10);
    expect(px(declarationsOf('.fullscreen-btn'), 'right')).toBe(10); // bottom row, right
    expect(px(declarationsOf('.settings-btn'), 'left')).toBe(10); // bottom row, left

    const pairs = [
      ['.rec-btn', 'right', outerRight], // beside Mute, top right
      ['.pip-btn', 'right', 10], // beside Fullscreen, bottom right
      ['.ptz-btn', 'left', 10], // beside Settings, bottom left
    ];
    for (const [sel, side, outerOffset] of pairs) {
      const inner = px(declarationsOf(sel), side);
      const gap = inner - (outerOffset + 30);
      expect(gap, `${sel} sits ${gap}px from its neighbour; needs >= ${2 * INSET}px`).toBeGreaterThanOrEqual(2 * INSET);
    }
  });
});

describe('★ the drag handle has a 44px hit area (#381)', () => {
  test('.drag-handle is the positioning anchor, and its ::after reaches 10px past each edge (24 + 2*10 = 44)', () => {
    expect(declarationsOf('.drag-handle')).toMatch(/position:\s*relative/);
    const after = declarationsOf('.drag-handle::after');
    expect(after, 'a .drag-handle::after rule').not.toBeNull();
    expect(after).toMatch(/content:\s*''/);
    expect(after).toMatch(/position:\s*absolute/);
    expect(after).toMatch(/inset:\s*-10px/);
    expect(after).not.toMatch(/background|border|box-shadow|outline/);
    // Must still receive the tap: see the same assertion on the tile buttons' rule above.
    expect(after).not.toMatch(/pointer-events:\s*none/);
    expect(after).not.toMatch(/display:\s*none/);
    expect(after).not.toMatch(/visibility:\s*hidden/);
  });

  test('it keeps touch-action:none (a drag must not scroll the page), which the pseudo-element inherits', () => {
    expect(declarationsOf('.drag-handle')).toMatch(/touch-action:\s*none/);
  });
});
