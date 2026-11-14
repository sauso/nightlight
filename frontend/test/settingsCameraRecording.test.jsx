import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsCameraRecording from '../src/pages/SettingsCameraRecording.jsx';
import SettingsCamera from '../src/pages/SettingsCamera.jsx';
import SettingsRecording from '../src/pages/SettingsRecording.jsx';
import ClipManagement from '../src/pages/ClipManagement.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

const ROWS = [
  ['Camera controls', '/settings/camera', 'PTZ step size and offline-camera alerts', SettingsCamera],
  ['Recording', '/settings/recording', 'Automatic clips, on-demand recording, retention and storage', SettingsRecording],
  ['Clip management', '/settings/clips', 'Browse recorded clips by date; bulk-delete', ClipManagement],
];

function Probe() {
  const location = useLocation();
  return (
    <>
      <div>at {location.pathname}</div>
      {location.state?.from && <div>from {location.state.from.to} ({location.state.from.label})</div>}
    </>
  );
}

function routes(realPage = false) {
  return (
    <Routes>
      <Route path="/settings" element={<Probe />} />
      <Route path="/settings/camera-recording" element={<SettingsCameraRecording />} />
      {ROWS.map(([, path, , Page]) =>
        <Route key={path} path={path} element={realPage ? <Page /> : <Probe />} />
      )}
    </Routes>
  );
}

describe('Camera and recording sub-menu', () => {
  test('shows the three existing destinations and returns to Settings', async () => {
    const { user } = renderAsAdmin(routes(), { route: '/settings/camera-recording' });
    for (const [label, , desc] of ROWS) {
      const row = screen.getByRole('button', { name: `${label} ${desc}` });
      expect(row).toHaveClass('nav-row');
      expect(within(row).getByText(desc)).toBeInTheDocument();
    }
    expect(screen.getAllByRole('button', { name: /^(Camera controls|Recording|Clip management) / })).toHaveLength(3);
    expect(screen.getByRole('button', { name: /^Recording / }).querySelector('.nav-row__chip svg').outerHTML)
      .not.toBe(screen.getByRole('button', { name: /^Clip management / }).querySelector('.nav-row__chip svg').outerHTML);
    await user.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(screen.getByText('at /settings')).toBeInTheDocument();
  });

  test.each(ROWS)('%s row opens its existing URL', async (label, path) => {
    const { user } = renderAsAdmin(routes(), { route: '/settings/camera-recording' });
    await user.click(screen.getByText(label));
    expect(screen.getByText(`at ${path}`)).toBeInTheDocument();
    expect(screen.getByText('from /settings/camera-recording (Camera settings)')).toBeInTheDocument();
  });

  test.each(ROWS)('%s Back returns to the sub-menu after a menu visit or direct link', async (label, path) => {
    vi.spyOn(api, 'get').mockResolvedValue([]);
    for (const start of ['/settings/camera-recording', path]) {
      const { user, unmount } = renderAsAdmin(routes(true), { route: start });
      if (start !== path) await user.click(screen.getByText(label));
      expect(await screen.findByRole('heading', { name: path === '/settings/clips' ? 'Clip management' : label })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back to Camera settings' }));
      expect(screen.getByRole('heading', { name: 'Camera and recording' })).toBeInTheDocument();
      unmount();
    }
  });
});

describe('Camera controls cards', () => {
  test('each setting is a visible card title tied to its control, and switches still toggle', async () => {
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: {
      ptz_step: 12, camera_offline_alert_enabled: true, camera_offline_alert_minutes: 5,
      snooze_alert_enabled: true, snooze_alert_minutes: 60,
    } });
    for (const name of ['PTZ step size', 'Notify when a camera goes offline',
      "Notify admins when a camera's alerts stay silenced for a long time"]) {
      const title = screen.getByRole('heading', { name });
      expect(title).toHaveClass('camera-controls__title');
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Offline for longer than (minutes)')).toBeInTheDocument();
    expect(screen.getByLabelText('Silenced for longer than (minutes)')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Notify when a camera goes offline'));
    expect(screen.getByLabelText('Notify when a camera goes offline')).not.toBeChecked();
    expect(screen.getByLabelText('Offline for longer than (minutes)')).toBeDisabled();
    await user.click(screen.getByLabelText("Notify admins when a camera's alerts stay silenced for a long time"));
    expect(screen.getByLabelText('Silenced for longer than (minutes)')).toBeDisabled();
  });

  test('Save changes stays one full-width primary action with the same request body', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({});
    const { user } = renderAsAdmin(<SettingsCamera />, { settings: {
      ptz_step: 12, camera_offline_alert_enabled: true, camera_offline_alert_minutes: 5,
      snooze_alert_enabled: true, snooze_alert_minutes: 60,
    } });
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toHaveClass('btn-primary');
    await user.clear(screen.getByLabelText('PTZ step size'));
    await user.type(screen.getByLabelText('PTZ step size'), '20');
    await user.click(save);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/settings', {
      ptz_step: '20', camera_offline_alert_enabled: true, camera_offline_alert_minutes: 5,
      snooze_alert_enabled: true, snooze_alert_minutes: 60,
    }));
  });
});
