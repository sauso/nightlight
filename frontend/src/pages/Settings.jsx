import { useNavigate } from 'react-router-dom';
import { SlidersHorizontal, Thermometer, Bell, Users, ScrollText, ChevronRight } from 'lucide-react';
import AppHeader from '../components/AppHeader.jsx';

// Settings is a hub: each row opens its own sub-page (see the /settings/* routes in App.jsx).
// The page was getting long as one scroll, so it's split into focused sections here.
const ITEMS = [
  { to: '/settings/general', Icon: SlidersHorizontal, label: 'General', desc: 'App name, timezone, theme, font, colours, temperature unit' },
  { to: '/settings/mqtt', Icon: Thermometer, label: 'MQTT', desc: 'Broker for room temperature / humidity' },
  { to: '/settings/push', Icon: Bell, label: 'Push notifications', desc: 'Enable phone alerts for motion detection' },
  { to: '/settings/users', Icon: Users, label: 'User management', desc: 'Caregiver accounts and active sessions' },
  { to: '/settings/logs', Icon: ScrollText, label: 'Logs', desc: 'Recent alerts, camera history, server logs' },
];

export default function Settings() {
  const navigate = useNavigate();

  return (
    <>
      <AppHeader title="Settings" />
      <main className="app-main">
        <div className="card">
          {ITEMS.map(({ to, Icon, label, desc }) => (
            <div
              key={to}
              className="list-row"
              role="button"
              tabIndex={0}
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(to)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(to); } }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Icon size={20} aria-hidden="true" />
                <div>
                  <div>{label}</div>
                  <div className="camera-tile__sub">{desc}</div>
                </div>
              </div>
              <ChevronRight size={18} style={{ opacity: 0.5, flexShrink: 0 }} aria-hidden="true" />
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
