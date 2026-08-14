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

// Base64-encode a UTF-8 string safely (btoa alone mangles multi-byte characters).
function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// Save a text file straight into the phone's public Downloads folder (native Download plugin) so
// it's easy to then upload to GitHub etc. On Android 10+ this needs no permission. Returns true on
// success, false in a browser / when the plugin is missing / on failure — so the caller can fall
// back to the share sheet (saveTextFile) or a web download.
export async function saveToDownloads(filename, text, mimeType = 'application/octet-stream') {
  const Download = window.Capacitor?.Plugins?.Download;
  if (!isNativeApp() || !Download) return false;
  try {
    await Download.saveToDownloads({ filename, data: utf8ToBase64(text), mimeType });
    return true;
  } catch (err) {
    console.warn('saveToDownloads (native) failed', err);
    return false;
  }
}

// Base64-encode a Blob's raw bytes (for binary files — a recorded clip — where utf8ToBase64 would
// corrupt the data). Reads via a data: URL and strips the "data:...;base64," prefix.
function base64FromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Save arbitrary BINARY data (e.g. a recorded video clip) straight into the phone's public Downloads
// folder via the native Download plugin, falling back to the Filesystem + Share sheet on older
// devices. Same reason as saveTextFile: the Android WebView can't do a browser-style <a download>.
// Returns true if the native app handled it, false in a browser so the caller can fall back to a
// normal blob/anchor download (which does work outside the WebView).
export async function saveBlobToDownloads(filename, blob, mimeType = 'application/octet-stream') {
  if (!isNativeApp()) return false;
  const data = await base64FromBlob(blob);
  const Download = window.Capacitor?.Plugins?.Download;
  if (Download) {
    try {
      await Download.saveToDownloads({ filename, data, mimeType });
      return true;
    } catch (err) {
      console.warn('saveBlobToDownloads (native download) failed', err);
    }
  }
  const Filesystem = window.Capacitor?.Plugins?.Filesystem;
  const Share = window.Capacitor?.Plugins?.Share;
  if (Filesystem && Share) {
    try {
      // No encoding => Capacitor writes the base64 as raw bytes. CACHE needs no permission.
      await Filesystem.writeFile({ path: filename, data, directory: 'CACHE' });
      const { uri } = await Filesystem.getUri({ path: filename, directory: 'CACHE' });
      try {
        await Share.share({ title: filename, files: [uri], dialogTitle: 'Save or share clip' });
      } catch (shareErr) {
        console.warn('Share dismissed/failed', shareErr);
      }
      return true;
    } catch (err) {
      console.warn('saveBlobToDownloads (share) failed', err);
    }
  }
  return false;
}

// Save a text file out of the app and hand it to the OS share sheet (Save to Files, email, etc.).
// The Android WebView can't do a browser-style blob/<a download> download — those silently do
// nothing — so exports like the diagnostics bundle have to go through the native Filesystem +
// Share plugins. Returns true if the native app handled it (so the caller does NOT also attempt a
// web download that can't work here), false in a browser / when the plugins aren't present so the
// caller can fall back to a normal blob download.
export async function saveTextFile(filename, text) {
  const Filesystem = window.Capacitor?.Plugins?.Filesystem;
  const Share = window.Capacitor?.Plugins?.Share;
  if (!isNativeApp() || !Filesystem || !Share) return false;
  try {
    // Cache dir needs no permission; the Share plugin exposes it via its own FileProvider.
    await Filesystem.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' });
    const { uri } = await Filesystem.getUri({ path: filename, directory: 'CACHE' });
    try {
      await Share.share({ title: filename, files: [uri], dialogTitle: 'Save or share diagnostics' });
    } catch (shareErr) {
      // User dismissed the share sheet (or a benign share error) — the file was still written and
      // offered, so treat it as handled rather than falling back to a download that can't work.
      console.warn('Share dismissed/failed', shareErr);
    }
    return true;
  } catch (err) {
    console.warn('saveTextFile (native) failed', err);
    return false;
  }
}

