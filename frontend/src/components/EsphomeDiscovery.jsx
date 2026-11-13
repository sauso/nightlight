import { ChevronRight } from 'lucide-react';
import useDiscoveryScan from '../lib/useDiscoveryScan.js';

const HELP = 'No devices found. Discovery needs Nightlight on the same network segment as the devices. The default Docker bridge does not expose LAN multicast; another VLAN needs an mDNS relay. You can always add a device manually.';

export default function EsphomeDiscovery({ onPick, full = false }) {
  const { scan, error, seconds, start } = useDiscoveryScan('/esphome/discover');
  const candidates = scan?.candidates || [];
  return <>
    <section className="card camera-discovery" aria-label="Find devices">
      <h2 className="camera-discovery__title">Devices on your network</h2>
      <button type="button" className="btn btn-secondary" onClick={start} disabled={scan && !scan.done && !error}>
        {scan?.done || error ? 'Search again' : 'Find devices on my network'}
      </button>
      {scan && !scan.done && !error && <p role="status">Looking... {seconds}s</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {scan?.done && candidates.length === 0 && !error && <p>{HELP}</p>}
      {full && <p className="camera-tile__sub">Results cannot be picked while you have 8 devices.</p>}
    </section>
    {candidates.length > 0 && <ul className="camera-list" aria-label="Devices found">
      {candidates.map((candidate) => {
        const unavailable = candidate.alreadyAdded === true || full;
        return <li key={candidate.id}>
          {/* #1071: keep unavailable cards focusable so their reason can be announced. */}
          <button type="button" className={`camera-card${unavailable ? ' is-added' : ''}`}
            aria-disabled={unavailable || undefined} onClick={() => { if (!unavailable) onPick(candidate); }}>
            <span className="camera-card__text">
              <strong className="camera-card__name">{candidate.name}</strong>
              <span className="camera-card__line">{candidate.ip}:{candidate.port}</span>
              {candidate.board && <span className="camera-card__line camera-card__product">{candidate.board}</span>}
              {candidate.version && <span className="camera-card__line">{candidate.version}</span>}
            </span>
            <span className="camera-card__side">
              {candidate.encrypted && <span className="cam-badge">Encryption advertised</span>}
              {candidate.alreadyAdded ? <span className="cam-badge">Already added</span>
                : <ChevronRight size={18} className="camera-card__chevron" aria-hidden="true" />}
            </span>
          </button>
        </li>;
      })}
    </ul>}
  </>;
}
