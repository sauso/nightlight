// Stops the page behind an open dialog from scrolling (#376, the last item of that issue).
//
// WHY A COUNT. Dialogs chain (the two-factor flow replaces one dialog with the next) and can nest (a confirmation
// over a form), so "lock on open, unlock on close" with a flag would unlock under a dialog that is still open,
// or leave the page locked after the last one closes. Same shape as reloadGuard.js: each lockScroll() returns its
// own release, which is safe to call twice, and the page is locked while at least one release is outstanding.
//
// WHICH ELEMENT. The VIEWPORT is what scrolls here: html, body and #root are all `height: 100dvh` with
// `.app-shell` taller than that, and usePullToRefresh reads window.scrollY. `overflow: hidden` on <html> propagates
// to the viewport, which freezes the page where it is. The `position: fixed` body trick is deliberately NOT used:
// it resets the scroll position on unlock and would break pull-to-refresh's scrollY test.
//
// THE SCROLLBAR. Hiding a classic (desktop) scrollbar makes the page jump sideways by its width. The width that
// disappears is measured BEFORE the class is added and put back as padding on <html>; it is 0 on phones, whose
// scrollbars overlay the page.
//
// KNOWN LIMIT (not measured on a real iPhone): iOS Safari can still rubber-band the page behind an
// `overflow: hidden` root. The dialog card scrolls itself (overflow-y: auto), and html, body and #root already set
// `overscroll-behavior-y: contain` (index.css), which keeps the bounce from chaining into a reload.
const LOCK_CLASS = 'modal-scroll-locked';
let locks = 0;

export function lockScroll() {
  const root = document.documentElement;
  if (locks === 0) {
    const bar = Math.max(0, window.innerWidth - root.clientWidth);
    root.style.paddingRight = bar ? `${bar}px` : '';
    root.classList.add(LOCK_CLASS);
  }
  locks += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks -= 1;
    if (locks === 0) {
      root.classList.remove(LOCK_CLASS);
      root.style.paddingRight = '';
    }
  };
}
