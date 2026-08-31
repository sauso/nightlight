import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/AuthContext.jsx';
import { SettingsProvider } from './lib/SettingsContext.jsx';
import { CamerasProvider } from './lib/CamerasContext.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { isNativeApp, hasActiveBackgroundAudio } from './lib/nativeBridge.js';
import { initPushNotifications } from './lib/pushNotifications.js';
import { useSwipeBack } from './lib/useSwipeBack.js';
import { useHardwareBack } from './lib/useHardwareBack.js';
import NavBar from './components/NavBar.jsx';
import LiveMonitor from './components/LiveMonitor.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';
import PushBanner from './components/PushBanner.jsx';
import Login from './pages/Login.jsx';
import Children from './pages/Children.jsx';
import ChildDetail from './pages/ChildDetail.jsx';
import NightReview from './pages/NightReview.jsx';
import SleepDetail from './pages/SleepDetail.jsx';
import ChildSettings from './pages/ChildSettings.jsx';
import Cameras from './pages/Cameras.jsx';
import CameraSettings from './pages/CameraSettings.jsx';
import DetectionSettings from './pages/DetectionSettings.jsx';
import Account from './pages/Account.jsx';
import Settings from './pages/Settings.jsx';
import SettingsGeneral from './pages/SettingsGeneral.jsx';
import SettingsCamera from './pages/SettingsCamera.jsx';
import SettingsRecording from './pages/SettingsRecording.jsx';
import SettingsMqtt from './pages/SettingsMqtt.jsx';
import SettingsPush from './pages/SettingsPush.jsx';
import SettingsPushPushover from './pages/SettingsPushPushover.jsx';
import SettingsPushFirebase from './pages/SettingsPushFirebase.jsx';
import SettingsPushGotify from './pages/SettingsPushGotify.jsx';
import SettingsPushNtfy from './pages/SettingsPushNtfy.jsx';
import SettingsUsers from './pages/SettingsUsers.jsx';
import UserSettings from './pages/UserSettings.jsx';
import SettingsLogs from './pages/SettingsLogs.jsx';
import ClipManagement from './pages/ClipManagement.jsx';
import About from './pages/About.jsx';

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

// Exported for tests. These two are the ONLY thing standing between a caregiver and every
// admin screen, and the loading branch matters as much as the role one: returning null rather
// than redirecting is what stops a page refresh bouncing a signed-in user to the login screen
// while auth is still resolving.
export function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export function AdminProtected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

function Shell() {
  const { user, loading } = useAuth();
  useReloadAfterBackground();
  useSwipeBack();
  useHardwareBack();

  // Once signed in (native app only), register for push notifications so detection alerts can
  // reach the phone when the app is backgrounded/closed. No-op in a browser.
  useEffect(() => {
    if (user) initPushNotifications();
  }, [user]);

  if (loading) return null;

  return (
    <>
      <InstallPrompt />
      <PushBanner />
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
                    {/* Retired tabs redirect to the new child-centred structure. */}
                    <Route path="/family" element={<Navigate to="/children" replace />} />
                    <Route path="/alerts" element={<Navigate to="/children" replace />} />
                    {/* Children tab: list → child detail (cameras + alerts + sleep); avatar → settings. */}
                    <Route path="/children" element={<Children />} />
                    <Route path="/children/new" element={<ChildSettings />} />
                    <Route path="/children/:id" element={<ChildDetail />} />
                    <Route path="/children/:id/sleep" element={<SleepDetail />} />
                    <Route path="/children/:id/review/:date" element={<NightReview />} />
                    <Route path="/children/:id/edit" element={<ChildSettings />} />
                    <Route path="/cameras" element={<Cameras />} />
                    {/* Per-camera settings + split detection screens are admin-only (camera
                        management). /cameras/new and /cameras/:id/:kind are more specific than
                        /cameras/:id, so react-router matches them first regardless of order. */}
                    <Route path="/cameras/new" element={<AdminProtected><CameraSettings /></AdminProtected>} />
                    <Route path="/cameras/:id" element={<AdminProtected><CameraSettings /></AdminProtected>} />
                    <Route path="/cameras/:id/:kind" element={<AdminProtected><DetectionSettings /></AdminProtected>} />
                    {/* Settings hub is role-aware internally (admin-only rows are hidden for
                        caregivers), so the hub route itself is open to any signed-in user;
                        the config sub-pages stay admin-gated. */}
                    <Route path="/settings" element={<Settings />} />
                    <Route path="/settings/general" element={<AdminProtected><SettingsGeneral /></AdminProtected>} />
                    <Route path="/settings/camera" element={<AdminProtected><SettingsCamera /></AdminProtected>} />
                    <Route path="/settings/recording" element={<AdminProtected><SettingsRecording /></AdminProtected>} />
                    <Route path="/settings/mqtt" element={<AdminProtected><SettingsMqtt /></AdminProtected>} />
                    <Route path="/settings/push" element={<AdminProtected><SettingsPush /></AdminProtected>} />
                    <Route path="/settings/push/pushover" element={<AdminProtected><SettingsPushPushover /></AdminProtected>} />
                    <Route path="/settings/push/firebase" element={<AdminProtected><SettingsPushFirebase /></AdminProtected>} />
                    <Route path="/settings/push/gotify" element={<AdminProtected><SettingsPushGotify /></AdminProtected>} />
                    <Route path="/settings/push/ntfy" element={<AdminProtected><SettingsPushNtfy /></AdminProtected>} />
                    <Route path="/settings/users" element={<AdminProtected><SettingsUsers /></AdminProtected>} />
                    <Route path="/settings/users/new" element={<AdminProtected><UserSettings /></AdminProtected>} />
                    <Route path="/settings/users/:id" element={<AdminProtected><UserSettings /></AdminProtected>} />
                    <Route path="/settings/logs" element={<AdminProtected><SettingsLogs /></AdminProtected>} />
                    <Route path="/settings/clips" element={<AdminProtected><ClipManagement /></AdminProtected>} />
                    <Route path="/account" element={<Account />} />
                    <Route path="/about" element={<About />} />
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
    <ErrorBoundary>
      <SettingsProvider>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </SettingsProvider>
    </ErrorBoundary>
  );
}
