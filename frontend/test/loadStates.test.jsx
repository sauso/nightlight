// Loading, failed and genuinely-empty are three different answers (#375). Each screen below used to render
// the empty copy for all three. Per screen: FAILED shows the error and Retry and NOT the empty copy;
// EMPTY shows the empty copy; LOADING shows neither. Where the screen has a stale case, a failure after a
// good load keeps the list.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, forEachRole, renderAs } from './helpers/render.jsx';
import Children from '../src/pages/Children.jsx';
import ChildDetail from '../src/pages/ChildDetail.jsx';
import Cameras from '../src/pages/Cameras.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import SleepDetail from '../src/pages/SleepDetail.jsx';
import ClipManagement from '../src/pages/ClipManagement.jsx';
import LoadFailed from '../src/components/LoadFailed.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

const KID = { id: 'kid-1', name: 'Child A', birthday: null, color: '#f4c56a', photo: null };
const CAM = { id: 'cam-1', name: 'Nursery', mediamtx_path: 'p1', child_id: 'kid-1', statusLevel: 'live' };
const DOWN = 'Cannot reach Nightlight';

// The state a provider is in. `loaded` false + no error is the cold start; false + error is a failed first
// request; true + error is a failure after a good load.
const LOADING = { camerasLoaded: false, error: '' };
const FAILED = { camerasLoaded: false, error: DOWN };
const STALE = { camerasLoaded: true, error: DOWN };

