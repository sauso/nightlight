import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Moon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';

// Sleep detail: a to-scale timeline of one night for a child, with the wake-ups marked, plus a date
// picker to browse back through the retained nights (~30 days of activity_samples). Reached by tapping
// the "last night" summary on the child page. Data comes from GET /children/:id/sleep/:date?detail=1,
// which recomputes the night (segments + wake list) from the per-minute activity samples on demand.

const HISTORY_DAYS = 30; // how far back the underlying activity_samples are retained

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function fmtDur(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Colours for the timeline segments — tuned to read on both themes (defined against tokens in CSS).
const SEG_CLASS = { asleep: 'sleep-seg--asleep', wake: 'sleep-seg--wake', settling: 'sleep-seg--awake', awake: 'sleep-seg--awake' };

export default function SleepDetail() {
  const { id } = useParams();
  const { settings } = useSettings();
  const tz = settings.timezone || 'UTC';
  const { kids } = useCameras();
  const kid = kids.find((k) => k.id === id);

  const [maxDate, setMaxDate] = useState(null); // latest browsable night (last completed)
  const [date, setDate] = useState(null); // selected night's local start date
  const [night, setNight] = useState(undefined); // undefined = loading

  // Local calendar 'today' in the app tz, and the default max = yesterday (a completed night).
  const todayLocal = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    [tz]
  );

  // Pick the initial date from the latest stored night (falls back to yesterday if none stored yet).
  useEffect(() => {
    let alive = true;
    const fallback = addDays(todayLocal, -1);
    api.get(`/children/${id}/sleep?nights=1`)
      .then((r) => {
        const latest = r?.nights?.[0]?.night_date || fallback;
        if (!alive) return;
        setMaxDate(latest > fallback ? latest : fallback);
        setDate(latest);
      })
      .catch(() => { if (alive) { setMaxDate(fallback); setDate(fallback); } });
    return () => { alive = false; };
  }, [id, todayLocal]);

  useEffect(() => {
    if (!date) return;
    let alive = true;
    setNight(undefined);
    api.get(`/children/${id}/sleep/${date}?detail=1`)
      .then((r) => { if (alive) setNight(r || null); })
      .catch(() => { if (alive) setNight(null); });
    return () => { alive = false; };
  }, [id, date]);

  const minDate = maxDate ? addDays(maxDate, -(HISTORY_DAYS - 1)) : null;
  const canPrev = date && minDate && date > minDate;
  const canNext = date && maxDate && date < maxDate;

  const fmtTime = (utc) => {
    if (!utc) return '';
    const d = new Date(String(utc).replace(' ', 'T') + 'Z');
    return new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  };
  const fmtDateLong = (dstr) => {
    if (!dstr) return '';
    const d = new Date(dstr + 'T00:00:00');
    return new Intl.DateTimeFormat([], { weekday: 'long', day: 'numeric', month: 'short' }).format(d);
  };

  const back = { to: `/children/${id}`, label: kid?.name || 'Child' };

  return (
    <>
      <AppHeader title="Sleep" back={back} />
      <main className="app-main">
        {/* Date navigator */}
        <div className="sleep-nav">
          <button type="button" className="sleep-nav__arrow" disabled={!canPrev}
            onClick={() => canPrev && setDate(addDays(date, -1))} aria-label="Previous night">
            <ChevronLeft size={20} />
          </button>
          <label className="sleep-nav__date">
            <span className="sleep-nav__date-label">{date ? fmtDateLong(date) : '…'}</span>
            <span className="sleep-nav__date-sub">night of</span>
            {date && (
              <input type="date" className="sleep-nav__date-input" value={date} min={minDate || undefined} max={maxDate || undefined}
                onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Pick a night" />
            )}
          </label>
          <button type="button" className="sleep-nav__arrow" disabled={!canNext}
            onClick={() => canNext && setDate(addDays(date, 1))} aria-label="Next night">
            <ChevronRight size={20} />
          </button>
        </div>

        <NightBody night={night} fmtTime={fmtTime} tz={tz} />

        <div className="sleep-detail__est">
          <Moon size={13} aria-hidden="true" /> Estimated from movement &amp; sound over the night window — a
          sleep-pattern guide, not a medical measurement.
        </div>
      </main>
    </>
  );
}

