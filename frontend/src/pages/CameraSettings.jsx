import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Zap, AudioLines, Clock, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Modal from '../components/Modal.jsx';
import DetectionRow from '../components/DetectionRow.jsx';
import CameraReportButton from '../components/CameraReportButton.jsx';

const minToHHMM = (m) => `${String(Math.floor((m || 0) / 60)).padStart(2, '0')}:${String((m || 0) % 60).padStart(2, '0')}`;

const EMPTY_FORM = {
  name: '', rtsp_host: '', rtsp_port: '554', rtsp_path: '', rtsp_username: '', rtsp_password: '',
  child_id: '', mqtt_topic: '', talk_username: '', talk_password: '', sub_rtsp_path: '',
};

// Per-camera settings as a routed screen (replaces the old edit modal). /cameras/new adds a
// camera; /cameras/:id edits one. Only connection/identity fields live here — motion, sound and
// schedule are their own screens (see DetectionSettings.jsx), reachable from the Detection rows
// below on an existing camera. Admin-only (gated by the route in App.jsx).
export default function CameraSettings() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const navigate = useNavigate();
  const { kids: children, cameras, refresh } = useCameras();
  const cam = isNew ? null : cameras.find((c) => c.id === id);

  const [form, setForm] = useState(EMPTY_FORM);
  const [caps, setCaps] = useState({ backchannel_supported: undefined, talk_has_password: false, rtsp_has_password: false });
  const initedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [onvifBusy, setOnvifBusy] = useState(false);
  const [onvifMsg, setOnvifMsg] = useState('');
  const [talkVerifyBusy, setTalkVerifyBusy] = useState(false);
  const [talkVerifyMsg, setTalkVerifyMsg] = useState(null);
  const [pageError, setPageError] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  // Carried into the ONVIF fetch/talk-verify calls so extra capabilities detected here persist.
  const extraRef = useRef({});

  const back = { to: '/family', label: 'Family' };

  // Initialise the form once the camera has loaded (edit), or immediately (add).
  useEffect(() => {
    if (isNew || initedRef.current) return;
    if (!cam) return; // still loading
    initedRef.current = true;
    setForm({
      name: cam.name,
      rtsp_host: cam.rtsp_host || '',
      rtsp_port: cam.rtsp_port || '554',
      rtsp_path: cam.rtsp_path || '',
      rtsp_username: cam.rtsp_username || '',
      rtsp_password: '',
      child_id: cam.child_id || '',
      mqtt_topic: cam.mqtt_topic || '',
      talk_username: cam.talk_username || '',
      talk_password: '',
      sub_rtsp_path: cam.sub_rtsp_path || '',
    });
    setCaps({
      backchannel_supported: cam.backchannel_supported,
      talk_has_password: !!cam.talk_has_password,
      rtsp_has_password: !!cam.rtsp_has_password,
    });
  }, [cam, isNew]);

  async function fetchFromOnvif() {
    const host = form.rtsp_host.trim();
    if (!host) { setPageError('Enter the camera IP first'); return; }
    setOnvifBusy(true); setOnvifMsg(''); setPageError('');
    try {
      const r = await api.post('/cameras/onvif-probe', {
        host, username: form.rtsp_username || undefined, password: form.rtsp_password || undefined,
        id: isNew ? undefined : id,
      });
      setForm((f) => ({
        ...f,
        rtsp_host: r.rtspHost || host,
        rtsp_port: r.rtspPort || f.rtsp_port || '554',
        rtsp_path: r.rtspPath || f.rtsp_path,
        sub_rtsp_path: r.subRtspPath || f.sub_rtsp_path,
      }));
      extraRef.current = {
        discovery_source: 'onvif',
        onvif_device_url: r.onvifDeviceUrl,
        backchannel_supported: r.backchannel,
        motion_events_supported: r.motionEvents,
        ptz_supported: r.ptz ? 1 : 0,
        onvif_profile_token: r.profileToken || null,
      };
      setCaps((c) => ({ ...c, backchannel_supported: r.backchannel, backchannel_verified: r.backchannelVerified }));
      const res = r.video?.width ? `${r.video.codec || ''} ${r.video.width}×${r.video.height}`.trim() : r.video?.codec || '';
      const talk = r.backchannel === 'yes' ? ' · two-way audio' : r.backchannel === 'no' ? ' · no two-way audio' : '';
      const ptz = r.ptz ? ' · PTZ' : '';
      const motion = r.motionEvents === 'yes' ? ' · ONVIF motion' : '';
      const low = r.subRtspPath ? ' · low-quality stream' : '';
      setOnvifMsg(`Found stream${res ? ` — ${res}` : ''}${talk}${ptz}${motion}${low}. Port & path filled in.`);
    } catch (err) {
      setPageError(err.message);
    } finally {
      setOnvifBusy(false);
    }
  }

  async function verifyTalk() {
    const host = form.rtsp_host.trim();
    if (!host) { setTalkVerifyMsg({ ok: false, text: 'Enter the camera IP first' }); return; }
    if (!form.talk_username.trim()) { setTalkVerifyMsg({ ok: false, text: 'Enter the talk username first' }); return; }
    setTalkVerifyBusy(true); setTalkVerifyMsg(null);
    try {
      const r = await api.post('/cameras/verify-talk', {
        host, username: form.talk_username.trim(), password: form.talk_password || undefined, id: isNew ? undefined : id,
      });
      setTalkVerifyMsg({ ok: true, text: `Talk login works${r.codec ? ` — ${r.codec}` : ''}` });
    } catch (err) {
      setTalkVerifyMsg({ ok: false, text: err.message });
    } finally {
      setTalkVerifyBusy(false);
    }
  }

  // How talk-back is delivered, which decides what the talk panel shows:
  //  - 'onvif-backchannel' (Thingino/Sonoff/most ONVIF): rides the stream audio using the STREAM
  //    creds — no separate login. Prompting for one is misleading, and the save path discards it.
  //  - 'hikvision-isapi': needs the camera's web login (separate from the ONVIF user).
  // Prefer a fresh probe's live verification; otherwise trust the backend already stored on the camera.
  const talkBackend =
    caps.backchannel_verified === true ? 'onvif-backchannel'
    : caps.backchannel_verified === false ? 'hikvision-isapi'
    : cam?.talk_backend || null;
  // Talk-back over the stream backchannel is the default for any backchannel-capable camera; only a
  // camera positively known to use the Hikvision ISAPI login shows the credential form. This keeps a
  // legacy cam whose backend was never resolved out of the "empty username = disable talk" footgun.
  const isIsapi = talkBackend === 'hikvision-isapi';
  const showTalk = caps.backchannel_supported === 'yes' || isIsapi;
  const talkOverStream = showTalk && !isIsapi;

  async function doSave(force) {
    setBusy(true); setPageError('');
    const payload = { ...form, child_id: form.child_id || null, ...extraRef.current, ...(force ? { force: true } : {}) };
    // Backchannel cams carry no separate talk login (talk-back uses the stream creds). Never send the
    // empty talk fields for them — the API reads an empty talk_username as "disable talk-back", which
    // would silently turn two-way audio off on any unrelated edit.
    if (talkOverStream) { delete payload.talk_username; delete payload.talk_password; }
    try {
      const saved = isNew ? await api.post('/cameras', payload) : await api.put(`/cameras/${id}`, payload);
      await refresh();
      // New camera: drop into its own settings so motion/sound can be configured next.
      navigate(isNew ? `/cameras/${saved.id}` : back.to, isNew ? { state: { from: back } } : { state: { from: back } });
    } catch (err) {
      if (err.data?.needsConfirm) setConfirmMsg(err.message);
      else setPageError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function save(e) {
    e.preventDefault();
    setConfirmMsg(''); setPageError('');
    doSave(false);
  }

  async function confirmRemove() {
    setRemoveBusy(true); setPageError('');
    try {
      await api.del(`/cameras/${id}`);
      await refresh();
      navigate(back.to);
    } catch (err) {
      setPageError(err.message);
      setRemoveBusy(false);
    }
  }

  const detFrom = { state: { from: { to: `/cameras/${id}`, label: 'Camera' } } };

  return (
    <>
      <AppHeader title={isNew ? 'Add camera' : (cam?.name || 'Camera')} back={back} />
      <main className="app-main">
        {!isNew && !cam ? (
          <div className="empty-state">Loading…</div>
        ) : (
          <form onSubmit={save}>
            <div className="field">
              <label htmlFor="cam-name">Name</label>
              <input id="cam-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                required placeholder="e.g. Crib cam" />
            </div>

            <div className="onvif-box__row">
              <div className="field">
                <label htmlFor="cam-host">Camera IP address</label>
                <input id="cam-host" value={form.rtsp_host} onChange={(e) => setForm({ ...form, rtsp_host: e.target.value })}
                  required placeholder="192.168.1.50" />
              </div>
              <div className="field" style={{ maxWidth: 90 }}>
                <label htmlFor="cam-port">RTSP port</label>
                <input id="cam-port" value={form.rtsp_port} onChange={(e) => setForm({ ...form, rtsp_port: e.target.value })} placeholder="554" />
              </div>
            </div>

            <div className="onvif-box__row">
              <div className="field">
                <label htmlFor="cam-user">Username</label>
                <input id="cam-user" value={form.rtsp_username} onChange={(e) => setForm({ ...form, rtsp_username: e.target.value })}
                  autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </div>
              <div className="field">
                <label htmlFor="cam-pass">Password</label>
                <input id="cam-pass" type="password" value={form.rtsp_password}
                  onChange={(e) => setForm({ ...form, rtsp_password: e.target.value })}
                  autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  placeholder={!isNew && caps.rtsp_has_password ? '•••••• (unchanged)' : ''} />
              </div>
            </div>

            <div className="onvif-fetch">
              <button type="button" className="btn btn-peri" onClick={fetchFromOnvif} disabled={onvifBusy}>
                {onvifBusy ? 'Fetching…' : '↻ Fetch port, path & capabilities from ONVIF'}
              </button>
              <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                Optional: fetch the stream port, path and capabilities (two-way audio, PTZ) over ONVIF using
                the IP and login above. Most cameras don't need a login for this; if yours does, fill it in first.
              </div>
              {onvifMsg && <div className="onvif-box__ok">{onvifMsg}</div>}
            </div>

            <div className="field">
              <label htmlFor="cam-path">Stream path</label>
              <input id="cam-path" value={form.rtsp_path} onChange={(e) => setForm({ ...form, rtsp_path: e.target.value })}
                placeholder="/Streaming/Channels/101" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              <p className="onvif-box__hint">The main (high-quality) stream path. Filled in by the ONVIF fetch, or enter it manually.</p>
            </div>

            <div className="field">
              <label htmlFor="cam-sub-path">Low-quality stream path (optional)</label>
              <input id="cam-sub-path" value={form.sub_rtsp_path} onChange={(e) => setForm({ ...form, sub_rtsp_path: e.target.value })}
                autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="/Streaming/Channels/102" />
              <p className="onvif-box__hint">A second, lower-resolution stream that adds a "Low" quality option on the tile — it reuses the address and login above.</p>
            </div>

            {showTalk && (
              <div className="onvif-box">
                <div className="onvif-box__title">Two-way audio (talk-back)</div>
                {talkOverStream ? (
                  <p className="onvif-box__hint">
                    This camera plays talk-back over its own stream audio, so it needs <strong>no separate
                    login</strong> — the hold-to-talk button is enabled automatically using the stream
                    credentials above.
                  </p>
                ) : (
                  <>
                    <p className="onvif-box__hint">
                      This camera needs its <strong>web login</strong> to enable the hold-to-talk button — for
                      Hikvision that's the User Management account (separate from the ONVIF user). Leave the
                      username blank to turn it off.
                    </p>
                    <div className="onvif-box__row">
                      <div className="field">
                        <label htmlFor="cam-talk-user">Talk username</label>
                        <input id="cam-talk-user" value={form.talk_username} onChange={(e) => setForm({ ...form, talk_username: e.target.value })}
                          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                      </div>
                      <div className="field">
                        <label htmlFor="cam-talk-pass">Talk password</label>
                        <input id="cam-talk-pass" type="password" value={form.talk_password}
                          onChange={(e) => setForm({ ...form, talk_password: e.target.value })}
                          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                          placeholder={caps.talk_has_password ? '•••••• (unchanged)' : ''} />
                      </div>
                    </div>
                    <button type="button" className="btn btn-peri" onClick={verifyTalk} disabled={talkVerifyBusy} style={{ marginTop: 4 }}>
                      {talkVerifyBusy ? 'Verifying…' : 'Verify login'}
                    </button>
                    {talkVerifyMsg && <div className={talkVerifyMsg.ok ? 'onvif-box__ok' : 'onvif-box__err'}>{talkVerifyMsg.text}</div>}
                  </>
                )}
              </div>
            )}

            <div className="field">
              <label htmlFor="cam-child">Assign to child (optional)</label>
              <select id="cam-child" value={form.child_id} onChange={(e) => setForm({ ...form, child_id: e.target.value })}>
                <option value="">Unassigned</option>
                {children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
              </select>
            </div>

            <div className="field">
              <label htmlFor="cam-mqtt-topic">MQTT topic for temp/humidity (optional)</label>
              <input id="cam-mqtt-topic" value={form.mqtt_topic} onChange={(e) => setForm({ ...form, mqtt_topic: e.target.value })}
                placeholder="e.g. zigbee2mqtt/Raffa Room Temp" />
            </div>

            {/* Detection lives on its own screens — only once the camera exists. */}
            {!isNew && cam && (
              <>
                <div className="section-title">Detection</div>
                <div className="card" style={{ padding: 0 }}>
                  <DetectionRow Icon={Zap} label="Motion detection"
                    right={<><span className="camera-tile__sub">{cam.detect_motion_enabled ? 'On' : 'Off'}</span><ChevronRight size={18} style={{ opacity: 0.45 }} aria-hidden="true" /></>}
                    onClick={() => navigate(`/cameras/${id}/motion`, detFrom)} />
                  <DetectionRow Icon={AudioLines} label="Sound detection"
                    right={<><span className="camera-tile__sub">{cam.detect_sound_enabled ? 'On' : 'Off'}</span><ChevronRight size={18} style={{ opacity: 0.45 }} aria-hidden="true" /></>}
                    onClick={() => navigate(`/cameras/${id}/sound`, detFrom)} />
                  <DetectionRow Icon={Clock} label="Alert schedule"
                    right={<><span className="camera-tile__sub">{cam.detect_schedule_enabled ? `${minToHHMM(cam.detect_start)}–${minToHHMM(cam.detect_end)}` : 'Always'}</span><ChevronRight size={18} style={{ opacity: 0.45 }} aria-hidden="true" /></>}
                    onClick={() => navigate(`/cameras/${id}/schedule`, detFrom)} />
                </div>
              </>
            )}

            {pageError && <div className="error-banner" style={{ marginBottom: 12 }}>{pageError}</div>}
            {confirmMsg && (
              <div className="form-warning">
                <div>Couldn't reach the camera stream: {confirmMsg}</div>
                <div className="camera-tile__sub" style={{ marginTop: 4 }}>
                  Check the IP, path, and login — or if the camera's just offline right now, save it anyway.
                </div>
              </div>
            )}

            {/* When a probe or the stream check fails, offer a diagnostic report to add support for
                the camera (your idea: probe fails → send a bug report with the details attached). */}
            {(pageError || confirmMsg) && form.rtsp_host.trim() && (
              <CameraReportButton
                payload={{
                  host: form.rtsp_host.trim(),
                  port: form.rtsp_port,
                  path: form.rtsp_path,
                  sub_path: form.sub_rtsp_path,
                  username: form.rtsp_username,
                  password: form.rtsp_password || undefined,
                  mqtt_topic: form.mqtt_topic,
                  id: isNew ? undefined : id,
                }}
              />
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {busy ? 'Saving…' : confirmMsg ? 'Retry save' : isNew ? 'Add camera' : 'Save changes'}
              </button>
              {confirmMsg && (
                <button className="btn" type="button" onClick={() => doSave(true)} disabled={busy}>Save anyway</button>
              )}
            </div>

            {!isNew && (
              <button className="btn btn-danger" type="button" style={{ marginTop: 10 }} onClick={() => setRemoving(true)}>
                Remove camera
              </button>
            )}
          </form>
        )}
      </main>

      {removing && (
        <Modal title="Remove camera" placement="top" onClose={() => (removeBusy ? null : setRemoving(false))}>
          <p style={{ marginTop: 0 }}>
            Remove <strong>{cam?.name}</strong>? This stops its stream and deletes it from Nightlight. It can't be undone (you can always add it again).
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" type="button" onClick={() => setRemoving(false)} disabled={removeBusy}>Cancel</button>
            <button className="btn btn-danger" type="button" onClick={confirmRemove} disabled={removeBusy}>
              {removeBusy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
