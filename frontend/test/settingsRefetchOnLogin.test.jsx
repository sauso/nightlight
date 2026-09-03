// GET /settings answers an admin with more than it answers an anonymous visitor (the response is an
// allow-list keyed on role — see backend/src/routes/settings.js). Signing in happens IN-PAGE: Login
// calls navigate(), it does not reload. So a settings provider that fetched only at mount would hold
// the anonymous response for the entire session, and every admin settings form — which seeds its state
// straight from that response — would render fields that were never sent.
//
// The rest of the frontend suite injects SettingsContext directly, which makes it structurally blind
// to this: it never exercises the provider's own fetching. That is exactly why this file mounts the
// REAL SettingsProvider against a fake server.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SettingsProvider, useSettings } from '../src/lib/SettingsContext.jsx';
import { AuthContext } from '../src/lib/AuthContext.jsx';

const PUBLIC_FIELDS = ['app_name', 'accent_color', 'live_color', 'offline_color', 'font_choice', 'temp_unit', 'timezone'];
const ADMIN_ONLY = ['ptz_step', 'camera_offline_alert_enabled', 'camera_offline_alert_minutes', 'clip_pre_roll_s'];

// Deliberately stored AWAY from the UI's hardcoded defaults, so "the form fell back to a default" and
// "the form got the stored value" cannot be confused for one another.
const STORED = {
  app_name: 'Nightlight', accent_color: '#f4c56a', live_color: '#7FBFA3', offline_color: '#E08585',
  font_choice: 'warm-serif', temp_unit: 'C', timezone: 'Australia/Melbourne',
  ptz_step: 40, camera_offline_alert_enabled: 1, camera_offline_alert_minutes: 30, clip_pre_roll_s: 9,
};

const pick = (fields) => Object.fromEntries(fields.map((f) => [f, STORED[f]]));

let fetchCalls;

// Stands in for the real route: role decides the field list.
function fakeServer(isAdminNow) {
  return vi.fn(async (url) => {
    if (String(url).includes('/api/settings')) {
      fetchCalls.push(isAdminNow() ? 'admin' : 'anon');
      const body = pick(isAdminNow() ? [...PUBLIC_FIELDS, ...ADMIN_ONLY] : PUBLIC_FIELDS);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 200, text: async () => '{}' };
  });
}

// Reports what the provider is actually holding, which is what every settings form seeds from.
function Probe() {
  const { settings } = useSettings();
  return <div data-testid="ptz">{String(settings.ptz_step)}</div>;
}

beforeEach(() => { fetchCalls = []; });
afterEach(() => { vi.restoreAllMocks(); });

// The provider reads useAuth(); drive it directly so the test controls exactly when "login" happens.
function renderWithAuth(user) {
  const value = { user, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() };
  return render(
    <AuthContext.Provider value={value}>
      <SettingsProvider><Probe /></SettingsProvider>
    </AuthContext.Provider>
  );
}

