import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/AuthContext.jsx';
import { SettingsProvider } from './lib/SettingsContext.jsx';
import { CamerasProvider } from './lib/CamerasContext.jsx';
import NavBar from './components/NavBar.jsx';
import LiveMonitor from './components/LiveMonitor.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';
import Login from './pages/Login.jsx';
import Children from './pages/Children.jsx';
import Cameras from './pages/Cameras.jsx';
import Account from './pages/Account.jsx';
import Settings from './pages/Settings.jsx';

// How long the app needs to have been backgrounded before we reload on return. Short
// enough to catch a real "put the phone away for a bit" gap, long enough that quickly
// glancing at a notification for a couple seconds doesn't trigger a reload.
const BACKGROUND_RELOAD_THRESHOLD_MS = 15000;

// Mobile browsers can leave WebRTC/HLS connections in a half-broken state after an
// extended period backgrounded (network stack resets, connections silently drop,
// etc.) in ways that don't always cleanly self-heal through reconnect logic alone -
// a full reload is what reliably fixes it, so this does that automatically the
// moment you return, rather than leaving it for a person to notice and do by hand
// (not ideal for something meant to be glanced at half-asleep).
function useReloadAfterBackground() {
  useEffect(() => {
    let hiddenAt = null;
    function handleVisibility() {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (document.visibilityState === 'visible' && hiddenAt) {
        const hiddenFor = Date.now() - hiddenAt;
        hiddenAt = null;
        if (hiddenFor > BACKGROUND_RELOAD_THRESHOLD_MS) {
          window.location.reload();
        }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);
}

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AdminProtected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function Shell() {
  const { user, loading } = useAuth();
  useReloadAfterBackground();

  if (loading) return null;

  return (
    <>
      <InstallPrompt />
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
        <Route
          path="/*"
          element={
            <Protected>
              <CamerasProvider>
                <div className="app-shell">
                  <LiveMonitor />
                  <Routes>
                    <Route path="/" element={null} />
                    <Route path="/children" element={<Children />} />
                    <Route path="/cameras" element={<Cameras />} />
                    <Route path="/settings" element={<AdminProtected><Settings /></AdminProtected>} />
                    <Route path="/account" element={<Account />} />
                  </Routes>
                  <NavBar />
                </div>
              </CamerasProvider>
            </Protected>
          }
        />
      </Routes>
    </>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </SettingsProvider>
  );
}
