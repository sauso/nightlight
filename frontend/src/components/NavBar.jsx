import { Link, useLocation } from 'react-router-dom';
import { Video, Baby, Cctv, Settings } from 'lucide-react';
import { useSettings } from '../lib/SettingsContext.jsx';

// Four primary destinations, child-centred. Children, Cameras and Settings are hubs, so each stays
// highlighted while you're on any sub-page it owns (`match` prefix). Live matches "/" exactly.
const TABS = [
  { to: '/', Icon: Video, label: 'Live', match: ['/'], exact: true },
  { to: '/children', Icon: Baby, label: 'Children', match: ['/children'] },
  { to: '/cameras', Icon: Cctv, label: 'Cameras', match: ['/cameras'] },
  { to: '/settings', Icon: Settings, label: 'Settings', match: ['/settings', '/account', '/about'] },
];

function isActive(pathname, tab) {
  return tab.match.some((p) =>
    tab.exact ? pathname === p : pathname === p || pathname.startsWith(p + '/')
  );
}

// Same component renders as a bottom tab bar on phone/tablet and a left sidebar rail on desktop
// (≥1200px) — see .bottom-nav in index.css. The brand row only shows in the desktop rail.
export default function NavBar() {
  const { pathname } = useLocation();
  const { settings } = useSettings();
  const appName = settings?.app_name || 'Nightlight';
  return (
    <nav className="bottom-nav">
      <Link to="/" className="bottom-nav__brand" aria-label={`${appName} — Live`}>
        <img src="/icons/icon-192.png" alt="" className="bottom-nav__brand-icon" />
        <span className="bottom-nav__brand-name">{appName}</span>
      </Link>
      {TABS.map(({ to, Icon, label, ...tab }) => (
        <Link key={to} to={to} className={isActive(pathname, { to, ...tab }) ? 'active' : ''}>
          <Icon size={20} strokeWidth={2} className="bottom-nav__icon" aria-hidden="true" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
