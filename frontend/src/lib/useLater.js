import { useCallback, useEffect, useRef } from 'react';

// A setTimeout for a component that dies with the page (#855, #858).
//
// WHY. A bare `setTimeout(() => setSaved(false), 2500)` is never cancelled: leave the page and it still fires,
// updating state on an unmounted component. In the test run that showed it (#855) it fired after jsdom was torn
// down ("window is not defined", an unhandled error that failed CI although every test passed). #858 fixed the two
// photo timers with a ref each; the same one-line pattern was in 14 other components (the "Saved" ticks, "Copied",
// the camera restart and reboot messages), so it lives here once instead of a ref and a cleanup effect per page.
//
// `later(fn, ms)` behaves like `setTimeout(fn, ms)` while the component is mounted. After unmount it schedules
// nothing (a save that finishes once the page is gone must not start a timer nothing would ever cancel: the Codex
// review of #858), and on unmount every timer still pending is cleared. The returned function is stable, so it is
// safe in a dependency list and never causes an effect to re-run.
//
// Not for a timer you need to cancel yourself before it fires (a debounce, a "restart on second save"): `later`
// returns nothing to cancel. Those keep their own ref.
export function useLater() {
  const alive = useRef(true);
  const pending = useRef(new Set());

  useEffect(() => {
    // Set again, not just initialised: StrictMode runs the cleanup and then the mount once in dev, which would
    // otherwise leave `alive` false for the life of the page (same lesson as #858).
    alive.current = true;
    const timers = pending.current;
    return () => {
      alive.current = false;
      timers.forEach((id) => clearTimeout(id));
      timers.clear();
    };
  }, []);

  return useCallback((fn, ms) => {
    if (!alive.current) return;
    const id = setTimeout(() => {
      pending.current.delete(id); // fired: nothing left to clear for it
      fn();
    }, ms);
    pending.current.add(id);
  }, []);
}
