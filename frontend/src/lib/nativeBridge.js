// Bridge between the web app and the native Android shell (Capacitor).
//
// Safe to import everywhere: in a normal browser every function is a no-op,
// so the web app behaves exactly as before. Only inside the Capacitor
// WebView does isNativeApp() return true and the plugin calls do anything.
import { api, getToken } from './api.js';

// Tracks which cameras are currently in Background listening mode across the
// whole app. The foreground service is a single app-wide thing, so we start
// it when the first camera enters background mode, retitle its notification
// as the set changes, and stop it when the last camera leaves.
const activeCameras = new Map(); // camera.id -> camera.name

export function isNativeApp() {
  return !!window.Capacitor?.isNativePlatform?.();
}

// Whether this native build can actually export a file at all — true if either the Android Download
// plugin OR the Filesystem+Share pair is registered. The web UI loads live from the server, so an old
// installed app can be running newer web code that calls an export the app was built without: iOS
// sideloads from before @capacitor/filesystem + @capacitor/share were added (≤ v0.7.2) have neither,
// so nothing here can save a file until the app itself is updated. Lets callers say "update the app"
// instead of a generic "couldn't save". Always true in a browser (it uses a normal blob download).
export function hasFileExport() {
  if (!isNativeApp()) return true;
  const P = window.Capacitor?.Plugins || {};
  return !!P.Download || (!!P.Filesystem && !!P.Share);
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

// --- Switching server from an alert or link (#559) ---
// An alert or link can name the server it came from, so tapping a prod alert while the app shows a staging
// copy opens prod. That name arrives from OUTSIDE the app, so it is only ever a REQUEST: the app switches
// only to a server already in this phone's saved list (ServerConfig.list(), the same list the setup screen
// shows), and only after the person taps Switch. An address that is not on the list is refused, with no
// offer to add it from here: adding a server stays a deliberate step on the setup screen.
//
// ⚠️ The saved list is a FILTER, not a list of servers someone vetted: older app versions added a server to it
// whenever one answered its health check. So every switch still asks, and the docs tell people to review
// their saved servers (the setup screen has a ✕ to forget one).

// The one shape of address accepted from a request: scheme, host and optional port, at most one trailing
// slash. Mirrors the server's normalizeBaseUrl (backend/src/lib/push.js), which builds the address the
// server's own links carry, and for the same reason it checks the RAW string BEFORE `new URL()`: the WHATWG
// parser quietly turns `https:\\host`, `https://host?`, `https://user@host` or a tab inside the host into a
// clean origin, so validating only what it returns would accept all of them. No `@`, `/`, `?`, `#`, `\` or
// whitespace can get through the host part, which rules out credentials, paths, queries and fragments in one
// place. A non-ASCII host is refused (its punycode `xn--` form is accepted): window.location.origin and the
// server's links are always the punycode form, so nothing legitimate is lost.
const REQUEST_ORIGIN_SHAPE = /^https?:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?\/?$/i;
// The server's bound too: a maximum-length DNS name is 253 characters, so this only bounds hostile input.
const MAX_ORIGIN_LENGTH = 255;

// The canonical form of an address, or null when it is not a plain http(s) origin. Canonical = what
// `new URL().origin` gives: lower-case scheme and host, default port dropped (`:443` on https), no trailing
// slash. A trailing dot is NOT stripped and http and https are different origins, so `https://host.` and
// `http://host` never equal `https://host`. Compare the results with ===, nothing looser.
export function canonicalOrigin(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_ORIGIN_LENGTH) return null;
  if (!REQUEST_ORIGIN_SHAPE.test(s)) return null;
  try {
    // `new URL` still rejects what the pattern cannot: a port above 65535, an impossible IPv6 literal.
    return new URL(s).origin;
  } catch {
    return null;
  }
}

// The entry in this phone's saved-server list that IS `target` (already canonical), or null. Returns the
// stored string itself, exactly as the app saved it, so a switch hands the native side its own value and
// never a string that came from the request. An entry that is not a plain origin (or a list that cannot be
// read: an old app, iOS without the method) matches nothing, which refuses rather than guesses.
async function savedServerFor(target) {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p || !target) return null;
  try {
    const res = await p.list();
    const servers = Array.isArray(res?.servers) ? res.servers : [];
    return servers.find((s) => typeof s === 'string' && canonicalOrigin(s) === target) || null;
  } catch {
    return null;
  }
}

