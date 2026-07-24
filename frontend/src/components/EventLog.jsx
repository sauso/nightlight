import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Human-facing labels/colors for each event type the backend records (see
// lib/cameraEvents.js EVENT). Anything unrecognized falls back to a neutral style so a
// future event type never renders blank.
const TYPE_META = {
  offline: { label: 'Offline', className: 'event-log__dot--offline' },
  online: { label: 'Back online', className: 'event-log__dot--online' },
  restart: { label: 'Restarted', className: 'event-log__dot--restart' },
};

// SQLite stores created_at as UTC ("YYYY-MM-DD HH:MM:SS", no zone) - parse it as UTC and
// let the browser render it in the viewer's own local time.
function parseUtc(s) {
  return new Date(s.replace(' ', 'T') + 'Z');
}

function relativeTime(date) {
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export default function EventLog() {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  async function load() {
    try {
      const { events: fresh } = await api.get('/events');
      setEvents(fresh);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  return (
    <div className="event-log">
      <div className="log-viewer__toolbar">
        <label className="log-viewer__toggle">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh
        </label>
        <button type="button" className="icon-btn" onClick={load}>Refresh now</button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loaded && events.length === 0 && !error ? (
        <div className="event-log__empty">
          No camera events recorded yet. Drop-outs, recoveries, and restarts will show up
          here as they happen.
        </div>
      ) : (
        <ul className="event-log__list">
          {events.map((ev) => {
            const meta = TYPE_META[ev.type] || { label: ev.type, className: '' };
            const when = parseUtc(ev.created_at);
            return (
              <li key={ev.id} className="event-log__row">
                <span className={`event-log__dot ${meta.className}`} aria-hidden="true" />
                <div className="event-log__body">
                  <div className="event-log__line">
                    <span className="event-log__camera">{ev.camera_name}</span>
                    <span className="event-log__type">{meta.label}</span>
                  </div>
                  {ev.detail && <div className="event-log__detail">{ev.detail}</div>}
                </div>
                <time
                  className="event-log__time"
                  dateTime={when.toISOString()}
                  title={when.toLocaleString()}
                >
                  {relativeTime(when)}
                </time>
              </li>
            );
          })}
        </ul>
      )}

      <div className="camera-tile__sub" style={{ marginTop: 6 }}>
        Camera up/down and restart history (kept for up to 30 days). A drop that shows here
        was real - every device saw it. A camera that looks stuck on only one phone, with
        nothing here, is usually that phone's connection - reopen the app. See
        <code>KNOWN-ISSUES.md</code> for more.
      </div>
    </div>
  );
}
