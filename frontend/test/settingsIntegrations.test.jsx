import { afterEach, describe, expect, test, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsIntegrations from '../src/pages/SettingsIntegrations.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

function mqttRow() {
  return within(screen.getByText('MQTT').closest('.list-row'));
}

describe('Integrations hub', () => {
  test('shows both links, with no badge on Push notifications', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: true, connected: true });
    const Probe = () => <div>at {useLocation().pathname}</div>;
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/settings/integrations" element={<SettingsIntegrations />} />
        <Route path="*" element={<Probe />} />
      </Routes>,
      { route: '/settings/integrations' }
    );
    expect(screen.getByText('Push notifications')).toBeInTheDocument();
    expect(screen.getByText('MQTT')).toBeInTheDocument();
    expect(within(screen.getByText('Push notifications').closest('.list-row')).queryByText(/Connected|Disconnected|Off/)).toBeNull();
    await user.click(screen.getByText('Push notifications'));
    expect(await screen.findByText('at /settings/integrations/notifications')).toBeInTheDocument();
  });

  test('MQTT row opens the MQTT page', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ enabled: false, connected: false });
    const Probe = () => <div>at {useLocation().pathname}</div>;
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/settings/integrations" element={<SettingsIntegrations />} />
        <Route path="*" element={<Probe />} />
      </Routes>,
      { route: '/settings/integrations' }
    );
    await user.click(screen.getByText('MQTT'));
    expect(await screen.findByText('at /settings/integrations/mqtt')).toBeInTheDocument();
  });

  test.each([
    [{ enabled: true, connected: true }, 'Connected', 'status-badge--ok'],
    [{ enabled: true, connected: false }, 'Disconnected', 'status-badge--bad'],
    [{ enabled: false, connected: false }, 'Off', 'status-badge--off'],
  ])('MQTT status %j shows %s on its row', async (status, label, cls) => {
    vi.spyOn(api, 'get').mockResolvedValue(status);
    renderAsAdmin(<SettingsIntegrations />);
    await waitFor(() => expect(mqttRow().getByText(label)).toHaveClass(cls));
    expect(api.get).toHaveBeenCalledWith('/settings/mqtt/status');
  });

  test('no badge appears while the status is pending', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    renderAsAdmin(<SettingsIntegrations />);
    expect(mqttRow().queryByText(/Connected|Disconnected|Off/)).toBeNull();
  });

  test('a failed status request leaves both rows usable', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    renderAsAdmin(<SettingsIntegrations />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/settings/mqtt/status'));
    expect(screen.getByText('Push notifications')).toBeInTheDocument();
    expect(mqttRow().queryByText(/Connected|Disconnected|Off/)).toBeNull();
  });
});
