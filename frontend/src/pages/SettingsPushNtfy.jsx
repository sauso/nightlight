import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import SecretField from '../components/SecretField.jsx';

const BACK = { to: '/settings/push', label: 'Push notifications' };

export default function SettingsPushNtfy() {
  const [form, setForm] = useState({ enabled: false, configured: false, server_url: 'https://ntfy.sh', topic: '', token_set: false, token_masked: '', username: '', password_set: false });
  const [token, setToken] = useState(''); // secret — blank means keep the stored one
  const [password, setPassword] = useState(''); // separate — blank means keep the stored one
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    api.get('/ntfy/config').then((c) => { setForm(c); setLoaded(true); }).catch(() => setLoaded(true));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSaved(false); setTestMsg(null);
    try {
      const payload = { enabled: form.enabled, server_url: form.server_url, topic: form.topic, token, username: form.username };
      if (password) payload.password = password;
      const next = await api.put('/ntfy/config', payload);
      setForm(next); setToken(''); setPassword(''); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function sendTest() {
    setBusy(true); setTestMsg(null); setError('');
    try { await api.post('/ntfy/test'); setTestMsg({ ok: true, text: 'Test sent — check your ntfy subscription.' }); }
    catch (err) { setTestMsg({ ok: false, text: err.message }); } finally { setBusy(false); }
  }

  return (
    <>
      <AppHeader title="ntfy" back={BACK} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        <form onSubmit={save}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Sends alerts to an <strong>ntfy</strong> topic (ntfy.sh or your own server). Subscribe to the topic
              in the ntfy app or a browser; snapshots are attached inline. On a public server, pick a long,
              hard-to-guess topic name — anyone who knows it can read your alerts.
            </div>
            <label className="log-viewer__toggle" style={{ marginBottom: 14 }}>
              <Switch checked={!!form.enabled} disabled={busy || !loaded} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
              Enable ntfy notifications
            </label>
            <div className="field">
              <label htmlFor="ntfy-server">Server URL</label>
              <input id="ntfy-server" value={form.server_url || ''} onChange={(e) => setForm({ ...form, server_url: e.target.value })}
                placeholder="https://ntfy.sh" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </div>
            <div className="field">
              <label htmlFor="ntfy-topic">Topic</label>
              <input id="ntfy-topic" value={form.topic || ''} onChange={(e) => setForm({ ...form, topic: e.target.value })}
                placeholder="nightlight-alerts-x8k2" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
            </div>
            <div className="field">
              <SecretField
                id="ntfy-token"
                label="Access token (optional)"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                isSet={form.token_set}
                masked={form.token_masked}
                placeholder="tk_…"
                disabled={busy || !loaded}
                hint="For a protected topic — or use username/password below instead."
              />
            </div>
            <div className="onvif-box__row">
              <div className="field">
                <label htmlFor="ntfy-user">Username (optional)</label>
                <input id="ntfy-user" value={form.username || ''} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" autoCapitalize="none" />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="ntfy-pass">Password (optional)</label>
                <input id="ntfy-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder={form.password_set ? '•••••• (unchanged)' : ''} autoComplete="off" />
              </div>
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
