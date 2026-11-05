// The peri palette (owner: #8995FF on 2026-11-05, then #5663D6 by day on 2026-11-06 with white button text, dark mode keeping #8995FF
// with dark text). Text ON an accent fill must always be --on-accent, because the two themes need different colours (white on
// #5663D6 is 5.06:1; navy on #8995FF is 6.71:1; the other two pairings fail). Lines, rings and icons use --accent-line. Nothing
// renders these in jsdom, so the tests read the stylesheet's rules by their tokens (comments stripped, so a reformat or a
// comment cannot break them), with a guard that the stylesheet was really read, and they RECOMPUTE the WCAG contrast from the
// stylesheet's own token values, so changing a colour cannot silently make something unreadable. The numbers themselves are in
// docs/design-language.md section 1.
import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Avatar from '../src/components/Avatar.jsx';

const raw = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = css.split('}').map((rule) => rule.replace(/\s+/g, ' ').trim());

// The tokens as the stylesheet defines them: `day` is the :root block; `night` is the day values overridden by the dark block.
function tokens(block) {
  const out = {};
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[match[1]] = match[2].toLowerCase();
  return out;
}
const dayBlock = rules.find((rule) => rule.startsWith(':root {') && rule.includes('--accent:'));
const nightBlock = rules.find((rule) => rule.startsWith(":root[data-theme='dark'] {") && rule.includes('--accent-text'));
const day = tokens(dayBlock || '');
const night = { ...day, ...tokens(nightBlock || '') };

