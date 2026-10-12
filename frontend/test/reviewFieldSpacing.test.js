// The "Was this right?" edit card's field spacing.
//
// ⚠️ WHAT THIS DOES AND DOES NOT PROVE. jsdom loads no stylesheet and does no layout, so a test cannot see
// a gap. This reads the stylesheet's TEXT and asserts the two rules the card's spacing rests on are there.
// It catches the rules being deleted or reverted; it does not prove they render right (not browser-checked).
//
// Why the two rules matter (owner, staging, 2026-10): the card writes each field as
//   <label class="field"><span class="field__label">Text</span><input></label>
// and (1) a <label> is INLINE, so `.field`'s bottom margin did nothing and the "No one was in the bed"
// button sat flush against the note input above it; (2) `.field label` cannot match when `.field` IS the
// label, and `.field__label` had no rule, so the text sat inline and tight against its input.

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
    if (sel === wanted) return m[2];
  }
  return null;
}

describe('review edit card field spacing', () => {
  test('★ `.field` is a block, so its bottom margin separates a field from the button below it', () => {
    const body = declarationsOf('.field');
    expect(body).not.toBeNull();
    expect(body).toMatch(/display:\s*block/);
    expect(body).toMatch(/margin-bottom:\s*14px/);
  });

  test('★ `.field__label` is styled like `.field label`: block, small, secondary colour, 6px above the input', () => {
    const body = declarationsOf('.field label, .field__label');
    expect(body).not.toBeNull();
    expect(body).toMatch(/display:\s*block/);
    expect(body).toMatch(/font-size:\s*12px/);
    expect(body).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(body).toMatch(/margin-bottom:\s*6px/);
  });
});
