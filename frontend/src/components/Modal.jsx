import { useEffect, useId, useRef } from 'react';
import { lockScroll } from '../lib/scrollLock.js';

// The modals currently open, innermost last. Escape and the Tab trap belong to the TOP one only: a dialog opened
// from inside another (a confirmation over a form) must not close, or be tabbed out of, the one beneath it.
const openModals = [];

// What Tab can land on. Hidden and disabled things are filtered by the selector and by `hidden`; there is no layout
// test (offsetParent, getClientRects) on purpose, because it would make the behaviour impossible to check in jsdom
// and every control in these dialogs is plainly visible.
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary';
const tabbablesIn = (root) => [...root.querySelectorAll(TABBABLE)].filter((el) => !el.closest('[hidden], [inert]'));

// Where focus goes when a dialog closes (#768), best first. Built when the dialog is first rendered, while whatever
// opened it still exists.
//   1. The control that had focus when the dialog was asked for, exactly as before.
//   2. If that control is not on the page at close: whatever opened the dialog IT was opened from. The two-factor
//      set-up is a chain (password -> QR code -> backup codes), each dialog replacing the last in the same step, so the
//      control the last one saw focused was inside the dialog that had just disappeared. Inheriting the opener's
//      targets from the open dialog that contains it hands the whole chain's origin down to the last link.
//   3. If the origin is gone too (the card swapped its "Set up" button for "Turn off"), the nearest ancestor of the
//      origin that is still on the page, which is the region that button lived in; `region: true` marks those, and the
//      close focuses the first control in the region (here, the button that replaced it) rather than the region
//      itself. Nearest first, so the fallback stays as close to where the person was as it can.
// Never <body>, which is what the browser falls back to when focus is simply lost.
function restoreTargetsFor(opener) {
  if (!opener || opener === document.body) return [];
  // Innermost first: a dialog rendered inside another's children is contained by both cards.
  for (let i = openModals.length - 1; i >= 0; i--) {
    const parent = openModals[i];
    if (parent.card.contains(opener)) return [{ el: opener, region: false }, ...parent.targets];
  }
  const regions = [];
  for (let n = opener.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    regions.push({ el: n, region: true });
  }
  return [{ el: opener, region: false }, ...regions];
}

// Can a person (and a screen reader) actually get to this? `inert` is a subtree behind another open dialog (a
// confirmation closing over a form whose opener has gone), where focus would be lost anyway; `hidden` is not
// rendered, so a browser ignores focus() on it; `aria-hidden` can take focus but is invisible to a screen reader,
// which would announce nothing where focus landed. tabbablesIn already drops the first two for what is INSIDE a
// region; this also looks at the target and every ancestor, for the aria-hidden case it does not know about.
const reachable = (el) => el.isConnected && !el.closest('[inert], [hidden], [aria-hidden="true"]');

// Moves focus to `el` and says whether it ACTUALLY went there. focus() returns nothing and silently does nothing on an
// element a browser will not focus (not rendered, disabled by an ancestor), so success is read back from the page.
function tryFocus(el) {
  if (typeof el.focus !== 'function') return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

// A region with nothing to press in it: make it focusable for one stop, then put its markup back exactly as it was.
// A region that already has a tabindex (0 or -1) is focusable as it is and is left alone: overwriting it and then
// removing it on blur would turn a real tab stop into none. If focus does not land, nothing is left behind.
function tryFocusRegion(el) {
  if (el.hasAttribute('tabindex')) return tryFocus(el);
  el.setAttribute('tabindex', '-1');
  if (!tryFocus(el)) { el.removeAttribute('tabindex'); return false; }
  el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
  return true;
}

// Focus the first target that can take it, trying the next when one refuses, so the search never ends on <body> while
// something better is left. With no usable target focus is left to the browser, which is what happened before this
// fell back at all.
function restoreFocus(targets) {
  for (const { el, region } of targets) {
    if (!reachable(el)) continue;
    if (!region) {
      if (tryFocus(el)) return;
      continue;
    }
    if (tabbablesIn(el).some((inside) => reachable(inside) && tryFocus(inside))) return;
    if (tryFocusRegion(el)) return;
  }
}

// Makes everything outside the dialog inert while it is open (#376). `aria-modal` only DESCRIBES a dialog to
// assistive technology; it does not stop Tab from walking into the page behind it, or a screen reader from reading
// it. The dialog is rendered where it is used, not in a portal, so the way to isolate it is to walk up from it to
// <body> and mark every sibling on the way. Returns the elements this call marked, so closing the dialog removes
// exactly those and never an `inert` that something else (the inactive live monitor) put there. The attribute
// changes nothing visually. It does not stop video that is playing, only interaction and the accessibility tree.
function makeRestInert(overlay) {
  const marked = [];
  for (let node = overlay; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of node.parentElement.children) {
      if (sibling === node || sibling.hasAttribute('inert')) continue;
      if (['SCRIPT', 'STYLE', 'LINK'].includes(sibling.tagName)) continue;
      sibling.setAttribute('inert', '');
      marked.push(sibling);
    }
  }
  return marked;
}

