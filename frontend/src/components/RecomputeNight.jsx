import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import Modal from './Modal.jsx';

// Durations read as "9h 01m" here, matching the summary card this dialog is comparing against.
function fmtDur(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Admin-only "Recompute this night".
//
// Why it exists: a stored night is written once, the morning after, and never revisited, so after any
// change to the sleep logic the child's "last night" CARD keeps showing the old answer while the sleep
// detail page — which recomputes on every view — shows the new one. They disagree and never converge.
// On 2026-08-29 the stored row said a child fell asleep at 16:56 while the detail page correctly said
// 20:15, and the only way to reconcile it was pasting a fetch into a browser console.
//
// ⚠️ THE BASELINE IS THE STORED ROW, AND THAT IS THE WHOLE POINT. The first cut of this compared the
// page's `night` — which is ALREADY a fresh recompute — against another fresh recompute, so the two
// sides were the same computation and the dialog always reported "exactly the same numbers" while the
// card stayed wrong. `?stored=1` fetches what is actually saved. If this ever regresses to comparing
// against the page's night, the feature silently does nothing.
//
// It shows BEFORE -> AFTER rather than just asking "are you sure?". The comparison is the point: it
// turns an irreversible write into something you can read and judge first, and it is how an improvement
// to the sleep algorithm becomes visible instead of theoretical. The write itself refuses to downgrade
// a scored night (see computeAndStoreNight), so the worst case here is "nothing changed".
export default function RecomputeNight({ childId, date, night, fmtTime, onRecomputed }) {
  const { user } = useAuth();
  const [stored, setStored] = useState(undefined); // the saved row: undefined = not looked yet, null = none
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (user?.role !== 'admin' || !childId || !date || night?.in_progress) return null;

  const rows = open && stored ? [
    ['Fell asleep', fmtTime(stored.onset_at), fmtTime(night.onset_at)],
    ['Woke', fmtTime(stored.wake_at), fmtTime(night.wake_at)],
    ['Asleep', fmtDur(stored.asleep_minutes), fmtDur(night.asleep_minutes)],
    ['Awake', fmtDur(stored.awake_minutes), fmtDur(night.awake_minutes)],
    ['Wake-ups', String(stored.wake_count ?? 0), String(night.wake_count ?? 0)],
  ] : [];
  const changed = rows.some(([, before, after]) => before !== after);
  const nothingSaved = open && stored === null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.get(`/children/${childId}/sleep/${date}?store=1&detail=1`);
      onRecomputed?.(result);
      setOpen(false);
      setStored(undefined); // force a fresh look next time
    } catch (e) {
      setError(e?.message || 'Could not save the recomputed night.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm sleep-detail__recompute"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.get(`/children/${childId}/sleep/${date}?stored=1`);
            setStored(r?.night ?? null);
            setOpen(true);
          } catch (e) {
            setError(e?.message || 'Could not read the saved summary for this night.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={16} aria-hidden="true" /> Recompute this night
      </button>
      {error && !open && <div className="sleep-detail__recompute-error">{error}</div>}
      {/* A corrected night shows the person's times, not ours, so recomputing appears to do nothing —
          it changes the detector's answer underneath while the display keeps their correction. Say so,
          because otherwise the button looks broken. The owner pressed it expecting a wrong time to be
          replaced, and nothing visible happened. */}
      {night?.corrected && (
        <div className="sleep-detail__recompute-note">
          These times are the ones you told us. Recomputing re-runs the detector underneath — it will
          not change what is shown here. To change these, use <strong>Change what you told us about
          this night</strong>.
        </div>
      )}

      {open && (
        <Modal title="Recompute this night" onClose={() => !busy && setOpen(false)}>
          {nothingSaved ? (
            <p style={{ marginTop: 0 }}>
              Nothing is saved for this night yet, so there is no summary on the child’s page to correct.
              Saving now records the night as it is shown here.
            </p>
          ) : changed ? (
            <>
              <p style={{ marginTop: 0 }}>
                The summary saved for this night — the one on the child’s page — no longer matches what
                the recorded movement says. Saving replaces it with the figures on the right.
              </p>
              <div className="recompute-diff">
                {rows.map(([label, before, after]) => (
                  <div key={label} className={`recompute-diff__row${before === after ? '' : ' is-changed'}`}>
                    <span className="recompute-diff__label">{label}</span>
                    <span className="recompute-diff__was">{before || '—'}</span>
                    <span className="recompute-diff__arrow" aria-hidden="true">→</span>
                    <span className="recompute-diff__now">{after || '—'}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={{ marginTop: 0 }}>
              The saved summary already matches the recorded movement, so there is nothing to change.
            </p>
          )}
          {error && <div className="sleep-detail__recompute-error">{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
              {changed || nothingSaved ? 'Cancel' : 'Close'}
            </button>
            {(changed || nothingSaved) && (
              <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : nothingSaved ? 'Save this night' : 'Save the new numbers'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
