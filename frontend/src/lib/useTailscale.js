import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { errorMessage } from './tailscaleCopy.js';

const ENDPOINT = '/remote-access/tailscale';

export function useTailscale() {
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [consentUrl, setConsentUrl] = useState(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  const mutating = useRef(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (inFlight.current || mutating.current) return;
    inFlight.current = true;
    const started = generation.current;
    try {
      const next = await api.get(ENDPOINT);
      if (live.current && started === generation.current) { setView(next); setError(''); }
    } catch {
      // Keep the last good view: a failed refresh must not turn a ready card into an empty screen.
      if (live.current && started === generation.current) setError("Couldn't load Tailscale details.");
    } finally {
      inFlight.current = false;
      if (live.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    void load();
    return () => { live.current = false; };
  }, [load]);

  useEffect(() => {
    const interval = view?.state === 'starting' || (view?.state === 'needs-sign-in' && view.login_url)
      ? 3000 : view?.state === 'connected' && view.video_address_pending ? 15000 : 0;
    if (!interval) return undefined;
    let timer;
    const schedule = () => {
      clearInterval(timer);
      if (!document.hidden) timer = setInterval(() => { void load(); }, interval);
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
      if (live.current) setView(next);
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
  }, []);

  const act = useCallback((action, values = {}) => mutate(
    () => api.post(`${ENDPOINT}/actions`, { action, ...values }), action,
  ), [mutate]);
  const setEnabled = useCallback((enabled) => mutate(
    () => api.put(ENDPOINT, { enabled }), enabled ? 'enable' : 'disable',
  ), [mutate]);

  return { view, loading, error, busy, consentUrl, load, act, setEnabled };
}
