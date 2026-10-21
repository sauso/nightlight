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

const INITIAL = { enabled: false, configured: false, app_token_set: false, app_token_masked: '', user_key_set: false, user_key_masked: '', device: '' };

// What a reload-surviving draft may store (#377). Not the application token or the user key (secrets, kept apart from
// `po`). Only two fields are worth keeping on this page.
const DRAFT_FIELDS = ['enabled', 'device'];

export default function SettingsPushPushover() {
  const draftKey = useDraftKey('push:pushover');
  // Read once on mount: edits typed before a background reload, or before a visit to another screen.
  const [restoredDraft] = useState(() => loadDraft(draftKey, DRAFT_FIELDS));
  const [restored, setRestored] = useState(!!restoredDraft);
  const [po, setPo] = useState(INITIAL);
  // The config as last loaded or last successfully SAVED, never touched by typing: Send test tests this,
  // so it is what the on-screen form is compared against (#396). A failed save leaves it alone.
  const [lastSaved, setLastSaved] = useState(INITIAL);
  // Secret inputs are separate and start empty; the server never sends the tokens back, so a blank
  // field on save means "keep the saved one".
  const [appToken, setAppToken] = useState('');
  const [userKey, setUserKey] = useState('');
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
    api.get('/pushover/config').then((c) => {
      // The restored draft goes back over the server's values (the load replaces the whole form object).
      setPo({ ...c, ...restoredDraft }); setLastSaved(c); setConfigLoaded(true); setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSaved(false); setTestMsg(null);
    try {
      // Server validates the tokens with Pushover when enabling and 400s if they don't check out.
      // Blank fields keep the saved secrets.
      const next = await api.put('/pushover/config', { enabled: po.enabled, app_token: appToken, user_key: userKey, device: po.device || '' });
      setPo(next); setLastSaved(next); setConfigLoaded(true); setAppToken(''); setUserKey(''); setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  // Send test goes to the SAVED config (POST has no body), so it is held back while the screen differs.
  const dirty = hasUnsavedEdits(po, lastSaved, [appToken, userKey]);
  // Keeps the stored draft equal to "what is on screen, if it differs from what is saved". Its return value is not
  // used: `dirty` above is what gates Send test and works on a failed load too (settingsPush.test.jsx).
  useFormDraft({ key: draftKey, allow: DRAFT_FIELDS, form: po, baseline: lastSaved, ready: configLoaded, secrets: [appToken, userKey] });

  // Back to what is saved: useFormDraft sees form == baseline and removes the stored draft.
  function discardChanges() {
    setPo(lastSaved);
    setAppToken('');
    setUserKey('');
    setRestored(false);
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
        {dirty && configLoaded && (
          <UnsavedNotice restored={restored} onDiscard={discardChanges}
            note="The API token and user key are not kept if this page reloads; enter them again." />
        )}
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
            <button className="btn btn-secondary" type="button" disabled={busy || !po.configured || dirty}
              aria-describedby={dirty ? 'po-test-hint' : undefined} onClick={sendTest}>Send test with saved settings</button>
          </div>
          {dirty && <div id="po-test-hint" className="camera-tile__sub" style={{ marginTop: 8 }}>{UNSAVED_TEST_HINT}</div>}
          {testMsg && (
            <div className="camera-tile__sub" style={{ marginTop: 8, color: testMsg.ok ? 'var(--live)' : 'var(--offline)' }}>{testMsg.text}</div>
          )}
        </form>
      </main>
    </>
  );
}
