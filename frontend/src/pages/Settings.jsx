import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SlidersHorizontal, Bell, ScrollText, Users,
  Info, Server, LogOut, ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { isNativeApp, changeServer } from '../lib/nativeBridge.js';
import AppHeader from '../components/AppHeader.jsx';
import Avatar from '../components/Avatar.jsx';
import MqttIcon from '../components/icons/MqttIcon.jsx';

// Settings is a hub. Account sits at the top in its own card (like the mockup); system config
// (General / MQTT / Push / Logs) is admin-only; About + Change server share a card; Sign out is
// last. Rows that stay under Settings pass state.from so their back button returns here.
const BACK = { state: { from: { to: '/settings', label: 'Settings' } } };
const PERI = 'var(--peri)';

function displayName(u) {
  const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim();
  return name || u?.username || 'You';
}

function Row({ Icon, iconSize = 20, label, desc, trailing, onClick }) {
  return (
    <div
      className="list-row"
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Fixed 20px centred slot so every row's label starts at the same x, while an icon
            (e.g. the sparse MQTT logo) can render a little larger without shifting its label. */}
        <span style={{ width: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <Icon size={iconSize} color={PERI} aria-hidden="true" />
        </span>
        <div>
          <div>{label}</div>
          {desc && <div className="camera-tile__sub">{desc}</div>}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {trailing}
        <ChevronRight size={18} style={{ opacity: 0.5 }} aria-hidden="true" />
      </div>
    </div>
  );
}

const ADMIN_ITEMS = [
  { key: 'general', to: '/settings/general', Icon: SlidersHorizontal, label: 'General', desc: 'App name, timezone, theme, font, colours, temperature unit' },
  { key: 'caregivers', to: '/settings/users', Icon: Users, label: 'Caregivers', desc: 'Manage caregiver logins and active sessions' },
  { key: 'mqtt', to: '/settings/mqtt', Icon: MqttIcon, iconSize: 22, label: 'MQTT', desc: 'Connect your MQTT broker' },
  { key: 'push', to: '/settings/push', Icon: Bell, label: 'Push notifications', desc: 'Enable phone alerts for motion detection' },
  { key: 'logs', to: '/settings/logs', Icon: ScrollText, label: 'Logs', desc: 'Camera history and server logs' },
];

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [version, setVersion] = useState(null);
  const [mqtt, setMqtt] = useState(null);

  useEffect(() => {
    api.get('/about').then((info) => setVersion(info?.version)).catch(() => {});
    if (isAdmin) api.get('/settings/mqtt/status').then(setMqtt).catch(() => {});
  }, [isAdmin]);

  // Filled status badge: green when the broker is connected, red when it's enabled but not
  // connected, grey when MQTT is switched off entirely.
  const mqttBadge = mqtt
    ? (mqtt.connected
        ? { text: 'Connected', cls: 'status-badge--ok' }
        : mqtt.enabled
          ? { text: 'Disconnected', cls: 'status-badge--bad' }
          : { text: 'Off', cls: 'status-badge--off' })
    : null;

  return (
    <>
      <AppHeader title="Settings" />
      <main className="app-main">
        {/* Account — top of the list, in its own card. */}
        <div className="card">
          <div
            className="list-row"
            role="button"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
            onClick={() => navigate('/account', BACK)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/account', BACK); } }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar name={displayName(user)} src={user?.photo} size={40} />
              <div>
                <div style={{ fontWeight: 600 }}>{displayName(user)}</div>
                <div className="camera-tile__sub" style={{ textTransform: 'capitalize' }}>{user?.role} · Account</div>
              </div>
            </div>
            <ChevronRight size={18} style={{ opacity: 0.5, flexShrink: 0 }} aria-hidden="true" />
          </div>
        </div>

        {isAdmin && (
          <div className="card">
            {ADMIN_ITEMS.map((it) => (
              <Row
                key={it.key}
                {...it}
                trailing={it.key === 'mqtt' && mqttBadge ? <span className={`status-badge ${mqttBadge.cls}`}>{mqttBadge.text}</span> : undefined}
                onClick={() => navigate(it.to, BACK)}
              />
            ))}
          </div>
        )}

        <div className="card">
          <Row
            Icon={Info}
            label="About"
            desc="Version, links, disclaimer"
            trailing={version && <span className="camera-tile__sub">{version}</span>}
            onClick={() => navigate('/about', BACK)}
          />
          {isNativeApp() && (
            <Row Icon={Server} label="Change server" onClick={changeServer} />
          )}
        </div>

        <div className="card">
          <div
            className="list-row"
            role="button"
            tabIndex={0}
            style={{ cursor: 'pointer', color: 'var(--offline)' }}
            onClick={logout}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); logout(); } }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <LogOut size={20} aria-hidden="true" />
              <div>Sign out</div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
