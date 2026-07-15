import { NavLink } from 'react-router-dom';
import { Moon, Baby, Video } from 'lucide-react';

const TABS = [
  { to: '/', Icon: Moon, label: 'Nursery', end: true },
  { to: '/children', Icon: Baby, label: 'Children' },
  { to: '/cameras', Icon: Video, label: 'Cameras' },
];

export default function NavBar() {
  return (
    <nav className="bottom-nav">
      {TABS.map(({ to, Icon, label, end }) => (
        <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon size={20} strokeWidth={2} className="bottom-nav__icon" aria-hidden="true" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
