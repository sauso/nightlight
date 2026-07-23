// Bridge between the web app and the native Android shell (Capacitor).
//
// Safe to import everywhere: in a normal browser every function is a no-op,
// so the web app behaves exactly as before. Only inside the Capacitor
// WebView does isNativeApp() return true and the plugin calls do anything.

// Tracks which cameras are currently in Background listening mode across the
// whole app. The foreground service is a single app-wide thing, so we start
// it when the first camera enters background mode, retitle its notification
// as the set changes, and stop it when the last camera leaves.
const activeCameras = new Map(); // camera.id -> camera.name

export function isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.();
}

// True if the native foreground service is currently holding a wake lock + wifi
// lock for at least one camera (see AudioService.kt) - i.e. there's real evidence
// the process and its network connections were kept alive through however long the
// app was backgrounded, rather than frozen/suspended by Android. Used by
// useReloadAfterBackground in App.jsx to decide whether a resume-triggered reload
// is actually necessary, or would just interrupt a stream that never went stale.
export function hasActiveBackgroundAudio() {
  return activeCameras.size > 0;
}

// Forget the saved server address and restart the native shell back into its
// first-run setup screen (see ServerConfigPlugin.kt in nightlight-android). The
// whole app reboots into a different page, so nothing after the restart() call
// here ever runs.
export async function changeServer() {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p) return;
  try {
    await p.clear();
    await p.restart();
  } catch (err) {
    console.warn('ServerConfig plugin call failed', err);
  }
}

// True if this JS context has already run once before in this browsing session -
// i.e. this load came from our own location.reload() (see useReloadAfterBackground
// in App.jsx, which reloads after a long spell backgrounded to clear up half-broken
// WebRTC/HLS state), not a genuine fresh launch of the app. sessionStorage survives
// a reload but is cleared when the WebView itself is destroyed and recreated, which
// is what lets CameraTile tell the two apart - only a true fresh launch should
// silently collapse a persisted Background-listening choice back to plain On.
const SESSION_FLAG_KEY = 'nightlight_session_started';
export const isSoftReload = (() => {
  try {
    const already = sessionStorage.getItem(SESSION_FLAG_KEY) === 'true';
    sessionStorage.setItem(SESSION_FLAG_KEY, 'true');
    return already;
  } catch {
    return false;
  }
})();

function plugin() {
  return window.Capacitor?.Plugins?.BackgroundAudio ?? null;
}

async function syncService() {
  const p = plugin();
  if (!p) return;

  try {
    if (activeCameras.size === 0) {
      await p.stop();
      return;
    }
    const names = [...activeCameras.values()];
    const label = names.length === 1 ? names[0] : `${names.length} cameras`;
    // Calling start while the service is already running just updates the
    // notification text - it does not restart anything.
    await p.start({ label });
  } catch (err) {
    // Native call failing shouldn't break audio in the WebView itself.
    console.warn('BackgroundAudio plugin call failed', err);
  }
}

export function setBackgroundListening(cameraId, cameraName, enabled) {
  if (!isNativeApp()) return;
  const before = activeCameras.size;
  if (enabled) {
    activeCameras.set(cameraId, cameraName);
  } else {
    activeCameras.delete(cameraId);
  }
  // Only touch the service when membership actually changed.
  if (activeCameras.size !== before || enabled) syncService();
}

// Fired when the person taps "Stop" on the Android notification. Tiles use
// this to drop themselves back from 'bg' to 'on'. Returns an unsubscribe fn.
export function onBackgroundStopped(callback) {
  const p = plugin();
  if (!p) return () => {};

  const handlePromise = p.addListener('stopped', () => {
    activeCameras.clear();
    callback();
  });
  return () => {
    handlePromise.then((handle) => handle.remove()).catch(() => {});
  };
}
