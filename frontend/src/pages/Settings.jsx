import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SlidersHorizontal, Thermometer, Bell, ScrollText,
  UserCog, Info, Server, LogOut, ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { isNativeApp, changeServer } from '../lib/nativeBridge.js';
import AppHeader from '../components/AppHeader.jsx';

// Settings is a hub. System configuration (General / MQTT / Push / Logs) is admin-only, so
// those rows only render for admins. Everyone gets Account and About. The actions that used
// to live in the header's hamburger (Change server on native, Sign out) live here now too.
// Rows that stay inside Settings pass state.from so their back button returns here.
const BACK = { state: { from: { to: '/settings', label: 'Settings' } } };

const ADMIN_ITEMS = [
  { to: '/settings/general', Icon: SlidersHorizontal, label: 'General', desc: 'App name, timezone, theme, font, colours, temperature unit' },
  { to: '/settings/mqtt', Icon: Thermometer, label: 'MQTT', desc: 'Broker for room temperature / humidity' },
  { to: '/settings/push', Icon: Bell, label: 'Push notifications', desc: 'Enable phone alerts for motion detection' },
  { to: '/settings/logs', Icon: ScrollText, label: 'Logs', desc: 'Camera history and server logs' },
];

function Row({ Icon, label, desc, trailing, onClick }) {
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
        <Icon size={20} color="var(--peri)" aria-hidden="true" />
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

export default function Settings() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [version, setVersion] = useState(null);

  useEffect(() => {
    api.get('/about').then((info) => setVersion(info?.version)).catch(() => {});
  }, []);

  return (
    <>
      <AppHeader title="Settings" />
      <main className="app-main">
        {user?.role === 'admin' && (
          <div className="card">
            {ADMIN_ITEMS.map((it) => (
              <Row key={it.to} {...it} onClick={() => navigate(it.to, BACK)} />
            ))}
          </div>
        )}

        <div className="card">
          <Row
            Icon={UserCog}
            label="Account"
            desc="Password, sessions, notifications on this device"
            onClick={() => navigate('/account', BACK)}
          />
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
