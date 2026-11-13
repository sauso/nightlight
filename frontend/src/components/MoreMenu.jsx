import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';

// The "⋯" (more) menu in a page header: one button that opens a small list of actions. Built for the sleep page (UI
// refresh PR E), where "Recompute this night" and "Show with today's settings" moved out of the night card. The repo had
// no menu component, and the design does not draw one, so this is the plainest accessible version of the WAI-ARIA menu
// button pattern:
//   - the button has aria-haspopup="menu" / aria-expanded / aria-controls; Enter and Space open it (it is a <button>),
//     ArrowDown opens it too. Opening puts focus on the first item.
//   - the items are the children: real <button role="menuitem">, 44px tall (`.more-menu__item`). Up / Down / Home / End move
//     between them.
//   - it closes on Escape (focus goes back to the button), on choosing an item (focus goes back to the button, so a dialog
//     the item opens remembers it and returns there), on a press outside, and when focus moves out of it (Tab).
//
// ⚠️ THE PANEL IS ALWAYS MOUNTED, only `hidden` while closed. Two reasons, both load-bearing:
//   1. `onSlot` hands the page a DOM element INSIDE the panel, and the page portals an item into it (RecomputeNight keeps
//      its own state and dialog, so its item has to be rendered by it, not by this component). A panel that mounted on open
//      would give that item a second render pass to appear in, which made "focus the first item on open" a timing race.
//   2. That item's component must outlive the menu closing: choosing it closes the menu while its dialog is still
//      loading, and unmounting the item's owner would drop the dialog with it.
// The closed menu is `hidden` (display: none, out of the accessibility tree and the tab order), so nothing is reachable.
//
// The close-on-focus-out listens on the DOCUMENT's focusin, not on the button's blur: Safari does not focus a <button>
// when it is clicked, so a blur-based close fires with no `relatedTarget` on the press that is about to choose an item,
// hides the panel under the pointer, and the click never lands.
export default function MoreMenu({ label = 'More options', menuLabel = 'Options', onSlot, children }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const panelRef = useRef(null);
  const panelId = useId();

  const close = useCallback((returnFocus) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  const items = () => [...(panelRef.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];

  // Focus the first item when it opens (a keyboard or screen-reader user lands in the menu; a pointer user is not
  // bothered by a focus ring, which :focus-visible does not draw for a programmatic focus after a click).
  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const outside = (e) => { if (!wrapRef.current?.contains(e.target)) close(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open, close]);

  // Choosing an item closes the menu. A NATIVE listener on the panel, not an onClick prop: the page portals an item into this
  // panel from a component that is not a React child of this one, and React delivers a synthetic click to the React tree
  // (the portal's owner), never to this panel, so an onClick here would close the menu for its own children and silently
  // not for Recompute's item. The DOM does bubble through the panel, which is what this hears. It runs BEFORE the item's own
  // React handler (React listens at the root), which is fine: closing only hides the panel and moves focus, and the click
  // is already on its way.
  useEffect(() => {
    const panel = panelRef.current;
    const onClick = (e) => { if (e.target.closest('[role="menuitem"]')) close(true); };
    panel.addEventListener('click', onClick);
    return () => panel.removeEventListener('click', onClick);
  }, [close]);

  // Keys: NATIVE too, for the same reason as the click above (an item focused inside the panel that this component did not
  // render would never send its keydown to a React onKeyDown here, and Escape would do nothing on Recompute).
  useEffect(() => {
    const wrap = wrapRef.current;
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        e.stopPropagation(); // the page's other Escape handlers (a dialog above it) are not this menu's business
        close(true);
        return;
      }
      const list = items();
      if (!list.length) return;
      const at = list.indexOf(document.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = at < 0 ? list[0] : list[(at + 1) % list.length];
      else if (e.key === 'ArrowUp') next = at < 0 ? list[list.length - 1] : list[(at - 1 + list.length) % list.length];
      else if (e.key === 'Home' && open) next = list[0];
      else if (e.key === 'End' && open) next = list[list.length - 1];
      if (!next) return;
      e.preventDefault();
      if (!open) setOpen(true); // ArrowDown on the closed button opens it; the effect above focuses the first item
      else next.focus();
    };
    wrap.addEventListener('keydown', onKeyDown);
    return () => wrap.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  return (
    <div className="more-menu" ref={wrapRef}>
      <button type="button" ref={buttonRef} className="more-menu__btn" aria-label={label}
        aria-haspopup="menu" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}>
        <MoreHorizontal size={22} aria-hidden="true" />
      </button>
      <div ref={panelRef} id={panelId} className="more-menu__panel" role="menu" aria-label={menuLabel} hidden={!open}>
        {children}
        <div ref={onSlot} className="more-menu__slot" />
      </div>
    </div>
  );
}
