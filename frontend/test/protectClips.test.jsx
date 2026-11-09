import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import { api } from '../src/lib/api.js';
import ClipPlayerModal from '../src/components/ClipPlayerModal.jsx';
import AlertList from '../src/components/AlertList.jsx';
import ClipManagement from '../src/pages/ClipManagement.jsx';
import SleepDetail from '../src/pages/SleepDetail.jsx';
import RecentAlerts from '../src/components/RecentAlerts.jsx';
import SettingsRecording from '../src/pages/SettingsRecording.jsx';
import WakeClipPlayerModal from '../src/components/WakeClipPlayerModal.jsx';
import { AdminProtected } from '../src/App.jsx';

const at = '2026-08-30 10:00:00';
const alert = { id: 'a1', camera_name: 'Camera A', type: 'motion', created_at: at,
  clip_status: 'ready', clip_bytes: 1024 * 1024, protected: 1, snapshot: 1 };
const wake = { id: 'w1', camera_name: 'Camera A', child_name: 'a child', started_at: at,
  created_at: '2026-08-31 10:00:00', duration_s: 30, bytes: 2 * 1024 * 1024, protected: 1 };

afterEach(() => vi.restoreAllMocks());

describe('alert clip player', () => {
  test('protected trash is disabled, and an admin can unprotect before deleting', async () => {
    vi.spyOn(api, 'put').mockResolvedValue({ protected: false });
    const changed = vi.fn();
    const { user } = renderAsAdmin(<ClipPlayerModal ev={alert} onDeleted={vi.fn()} onProtectedChange={changed} onClose={vi.fn()} />);
    const trash = screen.getByRole('button', { name: 'Delete clip' });
    expect(trash).toBeDisabled();
    expect(trash).toHaveAttribute('title', 'Unprotect to delete');
    expect(screen.getByText(/Protected: kept until you unprotect it/)).toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Unprotect this clip' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(toggle);
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/alerts/a1/protected', { protected: false }));
    expect(changed).toHaveBeenCalledWith('a1', false);
    expect(screen.getByRole('button', { name: 'Protect this clip' })).toHaveAttribute('aria-pressed', 'false');
    expect(trash).not.toBeDisabled();
    expect(screen.queryByText(/Protected: kept until you unprotect it/)).toBeNull();
  });

  test('a caregiver cannot change protection but a caller can offer delete', () => {
    renderAsCaregiver(<ClipPlayerModal ev={alert} onDeleted={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Protected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unprotect this clip' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete clip' })).toBeDisabled();
  });

  test('protection failure shows the server sentence and keeps the clip unprotected', async () => {
    vi.spyOn(api, 'put').mockRejectedValue(new Error('This clip file is gone.'));
    const { user } = renderAsAdmin(<ClipPlayerModal ev={{ ...alert, protected: 0 }} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Protect this clip' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This clip file is gone.');
    expect(screen.getByRole('button', { name: 'Protect this clip' })).toBeInTheDocument();
  });

  test('a delete racing with protection shows the 409 sentence', async () => {
    const refusal = Object.assign(new Error('This clip is protected. Unprotect it first.'), { status: 409 });
    vi.spyOn(api, 'del').mockRejectedValue(refusal);
    const { user } = renderAsAdmin(<ClipPlayerModal ev={{ ...alert, protected: 0 }} onDeleted={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Delete clip' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete', exact: true }));
    expect(await screen.findByText('This clip is protected. Unprotect it first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete clip' })).toBeDisabled();
  });
});