// The address the server on screen gives out in its own links (GET /api/about `publicBaseUrl`, learned from an
// admin's phone; docs/notifications.md "Where tapping an alert opens"). A household can reach one server by two
// addresses (one at home, one over the internet), and those links carry only the one the server learned last,
// so a phone that saved the other address would otherwise be asked to "switch" to the server it is already on.
// Asked of the TRUSTED server already loaded, never of the address in the request. Only with a sign-in token
// (the route needs one, and a request without it would only fail); any failure means "no advertised address".
async function advertisedOrigin() {
  try {
    if (!getToken()) return null;
    // A short deadline (Opus review of #862): when the server on screen is not answering (a phone off home Wi-Fi still
    // pointed at a LAN address), this is the lookup the dialog waits on, and the default 30 s made it appear half a
    // minute late. No answer in 3 s just means "no advertised address", and the request is judged on the saved list.
    const about = await api.get('/about', { timeoutMs: 3000 });
    return canonicalOrigin(about?.publicBaseUrl);
  } catch {
    return null;
  }
}

// The addresses the phone has saved FOR THE SERVER IN USE, canonical: the one it was set up with, and the Tailscale one the
// server told it about (see syncTailscaleEndpoint). The page may be on either, depending on where the phone is, so a link
// that names the other one is the same server, not a request to switch. An older shell has no `tailscale` field and a
// list that cannot be read gives []: both just mean "no extra address".
async function ownAddresses() {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p) return [];
  try {
    const res = await p.list();
    return [res?.active, res?.tailscale].map((value) => canonicalOrigin(value)).filter(Boolean);
  } catch {
    return [];
  }
}

// What is showing: null, or { id, kind: 'confirm' | 'refused' | 'tailscale-added', origin, entry }. `origin` is the canonical
// origin (all the dialog ever shows, never a full URL); `entry` is the saved-list string a confirm would switch
// to. Read through useSyncExternalStore by components/ServerSwitchPrompt.jsx, mounted once at the app root.
let serverPrompt = null;
const serverPromptSubs = new Set();
// Each request takes a number; only the newest may still change what shows. The checks below wait on two
// lookups, so without this an older request whose lookups finished last would replace the newer one's dialog.
let serverRequestSeq = 0;

function setServerPrompt(next) {
  serverPrompt = next;
  serverPromptSubs.forEach((cb) => { try { cb(); } catch { /* one bad subscriber must not stop the rest */ } });
}

export function getServerSwitchPrompt() {
  return serverPrompt;
}

export function subscribeServerSwitchPrompt(callback) {
  serverPromptSubs.add(callback);
  return () => serverPromptSubs.delete(callback);
}

// Stay, OK, ✕, Escape or a tap outside: close the dialog and change nothing. Only the dialog with this id, so
// a late close from a dialog that a newer request has already replaced cannot close the new one.
export function dismissServerSwitchPrompt(id) {
  if (serverPrompt && serverPrompt.id === id) setServerPrompt(null);
}

// Switch, from the confirm dialog with this id. switchServer checks the saved list again itself, so a server
// forgotten while the dialog was open is refused here too. Returns switchServer's answer.
//
// One Switch at a time (Codex review of #862): two calls in flight both passed the checks and each ran save() and
// restart(). The dialog's button is disabled while it is busy, but the guarantee belongs here, with the function that
// acts, not in a button.
let confirming = false;
export async function confirmServerSwitch(id) {
  const prompt = serverPrompt;
  if (confirming || !prompt || prompt.id !== id || prompt.kind !== 'confirm') return false;
  confirming = true;
  try {
    return await switchServer(prompt.entry);
  } finally {
    confirming = false;
  }
}

// Close whatever dialog is showing, whichever it is. For a caller that is about to carry on in place and so
// supersedes it (a tapped alert that names no other server): newest wins, and Stay must then leave the person where
// that newest tap put them, not under a dialog about an older one.
export function closeServerSwitchPrompt() {
  setServerPrompt(null);
}

