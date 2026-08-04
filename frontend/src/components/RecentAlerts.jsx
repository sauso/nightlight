import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';

// Detection alerts (motion now, sound later) — see backend lib/detectionEvents.js ALERT.
const TYPE_META = {
  motion: { label: 'Motion', className: 'event-log__dot--motion' },
  sound: { label: 'Sound', className: 'event-log__dot--sound' },
};

// SQLite stores created_at as UTC — parse as UTC, render in the viewer's local time.
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

export default function RecentAlerts() {
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  async function load() {
    try {
      // /cameras/alerts returns the array directly (unlike /events, which wraps it).
      const fresh = await api.get('/cameras/alerts');
      setAlerts(Array.isArray(fresh) ? fresh : []);
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

  async function doClear() {
    setClearBusy(true);
    try {
      await api.del('/cameras/alerts');
      setConfirming(false);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setClearBusy(false);
    }
  }

  return (
    <div className="event-log">
      <div className="log-viewer__toolbar">
        <label className="log-viewer__toggle">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="icon-btn" onClick={load}>Refresh now</button>
          <button type="button" className="icon-btn" onClick={() => setConfirming(true)}>Clear log</button>
        </div>
      </div>

      {confirming && (
        <Modal title="Clear recent alerts" placement="top" onClose={() => (clearBusy ? null : setConfirming(false))}>
          <p style={{ marginTop: 0 }}>
            Clear all recent alerts? This permanently deletes the alert history and can't be undone.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setConfirming(false)} disabled={clearBusy}>
              Cancel
            </button>
            <button className="btn btn-danger" type="button" onClick={doClear} disabled={clearBusy}>
              {clearBusy ? 'Clearing…' : 'Clear log'}
            </button>
          </div>
        </Modal>
      )}

      {error && <div className="error-banner">{error}</div>}

      {loaded && alerts.length === 0 && !error ? (
        <div className="event-log__empty">
          No alerts yet. When a camera with motion detection enabled sees sustained movement,
          it shows up here.
        </div>
      ) : (
        <ul className="event-log__list">
          {alerts.map((ev) => {
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
                <time className="event-log__time" dateTime={when.toISOString()} title={when.toLocaleString()}>
                  {relativeTime(when)}
                </time>
              </li>
            );
          })}
        </ul>
      )}

      <div className="camera-tile__sub" style={{ marginTop: 6 }}>
        Movement detected on your cameras (kept for up to 30 days). Enable and tune motion
        detection per camera in Cameras → edit.
      </div>
    </div>
  );
}
