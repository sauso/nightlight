import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import SettingsBack from '../components/SettingsBack.jsx';
import Switch from '../components/Switch.jsx';

export default function SettingsPush() {
  // --- Firebase / FCM (Android app) ---
  const [pushStatus, setPushStatus] = useState(null); // { push_enabled, configured } | null
  const [fbEnabled, setFbEnabled] = useState(false);
  const [fbBusy, setFbBusy] = useState(false);
  const [fbError, setFbError] = useState('');
  const [fbSaved, setFbSaved] = useState(false);

  // --- Pushover ---
  const [po, setPo] = useState({ enabled: false, configured: false, app_token: '', user_key: '' });
  const [poLoaded, setPoLoaded] = useState(false);
  const [poBusy, setPoBusy] = useState(false);
  const [poError, setPoError] = useState('');
  const [poSaved, setPoSaved] = useState(false);
  const [testMsg, setTestMsg] = useState(null); // { ok, text } | null

  useEffect(() => {
    api.get('/push/status').then((s) => { setPushStatus(s); setFbEnabled(!!s.push_enabled); }).catch(() => {});
    api.get('/pushover/config').then((c) => { setPo(c); setPoLoaded(true); }).catch(() => setPoLoaded(true));
  }, []);

  async function saveFb(e) {
    e.preventDefault();
    setFbBusy(true); setFbError(''); setFbSaved(false);
    try {
      const next = await api.put('/push/enable', { enabled: fbEnabled });
      setPushStatus(next); setFbEnabled(!!next.push_enabled);
      setFbSaved(true); setTimeout(() => setFbSaved(false), 2500);
    } catch (err) {
      setFbError(err.message); setFbEnabled(!!pushStatus?.push_enabled);
    } finally { setFbBusy(false); }
  }

  async function savePo(e) {
    e.preventDefault();
    setPoBusy(true); setPoError(''); setPoSaved(false); setTestMsg(null);
    try {
      // Server validates the tokens with Pushover when enabling and 400s if they don't check out.
      const next = await api.put('/pushover/config', {
        enabled: po.enabled, app_token: po.app_token, user_key: po.user_key,
      });
      setPo(next);
      setPoSaved(true); setTimeout(() => setPoSaved(false), 2500);
    } catch (err) {
      setPoError(err.message);
    } finally { setPoBusy(false); }
  }

  async function sendTest() {
    setPoBusy(true); setTestMsg(null); setPoError('');
    try {
      await api.post('/pushover/test');
      setTestMsg({ ok: true, text: 'Test sent — check your device.' });
    } catch (err) {
      setTestMsg({ ok: false, text: err.message });
    } finally { setPoBusy(false); }
  }

  return (
    <>
      <AppHeader title="Push notifications" />
      <main className="app-main">
        <SettingsBack />

        <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
          Get alerted on your phone when a camera with motion detection sees movement, even when the
          app is closed. Choose either method below — <strong>Pushover</strong> is the simplest and
          works on iOS; <strong>Firebase</strong> delivers to the Nightlight Android app directly.
          Motion detection and the in-app <strong>Recent alerts</strong> (under Logs) work with or
          without any of this.
        </div>

        {/* ---- Pushover ---- */}
        <div className="section-title">Pushover</div>
        {poError && <div className="error-banner">{poError}</div>}
        {poSaved && <div className="saved-banner">Saved ✓</div>}
        <form onSubmit={savePo}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Install the <strong>Pushover</strong> app on your phone (iOS/Android), create a Pushover
              application to get an <strong>API token</strong>, and paste it below along with your
              <strong> user or group key</strong> (a group key alerts multiple caregivers). Motion
              alerts include a snapshot of what triggered them.
            </div>
            <label className="log-viewer__toggle" style={{ marginBottom: 14 }}>
              <Switch
                checked={!!po.enabled}
                disabled={poBusy || !poLoaded}
                onChange={(e) => setPo({ ...po, enabled: e.target.checked })}
              />
              Enable Pushover notifications
            </label>
            <div className="field">
              <label htmlFor="po-token">Application API token</label>
              <input
                id="po-token"
                value={po.app_token || ''}
                onChange={(e) => setPo({ ...po, app_token: e.target.value })}
                placeholder="a1b2c3…"
                autoComplete="off"
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="po-user">User or group key</label>
              <input
                id="po-user"
                value={po.user_key || ''}
                onChange={(e) => setPo({ ...po, user_key: e.target.value })}
                placeholder="u1v2w3…"
                autoComplete="off"
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" type="submit" disabled={poBusy || !poLoaded}>
              {poBusy ? 'Working…' : 'Save changes'}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={poBusy || !po.configured}
              onClick={sendTest}
            >
              Send test
            </button>
          </div>
          {testMsg && (
            <div className="camera-tile__sub" style={{ marginTop: 8, color: testMsg.ok ? 'var(--live, inherit)' : 'var(--offline, inherit)' }}>
              {testMsg.text}
            </div>
          )}
        </form>

        {/* ---- Firebase / FCM ---- */}
        <div className="section-title" style={{ marginTop: 22 }}>Firebase (Android app)</div>
        {fbError && <div className="error-banner">{fbError}</div>}
        {fbSaved && <div className="saved-banner">Saved ✓</div>}
        <form onSubmit={saveFb}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Delivers alerts straight to the Nightlight Android app via your own Firebase project —
              drop <strong>firebase-service-account.json</strong> and <strong>google-services.json</strong>{' '}
              into the data directory first (see <strong>docs/notifications.md</strong>). Android only.
            </div>
            <label className="log-viewer__toggle" style={{ margin: 0 }}>
              <Switch
                checked={fbEnabled}
                disabled={fbBusy || !pushStatus}
                onChange={(e) => setFbEnabled(e.target.checked)}
              />
              Enable Firebase notifications
            </label>
            {pushStatus && !pushStatus.configured && (
              <div className="camera-tile__sub" style={{ marginTop: 10 }}>
                Firebase files aren't detected in the data directory yet — add them, then enable.
              </div>
            )}
          </div>
          <button className="btn btn-primary" type="submit" disabled={fbBusy || !pushStatus}>
            {fbBusy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </main>
    </>
  );
}
