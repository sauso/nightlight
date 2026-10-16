/**
 * A pill toggle switch. The pill does NOT by itself say whether a change applies at once
 * or on Save (it used to be read that way, and the push provider pages and Recording both
 * put it in Save forms): the PAGE decides, and must do so for every control on it. On a page
 * with a Save button the switch is a draft and the page shows UnsavedNotice (#391); on a page
 * that saves itself, every control does. Never mix the two on one page.
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
