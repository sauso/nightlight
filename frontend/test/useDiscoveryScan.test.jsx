import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useDiscoveryScan from '../src/lib/useDiscoveryScan.js';
import { api } from '../src/lib/api.js';

vi.mock('../src/lib/api.js', async (original) => {
  const module = await original();
  return { ...module, api: { ...module.api, get: vi.fn(), post: vi.fn() } };
});
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

test.each(['/cameras/discover', '/esphome/discover'])('%s drops a late earlier search answer (#1071)', async (path) => {
  const old = deferred();
  api.post.mockResolvedValueOnce({ scanId: 'old', endsAt: Date.now() + 30000 })
    .mockResolvedValueOnce({ scanId: 'new', endsAt: Date.now() + 30000 });
  api.get.mockImplementation((url) => url.endsWith('/old') ? old.promise
    : Promise.resolve({ done: true, candidates: [{ ip: '10.0.0.2' }], sourceErrors: [] }));
  const { result } = renderHook(() => useDiscoveryScan(path));
  await act(async () => { result.current.start(); await Promise.resolve(); });
  await act(async () => { result.current.start(); await Promise.resolve(); await Promise.resolve(); });
  expect(result.current.scan.candidates[0].ip).toBe('10.0.0.2');
  await act(async () => { old.resolve({ done: true, candidates: [{ ip: '10.0.0.1' }] }); });
  expect(result.current.scan.candidates[0].ip).toBe('10.0.0.2');
});

test.each(['/cameras/discover', '/esphome/discover'])('%s stop drops an in-flight poll (#1071)', async (path) => {
  const old = deferred();
  api.post.mockResolvedValue({ scanId: 'one', endsAt: Date.now() + 30000 });
  api.get.mockReturnValue(old.promise);
  const { result } = renderHook(() => useDiscoveryScan(path));
  await act(async () => { result.current.start(); await Promise.resolve(); });
  await act(async () => { result.current.stop(); old.resolve({ done: true, candidates: [{ ip: '10.0.0.1' }] }); });
  expect(result.current.scan.candidates).toEqual([]);
});

test.each(['/cameras/discover', '/esphome/discover'])('%s aborts and clears timer on unmount (#1071)', async (path) => {
  vi.useFakeTimers();
  api.post.mockResolvedValue({ scanId: 'one', endsAt: Date.now() + 30000 });
  api.get.mockResolvedValue({ done: false, candidates: [] });
  const { result, unmount } = renderHook(() => useDiscoveryScan(path, true));
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
  expect(api.post).toHaveBeenCalledWith(path, {}, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(api.get).toHaveBeenCalledTimes(1);
  const signal = api.post.mock.calls[0][2].signal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(api.get).toHaveBeenCalledTimes(1);
});

test.each(['/cameras/discover', '/esphome/discover'])('%s countdown expires and marks search done (#1071)', async (path) => {
  vi.useFakeTimers();
  api.post.mockResolvedValue({ scanId: 'one', endsAt: Date.now() + 1000 });
  api.get.mockResolvedValue({ done: false, candidates: [] });
  const { result } = renderHook(() => useDiscoveryScan(path));
  await act(async () => { result.current.start(); for (let i = 0; i < 5; i++) await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(result.current.seconds).toBe(0);
  expect(result.current.scan.done).toBe(true);
});
