// The Settings hub — the one settings screen a caregiver can actually reach.
//
// Every screen BEHIND this menu sits under <AdminProtected> (covered in routeGuards.test.jsx), so the
// interesting question here is different: what does the menu OFFER? A caregiver shown an admin link
// would tap it and be bounced straight back, which reads as a broken app rather than a permission
// boundary; an admin missing a link loses a feature with no error anywhere.
//
// The other thing worth pinning is that a caregiver never even REQUESTS the MQTT status. It is an
// admin-only endpoint, so asking would produce a pointless 403 on every visit to Settings.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import Settings from '../src/pages/Settings.jsx';
import { api } from '../src/lib/api.js';

// Every label on the admin card. Listed in full deliberately: a menu that silently loses an entry is
// exactly the kind of regression nothing else would catch.
const ADMIN_LABELS = [
  'General', 'Camera controls', 'Recording', 'Caregivers',
  'MQTT', 'Push notifications', 'Clip management', 'Logs',
];

function mockApi({ version = '0.29.0', mqtt = null } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (String(path).includes('/about')) return Promise.resolve({ version });
    if (String(path).includes('/settings/mqtt/status')) return Promise.resolve(mqtt);
    return Promise.resolve(null);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('what the menu offers each role', () => {
  beforeEach(() => mockApi());

  test('an admin is offered every admin screen', async () => {
    renderAsAdmin(<Settings />);
    for (const label of ADMIN_LABELS) expect(screen.getByText(label)).toBeTruthy();
  });

  test('a caregiver is offered none of them', async () => {
    renderAsCaregiver(<Settings />);
    for (const label of ADMIN_LABELS) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  test('both roles still get their account and the About page', async () => {
    for (const renderAs of [renderAsAdmin, renderAsCaregiver]) {
      const { unmount } = renderAs(<Settings />);
      expect(screen.getByText('About')).toBeTruthy();
      expect(await screen.findByText(/Account/)).toBeTruthy();
      unmount();
    }
  });

  test('the signed-in role is shown on the account row', async () => {
    renderAsCaregiver(<Settings />);
    expect(await screen.findByText(/caregiver · Account/i)).toBeTruthy();
  });
});

describe('the MQTT status badge', () => {
  test('a caregiver never even asks for the admin-only status', async () => {
    mockApi();
    renderAsCaregiver(<Settings />);
    // Wait for the version request so the effect has definitely run before asserting an absence.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/about'));
    expect(api.get).not.toHaveBeenCalledWith('/settings/mqtt/status');
  });

  test('an admin does ask for it', async () => {
    mockApi();
    renderAsAdmin(<Settings />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/settings/mqtt/status'));
  });

  // Three states, and the middle one is the one that matters: "enabled but not connected" is the
  // broken case a person needs to see, and it must not read the same as "deliberately switched off".
  test('connected reads as Connected', async () => {
    mockApi({ mqtt: { enabled: true, connected: true } });
    renderAsAdmin(<Settings />);
    expect(await screen.findByText('Connected')).toBeTruthy();
  });

  test('enabled but not connected reads as Disconnected, not Off', async () => {
    mockApi({ mqtt: { enabled: true, connected: false } });
    renderAsAdmin(<Settings />);
    expect(await screen.findByText('Disconnected')).toBeTruthy();
    expect(screen.queryByText('Off')).toBeNull();
  });

  test('switched off reads as Off, not Disconnected', async () => {
    mockApi({ mqtt: { enabled: false, connected: false } });
    renderAsAdmin(<Settings />);
    expect(await screen.findByText('Off')).toBeTruthy();
    expect(screen.queryByText('Disconnected')).toBeNull();
  });

  test('no status yet means no badge at all, rather than a misleading one', async () => {
    mockApi({ mqtt: null });
    renderAsAdmin(<Settings />);
    expect(await screen.findByText('MQTT')).toBeTruthy();
    for (const t of ['Connected', 'Disconnected', 'Off']) expect(screen.queryByText(t)).toBeNull();
  });
});

describe('the version', () => {
  test('is shown beside About once it arrives', async () => {
    mockApi({ version: '0.29.0' });
    renderAsAdmin(<Settings />);
    expect(await screen.findByText('0.29.0')).toBeTruthy();
  });

  test('a failed version lookup leaves the menu usable', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    renderAsAdmin(<Settings />);
    expect(screen.getByText('About')).toBeTruthy();
    expect(screen.getByText('General')).toBeTruthy();
  });
});
