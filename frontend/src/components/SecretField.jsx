// Input for an API secret the server never sends back in full. When a value is already saved it shows
// a masked preview (Azure-style — enough to recognise which token it is) and the input starts empty:
// typing a new value replaces it, leaving it blank keeps the current one. type=password so a pasted
// token isn't shoulder-surfed; autoComplete off so password managers don't try to fill it.
export default function SecretField({ id, label, masked, isSet, value, onChange, placeholder, disabled, hint }) {
  return (
    <div className="field" style={{ marginBottom: 0 }}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="password"
        autoComplete="new-password"
        value={value}
        onChange={onChange}
        placeholder={isSet ? 'Leave blank to keep current' : placeholder || ''}
        disabled={disabled}
      />
      {isSet ? (
        <div className="camera-tile__sub" style={{ marginTop: 6 }}>
          Saved: <code>{masked}</code> — enter a new value to replace it.
        </div>
      ) : hint ? (
        <div className="camera-tile__sub" style={{ marginTop: 6 }}>{hint}</div>
      ) : null}
    </div>
  );
}
