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
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';

// ⚠️ The Router lives in main.jsx (the bootstrap, excluded from coverage), NOT in App.jsx — so a
// test that renders <App /> bare gets "useNavigate() may be used only in the context of a <Router>".
// HashRouter is what production mounts, and it reads window.location.hash, which is how `boot` below
// picks a starting route.
const app = () => <HashRouter><App /></HashRouter>;
import { api, setToken, getToken, getMediaToken, clearMediaToken } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';
import * as push from '../src/lib/pushNotifications.js';

const ADMIN = { id: 'u1', username: 'nacho', role: 'admin', first_name: 'Nacho' };
const CAREGIVER = { id: 'u2', username: 'nanny', role: 'caregiver' };

const SETTINGS = { app_name: 'Nightlight', timezone: 'Australia/Melbourne', temp_unit: 'C' };

function mockApi(me, over = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    const p = String(path);
    if (p.startsWith('/auth/me')) return me ? Promise.resolve(me) : Promise.reject(new Error('401'));
    if (p === '/auth/status') return Promise.resolve({ needsSetup: false, demo: false });
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

  // ★ #379. The inner <Routes> had no catch-all, so an address that matched nothing rendered the app chrome
  // around a blank page. These pin the catch-all AND that it does not swallow a real route (react-router
  // ranks by specificity, not order, so a `*` placed last cannot win; a mutant moving it or widening it
  // is what the second test is for).
  test('★ #379 an address that matches no screen says so, and Go to Live leads home', async () => {
    const { unmount } = await openAt('/children/kid-1/no-such-screen/at-all');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText(/nothing at this address/i)).toBeInTheDocument();
    // The nav is still there: the person is not stranded outside the app.
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByText('Go to Live'));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument());
    expect(window.location.hash).toBe('#/');
    unmount();
  });

  test('★ #379 unknown addresses at other depths are not-found too, not just one prefix', async () => {
    // A catch-all narrowed to one prefix (`/children/*`) passes the deep address above and fails these:
    // a top-level unknown and one under a section that has real routes of its own.
    for (const route of ['/nonsense', '/settings/nonsense']) {
      const { unmount } = await openAt(route);
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
      vi.spyOn(nativeBridge, 'hasActiveBackgroundAudio').mockReturnValue(false);
      vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
    }
  });

  test('★ #379 the real routes, and the retired /family, are NOT the not-found page', async () => {
    for (const [route, heading] of [
      ['/children', 'Children'],
      ['/cameras', 'Cameras'],
      ['/settings/mqtt', 'MQTT'],
      ['/family', 'Children'], // retired, redirects: must still redirect, not fall through to `*`
    ]) {
      const { unmount } = await openAt(route);
      expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
      vi.spyOn(nativeBridge, 'hasActiveBackgroundAudio').mockReturnValue(false);
      vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
    }
  });

  test('#379 the Live route itself (/) is not the not-found page either', async () => {
    await openAt('/');
    await waitFor(() => expect(document.querySelector('.live-monitor--active')).not.toBeNull());
    expect(screen.queryByRole('heading', { name: 'Page not found' })).not.toBeInTheDocument();
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

// ★ #562 bullet 7. A session can now end while a tab is open (a lowered SESSION_TTL_DAYS signs older sessions
// out at their next request; so do signing out from another device and removing the account). The server
// answers 401, and api.js cleared the token and set #/login, but AuthProvider kept its user, so the router
// sent #/login straight back to `/`: a dead live screen, no sign-in form, until a reload. A tablet left on the
// live view is never backgrounded, so the reload-after-background rule never rescued it.
//
// These go through the REAL api.js and the REAL AuthProvider: only `fetch` is faked. The request is made by
// the test through the same api module the app uses (the app's own polls would do it after 15 s; waiting for
// one adds time, not coverage).
describe('★ #562 a request answered 401 while the app is open', () => {
  const realFetch = globalThis.fetch;
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  // Answers the media-token request with a real-looking token, so the test can see it being dropped.
  const healthy = (url) => (String(url).endsWith('/auth/media-token')
    ? reply(200, { token: 'media-abc', expires_in: 43200 })
    : reply(200, null));

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearMediaToken();
  });

  const signedInShell = async () => {
    globalThis.fetch = vi.fn(async (url) => healthy(url));
    setToken('a-token');
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(document.querySelector('.app-shell')).not.toBeNull());
    expect(getMediaToken()).toBe('media-abc'); // precondition: there is a media token to drop
    api.get.mockRestore(); // from here on, requests go through the real client
  };

  test('★ shows the sign-in form at once, without a reload, and drops the token and the media token', async () => {
    await signedInShell();
    const reset = vi.spyOn(push, 'resetPushRegistration');
    globalThis.fetch = vi.fn(async () => reply(401, { error: 'Invalid or expired session' }));

    await act(async () => { await api.get('/cameras').catch(() => {}); });

    // The same render, no reload: jsdom cannot reload, so the form appearing in this document is the proof.
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();
    expect(document.querySelector('.app-shell')).toBeNull();
    expect(getToken()).toBeNull();
    expect(getMediaToken()).toBeNull();
    // Review of #696: push registration is forgotten too, so signing in again in this page registers push
    // under the new session (pushNotifications.test.js proves what the reset does to the flag). At least once,
    // not exactly once: every request the app still makes here answers 401 too, and each one resets again.
    expect(reset).toHaveBeenCalled();
  });

  test('★ a request that TIMED OUT cannot sign anyone out when its 401 arrives late', async () => {
    // The existing `signal.aborted` guard in api.js (review of 0.36.0) must keep covering the new listener:
    // the person may have signed in again since, and a stale answer must not end that.
    await signedInShell();
    let answerLate;
    globalThis.fetch = vi.fn((url) => (String(url).includes('/late-401-probe')
      ? new Promise((resolve) => { answerLate = resolve; }) // ignores the abort signal, like a slow proxy
      : Promise.resolve(healthy(url))));

    const err = await api.get('/late-401-probe', { timeoutMs: 20 }).catch((e) => e);
    expect(err.timedOut).toBe(true);
    await act(async () => {
      answerLate(reply(401, { error: 'Invalid or expired session' }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(document.querySelector('.app-shell')).not.toBeNull();
    expect(screen.queryByLabelText(/username/i)).not.toBeInTheDocument();
    expect(getToken()).toBe('a-token');
    expect(getMediaToken()).toBe('media-abc');
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

  test('the hidden timestamp is CLEARED on return, so a second visible event does not re-reload', async () => {
    // ⚠️ `hiddenAt = null` inside the visible branch. Without it a duplicate visibilitychange —
    // which mobile Safari and the Android app-switcher do emit — sees the stale timestamp, computes
    // the same long absence again, and reloads a page the user is already looking at. Deleting that
    // one line survived the whole suite until an adversarial review found it (2026-09-02).
    await bootShell();
    hide();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    showAgain();
    expect(reload).toHaveBeenCalledTimes(1);

    showAgain(); // a duplicate event, with no intervening hide
    expect(reload).toHaveBeenCalledTimes(1);
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
