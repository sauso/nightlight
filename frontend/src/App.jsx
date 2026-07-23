import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/AuthContext.jsx';
import { SettingsProvider } from './lib/SettingsContext.jsx';
import { CamerasProvider } from './lib/CamerasContext.jsx';
import { isNativeApp, hasActiveBackgroundAudio } from './lib/nativeBridge.js';
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
//
// Exception: the Android app's native foreground service (AudioService.kt) holds a
// wake lock + wifi lock specifically to keep the process and its connections alive
// while backgrounded - if that was running the whole time, there's no "half-broken
// network stack" to clean up, and reloading would just interrupt a stream that was
// deliberately being kept live for background listening. In that case, trust the
// WhepPlayer/HlsPlayer reconnect-if-actually-dead logic instead (see their own
// visibilitychange handlers).
function useReloadAfterBackground() {
  useEffect(() => {
    let hiddenAt = null;
    function handleVisibility() {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (document.visibilityState === 'visible' && hiddenAt) {
        const hiddenFor = Date.now() - hiddenAt;
        hiddenAt = null;
        // Checked now, not at hide-time: if the person tapped "Stop" on the
        // notification partway through, the service (and its wake lock) already
        // stopped covering the rest of the backgrounded period, so this correctly
        // falls back to reload in that case.
        const keptAliveByBackgroundAudio = isNativeApp() && hasActiveBackgroundAudio();
        if (hiddenFor > BACKGROUND_RELOAD_THRESHOLD_MS && !keptAliveByBackgroundAudio) {
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