describe('clip management', () => {
  const other = { ...alert, id: 'a2', protected: 0, camera_name: 'Camera B' };
  function setup() {
    let protectedAlert = true;
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path === '/cameras/clips') return Promise.resolve([{ ...alert, protected: protectedAlert ? 1 : 0 }, other]);
      if (path === '/cameras/clips/protected') return Promise.resolve({ alerts: protectedAlert ? [alert] : [], wake: [wake] });
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'put').mockImplementation(() => { protectedAlert = false; return Promise.resolve({ protected: false }); });
    vi.spyOn(api, 'post').mockResolvedValue({ deleted: 1, skipped_protected: 1 });
    return renderAsAdmin(<ClipManagement />, { route: '/settings/clips' });
  }

  test('protected rows cannot be selected; Select all skips them and the header counts the day list once', async () => {
    const { user } = setup();
    expect(await screen.findByText(/2 clips · 2 MB/)).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox', { name: 'Select clip' });
    expect(boxes[0]).toBeDisabled();
    expect(boxes[0]).toHaveAttribute('title', 'Unprotect to select');
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeChecked();
  });

  test('Protected section shows alert and wake clips; unprotect removes the alert but leaves its day row', async () => {
    const { user } = setup();
    const heading = await screen.findByText('Protected', { selector: '.card-title' });
    const section = heading.closest('.card');
    expect(within(section).getByText('Wake-up clip · a child', { exact: false })).toBeInTheDocument();
    expect(within(section).getByText('Motion', { exact: false })).toBeInTheDocument();
    expect(within(section).getAllByRole('button', { name: /Play protected/ })).toHaveLength(2);
    await user.click(within(section).getByRole('button', { name: 'Play protected alert clip from Camera A' }));
    await user.click(screen.getByRole('button', { name: 'Unprotect this clip' }));
    await waitFor(() => expect(within(section).queryByRole('button', { name: 'Play protected alert clip from Camera A' })).toBeNull());
    expect(within(section).getByRole('button', { name: 'Play protected wake-up clip from Camera A' })).toBeInTheDocument();
    expect(await screen.findByText(/2 clips · 2 MB/)).toBeInTheDocument();
  });

  test('a skipped protected clip in the bulk response is reported without losing success', async () => {
    const { user } = setup();
    await screen.findByText(/2 clips · 2 MB/);
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete 1' }));
    expect(await screen.findByRole('status')).toHaveTextContent('1 protected clip was kept');
    expect(api.post).toHaveBeenCalledWith('/cameras/clips/delete', { ids: ['a2'] }, expect.any(Object));
  });

  test('a protected wake clip can be played and removed from the section by unprotecting', async () => {
    const { user } = setup();
    const section = (await screen.findByText('Protected', { selector: '.card-title' })).closest('.card');
    await user.click(within(section).getByRole('button', { name: 'Play protected wake-up clip from Camera A' }));
    expect(screen.queryByRole('button', { name: 'Delete clip' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Unprotect this clip' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/recordings/w1/protected', { protected: false }));
    expect(within(section).queryByRole('button', { name: 'Play protected wake-up clip from Camera A' })).toBeNull();
  });

  test('protecting from the day list adds the alert to the Protected section', async () => {
    let protectedNow = false;
    vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path === '/cameras/clips'
      ? [{ ...alert, protected: protectedNow ? 1 : 0 }]
      : { alerts: protectedNow ? [alert] : [], wake: [] }));
    vi.spyOn(api, 'put').mockImplementation(() => { protectedNow = true; return Promise.resolve({ protected: true }); });
    const { user } = renderAsAdmin(<ClipManagement />, { route: '/settings/clips' });
    await user.click(await screen.findByRole('button', { name: 'Play clip from Camera A' }));
    await user.click(screen.getByRole('button', { name: 'Protect this clip' }));
    expect(await screen.findByRole('button', { name: 'Play protected alert clip from Camera A' })).toBeInTheDocument();
  });

  test('a caregiver is redirected before Clip Management can load', () => {
    const get = vi.spyOn(api, 'get');
    renderAsCaregiver(<Routes>
      <Route path="/settings/clips" element={<AdminProtected><ClipManagement /></AdminProtected>} />
      <Route path="/" element={<div>Home</div>} />
    </Routes>, { route: '/settings/clips' });
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.queryByText('Clip Management')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  test('an old protected clip remains findable even when the day list is empty', async () => {
    vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path === '/cameras/clips'
      ? [] : { alerts: [alert], wake: [] }));
    renderAsAdmin(<ClipManagement />, { route: '/settings/clips' });
    expect(await screen.findByRole('button', { name: 'Play protected alert clip from Camera A' })).toBeInTheDocument();
    expect(screen.queryByText(/No clips yet/)).toBeNull();
  });
});

test('AlertList names a protected clip and updates its badge after a successful toggle', async () => {
  vi.spyOn(api, 'put').mockResolvedValue({ protected: false });
  const changed = vi.fn();
  const { user } = renderAsAdmin(<AlertList alerts={[alert]} onChanged={changed} />);
  expect(screen.getByLabelText('Protected')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Play clip from Camera A' }));
  await user.click(screen.getByRole('button', { name: 'Unprotect this clip' }));
  await waitFor(() => expect(screen.queryByLabelText('Protected')).toBeNull());
  expect(changed).toHaveBeenCalledWith('a1', false);
});

test('Sleep Detail shows the wake lock and lets an admin unprotect it without a delete control', async () => {
  const night = { status: 'ok', night_date: '2026-08-30', onset_at: '2026-08-30 09:00:00', wake_at: '2026-08-30 20:00:00',
    window_start: '2026-08-30 08:00:00', window_end: '2026-08-30 21:00:00', coverage_minutes: 780,
    asleep_minutes: 600, wakes: [{ start_at: at, end_at: '2026-08-30 10:10:00', minutes: 10 }],
    visits: [], alerts: [], wakeClips: [wake] };
  vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path.includes('/sleep/live')
    ? { night: { night_date: '2026-08-30' } } : path.includes('/sleep/insights') ? null : night));
  vi.spyOn(api, 'put').mockResolvedValue({ protected: false });
  const { user } = renderAsAdmin(<Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
    { kids: [{ id: 'child-1', name: 'a child' }], route: '/children/child-1/sleep' });
  await user.click(await screen.findByRole('button', { name: /10m awake/ }));
  expect(screen.getAllByLabelText('Protected').length).toBeGreaterThan(0);
  await user.click(screen.getByRole('button', { name: 'Play the clip recorded at the start of this wake' }));
  expect(screen.queryByRole('button', { name: 'Delete clip' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Unprotect this clip' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/recordings/w1/protected', { protected: false }));
  expect(screen.queryByLabelText('Protected')).toBeNull();
});

