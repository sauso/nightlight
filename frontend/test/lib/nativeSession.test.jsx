// One sign-in across the Android app's two addresses (owner, 2026-11-06; plan phase D, reviewed by Codex, Opus and agy). The WEB half:
// lib/nativeBridge.js (saveNativeSession / adoptNativeSession / clearNativeSession) and where AuthContext.jsx and api.js use them.
//   1. The helpers do nothing outside the Android shell with the three methods, never throw, and bound the wait for a saved sign-in;
//   2. a sign-in is saved after login, and a sign-out clears the saved copy with NO token (clear whatever is saved), offline too;
//   3. a page with no token asks the app for one ONCE, keeps `loading` true while it asks (no sign-in form flash), and the token it
//      gets still goes through /auth/me;
//   4. a token the server refuses (401) clears only THAT token: a wrong password or MFA code (a 401 with no token) clears nothing,
//      and a refused old token does not delete a newer saved one; a refused web token with a DIFFERENT saved token takes it once
//      and never loops.
// NOT COVERED: the native half (SessionRules, SessionVault: JVM tests in nightlight-mobile; the Keystore wrapper and the plugin glue
// only by the phone check in the PR).
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useContext } from 'react';

const unregisterPushNotifications = vi.fn();
const resetPushRegistration = vi.fn();
vi.mock('../../src/lib/pushNotifications.js', () => ({
  unregisterPushNotifications: () => unregisterPushNotifications(),
  resetPushRegistration: () => resetPushRegistration(),
}));

let AuthProvider, AuthContext, setToken, getToken, api, nb;
let calls; // every fetch: { url, auth }

const ME = { id: 'u1', username: 'nacho', role: 'admin' };

// `handler(url, init)` answers each request; the default answers /auth/me with ME and everything else with {}.
function stubFetch(handler = () => ({ body: {} })) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    const auth = init?.headers?.Authorization ?? null;
    calls.push({ url, auth });
    const { status = 200, body = {} } = handler(url, init, auth) || {};
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  });
}

function stubNative(extra = {}) {
  const ServerConfig = {
    saveSession: vi.fn().mockResolvedValue({ saved: true }),
    getSession: vi.fn().mockResolvedValue({ token: null }),
    clearSession: vi.fn().mockResolvedValue({ cleared: true }),
    ...extra,
  };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { ServerConfig } };
  return ServerConfig;
}

function Probe() {
  const ctx = useContext(AuthContext);
  return (
    <div>
      <span data-testid="loading">{String(ctx.loading)}</span>
      <span data-testid="user">{ctx.user ? ctx.user.username : 'none'}</span>
      <button onClick={() => ctx.refresh()}>refresh</button>
      {/* A DIFFERENT user from the one /auth/me returns (ME), so a test can tell "signed in by hand" from "checked by /auth/me". */}
      <button onClick={() => ctx.login('new.token.value', { id: 'u2', username: 'by-hand', role: 'admin' })}>sign in</button>
      <button onClick={() => ctx.logout()}>sign out</button>
    </div>
  );
}

const renderProvider = () => render(<AuthProvider><Probe /></AuthProvider>);
const click = async (name) => { await act(async () => { screen.getByText(name).click(); }); };

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = '';
  delete window.Capacitor;
  unregisterPushNotifications.mockReset();
  unregisterPushNotifications.mockResolvedValue(undefined);
  resetPushRegistration.mockReset();
  ({ setToken, getToken, api } = await import('../../src/lib/api.js'));
  nb = await import('../../src/lib/nativeBridge.js');
  ({ AuthProvider, AuthContext } = await import('../../src/lib/AuthContext.jsx'));
});

afterEach(() => {
  vi.useRealTimers();
  delete window.Capacitor;
});

