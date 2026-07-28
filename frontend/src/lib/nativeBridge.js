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
// first-run setup screen (see ServerConfigPlugin.kt in nightlight-mobile). The
// whole app reboots into a different page, so nothing after the restart() call
// here ever runs.
export async function changeServer() {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p) return;
  // Tear down all playback and the background-audio service BEFORE restarting. The restart
  // rebuilds the WebView, but on its own it doesn't reliably stop media that's already playing
  // (Android's foreground service keeps the process/audio alive; iOS's old web view can linger
  // behind the swapped root controller). Left as-is, the old server's sound keeps going after
  // the switch and a second session stacks on top when you come back. So: stop every audio/video
  // element here and now, release the native foreground service, and only then clear + restart.
  try {
    document.querySelectorAll('audio, video').forEach((el) => {
      try { el.pause(); } catch { /* ignore */ }
      el.srcObject = null;
      el.removeAttribute('src');
      try { el.load(); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
  try {
    activeCameras.clear();
    await plugin()?.stop();
  } catch { /* ignore */ }
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

function pipPlugin() {
  return window.Capacitor?.Plugins?.Pip ?? null;
}

// True only where the native Activity-PiP plugin exists - i.e. the Android app. Lets the
// UI branch synchronously (before doing async fullscreen work) between the native
// fullscreen-then-PiP flow and the web <video> PiP API used in a browser and the iOS shell.
export function hasNativePip() {
  return !!pipPlugin();
}

// Whether the PiP button had to enter fullscreen itself to get a clean float (i.e. the
// tile wasn't already fullscreen). Leaving PiP uses this to return the user to where they
// were: exit fullscreen back to the dashboard if we entered it for them, or stay in
// fullscreen if that's where they already were. Module scope so CameraTile (which sets it)
// and LiveMonitor's PiP-mode listener (which acts on it) can share one flag.
let pipAutoEnteredFullscreen = false;
export function setPipAutoEnteredFullscreen(v) {
  pipAutoEnteredFullscreen = !!v;
}
export function didPipAutoEnterFullscreen() {
  return pipAutoEnteredFullscreen;
}

// Capacitor's addListener returns either a Promise<PluginListenerHandle> or, depending on the
// Capacitor/plugin version, the handle itself synchronously. Promise.resolve normalises both,
// so tearing a listener down never throws ".then is not a function" - which matters because
// these unsubscribes run inside React effect cleanups (e.g. when a camera tile unmounts on
// disable/remove), where an uncaught throw takes down the whole app.
function removeListener(handleOrPromise) {
  Promise.resolve(handleOrPromise).then((h) => h?.remove?.()).catch(() => {});
}

// Native Android PiP enter/leave. The web app uses this to hide the on-video overlay
// buttons (mute/settings/fullscreen) while floating - they only waste space in the tiny
// window. Returns an unsubscribe fn; no-op off-native.
export function onPipModeChanged(callback) {
  const p = pipPlugin();
  if (!p) return () => {};
  const handlePromise = p.addListener('pipModeChanged', ({ isInPip }) => callback(!!isInPip));
  return () => {
    removeListener(handlePromise);
  };
}

// --- Background-audio pause/resume (shared control surface) ---
// The Android notification's Pause/Resume button and iOS's Now Playing controls both
// funnel through here, so a single app-wide flag mutes/unmutes every Background-mode tile
// consistently no matter which system UI triggered it. Muting (not disconnecting) means
// resume is instant and the stream never drops.
let bgPaused = false;
const bgPauseSubs = new Set();

export function isBackgroundPaused() {
  return bgPaused;
}

export function setBackgroundPaused(paused) {
  const next = !!paused;
  if (next === bgPaused) return;
  bgPaused = next;
  bgPauseSubs.forEach((cb) => {
    try {
      cb(bgPaused);
    } catch {
      // A bad subscriber shouldn't stop the others from updating.
    }
  });
  // Keep the web Media Session's playback state in sync - this is what drives the iOS
  // Now Playing controls' play/pause glyph (and any other system media UI).
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = bgPaused ? 'paused' : 'playing';
    } catch {
      // Not all engines allow setting this - non-fatal.
    }
  }
}

export function subscribeBackgroundPaused(callback) {
  bgPauseSubs.add(callback);
  return () => bgPauseSubs.delete(callback);
}

// Android notification Pause/Resume taps (see AudioService.kt / BackgroundAudioPlugin.kt).
// Returns an unsubscribe fn; no-op off-native.
export function onBackgroundPauseChanged(callback) {
  const p = plugin();
  if (!p) return () => {};
  const handlePromise = p.addListener('pauseChanged', ({ paused }) => callback(!!paused));
  return () => {
    removeListener(handlePromise);
  };
}

// Enter native Android Activity Picture-in-Picture (floats the whole app window). The web
// <video> PiP API isn't supported in Android's WebView, so this is how the PiP button
// works there (see PipPlugin.kt in nightlight-mobile). Returns true only if PiP actually
// started; returns false - so the caller can fall back to the web PiP API - in a browser,
// or on any platform without the native Pip plugin (e.g. the iOS shell, which has no
// equivalent yet).
export async function enterNativePip() {
  const p = pipPlugin();
  if (!p) return false;
  try {
    const { entered } = await p.enter();
    return !!entered;
  } catch (err) {
    console.warn('Pip.enter failed', err);
    return false;
  }
}

// Tell the native shell whether to auto-enter PiP when the user leaves the app (Home / app
// switch). Enabled only while the live camera view is actually on screen, so leaving from
// a management page just backgrounds normally. No-op off-native or without the plugin.
export async function setAutoPictureInPicture(enabled) {
  const p = pipPlugin();
  if (!p) return;
  try {
    await p.setAutoEnter({ enabled: !!enabled });
  } catch (err) {
    console.warn('Pip.setAutoEnter failed', err);
  }
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
    removeListener(handlePromise);
  };
}
