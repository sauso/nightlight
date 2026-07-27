import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { useCameras } from '../lib/CamerasContext.jsx';
import Modal from '../components/Modal.jsx';
import BreathingDot from '../components/BreathingDot.jsx';
import AppHeader from '../components/AppHeader.jsx';

export default function Cameras() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { kids: children, cameras, error: contextError, refresh } = useCameras();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const EMPTY_FORM = {
    name: '', rtsp_host: '', rtsp_port: '554', rtsp_path: '', rtsp_username: '', rtsp_password: '',
    child_id: '', mqtt_topic: '',
  };
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [onvifBusy, setOnvifBusy] = useState(false);
  const [onvifMsg, setOnvifMsg] = useState('');
  // When the stream validation on save fails, we surface it inline with a "Save anyway"
  // option instead of a blocking browser confirm().
  const [confirmMsg, setConfirmMsg] = useState('');

  function openNew() {
    setForm(EMPTY_FORM);
    setOnvifMsg('');
    setConfirmMsg('');
    setEditing({});
  }

  function openEdit(cam) {
    // The API sends the address split into fields (never the password) - populate them;
    // the password field stays blank and means "keep the existing one" on save.
    setForm({
      name: cam.name,
      rtsp_host: cam.rtsp_host || '',
      rtsp_port: cam.rtsp_port || '554',
      rtsp_path: cam.rtsp_path || '',
      rtsp_username: cam.rtsp_username || '',
      rtsp_password: '',
      child_id: cam.child_id || '',
      mqtt_topic: cam.mqtt_topic || '',
    });
    setOnvifMsg('');
    setConfirmMsg('');
    setEditing(cam);
  }

  // Fetch port/path (and detected capabilities) over ONVIF using the IP already typed in the
  // form. Credentials are optional - many cameras answer the profile query unauthenticated;
  // if yours needs auth, fill username/password first and they'll be used.
  async function fetchFromOnvif() {
    const host = form.rtsp_host.trim();
    if (!host) {
      setError('Enter the camera IP first');
      return;
    }
    setOnvifBusy(true);
    setOnvifMsg('');
    setError('');
    try {
      const r = await api.post('/cameras/onvif-probe', {
        host,
        username: form.rtsp_username || undefined,
        password: form.rtsp_password || undefined,
      });
      setForm((f) => ({
        ...f,
        // Deliberately do NOT touch the name - it's the user's to set, and the ONVIF-reported
        // model name isn't useful. Only fill in the address details.
        rtsp_host: r.rtspHost || host,
        rtsp_port: r.rtspPort || f.rtsp_port || '554',
        rtsp_path: r.rtspPath || f.rtsp_path,
        discovery_source: 'onvif',
        onvif_device_url: r.onvifDeviceUrl,
        backchannel_supported: r.backchannel,
        ptz_supported: r.ptz ? 1 : 0,
        onvif_profile_token: r.profileToken || null,
      }));
      const res = r.video?.width ? `${r.video.codec || ''} ${r.video.width}×${r.video.height}`.trim() : r.video?.codec || '';
      const talk = r.backchannel === 'yes' ? ' · two-way audio' : r.backchannel === 'no' ? ' · no two-way audio' : '';
      const ptz = r.ptz ? ' · PTZ' : '';
      setOnvifMsg(`Found stream${res ? ` — ${res}` : ''}${talk}${ptz}. Port & path filled in — enter the username/password below.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setOnvifBusy(false);
    }
  }

  function submitCamera(payload) {
    return editing?.id ? api.put(`/cameras/${editing.id}`, payload) : api.post('/cameras', payload);
  }

  async function doSave(force) {
    setBusy(true);
    setError('');
    const payload = { ...form, child_id: form.child_id || null, ...(force ? { force: true } : {}) };
    try {
      await submitCamera(payload);
      setEditing(null);
      await refresh();
    } catch (err) {
      // The server validates the stream first; if it couldn't reach it (bad creds/path, or
      // the camera's just offline right now) it flags needsConfirm - surface that inline
      // with a "Save anyway" button rather than a browser popup.
      if (err.data?.needsConfirm) {
        setConfirmMsg(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  function save(e) {
    e.preventDefault();
    setConfirmMsg(''); // a fresh Save re-validates (e.g. after fixing the password)
    doSave(false);
  }

  async function assign(cam, childId) {
    try {
      await api.put(`/cameras/${cam.id}/assign`, { child_id: childId || null });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove(cam) {
    if (!confirm(`Remove camera "${cam.name}"?`)) return;
    try {
      await api.del(`/cameras/${cam.id}`);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <AppHeader title="Cameras" />
      <main className="app-main">
        {(error || contextError) && <div className="error-banner">{error || contextError}</div>}

        {cameras.length === 0 && <div className="empty-state">No cameras added yet.</div>}

        {cameras.map((cam) => (
          <div className="card" key={cam.id}>
            <div className="list-row" style={{ border: 'none', padding: '0 0 10px' }}>
              <div className="status-row">
                <BreathingDot status={cam.statusLevel || 'connecting'} />
                <div>
                  <div style={{ fontWeight: 600 }}>{cam.name}</div>
                  {/* Credential-free address (admins only - the API never sends the
                      password or the full credentialed URL). */}
                  {cam.rtsp_display && (
                    <div className="camera-tile__sub" style={{ wordBreak: 'break-all' }}>{cam.rtsp_display}</div>
                  )}
                  {/* Capability badges - only for cameras probed over ONVIF (we actually
                      know); green = supported, red = not. Manual cameras show none, so we
                      never falsely claim "not supported" for something we didn't check. */}
                  {cam.discovery_source === 'onvif' && (
                    <div className="cam-badge-row">
                      <span className={`cam-badge ${cam.ptz_supported ? 'cam-badge--ok' : 'cam-badge--bad'}`}>
                        PTZ
                      </span>
                      <span
                        className={`cam-badge ${cam.backchannel_supported === 'yes' ? 'cam-badge--ok' : 'cam-badge--bad'}`}
                      >
                        Two-way Audio
                      </span>
                    </div>
                  )}
                </div>
              </div>
              {isAdmin && (
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button className="icon-btn" onClick={() => openEdit(cam)}>Edit</button>
                  <button className="icon-btn" onClick={() => remove(cam)}>Remove</button>
                </div>
              )}
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Assigned to</label>
              <select value={cam.child_id || ''} onChange={(e) => assign(cam, e.target.value)}>
                <option value="">Unassigned</option>
                {children.map((child) => (
                  <option key={child.id} value={child.id}>{child.name}</option>
                ))}
              </select>
            </div>
          </div>
        ))}

        {isAdmin && (
          <button className="btn btn-primary" onClick={openNew}>+ Add camera</button>
        )}
      </main>

      {editing !== null && (
        <Modal title={editing.id ? 'Edit camera' : 'Add camera'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="cam-name">Name</label>
              <input
                id="cam-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                autoFocus
                placeholder="e.g. Crib cam"
              />
            </div>
            {/* Address + login as separate fields - the app builds the rtsp:// URL from
                these, so the password never sits in a visible URL. */}
            <div className="onvif-box__row">
              <div className="field">
                <label htmlFor="cam-host">Camera IP address</label>
                <input
                  id="cam-host"
                  value={form.rtsp_host}
                  onChange={(e) => setForm({ ...form, rtsp_host: e.target.value })}
                  required
                  placeholder="192.168.1.50"
                />
              </div>
              <div className="field" style={{ maxWidth: 90 }}>
                <label htmlFor="cam-port">RTSP port</label>
                <input
                  id="cam-port"
                  value={form.rtsp_port}
                  onChange={(e) => setForm({ ...form, rtsp_port: e.target.value })}
                  placeholder="554"
                />
              </div>
            </div>
            {!editing.id && (
              <div className="onvif-fetch">
                <button type="button" className="btn" onClick={fetchFromOnvif} disabled={onvifBusy}>
                  {onvifBusy ? 'Fetching…' : '↻ Fetch port & path from ONVIF'}
                </button>
                <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                  Optional: enter the IP above and fetch the stream port &amp; path
                  automatically. Most cameras don't need a login for this; if yours does, fill
                  the username/password below first.
                </div>
                {onvifMsg && <div className="onvif-box__ok">{onvifMsg}</div>}
              </div>
            )}
            <div className="field">
              <label htmlFor="cam-path">Stream path</label>
              <input
                id="cam-path"
                value={form.rtsp_path}
                onChange={(e) => setForm({ ...form, rtsp_path: e.target.value })}
                placeholder="/stream1"
              />
            </div>
            <div className="onvif-box__row">
              <div className="field">
                <label htmlFor="cam-user">Username</label>
                <input
                  id="cam-user"
                  value={form.rtsp_username}
                  onChange={(e) => setForm({ ...form, rtsp_username: e.target.value })}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label htmlFor="cam-pass">Password</label>
                <input
                  id="cam-pass"
                  type="password"
                  value={form.rtsp_password}
                  onChange={(e) => setForm({ ...form, rtsp_password: e.target.value })}
                  autoComplete="off"
                  placeholder={editing.id && editing.rtsp_has_password ? '•••••• (unchanged)' : ''}
                />
              </div>
            </div>
            <div className="field">
              <label htmlFor="cam-child">Assign to child (optional)</label>
              <select
                id="cam-child"
                value={form.child_id}
                onChange={(e) => setForm({ ...form, child_id: e.target.value })}
              >
                <option value="">Unassigned</option>
                {children.map((child) => (
                  <option key={child.id} value={child.id}>{child.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="cam-mqtt-topic">MQTT topic for temp/humidity (optional)</label>
              <input
                id="cam-mqtt-topic"
                value={form.mqtt_topic}
                onChange={(e) => setForm({ ...form, mqtt_topic: e.target.value })}
                placeholder="e.g. zigbee2mqtt/Raffa Room Temp"
              />
            </div>
            {confirmMsg && (
              <div className="form-warning">
                <div>Couldn't reach the camera stream: {confirmMsg}</div>
                <div className="camera-tile__sub" style={{ marginTop: 4 }}>
                  Check the IP, path, and login — or if the camera's just offline right now,
                  save it anyway.
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : confirmMsg ? 'Retry save' : 'Save'}
              </button>
              {confirmMsg && (
                <button className="btn" type="button" onClick={() => doSave(true)} disabled={busy}>
                  Save anyway
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
