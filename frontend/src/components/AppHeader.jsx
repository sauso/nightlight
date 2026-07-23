import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Palette, Settings as SettingsIcon, LogOut, Server } from 'lucide-react';
import { useAuth } from '../lib/AuthContext.jsx';
import { isNativeApp, changeServer } from '../lib/nativeBridge.js';

// The hamburger menu lives here, inside the header, rather than floating independently
// with its own position:fixed - the header itself is pinned to the top (position:
// sticky), so anything inside it just naturally stays put with it. This sidesteps a
// whole class of mobile-browser quirks around top-anchored fixed elements drifting
// during the address-bar hide/show animation.
export default function AppHeader({ title }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  function go(path) {
    setMenuOpen(false);
    navigate(path);
  }

  function handleLogout() {
    setMenuOpen(false);
    logout();
  }

  return (
    <header className="app-header">
      <div className="app-header__top-row">
        <button
          className="app-header__icon-btn"
          onClick={() => navigate('/')}
          aria-label="Go to Nursery"
        >
          <img src="/icons/icon-192.png" alt="" className="app-header__icon" />
        </button>
        <h1>{title}</h1>

        <button
          className="hamburger-btn"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          aria-expanded={menuOpen}
        >
          <Menu size={20} />
        </button>
      </div>

      {menuOpen && (
        <>
          <div className="hamburger-backdrop" onClick={() => setMenuOpen(false)} />
          <div className="hamburger-panel" onClick={(e) => e.stopPropagation()}>
            <nav className="hamburger-panel__items">
              {user?.role === 'admin' && (
                <button className="hamburger-item" onClick={() => go('/settings')}>
                  <Palette size={19} />
                  Settings
                </button>
              )}
              <button className="hamburger-item" onClick={() => go('/account')}>
                <SettingsIcon size={19} />
                Account
              </button>
              {isNativeApp() && (
                <button className="hamburger-item" onClick={changeServer}>
                  <Server size={19} />
                  Change server
                </button>
              )}
              <button className="hamburger-item hamburger-item--logout" onClick={handleLogout}>
                <LogOut size={19} />
                Sign out
              </button>
            </nav>
          </div>
        </>
      )}
    </header>
  );
}
