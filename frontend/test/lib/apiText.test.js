// api.getText: a GET whose successful answer is a file (the ESPHome CSV), read as text. It is an option on the SAME
// request path as every other call (`as: 'text'`), so the claims worth a test are that it shares that path's
// behaviour, and that nothing else changed: a JSON call still parses, a refusal still reads as JSON.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

let api, setToken, getToken;

function stubFetch(responses) {
  const queue = [...responses];
  const fn = vi.fn(async () => {
    const { status = 200, body = '' } = queue.length > 1 ? queue.shift() : queue[0];
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  });
  globalThis.fetch = fn;
  return fn;
}

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  window.location.hash = '';
  ({ api, setToken, getToken } = await import('../../src/lib/api.js'));
});
afterEach(() => vi.useRealTimers());

const CSV = 'minute_utc,device\r\n"2026-10-01T00:00:00.000Z","#1"\r\n';

describe('api.getText', () => {
  test('★ returns the body untouched as a string (a CSV is not parsed as JSON), with the bearer token', async () => {
    setToken('tok');
    const fetch = stubFetch([{ body: CSV }]);
    expect(await api.getText('/esphome/export?device=1')).toBe(CSV);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/esphome/export?device=1');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  test('★ a JSON-looking body is STILL returned as the string, not parsed', async () => {
    // WHY: a plain `get` would hand back an object here. Without the `as` option reaching exchange(), a file that
    // happens to be valid JSON would arrive parsed, and one that is not would arrive as null.
    stubFetch([{ body: '{"a":1}' }]);
    expect(await api.getText('/x')).toBe('{"a":1}');
  });

  test('an error answer is read as JSON, so a refusal reads exactly as it does on every other call', async () => {
    stubFetch([{ status: 400, body: { error: 'Enter valid from and to dates no more than 31 days apart.' } }]);
    await expect(api.getText('/esphome/export')).rejects.toMatchObject({
      message: 'Enter valid from and to dates no more than 31 days apart.', status: 400,
    });
  });

  test('★ a 401 on a text call clears the token and goes to the login route, like a JSON call', async () => {
    setToken('tok');
    stubFetch([{ status: 401, body: { error: 'Unauthorized' } }]);
    await expect(api.getText('/esphome/export')).rejects.toMatchObject({ status: 401 });
    expect(getToken()).toBeNull();
    expect(window.location.hash).toBe('#/login');
  });

  test('★ it is allowed the slow timeout: a call that takes 60 s is not cut off at the default 30 s', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ ok: true, status: 200, text: async () => CSV }), 60000);
      init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    }));
    const pending = api.getText('/esphome/export');
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toBe(CSV);
  });

  test('a call that never answers still times out (at the slow limit) with the usual message', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = api.getText('/esphome/export').catch((e) => e);
    await vi.advanceTimersByTimeAsync(90000);
    const err = await pending;
    expect(err.timedOut).toBe(true);
  });
});

describe('the JSON path is unchanged', () => {
  test('get still parses JSON, and an empty 200 is still null', async () => {
    stubFetch([{ body: { ok: true } }, { body: '' }]);
    expect(await api.get('/x')).toEqual({ ok: true });
    expect(await api.get('/x')).toBeNull();
  });
});
