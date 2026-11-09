// The live grid.
//
// ★ WHY THIS FILE EXISTS AT ALL — it is a correction. LiveMonitor was excluded from coverage on the
// grounds that it renders a CameraTile per camera and therefore "mounts the whole player stack, which
// jsdom cannot run". An adversarial review checked that by simply trying it, and it is false: the
// screen renders under jsdom with a real tile mounted; jsdom logs a "Not implemented:
// HTMLMediaElement.load()" notice and nothing throws. The file was excluded because it LOOKED
// untestable from its import list.
//
// That matters beyond one file: the exclusion was hiding `visibleCameras`, which is real,
// user-visible, installation-independent logic — and it is the mirror of the asymmetry that
// `reorderCameras` exists for. The grid shows only ENABLED cameras while the saved order covers every
// camera; `reorderCameras` owns the "every camera" half (liveMonitorHelpers.test.jsx) and this file
// owns the "only enabled" half. Losing either one silently strands a camera.
//
// ⚠️ What is genuinely out of reach here, and is NOT pretended otherwise: the Capacitor
// picture-in-picture and background-pause effects (absent off-native), and pull-to-refresh, which
// needs real pointer gestures against real scroll position. Those are e2e's job.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import { api } from '../src/lib/api.js';
import { setTheme } from '../src/lib/theme.js';

const CAMS = [
  { id: 'c1', name: 'Nursery', mediamtx_path: 'p1', child_id: 'kid-1' },
  { id: 'c2', name: 'Spare room', mediamtx_path: 'p2', disabled: 1 },
  { id: 'c3', name: 'Playroom', mediamtx_path: 'p3', child_id: 'kid-2' },
];
const KIDS = [{ id: 'kid-1', name: 'Child B' }, { id: 'kid-2', name: 'Child A' }];

const mount = (opts = {}) => renderAsAdmin(<LiveMonitor />, { cameras: CAMS, kids: KIDS, ...opts });

afterEach(() => vi.restoreAllMocks());

