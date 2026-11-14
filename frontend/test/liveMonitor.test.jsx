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
import CameraTile from '../src/components/CameraTile.jsx';
import { Route, Routes, useLocation } from 'react-router-dom';
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

describe('Live tile strip and sheet (#1076)', () => {
  test.each([
    ['live', false, false, 'Online', 'breathing--live'],
    ['connecting', false, false, 'Connecting', 'breathing--connecting'],
    ['offline', false, false, 'Offline', 'breathing--offline'],
    ['connecting', true, false, 'Status unknown', 'breathing--connecting'],
    ['offline', false, true, 'Disabled', 'dot--neutral'],
  ])('cameraState renders %s / unknown %s / disabled %s as %s', (statusLevel, statusUnknown, disabled, word, dot) => {
    const { container } = renderAsAdmin(<CameraTile camera={{ id: 'state', name: 'Camera', statusLevel, statusUnknown, disabled }} childName="A child" />);
    const strip = container.querySelector('.camera-tile__meta');
    // Strip: the dot sits in the SAME row as the name, before it (owner decision, option C), and the word is only
    // visually hidden text after the name, part of the row's accessible text ("Camera, Online").
    const row = within(strip).getByText('Camera').closest('.camera-tile__title');
    expect(row).not.toBeNull();
    expect(row.querySelector(`.${dot}`)).toBeInTheDocument();
    const dotBox = row.querySelector('.camera-tile__dot');
    expect(dotBox).toHaveAttribute('aria-hidden', 'true');
    expect(dotBox.compareDocumentPosition(within(row).getByText('Camera')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.querySelector('.camera-tile__sr')).toHaveTextContent(`, ${word}`);
    expect(row).toHaveTextContent(`Camera, ${word}`);
    // Nothing prints the word in the strip any more: no status line above the name, no visible word.
    expect(strip.querySelector('.camera-tile__state')).toBeNull();
    expect(within(strip).queryByText(word)).toBeNull();
    expect(within(strip).getByText('A child')).toBeInTheDocument();
  });

  // The word the strip no longer prints is printed (visibly, not in a visually hidden element) in the camera's
  // sheet with the same dot, so colour is never the only signal.
  test.each([
    ['live', false, false, 'Online', 'breathing--live'],
    ['connecting', false, false, 'Connecting', 'breathing--connecting'],
    ['offline', false, false, 'Offline', 'breathing--offline'],
    ['connecting', true, false, 'Status unknown', 'breathing--connecting'],
    ['offline', false, true, 'Disabled', 'dot--neutral'],
  ])('the camera sheet prints the status dot and word for %s / unknown %s / disabled %s as %s', async (statusLevel, statusUnknown, disabled, word, dot) => {
    const { user } = renderAsAdmin(<CameraTile camera={{ id: 'sheet', name: 'Camera', statusLevel, statusUnknown, disabled }} childName="A child" />);
    await user.click(screen.getByRole('button', { name: 'Camera settings' }));
    const sheet = document.querySelector('.tile-menu');
    const state = sheet.querySelector('.tile-menu__state');
    expect(state).toHaveTextContent(word);
    expect(within(sheet).getByText(word)).toBeVisible();
    expect(within(sheet).getByText(word).closest('.camera-tile__sr')).toBeNull();
    expect(state.querySelector(`.${dot}`)).toBeInTheDocument();
    expect(state.querySelector('.camera-tile__dot')).toHaveAttribute('aria-hidden', 'true');
    // The state line sits right under the camera name in the sheet header.
    expect(sheet.querySelector('.tile-menu__title').nextElementSibling).toBe(state);
  });

  test('temperature and humidity are separate icon chips beside a wrapping name and the drag handle', () => {
    const { container } = renderAsAdmin(<CameraTile camera={{ id: 'readings', name: 'A long camera name', mqtt: { temperature: 21.5, humidity: 48 } }}
      childName="A child" dragHandleProps={{}} />);
    const strip = container.querySelector('.camera-tile__meta');
    expect(strip.querySelector('.camera-tile__name')).toHaveTextContent('A long camera name');
    expect(within(strip).getByRole('button', { name: 'Reorder A long camera name' })).toBeInTheDocument();
    const chips = strip.querySelectorAll('.camera-tile__reading');
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent('21.5°C');
    expect(chips[1]).toHaveTextContent('48%');
    expect(chips[0].querySelector('svg')).toBeInTheDocument();
    expect(chips[1].querySelector('svg')).toBeInTheDocument();
  });

  test('segmented buttons keep pressed state and change their selections', async () => {
    const { user, container } = mount({ cameras: [{ ...CAMS[0], has_sub: true }] });
    await user.click(screen.getByRole('button', { name: 'Camera settings' }));
    for (const groupName of ['Connection mode', 'Stream quality']) {
      expect(screen.getByRole('group', { name: groupName })).toHaveClass('seg-track');
    }
    const mode = screen.getByRole('group', { name: 'Connection mode' });
    await user.click(within(mode).getByRole('button', { name: 'Compatibility' }));
    expect(within(mode).getByRole('button', { name: 'Compatibility' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(mode).getByRole('button', { name: 'Low latency' })).toHaveAttribute('aria-pressed', 'false');
    const quality = screen.getByRole('group', { name: 'Stream quality' });
    await user.click(within(quality).getByRole('button', { name: 'Low' }));
    expect(within(quality).getByRole('button', { name: 'Low' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.tile-menu__actions')).toBeInTheDocument();
  });

  test('Stop and Camera settings are rows with unchanged actions; caregiver has no settings row', async () => {
    const { user, unmount } = mount({ cameras: [CAMS[0]] });
    await user.click(screen.getByRole('button', { name: 'Camera settings' }));
    const stop = screen.getByRole('button', { name: 'Stop', exact: true });
    expect(stop).toHaveClass('tile-menu__action');
    expect(within(document.querySelector('.tile-menu')).getByRole('button', { name: 'Camera settings', exact: true })).toHaveClass('tile-menu__action');
    await user.click(stop);
    expect(screen.getByText('Camera stopped')).toBeInTheDocument();
    unmount();
    localStorage.removeItem('nightlight_stopped_c1');
    const carer = renderAsCaregiver(<LiveMonitor />, { cameras: [{ ...CAMS[0], id: 'c-care' }], kids: KIDS });
    await carer.user.click(screen.getByRole('button', { name: 'Camera settings' }));
    expect(within(document.querySelector('.tile-menu')).queryByRole('button', { name: 'Camera settings', exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop', exact: true })).toHaveClass('tile-menu__action');
  });

  test('Camera settings row still opens this camera with Live as its back destination', async () => {
    function Destination() {
      const location = useLocation();
      return <div>Camera route {location.pathname}, back {location.state?.from?.to}</div>;
    }
    const { user } = renderAsAdmin(<Routes>
      <Route path="/" element={<LiveMonitor />} />
      <Route path="/cameras/:id" element={<Destination />} />
    </Routes>, { cameras: [CAMS[0]], kids: KIDS });
    await user.click(screen.getByRole('button', { name: 'Camera settings' }));
    await user.click(within(document.querySelector('.tile-menu')).getByRole('button', { name: 'Camera settings' }));
    expect(screen.getByText('Camera route /cameras/c1, back /')).toBeInTheDocument();
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
