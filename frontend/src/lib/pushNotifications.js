// Push notifications on the native Android app (Capacitor). Safe to import/call anywhere: in a
// browser, or in a native build without the plugins, everything is a no-op.
//
// Self-hosted flow: the app has NO Firebase project baked in. It fetches this server's Firebase
// client config (GET /api/push/config, from the admin's google-services.json), initializes Firebase
// at runtime via the native FirebaseInit plugin, then registers for FCM. So each server uses its own
// Firebase project. Push is per-device opt-in (a Notifications toggle in Account).
import { api } from './api.js';
import { isNativeApp } from './nativeBridge.js';

// Must match the backend's ANDROID_CHANNEL (lib/push.js).
const CHANNEL_ID = 'nightlight_alerts';
// Per-device opt-in (like mute) — a signed-out/other device won't get alerts unless it opts in.
const ENABLED_KEY = 'nightlight_notifications_enabled';

function pushPlugin() {
  return window.Capacitor?.Plugins?.PushNotifications || null;
}
function firebaseInitPlugin() {
  return window.Capacitor?.Plugins?.FirebaseInit || null;
}

// True only in a native build that actually includes the push plugins (so the toggle can be hidden
// in a browser / on an older APK).
export function notificationsSupported() {
  return isNativeApp() && !!pushPlugin() && !!firebaseInitPlugin();
}

export function notificationsEnabled() {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

// Server push status: { configured, push_enabled }. `configured` = this server has Firebase set up.
export async function getServerPushStatus() {
  try {
    return await api.get('/push/status');
  } catch {
    return { configured: false, push_enabled: false };
  }
}

let currentToken = null;
let listenersAdded = false;
let registered = false;

async function ensureListeners(PN) {
  if (listenersAdded) return;
  listenersAdded = true;
  await PN.addListener('registration', async (t) => {
    currentToken = t?.value || null;
    if (!currentToken) return;
    try {
      await api.post('/push/register', { token: currentToken, platform: 'android' });
    } catch {
      // Non-fatal — re-registers next launch.
    }
  });
  await PN.addListener('registrationError', () => {});
  // Tapping an alert opens the app to the nursery (the alerting camera's tile is there).
  await PN.addListener('pushNotificationActionPerformed', () => {
    window.location.hash = '#/';
  });
  // A push that arrives while the app is in the FOREGROUND is not shown in the system tray by
  // Android — it's delivered here instead. Re-broadcast it as an in-app banner so foreground FCM
  // alerts are still visible (Pushover shows its own since it's a separate app). See PushBanner.jsx.
  await PN.addListener('pushNotificationReceived', (notif) => {
    window.dispatchEvent(
      new CustomEvent('nightlight:push', {
        detail: {
          title: notif?.title || notif?.data?.title || 'Camera alert',
          body: notif?.body || notif?.data?.body || 'Motion detected',
          cameraId: notif?.data?.cameraId || null,
        },
      })
    );
  });
}

// Initialize Firebase from the server's config and register for push — but only if this device has
// opted in and the server is configured. Called on sign-in and when the toggle is switched on.
export async function initPushNotifications() {
  if (!notificationsSupported() || !notificationsEnabled() || registered) return;
  const PN = pushPlugin();
  const FB = firebaseInitPlugin();
  try {
    const cfg = await api.get('/push/config');
    if (!cfg?.configured) return; // server has no Firebase configured
    await FB.initialize({ appId: cfg.appId, apiKey: cfg.apiKey, projectId: cfg.projectId, senderId: cfg.senderId });

    if (PN.createChannel) {
      await PN.createChannel({
        id: CHANNEL_ID,
        name: 'Camera alerts',
        description: 'Motion (and later sound) alerts from your cameras.',
        importance: 4,
      }).catch(() => {});
    }
    await ensureListeners(PN);

    const perm = await PN.requestPermissions();
    if (perm?.receive !== 'granted') return;
    registered = true;
    await PN.register();
  } catch {
    // leave registered=false so a later attempt can retry
  }
}

// Turn notifications on for this device: opt in + register now (prompts for permission).
export async function enableNotifications() {
  try {
    localStorage.setItem(ENABLED_KEY, '1');
  } catch {
    /* ignore */
  }
  await initPushNotifications();
}

// Turn notifications off for this device: unregister + opt out.
export async function disableNotifications() {
  try {
    localStorage.setItem(ENABLED_KEY, '0');
  } catch {
    /* ignore */
  }
  await unregisterPushNotifications();
  registered = false;
}

// Best-effort unregister of this device's token (on toggle-off or sign-out).
export async function unregisterPushNotifications() {
  const token = currentToken;
  if (!token) return;
  try {
    await api.post('/push/unregister', { token });
  } catch {
    /* ignore */
  }
}
