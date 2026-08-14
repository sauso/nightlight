import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Moon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import CameraRow from '../components/CameraRow.jsx';
import AlertList from '../components/AlertList.jsx';
import { ageLabel } from '../lib/age.js';

// A child's hub: their identity + (later) last night's sleep, then their cameras and their alerts.
// Tapping the avatar opens Child settings (name / birthday / colour / photo). Alerts are filtered
// to this child's cameras client-side via each event's camera_id.

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
            <Avatar name={kid.name} src={kid.photo} color={kid.color} size={100} />
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
        {alerts.length === 0
          ? <div className="empty-state" style={{ padding: 20 }}>No alerts for {kid.name} yet.</div>
          : <AlertList alerts={alerts} />}
      </main>
    </>
  );
}
