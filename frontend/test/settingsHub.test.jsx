// The Settings hub — the one settings screen a caregiver can actually reach.
//
// Every screen BEHIND this menu sits under <AdminProtected> (covered in routeGuards.test.jsx), so the
// interesting question here is different: what does the menu OFFER? A caregiver shown an admin link
// would tap it and be bounced straight back, which reads as a broken app rather than a permission
// boundary; an admin missing a link loses a feature with no error anywhere.
//
// The MQTT status is requested on Integrations, not on this menu. A caregiver must never request it.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import Settings from '../src/pages/Settings.jsx';
import { api } from '../src/lib/api.js';

// Every label on the admin card. Listed in full deliberately: a menu that silently loses an entry is
// exactly the kind of regression nothing else would catch.
const ADMIN_LABELS = [
  'General', 'Camera and Recording', 'Caregivers', 'Integrations', 'Logs',
];

function mockApi({ version = '0.29.0' } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (String(path).includes('/about')) return Promise.resolve({ version });
    return Promise.resolve(null);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('what the menu offers each role', () => {
  beforeEach(() => mockApi());

  test('an admin is offered every admin screen', async () => {
    renderAsAdmin(<Settings />);
    for (const label of ADMIN_LABELS) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('Camera Controls, Recording Settings and Clip Management')).toBeInTheDocument();
    for (const oldLabel of ['Camera controls', 'Recording', 'Clip management']) {
      expect(screen.queryByText(oldLabel)).toBeNull();
    }
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

describe('MQTT status belongs on Integrations', () => {
  test.each([['admin', renderAsAdmin], ['caregiver', renderAsCaregiver]])('Settings never asks for the status as %s', async (_, renderAs) => {
    mockApi();
    renderAs(<Settings />);
    // Wait for the version request so the effect has definitely run before asserting an absence.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/about'));
    expect(api.get).not.toHaveBeenCalledWith('/settings/mqtt/status');
  });
});

describe('the version', () => {
  test('is shown beside About once it arrives', async () => {
    mockApi({ version: '0.29.0' });
    renderAsAdmin(<Settings />);
    expect(await screen.findByText('0.29.0')).toBeTruthy();
  });

  test('a failed version lookup leaves the menu usable', async () => {
    // ⚠️ 'About' and 'General' are on screen at first paint, so asserting only those would pass
    // whether or not the rejection was handled. Wait for the request to have gone out and settle
    // first, then assert the menu survived AND no version was rendered.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    renderAsAdmin(<Settings />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/about'));
    await waitFor(() => expect(screen.getByText('About')).toBeTruthy());
    expect(screen.getByText('General')).toBeTruthy();
    expect(screen.queryByText('0.29.0')).toBeNull();
  });
});
