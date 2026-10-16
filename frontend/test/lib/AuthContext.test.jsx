// The provider that decides whether the app is signed in. Its job is small but the failure modes are
// severe: a bootstrap that never finishes leaves a permanent spinner, and a logout that doesn't clear
// the media token leaves a signed-out tab still able to pull video.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useContext } from 'react';

// Logout best-effort unregisters this device for push. Stubbed so the test doesn't need a service
// worker; asserted on, because "sign out stops the alerts" is the user-visible promise.
const unregisterPushNotifications = vi.fn();
// #562: the 401 listener resets push registration locally (see the describe at the end).
const resetPushRegistration = vi.fn();
vi.mock('../../src/lib/pushNotifications.js', () => ({
  unregisterPushNotifications: () => unregisterPushNotifications(),
  resetPushRegistration: () => resetPushRegistration(),
}));

let AuthProvider, AuthContext, setToken, getToken, getMediaToken, api;

function stubFetch(handler) {
  globalThis.fetch = vi.fn(async (url, init) => {
    const { status = 200, body = {} } = handler(url, init) || {};
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  });
  return globalThis.fetch;
}

// Surfaces the context value as text so assertions read like the UI's own branching.
function Probe() {
  const ctx = useContext(AuthContext);
  return (
    <div>
      <span data-testid="loading">{String(ctx.loading)}</span>
      <span data-testid="user">{ctx.user ? ctx.user.username : 'none'}</span>
      <span data-testid="unreachable">{String(ctx.unreachable)}</span>
      <button onClick={() => ctx.refresh()}>refresh</button>
      <button onClick={() => ctx.login('new-token', { id: 'u1', username: 'nacho', role: 'admin' })}>
        sign in
      </button>
      <button onClick={() => ctx.logout()}>sign out</button>
    </div>
  );
}