// True only in the native iOS app. Used to hide options that can't work there - e.g. Background
// audio in Compatibility (HLS) mode, which iOS suspends in the background (only Low latency's
// dedicated audio element survives). Returns false in a browser and in the Android app.
export function isIOS() {
  return window.Capacitor?.getPlatform?.() === 'ios';
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

// The origin the app is currently pointed at, normalised (no trailing slash) for comparison against
// a server address carried in a deep link / push. In the native shell this is the loaded server URL.
export function currentServerOrigin() {
  try {
    return window.location.origin.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// Switch the native shell to a DIFFERENT already-known-good server and reboot into it (used when a
// push/deep link from another Nightlight server than the one on screen is tapped — e.g. a prod alert
// while the app is showing dev). Like changeServer, tears down all playback + the background-audio
// service first so the old server's audio doesn't survive the switch. save() re-validates the
// address (/api/health) and rejects if unreachable, in which case we stay put. Returns whether the
// switch was initiated (false if not native, no URL, same server, or validation failed).
export async function switchServer(rawUrl) {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p || !rawUrl) return false;
  const target = String(rawUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(target)) return false; // only absolute http(s) origins
  if (target === currentServerOrigin()) return false; // already here — caller navigates in place
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
    await p.save({ url: target }); // rejects if unreachable — leaves the active server untouched
    await p.restart();
    return true;
  } catch (err) {
    console.warn('switchServer failed', err);
    return false;
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
    const label = names.length === 1 ? names[0] : 'Multiple Cameras';
    // Calling start while the service is already running just updates the
    // notification text - it does not restart anything.
    await p.start({ label });
  } catch (err) {
    // Native call failing shouldn't break audio in the WebView itself.
    console.warn('BackgroundAudio plugin call failed', err);
  }
}

// Subscribers notified when the SET of background-listening cameras changes (a camera joins or
// leaves). Lets the media session retitle itself - one camera shows its name, several show
// "Multiple Cameras" - reactively, since activeCameras is a plain Map, not React state.
const bgCameraSubs = new Set();
export function subscribeBackgroundCameras(callback) {
  bgCameraSubs.add(callback);
  return () => bgCameraSubs.delete(callback);
}
export function backgroundCameraCount() {
  return activeCameras.size;
}

// A command bus for background audio: the lock-screen / Now Playing Pause and Play broadcast to
// EVERY background-listening player, so all of them pause/resume together rather than just
// whichever one happens to own the media session. (iOS pauses the audio elements for real - see
// WhepPlayer - which is per-element, so a single owner couldn't stop the others on its own.)
const bgAudioCmdSubs = new Set();
export function subscribeBackgroundAudioCommand(callback) {
  bgAudioCmdSubs.add(callback);
  return () => bgAudioCmdSubs.delete(callback);
}
export function commandBackgroundAudio(paused) {
  bgAudioCmdSubs.forEach((cb) => { try { cb(!!paused); } catch { /* ignore */ } });
}

// Wipe the system media session (Now Playing / lock screen) so its tile disappears immediately
// once no camera is listening in the background any more. Without this, stopping the cameras left a
// stale "paused" tile behind whose Play button did nothing - the streams it referred to were gone.
// Clearing metadata + playbackState 'none' + the action handlers is what removes the tile.
export function clearNowPlaying() {
  setBackgroundPaused(false); // reset any lingering pause so the next background session starts clean
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    } catch {
      // Not every engine supports the full Media Session API - non-fatal.
    }
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
  const membershipChanged = activeCameras.size !== before;
  // Only touch the service when membership actually changed (or a label refresh came in).
  if (membershipChanged || enabled) syncService();
  // Retitle the media session only when the count crosses between one and several.
  if (membershipChanged) bgCameraSubs.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
  // The last background camera just left - tear the Now Playing tile down right away.
  if (membershipChanged && activeCameras.size === 0) clearNowPlaying();
}

// Fired when the person taps "Stop" on the Android notification. Tiles use
// this to drop themselves back from 'bg' to 'on'. Returns an unsubscribe fn.
export function onBackgroundStopped(callback) {
  const p = plugin();
  if (!p) return () => {};

  const handlePromise = p.addListener('stopped', () => {
    activeCameras.clear();
    clearNowPlaying();
    callback();
  });
  return () => {
    removeListener(handlePromise);
  };
}
