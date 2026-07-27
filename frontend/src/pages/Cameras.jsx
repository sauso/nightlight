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
  const [form, setForm] = useState({ name: '', rtsp_url: '', child_id: '', mqtt_topic: '' });
  const [busy, setBusy] = useState(false);
  // ONVIF auto-fill sub-form (only in the Add flow).
  const [onvif, setOnvif] = useState({ host: '', port: '', username: '', password: '' });
  const [onvifBusy, setOnvifBusy] = useState(false);
  const [onvifMsg, setOnvifMsg] = useState('');

  function resetOnvif() {
    setOnvif({ host: '', port: '', username: '', password: '' });
    setOnvifBusy(false);
    setOnvifMsg('');
  }

  function openNew() {
    setForm({ name: '', rtsp_url: '', child_id: '', mqtt_topic: '' });
    resetOnvif();
    setEditing({});
  }

  function openEdit(cam) {
    setForm({ name: cam.name, rtsp_url: cam.rtsp_url, child_id: cam.child_id || '', mqtt_topic: cam.mqtt_topic || '' });
    resetOnvif();
    setEditing(cam);
  }

  async function fetchFromOnvif() {
    if (!onvif.host.trim()) {
      setError('Enter the camera IP first');
      return;
    }
    setOnvifBusy(true);
    setOnvifMsg('');
    setError('');
    try {
      const r = await api.post('/cameras/onvif-probe', {
        host: onvif.host.trim(),
        port: onvif.port ? Number(onvif.port) : undefined,
        username: onvif.username,
        password: onvif.password,
      });
      setForm((f) => ({
        ...f,
        rtsp_url: r.rtspUrl,
        name: f.name || r.suggestedName || '',
        discovery_source: 'onvif',
        onvif_device_url: r.onvifDeviceUrl,
        backchannel_supported: r.backchannel,
      }));
      const res = r.video?.width ? `${r.video.codec || ''} ${r.video.width}×${r.video.height}`.trim() : r.video?.codec || '';
      const talk =
        r.backchannel === 'yes' ? ' · two-way audio supported' : r.backchannel === 'no' ? ' · no two-way audio' : '';
      setOnvifMsg(`Found stream${res ? ` — ${res}` : ''}${talk}. RTSP URL filled in below.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setOnvifBusy(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const payload = { ...form, child_id: form.child_id || null };
      if (editing?.id) {
        await api.put(`/cameras/${editing.id}`, payload);
      } else {
        await api.post('/cameras', payload);
      }
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
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
                  {/* rtsp_url is only present for admins - the API redacts it otherwise,
                      since it usually embeds the camera's own login credentials. */}
                  {cam.rtsp_url && (
                    <div className="camera-tile__sub" style={{ wordBreak: 'break-all' }}>{cam.rtsp_url}</div>
                  )}
                  {/* Two-way-audio capability, detected over ONVIF at add time. Only shown
                      when known - manual/unknown cameras get no badge to avoid clutter. */}
                  {cam.backchannel_supported === 'yes' && (
                    <span className="cam-badge cam-badge--ok">Two-way audio</span>
                  )}
                  {cam.backchannel_supported === 'no' && (
                    <span className="cam-badge cam-badge--muted">No two-way audio</span>
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
            {!editing.id && (
              <div className="onvif-box">
                <div className="section-title" style={{ marginTop: 0 }}>Auto-fill from ONVIF camera (optional)</div>
                <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
                  Enter the camera's IP and ONVIF login to fetch its RTSP URL automatically,
                  instead of typing it by hand.
                </div>
                <div className="onvif-box__row">
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label htmlFor="onvif-host">Camera IP</label>
                    <input
                      id="onvif-host"
                      value={onvif.host}
                      onChange={(e) => setOnvif({ ...onvif, host: e.target.value })}
                      placeholder="192.168.1.50"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 8, maxWidth: 90 }}>
                    <label htmlFor="onvif-port">Port</label>
                    <input
                      id="onvif-port"
                      value={onvif.port}
                      onChange={(e) => setOnvif({ ...onvif, port: e.target.value })}
                      placeholder="80"
                    />
                  </div>
                </div>
                <div className="onvif-box__row">
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label htmlFor="onvif-user">ONVIF username</label>
                    <input
                      id="onvif-user"
                      value={onvif.username}
                      onChange={(e) => setOnvif({ ...onvif, username: e.target.value })}
                      autoComplete="off"
                    />
                  </div>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <label htmlFor="onvif-pass">ONVIF password</label>
                    <input
                      id="onvif-pass"
                      type="password"
                      value={onvif.password}
                      onChange={(e) => setOnvif({ ...onvif, password: e.target.value })}
                      autoComplete="off"
                    />
                  </div>
                </div>
                <button type="button" className="btn" onClick={fetchFromOnvif} disabled={onvifBusy}>
                  {onvifBusy ? 'Fetching…' : 'Fetch stream URL'}
                </button>
                {onvifMsg && <div className="onvif-box__ok">{onvifMsg}</div>}
              </div>
            )}
            <div className="field">
              <label htmlFor="cam-rtsp">RTSP URL</label>
              <input
                id="cam-rtsp"
                value={form.rtsp_url}
                onChange={(e) => setForm({ ...form, rtsp_url: e.target.value })}
                required
                placeholder="rtsp://user:pass@192.168.1.50:554/stream1"
              />
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
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