// Handle a request to open another server, from a tapped alert or link. Returns what happened, so the caller
// knows whether a dialog is now in charge:
//   'same'        - it names the server on screen (or the address that server gives out): nothing to ask, the
//                   caller opens the screen in place, as before.
//   'invalid'     - not a plain http(s) origin: ignored, nothing switches, the caller opens in place.
//   'unavailable' - not in the native app: there is no other server to switch to.
//   'asked'       - the server is in the saved list: the confirm dialog is showing; only Switch changes server.
//   'refused'     - it is not: the refusal dialog is showing, with a single OK.
//   'superseded'  - a newer request arrived while this one was being checked; that one decides.
// Nothing here contacts the requested address. The only lookups are the phone's own saved list and the server
// already on screen; the native save() that tests the new server's health runs only after Switch.
// The newest request wins, so it also replaces (or, when it needs no dialog, closes) any dialog still open.
export async function requestServerSwitch(raw) {
  const seq = ++serverRequestSeq;
  const target = canonicalOrigin(raw);
  if (!target) { setServerPrompt(null); return 'invalid'; }
  if (target === canonicalOrigin(currentServerOrigin())) { setServerPrompt(null); return 'same'; }
  if (!window.Capacitor?.Plugins?.ServerConfig) { setServerPrompt(null); return 'unavailable'; }
  const [advertised, entry, own] = await Promise.all([advertisedOrigin(), savedServerFor(target), ownAddresses()]);
  if (seq !== serverRequestSeq) return 'superseded';
  if (advertised && advertised === target) { setServerPrompt(null); return 'same'; }
  // The server in use has two addresses on this phone (home and Tailscale): naming either is naming itself.
  if (own.includes(target)) { setServerPrompt(null); return 'same'; }
  setServerPrompt(entry ? { id: seq, kind: 'confirm', origin: target, entry } : { id: seq, kind: 'refused', origin: target });
  return entry ? 'asked' : 'refused';
}

// --- The server's Tailscale address, for use away from home (owner, 2026-11-06) ---
// The phone opens the address it was set up with, and falls back to the server's Tailscale address when that one does not
// answer (MainActivity, EndpointChooser). The server tells the phone that address: GET /api/remote-access/tailscale/address,
// which any signed-in user may read. This asks once per start and passes the answer to the native shell, which does the
// checking (same server id, `https://<name>.ts.net` only) and the saving:
//   { url: "https://x.ts.net" } -> addEndpoint; the person is told once, the first time it is saved;
//   { url: null }               -> removeEndpoint: the server no longer offers one (Tailscale turned off there);
//   anything else (409 "not known right now", an older server's 404, no network, an odd body) -> nothing changes. The server
//   sends null ONLY for "definitely not available", so a daemon restart can never erase a saved address.
// Does nothing in a browser, in an app built before the feature (no addEndpoint; both the Android and the iOS shell have it since
// 2026-11), or when signed out. Never throws.
// Returns what happened, for tests: 'added' | 'unchanged' | 'removed' | 'none' | null.
// The Tailscale address THIS page's own server offered on the last successful ask, or null (none offered, or the ask failed). A
// saved sign-in carries it (saveNativeSession), so the app binds the token to that address only when it is the one the server
// itself named: addEndpoint can be called by a page at the saved address, so an address another page planted must never be the
// one a real sign-in is bound to (Opus review of the code). Per page load, like everything in this module.
// It belongs to the sign-in whose request fetched it (`offeredFor`): after a sign-out and a new sign-in in the same page load the
// old answer is never reused for the new token, or an address another page planted before the sign-out could be stamped onto a
// real sign-in that is saved before its own sync has run (Astra review of the code).
let offeredTailscaleUrl = null;
// The kind is learned from the new endpoint only when the shell advertises support. A custom address is never a session binding.
let offeredKind = null;
let offeredFor = null;

// What the last ask ended in, so the About page can say WHY no Tailscale address is saved (owner, 2026-11-07: "Not saved" was a
// dead end). One of: 'saved' | 'server-none' (the server says it has none) | 'unknown' (the server could not say: 409, an older
// server's 404, no network, an odd body) | 'unreachable' | 'different' | 'refused' (the shell said no, see classifyAddRefusal) |
// null (not asked in this page load, or signed out). Per page load, like offeredTailscaleUrl; getConnectionRoute only reports it
// while nothing is saved, so a failed re-ask can never hide an address that IS saved.
let tailscaleOutcome = null;

