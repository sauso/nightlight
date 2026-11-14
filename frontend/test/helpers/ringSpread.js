// The spread of a child photo's colour ring, in px, read from the element's inline box-shadow (`0 0 0 <spread> <colour>`).
// The ring is nothing but that spread: a ring whose shadow is 0px wide paints nothing, yet still has the `data-child-ring` hook
// and the token name in its style, so a test that checks only those cannot tell a ring from no ring (PR #1100 review). Tests
// assert it is POSITIVE (`toBeGreaterThan(0)`), never an exact width: the width is a design choice, "there is a visible ring"
// is the behaviour. Returns 0 when there is no box-shadow or it has no spread, so "no ring" and "zero ring" read the same.
export function ringSpreadPx(el) {
  const m = /box-shadow:\s*\S+\s+\S+\s+\S+\s+(-?\d*\.?\d+)px/.exec(el.getAttribute('style') || '');
  return m ? parseFloat(m[1]) : 0;
}
