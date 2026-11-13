// A display choice: neighbouring one-minute stirs make a busy bar look striped.
// This threshold is not a sleep-detection or scoring threshold; source segments stay intact.
export const STIR_DRAW_GAP_MIN = 3;

export function timelineDrawingSegments(segments) {
  const drawn = [];
  for (let i = 0; i < segments.length; i += 1) {
    const first = segments[i];
    if (first.state !== 'stir') {
      drawn.push(first);
      continue;
    }
    let last = first;
    let minutes = first.minutes;
    while (i + 1 < segments.length) {
      const next = segments[i + 1];
      if (next.state === 'stir') {
        i += 1;
        last = next;
        minutes += next.minutes;
      } else if (next.state === 'asleep' && next.minutes < STIR_DRAW_GAP_MIN && segments[i + 2]?.state === 'stir') {
        i += 2;
        last = segments[i];
        minutes += next.minutes + last.minutes;
      } else {
        break;
      }
    }
    drawn.push({ ...first, to_at: last.to_at, minutes });
  }
  return drawn;
}
