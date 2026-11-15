import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import MqttIcon from '../components/icons/MqttIcon.jsx';
import EsphomeIcon from '../components/icons/EsphomeIcon.jsx';
import { hubBadge } from '../lib/esphomeUi.js';
import NavRow from '../components/NavRow.jsx';

const BACK = { state: { from: { to: '/settings/integrations', label: 'Integrations' } } };
const ITEMS = [
  { key: 'notifications', to: '/settings/integrations/notifications', Icon: Bell, label: 'Push notifications', desc: 'Set up phone alerts for motion and sound detection' },
  { key: 'mqtt', to: '/settings/integrations/mqtt', Icon: MqttIcon, label: 'MQTT', desc: 'Connect your MQTT broker' },
  { key: 'esphome', to: '/settings/integrations/esphome', Icon: EsphomeIcon, label: 'ESPHome', desc: 'Collect readings from ESPHome sensors' },
];

export default function SettingsIntegrations() {
  const navigate = useNavigate();
  const [mqtt, setMqtt] = useState(null);
  const [esphome, setEsphome] = useState(null);

  // The links remain available if a status request fails; no badge means its state is unknown.
  useEffect(() => { api.get('/settings/mqtt/status').then(setMqtt).catch(() => {}); }, []);
  useEffect(() => { api.get('/esphome/devices').then(setEsphome).catch(() => {}); }, []);
  const esphomeBadge = hubBadge(esphome);
  const mqttBadge = mqtt
    ? (mqtt.connected
        ? { text: 'Connected', cls: 'status-badge--ok' }
        : mqtt.enabled
          ? { text: 'Disconnected', cls: 'status-badge--bad' }
          : { text: 'Off', cls: 'status-badge--off' })
    : null;

  return (
    <>
      <AppHeader title="Integrations" back={{ to: '/settings', label: 'Settings' }} />
      <main className="app-main">
        <div className="page-intro">
          Connect Nightlight to notification services, your MQTT broker and ESPHome sensors.
        </div>
        <div className="card" style={{ padding: 0 }}>
          {ITEMS.map(({ key, ...item }) => (
            <NavRow key={key} Icon={item.Icon} label={item.label} sub={item.desc}
              badge={key === 'mqtt' ? mqttBadge : key === 'esphome' ? esphomeBadge : null}
              onClick={() => navigate(item.to, BACK)} />
          ))}
        </div>
      </main>
    </>
  );
}
