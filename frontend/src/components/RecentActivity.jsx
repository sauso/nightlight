import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// A compact "latest alerts" list for the Live screen — the quick cross-child glance that used to be
// the Alerts tab. Only polls while Live is on screen (LiveMonitor stays mounted all session). Full
// per-child history lives on each child's detail screen.
const TYPE_LABEL = { motion: 'Motion', sound: 'Sound' };
const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
function relTime(d) {
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function RecentActivity({ active }) {
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    async function load() {
      try {
        const a = await api.get('/cameras/alerts');
        if (live) setAlerts((Array.isArray(a) ? a : []).slice(0, 4));
      } catch { /* ignore — leave as-is */ }
    }
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
  }, [active]);

  if (alerts.length === 0) return null;

  return (
    <>
      <div className="section-title">Recent activity</div>
      <ul className="alert-feed">
        {alerts.map((ev) => {
          const when = parseUtc(ev.created_at);
          return (
            <li key={ev.id} className="alert-feed__row card">
              {ev.snapshot
                ? <img className="alert-feed__thumb" src={api.url(`/cameras/alerts/${ev.id}/snapshot`)} alt="" loading="lazy" />
                : <span className="alert-feed__dot event-log__dot" aria-hidden="true" />}
              <div className="alert-feed__body">
                <div className="alert-feed__line">
                  <span className="alert-feed__camera">{ev.camera_name}</span>
                  <span className="event-log__type">{TYPE_LABEL[ev.type] || ev.type}</span>
                </div>
                {ev.detail && <div className="event-log__detail">{ev.detail}</div>}
              </div>
              <time className="alert-feed__time" dateTime={when.toISOString()} title={when.toLocaleString()}>{relTime(when)}</time>
            </li>
          );
        })}
      </ul>
    </>
  );
}
