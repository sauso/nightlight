// useLater (#855): a setTimeout that dies with the component.
//
// The "Saved" ticks, "Copied" and the camera restart and reboot messages used to be bare
// `setTimeout(() => setX(...), ms)` calls. Leave the page and they fired anyway, on an unmounted component; in CI one
// fired after jsdom was torn down ("window is not defined") and failed a run although every test passed. This pins
// what the hook itself promises. Two components (Account, SettingsGeneral) have a test each that leaving the page
// really cancels the tick; the other call sites are the same one-line swap and are not individually tested.
import { StrictMode } from 'react';
import { describe, test, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLater } from '../../src/lib/useLater.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Distinctive delay, so the spies can pick this hook's timers out of any other timer React or the test library starts.
const MS = 4321;
const mine = (spy) => spy.mock.calls.flatMap((c, i) => (c[1] === MS ? [spy.mock.results[i].value] : []));

describe('useLater', () => {
  test('★ while mounted it behaves like setTimeout: the callback runs once, after the delay', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const { result } = renderHook(() => useLater());
    act(() => { result.current(fn, MS); });
    act(() => { vi.advanceTimersByTime(MS - 1); });
    expect(fn).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(fn).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('★ unmounting cancels every pending timer: the callback never runs and clearTimeout ran for each', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const first = vi.fn();
    const second = vi.fn();
    const { result, unmount } = renderHook(() => useLater());
    act(() => { result.current(first, MS); result.current(second, MS); });
    const ids = mine(setSpy);
    expect(ids).toHaveLength(2);
    expect(clearSpy).not.toHaveBeenCalledWith(ids[0]);
    unmount();
    expect(clearSpy).toHaveBeenCalledWith(ids[0]);
    expect(clearSpy).toHaveBeenCalledWith(ids[1]);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  test('★ a timer that has already fired is forgotten: unmounting later does not clear it again', () => {
    // Without the delete-on-fire the set grows for the life of the page and unmount clears ids that no longer exist.
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const { result, unmount } = renderHook(() => useLater());
    act(() => { result.current(() => {}, MS); });
    const [id] = mine(setSpy);
    act(() => { vi.advanceTimersByTime(MS); });
    unmount();
    expect(clearSpy).not.toHaveBeenCalledWith(id);
  });

  test('★ called after the page is gone it schedules nothing (a save that finishes late starts no timer)', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi.fn();
    const { result, unmount } = renderHook(() => useLater());
    unmount();
    act(() => { result.current(fn, MS); });
    expect(mine(setSpy)).toHaveLength(0);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(fn).not.toHaveBeenCalled();
  });

  test('the function is the same one on every render, so it is safe in a dependency list', () => {
    const { result, rerender } = renderHook(() => useLater());
    const first = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(first);
  });

  test('★ under StrictMode (cleanup, then mount again, in dev) it still schedules and fires', () => {
    // The mount-time cleanup flips "alive" to false; if the effect did not set it true again every later call would
    // silently do nothing in development (the same lesson as the #858 photo timers).
    vi.useFakeTimers();
    const fn = vi.fn();
    const { result } = renderHook(() => useLater(), { wrapper: StrictMode });
    act(() => { result.current(fn, MS); });
    act(() => { vi.advanceTimersByTime(MS); });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
