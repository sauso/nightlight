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
  // Kept in scope so the returned handles always refer to the CURRENT render, not the first one.
  let auth;
  let settingsValue;
  let camerasValue;
  const build = (opts) => {
    // ⚠️ `opts.user`, not the `user` argument, so `rerenderWith({ user })` can publish a user that
    // was not there at first paint. That transition is real — AuthContext resolves asynchronously, so
    // every screen renders once with `user: null` — and a form that fails to pick the user up when it
    // lands stays empty and then saves those blanks over the real values.
    // The spies are rebuilt each time, so grab handles from the returned `auth` AFTER a rerenderWith.
    auth = { user: opts.user, loading: opts.loading, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() };
    settingsValue = { settings: { ...DEFAULT_SETTINGS, ...opts.settings }, loading: opts.loading, refresh: vi.fn() };
    camerasValue = { kids: opts.kids, cameras: opts.cameras, error: opts.error, refresh: vi.fn() };
    return (
      <MemoryRouter initialEntries={[opts.route]}>
        <AuthContext.Provider value={auth}>
          <SettingsContext.Provider value={settingsValue}>
            <CamerasContext.Provider value={camerasValue}>{opts.ui}</CamerasContext.Provider>
          </SettingsContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>
    );
  };

  let opts = { settings, cameras, kids, error, loading, route, ui, user };
  const result = render(build(opts));

  // ⚠️ RTL's own `rerender` replaces the tree WITHOUT the providers, so anything using a context
  // explodes. `rerenderWith` re-renders the same screen inside the same providers with some values
  // changed — which is the only way to test what happens when a context value ARRIVES, as
  // SettingsContext's real timezone does a moment after boot. That transition silently destroyed a
  // user's typing once; a test for it needs to be able to reproduce it.
  const rerenderWith = (changes) => {
    opts = { ...opts, ...changes };
    result.rerender(build(opts));
  };

  return { ...result, rerenderWith, user: userEvent.setup(), auth, settingsValue, camerasValue };
}

export const renderAsAdmin = (ui, opts) => renderAs(ADMIN, ui, opts);
export const renderAsCaregiver = (ui, opts) => renderAs(CAREGIVER, ui, opts);

// Run the same assertions for both roles without duplicating the body.
//
// ⚠️ RETURNS A PROMISE — `await forEachRole(...)` whenever the body is async. It did not, once, and an
// async body's assertions then ran after the test had already resolved: the test passed against a
// component that rendered NOTHING AT ALL. A helper that silently discards a rejected promise turns
// every test written with it into a decoration, so it now collects them and the caller can await.
// Sequential, not Promise.all: each role renders into the SAME document, so running them concurrently
// puts two copies of the screen on the page and every query becomes ambiguous.
export async function forEachRole(fn) {
  for (const [name, who] of [['admin', ADMIN], ['caregiver', CAREGIVER]]) await fn(name, who);
}
