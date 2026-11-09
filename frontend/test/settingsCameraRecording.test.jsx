import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen } from '@testing-library/react';
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

describe('Camera and Recording sub-menu', () => {
  test('shows the three existing destinations and returns to Settings', async () => {
    const { user } = renderAsAdmin(routes(), { route: '/settings/camera-recording' });
    for (const [label, , desc] of ROWS) {
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.getByText(desc)).toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Back to Settings' }));
    expect(screen.getByText('at /settings')).toBeInTheDocument();
  });

  test.each(ROWS)('%s row opens its existing URL', async (label, path) => {
    const { user } = renderAsAdmin(routes(), { route: '/settings/camera-recording' });
    await user.click(screen.getByText(label));
    expect(screen.getByText(`at ${path}`)).toBeInTheDocument();
    expect(screen.getByText('from /settings/camera-recording (Camera and Recording)')).toBeInTheDocument();
  });

  test.each(ROWS)('%s Back returns to the sub-menu after a menu visit or direct link', async (label, path) => {
    vi.spyOn(api, 'get').mockResolvedValue([]);
    for (const start of ['/settings/camera-recording', path]) {
      const { user, unmount } = renderAsAdmin(routes(true), { route: start });
      if (start !== path) await user.click(screen.getByText(label));
      expect(await screen.findByRole('heading', { name: path === '/settings/clips' ? 'Clip Management' : label })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Back to Camera and Recording' }));
      expect(screen.getByRole('heading', { name: 'Camera and Recording' })).toBeInTheDocument();
      unmount();
    }
  });
});