test('Sleep Detail does not print zero after an unprotected wake clip', async () => {
  const night = { status: 'ok', night_date: '2026-08-30', onset_at: '2026-08-30 09:00:00', wake_at: '2026-08-30 20:00:00',
    window_start: '2026-08-30 08:00:00', window_end: '2026-08-30 21:00:00', coverage_minutes: 780,
    asleep_minutes: 600, wakes: [{ start_at: at, end_at: '2026-08-30 10:20:00', minutes: 20 }],
    visits: [], alerts: [], wakeClips: [{ ...wake, protected: 0 }] };
  vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path.includes('/sleep/live')
    ? { night: { night_date: '2026-08-30' } } : path.includes('/sleep/insights') ? null : night));
  renderAsAdmin(<Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
    { kids: [{ id: 'child-1', name: 'a child' }], route: '/children/child-1/sleep' });
  const head = await screen.findByRole('button', { name: /20m awake/ });
  expect(head).toHaveTextContent(/20m awakeclip$/);
  expect(head).not.toHaveTextContent(/clip0/);
});

test('Sleep Detail updates a correlated alert badge after protection changes', async () => {
  const night = { status: 'ok', night_date: '2026-08-30', onset_at: '2026-08-30 09:00:00', wake_at: '2026-08-30 20:00:00',
    window_start: '2026-08-30 08:00:00', window_end: '2026-08-30 21:00:00', coverage_minutes: 780,
    asleep_minutes: 600, wakes: [{ start_at: at, end_at: '2026-08-30 10:20:00', minutes: 20 }],
    visits: [], alerts: [{ ...alert, protected: 0 }], wakeClips: [] };
  vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path.includes('/sleep/live')
    ? { night: { night_date: '2026-08-30' } } : path.includes('/sleep/insights') ? null : night));
  vi.spyOn(api, 'put').mockResolvedValue({ protected: true });
  const { user } = renderAsAdmin(<Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
    { kids: [{ id: 'child-1', name: 'a child' }], route: '/children/child-1/sleep' });
  await user.click(await screen.findByRole('button', { name: /20m awake/ }));
  await user.click(screen.getByRole('button', { name: 'Play clip from Camera A' }));
  await user.click(screen.getByRole('button', { name: 'Protect this clip' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/cameras/alerts/a1/protected', { protected: true }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.getByLabelText('Protected')).toBeInTheDocument();
});

test('a caregiver sees a wake clip is protected but has no toggle', () => {
  renderAsCaregiver(<WakeClipPlayerModal clip={wake} onClose={vi.fn()} />);
  expect(screen.getByLabelText('Protected')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Unprotect this clip' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Delete clip' })).toBeNull();
});

test('clearing recent alerts tells people protected alerts remain, then shows the kept row', async () => {
  vi.spyOn(api, 'get').mockResolvedValue([alert]);
  vi.spyOn(api, 'del').mockResolvedValue({});
  const { user } = renderAsAdmin(<RecentAlerts />);
  await user.click(screen.getByRole('button', { name: 'Clear log' }));
  expect(within(screen.getByRole('dialog')).getByText(/Protected alerts are kept/)).toBeInTheDocument();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear log' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Protected alerts are kept');
  expect(screen.getByText('Camera A')).toBeInTheDocument();
  expect(screen.queryByText(/No alerts yet/)).toBeNull();
});

test('Storage card combines protected totals and names the protected wake subtotal', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ path: '/clips', ok: true, usedBytes: 1024 ** 2, clipCount: 1,
    wakeClips: { count: 3, bytes: 3 * 1024 ** 2 }, manualRecordings: { count: 0, bytes: 0 },
    protectedAlertClips: 2, protectedAlertBytes: 2 * 1024 ** 2,
    protectedWakeClips: 1, protectedWakeBytes: 1024 ** 2 });
  renderAsAdmin(<SettingsRecording />);
  expect(await screen.findByText(/Protected: 3 clips/)).toHaveTextContent('not counted toward the cap');
  expect(screen.getByText(/of which 1 protected/)).toBeInTheDocument();
});

test('Storage card hides protected totals when there are none', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ path: '/clips', ok: true, usedBytes: 1024 ** 2, clipCount: 1,
    wakeClips: { count: 0, bytes: 0 }, manualRecordings: { count: 0, bytes: 0 } });
  renderAsAdmin(<SettingsRecording />);
  await screen.findByText(/Alert clips:/);
  expect(screen.queryByText(/Protected:/)).toBeNull();
  expect(screen.queryByText(/of which/)).toBeNull();
});
