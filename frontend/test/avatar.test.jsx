// The child colour ring around a PHOTO (owner, 2026-11-15: "Should only be around the child photo. And make the colour optional").
// The component's own contract; the places it sits (list card, night card, edit screen) are asserted in childListCard, children
// and avatarEditor tests, and the token contrast in paletteTokens.test.jsx. Hooks, not pixels: a data attribute and the token NAME.
import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/react';
import Avatar from '../src/components/Avatar.jsx';
import { ringSpreadPx } from './helpers/ringSpread.js';

const PHOTO = 'data:image/png;base64,AAA';
const img = (props) => render(<Avatar name="Child B" src={PHOTO} {...props} />).container.querySelector('img');
const IDS = [['#f4c56a', 'yellow'], ['#7FBFA3', 'green'], ['#8A9FE0', 'blue'], ['#E0A5C9', 'pink'], ['#E0B27F', 'orange'], ['#7c83db', 'violet']];

describe('Avatar ring', () => {
  test.each(IDS)('★ a photo with colour %s is ringed in the themed --child-%s by default', (color, id) => {
    const el = img({ color });
    expect(el.hasAttribute('data-child-ring')).toBe(true);
    expect(el.getAttribute('style')).toContain(`var(--child-${id})`);
    expect(el.getAttribute('style')).not.toContain('-night');
    // The hook and the token name are not a ring: a 0px shadow has both and paints nothing (PR #1100 review).
    expect(ringSpreadPx(el), 'the ring has a visible width').toBeGreaterThan(0);
  });

  test('ringSpreadPx reads the spread, and a zero-width shadow is not a ring (guards the guard)', () => {
    const el = (style) => { const d = document.createElement('img'); d.setAttribute('style', style); return d; };
    expect(ringSpreadPx(el('box-shadow: 0 0 0 3px var(--child-green)'))).toBe(3);
    expect(ringSpreadPx(el('box-shadow: 0 0 0 0px var(--child-green)'))).toBe(0);
    expect(ringSpreadPx(el('width: 8px'))).toBe(0);
  });

  test.each(IDS)('★ colour %s on the navy night card (surface="night"): the ring is the -night shade of --child-%s', (color, id) => {
    const el = img({ color, surface: 'night' });
    expect(el.getAttribute('style')).toContain(`var(--child-${id}-night)`);
    expect(ringSpreadPx(el), 'the ring has a visible width').toBeGreaterThan(0);
  });

  test.each([[undefined], [null], [''], ['not a colour']])('★ a photo with no usable colour (%j) is plain: no ring attribute, no shadow', (color) => {
    const el = img({ color, surface: 'night' });
    expect(el.hasAttribute('data-child-ring')).toBe(false);
    expect(el.getAttribute('style')).not.toContain('box-shadow');
  });

  test('no photo: the colour fills the initials disc and there is no ring; no colour is the accent disc', () => {
    const coloured = render(<Avatar name="Child B" color="#7FBFA3" />).container;
    expect(coloured.querySelector('[data-child-ring]')).toBeNull();
    expect(coloured.querySelector('span').style.background).toBe('var(--child-green)');
    const none = render(<Avatar name="Child B" color="" />).container;
    expect(none.querySelector('span').style.background).toBe('var(--accent)');
  });

  test('the ring takes no layout: the photo keeps its width, height and round shape', () => {
    const el = img({ color: '#7FBFA3', size: 64 });
    expect(el.style.width).toBe('64px');
    expect(el.style.height).toBe('64px');
    expect(el.style.borderRadius).toBe('50%');
  });
});
