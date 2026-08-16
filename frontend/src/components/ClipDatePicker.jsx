import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

// Popup calendar for filtering clips by day — multi-select. Only days that actually have clips are
// enabled (shown with a dot); tapping days toggles them in/out of the filter (the list shows clips
// from every selected day), and "Clear" resets to all. Works in stable local day keys 'YYYY-MM-DD';
// the parent maps a key back to a display label.
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const monthNum = (k) => { const d = new Date(k + 'T00:00'); return d.getFullYear() * 12 + d.getMonth(); };

export default function ClipDatePicker({ selected, onToggle, onClear, availableDays, labelFor }) {
  const [open, setOpen] = useState(false);
  const [ym, setYm] = useState(() => ({ y: new Date().getFullYear(), m: new Date().getMonth() }));
  const ref = useRef(null);

  const bounds = useMemo(() => {
    const sorted = [...availableDays].sort();
    return { min: sorted[0], max: sorted[sorted.length - 1] };
  }, [availableDays]);

  // Jump the shown month to the latest selected day (or the most recent month with clips) when opening.
  function openPicker() {
    const sel = [...selected].sort();
    const base = sel[sel.length - 1] || bounds.max;
    const d = base ? new Date(base + 'T00:00') : new Date();
    setYm({ y: d.getFullYear(), m: d.getMonth() });
    setOpen(true);
  }

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const cells = useMemo(() => {
    const startDow = new Date(ym.y, ym.m, 1).getDay();
    const daysInMonth = new Date(ym.y, ym.m + 1, 0).getDate();
    const arr = Array.from({ length: startDow }, () => null);
    for (let d = 1; d <= daysInMonth; d++) arr.push(d);
    while (arr.length % 7 !== 0) arr.push(null);
    return arr;
  }, [ym]);

  const cur = ym.y * 12 + ym.m;
  const canPrev = bounds.min ? cur > monthNum(bounds.min) : false;
  const canNext = bounds.max ? cur < monthNum(bounds.max) : false;
  const monthLabel = new Date(ym.y, ym.m, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });

  const triggerLabel =
    selected.size === 0 ? 'All dates'
      : selected.size === 1 ? (labelFor([...selected][0]) || [...selected][0])
        : `${selected.size} days`;

  return (
    <div className="clip-datepicker" ref={ref}>
      <button type="button" className="clip-datepicker__trigger" onClick={() => (open ? setOpen(false) : openPicker())} aria-haspopup="dialog" aria-expanded={open}>
        <CalendarDays size={16} aria-hidden="true" />
        <span>{triggerLabel}</span>
      </button>

      {open && (
        <div className="clip-cal" role="dialog" aria-label="Filter clips by date">
          <div className="clip-cal__head">
            <button type="button" className="clip-cal__nav" onClick={() => setYm((s) => { const d = new Date(s.y, s.m - 1, 1); return { y: d.getFullYear(), m: d.getMonth() }; })} disabled={!canPrev} aria-label="Previous month">
              <ChevronLeft size={18} />
            </button>
            <div className="clip-cal__title">{monthLabel}</div>
            <button type="button" className="clip-cal__nav" onClick={() => setYm((s) => { const d = new Date(s.y, s.m + 1, 1); return { y: d.getFullYear(), m: d.getMonth() }; })} disabled={!canNext} aria-label="Next month">
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="clip-cal__dow">
            {WEEKDAYS.map((w, i) => <span key={i}>{w}</span>)}
          </div>

          <div className="clip-cal__grid">
            {cells.map((d, i) => {
              if (d == null) return <span key={i} className="clip-cal__day is-blank" />;
              const k = keyOf(ym.y, ym.m, d);
              const has = availableDays.has(k);
              const isSel = selected.has(k);
              return (
                <button
                  key={i}
                  type="button"
                  className={`clip-cal__day${has ? ' has-clips' : ''}${isSel ? ' is-sel' : ''}`}
                  disabled={!has}
                  aria-pressed={has ? isSel : undefined}
                  onClick={() => onToggle(k)}
                  aria-label={has ? `${new Date(ym.y, ym.m, d).toLocaleDateString()} — clips available` : undefined}
                >
                  {d}
                </button>
              );
            })}
          </div>

          <div className="clip-cal__foot">
            <button type="button" className="clip-cal__all" onClick={onClear} disabled={selected.size === 0}>
              Clear
            </button>
            <button type="button" className="clip-cal__done" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
