import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import SecretField from '../components/SecretField.jsx';
import { hasUnsavedEdits, UNSAVED_TEST_HINT } from '../lib/unsavedEdits.js';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';

const BACK = { to: '/settings/push', label: 'Push notifications' };

const INITIAL = { enabled: false, configured: false, server_url: 'https://ntfy.sh', topic: '', token_set: false, token_masked: '', username: '', password_set: false };

// What a reload-surviving draft may store (#377). Not the access token or the password (secrets, kept apart from
// `form`), and NOT the topic: the page itself says the topic is the only thing keeping a public-server alert feed
// private ("anyone who knows it can read your alerts"), so it is treated as a secret. A server URL that carries
// credentials is dropped by formDraft.js whatever the field is called.
const DRAFT_FIELDS = ['enabled', 'server_url', 'username'];

export default function SettingsPushNtfy() {
  const draftKey = useDraftKey('push:ntfy');
  // Read once on mount: edits typed before a background reload, or before a visit to another screen.
  const [restoredDraft] = useState(() => loadDraft(draftKey, DRAFT_FIELDS));
  const [restored, setRestored] = useState(!!restoredDraft);
  const [form, setForm] = useState(INITIAL);
  // The config as last loaded or last successfully SAVED, never touched by typing: Send test tests this,
  // so it is what the on-screen form is compared against (#396). A failed save leaves it alone.
  const [lastSaved, setLastSaved] = useState(INITIAL);
  const [token, setToken] = useState(''); // secret — blank means keep the stored one
  const [password, setPassword] = useState(''); // separate — blank means keep the stored one
  const [loaded, setLoaded] = useState(false);
  // The GET answered. Separate from `loaded` (which also becomes true after a FAILED load so the page stays usable):
  // a draft is written, restored and cleared only against a config that really arrived, or an unloaded form would
  // read as "nothing changed" and wipe it.
  const [configLoaded, setConfigLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    api.get('/ntfy/config').then((c) => {
      // The restored draft goes back over the server's values (the load replaces the whole form object).
      setForm({ ...c, ...restoredDraft }); setLastSaved(c); setConfigLoaded(true); setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSaved(false); setTestMsg(null);
    try {
      const payload = { enabled: form.enabled, server_url: form.server_url, topic: form.topic, token, username: form.username };
      if (password) payload.password = password;
      const next = await api.put('/ntfy/config', payload);
      setForm(next); setLastSaved(next); setToken(''); setPassword(''); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  // Send test goes to the SAVED config (POST has no body), so it is held back while the screen differs.
  const dirty = hasUnsavedEdits(form, lastSaved, [token, password]);
  // Keeps the stored draft equal to "what is on screen, if it differs from what is saved". Its return value is not
  // used: `dirty` above is what gates Send test and works on a failed load too (settingsPush.test.jsx).
  useFormDraft({ key: draftKey, allow: DRAFT_FIELDS, form, baseline: lastSaved, ready: configLoaded, secrets: [token, password] });

  // Back to what is saved: useFormDraft sees form == baseline and removes the stored draft.
  function discardChanges() {
    setForm(lastSaved);
    setToken('');
    setPassword('');
    setRestored(false);
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
        {dirty && configLoaded && (
          <UnsavedNotice restored={restored} onDiscard={discardChanges}
            note="The topic, access token and password are not kept if this page reloads; enter them again." />
        )}
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
                placeholder="https://ntfy.sh" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy || !loaded} />
            </div>
            <div className="field">
              <label htmlFor="ntfy-topic">Topic</label>
              <input id="ntfy-topic" value={form.topic || ''} onChange={(e) => setForm({ ...form, topic: e.target.value })}
                placeholder="nightlight-alerts-x8k2" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy || !loaded} />
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
                <input id="ntfy-user" value={form.username || ''} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" autoCapitalize="none" disabled={busy || !loaded} />
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
            <button className="btn btn-secondary" type="button" disabled={busy || !form.configured || dirty}
              aria-describedby={dirty ? 'ntfy-test-hint' : undefined} onClick={sendTest}>Send test with saved settings</button>
          </div>
          {dirty && <div id="ntfy-test-hint" className="camera-tile__sub" style={{ marginTop: 8 }}>{UNSAVED_TEST_HINT}</div>}
          {testMsg && (
            <div className="camera-tile__sub" style={{ marginTop: 8, color: testMsg.ok ? 'var(--live)' : 'var(--offline)' }}>{testMsg.text}</div>
          )}
        </form>
      </main>
    </>
  );
}
