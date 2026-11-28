// nextFocus: the TV screen's arrow-key movement (src/lib/tvNav.js), a pure function over rectangles.
//
// The fixtures are laid out by hand (a grid of equal 16:9 rects, then deliberately unequal ones) and the expected
// answers are written out per tile, NOT computed by a second implementation of the rule: a test that derives its
// expectation from the same arithmetic would pass for any rule.
//
// THE RULE under test (also in tvNav.js): a target is a candidate only if its centre lies beyond the current
// one's in the pressed direction; ranked by the gap along the axis, then by how far off-axis its centre is, then
// by index. Left/Right also need a shared row (some vertical overlap); Up/Down do not, so a ragged last row is
// reachable. No wrap-around; no candidate means "stay".
import { describe, test, expect } from 'vitest';
import { nextFocus } from '../src/lib/tvNav.js';
import { tvColumns } from '../src/lib/tvLayout.js';

const W = 160;
const H = 90;
const GAP = 20;

const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });

// n equal tiles laid out row by row in `cols` columns (a ragged last row sits in the FIRST columns, as CSS grid does).
function grid(n, cols = tvColumns(n), originTop = 0) {
  return Array.from({ length: n }, (_, i) => rect((i % cols) * (W + GAP), originTop + Math.floor(i / cols) * (H + GAP), W, H));
}

// For every tile, [up, down, left, right]; `.` in the table means "stays". Written per layout below.
const DIRS = ['up', 'down', 'left', 'right'];
function expectTable(rects, table) {
  table.forEach((row, from) => {
    DIRS.forEach((dir, d) => {
      const want = row[d] === null ? from : row[d];
      expect(nextFocus(rects, from, dir), `tile ${from} ${dir}`).toBe(want);
    });
  });
}

describe('nextFocus: layouts the screen actually builds', () => {
  test('1 tile: every direction stays', () => {
    expectTable(grid(1), [[null, null, null, null]]);
  });

  test('2 tiles side by side: only Left and Right move', () => {
    //                  up    down  left  right
    expectTable(grid(2), [[null, null, null, 1], [null, null, 0, null]]);
  });

  test('3 tiles (2 columns, ragged): the lone tile in row two is under column one', () => {
    // 0 1
    // 2
    expectTable(grid(3), [
      [null, 2, null, 1], // 0
      [null, 2, 0, null], // 1: Down has only one candidate, the tile under the OTHER column (ragged row)
      [0, null, null, null], // 2: Up ties on the gap between 0 and 1; 0 is exactly above, so it wins on off-axis distance
    ]);
  });

  test('4 tiles (2 x 2)', () => {
    // 0 1
    // 2 3
    expectTable(grid(4), [
      [null, 2, null, 1],
      [null, 3, 0, null],
      [0, null, null, 3],
      [1, null, 2, null],
    ]);
  });

  test('7 tiles (3 columns, ragged last row)', () => {
    // 0 1 2
    // 3 4 5
    // 6
    expectTable(grid(7), [
      [null, 3, null, 1], // 0
      [null, 4, 0, 2], // 1
      [null, 5, 1, null], // 2
      [0, 6, null, 4], // 3
      [1, 6, 3, 5], // 4: Down goes to 6, the only tile below, though it is not in line (ragged row)
      [2, 6, 4, null], // 5: same
      [3, null, null, null], // 6: Up -> 3, the one exactly above; 4 and 5 are as near along the axis but further off it. Right has no tile in its ROW
    ]);
  });

  test('no wrap-around: the right edge of a row does not continue on the next row, nor the bottom on the top', () => {
    const rects = grid(7);
    expect(nextFocus(rects, 2, 'right')).toBe(2);
    expect(nextFocus(rects, 5, 'right')).toBe(5);
    expect(nextFocus(rects, 3, 'left')).toBe(3);
    expect(nextFocus(rects, 6, 'down')).toBe(6);
    expect(nextFocus(rects, 0, 'up')).toBe(0);
  });
});

describe('nextFocus: the up-from-the-ragged-tile tie, stated', () => {
  test('Up from the lone tile goes to the tile in line with it, not to the middle of the row above', () => {
    // 3 columns: tile 6 is under column one. Tiles 3, 4 and 5 are in the row above at the same distance along the
    // axis, so the tie goes to the smallest off-axis distance: 3 (directly above). The brief allowed "4 or 5" for
    // a centred lone tile: put 6 in the MIDDLE column and the same rule gives 4.
    const rects = grid(7);
    expect(nextFocus(rects, 6, 'up')).toBe(3);
    const centred = [...rects.slice(0, 6), rect(1 * (W + GAP), 2 * (H + GAP), W, H)];
    expect(nextFocus(centred, 6, 'up')).toBe(4);
  });

  test('a full tie (same gap, same off-axis distance) goes to the lower index', () => {
    // From a tile centred under two equal tiles, Up is equally far from both.
    const rects = [rect(0, 0, 100, 50), rect(100, 0, 100, 50), rect(50, 100, 100, 50)];
    expect(nextFocus(rects, 2, 'up')).toBe(0);
    // ...and the answer does not depend on which of the two comes first in the list.
    const swapped = [rects[1], rects[0], rects[2]];
    expect(nextFocus(swapped, 2, 'up')).toBe(0);
  });
});

