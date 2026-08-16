import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

// Popup calendar for filtering clips by day. Only days that actually have clips are enabled (shown
// with a dot); picking one filters to that day, "All dates" clears it. Emits/accepts a stable local
// day key 'YYYY-MM-DD' (or 'all'); the parent maps that back to a display label.
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const monthNum = (k) => { const d = new Date(k + 'T00:00'); return d.getFullYear() * 12 + d.getMonth(); };

export default function ClipDatePicker({ value, onChange, availableDays, labelFor }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const bounds = useMemo(() => {
    const sorted = [...availableDays].sort();
    return { min: sorted[0], max: sorted[sorted.length - 1] };
  }, [availableDays]);

  const [ym, setYm] = useState(() => {
    const base = value !== 'all' ? value : bounds.max;
    const d = base ? new Date(base + 'T00:00') : new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  // On open, jump to the selected day's month (or the most recent month with clips).
  useEffect(() => {
    if (!open) return;
    const base = value !== 'all' ? value : bounds.max;
    const d = base ? new Date(base + 'T00:00') : new Date();
    setYm({ y: d.getFullYear(), m: d.getMonth() });
  }, [open, value, bounds.max]);

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
  const triggerLabel = value === 'all' ? 'All dates' : (labelFor(value) || value);

  function pick(d) {
    onChange(keyOf(ym.y, ym.m, d));
    setOpen(false);
  }

  return (
    <div className="clip-datepicker" ref={ref}>
      <button type="button" className="clip-datepicker__trigger" onClick={() => setOpen((o) => !o)} aria-haspopup="dialog" aria-expanded={open}>
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
              const isSel = value === k;
              return (
                <button
                  key={i}
                  type="button"
                  className={`clip-cal__day${has ? ' has-clips' : ''}${isSel ? ' is-sel' : ''}`}
                  disabled={!has}
                  onClick={() => pick(d)}
                  aria-label={has ? `${new Date(ym.y, ym.m, d).toLocaleDateString()} — clips available` : undefined}
                >
                  {d}
                </button>
              );
            })}
          </div>

          <button type="button" className="clip-cal__all" onClick={() => { onChange('all'); setOpen(false); }}>
            All dates
          </button>
        </div>
      )}
    </div>
  );
}
