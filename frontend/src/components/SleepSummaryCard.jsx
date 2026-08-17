import { useEffect, useState } from 'react';
import { Moon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';

// "Last night" sleep summary shown in the Child detail hero (replaces the old "coming soon" slot).
// Reads the most recent stored sleep_nights row (computed nightly by the server) and formats it. This
// is a sleep-PATTERN estimate from movement + noise — never a medical claim — worded softly to match.

function fmtDur(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export default function SleepSummaryCard({ childId }) {
  const { settings } = useSettings();
  const tz = settings.timezone || 'UTC';
  const [night, setNight] = useState(undefined); // undefined = loading, null = none

  useEffect(() => {
    let alive = true;
    api.get(`/children/${childId}/sleep?nights=1`)
      .then((r) => { if (alive) setNight((r?.nights && r.nights[0]) || null); })
      .catch(() => { if (alive) setNight(null); });
    return () => { alive = false; };
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

  let body;
  if (night === undefined) {
    body = <div className="night__soon">Loading last night…</div>;
  } else if (!night || night.status === 'no_data') {
    body = (
      <div className="night__soon">
        Once a camera with motion or sound detection runs overnight, last night’s sleep shows here.
      </div>
    );
  } else if (night.status === 'no_sleep') {
    body = (
      <>
        <div className="night__sleep-head">Last night · {fmtDate(night.night_date)}</div>
        <div className="night__soon">No clear sleep detected overnight.</div>
      </>
    );
  } else {
    const range = night.wake_at
      ? `${fmtTime(night.onset_at)} – ${fmtTime(night.wake_at)}`
      : `from ${fmtTime(night.onset_at)} · still asleep at ${fmtTime(night.window_end)}`;
    const bits = [range];
    if (night.wake_count != null) bits.push(`${night.wake_count} wake-up${night.wake_count === 1 ? '' : 's'}`);
    if (night.longest_stretch_minutes) bits.push(`longest ${fmtDur(night.longest_stretch_minutes)}`);
    body = (
      <>
        <div className="night__sleep-head">Last night · {fmtDate(night.night_date)}</div>
        <div className="night__sleep-big">{fmtDur(night.asleep_minutes)} asleep</div>
        <div className="night__soon">{bits.join(' · ')}</div>
        <div className="night__est">Estimated from movement &amp; sound — not a medical measurement.</div>
      </>
    );
  }

  return (
    <div className="night__sleep">
      <Moon size={18} aria-hidden="true" />
      <div>{body}</div>
    </div>
  );
}
