import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import SettingsBack from '../components/SettingsBack.jsx';

export default function SettingsMqtt() {
  const [form, setForm] = useState({ mqtt_enabled: false, mqtt_host: '', mqtt_port: '', mqtt_username: '', mqtt_password: '' });
  const [passwordSet, setPasswordSet] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/settings/mqtt').then((mqtt) => {
      setForm((f) => ({
        ...f,
        mqtt_enabled: mqtt.mqtt_enabled,
        mqtt_host: mqtt.mqtt_host,
        mqtt_port: mqtt.mqtt_port,
        mqtt_username: mqtt.mqtt_username,
      }));
      setPasswordSet(mqtt.mqtt_password_set);
    }).catch(() => {});
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const payload = {
        mqtt_enabled: form.mqtt_enabled,
        mqtt_host: form.mqtt_host,
        mqtt_port: form.mqtt_port,
        mqtt_username: form.mqtt_username,
      };
      // Only send a new password if one was actually typed — blank means "keep current".
      if (form.mqtt_password) payload.mqtt_password = form.mqtt_password;
      await api.put('/settings', payload);
      setForm((f) => ({ ...f, mqtt_password: '' }));
      if (form.mqtt_password) setPasswordSet(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppHeader title="MQTT" />
      <main className="app-main">
        <SettingsBack />
        {error && <div className="error-banner">{error}</div>}
        {saved && <div className="saved-banner">Saved ✓</div>}

        <form onSubmit={save}>
          <div className="card">
            <div className="camera-tile__sub" style={{ marginBottom: 10 }}>
              Optional — connects to your existing MQTT broker (e.g. from Home Assistant /
              Zigbee2MQTT) to show temperature and humidity on each camera.
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
                placeholder={passwordSet ? 'Leave blank to keep current password' : ''}
                value={form.mqtt_password || ''}
                onChange={(e) => setForm({ ...form, mqtt_password: e.target.value })}
              />
            </div>
          </div>

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </form>
      </main>
    </>
  );
}
