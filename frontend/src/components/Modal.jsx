import { useEffect, useRef } from 'react';

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
export default function Modal({ title, onClose, children, placement = 'bottom', headerAction = null, wide = false }) {
  const top = placement === 'top';
  const overlayRef = useRef(null);

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
    <div ref={overlayRef} className={overlayClass} onClick={onClose}>
      <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card__head">
          <h2>{title}</h2>
          <div className="modal-card__actions">
            {headerAction}
            <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