// Why the shell refused to save the address, from the sentence it rejected with (ServerConfigPlugin.refusal, in nightlight-mobile).
// Matching the wording couples the two repos, so the failure mode is chosen: a reworded or unrecognised sentence is 'refused',
// whose text is generic and never names a cause the shell did not give. "Couldn't reach" is the usual real cause: the address
// answers only while the PHONE is on Tailscale, and addEndpoint probes it from the phone.
export function classifyAddRefusal(err) {
  const message = typeof err?.message === 'string' ? err.message : '';
  if (/couldn'?t reach/i.test(message)) return 'unreachable';
  if (/different server/i.test(message)) return 'different';
  return 'refused';
}

// The ask in progress, if any. getConnectionRoute waits for it, so About opened while the start-up ask is still running shows its
// result, not the state from before it (Codex review of the code: About reads once and would otherwise stay stale).
let syncInFlight = null;

export async function syncTailscaleEndpoint() {
  const run = askForTailscaleAddress();
  syncInFlight = run;
  try {
    return await run;
  } finally {
    if (syncInFlight === run) syncInFlight = null;
  }
}

async function askForTailscaleAddress() {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p || typeof p.addEndpoint !== 'function' || typeof p.removeEndpoint !== 'function') { tailscaleOutcome = null; return null; }
  if (!getToken()) { tailscaleOutcome = null; return null; }
  let url;
  let kind = 'tailscale';
  let supportsCustomUrl = false;
  const asAToken = getToken();
  // The outcome belongs to the sign-in that asked: an ask that finishes after a sign-out (and perhaps a new sign-in) must not write
  // its result over the new session's state (Codex review of the code), the same rule offeredFor follows.
  const note = (outcome) => { if (getToken() === asAToken) tailscaleOutcome = outcome; };
  try {
    // A short deadline: this runs at every start and must never hold anything up. No answer just means "no change".
    if (typeof p.get === 'function') {
      try { supportsCustomUrl = (await p.get())?.supportsCustomUrl === true; }
      catch { /* An older shell may not answer get(); use its existing endpoint. */ }
    }
    const res = await api.get(supportsCustomUrl ? '/remote-access/address' : '/remote-access/tailscale/address', { timeoutMs: 5000 });
    url = res?.url;
    kind = supportsCustomUrl ? res?.kind : 'tailscale';
  } catch {
    offeredTailscaleUrl = null; // nothing is known about what the server offers right now
    offeredKind = null;
    offeredFor = null;
    note('unknown');
    return null;
  }
  offeredTailscaleUrl = typeof url === 'string' && kind === 'tailscale' ? url : null;
  offeredKind = typeof url === 'string' && (kind === 'custom' || kind === 'tailscale') ? kind : null;
  offeredFor = asAToken;
  note(url === null ? 'server-none' : 'unknown'); // anything but a string or null is an odd body: not known
  try {
    if (typeof url === 'string' && offeredKind) {
      const res = await p.addEndpoint(supportsCustomUrl ? { url, kind } : { url });
      note('saved');
      if (res?.added === true) {
        if (kind === 'tailscale') announceTailscaleAdded();
        return 'added';
      }
      return 'unchanged';
    }
    if (url === null) {
      const res = await p.removeEndpoint();
      return res?.removed === true ? 'removed' : 'none';
    }
  } catch (err) {
    // The shell refused (not this server's page, the address did not answer or is another server): it can be tried again
    // at the next start. The person can act on it only if told why, which is the About page's Connection card.
    if (typeof url === 'string') note(classifyAddRefusal(err));
    console.warn('Secure address not saved', err);
  }
  return null;
}

