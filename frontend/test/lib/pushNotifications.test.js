// pushNotifications.js's own module-level `registered` flag - the thing that gates whether
// initPushNotifications() actually calls PN.register() again. AuthContext.test.jsx mocks this whole
// module out (it only needs to know logout() CALLS unregisterPushNotifications), so it can't see a
// bug inside this file's own state machine - this file tests the real module instead.
import { describe, test, expect, beforeEach, vi } from 'vitest';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../src/lib/api.js', () => ({
  api: { get: (...args) => apiGet(...args), post: (...args) => apiPost(...args) },
}));

const ENABLED_KEY = 'nightlight_notifications_enabled';

// Stands in for the native Capacitor plugins. register() resolves the SAME way the real plugin
// does - asynchronously, via the 'registration' event a listener was subscribed for - rather than
// returning the token directly, since ensureListeners()'s listener is where api.post('/push/
// register', ...) actually gets called.
function stubCapacitorNative({ token = 'fcm-token-1' } = {}) {
  const listeners = {};
  const PushNotifications = {
    addListener: vi.fn((event, cb) => {
      listeners[event] = cb;
      return Promise.resolve({ remove: () => {} });
    }),
    createChannel: vi.fn().mockResolvedValue(undefined),
    requestPermissions: vi.fn().mockResolvedValue({ receive: 'granted' }),
    register: vi.fn(async () => {
      await listeners.registration?.({ value: token });
    }),
  };
  const FirebaseInit = { initialize: vi.fn().mockResolvedValue(undefined) };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { PushNotifications, FirebaseInit } };
  return { PushNotifications, FirebaseInit };
}

let initPushNotifications, enableNotifications, disableNotifications, unregisterPushNotifications;

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  delete window.Capacitor;
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockResolvedValue({ configured: true, appId: 'a', apiKey: 'k', projectId: 'p', senderId: 's' });
  apiPost.mockResolvedValue({ ok: true });
  ({ initPushNotifications, enableNotifications, disableNotifications, unregisterPushNotifications } = await import(
    '../../src/lib/pushNotifications.js'
  ));
});

describe('a plain sign-out then sign-in, without restarting the app, still re-registers', () => {
  test('★ THE FIX: unregisterPushNotifications resets the registered flag, so a later initPushNotifications call actually re-registers', async () => {
    stubCapacitorNative();
    localStorage.setItem(ENABLED_KEY, '1'); // the device opted in during an earlier session

    await initPushNotifications();
    expect(apiPost).toHaveBeenCalledWith('/push/register', expect.objectContaining({ token: 'fcm-token-1' }));

    // logout()'s cleanup path in AuthContext.jsx calls exactly this, not disableNotifications() -
    // the toggle stays "on" the whole time, only the session changed.
    apiPost.mockClear();
    await unregisterPushNotifications();
    expect(apiPost).toHaveBeenCalledWith('/push/unregister', { token: 'fcm-token-1' });

    // A fresh sign-in in the SAME running app process - App.jsx's effect calls this directly again.
    apiPost.mockClear();
    await initPushNotifications();

    // Without the fix, `registered` was still true from the first call and this early-returns -
    // the device silently never re-registers for the rest of the app's lifetime.
    expect(apiPost).toHaveBeenCalledWith('/push/register', expect.objectContaining({ token: 'fcm-token-1' }));
  });

  test('a second initPushNotifications call with no logout in between does NOT re-register (the control)', async () => {
    // Proves the flag still does its original job - preventing a duplicate register from, say, two
    // effects firing close together - and that the fix above didn't just remove the guard entirely.
    const { PushNotifications } = stubCapacitorNative();
    localStorage.setItem(ENABLED_KEY, '1');

    await initPushNotifications();
    expect(PushNotifications.register).toHaveBeenCalledTimes(1);

    await initPushNotifications();
    expect(PushNotifications.register).toHaveBeenCalledTimes(1);
  });
});

describe('disableNotifications (the pre-existing toggle-off path)', () => {
  test('still resets the registered flag and unregisters, same as before', async () => {
    stubCapacitorNative();
    localStorage.setItem(ENABLED_KEY, '1');
    await initPushNotifications();
    apiPost.mockClear();

    await disableNotifications();
    expect(apiPost).toHaveBeenCalledWith('/push/unregister', { token: 'fcm-token-1' });
    expect(localStorage.getItem(ENABLED_KEY)).toBe('0');

    apiPost.mockClear();
    await enableNotifications();
    expect(apiPost).toHaveBeenCalledWith('/push/register', expect.objectContaining({ token: 'fcm-token-1' }));
  });
});
