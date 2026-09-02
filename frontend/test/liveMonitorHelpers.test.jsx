// `reorderCameras` — the drag-to-reorder logic behind the live grid.
//
// ⚠️ SCOPE, stated plainly: LiveMonitor itself renders one CameraTile per camera and so mounts the
// whole WebRTC/HLS player stack, plus Capacitor picture-in-picture and pointer-gesture
// pull-to-refresh. None of that exists in jsdom, so the component is excluded from coverage and is
// covered for real by the Playwright suite. This is the logic that CAN be tested honestly, extracted
// for that purpose — the same arrangement as CameraTile's `detectionPayload`.
//
// ★ WHY IT EARNS A TEST. The grid shows only ENABLED cameras, but the order it SAVES covers every
// camera, disabled ones included. That asymmetry is the whole point: a camera switched off keeps its
// place and comes back where it was, instead of being shunted to the end by the first drag anybody
// does. Get it wrong and nothing looks broken — the reorder works, and a camera silently loses its
// position days later when someone turns it back on.
import { describe, test, expect } from 'vitest';
import { reorderCameras } from '../src/components/LiveMonitor.jsx';

// Cameras B and D are disabled, so the grid renders A, C, E while the saved order is A–E.
const CAMS = [
  { id: 'A' },
  { id: 'B', disabled: 1 },
  { id: 'C' },
  { id: 'D', disabled: 1 },
  { id: 'E' },
];
const ids = (list) => list.map((c) => c.id).join('');

describe('reorderCameras', () => {
  test('moves the dragged camera to the target position', () => {
    expect(ids(reorderCameras(CAMS, 'E', 'A'))).toBe('EABCD');
  });

  test('moving forwards closes the gap behind it', () => {
    // The other direction, which is the one an off-by-one gets wrong: dnd-kit's arrayMove removes
    // first and inserts second, so forwards and backwards are not symmetric.
    expect(ids(reorderCameras(CAMS, 'A', 'C'))).toBe('BCADE');
  });

  test('★★ disabled cameras stay in the saved order, keeping their position', () => {
    // The property the whole design turns on. Dragging E ahead of C moves it past D, which is not on
    // screen — and D has to stay exactly where it was, between C and E's old slot.
    const next = reorderCameras(CAMS, 'E', 'C');
    expect(ids(next)).toBe('ABECD');
    expect(next.filter((c) => c.disabled).map((c) => c.id), 'both disabled cameras survive the write').toEqual(['B', 'D']);
  });

  test('★ every camera is still there afterwards — the order is what gets saved', () => {
    // The saved order is the full list of ids. Losing one here would drop that camera out of the
    // order entirely, and nothing on the grid would show it.
    const next = reorderCameras(CAMS, 'C', 'A');
    expect(next).toHaveLength(CAMS.length);
    expect([...ids(next)].sort().join('')).toBe('ABCDE');
  });

  test('★ an unknown id changes nothing at all', () => {
    // findIndex returns -1 for an id not in the list, and arrayMove(-1) silently moves the LAST
    // element — so without the guard a stale drag (a camera deleted on another device mid-drag)
    // would quietly reorder a camera nobody touched.
    expect(ids(reorderCameras(CAMS, 'Z', 'A'))).toBe('ABCDE');
    expect(ids(reorderCameras(CAMS, 'A', 'Z'))).toBe('ABCDE');
  });

  test('does not mutate the list it was given', () => {
    // React state: mutating in place would leave the new array === the old one, and the grid would
    // not re-render even though the order had changed.
    const original = [...CAMS];
    reorderCameras(CAMS, 'A', 'E');
    expect(CAMS).toEqual(original);
  });

  test('a single camera is a no-op rather than an error', () => {
    expect(ids(reorderCameras([{ id: 'A' }], 'A', 'A'))).toBe('A');
  });
});
