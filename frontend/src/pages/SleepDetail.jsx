import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Moon, DoorOpen, Thermometer, Sparkles, Zap, AudioLines, Play } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import ClipPlayerModal from '../components/ClipPlayerModal.jsx';

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

        <NightBody night={night} fmtTime={fmtTime} tz={tz} tempUnit={settings.temp_unit} />

        <SleepInsights childId={id} tempUnit={settings.temp_unit} childName={kid?.name} />

        <div className="sleep-detail__est">
          <Moon size={13} aria-hidden="true" /> Estimated from movement &amp; sound over the night window — a
          sleep-pattern guide, not a medical measurement.
        </div>
      </main>
    </>
  );
}

function NightBody({ night, fmtTime, tz, tempUnit }) {
  // The wake↔alert clip currently open in the shared player (or null). Lives here so it survives a
  // 2-min live refresh of `night` without tearing the modal down mid-watch.
  const [clipFor, setClipFor] = useState(null);
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
  if (night.status === 'empty') {
    return (
      <div className="card">
        <div className="camera-tile__sub" style={{ padding: 14 }}>
          No one in the bed for this night. The cameras watched the whole window
          ({night.coverage_minutes} minutes covered) and saw no one sleeping here, so there’s no sleep to report.
        </div>
      </div>
    );
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
  const hasChildOut = visits.some((v) => v.type === 'child_out');
  const hasRoom = visits.some((v) => v.type !== 'child_out');
  const alerts = night.alerts || [];
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
        <RefinedTimes night={night} fmtTime={fmtTime} />
      </div>

      <div className="card">
        <div className="sleep-detail__section-title">Night timeline</div>
        <Timeline night={night} fmtTime={fmtTime} tz={tz} tempUnit={tempUnit} />
        <div className="sleep-legend">
          <span><i className="sleep-legend__sw sleep-seg--asleep" /> Asleep</span>
          <span><i className="sleep-legend__sw sleep-seg--stir" /> Stirring</span>
          <span><i className="sleep-legend__sw sleep-seg--wake" /> Awake</span>
          <span><i className="sleep-legend__sw sleep-seg--awake" /> Before/after sleep</span>
          {hasRoom && <span><i className="sleep-legend__sw sleep-legend__sw--visit" /> Movement outside the bed</span>}
          {hasChildOut && <span><i className="sleep-legend__sw sleep-legend__sw--out" /> Out of bed</span>}
          {(night.transitions || []).length > 0 && (
            <span><i className="sleep-tl__tx sleep-tl__tx--in" style={{ position: 'static', display: 'inline-block', transform: 'none', margin: '0 4px 1px 0', verticalAlign: 'middle' }} /> Got into bed
              <i className="sleep-tl__tx sleep-tl__tx--out" style={{ position: 'static', display: 'inline-block', transform: 'none', margin: '0 4px 0 10px', verticalAlign: 'middle' }} /> Got out of bed</span>
          )}
        </div>
        <ClimateTrack night={night} startMs={utcMs(night.display_start || night.window_start)} endMs={utcMs(night.display_end || night.window_end)} tempUnit={tempUnit} />
      </div>

      <div className="card">
        <div className="sleep-detail__section-title">Wake-ups · {wakes.length}</div>
        {wakes.length === 0 ? (
          <div className="camera-tile__sub" style={{ padding: '2px 2px 4px' }}>No awakenings counted (a stir under 5 minutes doesn’t count).</div>
        ) : (
          <ul className="sleep-wakes">
            {wakes.map((w, i) => (
              <WakeItem key={i} wake={w} hits={alertsInRange(alerts, w.start_at, w.end_at)}
                fmtTime={fmtTime} onPlay={setClipFor} />
            ))}
          </ul>
        )}
      </div>

      {visits.length > 0 && (
        <div className="card">
          <div className="sleep-detail__section-title"><DoorOpen size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Room activity · {visits.length}</div>
          <div className="camera-tile__sub" style={{ margin: '-6px 0 10px' }}>Movement the camera saw away from the bed. Before your child settles and after they get up it&rsquo;s them; in between, it could be them or someone else — the camera can&rsquo;t tell who.</div>
          <ul className="sleep-wakes">
            {visits.map((v, i) => {
              const isOut = v.type === 'child_out';
              return (
                <li key={i} className="sleep-wakes__row">
                  <span className="sleep-wakes__time">{fmtTime(v.start_at)}{v.minutes > 1 ? ` – ${fmtTime(v.end_at)}` : ''}</span>
                  <span className="sleep-visit-right">
                    <span className={`sleep-visit-tag${isOut ? ' sleep-visit-tag--out' : ''}`}>{isOut ? 'Out of bed' : 'Movement outside the bed'}</span>
                    <span className={`sleep-wakes__dur ${isOut ? 'sleep-wakes__dur--out' : 'sleep-wakes__dur--visit'}`}>{fmtDur(v.minutes)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {clipFor && <ClipPlayerModal ev={clipFor} onClose={() => setClipFor(null)} />}
    </>
  );
}

// One wake-up row. Collapsed by default (just time + duration + an alert-count chip); when it has
// correlated alerts you can expand it to see them and play any recorded clip inline. A wake with no
// alerts isn't expandable — it stays a plain row.
function WakeItem({ wake, hits, fmtTime, onPlay }) {
  const [open, setOpen] = useState(false);
  const expandable = hits.length > 0;
  const head = (
    <>
      <span className="sleep-wakes__time">{fmtTime(wake.start_at)} – {fmtTime(wake.end_at)}</span>
      <span className="sleep-wakes__headright">
        <span className="sleep-wakes__dur">{fmtDur(wake.minutes)} awake</span>
        {expandable && (
          <span className="sleep-wakes__badge">
            <Zap size={11} aria-hidden="true" />{hits.length} alert{hits.length === 1 ? '' : 's'}
          </span>
        )}
        {expandable && <ChevronDown size={16} className={`sleep-wakes__chev${open ? ' is-open' : ''}`} aria-hidden="true" />}
      </span>
    </>
  );
  return (
    <li className={`sleep-wakes__item${expandable ? ' sleep-wakes__item--expandable' : ''}`}>
      {expandable ? (
        <button type="button" className="sleep-wakes__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {head}
        </button>
      ) : (
        <div className="sleep-wakes__head">{head}</div>
      )}
      {open && (
        <ul className="sleep-wakes__alerts">
          {hits.map((a) => <AlertRow key={a.id} a={a} fmtTime={fmtTime} onPlay={onPlay} />)}
        </ul>
      )}
    </li>
  );
}

// A single correlated alert inside an expanded wake. Shows the snapshot thumbnail (falling back to a
// type icon) + label + time/camera/detail; when a clip was recorded (clip_status === 'ready') the
// thumbnail becomes a play button that opens the same clip player used in the alert feed.
function AlertRow({ a, fmtTime, onPlay }) {
  const hasClip = a.clip_status === 'ready';
  const thumb = a.snapshot ? (
    <img className="sleep-wakes__thumb" src={api.url(`/cameras/alerts/${a.id}/snapshot`)} alt="" loading="lazy" />
  ) : (
    <span className="sleep-wakes__thumb sleep-wakes__thumb--empty" aria-hidden="true"><AlertTypeIcon type={a.type} /></span>
  );
  return (
    <li className="sleep-wakes__alert">
      {hasClip ? (
        <button type="button" className="sleep-wakes__thumbwrap" onClick={() => onPlay(a)}
          aria-label={`Play clip from ${a.camera_name || 'camera'}`}>
          {thumb}
          <span className="sleep-wakes__play" aria-hidden="true"><Play size={13} fill="currentColor" /></span>
        </button>
      ) : (
        <span className="sleep-wakes__thumbwrap">{thumb}</span>
      )}
      <div className="sleep-wakes__alert-body">
        <span className="sleep-wakes__alert-label">{alertLabel(a.type)}{a.clip_status === 'pending' ? ' · recording…' : ''}</span>
        <span className="sleep-wakes__alert-meta">
          {fmtTime(a.created_at)}{a.camera_name ? ` · ${a.camera_name}` : ''}{a.detail ? ` · ${a.detail}` : ''}
        </span>
      </div>
    </li>
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

// The headline times now come from bed entry/exit detection where a real transition supports them. This
// strip shows what movement & sound ALONE would have reported, and only when the two differ — so the two
// methods can still be compared each morning now that the better one is the default. Older nights
// (computed before the promotion) have no *_algo values and simply show nothing.
function RefinedTimes({ night, fmtTime }) {
  const onsetDiff = night.onset_at_algo && night.onset_at_algo !== night.onset_at;
  const wakeDiff = night.wake_at_algo && night.wake_at_algo !== night.wake_at;
  if (!onsetDiff && !wakeDiff) return null;
  return (
    <div className="sleep-refined">
      <span className="sleep-refined__label"><DoorOpen size={13} aria-hidden="true" /> Movement-only estimate</span>
      {onsetDiff && (
        <span className="sleep-refined__item">
          Asleep <span className="sleep-refined__old">{fmtTime(night.onset_at_algo)}</span><b>{fmtTime(night.onset_at)}</b>
        </span>
      )}
      {wakeDiff && (
        <span className="sleep-refined__item">
          Woke <span className="sleep-refined__old">{fmtTime(night.wake_at_algo)}</span><b>{night.wake_at ? fmtTime(night.wake_at) : '—'}</b>
        </span>
      )}
      <span className="sleep-refined__note">The times above use bed entry/exit detection. Struck through is what movement &amp; sound alone would have reported.</span>
    </div>
  );
}

// The to-scale bar: each segment positioned by its share of the window, plus hour tick labels and
// onset/wake markers so the wake-ups read against a real time axis.
function Timeline({ night, fmtTime, tz, tempUnit }) {
  // The bar spans the night that was actually SLEPT, which can start before the configured window — see
  // display_start in sleepAnalysis. Falls back to the window for an older payload that has neither.
  const startMs = utcMs(night.display_start || night.window_start);
  const endMs = utcMs(night.display_end || night.window_end);
  const totalMs = Math.max(1, endMs - startMs);
  const segs = night.segments || [];

  // Hover bubble: as the cursor (or a finger) moves across the bar, show the time under it, the sleep
  // status at that moment, and — if the room had a sensor — the temperature then. `null` = not hovering.
  const barRef = useRef(null);
  const [hover, setHover] = useState(null);

  const tempSeries = useMemo(
    () => (night.climate?.series || []).filter((p) => p.temperature != null).map((p) => ({ ms: utcMs(p.t), c: p.temperature })),
    [night]
  );
  const toF = tempUnit === 'F';
  const tempUnitLabel = `°${tempUnit || 'C'}`;

  function stateAt(ms) {
    const s = segs.find((seg) => utcMs(seg.from_at) <= ms && ms < utcMs(seg.to_at));
    return (s || segs[ms >= endMs ? segs.length - 1 : 0] || {}).state;
  }
  function tempAt(ms) {
    if (!tempSeries.length) return null;
    let best = tempSeries[0];
    for (const p of tempSeries) if (Math.abs(p.ms - ms) < Math.abs(best.ms - ms)) best = p;
    // Only report a nearby reading (within ~10 min) so we don't label a gap with a far-off temperature.
    if (Math.abs(best.ms - ms) > 10 * 60000) return null;
    const c = best.c;
    return `${(toF ? (c * 9) / 5 + 32 : c).toFixed(1)}${tempUnitLabel}`;
  }
  const fmtMs = (ms) => new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

  function updateHover(clientX) {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const ms = startMs + f * totalMs;
    setHover({ pct: f * 100, time: fmtMs(ms), status: labelFor(stateAt(ms)), temp: tempAt(ms) });
  }

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
  // Bed entry/exit transitions — clamp to [0,100] since the morning exit can land just past the window
  // end (the shadow-wake lookahead), and drop any that fall well outside the bar.
  const transitions = (night.transitions || [])
    .map((t) => ({ ...t, pct: pctOf(t.at, startMs, totalMs) }))
    .filter((t) => t.pct != null && t.pct >= -1 && t.pct <= 101)
    .map((t) => ({ ...t, pct: Math.max(0, Math.min(100, t.pct)) }));

  return (
    <div className="sleep-tl">
      {/* Moment markers: ▼ got into bed / ▲ got out of bed, from the frame-diff detector. These are
          instants; the round markers below are spans, which is why the wording differs. */}
      {transitions.length > 0 && (
        <div className="sleep-tl__txs">
          {transitions.map((t, i) => (
            <span key={i} className={`sleep-tl__tx ${t.type === 'into_bed' ? 'sleep-tl__tx--in' : 'sleep-tl__tx--out'}`}
              style={{ left: `${t.pct}%` }}
              title={`${t.type === 'into_bed' ? 'Got into bed' : 'Got out of bed'} · ${fmtTime(t.at)}`} />
          ))}
        </div>
      )}
      {/* Room-activity (outside-bed) markers sit above the bar so they read as events, not sleep state. */}
      {visits.length > 0 && (
        <div className="sleep-tl__visits">
          {visits.map((v, i) => (
            <span key={i} className={`sleep-tl__visit${v.type === 'child_out' ? ' sleep-tl__visit--out' : ''}`}
              style={{ left: `${pctOf(v.start_at, startMs, totalMs)}%` }}
              title={`${v.type === 'child_out' ? 'Out of bed' : 'Movement outside the bed'} · ${fmtTime(v.start_at)}`} />
          ))}
        </div>
      )}
      <div className="sleep-tl__barwrap" ref={barRef}
        onMouseMove={(e) => updateHover(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => updateHover(e.touches[0].clientX)}
        onTouchMove={(e) => updateHover(e.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
      >
        <div className="sleep-tl__bar">
          {segs.map((s, i) => (
            <div key={i} className={`sleep-seg ${SEG_CLASS[s.state] || 'sleep-seg--awake'}`}
              style={{ width: `${(s.minutes / (totalMs / 60000)) * 100}%` }} />
          ))}
          {onsetPct != null && <span className="sleep-tl__mark" style={{ left: `${onsetPct}%` }} />}
          {wakePct != null && <span className="sleep-tl__mark" style={{ left: `${wakePct}%` }} />}
          {nowPct != null && <span className="sleep-tl__now" style={{ left: `${nowPct}%` }} title="as of now" />}
        </div>
        {hover && (
          <div className="sleep-tl__tip" style={{ left: `${hover.pct}%` }} aria-hidden="true">
            <span className="sleep-tl__tip-time">{hover.time}</span>
            <span className="sleep-tl__tip-status">{hover.status}</span>
            {hover.temp && <span className="sleep-tl__tip-temp"><Thermometer size={11} aria-hidden="true" />{hover.temp}</span>}
          </div>
        )}
        {hover && <span className="sleep-tl__cursor" style={{ left: `${hover.pct}%` }} aria-hidden="true" />}
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

// A companion track under the sleep bar: room temperature across the same time axis, so you can read a
// wake against how warm the room was. Line is positioned by each reading's real timestamp (not index),
// keeping it aligned to the timeline above. Temperature is stored in Celsius; converted to the user's
// unit here. Draws nothing when the child's cameras have no sensor (or too few readings).
function ClimateTrack({ night, startMs, endMs, tempUnit }) {
  const climate = night.climate;
  const series = (climate?.series || []).filter((p) => p.temperature != null);
  if (series.length < 2) return null;
  const totalMs = Math.max(1, endMs - startMs);
  const toF = tempUnit === 'F';
  const conv = (c) => (toF ? (c * 9) / 5 + 32 : c);
  const unit = `°${tempUnit || 'C'}`;
  const vals = series.map((p) => conv(p.temperature));
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 1) { min -= 0.5; max += 0.5; } // don't pin a near-flat night to the edges
  const span = max - min;
  const H = 46;
  const coords = series.map((p) => {
    const x = Math.max(0, Math.min(100, ((utcMs(p.t) - startMs) / totalMs) * 100));
    const y = H - 5 - ((conv(p.temperature) - min) / span) * (H - 10);
    return [x, y];
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${d} L${coords[coords.length - 1][0].toFixed(2)} ${H} L${coords[0][0].toFixed(2)} ${H} Z`;

  const fmt1 = (c) => conv(c).toFixed(1);
  const caption = [`avg ${fmt1(climate.temp_avg)}${unit}`];
  if (climate.temp_min != null && climate.temp_max != null) caption.push(`${fmt1(climate.temp_min)}–${fmt1(climate.temp_max)}${unit}`);
  if (climate.humidity_avg != null) caption.push(`${climate.humidity_avg}% humidity`);

  return (
    <div className="sleep-climate">
      <div className="sleep-climate__head">
        <span className="sleep-climate__label"><Thermometer size={13} aria-hidden="true" /> Room temperature</span>
        <span className="sleep-climate__caption">{caption.join(' · ')}</span>
      </div>
      <div className="sleep-climate__chart">
        <svg width="100%" height={H} viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={area} fill="var(--sleep-temp)" opacity="0.12" />
          <path d={d} fill="none" stroke="var(--sleep-temp)" strokeWidth="2" vectorEffect="non-scaling-stroke"
            strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span className="sleep-climate__hi">{max.toFixed(1)}{unit}</span>
        <span className="sleep-climate__lo">{min.toFixed(1)}{unit}</span>
      </div>
    </div>
  );
}

// Phase 5: temperature ↔ sleep correlation across this child's recent nights. Fetched once per child
// (not per night). Only renders something meaningful once there are enough tracked nights; otherwise it
// nudges to keep tracking (or stays hidden when tracking is off / there's no sensor data at all).
function SleepInsights({ childId, tempUnit, childName }) {
  const [ins, setIns] = useState(undefined); // undefined = loading

  useEffect(() => {
    let alive = true;
    api.get(`/children/${childId}/sleep/insights`)
      .then((r) => { if (alive) setIns(r || null); })
      .catch(() => { if (alive) setIns(null); });
    return () => { alive = false; };
  }, [childId]);

  if (ins === undefined || !ins || ins.status === 'off') return null;

  const toF = tempUnit === 'F';
  const unit = `°${tempUnit || 'C'}`;
  const t = (c) => (c == null ? '' : `${(toF ? (c * 9) / 5 + 32 : c).toFixed(1)}${unit}`);
  const name = childName || 'this child';

  if (ins.status === 'insufficient') {
    // Don't show the card at all until there's at least one tracked night — nothing useful to say yet.
    if (!ins.nights_analyzed) return null;
    return (
      <div className="card sleep-insight">
        <div className="sleep-insight__title"><Sparkles size={15} aria-hidden="true" /> Sleep &amp; room temperature</div>
        <div className="sleep-insight__body">
          Collecting nights — after about {ins.min_nights} tracked nights this will compare {name}’s wake-ups on
          warmer vs cooler nights. {ins.nights_analyzed} so far.
        </div>
      </div>
    );
  }

  const warm = ins.warmer;
  const cool = ins.cooler;
  let headline;
  if (ins.verdict === 'warm_more_wakes') headline = `Warmer nights tend to mean more wake-ups for ${name}.`;
  else if (ins.verdict === 'warm_fewer_wakes') headline = `Warmer nights actually saw fewer wake-ups for ${name}.`;
  else if (ins.verdict === 'flat') headline = `Room temperature barely changed across these nights, so there’s no clear link to report yet.`;
  else headline = `No clear link between room temperature and ${name}’s wake-ups over these ${ins.nights_analyzed} nights.`;

  return (
    <div className="card sleep-insight">
      <div className="sleep-insight__title"><Sparkles size={15} aria-hidden="true" /> Sleep &amp; room temperature</div>
      <div className="sleep-insight__headline">{headline}</div>
      {warm && cool && ins.verdict !== 'flat' && (
        <div className="sleep-insight__cmp">
          <div className="sleep-insight__col">
            <div className="sleep-insight__col-h"><Thermometer size={13} aria-hidden="true" /> Cooler nights</div>
            <div className="sleep-insight__temp">{t(cool.avg_temp)}</div>
            <div className="sleep-insight__metric">{cool.avg_wakes} wake-ups avg</div>
            <div className="sleep-insight__sub">{fmtDur(cool.avg_asleep_minutes)} asleep · {cool.nights} night{cool.nights === 1 ? '' : 's'}</div>
          </div>
          <div className="sleep-insight__col">
            <div className="sleep-insight__col-h sleep-insight__col-h--warm"><Thermometer size={13} aria-hidden="true" /> Warmer nights</div>
            <div className="sleep-insight__temp">{t(warm.avg_temp)}</div>
            <div className="sleep-insight__metric">{warm.avg_wakes} wake-ups avg</div>
            <div className="sleep-insight__sub">{fmtDur(warm.avg_asleep_minutes)} asleep · {warm.nights} night{warm.nights === 1 ? '' : 's'}</div>
          </div>
        </div>
      )}
      <div className="sleep-insight__foot">
        Based on {ins.nights_analyzed} tracked nights{ins.overall?.avg_humidity != null ? ` · ${ins.overall.avg_humidity}% avg humidity` : ''}.
        A pattern, not a cause — lots of things affect sleep.
      </div>
    </div>
  );
}

// --- small helpers ---
const utcMs = (s) => new Date(String(s).replace(' ', 'T') + 'Z').getTime();

// Detection alerts that fired within a wake's window, allowing a few minutes either side (a wake run is
// trimmed to its active minutes, and an alert can fire just before/after). Keeps ascending order.
const ALERT_MARGIN_MS = 3 * 60000;
function alertsInRange(alerts, startAt, endAt) {
  const s = utcMs(startAt) - ALERT_MARGIN_MS;
  const e = utcMs(endAt) + ALERT_MARGIN_MS;
  return alerts.filter((a) => {
    const t = utcMs(a.created_at);
    return t >= s && t <= e;
  });
}
const alertLabel = (type) => (type === 'sound' ? 'Sound' : type === 'motion' ? 'Motion' : type || 'Alert');
function AlertTypeIcon({ type }) {
  const Icon = type === 'sound' ? AudioLines : Zap;
  return <Icon size={13} className="sleep-wakes__alert-ico" aria-hidden="true" />;
}

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
