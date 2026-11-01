import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/AuthContext.jsx';
import { SettingsProvider } from './lib/SettingsContext.jsx';
import { CamerasProvider } from './lib/CamerasContext.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { isNativeApp, hasActiveBackgroundAudio } from './lib/nativeBridge.js';
import { isReloadHeld } from './lib/reloadGuard.js';
import { initPushNotifications } from './lib/pushNotifications.js';
import { applyViewportPolicy } from './lib/viewport.js';
import { useSwipeBack } from './lib/useSwipeBack.js';
import { useHardwareBack } from './lib/useHardwareBack.js';
import NavBar from './components/NavBar.jsx';
import LiveMonitor from './components/LiveMonitor.jsx';
import ServerUnreachable from './components/ServerUnreachable.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';
import PushBanner from './components/PushBanner.jsx';
import ServerSwitchPrompt from './components/ServerSwitchPrompt.jsx';
import Login from './pages/Login.jsx';
import Children from './pages/Children.jsx';
import Cameras from './pages/Cameras.jsx';
import Account from './pages/Account.jsx';
import Settings from './pages/Settings.jsx';
import NotFound from './pages/NotFound.jsx';
import { lazyPage } from './lib/lazyPage.jsx';

// #386: everything not needed to show the Live page, sign in, or reach the primary tabs is split out of
// the entry chunk (see lib/lazyPage.jsx). Eager on purpose: Login, the Children / Cameras / Settings /
// Account tab roots and NotFound (so a bad address never needs a network fetch), plus LiveMonitor and
// NavBar above. ChildDetail is lazy because it pulls the sleep, recordings and timelapse cards.
const ChildDetail = lazyPage(() => import('./pages/ChildDetail.jsx'));
const NightReview = lazyPage(() => import('./pages/NightReview.jsx'));
const SleepDetail = lazyPage(() => import('./pages/SleepDetail.jsx'));
const ChildSettings = lazyPage(() => import('./pages/ChildSettings.jsx'));
const CameraSettings = lazyPage(() => import('./pages/CameraSettings.jsx'));
const DetectionSettings = lazyPage(() => import('./pages/DetectionSettings.jsx'));
const SettingsGeneral = lazyPage(() => import('./pages/SettingsGeneral.jsx'));
const SettingsCamera = lazyPage(() => import('./pages/SettingsCamera.jsx'));
const SettingsRecording = lazyPage(() => import('./pages/SettingsRecording.jsx'));
const SettingsMqtt = lazyPage(() => import('./pages/SettingsMqtt.jsx'));
const SettingsIntegrations = lazyPage(() => import('./pages/SettingsIntegrations.jsx'));
const SettingsEsphome = lazyPage(() => import('./pages/SettingsEsphome.jsx'));
const SettingsPush = lazyPage(() => import('./pages/SettingsPush.jsx'));
const SettingsPushPushover = lazyPage(() => import('./pages/SettingsPushPushover.jsx'));
const SettingsPushFirebase = lazyPage(() => import('./pages/SettingsPushFirebase.jsx'));
const SettingsPushGotify = lazyPage(() => import('./pages/SettingsPushGotify.jsx'));
const SettingsPushNtfy = lazyPage(() => import('./pages/SettingsPushNtfy.jsx'));
const SettingsUsers = lazyPage(() => import('./pages/SettingsUsers.jsx'));
const UserSettings = lazyPage(() => import('./pages/UserSettings.jsx'));
const SettingsLogs = lazyPage(() => import('./pages/SettingsLogs.jsx'));
const ClipManagement = lazyPage(() => import('./pages/ClipManagement.jsx'));
const About = lazyPage(() => import('./pages/About.jsx'));

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
//
// Exception: a screen that holds state the server cannot give back can hold the reload off while it is open
// (lib/reloadGuard.js) - the two-factor set-up panel, whose secret and half-typed code a reload would lose.
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
        // A screen holding unrecoverable state (the two-factor set-up panel) can hold the reload off (#765).
        if (hiddenFor > BACKGROUND_RELOAD_THRESHOLD_MS && !keptAliveByBackgroundAudio && !isReloadHeld()) {
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
  const { user, loading, unreachable, retrying, refresh } = useAuth();
  useReloadAfterBackground();
  useSwipeBack();
  useHardwareBack();

  // #562 bullet 3: give a browser its pinch-zoom back; the native app keeps index.html's locked viewport (the
  // PiP double-tap bug). Here, once, on mount, rather than in main.jsx: main.jsx is the bootstrap and is not
  // covered by the tests, and appShell.test.jsx must be able to prove this runs. Runs whether or not anyone is
  // signed in (Shell is mounted either way), so the login screen is zoomable too. The iOS check (an iOS browser
  // keeps maximum-scale=1) is applyViewportPolicy's own default argument. See lib/viewport.js.
  useEffect(() => {
    applyViewportPolicy(document, isNativeApp());
  }, []);

  // Once signed in (native app only), register for push notifications so detection alerts can
  // reach the phone when the app is backgrounded/closed. No-op in a browser.
  useEffect(() => {
    if (user) initPushNotifications();
  }, [user]);

  if (loading) return null;

  // #382: a stored sign-in could not be checked because the server did not answer. Without this the
  // Protected wrapper below sent such a device to the sign-in form. Only while nobody is signed in: a
  // failed refresh() on an open session leaves `user` set and the app as it was.
  if (unreachable && !user) return <ServerUnreachable onRetry={refresh} retrying={retrying} />;

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
                    {/* Old settings bookmarks still reach the admin-gated canonical pages. */}
                    <Route path="/settings/mqtt" element={<Navigate to="/settings/integrations/mqtt" replace />} />
                    <Route path="/settings/push" element={<Navigate to="/settings/integrations/notifications" replace />} />
                    <Route path="/settings/push/pushover" element={<Navigate to="/settings/integrations/notifications/pushover" replace />} />
                    <Route path="/settings/push/firebase" element={<Navigate to="/settings/integrations/notifications/firebase" replace />} />
                    <Route path="/settings/push/gotify" element={<Navigate to="/settings/integrations/notifications/gotify" replace />} />
                    <Route path="/settings/push/ntfy" element={<Navigate to="/settings/integrations/notifications/ntfy" replace />} />
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
                    <Route path="/settings/integrations" element={<AdminProtected><SettingsIntegrations /></AdminProtected>} />
                    <Route path="/settings/integrations/mqtt" element={<AdminProtected><SettingsMqtt /></AdminProtected>} />
                    <Route path="/settings/integrations/esphome" element={<AdminProtected><SettingsEsphome /></AdminProtected>} />
                    <Route path="/settings/integrations/notifications" element={<AdminProtected><SettingsPush /></AdminProtected>} />
                    <Route path="/settings/integrations/notifications/pushover" element={<AdminProtected><SettingsPushPushover /></AdminProtected>} />
                    <Route path="/settings/integrations/notifications/firebase" element={<AdminProtected><SettingsPushFirebase /></AdminProtected>} />
                    <Route path="/settings/integrations/notifications/gotify" element={<AdminProtected><SettingsPushGotify /></AdminProtected>} />
                    <Route path="/settings/integrations/notifications/ntfy" element={<AdminProtected><SettingsPushNtfy /></AdminProtected>} />
                    <Route path="/settings/users" element={<AdminProtected><SettingsUsers /></AdminProtected>} />
                    <Route path="/settings/users/new" element={<AdminProtected><UserSettings /></AdminProtected>} />
                    <Route path="/settings/users/:id" element={<AdminProtected><UserSettings /></AdminProtected>} />
                    <Route path="/settings/logs" element={<AdminProtected><SettingsLogs /></AdminProtected>} />
                    <Route path="/settings/clips" element={<AdminProtected><ClipManagement /></AdminProtected>} />
                    <Route path="/account" element={<Account />} />
                    <Route path="/about" element={<About />} />
                    {/* Catch-all, LAST (#379). react-router ranks by specificity, not order, so every
                        route above still wins; this only receives an address nothing else matched.
                        /cameras/<id>/<unknown kind> matches /cameras/:id/:kind above, so DetectionSettings
                        itself renders NotFound for a kind it does not know and for a camera that is not there. */}
                    <Route path="*" element={<NotFound />} />
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
      {/* AuthProvider is OUTSIDE SettingsProvider so the settings can be re-fetched when the signed-in
          user changes: GET /settings answers an admin with more than it answers an anonymous visitor,
          and signing in happens in-page (Login navigates, it does not reload), so a provider that
          fetched once at mount would keep the anonymous response for the whole session and leave the
          admin settings forms seeding from fields that were never sent. AuthProvider does not read
          settings, so this nesting has no cycle. */}
      <AuthProvider>
        <SettingsProvider>
          <Shell />
        </SettingsProvider>
      </AuthProvider>
      {/* #559: asks before an alert or link moves the app to another server. Outside AuthProvider and Shell on
          purpose: Shell renders nothing while sign-in is resolving and only the "can't reach the server" page
          when that fails, and the dialog must still appear then; it needs no sign-in (the saved-server list is
          the phone's own). */}
      <ServerSwitchPrompt />
    </ErrorBoundary>
  );
}