describe('nextFocus: an offline tile is an ordinary target', () => {
  test('the middle tile of a row is reached and passed through (focus is never trapped or skipped)', () => {
    // The page draws an offline camera exactly like any other tile (same rectangle), so the function sees nothing
    // special: this pins that the arrows step through all three and back.
    const rects = grid(3, 3); // one row of three; 1 is the "offline" one
    expect(nextFocus(rects, 0, 'right')).toBe(1);
    expect(nextFocus(rects, 1, 'right')).toBe(2);
    expect(nextFocus(rects, 2, 'left')).toBe(1);
    expect(nextFocus(rects, 1, 'left')).toBe(0);
  });

  test('in a column of three, Down and Up step through the middle one', () => {
    const rects = grid(3, 1);
    expect(nextFocus(rects, 0, 'down')).toBe(1);
    expect(nextFocus(rects, 1, 'down')).toBe(2);
    expect(nextFocus(rects, 2, 'up')).toBe(1);
  });
});

describe('nextFocus: a button above the tiles (the Reconnect target)', () => {
  // 3 columns: [button] above, tiles 1..4 below (index 0 is the button, as on the page).
  // Top right, above the third column, and wider than a tile: its CENTRE (x 500) is to the right of that column's (440).
  const button = rect(400, -80, 200, 50);
  const rects = [button, ...grid(4, 3)];

  test('Up from any first-row tile reaches the button, even from the far left (no overlap needed)', () => {
    expect(nextFocus(rects, 1, 'up')).toBe(0);
    expect(nextFocus(rects, 2, 'up')).toBe(0);
    expect(nextFocus(rects, 3, 'up')).toBe(0);
  });

  test('Down from the button goes to the tile under it', () => {
    expect(nextFocus(rects, 0, 'down')).toBe(3);
  });

  test('Right from the last tile of the first row does NOT jump up to the button', () => {
    // The button's centre is to the right of the tile's centre: without the shared-row condition for Right/Left
    // this would move focus UP. (Fails with the vertical-overlap check removed.)
    expect(nextFocus(rects, 3, 'right')).toBe(3);
    expect(nextFocus(rects, 0, 'left')).toBe(0);
    expect(nextFocus(rects, 0, 'right')).toBe(0);
  });
});

describe('nextFocus: unequal rectangles', () => {
  test('a wide tile above two narrow ones: Down picks the narrow tile in line with its centre; Up from each returns to the wide one', () => {
    const rects = [
      rect(0, 0, 300, 100), // 0 wide
      rect(0, 120, 140, 60), // 1 left narrow (shorter)
      rect(160, 120, 140, 100), // 2 right narrow (taller: its CENTRE is further down than 1's)
    ];
    // Both are 20 below the wide tile (the gap between the rectangles), and their centres (x 70 and x 230) are both 80 off the
    // wide tile's centre (x 150), so the tie goes to the lower index.
    expect(nextFocus(rects, 0, 'down')).toBe(1);
    expect(nextFocus(rects, 1, 'up')).toBe(0);
    // Tile 1's centre is higher than tile 2's, but it is BESIDE tile 2, not above it: Up goes to the wide tile.
    expect(nextFocus(rects, 2, 'up')).toBe(0);
    expect(nextFocus(rects, 1, 'down')).toBe(1);
    expect(nextFocus(rects, 2, 'down')).toBe(2);
  });

  test('Down ranks by the gap between rectangles, not between centres: a taller neighbour does not hide a nearer row', () => {
    // From the top tile, tile 1 is directly below (gap 10) and tall (centre far down); tile 2 is a small tile
    // further left whose centre is nearer by centre-to-centre distance but whose gap is bigger (60).
    const rects = [
      rect(100, 0, 100, 50), // 0
      rect(100, 60, 100, 400), // 1: gap 10, centre y 260
      rect(0, 110, 60, 40), // 2: gap 60, centre y 130
    ];
    expect(nextFocus(rects, 0, 'down')).toBe(1);
  });

  test('Right only considers tiles that share height with the current one', () => {
    const rects = [rect(0, 0, 100, 50), rect(120, 60, 100, 50), rect(120, 20, 100, 50)];
    // 1 sits wholly below 0's row (60 >= 50): not a Right candidate. 2 overlaps vertically.
    expect(nextFocus(rects, 0, 'right')).toBe(2);
  });

  test('rectangles that only touch along an edge do not share height', () => {
    const rects = [rect(0, 0, 100, 50), rect(120, 50, 100, 50)];
    expect(nextFocus(rects, 0, 'right')).toBe(0);
  });
});

describe('nextFocus: bad input never throws and never moves', () => {
  test('an unknown direction, a missing current rectangle or an empty list returns the same index', () => {
    const rects = grid(4);
    expect(nextFocus(rects, 1, 'diagonal')).toBe(1);
    expect(nextFocus(rects, 9, 'down')).toBe(9);
    expect(nextFocus([], 0, 'down')).toBe(0);
    expect(nextFocus(null, 0, 'down')).toBe(0);
  });

  test('a target with no rectangle (not laid out yet) is skipped, not chosen', () => {
    const rects = [rect(0, 0, 100, 50), null, rect(120, 0, 100, 50)];
    expect(nextFocus(rects, 0, 'right')).toBe(2);
  });
});
