import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';

const HELP = 'No cameras found. Discovery needs Nightlight on the same network segment as the cameras (host networking, or a network with its own address); the default Docker bridge and cameras on another VLAN are not visible unless the router relays mDNS. You can always add a camera manually.';

export default function CameraDiscovery({ onPick, autoStart = false }) {
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
        const data = await api.get(`/cameras/discover/${scanId}`, { signal: pending.signal });
        if (!mounted.current || run !== generation.current) return;
        setScan({ ...data, candidates: Array.isArray(data.candidates) ? data.candidates : [] });
        setSeconds(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
        if (!data.done && Date.now() < endsAt) timer.current = setTimeout(() => poll(scanId, endsAt), 1500);
        else if (!data.done) setScan({ ...data, candidates: Array.isArray(data.candidates) ? data.candidates : [], done: true });
      } catch (e) { if (mounted.current && run === generation.current) setError(e.message); }
    };
    try {
      const started = await api.post('/cameras/discover', {}, { signal: pending.signal });
      if (mounted.current && run === generation.current) poll(started.scanId, started.endsAt);
    } catch (e) { if (mounted.current && run === generation.current) setError(e.message); }
  }
  useEffect(() => {
    mounted.current = true;
    if (autoStart) start();
    return () => { mounted.current = false; stop(); };
  }, [autoStart]);

  return <section className="card camera-discovery" aria-label="Find cameras">
    <button type="button" className="btn btn-secondary" onClick={start} disabled={scan && !scan.done && !error}>
      {scan?.done || error ? 'Search again' : 'Find cameras on my network'}
    </button>
    {scan && !scan.done && !error && <p role="status">Looking... {seconds}s</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {scan?.candidates?.map((candidate) => <button type="button" className="list-row camera-discovery__row"
      key={candidate.id} onClick={() => onPick(candidate)}>
      <span><strong>{candidate.name}</strong><br />{candidate.ip}{candidate.product ? ` · ${candidate.product}` : ''}</span>
      <span>{candidate.sources.includes('mdns') && 'Thingino'}{candidate.sources.includes('mdns') && candidate.sources.includes('onvif') && ' · '}{candidate.sources.includes('onvif') && 'ONVIF'}</span>
    </button>)}
    {scan?.done && scan.candidates?.length === 0 && !error && <p>{HELP}</p>}
  </section>;
}
