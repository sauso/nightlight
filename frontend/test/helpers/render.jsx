import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { AuthContext } from '../../src/lib/AuthContext.jsx';
import { SettingsContext } from '../../src/lib/SettingsContext.jsx';
import { CamerasContext } from '../../src/lib/CamerasContext.jsx';

// Render helpers for component tests.
//
// The point of `renderAs` is that every screen can be exercised in BOTH roles from one call. Role
// gating is real in this UI and it is where bugs hide: an admin-only affordance that never renders, or
// worse, a destructive one that renders for a caregiver. `renderAsAdmin` / `renderAsCaregiver` make
// checking the pair cheap enough that there's no excuse for testing only one.

export const ADMIN = { id: 'u-admin', username: 'nacho', role: 'admin', first_name: 'Nacho' };
export const CAREGIVER = { id: 'u-care', username: 'nanny', role: 'caregiver', first_name: 'Nanny' };

const DEFAULT_SETTINGS = {
  app_name: 'Nightlight',
  accent_color: '#f4c56a',
  live_color: '#7FBFA3',
  offline_color: '#E08585',
  timezone: 'Australia/Melbourne',
  font_choice: 'warm-serif',
  temp_unit: 'C',
};

// The injected values MUST match the shape the real providers publish, or a screen can pass its test
// while breaking in the app. These are taken from the providers themselves:
//   AuthContext     -> { user, loading, login, logout, refresh }
//   SettingsContext -> { settings, loading, refresh }
//   CamerasContext  -> { kids, cameras, error, refresh }
// (An earlier version of this helper published `setSettings`/`reload` and omitted `error`, none of
// which the app ever produces — Cameras.jsx and CameraSettings.jsx both destructure `error`.)
export function renderAs(
  user,
  ui,
  { settings = {}, cameras = [], kids = [], error = '', loading = false, route = '/' } = {}
) {
  const auth = { user, loading, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() };
  const settingsValue = { settings: { ...DEFAULT_SETTINGS, ...settings }, loading, refresh: vi.fn() };
  const camerasValue = { kids, cameras, error, refresh: vi.fn() };

  const result = render(
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={auth}>
        <SettingsContext.Provider value={settingsValue}>
          <CamerasContext.Provider value={camerasValue}>{ui}</CamerasContext.Provider>
        </SettingsContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { ...result, user: userEvent.setup(), auth, settingsValue, camerasValue };
}

export const renderAsAdmin = (ui, opts) => renderAs(ADMIN, ui, opts);
export const renderAsCaregiver = (ui, opts) => renderAs(CAREGIVER, ui, opts);

// Run the same assertions for both roles without duplicating the body.
export function forEachRole(fn) {
  for (const [name, who] of [['admin', ADMIN], ['caregiver', CAREGIVER]]) fn(name, who);
}
