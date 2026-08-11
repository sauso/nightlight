import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Modal from '../components/Modal.jsx';

// Detection alerts (motion now, sound later) — see backend lib/detectionEvents.js.
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
  return `${Math.round(hours / 24)}d ago`;
}

// Top-level Alerts feed. Unlike the old admin-only "Recent alerts" (which lived under
// Settings → Logs), this is reachable by every signed-in user — a caregiver is exactly who
// wants the feed. The underlying GET /cameras/alerts already allows any authenticated user;
// only clearing the history is admin-only.
export default function Alerts() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [alerts, setAlerts] = useState([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);

  async function load() {
    try {
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
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

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
    <>
      <AppHeader title="Alerts" />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}

        {loaded && alerts.length === 0 && !error ? (
          <div className="empty-state">
            <Bell size={28} aria-hidden="true" style={{ opacity: 0.5, marginBottom: 8 }} />
            <div>No alerts yet.</div>
            <div className="camera-tile__sub" style={{ marginTop: 4 }}>
              When a camera with motion detection sees sustained movement, it shows up here.
            </div>
          </div>
        ) : (
          <ul className="alert-feed">
            {alerts.map((ev) => {
              const meta = TYPE_META[ev.type] || { label: ev.type, className: '' };
              const when = parseUtc(ev.created_at);
              return (
                <li key={ev.id} className="alert-feed__row card">
                  {/* Snapshot thumbnail — rendered when the event has a stored image. Persisting
                      the alert-time image per event is a follow-up; until then ev.snapshot is
                      absent and the row shows the type dot instead. */}
                  {ev.snapshot ? (
                    <img
                      className="alert-feed__thumb"
                      src={api.url(`/cameras/alerts/${ev.id}/snapshot`)}
                      alt={`${ev.camera_name} snapshot`}
                      loading="lazy"
                    />
                  ) : (
                    <span className={`alert-feed__dot event-log__dot ${meta.className}`} aria-hidden="true" />
                  )}
                  <div className="alert-feed__body">
                    <div className="alert-feed__line">
                      <span className="alert-feed__camera">{ev.camera_name}</span>
                      <span className="event-log__type">{meta.label}</span>
                    </div>
                    {ev.detail && <div className="event-log__detail">{ev.detail}</div>}
                  </div>
                  <time
                    className="alert-feed__time"
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

        {isAdmin && alerts.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            style={{ marginTop: 6 }}
            onClick={() => setConfirming(true)}
          >
            Clear alert history
          </button>
        )}
      </main>

      {confirming && (
        <Modal title="Clear alerts" placement="top" onClose={() => (clearBusy ? null : setConfirming(false))}>
          <p style={{ marginTop: 0 }}>
            Clear all alerts? This permanently deletes the alert history and can't be undone.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setConfirming(false)} disabled={clearBusy}>
              Cancel
            </button>
            <button className="btn btn-danger" type="button" onClick={doClear} disabled={clearBusy}>
              {clearBusy ? 'Clearing…' : 'Clear alerts'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
