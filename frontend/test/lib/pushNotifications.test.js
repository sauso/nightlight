// pushNotifications.js's own module-level `registered` flag - the thing that gates whether
// initPushNotifications() actually calls PN.register() again. AuthContext.test.jsx mocks this whole
// module out (it only needs to know logout() CALLS unregisterPushNotifications), so it can't see a
// bug inside this file's own state machine - this file tests the real module instead.
import { describe, test, expect, beforeEach, vi } from 'vitest';

const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../../src/lib/api.js', () => ({
  api: { get: (...args) => apiGet(...args), post: (...args) => apiPost(...args) },
  // nativeBridge's server-switch check (#559) reads it; null = signed out, so it never asks /about here.
  getToken: () => null,
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

let initPushNotifications, enableNotifications, disableNotifications, unregisterPushNotifications, resetPushRegistration;

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  delete window.Capacitor;
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockResolvedValue({ configured: true, appId: 'a', apiKey: 'k', projectId: 'p', senderId: 's' });
  apiPost.mockResolvedValue({ ok: true });
  ({ initPushNotifications, enableNotifications, disableNotifications, unregisterPushNotifications, resetPushRegistration } =
    await import('../../src/lib/pushNotifications.js'));
});

// #562 (review of #696): when a sign-in ends server-side, AuthContext's 401 listener drops the user in the
// same page. Signing in again must register push again, or the phone stays bound to the dead session and
// gets no alerts until the app is relaunched. The listener cannot use unregisterPushNotifications(): its
// request would answer 401 and fire the listener again.
describe('★ #562 resetPushRegistration: a sign-in ended by a 401, then signing in again', () => {
  test('★ re-registers on the next initPushNotifications, and the reset itself sends no request', async () => {
    const { PushNotifications } = stubCapacitorNative();
    localStorage.setItem(ENABLED_KEY, '1');
    await initPushNotifications();
    expect(PushNotifications.register).toHaveBeenCalledTimes(1);

    apiGet.mockClear();
    apiPost.mockClear();
    resetPushRegistration();
    expect(apiGet).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled(); // no /push/unregister: that would 401 and loop

    await initPushNotifications();
    expect(PushNotifications.register).toHaveBeenCalledTimes(2);
    expect(apiPost).toHaveBeenCalledWith('/push/register', expect.objectContaining({ token: 'fcm-token-1' }));
  });
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

// #559: tapping an alert that names another server used to switch the app to it straight away. It now goes
// through requestServerSwitch, like any other request: a dialog, only for a server already saved on the phone,
// and while that dialog is up the app does not also move to the nursery underneath it. The dialog's own rules
// are in serverSwitch.test.js; this pins that the tap is wired to them and never switches by itself.
describe('★ #559 tapping an alert from another server asks first', () => {
  const GOOD = 'https://good.example';
  let ServerConfig;
  let nb;

  async function tapWith(server, { servers = [] } = {}) {
    const { PushNotifications } = stubCapacitorNative();
    ServerConfig = {
      list: vi.fn().mockResolvedValue({ servers, active: window.location.origin }),
      save: vi.fn().mockResolvedValue({}),
      restart: vi.fn().mockResolvedValue(undefined),
    };
    window.Capacitor.Plugins.ServerConfig = ServerConfig;
    localStorage.setItem(ENABLED_KEY, '1');
    await initPushNotifications();
    // The same module instance pushNotifications.js imported (both loaded after this test's resetModules).
    nb = await import('../../src/lib/nativeBridge.js');
    const onTap = PushNotifications.addListener.mock.calls.find(([e]) => e === 'pushNotificationActionPerformed')[1];
    window.location.hash = '#/children/kid-1'; // where the person was when the alert came in
    await onTap({ notification: { data: server === undefined ? {} : { server } } });
  }

  // The switch assertions come first on purpose: run against the code before #559 they are what fails (it
  // called save() at once), rather than the dialog lookup, which did not exist then.
  test('★ an unsaved server: nothing switches, the app stays where it was, and the refusal shows', async () => {
    await tapWith(GOOD, { servers: ['http://good.example', 'https://good.example.evil'] });
    expect(ServerConfig.save).not.toHaveBeenCalled();
    expect(ServerConfig.restart).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/children/kid-1');
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'refused', origin: GOOD });
  });

  test('★ a saved server: nothing switches until Switch, the app stays where it was, and the dialog asks', async () => {
    await tapWith(`${GOOD}/`, { servers: [GOOD] });
    expect(ServerConfig.save).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/children/kid-1');
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'confirm', origin: GOOD, entry: GOOD });
  });

  // Opening the nursery (#/) is itself the proof that no dialog took over: the tap returns early when one does.
  test('an unusable address switches nothing and opens in place, as an alert with no server does', async () => {
    await tapWith('https://good.example/path', { servers: ['https://good.example/path'] });
    expect(ServerConfig.save).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/');
  });

  test('control: an alert from the server on screen, or with no server, opens the nursery with no dialog', async () => {
    await tapWith(window.location.origin, { servers: [GOOD] });
    expect(window.location.hash).toBe('#/');

    window.location.hash = '#/children/kid-1';
    const onTap = window.Capacitor.Plugins.PushNotifications.addListener.mock.calls
      .find(([e]) => e === 'pushNotificationActionPerformed')[1];
    await onTap({ notification: { data: {} } });
    expect(window.location.hash).toBe('#/');
    expect(ServerConfig.list).not.toHaveBeenCalled();
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
