// Request timeouts (issue #556). Before this, api.js's fetch carried no timeout at all, so:
//   * a request that never answered stayed pending forever (and every `busy` spinner with it);
//   * the 15 s camera-status poll added two more pending requests on every tick of a stalled link;
//   * the per-camera detection save queue's "one in flight" slot never cleared, so every later save
//     for that camera was silently held back.
// Every fetch below NEVER settles and ignores its abort signal unless a test says otherwise - that is
// the failure these tests exist to catch, and a fetch that honours the signal would hide a missing
// race in api.js (real browsers do reject on abort; the race is the belt to that braces).
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, renderHook } from '@testing-library/react';

let api, DEFAULT_REQUEST_TIMEOUT_MS, SLOW_REQUEST_TIMEOUT_MS;

// A fetch that records every call and never answers.
function hangingFetch() {
  const fn = vi.fn(() => new Promise(() => {}));
  globalThis.fetch = fn;
  return fn;
}

// Settles a promise into an inspectable record without ever throwing in the test.
function track(promise) {
  const out = { settled: false, value: undefined, error: undefined };
  promise.then(
    (v) => { out.settled = true; out.value = v; },
    (e) => { out.settled = true; out.error = e; },
  );
  return out;
}

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  ({ api, DEFAULT_REQUEST_TIMEOUT_MS, SLOW_REQUEST_TIMEOUT_MS } = await import('../../src/lib/api.js'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('api request timeout', () => {
  test('a request that never answers rejects once the default timeout passes, not before', async () => {
    const fetchMock = hangingFetch();
    const result = track(api.get('/cameras'));

    await advance(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(result.settled).toBe(false);

    await advance(1);
    expect(result.settled).toBe(true);
    expect(result.error).toBeInstanceOf(Error);
    // The fetch was told to stop too, so the browser frees the connection.
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test('the timeout error does not look like a server fault', async () => {
    hangingFetch();
    const result = track(api.get('/cameras'));
    await advance(DEFAULT_REQUEST_TIMEOUT_MS);

    // No status: nothing was received, so there is no HTTP status to report (callers and the generic
    // "Request failed (5xx)" copy both key off `status`).
    expect(result.error.status).toBeUndefined();
    expect(result.error.timedOut).toBe(true);
    expect(result.error.message).toMatch(/took too long to respond/i);
    expect(result.error.message).toMatch(/check your connection/i);
    expect(result.error.message).not.toMatch(/Request failed|\b5\d\d\b/);
  });

  test('a per-call timeoutMs overrides the default: a slow-allowed call is not cut off early', async () => {
    hangingFetch();
    expect(SLOW_REQUEST_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUT_MS);
    const result = track(api.post('/cameras/onvif-probe', {}, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS }));

    await advance(DEFAULT_REQUEST_TIMEOUT_MS + 5000); // well past the default
    expect(result.settled).toBe(false);

    await advance(SLOW_REQUEST_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS - 5000);
    expect(result.settled).toBe(true);
    expect(result.error.timedOut).toBe(true);
  });

  test('every verb accepts the override (get/post/put/del)', async () => {
    hangingFetch();
    const results = [
      track(api.get('/a', { timeoutMs: 1000 })),
      track(api.post('/a', {}, { timeoutMs: 1000 })),
      track(api.put('/a', {}, { timeoutMs: 1000 })),
      track(api.del('/a', { timeoutMs: 1000 })),
    ];
    await advance(1000);
    expect(results.map((r) => r.settled)).toEqual([true, true, true, true]);
  });

  test('a request that answers in time is untouched and leaves no live timer behind', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{"a":1}' }));
    globalThis.fetch = fetchMock;
    await expect(api.get('/x')).resolves.toEqual({ a: 1 });
    expect(vi.getTimerCount()).toBe(0); // the timeout was cleared, not left to fire on a done request
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  });

  test('a real server error still reports its own message, not the timeout one', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 503, text: async () => '{"error":"Down for maintenance"}',
    }));
    const err = await api.get('/x').catch((e) => e);
    expect(err.message).toBe('Down for maintenance');
    expect(err.status).toBe(503);
    expect(err.timedOut).toBeUndefined();
  });

  test('a response whose BODY never finishes also times out', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }));
    const result = track(api.get('/x'));
    await advance(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(result.settled).toBe(true);
    expect(result.error.timedOut).toBe(true);
  });
});