describe('★ the helpers', () => {
  test('saveNativeSession hands the exact token over and reports whether it was kept', async () => {
    const SC = stubNative();
    expect(await nb.saveNativeSession('a.b.c')).toBe(true);
    expect(SC.saveSession).toHaveBeenCalledWith({ token: 'a.b.c' });
    SC.saveSession.mockResolvedValueOnce({ saved: false });
    expect(await nb.saveNativeSession('a.b.c')).toBe(false);
    SC.saveSession.mockResolvedValueOnce({});
    expect(await nb.saveNativeSession('a.b.c')).toBe(false);
  });

  test('saveNativeSession sends nothing for a missing or odd token, and never throws', async () => {
    const SC = stubNative();
    for (const bad of [null, undefined, '', 5, {}, []]) expect(await nb.saveNativeSession(bad)).toBe(false);
    expect(SC.saveSession).not.toHaveBeenCalled();
    SC.saveSession.mockRejectedValueOnce(new Error('Not available on this page'));
    await expect(nb.saveNativeSession('a.b.c')).resolves.toBe(false);
  });

  test('adoptNativeSession returns a string token and nothing else', async () => {
    const SC = stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'x.y.z' }) });
    expect(await nb.adoptNativeSession()).toBe('x.y.z');
    for (const answer of [{ token: null }, { token: '' }, { token: 5 }, { token: {} }, {}, null, undefined, 'x.y.z']) {
      SC.getSession.mockResolvedValueOnce(answer);
      expect(await nb.adoptNativeSession(), JSON.stringify(answer)).toBeNull();
    }
    SC.getSession.mockRejectedValueOnce(new Error('no'));
    await expect(nb.adoptNativeSession()).resolves.toBeNull();
  });

  test('★ adoptNativeSession gives up after 2 s: a slow app must not hold sign-in up', async () => {
    vi.useFakeTimers();
    stubNative({ getSession: vi.fn(() => new Promise(() => {})) });
    let answer = 'pending';
    nb.adoptNativeSession().then((value) => { answer = value; });
    await vi.advanceTimersByTimeAsync(1900);
    expect(answer).toBe('pending');
    await vi.advanceTimersByTimeAsync(200);
    expect(answer).toBeNull();
  });

  test('clearNativeSession clears everything with no token, and exactly one token when given', async () => {
    const SC = stubNative();
    await nb.clearNativeSession();
    expect(SC.clearSession).toHaveBeenLastCalledWith({});
    await nb.clearNativeSession('old.token.value');
    expect(SC.clearSession).toHaveBeenLastCalledWith({ token: 'old.token.value' });
    for (const odd of ['', null, 5, {}]) {
      await nb.clearNativeSession(odd);
      expect(SC.clearSession).toHaveBeenLastCalledWith({});
    }
    SC.clearSession.mockRejectedValueOnce(new Error('no'));
    await expect(nb.clearNativeSession()).resolves.toBe(false);
  });

  test('★ in a browser, on iOS, or with a shell missing any of the three methods: nothing is called and nothing throws', async () => {
    expect(await nb.saveNativeSession('a.b.c')).toBe(false);
    expect(await nb.adoptNativeSession()).toBeNull();
    expect(await nb.clearNativeSession()).toBe(false);
    for (const missing of ['saveSession', 'getSession', 'clearSession']) {
      const SC = stubNative();
      delete SC[missing];
      expect(await nb.saveNativeSession('a.b.c'), missing).toBe(false);
      expect(await nb.adoptNativeSession(), missing).toBeNull();
      expect(await nb.clearNativeSession(), missing).toBe(false);
      for (const fn of Object.values(SC)) expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('★ signing in and out', () => {
  test('★ a sign-in is saved in the app, once, with the token the server gave', async () => {
    stubFetch();
    const SC = stubNative();
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(SC.saveSession).not.toHaveBeenCalled(); // nothing to save before a sign-in
    await click('sign in');
    expect(SC.saveSession).toHaveBeenCalledTimes(1);
    expect(SC.saveSession).toHaveBeenCalledWith({ token: 'new.token.value' });
  });

  test('★ a sign-out clears the saved copy with no token, even when the server call fails (offline)', async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    const SC = stubNative();
    setToken('t.o.k');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await click('sign out');
    expect(SC.clearSession).toHaveBeenCalledWith({});
    expect(getToken()).toBeNull();
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });
});

describe('★ a page with no token asks the app once', () => {
  test('★ it keeps loading while it asks, then signs in with the saved token after /auth/me checks it', async () => {
    let answer;
    const SC = stubNative({ getSession: vi.fn(() => new Promise((resolve) => { answer = resolve; })) });
    stubFetch((url) => (String(url).startsWith('/api/auth/me') ? { body: ME } : { body: {} }));
    renderProvider();
    await act(async () => {});
    expect(screen.getByTestId('loading'), 'the sign-in form must not flash while the app is asked').toHaveTextContent('true');
    expect(calls).toEqual([]);
    await act(async () => { answer({ token: 'saved.token.value' }); });
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(calls.find((c) => String(c.url).startsWith('/api/auth/me')).auth).toBe('Bearer saved.token.value');
    expect(getToken()).toBe('saved.token.value');
    expect(SC.getSession).toHaveBeenCalledTimes(1);
  });

  test('★ nothing saved: signed out, /auth/me is never called, and asking again later does not ask the app again', async () => {
    const SC = stubNative();
    stubFetch();
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(calls).toEqual([]);
    await click('refresh');
    await click('refresh');
    expect(SC.getSession, 'once per page load: a revoked token must not be fetched again and again').toHaveBeenCalledTimes(1);
  });

  test('a page that already has a token does not ask the app', async () => {
    const SC = stubNative();
    stubFetch((url) => (String(url).startsWith('/api/auth/me') ? { body: ME } : { body: {} }));
    setToken('own.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(SC.getSession).not.toHaveBeenCalled();
  });

  test('★ a saved token the server refuses leaves the page signed out and clears that token in the app: no loop', async () => {
    const SC = stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'revoked.token.value' }) });
    stubFetch(() => ({ status: 401, body: { error: 'Invalid or expired session' } }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(SC.clearSession).toHaveBeenCalledWith({ token: 'revoked.token.value' });
    expect(calls.filter((c) => String(c.url).startsWith('/api/auth/me'))).toHaveLength(1);
    expect(SC.getSession).toHaveBeenCalledTimes(1);
  });
});

describe('★ a 401 clears exactly the token that was refused', () => {
  test('★ a LATE refusal of an old token does not end a newer sign-in (Codex review)', async () => {
    const SC = stubNative();
    let release;
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).startsWith('/api/children')) {
        await new Promise((resolve) => { release = resolve; }); // held until the test lets it go
        return { ok: false, status: 401, text: async () => '{}' };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(ME) };
    });
    setToken('old.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    const late = api.get('/children').catch(() => {}); // carries the OLD token
    await waitFor(() => expect(release).toBeTypeOf('function'));
    setToken('newer.token.value'); // the person signs in again while that request is out
    window.location.hash = '#/cameras';
    release();
    await late;
    expect(getToken(), 'the newer sign-in must survive the refusal of an old token').toBe('newer.token.value');
    expect(window.location.hash).toBe('#/cameras');
    expect(screen.getByTestId('user')).toHaveTextContent('nacho');
    expect(SC.clearSession).not.toHaveBeenCalled();
  });

  test('★ a wrong password (a 401 with no token) clears nothing in the app', async () => {
    const SC = stubNative();
    stubFetch(() => ({ status: 401, body: { error: 'Invalid username or password' } }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await expect(api.post('/auth/login', { username: 'a', password: 'wrong' })).rejects.toBeTruthy();
    expect(SC.clearSession, 'a typo on the sign-in form must not wipe a saved sign-in').not.toHaveBeenCalled();
  });

  test('★ a refused request that carried a token clears that token', async () => {
    const SC = stubNative();
    stubFetch((url) => (String(url).startsWith('/api/children') ? { status: 401, body: {} } : { body: ME }));
    setToken('current.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    await expect(api.get('/children')).rejects.toBeTruthy();
    await waitFor(() => expect(SC.clearSession).toHaveBeenCalledWith({ token: 'current.token.value' }));
    expect(SC.clearSession).toHaveBeenCalledTimes(1);
  });

  test('★ a web token the server refuses, with a DIFFERENT saved token: take it once, check it, and be signed in', async () => {
    const SC = stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'newer.token.value' }) });
    stubFetch((url, init, auth) => {
      if (!String(url).startsWith('/api/auth/me')) return { body: {} };
      return auth === 'Bearer newer.token.value' ? { body: ME } : { status: 401, body: {} };
    });
    setToken('stale.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(getToken()).toBe('newer.token.value');
    expect(SC.getSession).toHaveBeenCalledTimes(1);
    // The refusal told the app to drop the STALE token only; the newer saved one was not named.
    expect(SC.clearSession).toHaveBeenCalledWith({ token: 'stale.token.value' });
    expect(SC.clearSession).not.toHaveBeenCalledWith({ token: 'newer.token.value' });
  });

  test('★ taking the newer saved sign-in puts the person back where they were, not on the sign-in route', async () => {
    stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'newer.token.value' }) });
    stubFetch((url, init, auth) => {
      if (!String(url).startsWith('/api/auth/me')) return { body: {} };
      return auth === 'Bearer newer.token.value' ? { body: ME } : { status: 401, body: {} };
    });
    window.location.hash = '#/cameras';
    setToken('stale.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(window.location.hash).toBe('#/cameras');
  });

  test('★ a cold start has no route at all: taking the saved sign-in lands on the home screen, not the sign-in route', async () => {
    stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'newer.token.value' }) });
    stubFetch((url, init, auth) => {
      if (!String(url).startsWith('/api/auth/me')) return { body: {} };
      return auth === 'Bearer newer.token.value' ? { body: ME } : { status: 401, body: {} };
    });
    window.location.hash = '';
    setToken('stale.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(window.location.hash).toBe('#/');
  });

  test('★ the app is asked at most once per page load after a refusal, even for a later sign-in that is refused', async () => {
    const SC = stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'newer.token.value' }) });
    stubFetch((url, init, auth) => {
      // EXACT match: '/api/auth/media-token' also starts with '/api/auth/me'. login() fetches the media token, and refusing THAT
      // request signed the person out before the refresh below, which then (correctly) took the signed-out path. Found by a debug run.
      if (String(url) !== '/api/auth/me') return { body: {} };
      return auth === 'Bearer newer.token.value' ? { body: ME } : { status: 401, body: {} };
    });
    setToken('stale.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(SC.getSession).toHaveBeenCalledTimes(1);
    await click('sign in'); // signs in with 'new.token.value'; its /auth/me check is refused below
    // login() finishes with setUser AFTER it has fetched the media token: wait for that, or it could land AFTER the refusal below
    // and put the person back in. The user it sets is a different one from /auth/me's, so waiting for it is exact.
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('by-hand'));
    await click('refresh');
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('none'));
    expect(SC.getSession, 'a second refusal must not ask the app again').toHaveBeenCalledTimes(1);
  });

  test('★ a sign-in made while the app is still being asked is not overwritten by the answer', async () => {
    let answer;
    stubNative({ getSession: vi.fn(() => new Promise((resolve) => { answer = resolve; })) });
    stubFetch((url) => (String(url).startsWith('/api/auth/me') ? { body: ME } : { body: {} }));
    renderProvider();
    await act(async () => {});
    await click('sign in'); // the person signs in by hand while the app is still being asked
    await act(async () => { answer({ token: 'saved.token.value' }); });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(getToken()).toBe('new.token.value');
  });

  test('a saved sign-in that is refused too leaves the person on the sign-in route', async () => {
    stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'newer.token.value' }) });
    stubFetch(() => ({ status: 401, body: {} }));
    window.location.hash = '#/cameras';
    setToken('stale.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(window.location.hash).toBe('#/login');
  });

  test('★ a web token the server refuses, with the SAME token saved: signed out, asked once, no loop', async () => {
    const SC = stubNative({ getSession: vi.fn().mockResolvedValue({ token: 'stale.token.value' }) });
    stubFetch(() => ({ status: 401, body: {} }));
    setToken('stale.token.value');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(calls.filter((c) => String(c.url).startsWith('/api/auth/me'))).toHaveLength(1);
    expect(SC.getSession).toHaveBeenCalledTimes(1);
  });
});