// Which of the server's addresses this phone is using right now, and whether a Tailscale address is saved, for the About page
// (owner, 2026-11-06: there was no way to SEE that the Tailscale address was saved, or which address a session is on).
//   via: 'tailscale' - the page is on the saved Tailscale address;
//        'saved'     - the page is on the address the app was set up with;
//        'other'     - neither (an unexpected state; shown without a name rather than guessed).
//   tailscaleSaved   - a Tailscale address is stored for this server.
//   address          - its host (e.g. `x.ts.net`, no scheme), or null when none is saved. Shown on About (owner, 2026-11-07).
//   why              - when none is saved: the outcome of this page load's ask (see tailscaleOutcome), else null. Never set while
//                      an address is saved: a failed re-ask does not unsave it.
// null when this is not a shell with the Tailscale feature (a browser, an app built before it): nothing is shown then. The Android
// and iOS shells both have it; the feature is detected by the shell's methods, never by platform.
// Comparisons use the canonical origin, like every other address check here. Never throws.
export async function getConnectionRoute() {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p || typeof p.addEndpoint !== 'function' || typeof p.get !== 'function') return null;
  if (syncInFlight) await syncInFlight.catch(() => {}); // the ask may be about to save the address p.get() reports
  let res;
  try {
    res = await p.get();
  } catch {
    return null;
  }
  const here = canonicalOrigin(currentServerOrigin());
  const saved = canonicalOrigin(res?.url);
  const tailscale = canonicalOrigin(res?.tailscale);
  let via = 'other';
  if (here && tailscale && here === tailscale) via = 'tailscale';
  else if (here && saved && here === saved) via = 'saved';
  let address = null;
  if (tailscale) {
    try { address = new URL(tailscale).host; } catch { address = null; }
  }
  return { via, tailscaleSaved: Boolean(tailscale), address, why: tailscale ? null : tailscaleOutcome, kind: offeredKind };
}

// --- One sign-in across the server's two addresses (owner, 2026-11-06) ---
// The saved address and the Tailscale address are different web origins, each with its own localStorage, so a person had to sign
// in on each. The Android app can also keep the session token, encrypted, in its own storage (ServerConfig.saveSession /
// getSession / clearSession; ServerConfigPlugin.kt, SessionRules.kt) and hand it ONLY to the page that is the saved Tailscale
// address, after checking it is the same server. The iOS app does the same in the Keychain (ServerConfigPlugin.swift,
// SessionRules.swift; added in the 2026-11 iPhone release): the feature is switched on by the shell having all three methods,
// never by platform. These three wrap those calls. Every one does nothing in a browser or in an app without the methods (an
// older app), and NEVER throws: a failure here must never get in the way of signing in or out.
// WHY 6 s: the app first reads the page, then asks the page's own server for its id (up to 3 s to connect and 3 s to answer, over a
// relayed Tailscale link on cellular), then decrypts. 2 s gave up on exactly the slow link this feature is for, and showed the
// sign-in form (Opus review; the timing is reasoned, not measured on a phone). `loading` holds the screen for at most this long.
const SESSION_ADOPT_DEADLINE_MS = 6000;

function sessionPlugin() {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  return p && typeof p.saveSession === 'function' && typeof p.getSession === 'function' && typeof p.clearSession === 'function' ? p : null;
}

// Keep this token for the other address. Called after a sign-in, and again once the Tailscale address is known (the app stamps
// each saved token with the addresses in force when it is saved, so a first sign-in is saved again after that).
export async function saveNativeSession(token) {
  const p = sessionPlugin();
  if (!p || typeof token !== 'string' || !token) return false;
  try {
    // Only a Tailscale offer can bind a saved sign-in. A custom domain gets its own sign-in because its ownership can change.
    // null also means no address is known, so the app binds the token to no Tailscale address until a later save.
    const res = await p.saveSession({ token, tailscale: offeredFor === token ? offeredTailscaleUrl : null });
    return res?.saved === true;
  } catch {
    return false;
  }
}

// Ask for the saved token, for a page that has none. The app answers `{ token }` only to the saved Tailscale address and for
// every other page says `{ token: null }`. A string comes back, or null. A deadline: signing in must not wait on a slow check.
export async function adoptNativeSession() {
  const p = sessionPlugin();
  if (!p) return null;
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), SESSION_ADOPT_DEADLINE_MS); });
    const answer = await Promise.race([p.getSession(), timeout]);
    return typeof answer?.token === 'string' && answer.token ? answer.token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Forget the saved token: a sign-out passes none (it clears whatever is saved); a 401 passes the token the server rejected, so only
// that exact token is dropped and a newer saved sign-in survives.
export async function clearNativeSession(token) {
  const p = sessionPlugin();
  if (!p) return false;
  try {
    await p.clearSession(typeof token === 'string' && token ? { token } : {});
    return true;
  } catch {
    return false;
  }
}

