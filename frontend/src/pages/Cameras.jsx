import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Pencil, Plus, Trash2, Power } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useCameras } from '../lib/CamerasContext.jsx';
import BreathingDot from '../components/BreathingDot.jsx';
import MoreMenu from '../components/MoreMenu.jsx';
import RemoveCameraDialog from '../components/RemoveCameraDialog.jsx';
import AppHeader from '../components/AppHeader.jsx';
import LoadFailed from '../components/LoadFailed.jsx';
import { loadState } from '../lib/loadState.js';
import { cameraState } from '../lib/cameraStatus.js';

// Cameras management (its own top-level tab). Editing/adding a camera happens on its own routed
// screen (CameraSettings.jsx); this page keeps the at-a-glance list plus quick inline actions
// (assign to a child, enable/disable, remove).
const BACK = { state: { from: { to: '/cameras', label: 'Cameras' } } };

export default function Cameras() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { kids: children, cameras, error: contextError, loaded, refresh } = useCameras();
  const navigate = useNavigate();
  const listState = loadState({ loaded, error: contextError, count: cameras.length });
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  // The failure of the Remove dialog's own request, shown INSIDE the dialog (#378). It is separate from the
  // page `error` on purpose: that banner renders in <main>, underneath the modal overlay, so a failed
  // remove used to look like the button did nothing.
  const [removeError, setRemoveError] = useState('');
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
    setRemoveError('');
    try {
      await api.del(`/cameras/${removing.id}`);
      setRemoving(null);
      await refresh();
    } catch (err) {
      // Stay open with the button re-enabled (finally below): the person can read why and retry or cancel.
      setRemoveError(err.message);
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <>
      <AppHeader title="Cameras" />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {/* The poll's failure is its own message with Retry, and "No cameras added yet" waits for a request that
            actually succeeded (#375): an outage is not an empty install. */}
        {(listState === 'error' || listState === 'stale') && (
          <LoadFailed what="cameras" error={contextError} onRetry={refresh} stale={listState === 'stale'} />
        )}
        {listState === 'loading' && <div className="empty-state">Loading…</div>}
        {listState !== 'loading' && listState !== 'error' && (
          <h2 className="section-title cameras-title">Your cameras <span>{cameras.length}</span></h2>
        )}
        {listState === 'empty' && (isAdmin ?
          <section className="night cameras-empty"><h2>Add your first camera</h2>
            <p>Find cameras on your network or enter their details yourself.</p>
            <button className="btn btn-primary" onClick={() => navigate('/cameras/new', BACK)}><Plus size={18} aria-hidden="true" />Add camera</button>
          </section> : <div className="empty-state">No cameras added yet.</div>)}

        {cameras.map((cam) => (
          <div className="dev-card camera-device" key={cam.id}>
            <div className="dev-card__main">
              <div className="dev-card__body">
                <div className="dev-card__state">
                  {cameraState(cam).dot === 'neutral' ? <span className="dot--neutral" aria-hidden="true" />
                    : <BreathingDot status={cameraState(cam).dot} />}
                  {cameraState(cam).word}
                </div>
                <div className="dev-card__name">{cam.name}</div>
                {cam.rtsp_display && <div className="dev-card__line">{cam.rtsp_display}</div>}
                {!cam.disabled && (cam.detect_motion_enabled != null || cam.detect_sound_enabled != null) &&
                  <div className="dev-card__line camera-device__detection">
                    {cam.detect_motion_enabled != null && `Motion ${cam.detect_motion_enabled ? 'on' : 'off'}`}
                    {cam.detect_motion_enabled != null && cam.detect_sound_enabled != null && ' · '}
                    {cam.detect_sound_enabled != null && `Sound ${cam.detect_sound_enabled ? 'on' : 'off'}`}
                  </div>}
                {(cam.discovery_source === 'onvif' || cam.ptz_supported || cam.backchannel_supported === 'yes') &&
                  <div className="camera-device__chips">
                    {cam.discovery_source === 'onvif' && <span><Check size={13} aria-hidden="true" />ONVIF</span>}
                    {!!cam.ptz_supported && <span><Check size={13} aria-hidden="true" />PTZ</span>}
                    {cam.backchannel_supported === 'yes' && <span><Check size={13} aria-hidden="true" />Two-way audio</span>}
                  </div>}
              </div>
              {isAdmin && (
                <MoreMenu className="more-menu--card" label={`More for ${cam.name}`} menuLabel={`Actions for ${cam.name}`}>
                  <button role="menuitem" className="more-menu__item" onClick={() => navigate(`/cameras/${cam.id}`, BACK)}><Pencil size={16} aria-hidden="true" />Edit camera</button>
                  <button role="menuitem" className="more-menu__item" disabled={togglingId === cam.id} onClick={() => toggleEnabled(cam)}><Power size={16} aria-hidden="true" />{cam.disabled ? 'Enable camera' : 'Disable camera'}</button>
                  <div className="dev-card__menu-divider" />
                  <button role="menuitem" className="more-menu__item dev-card__delete" onClick={() => { setRemoveError(''); setRemoving(cam); }}><Trash2 size={16} aria-hidden="true" />Remove camera</button>
                </MoreMenu>
              )}
            </div>
            <div className="camera-device__foot">
              {/* htmlFor/id (#381): without it the label is not associated with the select, so a screen reader
                  announced an unnamed combobox. The id carries the camera id because there is one select per
                  card and ids must be unique on the page. The caregiver's plain text has no control to
                  point at, so it gets no `for` (an orphan `for` would label nothing). */}
              {isAdmin ? <label htmlFor={`assign-${cam.id}`}>Assigned to</label> : <span>Assigned to</span>}
              {/* Admin-only (#552): which child a camera belongs to decides whether its nights are tracked,
                  so a caregiver sees the assignment but cannot change it (the server refuses it). */}
              {isAdmin ? (
                <select id={`assign-${cam.id}`} value={cam.child_id || ''} onChange={(e) => assign(cam, e.target.value)}>
                  <option value="">Unassigned</option>
                  {children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
                </select>
              ) : (
                <div>{children.find((child) => child.id === cam.child_id)?.name || 'Unassigned'}</div>
              )}
            </div>
          </div>
        ))}

        {isAdmin && listState !== 'loading' && listState !== 'error' && listState !== 'empty' && (
          <button className="btn btn-primary cameras-add" onClick={() => navigate('/cameras/new', BACK)}><Plus size={18} aria-hidden="true" />Add camera</button>
        )}
      </main>

      {removing && <RemoveCameraDialog camera={removing} error={removeError} busy={removeBusy}
        onClose={() => setRemoving(null)} onConfirm={confirmRemove} />}
    </>
  );
}
