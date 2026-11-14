// lib/childColors.js: which of the six child colours a STORED hex means. Display only: nothing here is ever written back.
import { describe, expect, test } from 'vitest';
import { CHILD_COLORS, childColorId, childColorVars } from '../src/lib/childColors.js';

describe('childColorId', () => {
  test.each(CHILD_COLORS)('★ the stored value of $id maps to $id, in any letter case', ({ id, stored }) => {
    expect(childColorId(stored)).toBe(id);
    expect(childColorId(stored.toLowerCase())).toBe(id);
    expect(childColorId(stored.toUpperCase())).toBe(id);
  });

  test('★ the six stored values are exactly what the picker always saved (nothing in the database changes)', () => {
    expect(CHILD_COLORS.map((c) => c.stored)).toEqual(['#f4c56a', '#7FBFA3', '#8A9FE0', '#E0A5C9', '#E0B27F', '#7c83db']);
    expect(CHILD_COLORS.map((c) => c.id)).toEqual(['yellow', 'green', 'blue', 'pink', 'orange', 'violet']);
  });

  test('★ the server default #F5D9A8 (the old pale gold) is yellow, not orange, though orange is nearer by RGB', () => {
    expect(childColorId('#F5D9A8')).toBe('yellow');
    expect(childColorId('#f5d9a8')).toBe('yellow');
  });

  test('★ any other hex takes the nearest of the six by RGB distance', () => {
    expect(childColorId('#00ff00')).toBe('green');
    expect(childColorId('#0000ff')).toBe('violet'); // pure blue is nearest the violet #7c83db, not the paler blue (arithmetic, not taste)
    expect(childColorId('#ffffff')).toBe('pink'); // 109 from pink, the nearest
    expect(childColorId('#E0A5C8')).toBe('pink'); // one step off a stored value
    expect(childColorId('#d0a070')).toBe('orange');
  });

  test('★ no colour, or something that is not #RRGGBB, is null (the caller draws nothing)', () => {
    for (const bad of [undefined, null, '', 'red', '#fff', '#12345', '#1234567', 123456, {}]) expect(childColorId(bad), String(bad)).toBeNull();
  });
});

describe('childColorVars', () => {
  test('gives the theme tokens for the colour: fill, initials, list-card ring and night-card ring', () => {
    expect(childColorVars('#7FBFA3')).toEqual({
      id: 'green', fill: 'var(--child-green)', on: 'var(--child-green-on)', ring: 'var(--child-green)', ringOnNight: 'var(--child-green-night)',
    });
  });
  test('a legacy hex gets its nearest colour\'s tokens', () => {
    expect(childColorVars('#F5D9A8').fill).toBe('var(--child-yellow)');
  });
  test('no colour gives null', () => {
    expect(childColorVars(undefined)).toBeNull();
    expect(childColorVars('')).toBeNull();
  });
});
