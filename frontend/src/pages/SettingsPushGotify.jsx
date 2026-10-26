import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useLater } from '../lib/useLater.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';
import SecretField from '../components/SecretField.jsx';
import { hasUnsavedEdits, UNSAVED_TEST_HINT } from '../lib/unsavedEdits.js';
import UnsavedNotice from '../components/UnsavedNotice.jsx';
import { loadDraft } from '../lib/formDraft.js';
import { useDraftKey, useFormDraft } from '../lib/useFormDraft.js';

const BACK = { to: '/settings/push', label: 'Push notifications' };

const INITIAL = { enabled: false, configured: false, server_url: '', app_token_set: false, app_token_masked: '', priority: 5 };

// What a reload-surviving draft may store (#377). Not the application token (a secret, and kept apart from `form`).
// A server URL that carries credentials is dropped by formDraft.js whatever the field is called.
const DRAFT_FIELDS = ['enabled', 'server_url', 'priority'];

export default function SettingsPushGotify() {
  const draftKey = useDraftKey('push:gotify');
  // Read once on mount: edits typed before a background reload, or before a visit to another screen.
  const [restoredDraft] = useState(() => loadDraft(draftKey, DRAFT_FIELDS));
  const [restored, setRestored] = useState(!!restoredDraft);
  const [form, setForm] = useState(INITIAL);
  // The config as last loaded or last successfully SAVED, never touched by typing: Send test tests this,
  // so it is what the on-screen form is compared against (#396). A failed save leaves it alone.
  const [lastSaved, setLastSaved] = useState(INITIAL);
  const [appToken, setAppToken] = useState(''); // secret input, blank = keep saved
  const [loaded, setLoaded] = useState(false);
  // The GET answered. Separate from `loaded` (which also becomes true after a FAILED load so the page stays usable):
  // a draft is written, restored and cleared only against a config that really arrived, or an unloaded form would
  // read as "nothing changed" and wipe it.
  const [configLoaded, setConfigLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const later = useLater(); // blanks the "Saved" tick; cancelled when the page goes away (#855)
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    api.get('/gotify/config').then((c) => {
      // The restored draft goes back over the server's values (the load replaces the whole form object).
      setForm({ ...c, ...restoredDraft }); setLastSaved(c); setConfigLoaded(true); setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSaved(false); setTestMsg(null);
    try {
      const next = await api.put('/gotify/config', { enabled: form.enabled, server_url: form.server_url, app_token: appToken, priority: form.priority });
      setForm(next); setLastSaved(next); setConfigLoaded(true); setAppToken(''); setSaved(true); later(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  // Send test goes to the SAVED config (POST has no body), so it is held back while the screen differs.
  // `priority` is a number from the server and a string once typed: hasUnsavedEdits compares as strings.
  const dirty = hasUnsavedEdits(form, lastSaved, [appToken]);
  // Keeps the stored draft equal to "what is on screen, if it differs from what is saved". Its return value is not
  // used: `dirty` above is what gates Send test and works on a failed load too (settingsPush.test.jsx).
  useFormDraft({ key: draftKey, allow: DRAFT_FIELDS, form, baseline: lastSaved, ready: configLoaded, secrets: [appToken] });

  // Back to what is saved: useFormDraft sees form == baseline and removes the stored draft.
  function discardChanges() {
    setForm(lastSaved);
    setAppToken('');
    setRestored(false);
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
        {dirty && configLoaded && (
          <UnsavedNotice restored={restored} onDiscard={discardChanges}
            note="The application token is not kept if this page reloads; enter it again." />
        )}
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
              {/* ⚠️ `disabled={busy || !loaded}` like every other control here, and it is not
                  cosmetic: the load handler replaces the WHOLE form object, so anything typed into a
                  field left editable during the fetch is thrown away the instant the response lands —
                  the text vanishes with no error and nothing to explain it. This field was the only
                  one missing the guard. Same failure as the SettingsContext value that arrived a
                  moment after boot and destroyed a user's typing. */}
              <input id="gotify-server" value={form.server_url || ''} onChange={(e) => setForm({ ...form, server_url: e.target.value })}
                placeholder="https://gotify.example.com" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                disabled={busy || !loaded} />
            </div>
            <div className="field">
              <SecretField
                id="gotify-token"
                label="Application token"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                isSet={form.app_token_set}
                masked={form.app_token_masked}
                placeholder="A…"
                disabled={busy || !loaded}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="gotify-priority">Priority (0–10)</label>
              <input id="gotify-priority" type="number" min="0" max="10" value={form.priority ?? 5} onChange={(e) => setForm({ ...form, priority: e.target.value })}
                disabled={busy || !loaded} />
              <div className="camera-tile__sub">Higher shows more prominently and can bypass quiet settings in the Gotify app.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-primary" type="submit" disabled={busy || !loaded}>{busy ? 'Working…' : 'Save changes'}</button>
            <button className="btn btn-secondary" type="button" disabled={busy || !form.configured || dirty}
              aria-describedby={dirty ? 'gotify-test-hint' : undefined} onClick={sendTest}>Send test with saved settings</button>
          </div>
          {dirty && <div id="gotify-test-hint" className="camera-tile__sub" style={{ marginTop: 8 }}>{UNSAVED_TEST_HINT}</div>}
          {testMsg && (
            <div className="camera-tile__sub" style={{ marginTop: 8, color: testMsg.ok ? 'var(--live)' : 'var(--offline)' }}>{testMsg.text}</div>
          )}
        </form>
      </main>
    </>
  );
}
