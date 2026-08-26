// The fetch wrapper every screen depends on. Three things here are worth real assertions:
//   * the 401 path, which both clears the session token AND bounces to #/login;
//   * the error shape (`status` + `data`), because callers branch on structured fields;
//   * the MEDIA token, which exists specifically so a full session token never lands in a URL
//     (and therefore never in a proxy log, browser history or Referer header).
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// api.js keeps the media token in module scope, so each test gets a fresh module instance rather
// than inheriting the previous test's cached token.
let api, getToken, setToken, refreshMediaToken, getMediaToken, clearMediaToken;

// A fetch stub that returns whatever the test queues up next. The last queued response repeats, so a
// test that only cares about one shape doesn't have to count calls.
function stubFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    const { status = 200, body = '' } = next;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  });
  globalThis.fetch = fn;
  fn.calls = calls;
  return fn;
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  window.location.hash = '';
  ({ api, getToken, setToken, refreshMediaToken, getMediaToken, clearMediaToken } =
    await import('../../src/lib/api.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session token storage', () => {
  test('round-trips through localStorage', () => {
    expect(getToken()).toBeNull();
    setToken('abc');
    expect(getToken()).toBe('abc');
    expect(localStorage.getItem('nightlight_token')).toBe('abc');
  });

  test('setToken(null) removes the key rather than storing "null"', () => {
    setToken('abc');
    setToken(null);
    expect(getToken()).toBeNull();
    expect(localStorage.getItem('nightlight_token')).toBeNull();
  });

  test('an empty-string token is treated as no token, not stored verbatim', () => {
    setToken('abc');
    setToken('');
    expect(getToken()).toBeNull();
  });
});

describe('request', () => {
  test('prefixes /api and sends the JSON content type', async () => {
    const fetchMock = stubFetch([{ body: { ok: true } }]);
    await api.get('/settings');
    expect(fetchMock.calls[0].url).toBe('/api/settings');
    expect(fetchMock.calls[0].init.method).toBe('GET');
    expect(fetchMock.calls[0].init.headers['Content-Type']).toBe('application/json');
  });

  test('attaches the bearer token when signed in, and omits it when not', async () => {
    const fetchMock = stubFetch([{ body: {} }]);
    await api.get('/a');
    expect(fetchMock.calls[0].init.headers.Authorization).toBeUndefined();

    setToken('tok-123');
    await api.get('/b');
    expect(fetchMock.calls[1].init.headers.Authorization).toBe('Bearer tok-123');
  });

  test('serialises a body for post/put and sends none for get/delete', async () => {
    const fetchMock = stubFetch([{ body: {} }]);
    await api.post('/x', { a: 1 });
    await api.put('/x', { b: 2 });
    await api.get('/x');
    await api.del('/x');
    expect(fetchMock.calls[0].init.body).toBe('{"a":1}');
    expect(fetchMock.calls[1].init.body).toBe('{"b":2}');
    expect(fetchMock.calls[2].init.body).toBeUndefined();
    expect(fetchMock.calls[3].init.body).toBeUndefined();
    expect(fetchMock.calls[3].init.method).toBe('DELETE');
  });

  test('a body of null is still sent (it is a value, not "absent")', async () => {
    const fetchMock = stubFetch([{ body: {} }]);
    await api.post('/x', null);
    expect(fetchMock.calls[0].init.body).toBe('null');
  });

  test('returns the parsed JSON payload', async () => {
    stubFetch([{ body: { name: 'Nightlight' } }]);
    await expect(api.get('/settings')).resolves.toEqual({ name: 'Nightlight' });
  });

  test('returns null for a successful but empty response (e.g. 204)', async () => {
    stubFetch([{ status: 204, body: '' }]);
    await expect(api.del('/thing/1')).resolves.toBeNull();
  });

  test('returns null rather than throwing when a 200 body is not JSON', async () => {
    stubFetch([{ status: 200, body: '<html>proxy error page</html>' }]);
    await expect(api.get('/x')).resolves.toBeNull();
  });
});

describe('request error handling', () => {
  test('throws the server-supplied message, carrying status and data', async () => {
    stubFetch([{ status: 400, body: { error: 'Bad zone', needsConfirm: true } }]);
    const err = await api.post('/cameras', {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Bad zone');
    expect(err.status).toBe(400);
    // Callers branch on structured fields, so the whole payload must survive.
    expect(err.data.needsConfirm).toBe(true);
  });

  test('falls back to a generic message when the body carries no error field', async () => {
    stubFetch([{ status: 500, body: '' }]);
    const err = await api.get('/x').catch((e) => e);
    expect(err.message).toBe('Request failed (500)');
    expect(err.status).toBe(500);
  });

  test('a 401 clears the stored token and redirects to the login route', async () => {
    setToken('expired');
    stubFetch([{ status: 401, body: { error: 'Unauthorised' } }]);
    await api.get('/auth/me').catch(() => {});
    expect(getToken()).toBeNull();
    expect(window.location.hash).toBe('#/login');
  });

  test('a 403 does NOT sign the user out - it is a permission problem, not a stale session', async () => {
    setToken('valid');
    stubFetch([{ status: 403, body: { error: 'Admin only' } }]);
    await api.del('/timelapses/1').catch(() => {});
    expect(getToken()).toBe('valid');
    expect(window.location.hash).toBe('');
  });
});

describe('media token', () => {
  test('is not fetched at all when signed out', async () => {
    const fetchMock = stubFetch([{ body: { token: 'm', expires_in: 3600 } }]);
    await expect(refreshMediaToken()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('is fetched from /auth/media-token and returned', async () => {
    setToken('sess');
    const fetchMock = stubFetch([{ body: { token: 'media-abc', expires_in: 43200 } }]);
    await expect(refreshMediaToken()).resolves.toBe('media-abc');
    expect(fetchMock.calls[0].url).toBe('/api/auth/media-token');
    expect(fetchMock.calls[0].init.method).toBe('POST');
  });

  test('concurrent refreshes share one in-flight request', async () => {
    setToken('sess');
    const fetchMock = stubFetch([{ body: { token: 'media-abc', expires_in: 43200 } }]);
    const [a, b, c] = await Promise.all([refreshMediaToken(), refreshMediaToken(), refreshMediaToken()]);
    expect([a, b, c]).toEqual(['media-abc', 'media-abc', 'media-abc']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('keeps the existing token when a refresh fails, rather than blanking media URLs', async () => {
    setToken('sess');
    stubFetch([{ body: { token: 'media-abc', expires_in: 43200 } }]);
    await refreshMediaToken();

    globalThis.fetch = vi.fn(async () => { throw new Error('network down'); });
    await expect(refreshMediaToken()).resolves.toBe('media-abc');
    expect(getMediaToken()).toBe('media-abc');
  });

  test('clearMediaToken drops it, so a signed-out tab cannot keep loading media', async () => {
    setToken('sess');
    stubFetch([{ body: { token: 'media-abc', expires_in: 43200 } }]);
    await refreshMediaToken();
    clearMediaToken();
    setToken(null);
    expect(getMediaToken()).toBeNull();
  });

  test('getMediaToken kicks off a background refresh when none is held, returning null on the first call', async () => {
    setToken('sess');
    const fetchMock = stubFetch([{ body: { token: 'media-abc', expires_in: 43200 } }]);
    expect(getMediaToken()).toBeNull(); // nothing held yet
    expect(fetchMock).toHaveBeenCalledTimes(1); // ...but a fetch is now in flight
    await vi.waitFor(() => expect(getMediaToken()).toBe('media-abc'));
  });

  test('refreshes proactively inside the 5-minute expiry margin', async () => {
    setToken('sess');
    const fetchMock = stubFetch([{ body: { token: 'media-abc', expires_in: 600 } }]); // 10 min
    await refreshMediaToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 4 minutes in: 6 minutes of life left, outside the margin - no refresh.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 4 * 60 * 1000);
    getMediaToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 6 minutes in: inside the last 5 minutes - refresh now.
    vi.setSystemTime(Date.now() + 2 * 60 * 1000);
    getMediaToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('api.url', () => {
  test('returns a plain path when no media token is held', () => {
    expect(api.url('/cameras/1/snapshot')).toBe('/api/cameras/1/snapshot');
  });

  test('appends the MEDIA token - never the session token - with ? for a bare path', async () => {
    setToken('SESSION-SECRET');
    stubFetch([{ body: { token: 'media-abc', expires_in: 43200 } }]);
    await refreshMediaToken();

    const url = api.url('/cameras/1/snapshot');
    expect(url).toBe('/api/cameras/1/snapshot?token=media-abc');
    expect(url).not.toContain('SESSION-SECRET');
  });

  test('uses & when the path already carries a query string', async () => {
    setToken('sess');
    stubFetch([{ body: { token: 'media-abc', expires_in: 43200 } }]);
    await refreshMediaToken();
    expect(api.url('/clips?date=2026-08-26')).toBe('/api/clips?date=2026-08-26&token=media-abc');
  });

  test('percent-encodes the token so a URL-unsafe character cannot break the query', async () => {
    setToken('sess');
    stubFetch([{ body: { token: 'a+b/c=d', expires_in: 43200 } }]);
    await refreshMediaToken();
    expect(api.url('/x')).toBe('/api/x?token=a%2Bb%2Fc%3Dd');
  });
});
