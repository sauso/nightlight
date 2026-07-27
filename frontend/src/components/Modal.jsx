export default function Modal({ title, onClose, children, placement = 'bottom' }) {
  const top = placement === 'top';
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10, 13, 28, 0.7)',
        display: 'flex',
        alignItems: top ? 'flex-start' : 'flex-end',
        justifyContent: 'center',
        // A top sheet must clear the device safe area (status bar / notch) so it lines up
        // with the header rather than hiding behind it - matters in the native mobile app.
        paddingTop: top ? 'env(safe-area-inset-top, 0px)' : undefined,
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
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 18 }}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
