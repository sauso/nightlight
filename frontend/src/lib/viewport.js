// Page zoom: allowed in a browser, locked in the native app (#562 bullet 3, owner decision 2026-10-13).
//
// index.html ships the LOCKED viewport (`maximum-scale=1, user-scalable=no`), because the native Android app
// needs it: double-tapping its picture-in-picture window zoomed the whole app and left it stuck until a
// restart. That string is the safe default, what the native shell gets if this code never runs. But it also
// stopped everyone in an ordinary browser from pinch-zooming the page (WCAG 1.4.4, resize text), for a bug
// that only the native shell has. So at start, outside the native app, the two locking tokens are removed
// and the browser's own zoom comes back.
//
// ⚠️ ONLY THOSE TWO TOKENS. `width`, `initial-scale`, `viewport-fit=cover` (the safe-area insets depend on it)
// and anything else are kept verbatim and in order; only the separators are normalised to ", ".
//
// Known effects outside the native app, stated rather than discovered:
//  - iOS Safari already ignored `user-scalable=no` for pinch (since iOS 10), so pinch-zoom there is unchanged.
//    Removing `maximum-scale=1` does, however, let iOS Safari zoom in on a focused field whose text is under
//    16px (the app's fields are 15px, docs/design-language.md "Fields"). Expected from WebKit's documented
//    behaviour; not checked on a device.
//  - A home-screen install (PWA) is a browser, not the native app, so it becomes zoomable too. The PiP bug was
//    the native shell's own picture-in-picture window; a browser's PiP shows only the video element.
import { isNativeApp } from './nativeBridge.js';

// The tokens that lock page zoom. Matched on the name before `=`, trimmed and lower-cased, so `Maximum-Scale = 1`
// is caught and `minimum-scale` or `initial-scale` (which share the "-scale" suffix) are not.
const LOCKING = new Set(['maximum-scale', 'user-scalable']);

/**
 * The viewport `content` with the zoom-locking tokens removed. Browsers accept `,` and `;` between tokens.
 * @param {string} content
 * @returns {string}
 */
export function relaxedViewportContent(content) {
  return String(content)
    .split(/[,;]/)
    .map((token) => token.trim())
    .filter((token) => token && !LOCKING.has(token.split('=')[0].trim().toLowerCase()))
    .join(', ');
}

/**
 * Relax the viewport meta outside the native app; leave it exactly as shipped inside it. Idempotent, and a
 * page without a viewport meta is left alone. Returns whether anything changed.
 *
 * @param {Document} [doc]
 * @param {boolean} [native]  whether this is the Capacitor shell (nativeBridge.isNativeApp())
 */
export function applyViewportPolicy(doc = document, native = isNativeApp()) {
  // Native: the lock IS the fix for the PiP double-tap bug, so nothing is touched, not even the separators.
  if (native) return false;
  let changed = false;
  // Only the viewport meta: another meta (a description that happens to mention these words) is not ours.
  for (const meta of doc.querySelectorAll('meta[name="viewport"]')) {
    const before = meta.getAttribute('content') ?? '';
    const after = relaxedViewportContent(before);
    if (after !== before) {
      meta.setAttribute('content', after);
      changed = true;
    }
  }
  return changed;
}
