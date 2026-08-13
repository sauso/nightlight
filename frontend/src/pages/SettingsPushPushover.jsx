import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';

const BACK = { to: '/settings/push', label: 'Push notifications' };

export default function SettingsPushPushover() {
  const [po, setPo] = useState({ enabled: false, configured: false, app_token: '', user_key: '' });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    api.get('/pushover/config').then((c) => { setPo(c); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSaved(false); setTestMsg(null);
    try {
      // Server validates the tokens with Pushover when enabling and 400s if they don't check out.
      const next = await api.put('/pushover/config', { enabled: po.enabled, app_token: po.app_token, user_key: po.user_key });
      setPo(next); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function sendTest() {
    setBusy(true); setTestMsg(null); setError('');
    try { await api.post('/pushover/test'); setTestMsg({ ok: true, text: 'Test sent — check your device.' }); }
    catch (err) { setTestMsg({ ok: false, text: err.message }); } finally { setBusy(false); }
  }

  return (
    <>
      <AppHeader title="Pushover" back={BACK} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        <form onSubmit={save}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Install the <strong>Pushover</strong> app (iOS/Android), create a Pushover application to get an
              <strong> API token</strong>, and paste it below with your <strong>user or group key</strong> (a group
              key alerts multiple caregivers). Motion/sound alerts include a snapshot.
            </div>
            <label className="log-viewer__toggle" style={{ marginBottom: 14 }}>
              <Switch checked={!!po.enabled} disabled={busy || !loaded} onChange={(e) => setPo({ ...po, enabled: e.target.checked })} />
              Enable Pushover notifications
            </label>
            <div className="field">
              <label htmlFor="po-token">Application API token</label>
              <input id="po-token" value={po.app_token || ''} onChange={(e) => setPo({ ...po, app_token: e.target.value })} placeholder="a1b2c3…" autoComplete="off" />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="po-user">User or group key</label>
              <input id="po-user" value={po.user_key || ''} onChange={(e) => setPo({ ...po, user_key: e.target.value })} placeholder="u1v2w3…" autoComplete="off" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" type="submit" disabled={busy || !loaded}>{busy ? 'Working…' : 'Save changes'}</button>
            <button className="btn btn-secondary" type="button" disabled={busy || !po.configured} onClick={sendTest}>Send test</button>
          </div>
          {testMsg && (
            <div className="camera-tile__sub" style={{ marginTop: 8, color: testMsg.ok ? 'var(--live)' : 'var(--offline)' }}>{testMsg.text}</div>
          )}
        </form>
      </main>
    </>
  );
}
