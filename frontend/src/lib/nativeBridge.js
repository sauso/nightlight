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
