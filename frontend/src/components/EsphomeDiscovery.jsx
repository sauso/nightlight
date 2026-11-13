import { Check, ChevronRight, Cpu, Lock, Wifi } from 'lucide-react';
import useDiscoveryScan from '../lib/useDiscoveryScan.js';

const HELP = 'No devices found. Discovery needs Nightlight on the same network segment as the devices. The default Docker bridge does not expose LAN multicast; another VLAN needs an mDNS relay. You can always add a device manually.';

export default function EsphomeDiscovery({ onPick, onAddManually, full = false, loading = false }) {
  const { scan, error, seconds, start } = useDiscoveryScan('/esphome/discover');
  const candidates = scan?.candidates || [];
  const searching = !!scan && !scan.done && !error;
  return (
    <section className="night esp-find" aria-label="Find devices">
      <div className="esp-find__head">
        <span className="esp-find__icon"><Wifi size={20} aria-hidden="true" /></span>
        <div><h2>Find devices</h2><p>ESPHome devices on your network</p></div>
      </div>
      <button type="button" className="esp-find__action" onClick={start} disabled={searching}>
        {searching ? <><span className="esp-find__busy-dot" aria-hidden="true" />Looking… {seconds} s</>
          : scan?.done || error ? 'Search again' : 'Find devices on my network'}
      </button>
      {/* One announcement when the search starts. The visible seconds are not a live region: reading out every tick would
          talk over a screen reader for 30 seconds. */}
      {searching && <span className="esp-find__sr" role="status">Looking for devices</span>}
      {searching && <div className="esp-find__progress" aria-hidden="true"><span style={{ width: `${Math.max(0, (30 - seconds) / 30) * 100}%` }} /></div>}
      {!scan && !error && <p className="esp-find__note">A search takes up to 30 seconds.</p>}
      {error && <p className="esp-find__error" role="alert">{error}</p>}
      {scan?.done && candidates.length === 0 && !error && <>
        <p className="esp-find__note">{HELP}</p>
        {/* Same rule as a pick: no add form before the device count is known (#1075 review). */}
        {!full && <button type="button" className="esp-find__manual" aria-disabled={loading || undefined}
          onClick={() => { if (!loading) onAddManually?.(); }}>Add by IP address</button>}
      </>}
      {full && <p className="esp-find__note">You have 8 devices, which is the limit. Delete one to add another.</p>}
      {candidates.length > 0 && <ul className="esp-find__results" aria-label="Devices found">
        {candidates.map((candidate) => {
          // #1074: the count must be known before a pick; a failed list load may still use the server's limit check.
          const unavailable = candidate.alreadyAdded === true || full || loading;
          return <li key={candidate.id}>
            <button type="button" className="esp-find__result" aria-disabled={unavailable || undefined}
              onClick={() => { if (!unavailable) onPick(candidate); }}>
              <span className="esp-find__tile"><Cpu size={16} aria-hidden="true" /></span>
              <span className="esp-find__result-text">
                <strong>{candidate.name}</strong>
                <span>{candidate.ip}:{candidate.port}{candidate.board ? ` · ${candidate.board}` : ''}</span>
                {candidate.version && <span>{candidate.version}</span>}
              </span>
              <span className="esp-find__side">
                {candidate.encrypted && <span className="esp-find__chip"><Lock size={12} aria-hidden="true" />Encryption advertised</span>}
                {candidate.alreadyAdded ? <span className="esp-find__availability"><Check size={16} aria-hidden="true" />Added</span>
                  : full ? <span className="esp-find__availability">Not added</span>
                    : !loading && <ChevronRight size={18} aria-hidden="true" />}
              </span>
            </button>
          </li>;
        })}
      </ul>}
    </section>
  );
}
