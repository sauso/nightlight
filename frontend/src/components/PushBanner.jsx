import { useEffect, useRef, useState } from 'react';

// In-app banner for push alerts that arrive while the app is in the foreground. Android does not
// show a system-tray notification for an FCM message while the app is open — it delivers it to the
// JS layer instead (see pushNotifications.js, which re-broadcasts it as a `nightlight:push` event).
// Without this, a motion alert while you're watching the app would be silently swallowed. Tapping
// the banner jumps to the nursery (where the alerting camera's tile lives); it auto-dismisses.
const AUTO_DISMISS_MS = 6000;

export default function PushBanner() {
  const [alert, setAlert] = useState(null); // { title, body, cameraId }
  const timerRef = useRef(null);

  useEffect(() => {
    function onPush(e) {
      setAlert(e.detail);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setAlert(null), AUTO_DISMISS_MS);
    }
    window.addEventListener('nightlight:push', onPush);
    return () => {
      window.removeEventListener('nightlight:push', onPush);
      clearTimeout(timerRef.current);
    };
  }, []);

  if (!alert) return null;

  function open() {
    clearTimeout(timerRef.current);
    setAlert(null);
    window.location.hash = '#/';
  }
  function dismiss(e) {
    e.stopPropagation();
    clearTimeout(timerRef.current);
    setAlert(null);
  }

  return (
    <div
      className="push-banner"
      role="alert"
      onClick={open}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && open()}
      tabIndex={0}
    >
      <div className="push-banner__body">
        <div className="push-banner__title">{alert.title}</div>
        <div className="push-banner__text">{alert.body}</div>
      </div>
      <button className="push-banner__close" aria-label="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
