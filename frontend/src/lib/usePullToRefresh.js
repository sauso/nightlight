import { useEffect, useRef, useState } from 'react';

// Custom pull-to-refresh for the camera dashboard. The native browser pull-to-refresh
// gesture doesn't exist inside the Capacitor WebView (the mobile apps), so "just pull
// down" - which the troubleshooting docs suggest for a wedged camera - otherwise does
// nothing there. This implements it in JS instead, so it behaves identically in a
// browser and in the native app.
//
// Listeners are attached natively (not via React's onTouch* props) specifically so
// touchmove can be non-passive: preventing the browser's own rubber-band/scroll while
// pulling is what lets our own indicator be the sole, smooth feedback. React registers
// its touch listeners as passive, where preventDefault is ignored.

const THRESHOLD = 70; //  px of (resisted) pull needed to trigger a refresh
const MAX_PULL = 110; //  px the indicator can travel, so it never runs away down the page
const RESISTANCE = 0.5; // <1 makes the pull feel rubbery - you drag further than it moves
const MIN_SPIN_MS = 600; // keep the spinner up at least this long so it never just flashes

/**
 * @param {object}   opts
 * @param {boolean}  opts.enabled   - only track while the dashboard is the active screen
 * @param {Function} opts.onRefresh - called when the pull passes the threshold; may be async
 * @returns {{ containerRef, pull:number, refreshing:boolean, armed:boolean }}
 */
export function usePullToRefresh({ enabled, onRefresh }) {
  const containerRef = useRef(null);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Refs mirror the rendered state so the native handlers (whose closure is created once
  // per effect run) always read current values without needing to be in the dep array.
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const startYRef = useRef(null);
  const activeRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  function setPullBoth(v) {
    pullRef.current = v;
    setPull(v);
  }
  function setRefreshingBoth(v) {
    refreshingRef.current = v;
    setRefreshing(v);
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled) return undefined;

    function onTouchStart(e) {
      if (refreshingRef.current || e.touches.length !== 1 || window.scrollY > 0) {
        startYRef.current = null;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      activeRef.current = false;
    }

    function onTouchMove(e) {
      if (startYRef.current === null || refreshingRef.current) return;
      const dy = e.touches[0].clientY - startYRef.current;
      // Pulling up, or the page has scrolled off the top mid-gesture: not our gesture.
      if (dy <= 0 || window.scrollY > 0) {
        if (activeRef.current) {
          activeRef.current = false;
          setPullBoth(0);
        }
        return;
      }
      if (!activeRef.current) setDragging(true);
      activeRef.current = true;
      setPullBoth(Math.min(MAX_PULL, dy * RESISTANCE));
      // Suppress the browser's native overscroll so only our indicator moves.
      e.preventDefault();
    }

    async function onTouchEnd() {
      if (startYRef.current === null) return;
      const shouldRefresh = activeRef.current && pullRef.current >= THRESHOLD;
      startYRef.current = null;
      activeRef.current = false;
      setDragging(false);

      if (!shouldRefresh) {
        setPullBoth(0);
        return;
      }
      setRefreshingBoth(true);
      setPullBoth(THRESHOLD); // hold at the threshold line while the spinner runs
      const startedAt = Date.now();
      try {
        await onRefreshRef.current?.();
      } finally {
        const remaining = Math.max(0, MIN_SPIN_MS - (Date.now() - startedAt));
        setTimeout(() => {
          setRefreshingBoth(false);
          setPullBoth(0);
        }, remaining);
      }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled]);

  return { containerRef, pull, refreshing, dragging, armed: pull >= THRESHOLD };
}
