import { afterEach, expect, test, vi } from 'vitest';
import { setNativeImmersive } from '../../src/lib/nativeBridge.js';

afterEach(() => {
  delete window.Capacitor;
  vi.restoreAllMocks();
});

test('does nothing without a native Immersive plugin', async () => {
  expect(await setNativeImmersive(true)).toBe(false);
  window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  expect(await setNativeImmersive(true)).toBe(false);
  const setEnabled = vi.fn();
  window.Capacitor = { isNativePlatform: () => false, Plugins: { Immersive: { setEnabled } } };
  expect(await setNativeImmersive(true)).toBe(false);
  expect(setEnabled).not.toHaveBeenCalled();
});

test('passes the requested state to the native plugin', async () => {
  const setEnabled = vi.fn().mockResolvedValue(undefined);
  window.Capacitor = { isNativePlatform: () => true, Plugins: { Immersive: { setEnabled } } };
  expect(await setNativeImmersive(true)).toBe(true);
  expect(await setNativeImmersive(false)).toBe(true);
  expect(setEnabled.mock.calls).toEqual([[{ enabled: true }], [{ enabled: false }]]);
});

test('a native failure returns false without throwing', async () => {
  const error = new Error('native failure');
  window.Capacitor = { isNativePlatform: () => true, Plugins: { Immersive: { setEnabled: vi.fn().mockRejectedValue(error) } } };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(await setNativeImmersive(true)).toBe(false);
  expect(warn).toHaveBeenCalledWith('Immersive.setEnabled failed', error);
});
