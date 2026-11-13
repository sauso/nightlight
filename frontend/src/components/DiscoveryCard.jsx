import { Check, ChevronRight, Cpu, Wifi } from 'lucide-react';
// "Cameras found" -> "cameras": the noun for the one-time screen-reader announcement ("Looking for cameras").
const nounOf = (label) => label.replace(/ found$/i, '').toLowerCase();
import useDiscoveryScan from '../lib/useDiscoveryScan.js';

// #1076: one scan surface keeps camera and ESPHome states and keyboard semantics in step.
export default function DiscoveryCard({ scanPath, autoStart = false, title, subtitle, idleLabel,
  help, manualLabel, onAddManually, loading = false, full = false, limitNote,
  resultsLabel, describe, selectedId, onPick, ResultIcon = Cpu, children }) {
  const { scan, error, seconds, start } = useDiscoveryScan(scanPath, autoStart);
  const candidates = scan?.candidates || [];
  const searching = !!scan && !scan.done && !error;
  return <>
    <section className="night find-card" aria-label={title}>
      <div className="find-card__head">
        <span className="find-card__icon"><Wifi size={20} aria-hidden="true" /></span>
        <div><h2>{title}</h2><p>{subtitle}</p></div>
      </div>
      <button type="button" className="find-card__action" onClick={start} disabled={searching}>
        {searching ? <><span className="find-card__busy-dot" aria-hidden="true" />Looking… {seconds} s</>
          : scan?.done || error ? 'Search again' : idleLabel}
      </button>
      {/* Announce the start once; the visible countdown should not interrupt speech every second. */}
      {searching && <span className="find-card__sr" role="status">Looking for {nounOf(resultsLabel)}</span>}
      {searching && <div className="find-card__progress" aria-hidden="true"><span style={{ width: `${Math.max(0, (30 - seconds) / 30) * 100}%` }} /></div>}
      {!scan && !error && <p className="find-card__note">A search takes up to 30 seconds.</p>}
      {error && <p className="find-card__error" role="alert">{error}</p>}
      {scan?.done && candidates.length === 0 && !error && <>
        <p className="find-card__note">{help}</p>
        {!full && onAddManually && <button type="button" className="find-card__manual"
          aria-disabled={loading || undefined} onClick={() => { if (!loading) onAddManually(); }}>{manualLabel}</button>}
      </>}
      {full && <p className="find-card__note">{limitNote}</p>}
      {candidates.length > 0 && <ul className="find-card__results" aria-label={resultsLabel}>
        {candidates.map((candidate) => {
          const { name, line, extra, chips = [], added } = describe(candidate);
          const unavailable = added || full || loading;
          const selected = !unavailable && candidate.id === selectedId;
          return <li key={candidate.id}>
            <button type="button" className={`find-card__result${selected ? ' find-card__result--selected' : ''}`}
              aria-disabled={unavailable || undefined} aria-pressed={selectedId == null || unavailable ? undefined : selected}
              onClick={() => { if (!unavailable) onPick(candidate); }}>
              <span className="find-card__tile"><ResultIcon size={16} aria-hidden="true" /></span>
              <span className="find-card__result-text">
                <strong>{name}</strong><span>{line}</span>
                {extra && <span title={extra}>{extra}</span>}
              </span>
              <span className="find-card__side">
                {!added && chips.map((chip) => <span className="find-card__chip" key={chip.text}>{chip.icon && <chip.icon size={12} aria-hidden="true" />}{chip.text}</span>)}
                {added ? <span className="find-card__availability"><Check size={16} aria-hidden="true" />Added</span>
                  : full ? <span className="find-card__availability">Not added</span>
                    : !loading && <ChevronRight size={18} aria-hidden="true" />}
              </span>
            </button>
          </li>;
        })}
      </ul>}
    </section>
    {children}
  </>;
}
