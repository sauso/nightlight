import { Link, useLocation } from 'react-router-dom';
import { Video, Baby, Cctv, Settings } from 'lucide-react';

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
// (≥1200px) — see .bottom-nav in index.css. On desktop the rail sits below the app header (no
// separate brand — the header already shows the logo + app name).
export default function NavBar() {
  const { pathname } = useLocation();
  return (
    <nav className="bottom-nav">
      {TABS.map(({ to, Icon, label, ...tab }) => (
        <Link key={to} to={to} className={isActive(pathname, { to, ...tab }) ? 'active' : ''}>
          <Icon size={20} strokeWidth={2} className="bottom-nav__icon" aria-hidden="true" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
