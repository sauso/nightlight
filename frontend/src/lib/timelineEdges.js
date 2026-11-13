// Keeping the timeline's markers and axis labels inside the card's content box (owner, on a real phone, 2026-11-13: "slightly
// out of the bounds"). Everything on the bar is positioned by a percentage and centred on it, so a mark at the very start or end
// pokes half its own width past the bar, and the first and last hour labels poke past the card's content edge by half a label.
// Both are fixed in layout terms, with no measuring, so they stay right when the bar is resized or rotated.

// CSS `left` for a marker CENTRED on `pct` (0 to 100) that is `halfPx` wide on each side of its centre: the centre is held at
// least `halfPx` from either end, so the whole marker stays inside the bar and still points at its minute as nearly as it can.
// Returns undefined for a position that is not a number, so a malformed time draws nothing rather than a marker at the wrong end.
export function markerLeft(pct, halfPx) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  const p = Math.min(100, Math.max(0, pct));
  return `clamp(${halfPx}px, ${p}%, calc(100% - ${halfPx}px))`;
}

// How an hour label sits on its tick: left-aligned to the bar's left edge for a tick at the start, right-aligned to the right
// edge for one at the end, centred otherwise. "At the start" is the first 5% of the bar, which is wider than one label's half
// width on every phone (a 10px label is about 20px wide, 5% of a 260px bar is 13px), so a label near an edge never pokes out.
export const EDGE_LABEL_ZONE_PCT = 5;
export function tickLabelAlign(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'center';
  if (pct < EDGE_LABEL_ZONE_PCT) return 'start';
  if (pct > 100 - EDGE_LABEL_ZONE_PCT) return 'end';
  return 'center';
}
