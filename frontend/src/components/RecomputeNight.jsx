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
// Why it exists: a stored night is written once and never revisited, so after any change to the sleep
// logic the summary CARD keeps showing the old answer while this page — which recomputes on every view
// — shows the new one. They disagree and never converge. On 2026-08-29 the stored row said a child fell
// asleep at 16:56 while this page correctly said 20:15, and the only way to reconcile it was pasting a
// fetch into a browser console with hand-copied child ids.
//
// It shows BEFORE -> AFTER rather than just asking "are you sure?". The comparison is the point: it
// turns an irreversible write into something you can read and judge first, and it is how an improvement
// to the sleep algorithm becomes visible instead of theoretical. The write itself refuses to downgrade
// a scored night (see computeAndStoreNight), so the worst case here is "nothing changed".
export default function RecomputeNight({ childId, date, night, fmtTime, onRecomputed }) {
  const { user } = useAuth();
  const [preview, setPreview] = useState(null); // the recomputed night, before storing
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (user?.role !== 'admin' || !childId || !date || night?.in_progress) return null;

  const rows = preview ? [
    ['Fell asleep', fmtTime(night.onset_at), fmtTime(preview.onset_at)],
    ['Woke', fmtTime(night.wake_at), fmtTime(preview.wake_at)],
    ['Asleep', fmtDur(night.asleep_minutes), fmtDur(preview.asleep_minutes)],
    ['Awake', fmtDur(night.awake_minutes), fmtDur(preview.awake_minutes)],
    ['Wake-ups', String(night.wake_count ?? 0), String(preview.wake_count ?? 0)],
  ] : [];
  const changed = rows.some(([, before, after]) => before !== after);

  const store = async () => {
    setBusy(true);
    setError(null);
    try {
      const stored = await api.get(`/children/${childId}/sleep/${date}?store=1&detail=1`);
      onRecomputed?.(stored);
      setPreview(null);
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
            setPreview(await api.get(`/children/${childId}/sleep/${date}?detail=1`));
          } catch (e) {
            setError(e?.message || 'Could not work this night out again.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={16} aria-hidden="true" /> Recompute this night
      </button>
      {error && !preview && <div className="sleep-detail__recompute-error">{error}</div>}

      {preview && (
        <Modal title="Recompute this night" onClose={() => !busy && setPreview(null)}>
          {changed ? (
            <>
              <p style={{ marginTop: 0 }}>
                Working this night out again from the recorded movement gives different numbers. Saving
                replaces the stored summary — the one shown on the child’s page.
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
              Working this night out again gives exactly the same numbers, so there is nothing to save.
            </p>
          )}
          {error && <div className="sleep-detail__recompute-error">{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setPreview(null)} disabled={busy}>
              {changed ? 'Cancel' : 'Close'}
            </button>
            {changed && (
              <button type="button" className="btn btn-primary" onClick={store} disabled={busy}>
                {busy ? 'Saving…' : 'Save the new numbers'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
