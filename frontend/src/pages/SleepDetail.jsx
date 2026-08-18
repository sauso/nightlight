import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Moon, DoorOpen } from 'lucide-react';
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
const SEG_CLASS = {
  asleep: 'sleep-seg--asleep', stir: 'sleep-seg--stir', wake: 'sleep-seg--wake',
  settling: 'sleep-seg--awake', awake: 'sleep-seg--awake',
};

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

  // Start on the live night — the one in progress if a window is open (so you land on "tonight · so
  // far"), else the last completed night. That date is also the max the picker allows.
  useEffect(() => {
    let alive = true;
    const fallback = addDays(todayLocal, -1);
    api.get(`/children/${id}/sleep/live`)
      .then((r) => {
        const nd = r?.night?.night_date || fallback;
        if (!alive) return;
        setMaxDate(nd > fallback ? nd : fallback);
        setDate(nd);
      })
      .catch(() => { if (alive) { setMaxDate(fallback); setDate(fallback); } });
    return () => { alive = false; };
  }, [id, todayLocal]);

  useEffect(() => {
    if (!date) return;
    let alive = true;
    setNight(undefined);
    const load = () => api.get(`/children/${id}/sleep/${date}?detail=1`)
      .then((r) => { if (alive) setNight(r || null); })
      .catch(() => { if (alive) setNight(null); });
    load();
    // Keep the live (in-progress) night fresh — only the latest night can still be changing.
    const t = date === maxDate ? setInterval(load, 2 * 60 * 1000) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [id, date, maxDate]);

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
            <span className="sleep-nav__date-label">
              {date ? fmtDateLong(date) : '…'}
              {night?.in_progress && <span className="sleep-live-badge">so far</span>}
            </span>
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
  if (night && night.status === 'off') {
    return (
      <div className="card">
        <div className="camera-tile__sub" style={{ padding: 14 }}>
          Sleep tracking is off for this child. Turn it on in their settings to record and see nightly sleep.
        </div>
      </div>
    );
  }
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

  const range = night.in_progress
    ? night.wake_at
      ? `${fmtTime(night.onset_at)} – awake since ${fmtTime(night.wake_at)}`
      : `asleep since ${fmtTime(night.onset_at)} (ongoing)`
    : night.wake_at
      ? `${fmtTime(night.onset_at)} – ${fmtTime(night.wake_at)}`
      : `from ${fmtTime(night.onset_at)} · still asleep at ${fmtTime(night.window_end)}`;
  const wakes = night.wakes || [];
  const visits = night.visits || [];
  // Coverage is measured against elapsed time so far for a live night, not the full window.
  const covEnd = night.in_progress && night.as_of ? night.as_of : night.window_end;
  const covPct = Math.round((night.coverage_minutes / Math.max(1, Math.round((utcMs(covEnd) - utcMs(night.window_start)) / 60000))) * 100);

  return (
    <>
      <div className="card sleep-detail__summary">
        <div className="sleep-detail__big">{fmtDurBig(night.asleep_minutes)}<span> asleep{night.in_progress ? ' so far' : ''}</span></div>
        <div className="sleep-detail__stats">
          <Stat label={night.in_progress ? 'Asleep' : 'Asleep from → to'} value={range} />
          <Stat label="Wake-ups" value={String(night.wake_count ?? 0)} />
          <Stat label="Longest stretch" value={fmtDurAbbr(night.longest_stretch_minutes)} />
          <Stat label="Coverage" value={`${covPct}%`} />
        </div>
      </div>

      <div className="card">
        <div className="sleep-detail__section-title">Night timeline</div>
        <Timeline night={night} fmtTime={fmtTime} tz={tz} />
        <div className="sleep-legend">
          <span><i className="sleep-legend__sw sleep-seg--asleep" /> Asleep</span>
          <span><i className="sleep-legend__sw sleep-seg--stir" /> Stirring</span>
          <span><i className="sleep-legend__sw sleep-seg--wake" /> Awake</span>
          <span><i className="sleep-legend__sw sleep-seg--awake" /> Before/after sleep</span>
          {visits.length > 0 && <span><i className="sleep-legend__sw sleep-legend__sw--visit" /> In the room</span>}
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

      {visits.length > 0 && (
        <div className="card">
          <div className="sleep-detail__section-title"><DoorOpen size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Room activity · {visits.length}</div>
          <div className="camera-tile__sub" style={{ margin: '-6px 0 10px' }}>Movement outside the crib — someone in the room, or the child out of bed.</div>
          <ul className="sleep-wakes">
            {visits.map((v, i) => (
              <li key={i} className="sleep-wakes__row">
                <span className="sleep-wakes__time">{fmtTime(v.start_at)}{v.minutes > 1 ? ` – ${fmtTime(v.end_at)}` : ''}</span>
                <span className="sleep-wakes__dur sleep-wakes__dur--visit">{fmtDur(v.minutes)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
  const nowPct = night.in_progress && night.as_of ? pctOf(night.as_of, startMs, totalMs) : null;
  const visits = night.visits || [];

  return (
    <div className="sleep-tl">
      {/* Room-activity (outside-crib) markers sit above the bar so they read as events, not sleep state. */}
      {visits.length > 0 && (
        <div className="sleep-tl__visits">
          {visits.map((v, i) => (
            <span key={i} className="sleep-tl__visit" style={{ left: `${pctOf(v.start_at, startMs, totalMs)}%` }}
              title={`In the room · ${fmtTime(v.start_at)}`} />
          ))}
        </div>
      )}
      <div className="sleep-tl__bar">
        {segs.map((s, i) => (
          <div key={i} className={`sleep-seg ${SEG_CLASS[s.state] || 'sleep-seg--awake'}`}
            style={{ width: `${(s.minutes / (totalMs / 60000)) * 100}%` }}
            title={`${fmtTime(s.from_at)}–${fmtTime(s.to_at)} · ${labelFor(s.state)}`} />
        ))}
        {onsetPct != null && <span className="sleep-tl__mark" style={{ left: `${onsetPct}%` }} />}
        {wakePct != null && <span className="sleep-tl__mark" style={{ left: `${wakePct}%` }} />}
        {nowPct != null && <span className="sleep-tl__now" style={{ left: `${nowPct}%` }} title="as of now" />}
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
const labelFor = (state) => (state === 'asleep' ? 'asleep' : state === 'stir' ? 'stirring' : state === 'wake' ? 'awake' : 'before/after sleep');
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
