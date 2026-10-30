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

describe('Integrations hub: the ESPHome row (#506)', () => {
  const espRow = () => within(screen.getByText('ESPHome').closest('.list-row'));
  const dev = (state, enabled = true) => ({ id: 1, enabled, status: { state } });
  // Answers by address: the MQTT status and the ESPHome list are two different requests.
  const mockApis = (esphome) => vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/esphome/devices') return typeof esphome === 'function' ? esphome() : esphome;
    return { enabled: false, connected: false };
  });

  test('the row carries the ESPHome icon and opens the ESPHome page', async () => {
    mockApis([]);
    const Probe = () => <div>at {useLocation().pathname}</div>;
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/settings/integrations" element={<SettingsIntegrations />} />
        <Route path="*" element={<Probe />} />
      </Routes>,
      { route: '/settings/integrations' }
    );
    expect(espRow().getByText('Collect readings from ESPHome sensors')).toBeInTheDocument();
    // The house icon (a mask, so the "E" is cut out), in the same colour as the other rows' icons.
    const icon = screen.getByText('ESPHome').closest('.list-row').querySelector('svg mask');
    expect(icon).not.toBeNull();
    expect(screen.getByText('ESPHome').closest('.list-row').querySelector('svg path[fill="var(--peri)"]')).not.toBeNull();
    await user.click(screen.getByText('ESPHome'));
    expect(await screen.findByText('at /settings/integrations/esphome')).toBeInTheDocument();
  });

  test.each([
    [[dev('connected')], 'Connected', 'status-badge--ok'],
    [[dev('connected'), dev('failed')], 'Disconnected', 'status-badge--bad'],
    [[dev('connecting')], 'Disconnected', 'status-badge--bad'],
    [[], 'Off', 'status-badge--off'],
    [[dev('disabled', false)], 'Off', 'status-badge--off'],
  ])('devices %j show %s on the row', async (devices, label, cls) => {
    mockApis(devices);
    renderAsAdmin(<SettingsIntegrations />);
    await waitFor(() => expect(espRow().getByText(label)).toHaveClass(cls));
    expect(api.get).toHaveBeenCalledWith('/esphome/devices');
  });

  test('★ the MQTT badge is still its own: an ESPHome answer never leaks onto it, and the reverse', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path) => (path === '/esphome/devices'
      ? [dev('failed')]
      : { enabled: true, connected: true }));
    renderAsAdmin(<SettingsIntegrations />);
    await waitFor(() => expect(espRow().getByText('Disconnected')).toBeInTheDocument());
    expect(mqttRow().getByText('Connected')).toBeInTheDocument();
  });

  test('★ a failed or non-list answer leaves the row usable with no badge', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path) => {
      if (path === '/esphome/devices') throw new Error('offline');
      return { enabled: false, connected: false };
    });
    renderAsAdmin(<SettingsIntegrations />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/esphome/devices'));
    expect(screen.getByText('ESPHome')).toBeInTheDocument();
    expect(espRow().queryByText(/Connected|Disconnected|Off/)).toBeNull();

    vi.restoreAllMocks();
    mockApis({ unexpected: 'object' });
    renderAsAdmin(<SettingsIntegrations />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/esphome/devices'));
    expect(within(screen.getAllByText('ESPHome').at(-1).closest('.list-row')).queryByText(/Connected|Disconnected|Off/)).toBeNull();
  });
});
