// The peri palette (owner, 2026-11-05: #8995FF is the app's main colour). Peri is a light colour: white text on it is 2.69:1
// (WCAG wants 4.5:1) and as a thin line on a light surface it is also below 3:1. So text ON a peri fill must be --on-accent
// (navy), and lines, rings and icons on light surfaces must be --accent-line. Nothing renders these in jsdom, so the tests
// read the stylesheet's rules by their tokens (comments stripped, so a reformat or a comment cannot break them), with a guard that the
// stylesheet was really read. The numbers themselves are in docs/design-language.md section 1.
import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Avatar from '../src/components/Avatar.jsx';

const raw = readFileSync(join(process.cwd(), 'src', 'index.css'), 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = css.split('}').map((rule) => rule.replace(/\s+/g, ' ').trim());

describe('the peri palette', () => {
  test('the stylesheet was read, and the tokens are defined', () => {
    expect(rules.length).toBeGreaterThan(500);
    expect(css).toMatch(/--accent:\s*#8995ff;/i);
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

describe('the default avatar', () => {
  test('★ initials on the default peri disc are navy; on a chosen colour they stay white', () => {
    const plain = render(<Avatar name="Nanny McPhee" />).container.querySelector('span');
    expect(plain.style.background).toContain('var(--accent)');
    expect(plain.style.color).toBe('var(--on-accent)');
    const chosen = render(<Avatar name="Nanny McPhee" color="#7FBFA3" />).container.querySelectorAll('span');
    expect([...chosen].some((el) => el.style.color === 'rgb(255, 255, 255)')).toBe(true);
  });
});
