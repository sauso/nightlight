// The app shell: `App.jsx` mounted for real, with the REAL providers, over a mocked API.
//
// Every other test in this suite injects the three contexts directly (that is what makes role gating
// cheap to check). This file deliberately does not: it is the only place that exercises what actually
// happens on boot — providers resolving, the signed-out redirect, the route table wiring each URL to
// the right screen, and the reload-after-background rule that exists because a phone's network stack
// comes back broken.
//
// ⚠️ Worth stating plainly: this renders LiveMonitor and its whole player stack under jsdom. That
// works — jsdom logs a "Not implemented: HTMLMediaElement.load()" notice and nothing throws — and the
// fact that it works is why LiveMonitor is no longer on the coverage exclude list. What it does NOT
// test is anything about video actually playing; that belongs to the Playwright suite in e2e/.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { HashRouter } from 'react-router-dom';
import App from '../src/App.jsx';

// ⚠️ The Router lives in main.jsx (the bootstrap, excluded from coverage), NOT in App.jsx — so a
// test that renders <App /> bare gets "useNavigate() may be used only in the context of a <Router>".
// HashRouter is what production mounts, and it reads window.location.hash, which is how `boot` below
// picks a starting route.
const app = () => <HashRouter><App /></HashRouter>;
import { api, setToken } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';
import * as push from '../src/lib/pushNotifications.js';

const ADMIN = { id: 'u1', username: 'nacho', role: 'admin', first_name: 'Nacho' };
const CAREGIVER = { id: 'u2', username: 'nanny', role: 'caregiver' };

const SETTINGS = { app_name: 'Nightlight', timezone: 'Australia/Melbourne', temp_unit: 'C' };

function mockApi(me, over = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    const p = String(path);
    if (p.startsWith('/auth/me')) return me ? Promise.resolve(me) : Promise.reject(new Error('401'));
    if (p.startsWith('/settings/mqtt/status')) return Promise.resolve({ enabled: false, connected: false });
    if (p.startsWith('/settings')) return Promise.resolve(SETTINGS);
    if (p.startsWith('/about')) return Promise.resolve({ version: '0.29.0' });
    if (p.startsWith('/children')) return Promise.resolve([]);
    if (p.startsWith('/cameras/alerts')) return Promise.resolve([]);
    if (p.startsWith('/cameras')) return Promise.resolve([]);
    if (p.startsWith('/events')) return Promise.resolve({ events: [] });
    if (p.startsWith('/logs')) return Promise.resolve({ lines: [] });
    return Promise.resolve(over[p] ?? null);
  });
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'post').mockResolvedValue({});
}

beforeEach(() => {
  // The shell calls into the native bridge on boot; in a browser these are no-ops, and here they must
  // not be real.
  vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
  vi.spyOn(nativeBridge, 'hasActiveBackgroundAudio').mockReturnValue(false);
  vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  setToken(null);
  window.location.hash = '';
});

/** Mount the app at `route` and wait for auth to settle. */
async function boot(route = '/') {
  window.location.hash = `#${route}`;
  const r = render(app());
  await waitFor(() => expect(document.querySelector('.app-shell, .login-page, form')).toBeTruthy());
  return r;
}

