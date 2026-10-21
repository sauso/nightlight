import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';

// What a reload-surviving draft may store (#377). NOT the password, and NOT the certificate text: the box takes
// arbitrary pasted text and the page itself warns against pasting a private key into it, so it is kept out of
// browser storage rather than trusted to be a public certificate. The cost is pasting it again after a reload.
const DRAFT_FIELDS = ['mqtt_enabled', 'mqtt_host', 'mqtt_port', 'mqtt_username', 'mqtt_tls', 'mqtt_tls_verify'];

export default function SettingsMqtt() {
  const draftKey = useDraftKey('settings:mqtt');
  // Read once on mount: edits typed before a background reload, or before a visit to another screen.
  const [restoredDraft] = useState(() => loadDraft(draftKey, DRAFT_FIELDS));
  const [restored, setRestored] = useState(!!restoredDraft);
  const [form, setForm] = useState({
    mqtt_enabled: false, mqtt_host: '', mqtt_port: '', mqtt_username: '', mqtt_password: '',
    // TLS (#537). Off by default, as for every install that existed before it; verification on.
    mqtt_tls: false, mqtt_tls_ca: '', mqtt_tls_verify: true,
    ...restoredDraft,
  });
  // The form as last loaded or last accepted by the server (never touched by typing). `ready` is false until the
  // server's values have arrived, and stays false if that request fails: a failed load must neither write nor CLEAR
  // a stored draft (an unloaded form would read as "nothing changed").
  const [baseline, setBaseline] = useState(null);
  const [passwordSet, setPasswordSet] = useState(false);
  const [error, setError] = useState('');
  // A refusal that belongs to one control (the CA text) is shown beside it, not in the banner above the form.
  const [caError, setCaError] = useState('');
  // The live connection, so a certificate that is not trusted is explained here and not only in the server log.
  const [status, setStatus] = useState(null);
  const loadStatus = () => api.get('/settings/mqtt/status').then((r) => setStatus(r || null)).catch(() => setStatus(null));
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  // True while anything on screen differs from what is stored, INCLUDING a typed password and an edited certificate,
  // which are never written to storage (so after a reload there is nothing to restore and the notice goes).
  const draftUnsaved = useFormDraft({
    key: draftKey, allow: DRAFT_FIELDS, form, baseline: baseline || {}, ready: baseline !== null, secrets: [form.mqtt_password],
  });
  const unsaved = draftUnsaved || (baseline !== null && String(form.mqtt_tls_ca ?? '') !== String(baseline.mqtt_tls_ca ?? ''));

  // Back to what is stored: useFormDraft sees form == baseline and removes the stored draft.
  function discardChanges() {
    setForm((f) => ({ ...f, ...baseline, mqtt_password: '' }));
    setRestored(false);
  }

  useEffect(() => {
    api.get('/settings/mqtt').then((mqtt) => {
      // ⚠️ READ THE FIELDS HERE, NOT INSIDE THE UPDATER. `api.get` returns null for an empty or
      // unparseable body on an otherwise-200 response, and dereferencing it inside `setForm(f => …)`
      // throws when REACT runs the updater, on a later tick — by which time the `.catch` below has
      // long since gone. The result was an uncaught TypeError that took the whole page to the crash
      // screen, with a `.catch(() => {})` sitting right there looking like it handled it.
      const cfg = mqtt || {};
      const next = {
        mqtt_enabled: cfg.mqtt_enabled,
        mqtt_host: cfg.mqtt_host,
        mqtt_port: cfg.mqtt_port,
        mqtt_username: cfg.mqtt_username,
        // `!== false` / `!= null`: a server older than TLS support sends none of these, and that means "as before".
        mqtt_tls: !!cfg.mqtt_tls,
        mqtt_tls_ca: cfg.mqtt_tls_ca || '',
        mqtt_tls_verify: cfg.mqtt_tls_verify !== false,
      };
      // A restored draft goes back over the server's values, so what was typed before the reload is what is on screen.
      setForm((f) => ({ ...f, ...next, ...restoredDraft }));
      setBaseline(next);
      setPasswordSet(cfg.mqtt_password_set);
    }).catch(() => {});
    loadStatus();
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setCaError('');
    setSaved(false);
    try {
      const payload = {
        mqtt_enabled: form.mqtt_enabled,
        mqtt_host: form.mqtt_host,
        mqtt_port: form.mqtt_port,
        mqtt_username: form.mqtt_username,
        mqtt_tls: !!form.mqtt_tls,
        mqtt_tls_verify: !!form.mqtt_tls_verify,
      };
      // The CA box is hidden while TLS is off, so its text is sent only while TLS is on. Sent always, a refused CA
      // typed before switching TLS off made the whole save fail with the reason drawn inside the hidden block: no
      // message, no "Saved" (#537 review). Left out, the server keeps the stored CA, so switching TLS back on later
      // finds it where it was; and the person sees and fixes the text when the box is visible again.
      if (form.mqtt_tls) payload.mqtt_tls_ca = form.mqtt_tls_ca;
      // Only send a new password if one was actually typed — blank means "keep current".
      if (form.mqtt_password) payload.mqtt_password = form.mqtt_password;
      await api.put('/settings', payload);
      // The baseline becomes what the server was SENT, not the whole form: the certificate text is left out of the
      // payload while TLS is off, so it was not saved and must stay a difference (and the unsaved notice on).
      const { mqtt_password: sentPassword, ...sent } = payload; // eslint-disable-line no-unused-vars
      setBaseline((b) => ({ ...b, ...sent }));
      setForm((f) => ({ ...f, mqtt_password: '' }));
      if (form.mqtt_password) setPasswordSet(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      // The broker is dialled right after the save; give the handshake a moment, then say how it went.
      loadStatus();
      setTimeout(loadStatus, 2500);
    } catch (err) {
      // Beside the CA box only while that box is on screen; otherwise in the banner, so a refusal is never invisible.
      if (err.data?.field === 'mqtt_tls_ca' && form.mqtt_tls) setCaError(err.message);
      else setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppHeader title="MQTT" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        {unsaved && (
          <UnsavedNotice restored={restored} onDiscard={discardChanges}
            note="The password and the certificate text are not kept if this page reloads; enter them again." />
        )}

        <form onSubmit={save}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Optional — connects to your existing MQTT broker (e.g. from Home Assistant /
              Zigbee2MQTT) to show temperature and humidity on each camera.
            </div>
            <label className="log-viewer__toggle" style={{ marginBottom: 14 }}>
              <Switch
                checked={!!form.mqtt_enabled}
                onChange={(e) => setForm({ ...form, mqtt_enabled: e.target.checked })}
              />
              Enable MQTT
            </label>
            <div className="field">
              <label htmlFor="mqtt-host">Broker host</label>
              <input
                id="mqtt-host"
                placeholder="e.g. 192.168.1.50"
                value={form.mqtt_host || ''}
                onChange={(e) => setForm({ ...form, mqtt_host: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="mqtt-port">Broker port</label>
              <input
                id="mqtt-port"
                type="number"
                // A TCP port (#562): the server rejects anything outside 1-65535 (routes/settings.js), so
                // the field says so before Save instead of after. Left blank stays valid: the server
                // then uses the default, 1883 (the placeholder).
                min="1"
                max="65535"
                placeholder="1883"
                value={form.mqtt_port || ''}
                onChange={(e) => setForm({ ...form, mqtt_port: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="mqtt-username">Username (optional)</label>
              <input
                id="mqtt-username"
                value={form.mqtt_username || ''}
                onChange={(e) => setForm({ ...form, mqtt_username: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="mqtt-password">Password (optional)</label>
              <input
                id="mqtt-password"
                type="password"
                placeholder={passwordSet ? 'Leave blank to keep current password' : ''}
                value={form.mqtt_password || ''}
                onChange={(e) => setForm({ ...form, mqtt_password: e.target.value })}
              />
            </div>

            {/* TLS (#537). Off by default: a plain mqtt:// connection, as before. */}
            <label className="log-viewer__toggle" style={{ marginBottom: 6 }}>
              <Switch
                checked={!!form.mqtt_tls}
                onChange={(e) => setForm({ ...form, mqtt_tls: e.target.checked })}
              />
              Use TLS (mqtts://)
            </label>
            <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
              Encrypts the connection, including the username and password. Your broker must have TLS turned on,
              usually on port 8883. With the port left blank, 8883 is used when this is on.
            </div>
            {form.mqtt_tls && (
              <>
                <label className="log-viewer__toggle" style={{ marginBottom: 6 }}>
                  <Switch
                    checked={!!form.mqtt_tls_verify}
                    onChange={(e) => setForm({ ...form, mqtt_tls_verify: e.target.checked })}
                  />
                  Verify the broker's certificate
                </label>
                <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
                  Keep this on. Turned off, the connection is still encrypted but Nightlight no longer checks who
                  it is talking to, so anyone on your network who answers as the broker is trusted.
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label htmlFor="mqtt-tls-ca">CA certificate (optional)</label>
                  <textarea
                    id="mqtt-tls-ca"
                    rows={6}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={'-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----'}
                    style={{ fontFamily: 'monospace', fontSize: 12 }}
                    value={form.mqtt_tls_ca || ''}
                    onChange={(e) => { setCaError(''); setForm({ ...form, mqtt_tls_ca: e.target.value }); }}
                    aria-invalid={caError ? 'true' : undefined}
                    aria-describedby="mqtt-tls-ca-help"
                  />
                  {caError && <div className="error-banner" role="alert" style={{ marginTop: 8 }}>{caError}</div>}
                  <div id="mqtt-tls-ca-help" className="camera-tile__sub" style={{ marginTop: 6 }}>
                    Only needed when your broker uses a certificate from your own authority or a self-signed one.
                    Paste the certificate of the authority that signed it (or, for a self-signed broker, the broker's
                    own certificate) in PEM form. Leave blank to
                    trust the usual public authorities. When filled in, only this certificate is trusted for this
                    connection. A certificate is not a secret; never paste a private key here.
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Why it is not connected, in words (#537). Nothing is shown while it is connected or switched off. */}
          {status?.enabled && !status.connected && status.error && (
            <div className="error-banner" role="status" style={{ marginBottom: 12 }}>
              Not connected: {status.error}
            </div>
          )}
          {status?.enabled && status.connected && (
            <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
              Connected{status.tls ? ' over TLS' : ''}.
            </div>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </main>
    </>
  );
}
