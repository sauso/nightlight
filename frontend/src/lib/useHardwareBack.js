import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

// Handle the Android hardware Back button AND the OS edge back-gesture (both fire the
// @capacitor/app plugin's `backButton` event) by stepping back through react-router history,
// rather than letting the WebView's default finish the Activity (which is why "back exits the
// app"). Android's WebView doesn't track a single-page hash-router's history, so this MUST be
// driven from JS where react-router's history is authoritative. No-op in a browser / where the
// App plugin isn't present (the plugin ships in the native shell; this handler ships with the web
// app, so its behaviour can be iterated via a normal web deploy).
export function useHardwareBack() {
  const navigate = useNavigate();
  const location = useLocation();
  const locRef = useRef(location);
  locRef.current = location;

  useEffect(() => {
    const App = window.Capacitor?.Plugins?.App;
    if (!App?.addListener) return undefined;

    let handle;
    Promise.resolve(
      App.addListener('backButton', () => {
        const path = locRef.current.pathname;
        // On a drill-in screen, go back a step; on the root Live dashboard (or login) there's
        // nowhere to go, so let Back leave the app as usual.
        if (path !== '/' && path !== '/login') {
          navigate(-1);
        } else {
          App.exitApp?.();
        }
      }),
    ).then((h) => { handle = h; }).catch(() => {});

    return () => { Promise.resolve(handle).then((h) => h?.remove?.()).catch(() => {}); };
  }, [navigate]);
}
