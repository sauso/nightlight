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
import LoadFailed from '../components/LoadFailed.jsx';
import { loadState } from '../lib/loadState.js';
import SensorHistoryCard from '../components/SensorHistoryCard.jsx';
import SleepSummaryCard from '../components/SleepSummaryCard.jsx';
import TimelapseCard from '../components/TimelapseCard.jsx';
import RecordingsCard from '../components/RecordingsCard.jsx';
import MorningReviewCard from '../components/MorningReviewCard.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { ageLabel } from '../lib/age.js';

// A child's hub: their identity + (later) last night's sleep, then their cameras and their alerts.
// Tapping the avatar opens Child settings (name / birthday / colour / photo). Alerts are filtered
// to this child's cameras client-side via each event's camera_id.

export default function ChildDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { kids, cameras, loaded: camerasLoaded, error: camerasError, refresh: refreshCameras } = useCameras();
  const { settings } = useSettings();
  // Same formatter the sleep card uses, so the card and the review agree to the minute.
  const fmtTime = (utc) => {
    if (!utc) return '';
    const d = new Date(String(utc).replace(' ', 'T') + 'Z');
    return new Intl.DateTimeFormat([], { timeZone: settings?.timezone || undefined, hour: 'numeric', minute: '2-digit' }).format(d);
  };
  const kid = kids.find((k) => k.id === id);
  const childCams = cameras.filter((c) => c.child_id === id);
  const [alerts, setAlerts] = useState([]);
  // Alerts get the same three-way split as every fetched list (#375). A failed fetch used to be swallowed and
  // leave [], which the render below turned into "No alerts for <child> yet" - the same words as a quiet week.
  const [alertsLoaded, setAlertsLoaded] = useState(false);
  const [alertsError, setAlertsError] = useState('');
  const [photoOpen, setPhotoOpen] = useState(false);

  async function loadAlerts() {
    const camIds = new Set(cameras.filter((c) => c.child_id === id).map((c) => c.id));
    try {
      const all = await api.get('/cameras/alerts');
      setAlerts((Array.isArray(all) ? all : []).filter((ev) => camIds.has(ev.camera_id)).slice(0, 20));
      setAlertsLoaded(true);
      setAlertsError('');
    } catch (err) {
      // The last feed stays on screen (stale); the message says so and offers Retry.
      setAlertsError(err?.message || 'Request failed');
    }
  }

  useEffect(() => {
    // The feed is filtered to THIS child's cameras, so asking before the camera list has loaded would filter
    // against an empty set and report a successful "no alerts" that was never true.
    if (!camerasLoaded) return undefined;
    loadAlerts();
    const t = setInterval(loadAlerts, 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cameras.length, camerasLoaded]);

  if (!kid) {
    // Not found only after the list has actually loaded: before that, or after a failed load, the child may
    // well exist and "Loading…" forever (the old behaviour) hid the failure (#375).
    const missing = loadState({ loaded: camerasLoaded, error: camerasError, count: kids.length });
    return (
      <>
        <AppHeader title="Child" back={{ to: '/children', label: 'Children' }} />
        <main className="app-main">
          {missing === 'error' && <LoadFailed what="this child" error={camerasError} onRetry={refreshCameras} />}
          {missing === 'loading' && <div className="empty-state">Loading…</div>}
          {(missing === 'empty' || missing === 'ready' || missing === 'stale') && (
            <div className="empty-state">We couldn’t find this child. Go back to Children and pick one from the list.</div>
          )}
        </main>
      </>
    );
  }
  const alertsState = loadState({ loaded: alertsLoaded, error: alertsError, count: alerts.length });
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

        <MorningReviewCard childId={id} fmtTime={fmtTime} />

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
          {/* Assigning a camera is admin-only (#552), so a caregiver is told who can, not sent to a
              screen where the control is not there for them. */}
          {childCams.length === 0 && (
            <div className="camera-tile__sub">
              {isAdmin
                ? 'No cameras assigned yet — assign one from the Cameras tab.'
                : 'No cameras assigned yet — an admin can assign one from the Cameras tab.'}
            </div>
          )}
        </div>

        {alertsState === 'ready' || alertsState === 'stale' ? (
          <>
            {alertsState === 'stale' && <LoadFailed what="alerts" error={alertsError} onRetry={loadAlerts} stale />}
            <AlertList alerts={alerts} onChanged={loadAlerts} title="Recent alerts" />
          </>
        ) : (
          <div className="card">
            <div className="card-title">Recent alerts</div>
            {alertsState === 'loading' && <div className="camera-tile__sub">Loading…</div>}
            {alertsState === 'error' && <LoadFailed what="alerts" error={alertsError} onRetry={loadAlerts} />}
            {alertsState === 'empty' && <div className="camera-tile__sub">No alerts for {kid.name} yet.</div>}
          </div>
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