// Tell the person, once, that the phone will now also use the Tailscale address. Only when nothing else is asking: it never
// replaces or closes a switch-server dialog.
// "Once" is once per web address (the flag is in this page's localStorage, which is per origin). The phone forgets a server's
// Tailscale address on Change server (by design: it belongs to the server being left), so switching away and back learns it
// again and the app reports "added" every time; without this flag the message came back on every switch (owner, 2026-11-06).
const TAILSCALE_ANNOUNCED_KEY = 'nightlight_tailscale_announced';
function announceTailscaleAdded() {
  if (serverPrompt) return;
  try {
    if (localStorage.getItem(TAILSCALE_ANNOUNCED_KEY)) return;
    localStorage.setItem(TAILSCALE_ANNOUNCED_KEY, '1'); // set only when it is about to be shown, so a busy moment does not use it up
  } catch {
    // Storage refused: show it rather than never telling anyone.
  }
  setServerPrompt({ id: ++serverRequestSeq, kind: 'tailscale-added', origin: null, entry: null });
}

// The window event the native shell fires when it is holding a server request from a tapped link, for an app
// that is already open. A cold start fires nothing (the page was not loaded yet), so the app also asks once on
// load; components/ServerSwitchPrompt.jsx does both.
export const SERVER_REQUEST_EVENT = 'nightlightServerRequest';

// Collect the request the native shell is holding, if any (ServerConfig.takePending() -> { server | null },
// which also clears it, so a request is handled once), and handle it like any other. iOS and app versions from
// before this change have no takePending and reject: that is "nothing pending", never an error on screen.
// A link opens the app where it already was, so 'same' needs nothing further here.
export async function takePendingServerRequest() {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p) return null;
  let server = null;
  try {
    const res = await p.takePending();
    server = typeof res?.server === 'string' ? res.server : null;
  } catch {
    return null;
  }
  if (!server) return null;
  return requestServerSwitch(server);
}

// Switch the native shell to a DIFFERENT server that is ALREADY in this phone's saved list, and reboot into
// it. Called only from the confirm dialog's Switch (confirmServerSwitch). The saved-list check is HERE, inside
// the one function that switches, so no caller, present or future, can switch to an address the phone does
// not know, and it hands save() the saved entry's own string, never the caller's. Like changeServer, tears
// down all playback + the background-audio service first so the old server's audio doesn't survive the
// switch. save() re-validates the address (/api/health) and rejects if unreachable, in which case we stay
// put. Returns whether the switch was initiated (false if not native, not a plain origin, same server, not in
// the saved list, or validation failed).
export async function switchServer(rawUrl) {
  const p = window.Capacitor?.Plugins?.ServerConfig;
  if (!p || !rawUrl) return false;
  const target = canonicalOrigin(rawUrl);
  if (!target) return false; // only plain http(s) origins
  if (target === canonicalOrigin(currentServerOrigin())) return false; // already here — caller navigates in place
  const entry = await savedServerFor(target);
  if (!entry) return false; // not a server this phone has saved: refuse, before anything is torn down
  // save() BEFORE the teardown (Opus review of #862): it tests the new server and rejects when it is unreachable, and a
  // person who taps Switch and gets "could not reach it" must still have the app exactly as it was, listening
  // included. With the teardown first, a failed save had already stopped background listening and blanked the
  // players while the camera tiles still said it was on. save() only stores the address; restart() below is what
  // actually changes server, so tearing down between the two still runs before anything is reloaded.
  try {
    await p.save({ url: entry }); // rejects if unreachable — leaves the active server untouched
  } catch (err) {
    console.warn('switchServer failed', err);
    return false;
  }
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

// Fullscreen otherwise leaves Android's status and gesture bars painted over the camera
// controls (owner screenshots, 11-01). The live web UI also reaches older APKs and iOS,
// so only a native build with the matching plugin may change the system bars.
export async function setNativeImmersive(enabled) {
  const immersive = window.Capacitor?.Plugins?.Immersive;
  if (!isNativeApp() || !immersive) return false;
  try {
    await immersive.setEnabled({ enabled });
    return true;
  } catch (err) {
    console.warn('Immersive.setEnabled failed', err);
    return false;
  }
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
// controls and panels while floating - they only waste space in the tiny
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
