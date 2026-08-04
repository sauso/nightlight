import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import SettingsBack from '../components/SettingsBack.jsx';

export default function SettingsPush() {
  const [pushStatus, setPushStatus] = useState(null); // { push_enabled, configured } | null
  const [enabled, setEnabled] = useState(false); // local checkbox state, applied on Save
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/push/status').then((s) => {
      setPushStatus(s);
      setEnabled(!!s.push_enabled);
    }).catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      // Server validates the Firebase files when enabling and 400s if any are missing.
      const next = await api.put('/push/enable', { enabled });
      setPushStatus(next);
      setEnabled(!!next.push_enabled);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
      // Revert the toggle to the real (unchanged) server state.
      setEnabled(!!pushStatus?.push_enabled);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppHeader title="Push notifications" />
      <main className="app-main">
        <SettingsBack />
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}

        <form onSubmit={save}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Send a push notification to phones when a camera with motion detection sees movement,
              even when the app is closed. Requires your own Firebase project — drop{' '}
              <strong>firebase-service-account.json</strong> and <strong>google-services.json</strong>{' '}
              into the data directory first (see <strong>docs/notifications.md</strong>). Motion
              detection and the in-app <strong>Recent alerts</strong> (under Logs) work with or
              without this.
            </div>
            <label className="log-viewer__toggle" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={busy || !pushStatus}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Enable push notifications
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
