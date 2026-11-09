import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { api } from '../lib/api.js';

const HELP = 'No cameras found. Discovery needs Nightlight on the same network segment as the cameras (host networking, or a network with its own address); the default Docker bridge and cameras on another VLAN are not visible unless the router relays mDNS. You can always add a camera manually.';

// The search card plus one card per camera it finds (#950). The cards are rendered here, not by the caller, because
// they are the scan's own state; `children` renders after them so a caller can put the connect card and the manual
// card directly below the list. A camera already saved is shown greyed and cannot be picked: leaving it out
// looked like a camera the search had missed.
export default function CameraDiscovery({ onPick, autoStart = false, selectedId = null, children = null }) {
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

  const candidates = scan?.candidates || [];
  return <>
    <section className="card camera-discovery" aria-label="Find cameras">
      <h2 className="camera-discovery__title">Cameras on your network</h2>
      <button type="button" className="btn btn-secondary" onClick={start} disabled={scan && !scan.done && !error}>
        {scan?.done || error ? 'Search again' : 'Find cameras on my network'}
      </button>
      {scan && !scan.done && !error && <p role="status">Looking... {seconds}s</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {scan?.done && candidates.length === 0 && !error && <p>{HELP}</p>}
    </section>
    {candidates.length > 0 && <ul className="camera-list" aria-label="Cameras found">
      {candidates.map((candidate) => {
        const added = candidate.alreadyAdded === true;
        const selected = !added && candidate.id === selectedId;
        return <li key={candidate.id}>
          {/* aria-disabled, not disabled: the card stays in the tab order so a screen reader still announces
              it and its "Already added" pill; the click is ignored. */}
          <button type="button" className={`camera-card${selected ? ' is-selected' : ''}${added ? ' is-added' : ''}`}
            aria-pressed={added ? undefined : selected} aria-disabled={added || undefined}
            onClick={() => { if (!added) onPick(candidate); }}>
            <span className="camera-card__text">
              <strong className="camera-card__name">{candidate.name}</strong>
              <span className="camera-card__line">{candidate.ip}</span>
              {candidate.product && <span className="camera-card__line camera-card__product" title={candidate.product}>{candidate.product}</span>}
            </span>
            <span className="camera-card__side">
              {added ? <span className="cam-badge">Already added</span> : <>
                {candidate.sources.includes('mdns') && <span className="cam-badge">Thingino</span>}
                {candidate.sources.includes('onvif') && <span className="cam-badge">ONVIF</span>}
                <ChevronRight size={18} className="camera-card__chevron" aria-hidden="true" />
              </>}
            </span>
          </button>
        </li>;
      })}
    </ul>}
    {children}
  </>;
}