const renderProvider = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = '';
  // setup.js runs vi.restoreAllMocks() after every test, which strips the implementation too - so
  // re-arm it here rather than once at declaration.
  unregisterPushNotifications.mockReset();
  unregisterPushNotifications.mockResolvedValue(undefined);
  resetPushRegistration.mockReset();
  ({ setToken, getToken, getMediaToken, api } = await import('../../src/lib/api.js'));
  ({ AuthProvider, AuthContext } = await import('../../src/lib/AuthContext.jsx'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bootstrap', () => {
  test('with no stored token, finishes loading as signed out without calling the API', async () => {
    const fetchMock = stubFetch(() => ({ body: {} }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('with a stored token, loads the user from /auth/me', async () => {
    setToken('stored');
    stubFetch((url) =>
      url.endsWith('/auth/me')
        ? { body: { id: 'u1', username: 'nacho', role: 'admin' } }
        : { body: { token: 'media-abc', expires_in: 43200 } }
    );
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
  });

  test('primes the media token before the authed app renders, so the first image load has one', async () => {
    setToken('stored');
    stubFetch((url) =>
      url.endsWith('/auth/me')
        ? { body: { id: 'u1', username: 'nacho', role: 'admin' } }
        : { body: { token: 'media-abc', expires_in: 43200 } }
    );
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(getMediaToken()).toBe('media-abc');
  });

  test('a rejected /auth/me leaves the app signed out but NOT stuck loading', async () => {
    setToken('expired');
    stubFetch(() => ({ status: 401, body: { error: 'Unauthorised' } }));
    renderProvider();
    // The important half: loading must reach false, or the user sees a spinner forever.
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  test('a failed media-token fetch does not block sign-in', async () => {
    setToken('stored');
    stubFetch((url) =>
      url.endsWith('/auth/me')
        ? { body: { id: 'u1', username: 'nacho', role: 'admin' } }
        : { status: 500, body: '' }
    );
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
  });
});

describe('login', () => {
  test('stores the token and sets the user', async () => {
    stubFetch(() => ({ body: { token: 'media-abc', expires_in: 43200 } }));
    const { getByText } = renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => { getByText('sign in').click(); });

    expect(getToken()).toBe('new-token');
    expect(screen.getByTestId('user')).toHaveTextContent('nacho');
  });
});

describe('logout', () => {
  async function signedIn() {
    setToken('stored');
    stubFetch((url) =>
      url.endsWith('/auth/me')
        ? { body: { id: 'u1', username: 'nacho', role: 'admin' } }
        : { body: { token: 'media-abc', expires_in: 43200 } }
    );
    const utils = renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    return utils;
  }

  test('clears the session token, the media token and the user', async () => {
    const { getByText } = await signedIn();
    expect(getMediaToken()).toBe('media-abc');

    await act(async () => { getByText('sign out').click(); });

    expect(getToken()).toBeNull();
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    // Without this, a signed-out tab could still pull video with the in-memory media token.
    expect(getMediaToken()).toBeNull();
  });

  test('★ #377 signing out clears every unsaved-form draft, so the next person is never offered them', async () => {
    sessionStorage.setItem('nightlight_draft:u1:child:1', JSON.stringify({ at: Date.now(), values: { name: 'half typed' } }));
    sessionStorage.setItem('unrelated', 'keep');
    const { getByText } = await signedIn();
    await act(async () => { getByText('sign out').click(); });
    expect(sessionStorage.getItem('nightlight_draft:u1:child:1')).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('keep');
  });

  test('unregisters this device for push, so alerts stop reaching it', async () => {
    const { getByText } = await signedIn();
    await act(async () => { getByText('sign out').click(); });
    expect(unregisterPushNotifications).toHaveBeenCalled();
  });

  test('still signs out locally when the server-side logout call fails', async () => {
    const { getByText } = await signedIn();
    globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });

    await act(async () => { getByText('sign out').click(); });

    expect(getToken()).toBeNull();
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });

  test('still signs out locally when push unregistration rejects', async () => {
    const { getByText } = await signedIn();
    unregisterPushNotifications.mockRejectedValueOnce(new Error('no service worker'));

    await act(async () => { getByText('sign out').click(); });

    expect(getToken()).toBeNull();
    expect(screen.getByTestId('user')).toHaveTextContent('none');
  });
});

describe('media-token keepalive', () => {
  test('refreshes hourly while signed in, and stops on unmount', async () => {
    // Fake timers must be installed BEFORE the provider mounts: an interval scheduled under real
    // timers is not controlled by them afterwards, so the test would advance the clock and observe
    // nothing. `shouldAdvanceTime` keeps waitFor working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setToken('stored');
    const fetchMock = stubFetch((url) =>
      url.endsWith('/auth/me')
        ? { body: { id: 'u1', username: 'nacho', role: 'admin' } }
        : { body: { token: 'media-abc', expires_in: 43200 } }
    );
    const { unmount } = renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));

    const afterBootstrap = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60 * 1000); });
    expect(fetchMock.mock.calls.length).toBe(afterBootstrap + 1);

    // The interval must be torn down, or a remounted provider stacks timers.
    unmount();
    const afterUnmount = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000); });
    expect(fetchMock.mock.calls.length).toBe(afterUnmount);
  });

  test('no keepalive timer runs while signed out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubFetch(() => ({ body: {} }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));

    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// #562: a sign-in can end server-side while the app is open; the provider listens for the 401 (api.js's
// onUnauthorized). The app-level proof that the sign-in form then appears is in appShell.test.jsx; these pin
// what the provider itself does and that it stops listening when it unmounts.
describe('★ #562 a 401 on any request while signed in', () => {
  async function signedIn() {
    setToken('stored');
    stubFetch((url) =>
      url.endsWith('/auth/me')
        ? { body: { id: 'u1', username: 'nacho', role: 'admin' } }
        : { body: { token: 'media-abc', expires_in: 43200 } }
    );
    const utils = renderProvider();
    await waitFor(() => expect(screen.getByTestId('user')).toHaveTextContent('nacho'));
    expect(getMediaToken()).toBe('media-abc');
    return utils;
  }
  const answer401 = () => stubFetch(() => ({ status: 401, body: { error: 'Invalid or expired session' } }));

  test('★ drops the user and the media token, and resets push registration WITHOUT an unregister request', async () => {
    await signedIn();
    const fetchMock = answer401();
    await act(async () => { await api.get('/cameras').catch(() => {}); });

    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(getMediaToken()).toBeNull();
    // Reset locally, so signing in again in this page registers push afresh (pushNotifications.test.js
    // proves the flag); never unregister, whose request would answer 401 and fire this listener again.
    expect(resetPushRegistration).toHaveBeenCalledTimes(1);
    expect(unregisterPushNotifications).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // the one request that answered 401, nothing after it
  });

  test('★ #377 an EXPIRED sign-in keeps the unsaved-form drafts, so signing back in resumes them', async () => {
    const key = 'nightlight_draft:u1:child:1';
    sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), values: { name: 'half typed' } }));
    await signedIn();
    answer401();
    await act(async () => { await api.get('/cameras').catch(() => {}); });
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(sessionStorage.getItem(key)).not.toBeNull();
  });

  test('★ after the provider unmounts, a 401 no longer reaches it (the effect returns the unsubscribe)', async () => {
    const { unmount } = await signedIn();
    unmount();
    answer401();
    await act(async () => { await api.get('/cameras').catch(() => {}); });
    expect(resetPushRegistration).not.toHaveBeenCalled();
  });
});

