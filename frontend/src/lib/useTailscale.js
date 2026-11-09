import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { errorMessage } from './tailscaleCopy.js';

const ENDPOINT = '/remote-access/tailscale';

// How often an open card re-checks while it says "Connected" (15 s while the video address is still being applied, as before).
// Before 2026-11-05 a connected card never looked again, so a device deleted from the tailnet kept saying "Connected" until
// the page was reloaded.
const CONNECTED_POLL_MS = 30000;
// How many views in a row must say the node is offline before the card says so. One reading can be the daemon reconnecting
// (a just-started daemon may report offline for a moment), and two readings are 30-60 s of it.
const OFFLINE_READINGS = 2;

export function useTailscale() {
  const [view, setView] = useState(null);
  const [lostConnection, setLostConnection] = useState(false);
  const offlineReadings = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [consentUrl, setConsentUrl] = useState(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  const mutating = useRef(false);
  const generation = useRef(0);

  // EVERY view the hook shows goes through here, so the count of offline readings cannot be bypassed by an action's response.
  // Only a view that says connected AND online === false counts; anything else (online, unknown/null, another state) resets it.
  const show = useCallback((next) => {
    offlineReadings.current = next?.state === 'connected' && next.online === false ? offlineReadings.current + 1 : 0;
    setLostConnection(offlineReadings.current >= OFFLINE_READINGS);
    setView(next);
  }, []);

  // `quiet` is for the background refresh of a connected card: a failed one keeps the last good view and shows nothing,
  // so a flaky network does not flash a "Couldn't load" banner every 30 seconds. A person's own Retry is not quiet.
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (inFlight.current || mutating.current) return;
    inFlight.current = true;
    const started = generation.current;
    try {
      const next = await api.get(ENDPOINT);
      if (live.current && started === generation.current) { show(next); setError(''); }
    } catch {
      // Keep the last good view: a failed refresh must not turn a ready card into an empty screen.
      if (live.current && started === generation.current && !quiet) setError("Couldn't load Tailscale details.");
    } finally {
      inFlight.current = false;
      if (live.current) setLoading(false);
    }
  }, [show]);

  useEffect(() => {
    live.current = true;
    void load();
    return () => { live.current = false; };
  }, [load]);

  useEffect(() => {
    const connected = view?.state === 'connected';
    const interval = view?.state === 'starting' || (view?.state === 'needs-sign-in' && view.login_url)
      ? 3000 : connected ? (view.video_address_pending ? 15000 : CONNECTED_POLL_MS) : 0;
    if (!interval) return undefined;
    let timer;
    const schedule = () => {
      clearInterval(timer);
      if (!document.hidden) timer = setInterval(() => { void load({ quiet: connected }); }, interval);
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', schedule); };
  }, [view?.state, view?.login_url, view?.video_address_pending, load]);

  const mutate = useCallback(async (request, action) => {
    mutating.current = true;
    generation.current += 1;
    setBusy(true);
    setError('');
    setConsentUrl(null);
    try {
      const next = await request();
      if (live.current) show(next);
      return next;
    } catch (cause) {
      if (live.current) {
        setError(errorMessage(cause.data?.code, action));
        if (cause.data?.code === 'consent_required') setConsentUrl(cause.data.consent_url);
      }
      return null;
    } finally {
      mutating.current = false;
      if (live.current) setBusy(false);
    }
  }, [show]);

  const act = useCallback((action, values = {}) => mutate(
    () => api.post(`${ENDPOINT}/actions`, { action, ...values }), action,
  ), [mutate]);
  const setEnabled = useCallback((enabled) => mutate(
    () => api.put(ENDPOINT, { enabled }), enabled ? 'enable' : 'disable',
  ), [mutate]);

  return { view, loading, error, busy, consentUrl, load, act, setEnabled, lostConnection };
}
