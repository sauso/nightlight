// The "you have changes that are not saved" line shown on a form with an explicit Save (#377, #391).
//
// One component so every form says the same thing in the same place. It is a status region (announced
// politely when it appears), not an alert: nothing is wrong, the person just needs to know that what is on
// screen is not yet what is stored. `restored` is true when the values came back from a draft after a
// reload or a visit elsewhere, which is worth saying because the person did not just type them.
//
// `note` is for form-specific truth, e.g. that a password is deliberately not kept across a reload.
export default function UnsavedNotice({ restored = false, note = '', onDiscard }) {
  return (
    <div role="status" className="camera-tile__sub"
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', margin: '0 0 14px', color: 'var(--text-primary)' }}>
      <span style={{ flex: 1, minWidth: 180 }}>
        <span aria-hidden="true" style={{ color: 'var(--peri)' }}>● </span>
        <strong>{restored ? 'Unsaved changes restored.' : 'Unsaved changes.'}</strong>{' '}
        They are kept on this device only until you press Save.
        {note ? <> {note}</> : null}
      </span>
      {onDiscard && (
        <button type="button" className="btn btn-secondary btn-sm" style={{ width: 'auto' }} onClick={onDiscard}>
          Discard changes
        </button>
      )}
    </div>
  );
}
