// Page zoom: allowed in a browser, locked in the native app (#562 bullet 3, owner decision 2026-10-13).
//
// index.html ships the LOCKED viewport (`maximum-scale=1, user-scalable=no`), because the native Android app
// needs it: double-tapping its picture-in-picture window zoomed the whole app and left it stuck until a
// restart. That string is the safe default, what the native shell gets if this code never runs. But it also
// stopped everyone in an ordinary Android or desktop browser from pinch-zooming the page (WCAG 1.4.4, resize
// text), for a bug that only the native shell has. So at start, outside the native app, the locking tokens
// are removed and the browser's own zoom comes back.
//
// ⚠️ WHICH TOKENS, BY PLATFORM (owner decision 2026-10-13, after the first build of this change):
//  - Android and desktop browsers: both `maximum-scale` and `user-scalable` go. Chrome honours either one,
//    so keeping one would keep the page locked there.
//  - iOS/iPadOS browsers (Safari, and Chrome or Firefox on iOS, which are WebKit too): only `user-scalable`
//    goes and `maximum-scale=1` stays. WebKit has ignored both for PINCH-zoom since iOS 10, so pinch already
//    worked there and removing `maximum-scale` buys nothing. What `maximum-scale=1` still does in WebKit is
//    stop Safari zooming the page in when a field whose text is under 16px is focused, and the app's fields
//    are 15px (docs/design-language.md "Fields"): without it, every tap into a field made the page jump.
//    Expected from WebKit's documented behaviour; not checked on a device.
//  - Everything else (`width`, `initial-scale`, `viewport-fit=cover`, which the safe-area insets depend on) is
//    kept verbatim and in order; only the separators are normalised to ", ". Separators are read the way
//    Blink and WebKit read them: a comma, a semicolon OR whitespace (`width=device-width maximum-scale=1` is two
//    settings to a browser), with spaces allowed around `=` (fix round 1: a comma-only split left a
//    space-separated lock in place).
//
// A home-screen install (PWA) is a browser, not the native app, so it follows the browser rules. The PiP bug was
// the native shell's own picture-in-picture window; a browser's picture-in-picture is its own video window, not
// the page.
import { isNativeApp } from './nativeBridge.js';

// The tokens that lock page zoom. Matched on the whole name before `=`, lower-cased, so `Maximum-Scale = 1` is
// caught and `minimum-scale` or `initial-scale` (which share the "-scale" suffix) are not.
const LOCKING = new Set(['maximum-scale', 'user-scalable']);
// An iOS browser loses only `user-scalable`: see the header for why `maximum-scale=1` stays there.
const LOCKING_IOS = new Set(['user-scalable']);

/**
 * Whether this is a browser on iOS or iPadOS (every iOS browser is WebKit, so they all behave alike here).
 *
 * The user agent names the device on iPhone, iPod and older iPads. ⚠️ iPadOS 13+ Safari reports a MAC user
 * agent ("Macintosh; Intel Mac OS X") by default, so the UA alone misses every current iPad. The tell is a
 * "Mac" with a touch screen: `platform` is 'MacIntel' and `maxTouchPoints` is above 1 (a real Mac reports 0).
 *
 * @param {{ userAgent?: string, platform?: string, maxTouchPoints?: number }} [nav]
 */
export function isIosBrowser(nav = navigator) {
  if (!nav) return false;
  const ua = String(nav.userAgent || '');
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1;
}

// A separator between viewport settings: comma, semicolon or any whitespace, as in Blink's and WebKit's
// parser. (They also skip a stray `=` where a name should start; viewportTokens does too.)
const isSeparator = (c) => c === ',' || c === ';' || /\s/.test(c);

/**
 * Split a viewport `content` into its settings, each as { name (lower-cased), text (as written) }.
 * `a=1, b = 2;c=3 d` gives a=1, `b = 2`, c=3 and d. Empty settings are skipped.
 * @param {string} content
 */
export function viewportTokens(content) {
  const s = String(content);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    // Separators, and a stray `=` with no name before it (Blink treats `=` as a separator here).
    while (i < s.length && (isSeparator(s[i]) || s[i] === '=')) i += 1;
    if (i >= s.length) break;
    const start = i;
    while (i < s.length && !isSeparator(s[i]) && s[i] !== '=') i += 1;
    const name = s.slice(start, i);
    // Spaces are allowed around `=` (`maximum-scale = 1`), so look past them before deciding there is no value.
    let j = i;
    while (j < s.length && /\s/.test(s[j])) j += 1;
    if (s[j] === '=') {
      j += 1;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      while (j < s.length && !isSeparator(s[j])) j += 1;
      i = j;
    }
    // trim(): a `name =` with no value would otherwise keep the spaces it looked past.
    tokens.push({ name: name.toLowerCase(), text: s.slice(start, i).trim() });
  }
  return tokens;
}

/**
 * The viewport `content` with the zoom-locking settings removed and the rest rejoined with ", ".
 * @param {string} content
 * @param {boolean} [ios]  an iOS browser: keep `maximum-scale` (see the header)
 * @returns {string}
 */
export function relaxedViewportContent(content, ios = false) {
  const drop = ios ? LOCKING_IOS : LOCKING;
  return viewportTokens(content)
    .filter((token) => !drop.has(token.name))
    .map((token) => token.text)
    .join(', ');
}

/**
 * Relax the viewport meta outside the native app; leave it exactly as shipped inside it. Idempotent, and a
 * page without a viewport meta is left alone. Returns whether anything changed.
 *
 * @param {Document} [doc]
 * @param {boolean} [native]  whether this is the Capacitor shell (nativeBridge.isNativeApp())
 * @param {boolean} [ios]     whether this is an iOS/iPadOS browser (isIosBrowser())
 */
export function applyViewportPolicy(doc = document, native = isNativeApp(), ios = isIosBrowser()) {
  // Native: the lock IS the fix for the PiP double-tap bug, so nothing is touched, not even the separators.
  if (native) return false;
  let changed = false;
  // Only the viewport meta: another meta (a description that happens to mention these words) is not ours.
  for (const meta of doc.querySelectorAll('meta[name="viewport"]')) {
    const before = meta.getAttribute('content') ?? '';
    const after = relaxedViewportContent(before, ios);
    if (after !== before) {
      meta.setAttribute('content', after);
      changed = true;
    }
  }
  return changed;
}
