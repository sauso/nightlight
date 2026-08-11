import { Link, useLocation } from 'react-router-dom';
import { Moon, Bell, Users, SlidersHorizontal } from 'lucide-react';

// The four primary destinations. Family and Settings are hubs, so they stay highlighted
// while you're on any of the sub-pages they own (`match`) — e.g. Family is lit on
// /children and /cameras, Settings on /account and /about. Live matches only "/" exactly.
const TABS = [
  { to: '/', Icon: Moon, label: 'Live', match: ['/'], exact: true },
  { to: '/alerts', Icon: Bell, label: 'Alerts', match: ['/alerts'] },
  { to: '/family', Icon: Users, label: 'Family', match: ['/family', '/children', '/cameras'] },
  { to: '/settings', Icon: SlidersHorizontal, label: 'Settings', match: ['/settings', '/account', '/about'] },
];

function isActive(pathname, tab) {
  return tab.match.some((p) =>
    tab.exact ? pathname === p : pathname === p || pathname.startsWith(p + '/')
  );
}

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
