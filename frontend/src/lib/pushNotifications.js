// Push notifications on the native Android app (Capacitor @capacitor/push-notifications).
// Safe to import/call anywhere: in a browser, or in a native build that predates the push
// plugin, every function is a no-op. Accessed via the global Capacitor.Plugins bridge (same
// pattern as nativeBridge.js) so the web app needs no build-time dependency on the plugin.
import { api } from './api.js';
import { isNativeApp } from './nativeBridge.js';

// Must match the backend's ANDROID_CHANNEL in lib/push.js — Android 8+ drops a notification
// whose channel doesn't exist.
const CHANNEL_ID = 'nightlight_alerts';

function pushPlugin() {
  return window.Capacitor?.Plugins?.PushNotifications || null;
}

let started = false;
let currentToken = null;

// Request permission, register with FCM, and send the token to the server. Called once the user
// is signed in (see App.jsx). No-op off-native or when the plugin isn't in this build.
export async function initPushNotifications() {
  const PN = pushPlugin();
  if (!isNativeApp() || !PN || started) return;
  started = true;
  try {
    // Create the alert channel (importance 4 = HIGH, so alerts can pop/heads-up).
    if (PN.createChannel) {
      await PN.createChannel({
        id: CHANNEL_ID,
        name: 'Camera alerts',
        description: 'Motion (and later sound) alerts from your cameras.',
        importance: 4,
      }).catch(() => {});
    }

    // Register the token -> server whenever FCM (re)issues one.
    await PN.addListener('registration', async (t) => {
      currentToken = t?.value || null;
      if (!currentToken) return;
      try {
        await api.post('/push/register', { token: currentToken, platform: 'android' });
      } catch {
        // Non-fatal — it'll re-register on the next launch.
      }
    });
    await PN.addListener('registrationError', () => {});
    // Tapping a notification opens the app; take the user to the nursery (the alerting camera's
    // tile is there). data.cameraId is available for finer deep-linking later.
    await PN.addListener('pushNotificationActionPerformed', () => {
      window.location.hash = '#/';
    });

    const perm = await PN.requestPermissions();
    if (perm?.receive !== 'granted') {
      started = false;
      return;
    }
    await PN.register();
  } catch {
    started = false;
  }
}

// Called on sign-out so a signed-out device stops receiving this account's alerts.
export async function unregisterPushNotifications() {
  const token = currentToken;
  if (!token) return;
  try {
    await api.post('/push/unregister', { token });
  } catch {
    // ignore
  }
}