function NightBody({ night, fmtTime, tz }) {
  if (night === undefined) return <div className="card"><div className="empty-state" style={{ padding: 20 }}>Loading night…</div></div>;
  if (!night || night.status === 'no_data') {
    return (
      <div className="card">
        <div className="camera-tile__sub" style={{ padding: 14 }}>
          No sleep data for this night — either it predates tracking, or the cameras weren’t running motion/sound
          detection with enough coverage.
        </div>
      </div>
    );
  }
  if (night.status === 'no_sleep') {
    return <div className="card"><div className="camera-tile__sub" style={{ padding: 14 }}>No clear sleep detected in this night’s window.</div></div>;
  }

  const range = night.wake_at
    ? `${fmtTime(night.onset_at)} – ${fmtTime(night.wake_at)}`
    : `from ${fmtTime(night.onset_at)} · still asleep at ${fmtTime(night.window_end)}`;
  const wakes = night.wakes || [];

  return (
    <>
      <div className="card sleep-detail__summary">
        <div className="sleep-detail__big">{fmtDurBig(night.asleep_minutes)}<span> asleep</span></div>
        <div className="sleep-detail__stats">
          <Stat label="Asleep from → to" value={range} />
          <Stat label="Wake-ups" value={String(night.wake_count ?? 0)} />
          <Stat label="Longest stretch" value={fmtDurAbbr(night.longest_stretch_minutes)} />
          <Stat label="Coverage" value={`${Math.round((night.coverage_minutes / windowMinutes(night)) * 100)}%`} />
        </div>
      </div>

      <div className="card">
        <div className="sleep-detail__section-title">Night timeline</div>
        <Timeline night={night} fmtTime={fmtTime} tz={tz} />
        <div className="sleep-legend">
          <span><i className="sleep-legend__sw sleep-seg--asleep" /> Asleep</span>
          <span><i className="sleep-legend__sw sleep-seg--wake" /> Awake</span>
          <span><i className="sleep-legend__sw sleep-seg--awake" /> Before/after sleep</span>
        </div>
      </div>

      <div className="card">
        <div className="sleep-detail__section-title">Wake-ups · {wakes.length}</div>
        {wakes.length === 0 ? (
          <div className="camera-tile__sub" style={{ padding: '2px 2px 4px' }}>No awakenings counted (a stir under 5 minutes doesn’t count).</div>
        ) : (
          <ul className="sleep-wakes">
            {wakes.map((w, i) => (
              <li key={i} className="sleep-wakes__row">
                <span className="sleep-wakes__time">{fmtTime(w.start_at)} – {fmtTime(w.end_at)}</span>
                <span className="sleep-wakes__dur">{fmtDur(w.minutes)} awake</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }) {
  return (
    <div className="sleep-stat">
      <div className="sleep-stat__label">{label}</div>
      <div className="sleep-stat__value">{value}</div>
    </div>
  );
}

// The to-scale bar: each segment positioned by its share of the window, plus hour tick labels and
// onset/wake markers so the wake-ups read against a real time axis.
function Timeline({ night, fmtTime, tz }) {
  const startMs = utcMs(night.window_start);
  const endMs = utcMs(night.window_end);
  const totalMs = Math.max(1, endMs - startMs);
  const segs = night.segments || [];

  const ticks = useMemo(() => {
    const out = [];
    // First whole hour at/after the window start (the window is aligned to a local hour, so stepping
    // by 1h keeps local-hour alignment). Label every 2h to avoid clutter.
    let ms = Math.ceil(startMs / 3600000) * 3600000;
    let n = 0;
    for (; ms <= endMs; ms += 3600000, n++) {
      out.push({ pct: ((ms - startMs) / totalMs) * 100, label: n % 2 === 0 ? shortHour(ms, tz) : null });
    }
    return out;
  }, [startMs, endMs, totalMs, tz]);

  const onsetPct = pctOf(night.onset_at, startMs, totalMs);
  const wakePct = night.wake_at ? pctOf(night.wake_at, startMs, totalMs) : null;

  return (
    <div className="sleep-tl">
      <div className="sleep-tl__bar">
        {segs.map((s, i) => (
          <div key={i} className={`sleep-seg ${SEG_CLASS[s.state] || 'sleep-seg--awake'}`}
            style={{ width: `${(s.minutes / (totalMs / 60000)) * 100}%` }}
            title={`${fmtTime(s.from_at)}–${fmtTime(s.to_at)} · ${labelFor(s.state)}`} />
        ))}
        {onsetPct != null && <span className="sleep-tl__mark" style={{ left: `${onsetPct}%` }} />}
        {wakePct != null && <span className="sleep-tl__mark" style={{ left: `${wakePct}%` }} />}
      </div>
      <div className="sleep-tl__axis">
        {ticks.map((t, i) => (
          <span key={i} className="sleep-tl__tick" style={{ left: `${t.pct}%` }}>
            {t.label && <span className="sleep-tl__tick-label">{t.label}</span>}
          </span>
        ))}
      </div>
      <div className="sleep-tl__ends">
        <span>{fmtTime(night.window_start)}</span>
        <span>{fmtTime(night.window_end)}</span>
      </div>
    </div>
  );
}

// --- small helpers ---
const utcMs = (s) => new Date(String(s).replace(' ', 'T') + 'Z').getTime();
const pctOf = (s, startMs, totalMs) => (s ? ((utcMs(s) - startMs) / totalMs) * 100 : null);
const windowMinutes = (night) => Math.max(1, Math.round((utcMs(night.window_end) - utcMs(night.window_start)) / 60000));
const labelFor = (state) => (state === 'asleep' ? 'asleep' : state === 'wake' ? 'awake' : 'before/after sleep');
function shortHour(ms, tz) {
  const s = new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', hour12: true }).format(new Date(ms));
  return s.replace(/\s?AM/i, 'a').replace(/\s?PM/i, 'p');
}
function fmtDurBig(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtDurAbbr(min) { return min ? fmtDurBig(min) : '—'; }