describe('detection save queue recovers from a hung request', () => {
  test('a PUT that never answers fails after the timeout, and Retry then goes out', async () => {
    const { queuePatch, retry, useDetectionSave, __resetForTests } =
      await import('../../src/lib/detectionSaves.js');
    __resetForTests();

    const fetchMock = hangingFetch();
    const send = (payload) => api.put('/cameras/cam-1/detection', payload);
    const { result } = renderHook(() => useDetectionSave('cam-1'));

    act(() => { queuePatch('cam-1', { sound_sensitivity: 30 }, { immediate: true, send }); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe('saving');

    // Before the fix `inFlight` never cleared: this stayed on "Saving..." until a reload.
    await advance(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(result.current.state).toBe('failed');
    expect(result.current.error.timedOut).toBe(true);

    // The slot is free again, so Retry really sends (a wedged queue would ignore it).
    act(() => { retry('cam-1'); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(DEFAULT_REQUEST_TIMEOUT_MS); // let the retry time out too, so nothing leaks
  });
});

describe('CamerasProvider poll does not pile up', () => {
  const cam = (id) => ({ id, name: id, status: { ready: true } });

  async function mount() {
    const { CamerasProvider, CamerasContext } = await import('../../src/lib/CamerasContext.jsx');
    const { useContext } = await import('react');
    function Probe() {
      const ctx = useContext(CamerasContext);
      return <span data-testid="error">{ctx.error}</span>;
    }
    return render(<CamerasProvider><Probe /></CamerasProvider>);
  }

  test('a stalled server gets one poll (two requests), not one per 15 s tick', async () => {
    const fetchMock = hangingFetch();
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(2); // /children + /cameras, the mount-time load

    // Ticks at 15 s and 30 s-ish would each have added two more; the request timeout (30 s) has not
    // fired yet, so the first poll is still in flight and must be left alone.
    await advance(DEFAULT_REQUEST_TIMEOUT_MS - 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('once the stalled poll times out it counts as a failure and polling resumes', async () => {
    const fetchMock = hangingFetch();
    await mount();

    await advance(DEFAULT_REQUEST_TIMEOUT_MS);
    // The timed-out poll surfaces through the provider's normal error path (same as a refused
    // connection), not as a silent hang.
    expect(screen.getByTestId('error').textContent).toMatch(/took too long/i);

    // The first poll gave up at 30 s and the 30 s tick found the guard released: a second poll (two
    // more requests) is under way. A guard that never released (no timeout) would still be at 2.
    expect(fetchMock.mock.calls.length).toBe(4);
  });

  test('90 s of silence starts only a handful of requests (was 14)', async () => {
    const fetchMock = hangingFetch();
    await mount();
    await advance(90000);
    // Timeline: each poll (2 requests) is abandoned at 30 s and the next starts on the 15 s tick that
    // follows, so polls start at 0, 30, 60 and 90 s: 8 requests, against the 14 the issue measured
    // (and which kept growing, since none ever finished).
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  test('a manual refresh() is never skipped while a poll is in flight', async () => {
    const { CamerasProvider, CamerasContext } = await import('../../src/lib/CamerasContext.jsx');
    const { useContext, useEffect } = await import('react');
    let refresh;
    function Grab() {
      const ctx = useContext(CamerasContext);
      useEffect(() => { refresh = ctx.refresh; });
      return null;
    }
    const fetchMock = hangingFetch();
    render(<CamerasProvider><Grab /></CamerasProvider>);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => { refresh(); });
    // The detection queue awaits refresh() after a save; skipping it would hand back stale cameras.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await advance(DEFAULT_REQUEST_TIMEOUT_MS); // let both time out
  });

  test('a healthy poll still refreshes every 15 s', async () => {
    const fetchMock = vi.fn(async (url) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(String(url).endsWith('/children') ? [] : [cam('c1')]),
    }));
    globalThis.fetch = fetchMock;
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(15000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await advance(15000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
