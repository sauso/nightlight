// The peri palette (owner: #8995FF on 2026-11-05, then #5663D6 by day on 2026-11-06 with white button text, dark mode keeping #8995FF
// with dark text). Text ON an accent fill must always be --on-accent, because the two themes need different colours (white on
// #5663D6 is 5.06:1; navy on #8995FF is 6.71:1; the other two pairings fail). Lines, rings and icons use --accent-line. Nothing
// renders these in jsdom, so the tests read the stylesheet's rules by their tokens (comments stripped, so a reformat or a
// comment cannot break them), with a guard that the stylesheet was really read, and they RECOMPUTE the WCAG contrast from the
// stylesheet's own token values, so changing a colour cannot silently make something unreadable. The numbers themselves are in
// docs/design-language.md section 1.
import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
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
// Every `:root {` rule and every `:root[data-theme='dark'] {` rule, in stylesheet order, LAST declaration of a token winning, which is
// what the browser does (same specificity, later wins). Reading only the first matching block would miss a later override that
// the page actually shows (found in review, 2026-11-12). `dark` is the dark rules alone, for "this token is not redefined at night".
function themeTokens(ruleList) {
  const dayTokens = {};
  const dark = {};
  for (const rule of ruleList) {
    if (rule.startsWith(':root {')) Object.assign(dayTokens, tokens(rule));
    else if (rule.startsWith(":root[data-theme='dark'] {")) Object.assign(dark, tokens(rule));
  }
  return { day: dayTokens, dark, night: { ...dayTokens, ...dark } };
}
const resolved = themeTokens(rules);
const { day, night, dark: darkOnly } = resolved;

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

  test('★ the logo\'s crescent is #778ffd, its own colour and deliberately NOT the accent (owner, 2026-11-06: "the logo only needs to be 778ffd")', () => {
    const svg = readFileSync(join(process.cwd(), 'public', 'icons', 'nightlight-logo.svg'), 'utf8');
    const fills = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((match) => match[1].toLowerCase());
    expect(fills, 'the logo has its crescent colour').toContain('#778ffd');
    expect(fills.filter((fill) => fill !== '#f8f8ff' && fill !== '#778ffd'), 'and no other colour than the baby white').toEqual([]);
    expect(day['--accent'], 'buttons keep their own colour').not.toBe('#778ffd');
  });
});

