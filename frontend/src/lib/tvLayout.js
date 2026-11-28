// How many columns the TV screen lays its camera tiles in, by how many cameras there are (pages/TvMonitor.jsx).
//
//   1 camera   -> 1 column  (one big tile)
//   2 cameras  -> 2 columns (side by side)
//   3-4        -> 2 columns (a 2 x 2 grid; the 4th slot stays empty for 3)
//   5 or more  -> 3 columns (the page scrolls by row; the focused tile is kept in view)
//
// Chosen by judgement for a 10-foot screen, not measured: three tiles across is the most that still shows a
// camera name in type big enough to read from a sofa on a 1080p screen, and two rows is what fits without scrolling.
// A household with many cameras is the case this does NOT optimise (it scrolls); say so in docs/mobile.md.
export function tvColumns(count) {
  if (!(count >= 1)) return 1;
  if (count === 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

export function tvRows(count) {
  if (!(count >= 1)) return 1;
  return Math.ceil(count / tvColumns(count));
}
