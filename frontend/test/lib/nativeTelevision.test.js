// nativeBridge.isTelevision(): does the native shell say it is running on a television?
// The shell's ServerConfig.isTelevision() resolves { tv: boolean } (nightlight-mobile). The contract this file pins is that
// the answer is a clear YES only when the shell says exactly `{ tv: true }` inside a native app, and FALSE in every other
// case, so a phone is never sent to the TV screen by an absent or malformed answer.
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { isTelevision, TV_PROBE_MS } from '../../src/lib/nativeBridge.js';

const native = (ServerConfig) => {
  window.Capacitor = { isNativePlatform: () => true, Plugins: { ServerConfig } };
};

beforeEach(() => {
  delete window.Capacitor;
});
afterEach(() => {
  delete window.Capacitor;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('false in a browser, and the shell is not asked', async () => {
  const spy = vi.fn().mockResolvedValue({ tv: true });
  // A plugin object is present but the platform is not native: still false.
  window.Capacitor = { isNativePlatform: () => false, Plugins: { ServerConfig: { isTelevision: spy } } };
  expect(await isTelevision()).toBe(false);
  expect(spy).not.toHaveBeenCalled();
  delete window.Capacitor;
  expect(await isTelevision()).toBe(false);
});

test('false when the plugin, or the method, is missing (an app built before the method existed)', async () => {
  window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  expect(await isTelevision()).toBe(false);
  native({ list: vi.fn() });
  expect(await isTelevision()).toBe(false);
});

test('false when the shell rejects (the Capacitor "not implemented" case, iOS)', async () => {
  native({ isTelevision: vi.fn().mockRejectedValue(new Error('"isTelevision" is not implemented on android')) });
  expect(await isTelevision()).toBe(false);
});

test('false when the shell throws synchronously', async () => {
  native({ isTelevision: vi.fn(() => { throw new Error('boom'); }) });
  expect(await isTelevision()).toBe(false);
});

test('true when the shell says { tv: true }', async () => {
  const spy = vi.fn().mockResolvedValue({ tv: true });
  native({ isTelevision: spy });
  expect(await isTelevision()).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1);
});

test('false for { tv: false } and for answers that are not exactly true', async () => {
  for (const answer of [{ tv: false }, {}, null, undefined, { tv: 'true' }, { tv: 1 }, 'tv', true]) {
    native({ isTelevision: vi.fn().mockResolvedValue(answer) });
    expect(await isTelevision(), JSON.stringify(answer)).toBe(false);
  }
});

test('a shell that never answers is "not a TV" after the deadline, so the app cannot stay blank', async () => {
  vi.useFakeTimers();
  native({ isTelevision: vi.fn(() => new Promise(() => {})) });
  let settled = null;
  isTelevision().then((v) => { settled = v; });
  await vi.advanceTimersByTimeAsync(TV_PROBE_MS - 1);
  expect(settled).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
});

test('an answer that arrives in time is not cut off by the deadline', async () => {
  vi.useFakeTimers();
  native({ isTelevision: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ tv: true }), TV_PROBE_MS - 100))) });
  const answer = isTelevision();
  await vi.advanceTimersByTimeAsync(TV_PROBE_MS - 100);
  expect(await answer).toBe(true);
});
