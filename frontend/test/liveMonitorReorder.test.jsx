// What LiveMonitor does when a drag ENDS (#562): the order written to the server, and how many times.
//
// ★ THE DEFECT. handleDragEnd called api.put('/cameras/reorder') from INSIDE a setOrderedCameras updater.
// React may run an updater more than once (<StrictMode> does so on purpose in development, to expose a
// side effect inside one), so a single drop sent the same reorder twice. The fix computes the new order in
// the handler and sends one PUT. The test that fails without it is the "exactly one PUT, under StrictMode"
// one below: the unfixed code sends two.
//
// ★ HOW A DRAG IS DRIVEN HERE. dnd-kit starts a drag from real pointer events against real layout, which
// jsdom does not have (liveMonitor.test.jsx says so). So '@dnd-kit/core' is wrapped, not replaced: the
// real DndContext still renders (the tiles' useSortable needs it) and the wrapper only records the
// `onDragEnd` prop LiveMonitor passed, which the tests then call with the same `{ active, over }` event
// dnd-kit would. That exercises the real handler, the real state and the real PUT.
//
// WHAT THIS DOES NOT PROVE: that a finger drag produces that event (dnd-kit's own job, and e2e's), or
// that the grid animates. It proves what happens once the drop has been reported.
import { StrictMode } from 'react';
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import { api } from '../src/lib/api.js';

// The handler LiveMonitor handed to DndContext on its latest render.
let latestOnDragEnd = null;

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal();
  const React = await import('react');
  return {
    ...actual,
    DndContext: (props) => {
      latestOnDragEnd = props.onDragEnd;
      return React.createElement(actual.DndContext, props);
    },
  };
});

// c2 is switched off: it is in the saved order but not on the grid (liveMonitorHelpers.test.jsx).
const CAMS = [
  { id: 'c1', name: 'Nursery', mediamtx_path: 'p1' },
  { id: 'c2', name: 'Spare room', mediamtx_path: 'p2', disabled: 1 },
  { id: 'c3', name: 'Playroom', mediamtx_path: 'p3' },
];

const drop = (activeId, overId) => act(() => {
  latestOnDragEnd({ active: { id: activeId }, over: overId == null ? null : { id: overId } });
});
// Visible tile names in DOM order.
const gridOrder = () => screen.getAllByText(/^(Nursery|Playroom)$/).map((n) => n.textContent);

beforeEach(() => {
  latestOnDragEnd = null;
  vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('★★ dropping a tile (#562)', () => {
  test('★★ ONE PUT per drop, drop after drop, even under StrictMode, carrying the full order', () => {
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    expect(latestOnDragEnd).toBeTypeOf('function');

    drop('c1', 'c3');
    expect(api.put).toHaveBeenCalledTimes(1);
    // The saved order spans every camera, the disabled c2 included, in its kept place: c1 moved to c3's
    // slot in the FULL list, so [c1, c2, c3] -> [c2, c3, c1].
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c2', 'c3', 'c1'] });

    // ⚠️ THE FIRST DROP ALONE DOES NOT SHOW THE DEFECT. Measured against the unfixed code (React 18.3.1):
    // on a fresh fiber React computes the updater once, eagerly, at dispatch, so one drop sent one PUT and
    // this test passed. It is the SECOND and later drops, when the fiber already has pending work, that
    // run the updater again during render under StrictMode and send the request twice (3 PUTs after two
    // drops, 5 after three). So the count is asserted across several drops.
    drop('c3', 'c2');
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c3', 'c2', 'c1'] });

    drop('c1', 'c3');
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c1', 'c3', 'c2'] });
  });

  test('the grid shows the new order after the drop', () => {
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    expect(gridOrder()).toEqual(['Nursery', 'Playroom']);
    drop('c1', 'c3');
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
  });

  test('★ a second drop is built on the first one\'s result, not on the order the page loaded with', () => {
    // The handler reads `orderedCameras` from its render. One that kept the order the page loaded with
    // would build the second move from [c1, c2, c3] and send [c1, c3, c2] instead of [c3, c2, c1]. Two drops
    // with a render between them tell them apart.
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c3'); // [c2, c3, c1]
    drop('c3', 'c2'); // c3 to c2's slot: [c3, c2, c1]
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenNthCalledWith(1, '/cameras/reorder', { order: ['c2', 'c3', 'c1'] });
    expect(api.put).toHaveBeenNthCalledWith(2, '/cameras/reorder', { order: ['c3', 'c2', 'c1'] });
  });

  test('★ two drops reported inside ONE React batch: the second is built on the first, not on the stale render', () => {
    // No render happens between these two calls (one act), so the handler's closure still holds the order
    // the page loaded with. A handler that read only that closure would build the second move from
    // [c1, c2, c3] and send [c1, c3, c2]: the first drop silently undone. The old updater form did not
    // have this problem, and the ref in LiveMonitor exists so that moving the PUT out of it does not lose it.
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    act(() => {
      latestOnDragEnd({ active: { id: 'c1' }, over: { id: 'c3' } }); // [c2, c3, c1]
      latestOnDragEnd({ active: { id: 'c3' }, over: { id: 'c2' } }); // [c3, c2, c1]
    });
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenNthCalledWith(1, '/cameras/reorder', { order: ['c2', 'c3', 'c1'] });
    expect(api.put).toHaveBeenNthCalledWith(2, '/cameras/reorder', { order: ['c3', 'c2', 'c1'] });
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
  });

  test('a drop onto itself, or onto nothing, sends nothing', () => {
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c1');
    drop('c1', null);
    expect(api.put).not.toHaveBeenCalled();
    expect(gridOrder()).toEqual(['Nursery', 'Playroom']);
  });

  test('a failed save does not throw out of the handler (the grid keeps the new order)', async () => {
    // Fire-and-forget on purpose: surfacing a failed reorder is a design change (where, and whether to
    // roll the grid back), left on the issue. What is pinned is that the rejection is handled.
    api.put.mockRejectedValue(new Error('offline'));
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c3');
    await act(async () => { await Promise.resolve(); });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
  });

  test('a caregiver\'s drop sends nothing (the second line behind the missing handle)', () => {
    // The drag handle is not rendered for a caregiver, so this is unreachable by hand; the guard is the
    // line that keeps it so if a handle ever is. Reachable here only because the handler is called directly.
    renderAsCaregiver(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c3');
    expect(api.put).not.toHaveBeenCalled();
    expect(gridOrder()).toEqual(['Nursery', 'Playroom']);
  });
});