describe('Children', () => {
  const EMPTY_COPY = /No children yet/;

  test('★ failed: the error and Retry, NOT "No children yet", NOT Add child (either role)', async () => {
    await forEachRole(async (_n, who) => {
      const { unmount } = renderAs(who, <Children />, { kids: [], ...FAILED });
      expect(screen.getByText(DOWN)).toBeTruthy();
      expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
      expect(screen.queryByText(EMPTY_COPY)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add child' })).toBeNull();
      unmount();
    });
  });

  test('empty: the empty copy, and the admin gets Add child', () => {
    renderAsAdmin(<Children />, { kids: [] });
    expect(screen.getByText(EMPTY_COPY)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add child' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  test('loading: neither the empty copy nor the error', () => {
    renderAsAdmin(<Children />, { kids: [], ...LOADING });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add child' })).toBeNull();
  });

  test('stale: the last children stay, labelled as possibly out of date, with Retry', () => {
    renderAsAdmin(<Children />, { kids: [KID], ...STALE });
    expect(screen.getByText('Child A')).toBeTruthy();
    expect(screen.getByText(/Couldn’t refresh children/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(EMPTY_COPY)).toBeNull();
  });

  test('Retry asks the provider to reload', async () => {
    const { user, camerasValue } = renderAsAdmin(<Children />, { kids: [], ...FAILED });
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(camerasValue.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('Cameras tab', () => {
  test('★ failed: the error and Retry, NOT "No cameras added yet"', () => {
    renderAsAdmin(<Cameras />, { cameras: [], ...FAILED });
    expect(screen.getByText(DOWN)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText('No cameras added yet.')).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add camera' })).toBeNull();
  });
  test('empty: the empty copy', () => {
    renderAsAdmin(<Cameras />, { cameras: [] });
    expect(screen.getByText('No cameras added yet.')).toBeTruthy();
  });
  test('loading: neither', () => {
    renderAsAdmin(<Cameras />, { cameras: [], ...LOADING });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('No cameras added yet.')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  test('stale: the cameras stay with a labelled warning', () => {
    renderAsAdmin(<Cameras />, { cameras: [CAM], kids: [KID], ...STALE });
    expect(screen.getByText('Nursery')).toBeTruthy();
    expect(screen.getByText(/Couldn’t refresh cameras/)).toBeTruthy();
  });
});

describe('Live (LiveMonitor)', () => {
  const EMPTY = /No cameras yet/;
  test('★ failed: the error and Retry, NOT "No cameras yet. Add one…"', async () => {
    await forEachRole(async (_n, who) => {
      const { unmount } = renderAs(who, <LiveMonitor />, { cameras: [], ...FAILED });
      expect(screen.getByText(DOWN)).toBeTruthy();
      expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
      expect(screen.queryByText(EMPTY)).toBeNull();
      unmount();
    });
  });
  test('empty: the empty copy', () => {
    renderAsAdmin(<LiveMonitor />, { cameras: [] });
    expect(screen.getByText(EMPTY)).toBeTruthy();
  });
  test('loading: neither', () => {
    renderAsAdmin(<LiveMonitor />, { cameras: [], ...LOADING });
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
  test('stale: the grid stays (a baby monitor never blanks on a blip) and says it may be out of date', () => {
    renderAsAdmin(<LiveMonitor />, { cameras: [CAM], kids: [KID], ...STALE });
    expect(screen.getByText('Nursery')).toBeTruthy();
    expect(screen.getByText(/Couldn’t refresh cameras/)).toBeTruthy();
  });
});

describe('Child detail: alerts feed and unknown child', () => {
  const detail = <Routes><Route path="/children/:id" element={<ChildDetail />} /></Routes>;
  const opts = { route: '/children/kid-1', kids: [KID], cameras: [CAM] };
  const alertRow = { id: 'e1', camera_id: 'cam-1', camera_name: 'Nursery', type: 'motion', created_at: '2026-08-30 09:00:00' };
  const mockAlerts = (impl) => vi.spyOn(api, 'get').mockImplementation((p) =>
    (String(p).includes('/cameras/alerts') ? impl() : Promise.resolve(null)));

  test('★ failed: the error and Retry, NOT "No alerts for Child A yet"', async () => {
    mockAlerts(() => Promise.reject(new Error('alerts down')));
    renderAsAdmin(detail, opts);
    expect(await screen.findByText('alerts down')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(/No alerts for Child A yet/)).toBeNull();
  });

  test('Retry re-asks and a good answer replaces the error', async () => {
    let fail = true;
    mockAlerts(() => (fail ? Promise.reject(new Error('alerts down')) : Promise.resolve([])));
    const { user } = renderAsAdmin(detail, opts);
    await screen.findByText('alerts down');
    fail = false;
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/No alerts for Child A yet/)).toBeTruthy();
    expect(screen.queryByText('alerts down')).toBeNull();
  });

  test('empty: a SUCCESSFUL empty feed shows the empty copy', async () => {
    mockAlerts(() => Promise.resolve([]));
    renderAsAdmin(detail, opts);
    expect(await screen.findByText(/No alerts for Child A yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  test('loading: while the feed is unanswered it shows neither the empty copy nor an error', async () => {
    mockAlerts(() => new Promise(() => {}));
    renderAsAdmin(detail, opts);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cameras/alerts'));
    expect(screen.queryByText(/No alerts for Child A yet/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('★ the feed is not asked before the camera list has loaded (it would filter against none and report "no alerts")', async () => {
    mockAlerts(() => Promise.resolve([alertRow]));
    renderAsAdmin(detail, { ...opts, cameras: [], camerasLoaded: false });
    await new Promise((r) => setTimeout(r, 30));
    expect(api.get).not.toHaveBeenCalledWith('/cameras/alerts');
    expect(screen.queryByText(/No alerts for Child A yet/)).toBeNull();
  });

  test('an unknown child after a FAILED list load shows the error and Retry, not "Loading…" forever', async () => {
    renderAsAdmin(detail, { route: '/children/kid-1', kids: [], cameras: [], ...FAILED });
    expect(screen.getByText(DOWN)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

describe('Sleep detail', () => {
  const KID_ROUTE = { kids: [KID], route: '/children/kid-1/sleep' };
  const ui = <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>;
  const mock = (night) => vi.spyOn(api, 'get').mockImplementation((p) => {
    if (p.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
    if (p.includes('/sleep/insights')) return Promise.resolve(null);
    return night();
  });

  test('★ failed: "Couldn’t load this night" with Retry, NOT "No sleep data for this night"', async () => {
    mock(() => Promise.reject(new Error('sleep down')));
    renderAsAdmin(ui, KID_ROUTE);
    expect(await screen.findByText('sleep down')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(/No sleep data for this night/)).toBeNull();
  });

  test('Retry re-fetches and replaces the error with the night', async () => {
    let fail = true;
    mock(() => (fail ? Promise.reject(new Error('sleep down')) : Promise.resolve(null)));
    const { user } = renderAsAdmin(ui, KID_ROUTE);
    await screen.findByText('sleep down');
    fail = false;
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/No sleep data for this night/)).toBeTruthy();
    expect(screen.queryByText('sleep down')).toBeNull();
  });

  test('empty: the server saying "no data" shows the no-data copy and no error', async () => {
    mock(() => Promise.resolve({ status: 'no_data' }));
    renderAsAdmin(ui, KID_ROUTE);
    expect(await screen.findByText(/No sleep data for this night/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('loading: neither the no-data copy nor an error', async () => {
    mock(() => new Promise(() => {}));
    renderAsAdmin(ui, KID_ROUTE);
    expect(await screen.findByText('Loading night…')).toBeTruthy();
    expect(screen.queryByText(/No sleep data for this night/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Clip management', () => {
  const mountClips = () => renderAsAdmin(<ClipManagement />, { route: '/settings/clips' });
  const EMPTY = /No clips yet/;

  test('★ failed: the error and Retry, NOT "No clips yet" and NOT "0 clips"', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('clips down'));
    mountClips();
    expect(await screen.findByText('clips down')).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText(/^0 clips/)).toBeNull();
  });

  test('Retry re-fetches', async () => {
    const get = vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('clips down')).mockResolvedValue([]);
    const { user } = mountClips();
    await screen.findByText('clips down');
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('clips down')).toBeNull();
  });

  test('empty: a successful empty list shows the empty copy', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([]);
    mountClips();
    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('loading: neither', async () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    mountClips();
    expect(await screen.findByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('LoadFailed', () => {
  test('a blocking failure names what failed, the cause, and the next action; Retry is a real button', async () => {
    const onRetry = vi.fn();
    const { user } = renderAsCaregiver(<LoadFailed what="clips" error="boom" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load clips.');
    expect(screen.getByRole('alert')).toHaveTextContent('Check your connection, then try again.');
    expect(screen.getByText('boom')).toBeTruthy();
    const retry = screen.getByRole('button', { name: /retry/i });
    retry.focus();
    await user.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('a stale failure says the list is the last one we had and does not claim the page is empty or blocked', () => {
    renderAsAdmin(<LoadFailed what="clips" error="boom" onRetry={() => {}} stale />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t refresh clips. Showing what we had.');
    expect(screen.queryByText(/Check your connection/)).toBeNull();
  });

  test('without onRetry there is no button (nothing to call)', () => {
    renderAsAdmin(<LoadFailed what="x" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
