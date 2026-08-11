/**
 * A pill toggle switch. Use for *immediate-apply* settings (the change takes effect
 * the moment it's flipped) — e.g. enable notifications, enable MQTT, auto-refresh.
 * For save-on-submit forms keep a plain checkbox, so the control's shape tells the
 * user whether it applies instantly or on Save.
 *
 * Renders a real <input type="checkbox"> (so it stays keyboard- and label-friendly)
 * with the visual track/thumb drawn by the .switch CSS in index.css.
 */
export default function Switch({ checked, disabled = false, onChange, ...rest }) {
  return (
    <span className={`switch${disabled ? ' switch--disabled' : ''}`}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        {...rest}
      />
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
    </span>
  );
}
