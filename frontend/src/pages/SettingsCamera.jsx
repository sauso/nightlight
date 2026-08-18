import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import Switch from '../components/Switch.jsx';

// Camera controls — global camera behaviour that isn't per-camera: the PTZ step size (moved here out
// of General) and the offline-camera push alert. Save-on-submit, same pattern as SettingsGeneral; the
// settings PUT leaves any field we don't send untouched, so this page only owns these three.
export default function SettingsCamera() {
  const { settings, refresh } = useSettings();
  const [form, setForm] = useState(settings);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setForm((f) => ({ ...f, ...settings })), [settings]);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api.put('/settings', {
        ptz_step: form.ptz_step,
        camera_offline_alert_enabled: !!form.camera_offline_alert_enabled,
        camera_offline_alert_minutes: form.camera_offline_alert_minutes,
      });
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const offlineOn = !!form.camera_offline_alert_enabled;

  return (
    <>
      <AppHeader title="Camera controls" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}

        <form onSubmit={save}>
          <div className="card">
            <div className="card-title">Pan / tilt</div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="ptz-step">PTZ step size</label>
              <input
                id="ptz-step"
                type="number"
                min="1"
                max="100"
                value={form.ptz_step ?? 12}
                onChange={(e) => setForm({ ...form, ptz_step: e.target.value })}
              />
              <div className="camera-tile__sub">
                How far a camera moves per tap of the pan/tilt controls. Larger = bigger jumps.
                Only affects cameras that support precise (RelativeMove) positioning; others move a
                fixed amount. The right value depends on the camera — around 12 suits the common
                Sonoff pan/tilt cameras.
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">Offline alerts</div>
            <div className="list-row" style={{ padding: 0 }}>
              <div>
                <div>Notify when a camera goes offline</div>
                <div className="camera-tile__sub">
                  Send a push notification if a camera stops delivering video for longer than the
                  threshold below, and another when it comes back. Uses whichever push channels you've
                  set up (Firebase, Pushover, ntfy, Gotify).
                </div>
              </div>
              <Switch
                checked={offlineOn}
                disabled={busy}
                onChange={(e) => setForm({ ...form, camera_offline_alert_enabled: e.target.checked })}
              />
            </div>

            <div className="field" style={{ marginTop: 14, marginBottom: 0 }}>
              <label htmlFor="offline-mins">Offline for longer than (minutes)</label>
              <input
                id="offline-mins"
                type="number"
                min="1"
                max="1440"
                disabled={!offlineOn}
                value={form.camera_offline_alert_minutes ?? 5}
                onChange={(e) => setForm({ ...form, camera_offline_alert_minutes: e.target.value })}
              />
              <div className="camera-tile__sub">
                A brief blip that recovers on its own won't alert — only an outage that lasts at least
                this long. One notification per outage.
              </div>
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: 20 }}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </main>
    </>
  );
}
