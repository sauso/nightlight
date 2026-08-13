// One detection row (Motion / Sound / Alert schedule), shown two ways from the same shape:
//  - Camera settings drills into the full config screen  → as a <div> button with a value + chevron.
//  - The camera cog sheet quick-toggles it in place       → as a <label> wrapping a Switch.
// Both get the same periwinkle icon chip so they read identically (see .det-row / .det-chip CSS).
export default function DetectionRow({ Icon, label, sub, right, onClick, as = 'div' }) {
  const Tag = as;
  const clickable = !!onClick;
  return (
    <Tag
      className={`det-row${clickable ? ' det-row--clickable' : ''}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <span className="det-row__left">
        <span className="det-chip"><Icon size={18} aria-hidden="true" /></span>
        <span>
          <span className="det-row__label">{label}</span>
          {sub && <span className="camera-tile__sub" style={{ display: 'block' }}>{sub}</span>}
        </span>
      </span>
      <span className="det-row__right">{right}</span>
    </Tag>
  );
}
