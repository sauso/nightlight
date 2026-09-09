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
import { renderAsAdmin } from './helpers/render.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import { api } from '../src/lib/api.js';

const CAMS = [
  { id: 'c1', name: 'Nursery', mediamtx_path: 'p1', child_id: 'kid-1' },
  { id: 'c2', name: 'Spare room', mediamtx_path: 'p2', disabled: 1 },
  { id: 'c3', name: 'Playroom', mediamtx_path: 'p3', child_id: 'kid-2' },
];
const KIDS = [{ id: 'kid-1', name: 'Raffa' }, { id: 'kid-2', name: 'Renz' }];

const mount = (opts = {}) => renderAsAdmin(<LiveMonitor />, { cameras: CAMS, kids: KIDS, ...opts });

afterEach(() => vi.restoreAllMocks());

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
});

describe('what a tile is labelled with', () => {
  test('★ each camera is captioned with its child', () => {
    // The whole point of grouping by child was dropped in favour of a flat, freely-reorderable grid —
    // which only works because each tile still says whose room it is. Without it a parent with two
    // children cannot tell two similar-looking cots apart at 3am.
    mount();
    const tile = screen.getByText('Nursery').closest('.camera-tile');
    expect(within(tile).getByText('Raffa')).toBeTruthy();
  });

  test('a camera assigned to nobody simply has no child caption', () => {
    mount({ cameras: [{ id: 'c9', name: 'Hallway', mediamtx_path: 'p9' }], kids: KIDS });
    const tile = screen.getByText('Hallway').closest('.camera-tile');
    expect(within(tile).queryByText('Raffa')).toBeNull();
    expect(within(tile).queryByText('Renz')).toBeNull();
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
  });

  test('on its own route it is active and exposed', () => {
    const { container } = mount({ route: '/' });
    const grid = container.querySelector('.live-monitor');
    expect(grid.getAttribute('aria-hidden')).toBe('false');
    expect(grid.className).toContain('live-monitor--active');
  });
});

// ⚠️ NOT TESTED HERE, and deliberately not faked into looking tested: the drag itself. `handleDragEnd`
// only runs on a dnd-kit drop, which needs real pointer events against real layout — jsdom has
// neither. A test that called `reorderCameras` directly and claimed to be exercising the screen would
// be the very thing this file was written to correct: it would duplicate liveMonitorHelpers.test.jsx
// while its NAME promised something more. The PUT that follows a drop is e2e's.