// The navy neutrals with the band and timeline accent colours (owner, 2026-11-13, design v3; a warm-grey trial on 2026-11-12 was
// rejected). Everything below is read from the stylesheet, so a colour edit that breaks readability fails here rather than on a
// phone. The band tokens are defined but no component uses them yet (the next change does).
const BANDS = ['great', 'good', 'fair', 'low', 'early'];
// The timeline tokens sit in their own :root rules further down the sheet; themeTokens merges every such rule.
const sleepDay = day;
const sleepNight = night;
const nightRule = rules.find((rule) => rule.startsWith('.night {')) || '';
const nightTokens = tokens(nightRule);
// The @supports blocks of the stylesheet (comments already stripped), found by brace matching because they nest rules: the
// condition, the text inside, and the stylesheet with every such block cut out.
const supportsBlocks = [];
let outsideSupports = css;
{
  const re = /@supports\s*([^{]*)\{/g;
  let m;
  const cuts = [];
  while ((m = re.exec(css))) {
    let depth = 1; let i = re.lastIndex;
    while (i < css.length && depth > 0) { if (css[i] === '{') depth += 1; else if (css[i] === '}') depth -= 1; i += 1; }
    supportsBlocks.push({ condition: m[1].trim(), inner: css.slice(re.lastIndex, i - 1) });
    cuts.push([m.index, i]);
    re.lastIndex = i;
  }
  for (const [from, to] of cuts.reverse()) outsideSupports = outsideSupports.slice(0, from) + outsideSupports.slice(to);
}
const stops = [...nightRule.matchAll(/linear-gradient\([^)]*?(#[0-9a-fA-F]{6}) 0%, (#[0-9a-fA-F]{6}) 100%\)/g)][0]?.slice(1, 3).map((s) => s.toLowerCase()) || [];
const [gradientLight, gradientDark] = stops;
const trackMatch = (rules.find((rule) => rule.startsWith('.score-ring--dark .score-ring__track {')) || '').match(/stroke:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/);
// The ring's track as it composites over a point of the gradient: the track is translucent, so its colour depends on what is under it.
const overHex = (rgba, under) => {
  const base = [(parseInt(under.slice(1), 16) >> 16) & 255, (parseInt(under.slice(1), 16) >> 8) & 255, parseInt(under.slice(1), 16) & 255];
  const [r, g, b, a] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  return `#${[r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
};
// A colour laid over another at some opacity (color-mix in srgb does the same in the browser): used for the 15% tag tints and the
// ring's 12% wash, so the text on them is measured on what is really drawn, not on the bare card.
const tint = (fg, alpha, under) => {
  const f = [(parseInt(fg.slice(1), 16) >> 16) & 255, (parseInt(fg.slice(1), 16) >> 8) & 255, parseInt(fg.slice(1), 16) & 255];
  const u = [(parseInt(under.slice(1), 16) >> 16) & 255, (parseInt(under.slice(1), 16) >> 8) & 255, parseInt(under.slice(1), 16) & 255];
  return `#${f.map((v, i) => Math.round(v * alpha + u[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
};
const round2 = (n) => Math.round(n * 100) / 100;

describe('the navy neutrals and the band colours (owner, 2026-11-13, design v3)', () => {
  test('★ the original navy and lavender neutrals are in the token blocks, and none of the warm trial is left', () => {
    const expected = {
      day: { '--bg': '#f7f4fd', '--bg-elevated': '#ffffff', '--bg-elevated-2': '#eae3f8', '--field-bg': '#eae3f8', '--text-primary': '#1d1a3a', '--text-secondary': '#625c7f', '--border': '#ddd5ee', '--on-accent': '#ffffff' },
      night: { '--bg': '#14142a', '--bg-elevated': '#221f3c', '--bg-elevated-2': '#100f1c', '--field-bg': '#100f1c', '--text-primary': '#e8e2f7', '--text-secondary': '#bcb3d5', '--border': '#383450', '--on-accent': '#14142a' },
    };
    for (const [name, t] of [['day', day], ['night', night]]) {
      for (const [token, value] of Object.entries(expected[name])) expect(t[token], `${name} ${token}`).toBe(value);
    }
    expect(day['--bar'], 'the header is one navy in both themes').toBe('#14142a');
    expect(night['--bar']).toBe('#14142a');
    expect(day['--on-complement']).toBe('#14142a');
    // The warm trial's literals, by value, anywhere in the stylesheet (comments are stripped from `css`): a restored one is caught.
    for (const warm of ['#1a1618', '#262024', '#121011', '#f8f5f0', '#fffdf9', '#efe8df', '#241f24', '#f0e9e3', '#6b6158', '#c4b9af', '#e5dcd1', '#3d3439', '#1f1a1e', '#efe8e2', '#352b3a', '#1e191f', '#d6ccd3', '#2f2733', '#161115', '#ccc3b8', '#c4688a', '#126067']) {
      expect(css.toLowerCase(), `${warm} (from the warm trial) is gone from the stylesheet`).not.toContain(warm);
    }
    expect(css, 'the warm overlays and shadows are gone').not.toMatch(/rgba\((?:10, 8, 12, 0\.(?:55|7)|40, 28, 30|16, 10, 18)\b/);
  });

  test('the page\'s theme-color meta is the header navy, as --bar is', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const meta = html.match(/<meta name="theme-color" content="(#[0-9a-fA-F]{6})"/);
    expect(meta, 'a theme-color meta exists').toBeTruthy();
    expect(meta[1].toLowerCase()).toBe(day['--bar']);
  });

  test.each([['day', day], ['night', night]])('★ %s: primary and secondary text are readable on the page, the card and the inset (4.5:1)', (_name, t) => {
    for (const text of ['--text-primary', '--text-secondary']) {
      for (const surface of ['--bg', '--bg-elevated', '--bg-elevated-2']) {
        expect(contrast(t[text], t[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('the header text and its controls are readable on --bar in both themes (4.5:1)', () => {
    for (const t of [day, night]) {
      expect(contrast(t['--bar-text'], t['--bar'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t['--accent-soft'], t['--bar'])).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('every band has a card mark, and a ring mark that does not switch with the theme', () => {
    for (const band of BANDS) {
      expect(day[`--band-${band}`], `day --band-${band}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(night[`--band-${band}`], `night --band-${band}`).toMatch(/^#[0-9a-f]{6}$/);
      expect(day[`--band-${band}-ring`], `--band-${band}-ring`).toMatch(/^#[0-9a-f]{6}$/);
      // The ring variants live in :root only: the card they sit on is the same in both themes, so the dark block must not redefine them.
      expect(darkOnly[`--band-${band}-ring`], `--band-${band}-ring must not be redefined at night`).toBeUndefined();
      expect(night[`--band-${band}-ring`]).toBe(day[`--band-${band}-ring`]);
    }
  });

  test('★ the band colours are the approved v3 values (the floors below say they are readable; this says they are the designer\'s)', () => {
    const pick = (t, suffix = '') => BANDS.map((band) => t[`--band-${band}${suffix}`]);
    expect(pick(day), 'day marks: great, good, fair, low, early').toEqual(['#1e6b3d', '#0f555c', '#a36a10', '#b85a7e', '#7a7496']);
    expect(pick(night), 'night marks').toEqual(['#a8edbe', '#5cbfc6', '#d99c50', '#c77790', '#d3cde6']);
    expect(pick(day, '-ring'), 'ring marks on the navy card').toEqual(['#a8edbe', '#5cbfc6', '#d99c50', '#c77790', '#d3cde6']);
  });

  test('★ the palette tokens are declared ONLY in the two theme blocks (and --night-* only on .night): a later override elsewhere would change the real colour unseen by these tests', () => {
    // The token reader above reads exactly `:root` and `:root[data-theme='dark']`, so a declaration anywhere else
    // (for instance `html[data-theme='dark'] { --bg: ... }`, which has higher specificity) would win in the browser and be invisible
    // here. Every place that declares one of the pinned tokens is therefore listed; the only deliberate exceptions are named:
    //   .night  declares the --night-* custom properties (and nothing else of the palette), by design.
    // There are no others on this branch. Custom properties set in JSX style props are out of reach of this check.
    const pinned = /^--(?:bg|bg-elevated|bg-elevated-2|field-bg|text-primary|text-secondary|border|bar|bar-text|on-accent|band-[a-z-]+|sleep-[a-z-]+|night-[a-z-]+)$/;
    //   .night--<band> sets --night-tint (the tint colour, one of that band's --band-*-ring tokens) inside the @supports block that
    //           guards color-mix; the next test and "each band class feeds the tint from its own ring colour" pin its value.
    const allowed = (selector, token) => {
      const plain = selector.replace(/^@supports[^{]*\{\s*/, ''); // the first rule of a block carries the block's prefix
      return selector === ':root' || selector === ":root[data-theme='dark']" || (selector === '.night' && token.startsWith('--night-'))
        || (/^\.night--(?:great|good|fair|low|early)$/.test(plain) && token === '--night-tint');
    };
    const stray = [];
    for (const rule of rules) {
      const at = rule.lastIndexOf('{');
      if (at < 0) continue;
      const selector = rule.slice(0, at).trim();
      for (const [, token] of rule.slice(at + 1).matchAll(/(?:^|[\s;])(--[a-z0-9-]+)\s*:/g)) {
        if (pinned.test(token) && !allowed(selector, token)) stray.push(`${selector} { ${token} }`);
      }
    }
    expect(stray, `palette tokens declared outside the two theme blocks: ${stray.join(' | ')}`).toEqual([]);
    // And the night card's gradient is declared once: a second `.night` background rule would repaint it unseen by the stop reader.
    const gradientRules = rules.filter((rule) => {
      const at = rule.lastIndexOf('{');
      return at >= 0 && /\.night(?![\w-])/.test(rule.slice(0, at)) && /background(?:-image)?:[^;]*gradient/.test(rule.slice(at + 1));
    });
    expect(gradientRules.length, `.night gradient rules: ${gradientRules.join(' | ')}`).toBe(1);
  });

  test('★ text is never set in a band colour: no rule uses a --band-* token for `color`', () => {
    const offenders = rules.filter((rule) => /(^|[ ;{])color:\s*var\(--band-/.test(rule));
    expect(offenders, `band colour used as text: ${offenders.join(' | ')}`).toEqual([]);
  });

  test('the child card\'s gradient and its ring track were read from the stylesheet', () => {
    expect(gradientLight, 'gradient start').toBe('#2c2f63');
    expect(gradientDark, 'gradient end').toBe('#191b38');
    expect(trackMatch, 'the .score-ring--dark track rule').toBeTruthy();
    expect(gradientLight, 'the gradient must run light to dark: the start is where contrast is lowest for light marks').not.toBe(gradientDark);
    expect(luminance(gradientLight)).toBeGreaterThan(luminance(gradientDark));
  });

  test.each(BANDS)('★ the %s ring colour is a graphic on the night card: 3:1 on both gradient stops and on its track', (band) => {
    const ring = day[`--band-${band}-ring`];
    for (const stop of [gradientLight, gradientDark]) {
      expect(contrast(ring, stop), `${band} ring on the gradient at ${stop}`).toBeGreaterThanOrEqual(3);
      expect(contrast(ring, overHex(trackMatch, stop)), `${band} ring on its track over ${stop}`).toBeGreaterThanOrEqual(3);
    }
  });

  test.each([['day', day], ['night', night]])('★ %s: every band mark is a graphic on the card and on the inset track (3:1)', (_name, t) => {
    for (const band of BANDS) {
      for (const surface of ['--bg-elevated', '--bg-elevated-2']) {
        expect(contrast(t[`--band-${band}`], t[surface]), `--band-${band} on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  // The ring on a themed card sits on the TRACK THE CSS REALLY DRAWS: `.score-ring__track { stroke: var(--border) }`, not the inset
  // colour the bars will use (the test above). Codex review of #1055: it had been checked only against --bg-elevated-2, and on the
  // warm trial palette the day rose arc was 2.72:1 on its real track. On the navy design v3 palette every pair clears 3:1 (weakest:
  // day rose #b85a7e 3.09, day early #7a7496 3.11, day fair #a36a10 3.20), so there is no exception. If a palette change drops a
  // pair under 3:1 again, the way out is a NAMED, MEASURED exception here and in docs/design-language.md, not a looser floor.
  test.each([['day', day], ['night', night]])('★ %s: each band arc shows on the card (3:1) and on the --border track the ring draws (3:1)', (_name, t) => {
    expect(rules.find((r) => r.startsWith('.score-ring__track {')), 'the card ring track is --border').toContain('stroke: var(--border)');
    for (const band of BANDS) {
      const arc = t[`--band-${band}`];
      expect(contrast(arc, t['--bg-elevated']), `${band} arc on the card`).toBeGreaterThanOrEqual(3);
      expect(contrast(arc, t['--border']), `${band} arc on the --border track`).toBeGreaterThanOrEqual(3);
    }
  });

  test('★ the night card\'s text tints are readable on its lightest stop, where contrast is lowest (4.5:1)', () => {
    for (const token of ['--night-text', '--night-muted', '--night-link', '--night-number']) {
      expect(nightTokens[token], `${token} is defined on .night`).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrast(nightTokens[token], gradientLight), `${token} on ${gradientLight}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // The morning question's buttons on the night card (UI refresh PR C). The card is the same navy in both themes, so the primary
  // takes its own pair rather than the theme's --accent / --on-accent: its label must be readable on the fill (4.5:1) and the fill
  // must stand off the card as a control (3:1) on the lightest stop and on every band's washed corner.
  test.each(BANDS)('★ the night card\'s primary action: dark label on its fill (4.5:1), and the fill off the card (3:1), with the %s wash', (band) => {
    expect(nightTokens['--night-action'], '--night-action is defined on .night').toMatch(/^#[0-9a-f]{6}$/);
    expect(nightTokens['--night-on-action'], '--night-on-action is defined on .night').toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(nightTokens['--night-on-action'], nightTokens['--night-action'])).toBeGreaterThanOrEqual(4.5);
    const washed = tint(day[`--band-${band}-ring`], 0.12, gradientLight);
    expect(contrast(nightTokens['--night-action'], gradientLight)).toBeGreaterThanOrEqual(3);
    expect(contrast(nightTokens['--night-action'], washed)).toBeGreaterThanOrEqual(3);
  });

  test.each(BANDS)('★ the muted text still clears 5:1 where the ring\'s 12%% %s wash lightens the card (the design\'s figure is 5.07)', (band) => {
    // Lowest contrast on the card is the lightest stop with the band colour laid over it at 12% (the design's "washed corner").
    const washed = tint(day[`--band-${band}-ring`], 0.12, gradientLight);
    expect(contrast(nightTokens['--night-muted'], washed), `muted on the card washed by ${band}`).toBeGreaterThanOrEqual(5);
  });

  // The child card's band tint (owner approved the colour-scaled design, 2026-11-12): a flat layer of the band's ring colour at
  // N% over the gradient. Its alpha is read from the stylesheet, so changing it re-runs the readability numbers below.
  // The tint rules live inside an @supports block (see the next test for why); the alpha is read from the rule that paints it.
  const tintBlocks = supportsBlocks.filter((b) => /color-mix/.test(b.condition));
  const tintRules = tintBlocks.flatMap((b) => b.inner.split('}').map((rule) => rule.replace(/\s+/g, ' ').trim()));
  const tintPaint = tintRules.find((r) => /^\.night--[a-z]+.*\{ background:/.test(r)) || '';
  const tintAlpha = Number((tintPaint.match(/color-mix\(in srgb, var\(--night-tint\) (\d+)%, transparent\)/) || [])[1]) / 100;
  const hexToRgb = (hex) => [(parseInt(hex.slice(1), 16) >> 16) & 255, (parseInt(hex.slice(1), 16) >> 8) & 255, parseInt(hex.slice(1), 16) & 255];
  const blend = (fg, alpha, under) => {
    const f = hexToRgb(fg); const u = hexToRgb(under);
    return `#${f.map((v, i) => Math.round(v * alpha + u[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
  };

  test('the tint alpha was read, is subtle, and each band class feeds the tint from its own ring colour', () => {
    expect(tintAlpha, 'the 12% was read from the tint rule').toBeGreaterThan(0);
    expect(tintAlpha, 'a wash, not a fill').toBeLessThanOrEqual(0.15);
    for (const band of BANDS) {
      const rule = tintRules.find((r) => r.replace(/^@supports[^{]*\{ /, '').startsWith(`.night--${band} {`));
      expect(rule, `.night--${band} has a rule`).toBeTruthy();
      expect(rule, `.night--${band} uses its own ring colour`).toContain(`--night-tint: var(--band-${band}-ring)`);
    }
    // The wash sits in the background layers, above the gradient, so it can never cover text or take a tap.
    expect(tintPaint).toMatch(/background: linear-gradient\(color-mix\(.*?\), color-mix\(.*?\)\), linear-gradient\(165deg/);
  });

  test('★ the tinted background repeats the SAME gradient as the plain card (a drifted copy would change the card only when a score shows)', () => {
    const tintStops = [...tintPaint.matchAll(/linear-gradient\(165deg, (#[0-9a-fA-F]{6}) 0%, (#[0-9a-fA-F]{6}) 100%\)/g)][0]?.slice(1, 3).map((s) => s.toLowerCase());
    expect(tintStops, 'the tinted rule has the 165deg gradient').toEqual([gradientLight, gradientDark]);
  });

  // WHY (Codex review of #1055): a declaration holding var() is valid at parse time on EVERY engine and is only checked when the
  // value is computed, so on a WebView without color-mix() (iOS 15 to 16.1, Android WebView before Chromium 111) a background built
  // from color-mix(... var(--night-tint) ...) is "invalid at computed-value time" and the WHOLE background becomes transparent:
  // white text on the page colour. @supports is decided at parse time, so an engine without color-mix skips the block and keeps
  // the plain gradient. jsdom cannot show this, so the stylesheet text is what is checked.
  test('★ every color-mix on the night card sits inside an @supports (color-mix) block; the plain .night rule has none', () => {
    expect(tintBlocks.length, 'an @supports block that tests color-mix exists').toBeGreaterThan(0);
    for (const block of tintBlocks) expect(block.condition, 'it tests a background with color-mix').toMatch(/background:\s*color-mix\(/);
    expect(tintPaint, 'the paint rule was found INSIDE the block').toContain('color-mix');
    // Outside every @supports block: no rule for the night card may mention color-mix or the tint-fill property, and the base rule
    // must stay a plain gradient.
    const outside = outsideSupports.split('}').map((rule) => rule.replace(/\s+/g, ' ').trim());
    const offenders = outside.filter((rule) => /^\.night(--|\s|\{|$)/.test(rule) && /color-mix|--night-tint/.test(rule));
    expect(offenders, `night-card tint outside @supports: ${offenders.join(' | ')}`).toEqual([]);
    expect(nightRule).toMatch(/background: linear-gradient\(165deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 100%\)/i);
    // The base background declaration holds no var() at all: it must stay valid on an engine that cannot compute the tint.
    expect(nightRule.match(/(?:^|[ ;{])background:[^;]*;/)?.[0], 'the plain card background').not.toContain('var(');
  });

  test.each(BANDS)('★ %s: the card\'s text and the ring stay readable on the TINTED lightest stop, where contrast is lowest', (band) => {
    const ring = day[`--band-${band}-ring`];
    // Worst case for light text: the lightest stop with the tint over it. The tint of the darkest stop is checked too, for the ring.
    for (const stop of [gradientLight, gradientDark]) {
      const tinted = blend(ring, tintAlpha, stop);
      for (const token of ['--night-text', '--night-muted', '--night-link']) {
        expect(contrast(nightTokens[token], tinted), `${token} on ${stop} tinted with ${band}`).toBeGreaterThanOrEqual(4.5);
      }
      // Muted is the 10.5 to 13px text. Measured 2026-11-13 on the navy gradient's lightest stop (#2c2f63) with the 12% tint: great 5.07,
      // good 5.53, fair 5.68, low 5.87, early 5.17 (6.85 on the bare gradient). Floor of 5:1 (the design's own figure is 5.07), so a
      // stronger tint or a lighter gradient that eats the margin over the required 4.5:1 fails here before it reaches a phone.
      expect(contrast(nightTokens['--night-muted'], tinted), `muted on ${stop} tinted with ${band}`).toBeGreaterThanOrEqual(5);
      // The arc is a graphic (3:1) against the tinted card and against its own track as it composites on it.
      expect(contrast(ring, tinted), `${band} arc on the tinted ${stop}`).toBeGreaterThanOrEqual(3);
      expect(contrast(ring, overHex(trackMatch, tinted)), `${band} arc on its track over the tinted ${stop}`).toBeGreaterThanOrEqual(3);
    }
  });

  test('★ the ring arc takes its colour from the band tokens: --band-* on a themed card, --band-*-ring on the night card; the number never', () => {
    for (const band of BANDS) {
      expect(rules.find((r) => r.startsWith(`.score-ring--card.score-ring--${band} .score-ring__arc {`)), `card ${band}`).toContain(`stroke: var(--band-${band})`);
      expect(rules.find((r) => r.startsWith(`.score-ring--dark.score-ring--${band} .score-ring__arc {`)), `dark ${band}`).toContain(`stroke: var(--band-${band}-ring)`);
    }
    // TEXT IS NEVER SET IN A BAND COLOUR: no rule that colours text or the number's fill mentions a band token.
    const textInBand = rules.filter((r) => /(^|[ ;{])(color|fill):\s*var\(--band-/.test(r));
    expect(textInBand, `text coloured by a band token: ${textInBand.join(' | ')}`).toEqual([]);
    expect(rules.find((r) => r.startsWith('.score-ring__num {'))).toContain('fill: var(--text-primary)');
    expect(rules.find((r) => r.startsWith('.score-ring--dark .score-ring__num {'))).toContain('fill: #fff');
  });

  test.each([['day', day], ['night', night]])('%s: factor bars use card band tokens at 3:1 against the track', (_name, t) => {
    const track = t['--border'];
    for (const band of ['great', 'good', 'fair', 'low']) {
      const rule = rules.find((r) => r.startsWith(`.score-part__bar--${band} span {`));
      expect(rule, `${band} bar rule`).toContain(`background: var(--band-${band})`);
      expect(contrast(t[`--band-${band}`], track), `${band} against track`).toBeGreaterThanOrEqual(3);
    }
    expect(rules.find((r) => r.startsWith('.score-part__bar--empty {'))).toContain('border: 1px dashed');
  });

  test('★ the .night rules take their text colours from the card\'s properties, not from literals', () => {
    const nightRules = rules.filter((rule) => /^\.night(__|\s|\.)/.test(rule) && !rule.startsWith('.night {'));
    expect(nightRules.length, 'the .night__* rules were found').toBeGreaterThan(8);
    const literals = nightRules.filter((rule) => /#[0-9a-fA-F]{3,6}\b/.test(rule));
    expect(literals, `hex literals in ${literals.join(' | ')}`).toEqual([]);
    // The two dimmest steps of the old lavender ladder: #8f93d0 is 4.28:1 on the card, under what small text needs.
    expect(css).not.toMatch(/#(?:9fa3e0|8f93d0)\b/i);
  });

  test.each([['day', day, sleepDay], ['night', night, sleepNight]])('★ %s: where the wake-up amber is TEXT it is readable on the card and the inset (4.5:1)', (_name, t, sleep) => {
    expect(sleep['--sleep-asleep'], 'the timeline tokens were read').toMatch(/^#[0-9a-f]{6}$/);
    for (const surface of ['--bg-elevated', '--bg-elevated-2']) {
      expect(contrast(sleep['--sleep-wake-text'], t[surface]), `--sleep-wake-text on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test.each([['day', day, sleepDay], ['night', night, sleepNight]])('★ %s: where the room-activity teal is TEXT it is readable on the card, the inset and its own 15%% tag (4.5:1)', (_name, t, sleep) => {
    for (const surface of ['--bg-elevated', '--bg-elevated-2']) {
      expect(contrast(sleep['--sleep-visit-text'], t[surface]), `--sleep-visit-text on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
    // The .sleep-visit-tag sits on a card, never on the page, so the card is what its tint is laid over.
    expect(contrast(sleep['--sleep-visit-text'], tint(sleep['--sleep-visit'], 0.15, t['--bg-elevated'])), 'on its tag').toBeGreaterThanOrEqual(4.5);
    expect(contrast(sleep['--sleep-wake-text'], tint(sleep['--sleep-wake'], 0.14, t['--bg-elevated'])), 'the wake-up badge on its tag').toBeGreaterThanOrEqual(4.5);
  });

  test('★ the room-activity duration, tag and label use the readable teal; the dots and legend swatch keep the bright one', () => {
    for (const selector of ['.sleep-wakes__dur--visit', '.sleep-visit-tag', '.sleep-refined__label']) {
      const rule = rules.find((r) => r.startsWith(`${selector} {`));
      expect(rule, `${selector} has a rule`).toBeTruthy();
      expect(rule, selector).toMatch(/(^|[ ;{])color: var\(--sleep-visit-text\)/);
    }
    for (const selector of ['.sleep-tl__visit', '.sleep-legend__sw--visit']) {
      expect(rules.find((r) => r.startsWith(`${selector} {`)), selector).toMatch(/background: var\(--sleep-visit\)/);
    }
  });

  test('★ the timeline colours are the approved v3 ones: asleep, stirring, wake-up amber, before/after-sleep neutral, room activity', () => {
    const keys = ['--sleep-asleep', '--sleep-stir', '--sleep-wake', '--sleep-awake', '--sleep-visit', '--sleep-visit-text', '--sleep-gap'];
    // v3.1 (2026-11-13) moved two of them: stirring is #7279c6 by day and #a7ade4 at night (v3: #a7ade4 / #4a4f86), and room
    // activity is #279189 in both themes (v3: #2fa39a).
    expect(keys.map((k) => sleepDay[k])).toEqual(['#4b53b5', '#7279c6', '#f0a257', '#d2d0e2', '#279189', '#17706a', '#c7c7c7']);
    // Night room activity is #279189 (it was #3ec4b8, the same lightness as the Good band, ratio 1.01), but its TEXT stays #3ec4b8:
    // #279189 on its own 15% tag is only 3.46:1.
    expect(keys.map((k) => sleepNight[k])).toEqual(['#7c85e6', '#a7ade4', '#f6c899', '#3c3f60', '#279189', '#3ec4b8', '#5a5c6e']);
    expect(contrast('#279189', tint('#279189', 0.15, night['--bg-elevated'])), 'why night text is not the segment teal').toBeLessThan(4.5);
  });

  // The gap beside the awake block is the track colour AT NIGHT and nothing by day (v3.1). It is not a hex, so the token reader
  // above cannot see it: read the two :root rules for the literal values.
  test('★ the awake gap token is transparent by day and the track colour at night, and no 1px white separator is left on the bar', () => {
    const dayRule = rules.find((r) => r.startsWith(':root {') && r.includes('--sleep-wake-gap:')) || '';
    const nightBlock = rules.find((r) => r.startsWith(":root[data-theme='dark'] {") && r.includes('--sleep-wake-gap:')) || '';
    expect(dayRule, 'by day').toMatch(/--sleep-wake-gap:\s*transparent\s*;/);
    expect(nightBlock, 'at night').toMatch(/--sleep-wake-gap:\s*var\(--bg-elevated-2\)\s*;/);
    // The old separator (a 1px card-coloured inset line between asleep and its neighbours) must not come back: at night it was the
    // only thing separating asleep from awake, now the gaps do it.
    expect(rules.filter((r) => /inset 1px 0 0 var\(--bg-elevated\)/.test(r)), 'a 1px card-coloured separator').toEqual([]);
  });

  test('★ asleep gets its edge colour only beside stirring (the track) and awake (the awake gap token), and awake draws its own gap with that token', () => {
    const edge = (selector) => rules.find((r) => r.startsWith(`${selector} {`)) || '';
    // A neighbour BEFORE asleep sets the LEFT edge (--tl-edge-l); one AFTER it (the :has rules) sets the RIGHT edge (--tl-edge-r).
    // Checking the property, not only the colour, is what catches the two being swapped.
    expect(edge('.sleep-seg--stir + .sleep-seg--asleep')).toMatch(/--tl-edge-l:\s*var\(--bg-elevated-2\)/);
    expect(edge('.sleep-seg--asleep:has(+ .sleep-seg--stir)')).toMatch(/--tl-edge-r:\s*var\(--bg-elevated-2\)/);
    expect(edge('.sleep-seg--wake + .sleep-seg--asleep')).toMatch(/--tl-edge-l:\s*var\(--sleep-wake-gap\)/);
    expect(edge('.sleep-seg--asleep:has(+ .sleep-seg--wake)')).toMatch(/--tl-edge-r:\s*var\(--sleep-wake-gap\)/);
    // ...and asleep paints the left property on its left side (a positive inset offset) and the right one on its right (negative).
    const base = rules.find((r) => r.startsWith('.sleep-seg--asleep {') && r.includes('box-shadow')) || '';
    expect(base, 'left edge').toMatch(/inset\s+[1-9]\d*px\s+0\s+0\s+var\(--tl-edge-l/);
    expect(base, 'right edge').toMatch(/inset\s+-[1-9]\d*px\s+0\s+0\s+var\(--tl-edge-r/);
    // The blocks' own gaps: EVERY rule that sets a box-shadow on the stirring / awake ::before (the base rule and the first/last/only
    // variants) must use the gap colour, so a later rule that wins for some position cannot swap it unseen. Not a pixel pin.
    const shadowOf = (pseudo) => rules.filter((r) => { const at = r.lastIndexOf('{'); return r.slice(0, at).includes(pseudo) && /box-shadow:/.test(r.slice(at)); });
    for (const [pseudo, token] of [['.sleep-seg--wake::before', 'var(--sleep-wake-gap)'], ['.sleep-seg--stir::before', 'var(--bg-elevated-2)']]) {
      const all = shadowOf(pseudo);
      expect(all.length, `${pseudo} has a box-shadow rule`).toBeGreaterThan(0);
      for (const r of all) {
        const value = r.slice(r.lastIndexOf('{')).match(/box-shadow:\s*([^;}]*)/)[1];
        // `none` is the only-child rule (no neighbour to separate from); every other declaration must use the token.
        expect(value === 'none' || value.includes(token), `${r.slice(0, r.lastIndexOf('{')).trim()}: ${value}`).toBe(true);
      }
    }
  });

  test('★ a stirring or awake block that is first or last in the bar is anchored to that edge, so it cannot paint outside the bar', () => {
    for (const kind of ['stir', 'wake']) {
      const rule = (pos) => rules.find((r) => r.startsWith(`.sleep-tl__bar > .sleep-seg--${kind}:${pos}::before {`)) || '';
      expect(rule('first-child'), `${kind} first`).toMatch(/(^|[ ;{])left:\s*0\b/);
      expect(rule('last-child'), `${kind} last`).toMatch(/(^|[ ;{])right:\s*0\b/);
      expect(rule('last-child'), `${kind} last no longer centred by left`).toMatch(/left:\s*auto/);
      for (const pos of ['first-child', 'last-child', 'only-child']) expect(rule(pos), `${kind} ${pos} is not shifted back by the centring`).toMatch(/transform:\s*none/);
    }
  });

  // Known pairs below their floor (design v3, 2026-11-13; docs/design-language.md, "Known pairs below their floor"). Each is two
  // graphics, never text: either two bar segments that can touch, or a segment on the card or the inset track it is drawn on.
  // They are named here with their measured ratio so that the list is honest in both directions: a pair that gets worse than its
  // ratio, or better than the 3:1 floor, fails this test and the doc has to be updated, instead of the exception quietly going
  // stale (the same pattern as the exceptions in the score-colours change). The first four came from the designer; the review of
  // that list (2026-11-13) found the rest, and the completeness test below is what stops a list like this being short again.
  // The timeline-shape follow-up ("v3.1": segments separated by gaps and shape, not by colour alone) has landed: it cleared most of
  // them and the table below is what is left, plus the few pairs it made worse (see the comment inside the table).
  const TIMELINE_PAIRS = [['asleep', '--sleep-asleep'], ['stir', '--sleep-stir'], ['wake', '--sleep-wake'], ['awake', '--sleep-awake'], ['gap', '--sleep-gap'], ['visit', '--sleep-visit']];
  const SURFACES = { card: '--bg-elevated', track: '--bg-elevated-2' };
  const timelineColour = (theme, name) => {
    const t = theme === 'day' ? day : night;
    const found = TIMELINE_PAIRS.find(([n]) => n === name);
    return found ? t[found[1]] : t[SURFACES[name]];
  };
  const BELOW_FLOOR = [
    // [theme, a, b, ratio]  (a and b are the names above; `card` is --bg-elevated and `track` is --bg-elevated-2)
    // v3.1 (2026-11-13) moved the stirring and room-activity colours and separated the segments by shape and gaps. What cleared 3:1
    // and left this list: stirring on the card and on the track in both themes, room activity on the track by day, night stirring
    // against the before/after-sleep segment. What is NEW on it, honestly: day stirring against asleep (1.64) and against the
    // amber (1.90), night stirring against the amber (1.40); and night stirring against asleep went DOWN, 2.31 to 1.53, because it
    // is #a7ade4 again. Those pairs are told apart by shape (half-height block, gaps) rather than colour.
    ['night', 'wake', 'asleep', 2.15], ['night', 'stir', 'asleep', 1.53], ['day', 'stir', 'asleep', 1.64],
    ['day', 'wake', 'card', 2.1], ['day', 'wake', 'track', 1.68],
    ['day', 'awake', 'track', 1.22], ['night', 'awake', 'track', 1.87],
    ['day', 'awake', 'card', 1.52], ['night', 'awake', 'card', 1.56],
    ['day', 'stir', 'wake', 1.9], ['night', 'stir', 'wake', 1.4], ['day', 'stir', 'awake', 2.63], ['day', 'wake', 'awake', 1.38],
    // The "No data" hatch (--sleep-gap stripes on the track colour) was left out of the enumeration until Codex's review of #1057
    // found it; these existed before v3.1 (the gap colour did not change). `gap` against `track` is the hatch's own two stripes.
    ['day', 'gap', 'card', 1.69], ['day', 'gap', 'track', 1.36], ['day', 'gap', 'stir', 2.36], ['day', 'gap', 'wake', 1.24], ['day', 'gap', 'awake', 1.12],
    ['night', 'gap', 'card', 2.4], ['night', 'gap', 'track', 2.88], ['night', 'gap', 'asleep', 1.99], ['night', 'gap', 'awake', 1.54],
  ];
  const sortedPair = (a, b) => [a, b].sort().join('|');

  test.each(BELOW_FLOOR)('★ known below-floor pair, %s: %s against %s, is still exactly %s:1 and still under 3:1', (theme, a, b, documented) => {
    const ratio = contrast(timelineColour(theme, a), timelineColour(theme, b));
    expect(round2(ratio), 'the documented ratio').toBe(documented);
    expect(ratio, 'below the 3:1 a graphic needs: if this fails the colour was fixed, so remove it from the list here and in the doc').toBeLessThan(3);
  });

  test('★ the named list is COMPLETE: every pair of bar segments, and every segment or room-activity dot on the card and track, that is under 3:1 is named', () => {
    // Bar segments can touch one another; every timeline colour sits on the card or its inset track. Room activity is drawn above the
    // bar (a dot), so it is only measured against the surfaces, not against the other segments.
    const segments = ['asleep', 'stir', 'wake', 'awake', 'gap'];
    const candidates = [];
    for (const theme of ['day', 'night']) {
      for (let i = 0; i < segments.length; i += 1) for (let j = i + 1; j < segments.length; j += 1) candidates.push([theme, segments[i], segments[j]]);
      for (const name of [...segments, 'visit']) for (const surface of ['card', 'track']) candidates.push([theme, name, surface]);
    }
    const under = candidates
      .filter(([theme, a, b]) => contrast(timelineColour(theme, a), timelineColour(theme, b)) < 3)
      .map(([theme, a, b]) => `${theme}:${sortedPair(a, b)}`).sort();
    const named = BELOW_FLOOR.map(([theme, a, b]) => `${theme}:${sortedPair(a, b)}`).sort();
    expect(under, 'a pair under 3:1 that is not named (add it to BELOW_FLOOR and the doc), or a named pair that is no longer under').toEqual(named);
    expect(new Set(named).size, 'no pair is named twice').toBe(named.length);
  });

  test('★ the pairs the design measured as clearing 3:1 still do (a spot check, so the completeness list is not the only thing watching them)', () => {
    expect(contrast(sleepNight['--sleep-visit'], night['--bg-elevated']), 'night room activity on the card').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepNight['--sleep-visit'], night['--bg-elevated-2']), 'night room activity on the track').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepDay['--sleep-visit'], day['--bg-elevated']), 'day room activity on the card').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepDay['--sleep-visit'], day['--bg-elevated-2']), 'day room activity on the track (v3.1: #279189 is 3.06, the v3 teal was 2.47)').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepDay['--sleep-stir'], day['--bg-elevated']), 'day stirring on the card').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepDay['--sleep-stir'], day['--bg-elevated-2']), 'day stirring on the track').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepNight['--sleep-stir'], night['--bg-elevated']), 'night stirring on the card').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepNight['--sleep-stir'], night['--bg-elevated-2']), 'night stirring on the track').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepDay['--sleep-asleep'], day['--bg-elevated']), 'day asleep on the card').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepNight['--sleep-asleep'], night['--bg-elevated']), 'night asleep on the card').toBeGreaterThanOrEqual(3);
    expect(contrast(sleepDay['--sleep-wake'], sleepDay['--sleep-asleep']), 'day wake-up amber against asleep').toBeGreaterThanOrEqual(3);
  });

  test('★ the wake-up duration, badge, icon and "out of bed" tag use the readable amber, never the segment amber', () => {
    for (const selector of ['.sleep-wakes__dur', '.sleep-wakes__dur--out', '.sleep-wakes__badge', '.sleep-wakes__alert-ico', '.sleep-visit-tag--out']) {
      const rule = rules.find((r) => r.startsWith(`${selector} {`));
      expect(rule, `${selector} has a rule`).toBeTruthy();
      expect(rule, selector).toMatch(/(^|[ ;{])color: var\(--sleep-wake-text\)/);
    }
  });

  test('★ every var(--token) the stylesheet reads is defined somewhere (var(--danger, #c0392b) and var(--surface-2, ...) were not, so their fallbacks silently ruled)', () => {
    const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    // Properties set at runtime, in JSX style={{ '--x': ... }} or by script, are legitimately absent from the stylesheet.
    const runtimeSet = new Set();
    for (const file of ['src']) {
      const walk = (dir) => readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(jsx?|tsx?)$/.test(entry.name)) for (const m of readFileSync(full, 'utf8').matchAll(/['"`](--[a-z0-9-]+)['"`]|setProperty\(\s*['"](--[a-z0-9-]+)/g)) runtimeSet.add(m[1] || m[2]);
      });
      walk(join(process.cwd(), file));
    }
    const missing = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))].filter((name) => !defined.has(name) && !runtimeSet.has(name));
    expect(missing, `tokens read but never defined: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the token reader itself', () => {
  const read = (text) => themeTokens(text.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map((rule) => rule.replace(/\s+/g, ' ').trim()));

  test('★ a LATER declaration of a token wins, in any :root or dark block, as it does in the browser', () => {
    const { day: d, night: n, dark } = read(`
      :root { --bg: #111111; --text-primary: #222222; }
      :root[data-theme='dark'] { --bg: #333333; }
      :root { --bg: #444444; }
      :root[data-theme='dark'] { --bg: #555555; --text-primary: #666666; }
      :root[data-theme='dark'] { --bg: #777777; }
    `);
    expect(d['--bg'], 'a second :root block overrides the first').toBe('#444444');
    expect(n['--bg'], 'the last dark declaration wins at night').toBe('#777777');
    expect(n['--text-primary']).toBe('#666666');
    expect(d['--text-primary'], 'the dark override does not leak into day').toBe('#222222');
    expect(dark['--bg']).toBe('#777777');
  });

  test('a token only the day blocks define carries into night, and one defined twice in a block takes the last', () => {
    const { night: n } = read(':root { --a: #aaaaaa; --a: #bbbbbb; --b: #cccccc; } :root[data-theme=\'dark\'] { --b: #dddddd; }');
    expect(n['--a']).toBe('#bbbbbb');
    expect(n['--b']).toBe('#dddddd');
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

  test('★ the step bar stays on ONE row for any number of steps (it wrapped the seventh segment under a fixed six columns)', () => {
    const bar = ruleFor('.setup-progress');
    expect(bar, 'the rule was found').toContain('display: grid');
    expect(bar).toContain('grid-auto-flow: column');
    expect(bar).not.toMatch(/grid-template-columns:\s*repeat\(\d/);
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

// UI refresh PR E: the band line along the sleep page header's bottom edge. A graphic needs 3:1 against what it is drawn ON. The
// first version was a child element at the bar's edge, and measured against the light page background (where it can land) the
// bands were 1.24 / 1.99 / 2.19 / 2.99 and the neutral 9.06 (PR #1061 review). It is now an inset shadow of the header itself,
// so what it is drawn on is --bar, at full strength in the fixed --band-*-ring colours, and the neutral is a solid colour, not
// an opacity blend. These recompute every pair from the stylesheet.
describe('the band line under the sleep page header', () => {
  const LINE_BANDS = ['great', 'good', 'fair', 'low', 'early'];
  const lineRule = (key) => rules.find((rule) => rule.startsWith(`.app-header--band-${key}`) || rule.includes(`, .app-header--band-${key} {`));

  test.each(LINE_BANDS)('★ %s: the line colour clears 3:1 on --bar in both themes', (band) => {
    for (const [name, t] of [['day', day], ['night', night]]) {
      expect(contrast(t[`--band-${band}-ring`], t['--bar']), `${name} ${band}`).toBeGreaterThanOrEqual(3);
    }
  });

  test('★ the neutral state (early estimate, no score) is a solid colour that also clears 3:1 on --bar', () => {
    for (const key of ['early', 'none']) {
      const rule = lineRule(key);
      expect(rule, `a rule for the ${key} line`).toBeTruthy();
      expect(rule).toContain('inset 0 -3px 0 var(--band-early-ring)');
    }
    expect(contrast(day['--band-early-ring'], day['--bar'])).toBeGreaterThanOrEqual(3);
  });

  test.each(['great', 'good', 'fair', 'low'])('%s: the line is drawn in its own ring colour', (band) => {
    expect(lineRule(band), `a rule for the ${band} line`).toContain(`inset 0 -3px 0 var(--band-${band}-ring)`);
  });

  test('★ the line is painted by the header itself at full strength: an inset shadow, never a child over the page, never an opacity blend', () => {
    const lines = rules.filter((rule) => rule.includes('.app-header--band-'));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const rule of lines) {
      expect(rule, rule).toContain('box-shadow: inset');
      expect(rule, rule).not.toMatch(/opacity|rgba|transparent/);
    }
    expect(css).not.toContain('.app-header__band');
  });
});
