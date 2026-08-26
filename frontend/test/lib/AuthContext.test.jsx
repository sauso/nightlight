// The provider that decides whether the app is signed in. Its job is small but the failure modes are
// severe: a bootstrap that never finishes leaves a permanent spinner, and a logout that doesn't clear
// the media token leaves a signed-out tab still able to pull video.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useContext } from 'react';

// Logout best-effort unregisters this device for push. Stubbed so the test doesn't need a service
// worker; asserted on, because "sign out stops the alerts" is the user-visible promise.
const unregisterPushNotifications = vi.fn();
vi.mock('../../src/lib/pushNotifications.js', () => ({
  unregisterPushNotifications: () => unregisterPushNotifications(),
}));

let AuthProvider, AuthContext, setToken, getToken, getMediaToken;

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
  window.location.hash = '';
  // setup.js runs vi.restoreAllMocks() after every test, which strips the implementation too - so
  // re-arm it here rather than once at declaration.
  unregisterPushNotifications.mockReset();
  unregisterPushNotifications.mockResolvedValue(undefined);
  ({ setToken, getToken, getMediaToken } = await import('../../src/lib/api.js'));
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
