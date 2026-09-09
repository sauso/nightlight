import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';

const BACK = { to: '/settings/push', label: 'Push notifications' };

export default function SettingsPushFirebase() {
  const [pushStatus, setPushStatus] = useState(null); // { push_enabled, configured } | null
  const [fbEnabled, setFbEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // ⚠️ On failure the page stays disabled ON PURPOSE, and that is the half worth protecting.
    // `pushStatus` is both the data and the ready signal, so there is no safe default to fall back to:
    // guessing `configured: false` would put "your Firebase files aren't detected" on screen — a
    // specific, actionable, and quite possibly false claim — when the truth is that we do not know.
    // A greyed-out page is the honest state. What was wrong was swallowing the reason with it, which
    // left nothing on screen to explain why nothing worked; the error is now shown.
    api.get('/push/status')
      .then((s) => { setPushStatus(s); setFbEnabled(!!s.push_enabled); })
      .catch((err) => setError(err.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true); setError(''); setSaved(false);
    try {
      const next = await api.put('/push/enable', { enabled: fbEnabled });
      setPushStatus(next); setFbEnabled(!!next.push_enabled);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message); setFbEnabled(!!pushStatus?.push_enabled);
    } finally { setBusy(false); }
  }

  return (
    <>
      <AppHeader title="Firebase" back={BACK} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}
        <form onSubmit={save}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Delivers alerts straight to the Nightlight Android app via your own Firebase project — drop
              <strong> firebase-service-account.json</strong> and <strong>google-services.json</strong> into the
              data directory first (see <strong>docs/notifications.md</strong>). Android only.
            </div>
            <label className="log-viewer__toggle" style={{ margin: 0 }}>
              <Switch checked={fbEnabled} disabled={busy || !pushStatus} onChange={(e) => setFbEnabled(e.target.checked)} />
              Enable Firebase notifications
            </label>
            {pushStatus && !pushStatus.configured && (
              <div className="camera-tile__sub" style={{ marginTop: 10 }}>
                Firebase files aren't detected in the data directory yet — add them, then enable.
              </div>
            )}
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy || !pushStatus}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </main>
    </>
  );
}
