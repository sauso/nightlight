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
//
// ★ #675: EVERY signed-in user can drag, and the server may REFUSE a drop (409, reason
// `would_change_sleep_camera`: a non-admin moved the camera a tracked child is measured from). LiveMonitor
// therefore sends the saves ONE AT A TIME (a promise chain), so every PUT assertion below waits for the chain
// (`settle()`) instead of expecting the request synchronously; the #562 tests keep their names and their
// meaning (one PUT per drop, each built on the last). The refusal tests use a STATEFUL cameras context
// (`StatefulCameras`, below) whose refresh() publishes what the stand-in server holds, the way the real
// CamerasProvider does, and they assert the ORDER ON SCREEN, never that refresh was called.
import { StrictMode, useState } from 'react';
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import { CamerasContext } from '../src/lib/CamerasContext.jsx';
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
// Let the save chain run to the end (#675): one macrotask runs only after every queued microtask, and the
// stand-in api.put answers with promises, never timers.
const settle = () => act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
// Visible tile names in DOM order.
const gridOrder = () => screen.getAllByText(/^(Nursery|Playroom|Landing)$/).map((n) => n.textContent);

beforeEach(() => {
  latestOnDragEnd = null;
  vi.spyOn(api, 'put').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

describe('★★ dropping a tile (#562)', () => {
  test('★★ ONE PUT per drop, drop after drop, even under StrictMode, carrying the full order', async () => {
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    expect(latestOnDragEnd).toBeTypeOf('function');

    drop('c1', 'c3');
    await settle();
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
    await settle();
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c3', 'c2', 'c1'] });

    drop('c1', 'c3');
    await settle();
    expect(api.put).toHaveBeenCalledTimes(3);
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c1', 'c3', 'c2'] });
  });

  test('the grid shows the new order after the drop', async () => {
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    expect(gridOrder()).toEqual(['Nursery', 'Playroom']);
    drop('c1', 'c3');
    // At once (optimistic), and still after the save has answered.
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
    await settle();
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
  });

  test('★ a second drop is built on the first one\'s result, not on the order the page loaded with', async () => {
    // The handler reads `orderedCameras` from its render. One that kept the order the page loaded with
    // would build the second move from [c1, c2, c3] and send [c1, c3, c2] instead of [c3, c2, c1]. Two drops
    // with a render between them tell them apart.
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c3'); // [c2, c3, c1]
    drop('c3', 'c2'); // c3 to c2's slot: [c3, c2, c1]
    await settle();
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenNthCalledWith(1, '/cameras/reorder', { order: ['c2', 'c3', 'c1'] });
    expect(api.put).toHaveBeenNthCalledWith(2, '/cameras/reorder', { order: ['c3', 'c2', 'c1'] });
  });

  test('★ two drops reported inside ONE React batch: the second is built on the first, not on the stale render', async () => {
    // No render happens between these two calls (one act), so the handler's closure still holds the order
    // the page loaded with. A handler that read only that closure would build the second move from
    // [c1, c2, c3] and send [c1, c3, c2]: the first drop silently undone. The old updater form did not
    // have this problem, and the ref in LiveMonitor exists so that moving the PUT out of it does not lose it.
    // (The PUT bodies are fixed when the drop is handled; the chain only decides WHEN each is sent.)
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    act(() => {
      latestOnDragEnd({ active: { id: 'c1' }, over: { id: 'c3' } }); // [c2, c3, c1]
      latestOnDragEnd({ active: { id: 'c3' }, over: { id: 'c2' } }); // [c3, c2, c1]
    });
    await settle();
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenNthCalledWith(1, '/cameras/reorder', { order: ['c2', 'c3', 'c1'] });
    expect(api.put).toHaveBeenNthCalledWith(2, '/cameras/reorder', { order: ['c3', 'c2', 'c1'] });
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
  });

  test('a drop onto itself, or onto nothing, sends nothing', async () => {
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c1');
    drop('c1', null);
    await settle();
    expect(api.put).not.toHaveBeenCalled();
    expect(gridOrder()).toEqual(['Nursery', 'Playroom']);
  });

  test('a failed save does not throw out of the handler (the grid keeps the new order)', async () => {
    // A network failure is still silent (#675 surfaces ONLY the server's sleep-camera refusal, below): the
    // grid keeps the new order until the next cameras poll. What is pinned is that the rejection is handled.
    api.put.mockRejectedValue(new Error('offline'));
    renderAsAdmin(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c3');
    await settle();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('★★ a caregiver\'s drop is saved too (#675): ONE PUT with the full order', async () => {
    // Until #675 a caregiver's drop sent nothing (reordering was admin-only, #552). The server now decides,
    // per drop, and refuses only a move of a tracked child's sleep camera (the refusal tests below).
    renderAsCaregiver(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
    drop('c1', 'c3');
    await settle();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c2', 'c3', 'c1'] });
    expect(gridOrder()).toEqual(['Playroom', 'Nursery']);
  });
});

// ---- #675: the server refuses a drop that would change a tracked child's sleep camera ----------------------

// Three tiles on the grid (c2 is switched off, as above), so "back to before", "the refused order" and "the
// server's newer order" are three DIFFERENT arrangements on screen.
const CAMS4 = [
  { id: 'c1', name: 'Nursery', mediamtx_path: 'p1' },
  { id: 'c2', name: 'Spare room', mediamtx_path: 'p2', disabled: 1 },
  { id: 'c3', name: 'Playroom', mediamtx_path: 'p3' },
  { id: 'c4', name: 'Landing', mediamtx_path: 'p4' },
];
const REFUSAL = 'This move would change which camera is used for sleep tracking and the nightly timelapse of '
  + 'Child A, so the new order was not saved. An admin can choose a main camera for Child A in their settings, '
  + 'after which tiles can be rearranged freely.';
// The error lib/api.js throws for the server's 409 (message = the body's `error`, plus `status` and `data`).
function refusalError() {
  const err = new Error(REFUSAL);
  err.status = 409;
  err.data = { error: REFUSAL, reason: 'would_change_sleep_camera', children: [{ id: 'kid-1', name: 'Child A' }] };
  return err;
}
// A stand-in for the server: the shared camera order, and a reorder route that stores an accepted order and
// refuses (with the real error shape) any order `refuse` rejects. Here the rule is "c1 must stay first".
function makeServer({ refuse = (order) => order[0] !== 'c1' } = {}) {
  const server = { cameras: CAMS4.map((c) => ({ ...c })) };
  server.setOrder = (order) => { server.cameras = order.map((id) => server.cameras.find((c) => c.id === id)); };
  api.put.mockImplementation(async (url, { order }) => {
    if (refuse(order)) throw refusalError();
    server.setOrder(order);
    return { ok: true };
  });
  return server;
}
// A STATEFUL cameras context, standing in for CamerasProvider: refresh() publishes the server's current order
// as a new array (so LiveMonitor's effect resets the grid to it), as the real load() does. `refreshWorks:
// false` is a refresh that fails: the real load() then keeps the cameras it had, which is what this does.
function StatefulCameras({ server, refreshWorks = true, children }) {
  const [cameras, setCameras] = useState(server.cameras);
  const refresh = async () => {
    if (refreshWorks) setCameras(server.cameras.map((c) => ({ ...c })));
  };
  return (
    <CamerasContext.Provider value={{ kids: [], cameras, error: '', loaded: true, refresh }}>
      {children}
    </CamerasContext.Provider>
  );
}
const renderWithServer = (server, opts = {}) => renderAsCaregiver(
  <StatefulCameras server={server} {...opts}><StrictMode><LiveMonitor /></StrictMode></StatefulCameras>,
);

describe('★★ a drop the server refuses (#675)', () => {
  test('★★ the tiles go back AT ONCE and the server\'s words are shown, even when the refresh fails', async () => {
    // refreshWorks: false, so only LiveMonitor's own restore can put the tiles back: a revert left to refresh()
    // would leave the refused order on screen whenever the refresh fails.
    const server = makeServer();
    const { user } = renderWithServer(server, { refreshWorks: false });
    expect(gridOrder()).toEqual(['Nursery', 'Playroom', 'Landing']);

    drop('c1', 'c4'); // [c2, c3, c4, c1]: c1 is no longer first, refused
    expect(gridOrder()).toEqual(['Playroom', 'Landing', 'Nursery']); // optimistic, until the answer
    await settle();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(gridOrder()).toEqual(['Nursery', 'Playroom', 'Landing']);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain(REFUSAL);

    // The next drop is built on the order now on screen, not on the refused one.
    drop('c3', 'c4'); // [c1, c2, c4, c3]: allowed
    await settle();
    expect(api.put).toHaveBeenCalledTimes(2);
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c1', 'c2', 'c4', 'c3'] });
    expect(gridOrder()).toEqual(['Nursery', 'Landing', 'Playroom']);

    // Dismissible: it is about one drop.
    await user.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('★ two drops in ONE batch, the first refused: the second is never sent, and the tiles show the order from before both', async () => {
    // The second drop was built on the refused order. Judged on its own it would be refused too, and putting
    // back "the order before IT" would put back the refused order; so it is not sent at all.
    const server = makeServer();
    renderWithServer(server, { refreshWorks: false });
    act(() => {
      latestOnDragEnd({ active: { id: 'c1' }, over: { id: 'c4' } }); // [c2, c3, c4, c1]: refused
      latestOnDragEnd({ active: { id: 'c3' }, over: { id: 'c4' } }); // [c2, c4, c3, c1]: built on it
    });
    await settle();
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(api.put).toHaveBeenLastCalledWith('/cameras/reorder', { order: ['c2', 'c3', 'c4', 'c1'] });
    expect(gridOrder()).toEqual(['Nursery', 'Playroom', 'Landing']);
    expect(screen.getByRole('alert').textContent).toContain(REFUSAL);
  });

  test('★ once the saves have settled after a refusal, the tiles show the SERVER\'s order', async () => {
    // The order is shared: another viewer saved [c1, c2, c4, c3] after this page last loaded. Putting back
    // this page's own "before" is right at once, but the server's order is the truth once the chain is idle.
    const server = makeServer();
    renderWithServer(server);
    server.setOrder(['c1', 'c2', 'c4', 'c3']);
    drop('c1', 'c3'); // built on this page's [c1, c2, c3, c4]: [c2, c3, c1, c4], refused
    await settle();
    expect(gridOrder()).toEqual(['Nursery', 'Landing', 'Playroom']);
    expect(screen.getByRole('alert').textContent).toContain(REFUSAL);
  });

  test('★ ONLY that refusal reverts: a demo 403, a 401, another 409, a 5xx and a network failure stay silent', async () => {
    // As before #675: the grid keeps the new order and nothing is shown. The public demo answers every write
    // with a read-only 403, so treating any 4xx as a refusal would put a banner on every drag there.
    const failure = (status, message, data) => Object.assign(new Error(message), { status, data });
    const failures = [
      failure(403, 'This demo is read-only, so changes are disabled. You can still explore the sample data.',
        { error: 'This is a read-only public demo - that action is disabled here.' }),
      failure(401, 'Invalid or expired session', { error: 'Invalid or expired session' }),
      failure(409, 'That conflicts with the current state.', { error: 'That conflicts with the current state.' }),
      failure(502, 'Request failed (502)', null),
      new Error('Failed to fetch'),
    ];
    for (const err of failures) {
      api.put.mockRejectedValueOnce(err);
      const { unmount } = renderAsCaregiver(<StrictMode><LiveMonitor /></StrictMode>, { cameras: CAMS });
      drop('c1', 'c3');
      await settle();
      expect(gridOrder(), err.message).toEqual(['Playroom', 'Nursery']);
      expect(screen.queryByRole('alert'), err.message).toBeNull();
      unmount();
    }
  });
});