describe('Live-only theme toggle', () => {
  test('Live shows the toggle and switches the theme', async () => {
    setTheme('light');
    const { user } = mount({ cameras: [] });
    await user.click(screen.getByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(screen.getByRole('button', { name: 'Switch to light mode' })).toBeInTheDocument();
  });

  test('the mounted monitor has no toggle on another route', () => {
    const { container } = mount({ cameras: [], route: '/settings' });
    // The inactive monitor is inert, so role queries cannot see its DOM even if the button exists.
    expect(container.querySelector('.app-header__theme')).toBeNull();
  });
});

describe('★★ which cameras reach the grid', () => {
  test('every enabled camera gets a tile', () => {
    mount();
    expect(screen.getByText('Nursery')).toBeTruthy();
    expect(screen.getByText('Playroom')).toBeTruthy();
  });

  test('★★ a camera an admin switched off is NOT on the grid', () => {
    // It has no stream, so a tile for it would sit there permanently reading "No signal" — which is
    // indistinguishable from a camera that is broken, and would send someone hunting for a fault they
    // themselves switched off.
    mount();
    expect(screen.queryByText('Spare room')).toBeNull();
  });

  test('★ but it stays in the list the reorder writes, keeping its position', () => {
    // The other half of the asymmetry, and the reason the filter is display-only. `orderedCameras`
    // holds all three; only the render is filtered. Asserted through the observable consequence:
    // exactly the enabled cameras are draggable, while the saved order (reorderCameras, tested
    // separately) still spans every camera.
    mount();
    expect(screen.getAllByText(/Nursery|Playroom|Spare room/).map((n) => n.textContent).sort())
      .toEqual(['Nursery', 'Playroom']);
  });

  test('no cameras at all says how to add one', () => {
    // A blank grid reads as broken. This is the first thing a fresh install sees.
    mount({ cameras: [] });
    expect(screen.getByText(/No cameras yet/)).toBeTruthy();
  });

  test('★ every camera being disabled shows the SAME empty state, not a blank grid', () => {
    // The branch is `visibleCameras.length === 0`, not `cameras.length === 0` — an install whose only
    // camera is switched off would otherwise get an empty page with nothing to explain it.
    mount({ cameras: [{ id: 'c2', name: 'Spare room', mediamtx_path: 'p2', disabled: 1 }] });
    expect(screen.getByText(/No cameras yet/)).toBeTruthy();
  });

  // ★ #380. Adding a camera is admin-only (the Cameras tab shows a caregiver no Add button and the server
  // refuses their POST), but the empty state told everyone to "Add one from the Cameras tab".
  test('★ #380 an admin is told to add a camera; a caregiver is told who can', () => {
    mount({ cameras: [] });
    expect(screen.getByText('No cameras yet. Add one from the Cameras tab to start watching.')).toBeTruthy();
  });

  test('★ #380 a caregiver is NOT sent to a tab that cannot add one', () => {
    renderAsCaregiver(<LiveMonitor />, { cameras: [], kids: KIDS });
    expect(screen.getByText('No cameras yet. Ask an administrator to add or enable a camera.')).toBeTruthy();
    expect(screen.queryByText(/Add one from the Cameras tab/)).toBeNull();
  });

  test('#380 the caregiver copy also covers "all cameras are switched off"', () => {
    // The same branch (visibleCameras empty) fires when every camera is disabled; "or enable" is the half
    // of the sentence that is true for that install, and enabling is admin-only too.
    renderAsCaregiver(<LiveMonitor />, {
      cameras: [{ id: 'c2', name: 'Spare room', mediamtx_path: 'p2', disabled: 1 }],
      kids: KIDS,
    });
    expect(screen.getByText(/Ask an administrator to add or enable a camera/)).toBeTruthy();
  });
});

describe('what a tile is labelled with', () => {
  test('★ each camera is captioned with its child', () => {
    // The whole point of grouping by child was dropped in favour of a flat, freely-reorderable grid —
    // which only works because each tile still says whose room it is. Without it a parent with two
    // children cannot tell two similar-looking cots apart at 3am.
    mount();
    const tile = screen.getByText('Nursery').closest('.camera-tile');
    expect(within(tile).getByText('Child B')).toBeTruthy();
  });

  test('a camera assigned to nobody simply has no child caption', () => {
    mount({ cameras: [{ id: 'c9', name: 'Hallway', mediamtx_path: 'p9' }], kids: KIDS });
    const tile = screen.getByText('Hallway').closest('.camera-tile');
    expect(within(tile).queryByText('Child B')).toBeNull();
    expect(within(tile).queryByText('Child A')).toBeNull();
  });

  test('a camera whose child no longer exists still renders', () => {
    // `kids.find(...)` returns undefined for a deleted child. A tile that threw here would take the
    // whole grid down — every camera — over one stale assignment.
    mount({ cameras: [{ id: 'c9', name: 'Hallway', mediamtx_path: 'p9', child_id: 'gone' }], kids: KIDS });
    expect(screen.getByText('Hallway')).toBeTruthy();
  });
});

describe('the screen as a whole', () => {
  test('a camera-loading error is shown above the grid', () => {
    mount({ error: 'Could not reach the server' });
    expect(screen.getByText('Could not reach the server')).toBeTruthy();
  });

  test('an error does not take the cameras away', () => {
    // The context keeps the last known cameras on a failed refresh, and the grid must keep showing
    // them — this is a baby monitor, and a transient error is not a reason to blank the video.
    mount({ error: 'Could not reach the server' });
    expect(screen.getByText('Nursery')).toBeTruthy();
  });

  test('★ off-route it is hidden from assistive tech, not just from view', () => {
    // The grid stays MOUNTED when you navigate away, so the streams do not have to be renegotiated
    // on every tab change. It therefore has to be hidden properly: `aria-hidden` as well as the CSS
    // class, or a screen reader would read out a whole camera grid on top of the page you are on.
    const { container } = mount({ route: '/settings' });
    const grid = container.querySelector('.live-monitor');
    expect(grid.getAttribute('aria-hidden')).toBe('true');
    expect(grid.className).toContain('live-monitor--hidden');
    // aria-hidden alone leaves its buttons in the Tab order (#376); inert takes them out of that and of the
    // accessibility tree while the streams stay mounted.
    expect(grid.hasAttribute('inert')).toBe(true);
  });

  test('on its own route it is active and exposed', () => {
    const { container } = mount({ route: '/' });
    const grid = container.querySelector('.live-monitor');
    expect(grid.getAttribute('aria-hidden')).toBe('false');
    expect(grid.className).toContain('live-monitor--active');
    expect(grid.hasAttribute('inert')).toBe(false);
  });
});

describe('★★ who can reorder the grid (#552, reopened by #675)', () => {
  // Every signed-in user can drag the tiles again (#675; admin-only from #552). The camera order can still
  // pick the camera a child's sleep is measured from, so the SERVER refuses a non-admin's drop that would
  // change it, and the grid puts the tiles back (liveMonitorReorder.test.jsx). What jsdom CAN show here is
  // the affordance: the drag handle is the only thing a drag starts from.
  test('an admin gets a drag handle on every tile on the grid', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Reorder Nursery' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reorder Playroom' })).toBeTruthy();
  });

  test('★ a caregiver gets a drag handle on every tile too (#675)', () => {
    renderAsCaregiver(<LiveMonitor />, { cameras: CAMS, kids: KIDS });
    expect(screen.getByRole('button', { name: 'Reorder Nursery' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reorder Playroom' })).toBeTruthy();
    // Still only the tiles on the grid: the switched-off camera has no tile, so no handle.
    expect(screen.queryByRole('button', { name: 'Reorder Spare room' })).toBeNull();
  });
});

describe('★ who silenced a camera, on its tile (#552)', () => {
  // The server sends `alerts_snoozed_by` (a username) only while the camera is muted; the tile must show it
  // there, and show NO "by" when it is null (a silence set before this existed, or by an older server).
  const muted = (by, untilMs = Date.now() + 3_600_000) => [
    { id: 'c9', name: 'Quiet room', mediamtx_path: 'p9', alerts_snoozed_until: untilMs, alerts_snoozed_by: by },
  ];
  const openMenu = (user) => user.click(screen.getByRole('button', { name: 'Camera settings' }));

  test('muted by someone: the strip and the un-mute button both name them, for a caregiver too', async () => {
    for (const render of [renderAsAdmin, renderAsCaregiver]) {
      const { user, unmount } = render(<LiveMonitor />, { cameras: muted('carer1') });
      expect(screen.getByTitle(/^Alerts muted until .+ by carer1$/)).toBeTruthy();
      await openMenu(user);
      expect(screen.getByRole('button', { name: /^Muted until .+ by carer1 · tap to un-mute$/ })).toBeTruthy();
      unmount();
    }
  });

  test('★ muted with no name: no "by" anywhere, not "by null" or "by undefined"', async () => {
    const { user } = renderAsAdmin(<LiveMonitor />, { cameras: muted(null) });
    const badge = screen.getByTitle(/^Alerts muted until /);
    expect(badge.getAttribute('title')).not.toMatch(/ by /);
    await openMenu(user);
    const button = screen.getByRole('button', { name: /^Muted until .+ · tap to un-mute$/ });
    expect(button.textContent).not.toMatch(/ by /);
  });

  test('a silence that has run out shows no mute and no name, even if a name came with it', async () => {
    const { user } = renderAsAdmin(<LiveMonitor />, { cameras: muted('carer1', Date.now() - 60_000) });
    expect(screen.queryByTitle(/^Alerts muted until /)).toBeNull();
    await openMenu(user);
    expect(screen.getByRole('button', { name: 'Silence alerts' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/carer1/);
  });
});

// ⚠️ NOT TESTED HERE, and deliberately not faked into looking tested: the drag GESTURE itself. dnd-kit
// starts a drag from real pointer events against real layout — jsdom has neither. What happens once a
// drop has been REPORTED (the order written, once, under StrictMode) is tested in
// liveMonitorReorder.test.jsx, which wraps DndContext to call the real `onDragEnd`; that file says what it
// does and does not prove. That a finger produces the drop event is dnd-kit's, and e2e's.
