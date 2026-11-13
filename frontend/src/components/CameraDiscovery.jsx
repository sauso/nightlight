import { ChevronRight } from 'lucide-react';
import useDiscoveryScan from '../lib/useDiscoveryScan.js';

const HELP = 'No cameras found. Discovery needs Nightlight on the same network segment as the cameras (host networking, or a network with its own address); the default Docker bridge and cameras on another VLAN are not visible unless the router relays mDNS. You can always add a camera manually.';

// The search card plus one card per camera it finds (#950). The cards are rendered here, not by the caller, because
// they are the scan's own state; `children` renders after them so a caller can put the connect card and the manual
// card directly below the list. A camera already saved is shown greyed and cannot be picked: leaving it out
// looked like a camera the search had missed.
export default function CameraDiscovery({ onPick, autoStart = false, selectedId = null, children = null }) {
  const { scan, error, seconds, start } = useDiscoveryScan('/cameras/discover', autoStart);

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
