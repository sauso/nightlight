import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// #1071: a generation covers both the start response and every poll, so an older search cannot replace a newer one.
export default function useDiscoveryScan(basePath, autoStart = false) {
  const [scan, setScan] = useState(null);
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const controller = useRef(null);
  const timer = useRef(null);
  const mounted = useRef(true);
  const generation = useRef(0);

  function stop() {
    generation.current++;
    controller.current?.abort();
    clearTimeout(timer.current);
  }
  async function start() {
    stop();
    const run = generation.current;
    const pending = new AbortController();
    controller.current = pending;
    setError(''); setSeconds(30); setScan({ candidates: [], done: false, endsAt: Date.now() + 30000 });
    const poll = async (scanId, endsAt) => {
      if (!mounted.current || run !== generation.current) return;
      try {
        const data = await api.get(`${basePath}/${scanId}`, { signal: pending.signal });
        if (!mounted.current || run !== generation.current) return;
        setScan({ ...data, candidates: Array.isArray(data.candidates) ? data.candidates : [] });
        setSeconds(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
        if (!data.done && Date.now() < endsAt) timer.current = setTimeout(() => poll(scanId, endsAt), 1500);
        else if (!data.done) setScan({ ...data, candidates: Array.isArray(data.candidates) ? data.candidates : [], done: true });
      } catch (e) { if (mounted.current && run === generation.current) setError(e.message); }
    };
    try {
      const started = await api.post(basePath, {}, { signal: pending.signal });
      if (mounted.current && run === generation.current) poll(started.scanId, started.endsAt);
    } catch (e) { if (mounted.current && run === generation.current) setError(e.message); }
  }
  useEffect(() => {
    mounted.current = true;
    if (autoStart) start();
    return () => { mounted.current = false; stop(); };
  }, [autoStart, basePath]);
  return { scan, error, seconds, start, stop };
}
