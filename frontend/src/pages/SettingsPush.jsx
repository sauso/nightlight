import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import SettingsBack from '../components/SettingsBack.jsx';

export default function SettingsPush() {
  const [pushStatus, setPushStatus] = useState(null); // { push_enabled, configured } | null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/push/status').then(setPushStatus).catch(() => {});
  }, []);

  async function togglePush(on) {
    setBusy(true);
    setError('');
    try {
      // Server validates the Firebase files when enabling and 400s if any are missing.
      setPushStatus(await api.put('/push/enable', { enabled: on }));
    } catch (err) {
      setError(err.message);
      // Snap the toggle back to the real (unchanged) server state.
      api.get('/push/status').then(setPushStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppHeader title="Push notifications" />
      <main className="app-main">
        <SettingsBack />
        <div className="card">
          <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
            Send a push notification to phones when a camera with motion detection sees movement,
            even when the app is closed. Requires your own Firebase project — drop{' '}
            <strong>firebase-service-account.json</strong> and <strong>google-services.json</strong>{' '}
            into the data directory first (see <strong>docs/notifications.md</strong>). Motion
            detection and the in-app <strong>Recent alerts</strong> (under Logs) work with or without
            this.
          </div>
          {error && (
            <div className="error-banner" style={{ marginBottom: 10 }}>{error}</div>
          )}
          <label className="log-viewer__toggle">
            <input
              type="checkbox"
              checked={!!pushStatus?.push_enabled}
              disabled={busy || !pushStatus}
              onChange={(e) => togglePush(e.target.checked)}
            />
            Enable push notifications
          </label>
          {pushStatus && !pushStatus.configured && (
            <div className="camera-tile__sub" style={{ marginTop: 10 }}>
              Firebase files aren't detected in the data directory yet — add them, then enable.
            </div>
          )}
        </div>
      </main>
    </>
  );
}
