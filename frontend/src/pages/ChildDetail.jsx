import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useAuth } from '../lib/AuthContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import Modal from '../components/Modal.jsx';
import CameraRow from '../components/CameraRow.jsx';
import AlertList from '../components/AlertList.jsx';
import SensorHistoryCard from '../components/SensorHistoryCard.jsx';
import SleepSummaryCard from '../components/SleepSummaryCard.jsx';
import TimelapseCard from '../components/TimelapseCard.jsx';
import RecordingsCard from '../components/RecordingsCard.jsx';
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
  const [photoOpen, setPhotoOpen] = useState(false);

  async function loadAlerts() {
    const camIds = new Set(cameras.filter((c) => c.child_id === id).map((c) => c.id));
    try {
      const all = await api.get('/cameras/alerts');
      setAlerts((Array.isArray(all) ? all : []).filter((ev) => camIds.has(ev.camera_id)).slice(0, 20));
    } catch { /* ignore — feed just stays as-is */ }
  }

  useEffect(() => {
    loadAlerts();
    const t = setInterval(loadAlerts, 15000);
    return () => clearInterval(t);
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
          <div className="night__head">
            <button
              type="button"
              className="night__avatar-btn"
              onClick={() => (kid.photo ? setPhotoOpen(true) : navigate(`/children/${id}/edit`))}
              aria-label={kid.photo ? `View ${kid.name}'s photo` : `Add a photo for ${kid.name}`}
            >
              <Avatar name={kid.name} src={kid.photo} color={kid.color} size={100} />
            </button>
            <button type="button" className="night__id-btn" onClick={() => navigate(`/children/${id}/edit`)}>
              <span className="night__name">{kid.name}</span>
              <span className="night__age">{age || 'Tap to add birthday & photo'}</span>
            </button>
            <button type="button" className="night__edit" onClick={() => navigate(`/children/${id}/edit`)}>Edit ›</button>
          </div>
          <SleepSummaryCard childId={id} />
        </div>

        <TimelapseCard childId={id} />
        <RecordingsCard childId={id} />

        {childCams.filter((c) => c.mqtt_topic).map((c) => (
          <SensorHistoryCard key={c.id} camera={c} />
        ))}

        <div className="card tight">
          <div className="card-title">Cameras · {childCams.length}</div>
          {childCams.map((c) => (
            <CameraRow
              key={c.id}
              cam={c}
              onClick={isAdmin ? () => navigate(`/cameras/${c.id}`, { state: { from: { to: `/children/${id}`, label: kid.name } } }) : undefined}
            />
          ))}
          {childCams.length === 0 && (
            <div className="camera-tile__sub">No cameras assigned yet — assign one from the Cameras tab.</div>
          )}
        </div>

        {alerts.length === 0 ? (
          <div className="card">
            <div className="card-title">Recent alerts</div>
            <div className="camera-tile__sub">No alerts for {kid.name} yet.</div>
          </div>
        ) : (
          <AlertList alerts={alerts} onChanged={loadAlerts} title="Recent alerts" />
        )}
      </main>

      {photoOpen && kid.photo && (
        <Modal title={kid.name} onClose={() => setPhotoOpen(false)}>
          <img className="photo-full" src={kid.photo} alt={kid.name} />
        </Modal>
      )}
    </>
  );
}
