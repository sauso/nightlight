import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Moon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import CameraRow from '../components/CameraRow.jsx';

// A child's hub: their identity + (later) last night's sleep, then their cameras and their alerts.
// Tapping the avatar opens Child settings (name / birthday / colour / photo). Alerts are filtered
// to this child's cameras client-side via each event's camera_id.
function ageLabel(birthday) {
  if (!birthday) return null;
  const b = new Date(birthday + 'T00:00:00');
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months -= 1;
  if (months < 0) return null;
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`;
  return `${Math.floor(months / 12)} year${Math.floor(months / 12) === 1 ? '' : 's'}`;
}

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

export default function ChildDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { kids, cameras } = useCameras();
  const kid = kids.find((k) => k.id === id);
  const childCams = cameras.filter((c) => c.child_id === id);
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    const camIds = new Set(cameras.filter((c) => c.child_id === id).map((c) => c.id));
    let live = true;
    async function load() {
      try {
        const all = await api.get('/cameras/alerts');
        if (live) setAlerts((Array.isArray(all) ? all : []).filter((ev) => camIds.has(ev.camera_id)).slice(0, 20));
      } catch { /* ignore — feed just stays as-is */ }
    }
    load();
    const t = setInterval(load, 15000);
    return () => { live = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cameras.length]);

  if (!kid) {
    return (
      <>
        <AppHeader title="Child" back={{ to: '/children', label: 'Children' }} />
        <main className="app-main"><div className="empty-state">Loading…</div></main>
      </>
    );
  }
  const age = ageLabel(kid.birthday);

  return (
    <>
      <AppHeader title={kid.name} back={{ to: '/children', label: 'Children' }} />
      <main className="app-main">
        <div className="night">
          <button className="night__head" onClick={() => navigate(`/children/${id}/edit`)} aria-label={`Edit ${kid.name}`}>
            <Avatar name={kid.name} src={kid.photo} color={kid.color} size={64} />
            <span className="night__id">
              <span className="night__name">{kid.name}</span>
              <span className="night__age">{age || 'Tap to add birthday & photo'}</span>
            </span>
            <span className="night__edit">Edit ›</span>
          </button>
          <div className="night__sleep">
            <Moon size={18} aria-hidden="true" />
            <div>
              <div style={{ fontWeight: 600 }}>Sleep summary</div>
              <div className="night__soon">Coming soon — once sleep tracking is on, last night's sleep shows here.</div>
            </div>
          </div>
        </div>

        <div className="section-title">Cameras · {childCams.length}</div>
        <div className="card tight">
          {childCams.map((c) => (
            <CameraRow
              key={c.id}
              cam={c}
              onClick={isAdmin ? () => navigate(`/cameras/${c.id}`, { state: { from: { to: `/children/${id}`, label: kid.name } } }) : undefined}
            />
          ))}
          {childCams.length === 0 && (
            <div className="camera-tile__sub" style={{ padding: 14 }}>No cameras assigned yet — assign one from the Cameras tab.</div>
          )}
        </div>

        <div className="section-title">Recent alerts</div>
        {alerts.length === 0 ? (
          <div className="empty-state" style={{ padding: 20 }}>No alerts for {kid.name} yet.</div>
        ) : (
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
        )}
      </main>
    </>
  );
}