describe('settings are re-fetched when the signed-in user changes', () => {
  test('a session that began at the login screen still gets the admin fields after signing in', async () => {
    let signedIn = false;
    global.fetch = fakeServer(() => signedIn);

    // 1. Anonymous, as on the login screen. The provider fetches and gets the public fields only.
    const { rerender } = renderWithAuth(null);
    await waitFor(() => expect(screen.getByTestId('ptz').textContent).toBe('undefined'));

    // 2. The user signs in. No reload — only the auth value changes, exactly as navigate() leaves it.
    signedIn = true;
    const value = {
      user: { id: 'u-a', username: 'admin', role: 'admin' },
      loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    };
    rerender(
      <AuthContext.Provider value={value}>
        <SettingsProvider><Probe /></SettingsProvider>
      </AuthContext.Provider>
    );

    // 3. The admin-only field must now be present. Without the re-fetch this stays 'undefined' and
    //    the Camera settings form renders a blank PTZ step over a stored value of 40.
    await waitFor(() => expect(screen.getByTestId('ptz').textContent).toBe('40'));
    expect(fetchCalls).toEqual(['anon', 'admin']);
  });

  test('signing out drops back to the anonymous response', async () => {
    let signedIn = true;
    global.fetch = fakeServer(() => signedIn);

    const { rerender } = renderWithAuth({ id: 'u-a', username: 'admin', role: 'admin' });
    await waitFor(() => expect(screen.getByTestId('ptz').textContent).toBe('40'));

    signedIn = false;
    const value = { user: null, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() };
    rerender(
      <AuthContext.Provider value={value}>
        <SettingsProvider><Probe /></SettingsProvider>
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByTestId('ptz').textContent).toBe('undefined'));
  });

  test('a role change re-fetches too — a demoted admin must not keep admin-only settings', async () => {
    let admin = true;
    global.fetch = fakeServer(() => admin);

    const { rerender } = renderWithAuth({ id: 'u-a', username: 'admin', role: 'admin' });
    await waitFor(() => expect(screen.getByTestId('ptz').textContent).toBe('40'));

    admin = false;
    const value = {
      user: { id: 'u-a', username: 'admin', role: 'caregiver' },
      loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    };
    rerender(
      <AuthContext.Provider value={value}>
        <SettingsProvider><Probe /></SettingsProvider>
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByTestId('ptz').textContent).toBe('undefined'));
  });

  test('a failed re-fetch does not reset a theme that already loaded', async () => {
    // The catch exists so a FIRST failure doesn't block the app from loading. Once real settings have
    // arrived it must leave them alone: re-applying DEFAULTS would reset the palette and tab title
    // while `settings` state kept the real values, leaving a branded install half-themed after one
    // transient blip — no error shown, no retry. Harmless while this only ran at mount; live now that
    // it re-runs on every sign-in.
    let fail = false;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/settings')) {
        if (fail) return { ok: false, status: 500, text: async () => 'boom' };
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ ...pick(PUBLIC_FIELDS), app_name: 'Casa', accent_color: '#123456' }),
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    });

    const { rerender } = renderWithAuth(null);
    await waitFor(() => expect(document.title).toBe('Casa'));
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456');

    fail = true; // the post-login fetch fails
    const value = {
      user: { id: 'u-a', username: 'admin', role: 'admin' },
      loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    };
    rerender(
      <AuthContext.Provider value={value}>
        <SettingsProvider><Probe /></SettingsProvider>
      </AuthContext.Provider>
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(document.title).toBe('Casa');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#123456');
  });

  test('a slow anonymous response cannot overwrite a newer admin one', async () => {
    // Signing in fires a second fetch while the first may still be in flight. If the anonymous reply
    // lands last it would replace the admin settings with the 7 public fields, and SettingsRecording
    // does setForm(settings) — a replace, not a merge — so its form would silently blank.
    let releaseAnon;
    const anonHeld = new Promise((r) => { releaseAnon = r; });
    let call = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/api/settings')) {
        call += 1;
        if (call === 1) {
          await anonHeld; // anonymous request stalls until we let it finish
          return { ok: true, status: 200, text: async () => JSON.stringify(pick(PUBLIC_FIELDS)) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify(pick([...PUBLIC_FIELDS, ...ADMIN_ONLY])) };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    });

    const { rerender } = renderWithAuth(null);
    const value = {
      user: { id: 'u-a', username: 'admin', role: 'admin' },
      loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn(),
    };
    rerender(
      <AuthContext.Provider value={value}>
        <SettingsProvider><Probe /></SettingsProvider>
      </AuthContext.Provider>
    );

    await waitFor(() => expect(screen.getByTestId('ptz').textContent).toBe('40'));
    releaseAnon(); // the stale anonymous response arrives AFTER the admin one
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('ptz').textContent).toBe('40');
  });

  test('the provider still works with no AuthProvider above it', async () => {
    global.fetch = fakeServer(() => false);
    // Several existing tests render SettingsProvider on its own; it must not throw there.
    render(<SettingsProvider><Probe /></SettingsProvider>);
    await waitFor(() => expect(fetchCalls).toEqual(['anon']));
  });
});
