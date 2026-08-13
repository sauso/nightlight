import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';

const BACK = { to: '/settings/push', label: 'Push notifications' };

export default function SettingsPushGotify() {
  const [form, setForm] = useState({ enabled: false, configured: false, server_url: '', app_token: '', priority: 5 });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    api.get('/gotify/config').then((c) => { setForm(c); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSaved(false); setTestMsg(null);
    try {
      const next = await api.put('/gotify/config', { enabled: form.enabled, server_url: form.server_url, app_token: form.app_token, priority: form.priority });
      setForm(next); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function sendTest() {
    setBusy(true); setTestMsg(null); setError('');
    try { await api.post('/gotify/test'); setTestMsg({ ok: true, text: 'Test sent — check Gotify.' }); }
    catch (err) { setTestMsg({ ok: false, text: err.message }); } finally { setBusy(false); }
  }

  return (
    <>
      <AppHeader title="Gotify" back={BACK} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        <form onSubmit={save}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Sends alerts to your self-hosted <strong>Gotify</strong> server. In Gotify, create an
              <strong> application</strong> and copy its token below. Text only (Gotify doesn't show images);
              tapping an alert opens the camera.
            </div>
            <label className="log-viewer__toggle" style={{ marginBottom: 14 }}>
              <Switch checked={!!form.enabled} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Enable Gotify notifications
            </label>
            <div className="field">
              <label htmlFor="gotify-server">Server URL</label>
              <input id="gotify-server" value={form.server_url || ''} onChange={(e) => setForm({ ...form, server_url: e.target.value })}
                placeholder="https://gotify.example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="gotify-token">Application token</label>
              <input id="gotify-token" value={form.app_token || ''} onChange={(e) => setForm({ ...form, app_token: e.target.value })} placeholder="A…" autoComplete="off" />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="gotify-priority">Priority (0–10)</label>
              <input id="gotify-priority" type="number" min="0" max="10" value={form.priority ?? 5} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
              <div className="camera-tile__sub">Higher shows more prominently and can bypass quiet settings in the Gotify app.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" type="submit" disabled={busy || !loaded}>{busy ? 'Working…' : 'Save changes'}</button>
            <button className="btn btn-secondary" type="button" disabled={busy || !form.configured} onClick={sendTest}>Send test</button>
          </div>
          {testMsg && (
            <div className="camera-tile__sub" style={{ marginTop: 8, color: testMsg.ok ? 'var(--live)' : 'var(--offline)' }}>{testMsg.text}</div>
          )}
        </form>
      </main>
    </>
  );
}
