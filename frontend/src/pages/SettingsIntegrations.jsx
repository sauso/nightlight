import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';
import AppHeader from '../components/AppHeader.jsx';
import MqttIcon from '../components/icons/MqttIcon.jsx';

const BACK = { state: { from: { to: '/settings/integrations', label: 'Integrations' } } };
const ITEMS = [
  { key: 'notifications', to: '/settings/integrations/notifications', Icon: Bell, label: 'Push notifications', desc: 'Set up phone alerts for motion and sound detection' },
  { key: 'mqtt', to: '/settings/integrations/mqtt', Icon: MqttIcon, label: 'MQTT', desc: 'Connect your MQTT broker' },
];

export default function SettingsIntegrations() {
  const navigate = useNavigate();
  const [mqtt, setMqtt] = useState(null);

  // The links remain available if the status request fails; no badge means its state is unknown.
  useEffect(() => { api.get('/settings/mqtt/status').then(setMqtt).catch(() => {}); }, []);
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
        <div className="camera-tile__sub" style={{ marginBottom: 12 }}>
          Connect Nightlight to notification services and your MQTT broker.
        </div>
        <div className="card" style={{ padding: 0 }}>
          {ITEMS.map(({ key, ...item }) => (
            <Row key={key} {...item}
              badge={key === 'mqtt' ? mqttBadge : null}
              onClick={() => navigate(item.to, BACK)} />
          ))}
        </div>
      </main>
    </>
  );
}

function Row({ Icon, label, desc, badge, onClick }) {
  return (
    <div className="list-row" role="button" tabIndex={0}
      style={{ cursor: 'pointer', padding: '12px 14px' }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <span style={{ width: 24, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={22} color="var(--peri)" aria-hidden="true" />
        </span>
        <div style={{ minWidth: 0 }}>
          <div>{label}</div>
          <div className="camera-tile__sub">{desc}</div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {badge && <span className={`status-badge ${badge.cls}`}>{badge.text}</span>}
        <ChevronRight size={18} style={{ opacity: 0.5 }} aria-hidden="true" />
      </div>
    </div>
  );
}
