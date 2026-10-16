import { useEffect, useRef } from 'react';

// Automatic retry for the "Can't reach Nightlight" state (#382).
//
// `failures` is how many attempts in a row have failed (0 = none, nothing is scheduled). Each time it
// changes to a positive number this schedules ONE retry after a growing wait, and the caller bumps it again
// if that retry fails too, so the wait backs off 5 s, 10 s, 20 s, then stays at 30 s. A manual retry that
// fails bumps it as well, which restarts the wait from the new step instead of firing twice.
//
// WHY THESE NUMBERS. They are a judgement call, not a measurement: 5 s is quick enough that a server
// restart (a container recreate takes a few seconds) is picked up without a tap, and 30 s is the ceiling so
// a tablet left on the sign-in screen overnight is not hammering a server that is down.
export const RETRY_BASE_MS = 5000;
export const RETRY_MAX_MS = 30000;

export function retryDelayMs(failures) {
  return Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

export function useAutoRetry(failures, retry) {
  // The latest callback, so the timer never fires a stale closure and the effect need not depend on it.
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (failures < 1) return undefined;
    const timer = setTimeout(() => retryRef.current(), retryDelayMs(failures));
    return () => clearTimeout(timer);
  }, [failures]);
}
