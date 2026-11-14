import { useId } from 'react';
import Switch from './Switch.jsx';

// Keep the visible label and native switch input tied together even when several rows share a page.
export default function SwitchRow({ label, sub, children, id, checked, disabled, onChange, heading = false, headingLevel = 3, className = '', ...inputProps }) {
  const generatedId = useId();
  const inputId = id || `switch-${generatedId}`;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={`switch-row ${className}`.trim()}>
      <div className="switch-row__line">
        <div className="switch-row__copy">
          {heading ? <Heading className="card-heading"><label htmlFor={inputId}>{label}</label></Heading>
            : <label className="switch-row__label" htmlFor={inputId}>{label}</label>}
          {/* A <label> too, so a tap on the short explanation toggles the switch, as the old whole-row label did (Codex review of
              #1087). The input's own aria-label still names it; the long `children` note below stays plain text. */}
          {sub && <label className="switch-row__sub" htmlFor={inputId}>{sub}</label>}
        </div>
        <Switch id={inputId} aria-label={typeof label === 'string' ? label : undefined}
          checked={checked} disabled={disabled} onChange={onChange} {...inputProps} />
      </div>
      {children && <p className="switch-row__note">{children}</p>}
    </div>
  );
}