// WCAG 2.x relative luminance and contrast ratio.
const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe('the peri palette', () => {
  test('the stylesheet was read, and the tokens are defined', () => {
    expect(rules.length).toBeGreaterThan(500);
    expect(day['--accent'], 'by day the accent is #5663d6').toBe('#5663d6');
    expect(night['--accent'], 'at night it is the lighter #8995ff').toBe('#8995ff');
    for (const token of ['--on-accent', '--accent-line', '--accent-text', '--complement', '--on-complement']) {
      expect(css, `${token} is defined`).toContain(`${token}:`);
    }
    // The dark theme redefines the ones that need a lighter value on a dark surface.
    const dark = rules.find((rule) => rule.includes(":root[data-theme='dark']") && rule.includes('--accent-text'));
    expect(dark, 'a dark theme block with --accent-text').toBeTruthy();
    expect(dark).toContain('--accent-line:');
  });

  test('★ no rule puts white text on a peri fill (white on peri is 2.69:1)', () => {
    // Also the light page colours used as text (`color: var(--bg)` was one: near-white by day), which is white in all but name.
    const offenders = rules.filter((rule) => /background:\s*var\(--accent\)\s*;/.test(rule)
      && /(^|[ ;{])color:\s*(#fff(fff)?|white|var\(--bg\)|var\(--bg-elevated\))\s*;/i.test(rule));
    expect(offenders, `white or near-white text on the accent fill: ${offenders.join(' | ')}`).toEqual([]);
  });

  test('★ the primary button, the selected chip and the active toggle use --on-accent for their text', () => {
    for (const selector of ['.btn-primary', '.btn-peri', '.segmented__btn--active', '.detect-toggle--on', '.log-chip--active', '.clip-cal__done']) {
      const rule = rules.find((r) => r.includes(`${selector} {`) && r.includes('background'));
      expect(rule, `${selector} has a rule`).toBeTruthy();
      expect(rule, `${selector} text colour`).toContain('color: var(--on-accent)');
    }
  });

  test('★ focus rings use --accent-line, never the plain peri (2.69:1 on white)', () => {
    const plain = rules.filter((rule) => /outline:\s*2px solid var\(--accent\)\s*;/.test(rule));
    expect(plain, `focus ring in plain peri: ${plain.join(' | ')}`).toEqual([]);
    expect(rules.filter((rule) => /outline:\s*2px solid var\(--accent-line\)/.test(rule)).length).toBeGreaterThan(5);
  });

  test('the complement is a small highlight: the Recommended badge, the current setup step and the avatar badge border', () => {
    const using = rules.filter((rule) => rule.includes('var(--complement)')).map((rule) => rule.split('{')[0].trim());
    expect(using.sort()).toEqual([
      '.avatar-editor__badge',
      '.setup-progress .is-current',
      '.status-badge--highlight',
    ].sort());
  });
});

describe('readability, recomputed from the stylesheet\'s own tokens', () => {
  test('the tokens were found in both blocks', () => {
    for (const key of ['--bg', '--bg-elevated', '--bg-elevated-2', '--accent', '--on-accent', '--accent-text', '--accent-line', '--accent-soft', '--complement', '--on-complement', '--bar']) {
      expect(day[key], `day ${key}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(night[key], `night ${key}`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test.each([['day', day], ['night', night]])('★ %s: text on an accent fill is readable (4.5:1)', (_name, t) => {
    expect(contrast(t['--on-accent'], t['--accent'])).toBeGreaterThanOrEqual(4.5);
  });

  test.each([['day', day], ['night', night]])('★ %s: small accent text is readable on the card, the page and the inset (4.5:1)', (_name, t) => {
    for (const surface of ['--bg-elevated', '--bg', '--bg-elevated-2']) {
      expect(contrast(t['--accent-text'], t[surface]), `--accent-text on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.each([['day', day], ['night', night]])('★ %s: lines, rings and icons show against the card and the page (3:1)', (_name, t) => {
    for (const surface of ['--bg-elevated', '--bg']) {
      expect(contrast(t['--accent-line'], t[surface]), `--accent-line on ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  test.each([['day', day], ['night', night]])('%s: text on the complement fill and the header controls are readable (4.5:1)', (_name, t) => {
    expect(contrast(t['--on-complement'], t['--complement'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t['--accent-soft'], t['--bar'])).toBeGreaterThanOrEqual(4.5);
  });

  test('★ the logo\'s crescent is the day accent (owner, 2026-11-06: the colour updates on the logo as well as everywhere else)', () => {
    const svg = readFileSync(join(process.cwd(), 'public', 'icons', 'nightlight-logo.svg'), 'utf8');
    const fills = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((match) => match[1].toLowerCase());
    expect(fills, 'the logo has its crescent colour').toContain(day['--accent']);
    expect(fills.filter((fill) => fill !== '#f8f8ff' && fill !== day['--accent']), 'and no other colour than the baby white').toEqual([]);
  });
});

describe('the setup screens (owner, 2026-11-06)', () => {
  const ruleFor = (selector) => rules.find((rule) => rule.startsWith(`${selector} {`)) || '';

  test('★ the strip under the phone\'s status bar is the navy header colour, never the page colour (light icons vanished on the light page)', () => {
    const strip = ruleFor('html.setup-wizard body::before');
    expect(strip, 'the strip rule was found').toContain('position: fixed');
    expect(strip).toContain('height: env(safe-area-inset-top');
    expect(strip).toContain('background: var(--bar)');
    expect(strip).not.toContain('var(--bg)');
    // --bar is one colour in both themes (defined once, in :root), and it is dark enough for light icons.
    expect(night['--bar']).toBe(day['--bar']);
    expect(contrast('#ffffff', day['--bar'])).toBeGreaterThanOrEqual(7);
  });

  test('★ the avatar is centred on the account and caregiver forms: a column whose items are centred', () => {
    const photo = ruleFor('.setup-caregivers__photo');
    expect(photo, 'the rule was found').toContain('display: flex');
    expect(photo).toContain('flex-direction: column');
    expect(photo).toContain('align-items: center');
  });
});

describe('a lit control keeps its text colour while hovered (owner, 2026-11-06)', () => {
  // A phone leaves a tapped button in :hover, and `.x:hover` (two selectors' worth of specificity) beat the single-class lit rule, so
  // a just-tapped Alerts toggle showed white (dark mode) or navy (light mode) text on the accent fill. jsdom cannot apply :hover, so
  // the test reads the stylesheet: the hover rule must exclude the lit class, and the lit rule must set --on-accent text.
  test.each([
    ['.detect-toggle', '.detect-toggle--on'],
    ['.log-chip', '.log-chip--active'],
  ])('★ %s:hover leaves the lit %s alone, and the lit rule sets --on-accent text', (base, lit) => {
    const hover = rules.find((rule) => rule.startsWith(`${base}:hover`));
    const on = rules.find((rule) => rule.startsWith(`${lit} {`));
    expect(hover, 'the hover rule was found').toBeTruthy();
    expect(on, 'the lit rule was found').toBeTruthy();
    expect(hover.slice(0, hover.indexOf(' {'))).toContain(`:not(${lit})`);
    expect(on).toContain('color: var(--on-accent)');
  });
});

describe('the default avatar', () => {
  test('★ initials on the default peri disc are navy; on a chosen colour they stay white', () => {
    const plain = render(<Avatar name="Nanny McPhee" />).container.querySelector('span');
    expect(plain.style.background).toContain('var(--accent)');
    expect(plain.style.color).toBe('var(--on-accent)');
    const chosen = render(<Avatar name="Nanny McPhee" color="#7FBFA3" />).container.querySelectorAll('span');
    expect([...chosen].some((el) => el.style.color === 'rgb(255, 255, 255)')).toBe(true);
  });
});
