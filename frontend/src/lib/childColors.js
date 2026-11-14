// The six colours a child can be given (child settings), and how a STORED colour becomes the shade drawn on screen.
//
// Two different things are kept apart on purpose:
//   - the STORED value (`stored` below): a plain `#RRGGBB`, exactly what the picker has always saved. The server validates and
//     keeps it as given and nothing here rewrites it, so nothing in the database changes and an older app still shows it;
//   - the SHOWN colour: the CSS token `--child-<id>` (and `--child-<id>-on` for the initials on it) in index.css, which is
//     deeper in the light theme and the original lighter shade in the dark theme. The stored pastels are only 1.61 to 3.43:1
//     against a white card (five of the six under the 3:1 a ring or an avatar disc needs, and white initials fail 4.5:1 on all), so they cannot be drawn as they are by day.
//
// `stored` is therefore also the dark-theme shade (they are the same six values the picker always had). The measured contrast of
// every shade is in docs/design-language.md ("Child colours") and recomputed from the stylesheet by test/paletteTokens.test.jsx.

export const CHILD_COLORS = [
  { id: 'yellow', name: 'Yellow', stored: '#f4c56a' },
  { id: 'green', name: 'Green', stored: '#7FBFA3' },
  { id: 'blue', name: 'Blue', stored: '#8A9FE0' },
  { id: 'pink', name: 'Pink', stored: '#E0A5C9' },
  { id: 'orange', name: 'Orange', stored: '#E0B27F' },
  { id: 'violet', name: 'Violet', stored: '#7c83db' },
];

// A stored colour that is not one of the six, by name. `#F5D9A8` is the pale gold the server still gives a child created without
// a colour (backend/src/db.js, routes/children.js); the app itself moved that gold to the deeper `#f4c56a` (db.js, the accent
// migration), so it is yellow. By plain colour distance it would land on orange (60 away, against 65 for yellow), which is
// the wrong name for a pale yellow.
const KNOWN_LEGACY = { '#f5d9a8': 'yellow' };

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Which of the six a stored colour is. Display only: it picks the token to draw with and the swatch to mark; it never changes
// what is stored (a child saved with `#F5D9A8` stays `#F5D9A8` until someone picks a colour).
//   1. a case-insensitive match of one of the six stored values;
//   2. the known legacy value above;
//   3. any other `#RRGGBB` (the server accepts any, so an API client or an older release may have stored one): the NEAREST of
//      the six by straight RGB distance. Not perceptual, on purpose: this only has to give a custom colour a sensible
//      neighbour, ties go to the earlier entry, and a measured colour model would add code for nothing anyone can see.
// Returns null for no colour at all (undefined, empty, not a hex): the caller draws nothing rather than guess.
export function childColorId(stored) {
  if (typeof stored !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(stored)) return null;
  const lower = stored.toLowerCase();
  const exact = CHILD_COLORS.find((c) => c.stored.toLowerCase() === lower);
  if (exact) return exact.id;
  if (KNOWN_LEGACY[lower]) return KNOWN_LEGACY[lower];
  const want = rgb(lower);
  let best = null;
  let bestDistance = Infinity;
  for (const c of CHILD_COLORS) {
    const have = rgb(c.stored);
    const distance = (want[0] - have[0]) ** 2 + (want[1] - have[1]) ** 2 + (want[2] - have[2]) ** 2;
    if (distance < bestDistance) { best = c.id; bestDistance = distance; }
  }
  return best;
}

// The CSS values for a stored colour, or null. `fill` and `on` are for the avatar disc and its initials; `ring` is the card ring.
export function childColorVars(stored) {
  const id = childColorId(stored);
  if (!id) return null;
  return { id, fill: `var(--child-${id})`, on: `var(--child-${id}-on)`, ring: `var(--child-${id})`, ringOnNight: `var(--child-${id}-night)` };
}
