import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import SecretField from '../components/SecretField.jsx';

const BACK = { to: '/settings/push', label: 'Push notifications' };

export default function SettingsPushPushover() {
  const [po, setPo] = useState({ enabled: false, configured: false, app_token_set: false, app_token_masked: '', user_key_set: false, user_key_masked: '', device: '' });
  // Secret inputs are separate and start empty; the server never sends the tokens back, so a blank
  // field on save means "keep the saved one".
  const [appToken, setAppToken] = useState('');
  const [userKey, setUserKey] = useState('');
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
      // Blank fields keep the saved secrets.
      const next = await api.put('/pushover/config', { enabled: po.enabled, app_token: appToken, user_key: userKey, device: po.device || '' });
      setPo(next); setAppToken(''); setUserKey(''); setSaved(true); setTimeout(() => setSaved(false), 2500);
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
              <SecretField
                id="po-token"
                label="Application API token"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                isSet={po.app_token_set}
                masked={po.app_token_masked}
                placeholder="a1b2c3…"
                disabled={busy || !loaded}
              />
            </div>
            <SecretField
              id="po-user"
              label="User or group key"
              value={userKey}
              onChange={(e) => setUserKey(e.target.value)}
              isSet={po.user_key_set}
              masked={po.user_key_masked}
              placeholder="u1v2w3…"
              disabled={busy || !loaded}
            />
            <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
              <label htmlFor="po-device">Device <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>(optional)</span></label>
              <input
                id="po-device"
                value={po.device || ''}
                onChange={(e) => setPo({ ...po, device: e.target.value })}
                placeholder="Leave blank to alert all your devices"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={busy || !loaded}
              />
              <div className="camera-tile__sub" style={{ marginTop: 6 }}>
                Send alerts only to a specific Pushover device (its name as shown in the Pushover app). Leave
                blank to send to all of your devices. Separate multiple device names with commas.
              </div>
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
