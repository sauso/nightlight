import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { getCommonTimezones } from '../lib/greeting.js';
import { FONT_PRESETS } from '../lib/fonts.js';
import AppHeader from '../components/AppHeader.jsx';
import LogViewer from '../components/LogViewer.jsx';
import EventLog from '../components/EventLog.jsx';
import RecentAlerts from '../components/RecentAlerts.jsx';

const PRESETS = [
  { label: 'Nursery (default)', accent: '#F5D9A8', live: '#7FBFA3', offline: '#E08585' },
  { label: 'Dusk lavender', accent: '#C9B6F5', live: '#7FBFA3', offline: '#E08585' },
  { label: 'Ocean calm', accent: '#8FD1E0', live: '#7FBFA3', offline: '#E0A57F' },
  { label: 'Rose quartz', accent: '#F5B8C6', live: '#8FBF9F', offline: '#E08585' },
];

export default function Settings() {
  const { settings, refresh } = useSettings();
  const [form, setForm] = useState(settings);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [timezones] = useState(getCommonTimezones);
  const [mqttPasswordSet, setMqttPasswordSet] = useState(false);
  // Push is its own immediate switch (validated server-side on enable), not part of the main form.
  const [pushStatus, setPushStatus] = useState(null); // { push_enabled, configured } | null
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState('');

  useEffect(() => setForm((f) => ({ ...f, ...settings })), [settings]);

  useEffect(() => {
    api.get('/push/status').then(setPushStatus).catch(() => {});
  }, []);

  async function togglePush(on) {
    setPushBusy(true);
    setPushError('');
    try {
      // Server validates the Firebase files when enabling and 400s if any are missing.
      setPushStatus(await api.put('/push/enable', { enabled: on }));
    } catch (err) {
      setPushError(err.message);
      // Snap the toggle back to the real (unchanged) server state.
      api.get('/push/status').then(setPushStatus).catch(() => {});
    } finally {
      setPushBusy(false);
    }
  }

  useEffect(() => {
    api.get('/settings/mqtt').then((mqtt) => {
      setForm((f) => ({
        ...f,
        mqtt_enabled: mqtt.mqtt_enabled,
        mqtt_host: mqtt.mqtt_host,
        mqtt_port: mqtt.mqtt_port,
        mqtt_username: mqtt.mqtt_username,
      }));
      setMqttPasswordSet(mqtt.mqtt_password_set);
    }).catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const payload = {
        app_name: form.app_name,
        accent_color: form.accent_color,
        live_color: form.live_color,
        offline_color: form.offline_color,
        timezone: form.timezone,
        font_choice: form.font_choice,
        temp_unit: form.temp_unit,
        mqtt_enabled: form.mqtt_enabled,
        mqtt_host: form.mqtt_host,
        mqtt_port: form.mqtt_port,
        mqtt_username: form.mqtt_username,
      };
      // Only send a new password if the admin actually typed one - an empty field
      // means "keep whatever's already saved," not "clear it."
      if (form.mqtt_password) payload.mqtt_password = form.mqtt_password;
      await api.put('/settings', payload);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function useBrowserTimezone() {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setForm({ ...form, timezone: detected });
  }

  function applyPreset(preset) {
    setForm({
      ...form,
      accent_color: preset.accent,
      live_color: preset.live,
      offline_color: preset.offline,
    });
  }

  return (
    <>
      <AppHeader title="Settings" />
      <main className="app-main">
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}

        <form onSubmit={save}>
          <div className="card">
            <div className="field">
              <label htmlFor="app-name">App name</label>
              <input
                id="app-name"
                value={form.app_name}
                onChange={(e) => setForm({ ...form, app_name: e.target.value })}
                required
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="timezone">Timezone</label>
              <select
                id="timezone"
                value={form.timezone}
                onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              >
                {!timezones.includes(form.timezone) && (
                  <option value={form.timezone}>{form.timezone}</option>
                )}
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
              <button
                type="button"
                className="icon-btn"
                style={{ padding: '8px 0 0' }}
                onClick={useBrowserTimezone}
              >
                Use this device's timezone
              </button>
            </div>
          </div>

          <div className="section-title">Theme presets</div>
          <div className="preset-row">
            {PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.label}
                className="preset-btn"
                onClick={() => applyPreset(preset)}
                title={preset.label}
              >
                <span style={{ background: preset.accent }} />
                <span style={{ background: preset.live }} />
                <span style={{ background: preset.offline }} />
              </button>
            ))}
          </div>

          <div className="section-title">Font</div>
          <div className="font-row">
            {Object.entries(FONT_PRESETS).map(([key, preset]) => (
              <button
                type="button"
                key={key}
                className={`font-btn${form.font_choice === key ? ' font-btn--active' : ''}`}
                onClick={() => setForm({ ...form, font_choice: key })}
              >
                <span className="font-btn__sample" style={{ fontFamily: preset.display }}>
                  {preset.sample}
                </span>
                <span className="font-btn__label">{preset.label}</span>
              </button>
            ))}
          </div>

          <div className="section-title">Colors</div>
          <div className="card">
            <div className="color-field">
              <label htmlFor="accent-color">Accent (buttons, highlights)</label>
              <div className="color-field__row">
                <input
                  id="accent-color"
                  type="color"
                  value={form.accent_color}
                  onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
                />
                <span className="camera-tile__sub">{form.accent_color}</span>
              </div>
            </div>
            <div className="color-field">
              <label htmlFor="live-color">Live indicator</label>
              <div className="color-field__row">
                <input
                  id="live-color"
                  type="color"
                  value={form.live_color}
                  onChange={(e) => setForm({ ...form, live_color: e.target.value })}
                />
                <span className="camera-tile__sub">{form.live_color}</span>
              </div>
            </div>
            <div className="color-field">
              <label htmlFor="offline-color">Offline / alert</label>
              <div className="color-field__row">
                <input
                  id="offline-color"
                  type="color"
                  value={form.offline_color}
                  onChange={(e) => setForm({ ...form, offline_color: e.target.value })}
                />
                <span className="camera-tile__sub">{form.offline_color}</span>
              </div>
            </div>
          </div>

          <div className="section-title">Temperature unit</div>
          <div className="preset-row">
            <button
              type="button"
              className={`font-btn${form.temp_unit === 'C' ? ' font-btn--active' : ''}`}
              onClick={() => setForm({ ...form, temp_unit: 'C' })}
            >
              <span className="font-btn__label">°C</span>
            </button>
            <button
              type="button"
              className={`font-btn${form.temp_unit === 'F' ? ' font-btn--active' : ''}`}
              onClick={() => setForm({ ...form, temp_unit: 'F' })}
            >
              <span className="font-btn__label">°F</span>
            </button>
          </div>

          <div className="section-title">MQTT (room temperature / humidity)</div>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Optional - connects to your existing MQTT broker (e.g. from Home
              Assistant / Zigbee2MQTT) to show temperature and humidity on each
              camera.
            </div>
            <label className="log-viewer__toggle" style={{ marginBottom: 14 }}>
              <input
                type="checkbox"
                checked={!!form.mqtt_enabled}
                onChange={(e) => setForm({ ...form, mqtt_enabled: e.target.checked })}
              />
              Enable MQTT
            </label>
            <div className="field">
              <label htmlFor="mqtt-host">Broker host</label>
              <input
                id="mqtt-host"
                placeholder="e.g. 192.168.1.50"
                value={form.mqtt_host || ''}
                onChange={(e) => setForm({ ...form, mqtt_host: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="mqtt-port">Broker port</label>
              <input
                id="mqtt-port"
                type="number"
                placeholder="1883"
                value={form.mqtt_port || ''}
                onChange={(e) => setForm({ ...form, mqtt_port: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="mqtt-username">Username (optional)</label>
              <input
                id="mqtt-username"
                value={form.mqtt_username || ''}
                onChange={(e) => setForm({ ...form, mqtt_username: e.target.value })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="mqtt-password">Password (optional)</label>
              <input
                id="mqtt-password"
                type="password"
                placeholder={mqttPasswordSet ? 'Leave blank to keep current password' : ''}
                value={form.mqtt_password || ''}
                onChange={(e) => setForm({ ...form, mqtt_password: e.target.value })}
              />
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>

        <div className="section-title">Notifications (push)</div>
        <div className="card">
          <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
            Send a push notification to phones when a camera with motion detection sees movement,
            even when the app is closed. Requires your own Firebase project — drop{' '}
            <strong>firebase-service-account.json</strong> and <strong>google-services.json</strong>{' '}
            into the data directory first (see <strong>docs/notifications.md</strong>). Motion
            detection and the in-app <strong>Recent alerts</strong> below work with or without this.
          </div>
          {pushError && (
            <div className="error-banner" style={{ marginBottom: 10 }}>{pushError}</div>
          )}
          <label className="log-viewer__toggle">
            <input
              type="checkbox"
              checked={!!pushStatus?.push_enabled}
              disabled={pushBusy || !pushStatus}
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

        <div className="section-title">Recent alerts</div>
        <RecentAlerts />

        <div className="section-title">Camera history</div>
        <EventLog />

        <div className="section-title">Recent logs</div>
        <LogViewer />
      </main>
    </>
  );
}