describe('booting the app', () => {
  test('renders NOTHING until auth resolves — it must not flash the login screen', async () => {
    let resolveMe;
    vi.spyOn(api, 'get').mockImplementation((p) =>
      String(p).startsWith('/auth/me') ? new Promise((r) => { resolveMe = r; }) : Promise.resolve(SETTINGS)
    );
    setToken('a-token');
    const { container } = render(app());
    // ⚠️ THE REASON THE GUARDS RETURN null RATHER THAN REDIRECTING. Every page refresh passes through
    // this state; redirecting here would bounce a signed-in user to login on every single reload.
    expect(container).toBeEmptyDOMElement();
    resolveMe(ADMIN);
    await waitFor(() => expect(container).not.toBeEmptyDOMElement());
  });

  test('a signed-out visitor lands on the login screen', async () => {
    mockApi(null);
    await boot('/');
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(document.querySelector('.app-shell')).toBeNull();
  });

  test('a signed-in admin gets the shell, the nav bar and the live monitor', async () => {
    setToken('a-token');
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(document.querySelector('.app-shell')).not.toBeNull());
    expect(screen.getByRole('link', { name: 'Live' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  test('the login route redirects to home when already signed in', async () => {
    setToken('a-token');
    mockApi(ADMIN);
    await boot('/login');
    // Otherwise a stale bookmark to #/login shows a sign-in form to someone already signed in.
    await waitFor(() => expect(document.querySelector('.app-shell')).not.toBeNull());
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
  });

  test('push registration is attempted once signed in, and not before', async () => {
    mockApi(null);
    await boot('/');
    expect(push.initPushNotifications).not.toHaveBeenCalled();

    setToken('a-token');
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(push.initPushNotifications).toHaveBeenCalled());
  });
});

describe('the route table', () => {
  const openAt = async (route) => {
    setToken('a-token');
    mockApi(ADMIN);
    return boot(route);
  };

  test('each settings sub-route lands on its own screen', async () => {
    for (const [route, heading] of [
      ['/settings', 'Settings'],
      ['/settings/camera', 'Camera controls'],
      ['/settings/mqtt', 'MQTT'],
      ['/settings/logs', 'Logs'],
      ['/about', 'About'],
      ['/cameras', 'Cameras'],
      ['/children', 'Children'],
    ]) {
      const { unmount } = await openAt(route);
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
      vi.spyOn(nativeBridge, 'hasActiveBackgroundAudio').mockReturnValue(false);
      vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
    }
  });

  test('the retired tabs still resolve, rather than 404ing an old bookmark or a push deep-link', async () => {
    for (const old of ['/family', '/alerts']) {
      const { unmount } = await openAt(old);
      // Both were real destinations once, and a notification tapped from an old build can still
      // point at them. They redirect to Children rather than showing an empty shell.
      expect(await screen.findByRole('heading', { name: 'Children' })).toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
      vi.spyOn(nativeBridge, 'hasActiveBackgroundAudio').mockReturnValue(false);
      vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
    }
  });

  test('an admin-only screen sends a CAREGIVER home, and shows nothing of it on the way', async () => {
    setToken('a-token');
    mockApi(CAREGIVER);
    await boot('/settings/mqtt');
    // ⚠️ The gate is in the route table, and it is the only whole-screen role check in the app. This
    // is where the "admin-only route that 403'd everyone" class of bug is visible.
    await waitFor(() => expect(document.querySelector('.app-shell')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: 'MQTT' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Live' })).toBeInTheDocument();
  });

  test('the Settings hub itself stays open to a caregiver', async () => {
    setToken('a-token');
    mockApi(CAREGIVER);
    await boot('/settings');
    // It is role-aware internally — a caregiver needs Account and About from here.
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('About')).toBeInTheDocument();
    expect(screen.queryByText('MQTT')).not.toBeInTheDocument();
  });
});

describe('reloading after a spell in the background', () => {
  const hide = () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };
  const showAgain = () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  // ⚠️ `window.location.reload` CANNOT be spied on in this jsdom — vi.spyOn throws "Cannot redefine
  // property: reload". The whole `location` object has to be swapped for a plain stub, which then has
  // to carry enough of the real shape for HashRouter to keep working (it reads `hash` and needs it to
  // be a writable data property). Probed before writing this rather than assumed.
  let reload;
  let realLocation;
  beforeEach(() => {
    reload = vi.fn();
    realLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        href: realLocation.href,
        origin: realLocation.origin,
        protocol: realLocation.protocol,
        host: realLocation.host,
        hostname: realLocation.hostname,
        port: realLocation.port,
        pathname: realLocation.pathname,
        search: realLocation.search,
        hash: '#/',
        reload,
        assign: vi.fn(),
        replace: vi.fn(),
        toString: () => realLocation.href,
      },
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'location', { configurable: true, writable: true, value: realLocation });
  });

  const bootShell = async () => {
    setToken('a-token');
    mockApi(ADMIN);
    render(app());
    await waitFor(() => expect(document.querySelector('.app-shell')).not.toBeNull());
  };

  test('a LONG spell backgrounded reloads on return', async () => {
    await bootShell();
    hide();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    showAgain();
    // Mobile browsers leave WebRTC/HLS half-broken after a long background; a reload is what reliably
    // fixes it, and doing it automatically is the point — this is meant to be glanced at half-asleep.
    expect(reload).toHaveBeenCalled();
  });

  test('a QUICK glance at a notification does not', async () => {
    await bootShell();
    hide();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    showAgain();
    expect(reload).not.toHaveBeenCalled();
  });

  test('becoming visible without having been hidden does nothing', async () => {
    await bootShell();
    showAgain();
    expect(reload).not.toHaveBeenCalled();
  });

  test('background audio holding the connections alive suppresses the reload', async () => {
    nativeBridge.isNativeApp.mockReturnValue(true);
    nativeBridge.hasActiveBackgroundAudio.mockReturnValue(true);
    await bootShell();
    hide();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    showAgain();
    // The Android foreground service holds a wake lock and a wifi lock precisely so the stream stays
    // up; reloading would interrupt audio someone deliberately left playing.
    expect(reload).not.toHaveBeenCalled();
  });

  test('the check happens on RETURN, so stopping the service mid-background still reloads', async () => {
    nativeBridge.isNativeApp.mockReturnValue(true);
    nativeBridge.hasActiveBackgroundAudio.mockReturnValue(true);
    await bootShell();
    hide();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    // ⚠️ Tapping "Stop" on the notification part-way through means the wake lock stopped covering the
    // rest of the period — so the state is read on return, not at hide-time. Reading it at hide-time
    // would leave exactly that case unreloaded and half-broken.
    nativeBridge.hasActiveBackgroundAudio.mockReturnValue(false);
    showAgain();
    expect(reload).toHaveBeenCalled();
  });
});
