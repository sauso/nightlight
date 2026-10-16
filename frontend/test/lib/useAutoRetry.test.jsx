// useAutoRetry (#382): the backoff behind "Can't reach Nightlight", on its own.
//
// lib/AuthContext.test.jsx and login.test.jsx prove that the two screens using it keep to the documented
// schedule end to end. This pins what the hook itself promises, which those cannot isolate: the exact delays,
// one retry per failure count, and that a new count or an unmount cancels the retry already scheduled (without
// that, a manual Try again that fails while the timer waits would fire twice, and an unmounted screen would
// keep calling the server).
import { describe, test, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRetry, retryDelayMs, RETRY_BASE_MS, RETRY_MAX_MS } from '../../src/lib/useAutoRetry.js';

afterEach(() => vi.useRealTimers());

const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const mountHook = (failures, retry) =>
  renderHook(({ n, cb }) => useAutoRetry(n, cb), { initialProps: { n: failures, cb: retry } });

describe('retryDelayMs', () => {
  test('★ 5 s, 10 s, 20 s, then 30 s for every attempt after that, however many', () => {
    // README.md and docs/architecture.md state this schedule. Without the 30 s cap the fourth wait is 40 s and
    // the tenth over 40 minutes.
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(retryDelayMs))
      .toEqual([5000, 10000, 20000, 30000, 30000, 30000, 30000, 30000, 30000, 30000]);
    expect(retryDelayMs(1000)).toBe(RETRY_MAX_MS);
    expect(RETRY_BASE_MS).toBe(5000);
    expect(RETRY_MAX_MS).toBe(30000);
  });
});

describe('useAutoRetry', () => {
  test('schedules nothing while nothing has failed', async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    mountHook(0, retry);
    await advance(10 * 60 * 1000);
    expect(retry).not.toHaveBeenCalled();
  });

  test('★ one retry, after the delay for that many failures, and no more until the count changes', async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    mountHook(3, retry);
    await advance(20000 - 1);
    expect(retry).not.toHaveBeenCalled();
    await advance(1);
    expect(retry).toHaveBeenCalledTimes(1);
    await advance(10 * 60 * 1000);
    expect(retry, 'the next retry waits for the caller to report another failure').toHaveBeenCalledTimes(1);
  });

  test('★ a new failure count replaces the scheduled retry instead of adding a second one', async () => {
    // A manual Try again that fails bumps the count while the automatic retry is still waiting.
    vi.useFakeTimers();
    const retry = vi.fn();
    const { rerender } = mountHook(1, retry);
    await advance(1000);
    rerender({ n: 2, cb: retry });
    await advance(10000 - 1);
    expect(retry, 'the old 5 s retry did not fire').not.toHaveBeenCalled();
    await advance(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('★ a count back at 0 (the server answered) cancels the scheduled retry', async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { rerender } = mountHook(1, retry);
    rerender({ n: 0, cb: retry });
    await advance(60000);
    expect(retry).not.toHaveBeenCalled();
  });

  test('★ unmounting cancels the scheduled retry', async () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { unmount } = mountHook(1, retry);
    unmount();
    await advance(60000);
    expect(retry).not.toHaveBeenCalled();
  });

  test('the timer calls the latest callback, not the one it was armed with', async () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = mountHook(1, first);
    rerender({ n: 1, cb: latest });
    await advance(RETRY_BASE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