// The shared modal. On phone-width screens it's a SHEET: it hugs the bottom edge (or the top, with
// placement="top"), rounded on the inner side only, capped at a comfortable reading width.
//
// `wide` opts a modal into a desktop treatment — on a large window it becomes a centred dialog sized to
// its content rather than to a phone sheet. Used by the video player, where a 440px-wide sheet wastes
// most of a desktop screen. It changes nothing below the breakpoint, so phones keep the sheet.
//
// Layout lives in CSS (.modal-overlay / .modal-card in index.css) rather than inline styles, because a
// media query can't reach an inline style — and inline styles win over stylesheet rules, so the desktop
// rules would silently lose. Only the two values the visual-viewport effect computes below stay inline.
//
// `dismissible={false}` is for a dialog that holds something that cannot be got back (the one-time
// two-factor backup codes, #557). It removes every incidental way out — the overlay click, the ✕ button —
// so the only exit is whatever explicit button the caller renders inside. On a phone a tap just outside the
// card, or a scroll that ends as a click, is an easy accident, and the default closes on both. Escape (#376)
// honours it too: a non-dismissible dialog ignores the key.
//
// `error` (#378) is the failure of the dialog's OWN action (a Remove that the server refused). It renders
// INSIDE the card, under the title. Before this prop the callers set the page's `.error-banner`, which sits
// in <main> underneath the overlay: the person tapped Remove, nothing happened, and the only explanation
// was behind the dark scrim. An empty/absent `error` renders nothing, so every existing caller is unchanged.
export default function Modal({ title, onClose, children, placement = 'bottom', headerAction = null, wide = false, dismissible = true, error = '' }) {
  const top = placement === 'top';
  const titleId = useId();
  const overlayRef = useRef(null);
  const cardRef = useRef(null);
  // Who had focus when this dialog was asked for, read during the FIRST render, before the commit moves focus (or a
  // child's autoFocus does). Closing hands focus back to it (#376).
  // Kept as the ordered list of places to try (see restoreTargetsFor), not just the opener (#768).
  const targetsRef = useRef(undefined);
  if (targetsRef.current === undefined) targetsRef.current = typeof document !== 'undefined' ? restoreTargetsFor(document.activeElement) : [];
  // Latest props for the listener below, which is attached once.
  const live = useRef({ onClose, dismissible });
  live.current = { onClose, dismissible };

  // The whole dialog pattern (#376): focus moves in, Tab and Shift+Tab stay in, Escape closes (unless the dialog is
  // not dismissible, like the one-time backup codes), the page behind is inert, and on close focus goes back to the
  // control that opened it.
  useEffect(() => {
    const overlay = overlayRef.current;
    const card = cardRef.current;
    if (!overlay || !card) return undefined;
    // `card` and `targets` let a dialog opened from inside this one find where this one came from (#768).
    const me = { card, targets: targetsRef.current };
    openModals.push(me);
    const marked = makeRestInert(overlay);
    // The page behind must not scroll either (#376). Counted in lib/scrollLock.js, so a chain of dialogs or one
    // opened over another never unlocks it early.
    const unlockScroll = lockScroll();

    // A child with autoFocus has already placed focus well; otherwise the first field or action. The close button
    // in the header is the way OUT, not where someone wants to start, so it is only chosen when it is all there is.
    if (!card.contains(document.activeElement)) {
      const all = tabbablesIn(card);
      const target = card.querySelector('[data-autofocus]') || all.find((el) => !el.closest('.modal-card__actions')) || all[0] || card;
      target.focus({ preventScroll: true });
    }

    function onKeyDown(e) {
      if (openModals[openModals.length - 1] !== me) return;
      if (e.key === 'Escape') {
        // Not when something inside already used the key (an open <select>, an IME composition).
        if (e.defaultPrevented || e.isComposing || !live.current.dismissible) return;
        e.preventDefault();
        live.current.onClose?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = tabbablesIn(card);
      if (items.length === 0) { e.preventDefault(); card.focus({ preventScroll: true }); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!card.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (active === first || active === card)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const i = openModals.indexOf(me);
      if (i !== -1) openModals.splice(i, 1);
      for (const el of marked) el.removeAttribute('inert');
      unlockScroll();
      // Back to the opener if it is still on the page; if the dialog's action removed it, to the next best thing
      // (#768). Never to <body>.
      restoreFocus(targetsRef.current);
    };
  }, []);

  // Keep the modal inside the region the on-screen keyboard leaves visible. Without this, a tall form
  // (e.g. edit camera) gets shoved up under the status bar/notch when the keyboard opens and the focused
  // field disappears. We size/position the overlay to the visual viewport (which shrinks and shifts as
  // the keyboard appears) and let the card scroll, so the focused field always stays reachable above the
  // keyboard. Falls back to the CSS default (full height) where VisualViewport isn't available.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const el = overlayRef.current;
    function sync() {
      if (!el) return;
      el.style.height = `${vv.height}px`;
      el.style.top = `${vv.offsetTop}px`;
    }
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  const overlayClass = [
    'modal-overlay',
    top ? 'modal-overlay--top' : '',
    wide ? 'modal-overlay--wide' : '',
  ].filter(Boolean).join(' ');

  return (
    <div ref={overlayRef} className={overlayClass} onClick={dismissible ? onClose : undefined}>
      {/* role/aria-modal so assistive tech announces this as a dialog — without them a screen reader reads
          the modal as one more region of the page, and several of these ask for a password or confirm a
          destructive action. aria-modal does NOT make the page behind it inert (#376); the effect above does,
          with the `inert` attribute. tabIndex -1 only lets script focus the card when it holds nothing tabbable. `aria-labelledby`
          points at the visible heading, so the dialog announces itself by the title already on
          screen rather than needing a duplicate label that could drift out of step with it. */}
      <div ref={cardRef} tabIndex={-1} className="card modal-card" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()}>
        <div className="modal-card__head">
          <h2 id={titleId}>{title}</h2>
          <div className="modal-card__actions">
            {headerAction}
            {dismissible && <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>}
          </div>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {children}
      </div>
    </div>
  );
}
