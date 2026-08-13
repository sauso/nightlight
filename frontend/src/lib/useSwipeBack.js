import { useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

// iOS-style "swipe right to go back a screen." A mostly-horizontal drag that starts in the left
// half of the screen and travels far enough to the right pops one entry off the router history —
// so Settings → MQTT, Family → Camera, etc. can be dismissed with a swipe as well as the nav-bar
// back button. Deliberately NOT active on the root Live dashboard: there's nowhere sensible to go
// back to (a back there would leave the app), and the tiles own their own touch gestures (zoom /
// PTZ / the cog sheet's vertical swipe). Starting inside the left half — not at the very edge —
// keeps it working on Android gesture-nav, where the OS reserves the screen edge for its own back.
const START_ZONE = 0.5; // gesture must begin in the left half of the screen
const MIN_DX = 70; // px of rightward travel required
const OFF_AXIS = 0.6; // vertical drift must stay well under the horizontal travel
const MAX_MS = 800; // a back-swipe is a flick, not a slow drag

export function useSwipeBack() {
  const navigate = useNavigate();
  const location = useLocation();
  const startRef = useRef(null);
  // Screens where a back-swipe shouldn't fire (would exit the app / has its own gestures).
  const disabledRef = useRef(false);
  disabledRef.current = location.pathname === '/' || location.pathname === '/login';

  useEffect(() => {
    function onStart(e) {
      if (e.touches.length !== 1) { startRef.current = null; return; }
      const t = e.touches[0];
      startRef.current = { x: t.clientX, y: t.clientY, at: Date.now() };
    }
    function onEnd(e) {
      const s = startRef.current;
      startRef.current = null;
      if (!s || disabledRef.current) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (
        dx > MIN_DX &&
        Math.abs(dy) < dx * OFF_AXIS &&
        s.x < window.innerWidth * START_ZONE &&
        Date.now() - s.at < MAX_MS
      ) {
        navigate(-1);
      }
    }
    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchend', onEnd);
    };
  }, [navigate]);
}
