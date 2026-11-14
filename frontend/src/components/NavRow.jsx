import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

// #1076: the one "go deeper" row (icon chip, label, optional sub line, optional current value, chevron). It
// replaces DetectionRow, which was a <div role="button"> that needed its own Enter/Space handler; this is a real
// <button type="button"> (or a <Link> when `to` is given), so keyboard activation, focus and the role come from the
// browser. The accessible name is the text inside, so it starts with the visible label ("Motion detection On"),
// which is what a voice-control user says. The icon and chevron are aria-hidden: they carry no information the
// words do not. `value` is the CURRENT setting ("On", "Always"), never a decoration.
export default function NavRow({ Icon, label, sub, value, onClick, to }) {
  const Tag = to ? Link : 'button';
  return (
    <Tag className="nav-row" {...(to ? { to } : { type: 'button', onClick })}>
      <span className="nav-row__left">
        <span className="nav-row__chip"><Icon size={18} aria-hidden="true" /></span>
        <span className="nav-row__copy">
          <span className="nav-row__label">{label}</span>
          {sub && <>{' '}<span className="nav-row__sub">{sub}</span></>}
        </span>
      </span>
      {/* The literal spaces are for the accessible name: label, sub line and value are separate inline spans, which
          a screen reader would otherwise read run together ("Motion detectionOn"). */}
      {' '}
      <span className="nav-row__right">
        {value && <span className="nav-row__value">{value}</span>}
        <ChevronRight size={18} aria-hidden="true" />
      </span>
    </Tag>
  );
}
