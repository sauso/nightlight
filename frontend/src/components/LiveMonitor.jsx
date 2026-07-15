import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from './AppHeader.jsx';
import CameraTile from './CameraTile.jsx';

// This component is mounted once for the entire logged-in session (see App.jsx) so that
// switching to Settings/Children/Cameras/Account never tears down the WebRTC connections
// or interrupts audio. When you're not on the Nursery tab it's pushed off-screen with CSS
// (not display:none — that can pause media in some browsers) rather than unmounted.
export default function LiveMonitor() {
  const location = useLocation();
  const isActive = location.pathname === '/';
  const { kids, cameras, error } = useCameras();
  const { settings } = useSettings();

  // Keep the screen awake for as long as the monitor is open. Wake Lock is released
  // automatically whenever the tab is hidden, so it's re-requested on visibility change.
  useEffect(() => {
    let lock = null;
    let cancelled = false;

    async function acquire() {
      if (!('wakeLock' in navigator)) return;
      try {
        const l = await navigator.wakeLock.request('screen');
        if (cancelled) {
          l.release().catch(() => {});
        } else {
          lock = l;
        }
      } catch {
        // Not available/allowed in this context (e.g. battery saver) — non-fatal.
      }
    }

    acquire();
    function handleVisibility() {
      if (document.visibilityState === 'visible') acquire();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (lock) lock.release().catch(() => {});
    };
  }, []);

  const unassigned = cameras.filter((cam) => !cam.child_id);

  return (
    <div
      className={`live-monitor ${isActive ? 'live-monitor--active' : 'live-monitor--hidden'}`}
      aria-hidden={!isActive}
    >
      <AppHeader title={settings.app_name} />
      <main className="app-main app-main--wide">
        {error && <div className="error-banner">{error}</div>}

        {cameras.length === 0 && (
          <div className="empty-state">
            No cameras yet. Add one from the Cameras tab to start watching.
          </div>
        )}

        {kids.map((child) => {
          const cams = cameras.filter((cam) => cam.child_id === child.id);
          if (cams.length === 0) return null;
          return (
            <section key={child.id} className="child-section">
              <div className="child-heading">{child.name}</div>
              <div className="card-grid">
                {cams.map((cam) => (
                  <CameraTile key={cam.id} camera={cam} childName={child.name} />
                ))}
              </div>
            </section>
          );
        })}

        {unassigned.length > 0 && (
          <section className="child-section">
            <div className="section-title">Unassigned cameras</div>
            <div className="card-grid">
              {unassigned.map((cam) => (
                <CameraTile key={cam.id} camera={cam} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
