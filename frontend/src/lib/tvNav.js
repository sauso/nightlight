// Arrow-key focus movement for the TV screen (pages/TvMonitor.jsx), as one pure function.
//
// WHY our own and not the WebView's Tab order or a library: a TV remote has four arrows and no pointer, the
// WebView's default order follows the DOM (row by row, so Down from the left tile would go RIGHT), and the
// grid has a ragged last row, a button above the tiles and tiles that look "unavailable" (offline) but must stay
// reachable. One function over the tiles' on-screen rectangles is testable without a browser.
//
// `rects` is one rectangle per focus target, in any order that is stable for the caller: { left, top, right, bottom }
// (a DOMRect from getBoundingClientRect has exactly these). `current` is the index of the focused target.
// Returns the index to focus next, or `current` when there is nowhere to go (no wrap-around: the edge of the grid
// is the edge).
//
// THE RULE (the tests state it case by case):
//   A target is a candidate for a direction only if it lies WHOLLY beyond the current one along that axis (for Down:
//   its top is at or below the current one's bottom, with a pixel of slack for rounding). So its centre is beyond
//   too, and side-by-side tiles of different heights never count as "above" or "below" each other.
//   Candidates are ranked by
//     1. the gap between the two rectangles along the axis of movement (the nearest row or column),
//     2. then the distance between the centres across that axis (the one most in line),
//     3. then the lower index (so the answer never depends on the order the browser reports ties).
//   Left and Right ADDITIONALLY require that the candidate shares some height with the current one: Right never
//   jumps to another row. Up and Down have no such condition, because a ragged last row must be reachable from a
//   tile that is not above it (7 tiles in 3 columns: Down from the middle tile of row two goes to the lone tile
//   under the first column).
// Why gaps and not centre-to-centre distance for rank 1: with unequal rectangles (a wide tile above two narrow
// ones) the centre of a taller tile is further away than that of a shorter tile in the same row, which would
// skip the row's nearest member.

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

// Sub-pixel layout rounding (and the focused tile growing a little) must not make a neighbour look as if it overlaps.
const EDGE_SLACK = 1;

const centreX = (r) => (r.left + r.right) / 2;
const centreY = (r) => (r.top + r.bottom) / 2;
// Strict overlap: two rectangles that only touch along an edge do not share height.
const overlapsVertically = (a, b) => a.top < b.bottom && b.top < a.bottom;

export function nextFocus(rects, current, direction) {
  if (!Array.isArray(rects) || !DIRECTIONS.has(direction)) return current;
  const from = rects[current];
  if (!from) return current;

  const horizontal = direction === 'left' || direction === 'right';
  let best = -1;
  let bestGap = Infinity;
  let bestAcross = Infinity;

  for (let i = 0; i < rects.length; i += 1) {
    if (i === current) continue;
    const to = rects[i];
    if (!to) continue;

    let gap;
    let across;
    if (horizontal) {
      gap = direction === 'right' ? to.left - from.right : from.left - to.right;
      if (gap < -EDGE_SLACK || !overlapsVertically(from, to)) continue;
      across = Math.abs(centreY(to) - centreY(from));
    } else {
      gap = direction === 'down' ? to.top - from.bottom : from.top - to.bottom;
      if (gap < -EDGE_SLACK) continue;
      across = Math.abs(centreX(to) - centreX(from));
    }
    gap = Math.max(0, gap);

    // Strictly better only: a full tie keeps the earlier (lower) index, since i only grows.
    if (gap < bestGap || (gap === bestGap && across < bestAcross)) {
      best = i;
      bestGap = gap;
      bestAcross = across;
    }
  }
  return best === -1 ? current : best;
}
