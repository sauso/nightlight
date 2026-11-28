// Columns and rows of the TV screen's tile grid by camera count (src/lib/tvLayout.js):
// 1 = one tile, 2 = two columns, 3-4 = 2 x 2, 5 or more = 3 columns (the page scrolls by row).
import { describe, test, expect } from 'vitest';
import { tvColumns, tvRows } from '../src/lib/tvLayout.js';

describe('tvColumns', () => {
  test.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 2],
    [5, 3],
    [6, 3],
    [7, 3],
    [12, 3],
  ])('%i cameras -> %i columns', (count, cols) => {
    expect(tvColumns(count)).toBe(cols);
  });

  test('no cameras, or nonsense, is one column and never 0 (the grid is not drawn, but a 0 would divide by zero in tvRows)', () => {
    for (const bad of [0, -3, NaN, undefined, null]) expect(tvColumns(bad)).toBe(1);
  });
});

describe('tvRows', () => {
  test.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 2],
    [6, 2],
    [7, 3],
    [9, 3],
    [10, 4],
  ])('%i cameras -> %i rows', (count, rows) => {
    expect(tvRows(count)).toBe(rows);
  });

  test('no cameras is one row', () => {
    expect(tvRows(0)).toBe(1);
  });
});
