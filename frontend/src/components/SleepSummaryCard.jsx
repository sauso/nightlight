import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Moon, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';

// Sleep summary in the Child detail hero. Reads the LIVE endpoint: while a night is in progress it shows
// "Tonight · so far" (recomputed on demand, capped at now — so a morning wake shows within a minute or
// two of it happening), otherwise the last completed "Last night". A sleep-PATTERN estimate from
// movement + sound, never a medical claim. The whole card is a button into the Sleep detail page.

function fmtDur(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export default function SleepSummaryCard({ childId }) {
  const { settings } = useSettings();
  const navigate = useNavigate();
  const tz = settings.timezone || 'UTC';
  const [data, setData] = useState(undefined); // undefined = loading; { scope, night } | null

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.get(`/children/${childId}/sleep/live`)
        .then((r) => { if (alive) setData(r || null); })
        .catch(() => { if (alive) setData(null); });
    load();
    // Refresh every few minutes so an in-progress night stays current (e.g. the morning wake appears).
    const t = setInterval(load, 3 * 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [childId]);

  const fmtTime = (utc) => {
    if (!utc) return '';
    const d = new Date(String(utc).replace(' ', 'T') + 'Z');
    return new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  };
  const fmtDate = (nightDate) => {
    if (!nightDate) return '';
    const d = new Date(String(nightDate) + 'T00:00:00');
    return new Intl.DateTimeFormat([], { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  };

  const scope = data?.scope;
  const night = data?.night;
  const tonight = scope === 'tonight';

  let body;
  if (data === undefined) {
    body = <div className="night__soon">Loading sleep…</div>;
  } else if (!night || night.status === 'no_data') {
    body = tonight ? (
      <>
        <div className="night__sleep-head">Tonight</div>
        <div className="night__soon">Tracking tonight — sleep will show here once there’s enough overnight data.</div>
      </>
    ) : (
      <div className="night__soon">
        Once a camera with motion or sound detection runs overnight, last night’s sleep shows here.
      </div>
    );
  } else if (night.status === 'no_sleep') {
    body = (
      <>
        <div className="night__sleep-head">{tonight ? 'Tonight' : `Last night · ${fmtDate(night.night_date)}`}</div>
        <div className="night__soon">{tonight ? 'Not asleep yet.' : 'No clear sleep detected overnight.'}</div>
      </>
    );
  } else {
    // status ok
    const head = tonight ? 'Tonight · so far' : `Last night · ${fmtDate(night.night_date)}`;
    let range;
    if (tonight) {
      range = night.wake_at
        ? `awake since ${fmtTime(night.wake_at)}`
        : `asleep since ${fmtTime(night.onset_at)}`;
    } else {
      range = night.wake_at
        ? `${fmtTime(night.onset_at)} – ${fmtTime(night.wake_at)}`
        : `from ${fmtTime(night.onset_at)} · still asleep at ${fmtTime(night.window_end)}`;
    }
    const bits = [range];
    if (night.wake_count != null) bits.push(`${night.wake_count} wake-up${night.wake_count === 1 ? '' : 's'}`);
    if (night.longest_stretch_minutes) bits.push(`longest ${fmtDur(night.longest_stretch_minutes)}`);
    body = (
      <>
        <div className="night__sleep-head">{head}</div>
        <div className="night__sleep-big">{fmtDur(night.asleep_minutes)} asleep{tonight ? ' so far' : ''}</div>
        <div className="night__soon">{bits.join(' · ')}</div>
        <div className="night__est">Estimated from movement &amp; sound — not a medical measurement.</div>
      </>
    );
  }

  // The whole card is a button into the Sleep detail page (timeline + wake breakdown + date picker).
  // Clickable even with no data, so you can still browse other nights via the date picker there.
  return (
    <button type="button" className="night__sleep night__sleep--btn" onClick={() => navigate(`/children/${childId}/sleep`)}
      aria-label="View sleep detail and history">
      <Moon size={18} aria-hidden="true" />
      <div className="night__sleep-body">{body}</div>
      <ChevronRight size={18} aria-hidden="true" className="night__sleep-chev" />
    </button>
  );
}
