import { useEffect, useRef } from 'react';

export default function Modal({ title, onClose, children, placement = 'bottom', headerAction = null }) {
  const top = placement === 'top';
  const overlayRef = useRef(null);

  // Keep the modal inside the region the on-screen keyboard leaves visible. Without this, a
  // tall form (e.g. edit camera) gets shoved up under the status bar/notch when the keyboard
  // opens and the focused field disappears. We size/position the overlay to the visual
  // viewport (which shrinks and shifts as the keyboard appears) and let the card scroll, so
  // the focused field always stays reachable above the keyboard. Falls back to full-screen
  // where VisualViewport isn't available.
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

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        top: 0,
        height: '100%',
        background: 'rgba(10, 13, 28, 0.7)',
        display: 'flex',
        alignItems: top ? 'flex-start' : 'flex-end',
        justifyContent: 'center',
        // Always keep the modal clear of the device safe area (status bar / notch): a top
        // sheet starts below it, and a bottom sheet that grows tall (long form, or pushed up
        // by the keyboard) is capped so its top can't slide under it either.
        paddingTop: 'env(safe-area-inset-top, 0px)',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: 440,
          margin: 0,
          // Sheet hugs whichever edge it slides from - rounded corners on the inner side only.
          borderRadius: top ? '0 0 20px 20px' : '20px 20px 0 0',
          // Never exceed the visible area; scroll within it so the keyboard can't hide fields.
          maxHeight: '100%',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 16,
          }}
        >
          <h2 style={{ fontSize: 18 }}>{title}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {headerAction}
            <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