// #382, review of #715. The provider's "Can't reach Nightlight" state: when it is set, when it is cleared, and how
// often it retries. Which SCREEN Shell then shows is proved in appShell.test.jsx; these pin the state itself,
// through the REAL api.js with only `fetch` faked.
describe('★ #382 review: the unreachable state and its automatic retry', () => {
  const ME = { id: 'u1', username: 'parent', role: 'admin' };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  // Every request answered by `server()`, and the fake-clock time of each /auth/me, so a test can read the gaps.
  function fakeServer(server) {
    const meAt = [];
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).endsWith('/auth/me')) meAt.push(Date.now());
      return server(String(url));
    });
    return { fetchMock: globalThis.fetch, meAt };
  }
  const down = () => res(503, { error: 'down' });
  const up = (url) => (url.endsWith('/auth/me') ? res(200, ME) : res(200, { token: 'media-abc', expires_in: 43200 }));
  const shows = (id, text) => expect(screen.getByTestId(id)).toHaveTextContent(text);

  // The clock moves in short slices, each in its own act(), so React commits what a failed attempt set (and
  // useAutoRetry arms the next timer) before the clock moves on. A slice is also how late a retry can be seen,
  // which is why the gap assertions below allow one second on top of the documented wait and nothing below it.
  async function runClock(ms, slice = 250) {
    for (let t = 0; t < ms; t += slice) {
      await act(async () => { await vi.advanceTimersByTimeAsync(slice); });
    }
  }

  test('★ a 401 on another request, THEN the earlier /auth/me fails: signed out, not unreachable', async () => {
    // The reverse of the ordering #715 fixed. The listener resets everything first; the stale failure that lands
    // after it used to set unreachable again, so a device with no token sat on "Can't reach Nightlight" until the
    // 5 s retry found no token, instead of showing the sign-in form.
    setToken('stored');
    let failMe;
    globalThis.fetch = vi.fn((url) => (String(url).endsWith('/auth/me')
      ? new Promise((_, reject) => { failMe = reject; })
      : Promise.resolve(res(401, { error: 'Invalid or expired session' }))));
    renderProvider();
    await waitFor(() => expect(failMe).toBeTypeOf('function'));
    await act(async () => { await api.get('/cameras').catch(() => {}); });
    expect(getToken(), 'precondition: the 401 dropped the token').toBeNull();

    await act(async () => { failMe(new TypeError('Failed to fetch')); });
    await waitFor(() => shows('loading', 'false'));
    expect(screen.getByTestId('unreachable'), 'a session that has ended is not an unreachable server').toHaveTextContent('false');
    shows('user', 'none');
  });

  test('★ Sign out after a failed refresh() clears the unreachable state at once', async () => {
    // Signed in; a refresh() (what Account and UserSettings call after a save) hits a 5xx, which keeps the user
    // and sets unreachable. Sign out used to drop only the user, leaving unreachable set: Shell showed
    // "Can't reach Nightlight" instead of the sign-in form until the pending retry. The app-level proof is in
    // appShell.test.jsx.
    let serverUp = true;
    fakeServer((url) => (serverUp ? up(url) : down()));
    setToken('stored');
    renderProvider();
    await waitFor(() => shows('user', 'parent'));
    serverUp = false;
    await act(async () => { screen.getByText('refresh').click(); });
    await waitFor(() => shows('unreachable', 'true'));
    shows('user', 'parent'); // a blip does not sign anyone out

    await act(async () => { screen.getByText('sign out').click(); });
    shows('user', 'none');
    expect(screen.getByTestId('unreachable'), 'signed out is not unreachable').toHaveTextContent('false');
  });

  test('★ Sign out cancels the retry a failed refresh() had armed: the next sign-in does not inherit it', async () => {
    // Zeroing the failure count on Sign out is what clears useAutoRetry's timer. Left armed, it fired into
    // whatever session came next and sent an /auth/me nobody asked for.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let serverUp = true;
    const { meAt } = fakeServer((url) => (serverUp ? up(url) : down()));
    setToken('stored');
    renderProvider();
    await waitFor(() => shows('user', 'parent'));
    serverUp = false;
    await act(async () => { screen.getByText('refresh').click(); });
    await waitFor(() => shows('unreachable', 'true')); // a retry is now armed, due in 5 s
    serverUp = true;

    await act(async () => { screen.getByText('sign out').click(); });
    await act(async () => { screen.getByText('sign in').click(); }); // someone signs in again straight away
    expect(getToken()).toBe('new-token');
    const attempts = meAt.length;
    await runClock(10000);
    expect(meAt, 'no /auth/me from the old session\'s retry').toHaveLength(attempts);
  });

  test('★ while the server stays down it retries after 5, 10 and 20 s, then every 30 s, and keeps the stored token', async () => {
    // The schedule README.md and docs/architecture.md promise. A retry that set the count to 1 instead of adding
    // one stopped after the first retry (the count never changed again, so nothing re-armed the timer); an
    // uncapped backoff waited 40 s, then 80 s.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setToken('stored');
    const { meAt } = fakeServer(down);
    renderProvider();
    await waitFor(() => shows('unreachable', 'true'));
    await runClock(130000); // 5 + 10 + 20 + 30 + 30 + 30 = 125 s, and the seventh attempt is not due until 155 s

    const gaps = meAt.slice(1).map((t, i) => t - meAt[i]);
    const expected = [5000, 10000, 20000, 30000, 30000, 30000];
    expect(gaps, `the gaps between attempts were ${gaps.join(', ')} ms`).toHaveLength(expected.length);
    expected.forEach((wait, i) => {
      expect(gaps[i], `attempt ${i + 2}`).toBeGreaterThanOrEqual(wait);
      expect(gaps[i], `attempt ${i + 2}`).toBeLessThan(wait + 1000);
    });
    expect(getToken(), 'two minutes of outage do not end the sign-in').toBe('stored');
  });

  test('★ once the server answers again the backoff starts over: the next outage is retried after 5 s, not 10', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setToken('stored');
    let serverUp = false;
    const { meAt } = fakeServer((url) => (serverUp ? up(url) : down()));
    renderProvider();
    await waitFor(() => shows('unreachable', 'true'));
    serverUp = true;
    await runClock(5500); // the 5 s retry succeeds
    shows('user', 'parent');
    expect(screen.getByTestId('unreachable'), 'an answer clears the unreachable state').toHaveTextContent('false');

    serverUp = false; // a later blip, during a refresh() after a save
    await act(async () => { screen.getByText('refresh').click(); });
    await waitFor(() => shows('unreachable', 'true'));
    const blipAt = meAt.at(-1);
    const attempts = meAt.length;
    await runClock(6000);
    expect(meAt, 'the first retry of a new outage comes after 5 s').toHaveLength(attempts + 1);
    expect(meAt.at(-1) - blipAt).toBeLessThan(6000);
  });

  test('★ signed out in another tab while this one cannot reach the server: the next retry shows signed out', async () => {
    // The token lives in localStorage, which every tab of the site shares, so signing out elsewhere removes it
    // here without telling this provider. The retry then finds no token: that is "signed out", and it has to
    // clear the unreachable state too, or this tab stays on "Can't reach Nightlight" for good (nothing would
    // change the failure count again, so nothing would re-arm the timer).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setToken('stored');
    const { fetchMock } = fakeServer(down);
    renderProvider();
    await waitFor(() => shows('unreachable', 'true'));
    setToken(null);
    const requests = fetchMock.mock.calls.length;
    await runClock(5500);
    shows('unreachable', 'false');
    shows('user', 'none');
    expect(fetchMock.mock.calls.length, 'with no token there is nothing to ask the server').toBe(requests);
  });

  test('unmounting the provider cancels the pending retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setToken('stored');
    const { fetchMock } = fakeServer(down);
    const { unmount } = renderProvider();
    await waitFor(() => shows('unreachable', 'true'));
    unmount();
    const requests = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(fetchMock.mock.calls.length).toBe(requests);
  });
});
