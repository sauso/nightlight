import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { probeCamera, buildCameraPayload } from '../lib/cameraConnect.js';
import CameraDiscovery from './CameraDiscovery.jsx';
import CameraForm from './CameraForm.jsx';

// Adding a camera, as separate cards (#950): the search, one card per camera it found, then, for the one the
// person picks, a card that asks only for the camera's login, and last a card for adding by hand. Used by the
// setup wizard and by Settings > Cameras > Add camera, so both behave the same.
//
// Why only the login: a found camera's address is already known, and the ONVIF probe returns its port and stream
// paths, so asking for host, port and path (the full form) made people re-type what the app had just learned.
//
// NOTHING typed on the connect card is stored: no draft, no localStorage, no sessionStorage. The password lives
// in this component's state until the request is sent (the full form keeps the same rule, see DRAFT_FIELDS in
// CameraForm.jsx).
export default function AddCameraFlow({ initialChildId = '', onCreated, autoStart = false }) {
  const [selected, setSelected] = useState(null);
  const [manualOpen, setManualOpen] = useState(false);
  // What "Advanced settings" hands to the manual card's full form: the address, the name and the typed username.
  // One object per click, so the form (which applies a prefill once per object) takes it again if it is clicked twice.
  const [prefill, setPrefill] = useState(null);
  const [manualVersion, setManualVersion] = useState(0);
  const manualRef = useRef(null);

  function openAdvanced(values) {
    setPrefill(values);
    // Start the full form fresh: a previously opened manual form may hold a password that belongs to
    // a different camera. The selected card deliberately hands over only its username (#950).
    setManualVersion((version) => version + 1);
    setSelected(null);
    setManualOpen(true);
  }
  // The manual card sits below the list, so on a phone it can be off screen when Advanced opens it.
  useEffect(() => {
    if (prefill) manualRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [prefill]);

  return (
    <CameraDiscovery autoStart={autoStart} selectedId={selected?.id ?? null} onPick={setSelected}>
      {selected && <ConnectCard key={selected.id} candidate={selected} initialChildId={initialChildId}
        onCreated={onCreated} onAdvanced={openAdvanced} />}
      <section className="camera-manual" ref={manualRef}>
        <button type="button" className="camera-card" aria-expanded={manualOpen} onClick={() => setManualOpen((open) => !open)}>
          <span className="camera-card__text">
            <strong className="camera-card__name">Add a camera manually</strong>
            <span className="camera-card__line">Enter an RTSP or ONVIF address</span>
          </span>
          <span className="camera-card__side">
            <ChevronRight size={18} className={`camera-card__chevron${manualOpen ? ' is-open' : ''}`} aria-hidden="true" />
          </span>
        </button>
        {manualOpen && <div className="camera-manual__form">
          {/* requireChild follows initialChildId: the wizard hands one over and needs the camera assigned to it;
              on the Add camera screen a camera has always been allowed to start unassigned. */}
          <CameraForm key={manualVersion} embedded initialChildId={initialChildId} requireChild={!!initialChildId}
            onCreated={onCreated} prefill={prefill} />
        </div>}
      </section>
    </CameraDiscovery>
  );
}

function ConnectCard({ candidate, initialChildId, onCreated, onAdvanced }) {
  const { kids, refresh } = useCameras();
  const [name, setName] = useState(candidate.name);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [chosenChild, setChosenChild] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmMsg, setConfirmMsg] = useState('');
  const [canEnterDetails, setCanEnterDetails] = useState(false);
  // The probe's answer, kept so "Save anyway" does not log in to the camera a second time. Cleared when the
  // login changes, because the answer belongs to the login that produced it.
  const probed = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // One child: assigned silently. Several: the person chooses, unless the wizard already named one.
  const askChild = !initialChildId && kids.length > 1;
  const childId = initialChildId || (kids.length === 1 ? kids[0].id : chosenChild);

  function loginChanged(setter) {
    return (event) => { setter(event.target.value); probed.current = null; setConfirmMsg(''); setError(''); setCanEnterDetails(false); };
  }

  async function submit(force = false) {
    setBusy(true); setError(''); setConfirmMsg(''); setCanEnterDetails(false);
    try {
      if (!probed.current) {
        // The server's own message is shown as it is: it already tells a wrong login from a locked camera, and
        // it warns that repeated wrong logins can lock the camera. This is never retried automatically.
        probed.current = await probeCamera({ host: candidate.ip, username, password });
        // The person left while the camera was answering: do not go on to save something they walked away from.
        if (!mounted.current) return;
      }
      const { fields, extra } = probed.current;
      const form = {
        name: name.trim(),
        rtsp_host: fields.rtsp_host,
        rtsp_port: String(fields.rtsp_port || candidate.rtspPort || 554),
        rtsp_path: fields.rtsp_path,
        sub_rtsp_path: fields.sub_rtsp_path,
        rtsp_username: username,
        rtsp_password: password,
        child_id: childId,
      };
      const saved = await api.post('/cameras', buildCameraPayload(form, extra, { force }), { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      await refresh();
      if (mounted.current) onCreated?.(saved);
    } catch (err) {
      if (!mounted.current) return;
      // A refused stream test is a question, not a failure: the camera may just be switched off right now.
      if (err.data?.needsConfirm) setConfirmMsg(err.message);
      else {
        setError(err.message);
        // The probe route returns plain messages for both login rejection and unavailable ONVIF. Its
        // login messages explicitly warn about lockouts; only an unavailable probe offers manual details.
        setCanEnterDetails(!/incorrect|rejected|locked|lock the camera|lock the camera out|wrong attempts/i.test(err.message));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const advanced = () => onAdvanced({ host: candidate.ip, port: candidate.rtspPort, name: name.trim() || candidate.name, username });

  return (
    <form className="card camera-connect" aria-label={`Connect ${candidate.name}`}
      onSubmit={(event) => { event.preventDefault(); submit(false); }}>
      <h2 className="camera-connect__title">Connect {candidate.name}</h2>
      <p className="camera-connect__address">{candidate.ip}</p>
      <div className="field">
        <label htmlFor="connect-name">Name</label>
        <input id="connect-name" value={name} onChange={(event) => setName(event.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="connect-user">Username</label>
        <input id="connect-user" value={username} onChange={loginChanged(setUsername)}
          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </div>
      <div className="field">
        <label htmlFor="connect-pass">Password</label>
        <input id="connect-pass" type="password" value={password} onChange={loginChanged(setPassword)}
          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </div>
      {askChild && <div className="field">
        <label htmlFor="connect-child">Child</label>
        <select id="connect-child" value={chosenChild} onChange={(event) => setChosenChild(event.target.value)}>
          <option value="">Unassigned</option>
          {kids.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
        </select>
      </div>}
      {error && <div className="error-banner" role="alert">
        {error}
        {canEnterDetails && <div><button type="button" className="linkbtn" onClick={advanced}>Enter the stream details yourself</button></div>}
      </div>}
      {confirmMsg && <div className="form-warning" role="alert">
        <div>{confirmMsg}</div>
        <div className="camera-tile__sub">Check the login, or if the camera is just switched off right now, save it anyway.</div>
      </div>}
      <div className="camera-connect__actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Adding...' : 'Add camera'}</button>
        {confirmMsg && <button className="btn" type="button" disabled={busy} onClick={() => submit(true)}>Save anyway</button>}
        <button className="linkbtn camera-connect__advanced" type="button" onClick={advanced}>Advanced settings</button>
      </div>
    </form>
  );
}
