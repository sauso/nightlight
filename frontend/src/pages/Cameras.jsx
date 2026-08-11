import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useCameras } from '../lib/CamerasContext.jsx';
import Modal from '../components/Modal.jsx';
import BreathingDot from '../components/BreathingDot.jsx';
import AppHeader from '../components/AppHeader.jsx';

// Cameras management list. Editing/adding a camera now happens on its own routed screen
// (CameraSettings.jsx) rather than a modal — this page keeps the at-a-glance list plus the
// quick inline actions (assign to a child, enable/disable, remove). Reachable from the Family
// hub's camera rows (which deep-link straight into a camera's settings).
const BACK = { state: { from: { to: '/family', label: 'Family' } } };

export default function Cameras() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { kids: children, cameras, error: contextError, refresh } = useCameras();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [togglingId, setTogglingId] = useState(null);

  async function assign(cam, childId) {
    try {
      await api.put(`/cameras/${cam.id}/assign`, { child_id: childId || null });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleEnabled(cam) {
    setTogglingId(cam.id);
    setError('');
    try {
      await api.put(`/cameras/${cam.id}/enabled`, { enabled: !!cam.disabled });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setTogglingId(null);
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setRemoveBusy(true);
    setError('');
    try {
      await api.del(`/cameras/${removing.id}`);
      setRemoving(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <>
      <AppHeader title="Cameras" back={{ to: '/family', label: 'Family' }} />
      <main className="app-main">
        {(error || contextError) && <div className="error-banner">{error || contextError}</div>}

        {cameras.length === 0 && <div className="empty-state">No cameras added yet.</div>}

        {cameras.map((cam) => (
          <div className={`card cam-card${cam.disabled ? ' cam-card--off' : ''}`} key={cam.id}>
            <div className="cam-card__head">
              <div className="cam-card__title">
                <BreathingDot status={cam.disabled ? 'offline' : cam.statusLevel || 'connecting'} />
                <span className="cam-card__name">{cam.name}</span>
              </div>
              {isAdmin && (
                <div className="cam-card__actions">
                  <button className="icon-btn" onClick={() => toggleEnabled(cam)} disabled={togglingId === cam.id}>
                    {togglingId === cam.id ? '…' : cam.disabled ? 'Enable' : 'Disable'}
                  </button>
                  <button className="icon-btn" onClick={() => navigate(`/cameras/${cam.id}`, BACK)}>Edit</button>
                  <button className="icon-btn" onClick={() => setRemoving(cam)}>Remove</button>
                </div>
              )}
            </div>
            {cam.rtsp_display && <div className="camera-tile__sub cam-card__addr">{cam.rtsp_display}</div>}
            <div className="cam-badge-row">
              <span className={`cam-badge ${cam.discovery_source === 'onvif' ? 'cam-badge--ok' : 'cam-badge--bad'}`}>ONVIF</span>
              <span className={`cam-badge ${cam.ptz_supported ? 'cam-badge--ok' : 'cam-badge--bad'}`}>PTZ</span>
              <span className={`cam-badge ${cam.backchannel_supported === 'yes' ? 'cam-badge--ok' : 'cam-badge--bad'}`}>Two-way Audio</span>
            </div>
            <div className="field" style={{ marginBottom: 0, marginTop: 12 }}>
              <label>Assigned to</label>
              <select value={cam.child_id || ''} onChange={(e) => assign(cam, e.target.value)}>
                <option value="">Unassigned</option>
                {children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
              </select>
            </div>
          </div>
        ))}

        {isAdmin && (
          <button className="btn btn-primary" onClick={() => navigate('/cameras/new', BACK)}>+ Add camera</button>
        )}
      </main>

      {removing && (
        <Modal title="Remove camera" placement="top" onClose={() => (removeBusy ? null : setRemoving(null))}>
          <p style={{ marginTop: 0 }}>
            Remove <strong>{removing.name}</strong>? This stops its stream and deletes it from Nightlight.
            It can't be undone (you can always add it again).
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setRemoving(null)} disabled={removeBusy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={confirmRemove} disabled={removeBusy}>
              {removeBusy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
