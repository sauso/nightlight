import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
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
//
// ⚠️ A NIGHT A PARENT CORRECTED IS LOCKED (2026-09-30, the owner's rule: once corrected, a night is
// complete and nothing re-scores it). The server refuses the write, and `?stored=1` says so up front as
// `locked`, so the dialog opens on "this night is locked" instead of offering numbers that could never
// be saved. It keys on the server's `locked`, deliberately NOT on `night.corrected` (plan review R8): a
// corrected night whose saved row is missing or unscored is not locked, and this button is its only fix.
//
// ⚠️ THE LOCKED DIALOG USED TO SAY "Removing your correction unlocks it" WITH NOTHING TO REMOVE IT WITH
// (owner, staging, 2026-10). The review screen seeds its asleep and wake inputs with the detector's value, so
// a person who cleared only the in-bed time stayed locked (true_onset_at and true_wake_at still set) and
// nothing said why. "Remove my correction" is that missing control. It is a plain save of the EXISTING review
// route, deliberately and only with the three times, their three frame ids and (only when the stored review
// says no one was in the bed) the flag. See `removeCorrection` for exactly what is and is not sent.
export default function RecomputeNight({ childId, date, night, fmtTime, onRecomputed, onCorrectionRemoved }) {
  const { user } = useAuth();
  const [stored, setStored] = useState(undefined); // the saved row: undefined = not looked yet, null = none
  const [locked, setLocked] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false); // the "Remove my correction" confirm step, in the modal
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (user?.role !== 'admin' || !childId || !date || night?.in_progress) return null;

  const closeDialog = () => {
    setOpen(false);
    setConfirming(false);
  };

  // Clears the person's correction so the night can be recomputed, and keeps everything else they said.
  //
  // ⚠️ WHAT IS SENT IS THE WHOLE POINT. The review route reads `undefined` (key omitted) as "keep what is
  // stored" and `null` as "clear it" (sleepReviews.previewNightReview, `pick`), so this body names ONLY the
  // six time fields, each null. No verdicts, reasons, note or computed_* are sent, so the person's answers
  // about the events, their note and what the app showed them at the time all survive. Sending them "to be
  // safe" would re-save them as this person's answer, and a note re-sent from a stale page would overwrite
  // a newer one.
  //
  // The flag is the one exception, and it is conditional: "no one was in the bed" and the times are mutually
  // exclusive on the server, and with the times all null a stored flag would simply stay set (the night
  // would still be locked). `nobody_in_bed: false` is sent ONLY when the stored review has it, because
  // sending it also counts as an answer on the server (it resets a dismissal and puts the sender's name on
  // the review), which clearing three times does not. The stored review is read fresh here, not taken from
  // the page's night: that one is overlaid and goes stale on a second phone.
  const removeCorrection = async () => {
    setBusy(true);
    setError(null);
    try {
      const review = await api.get(`/children/${childId}/review/${date}`);
      const body = {
        true_onset_local: null,
        true_wake_local: null,
        true_in_bed_local: null,
        true_onset_transition_id: null,
        true_wake_transition_id: null,
        true_in_bed_transition_id: null,
      };
      // Strictly `=== 1`: the same reading as the server's saidNobody, so a value it would not treat as the
      // flag does not make this send an answer it did not need to.
      if (review?.review?.nobody_in_bed === 1) body.nobody_in_bed = false;
      await api.put(`/children/${childId}/review/${date}`, body);
    } catch (e) {
      // Nothing was removed: the dialog stays locked and says why.
      setError(e?.message || 'Could not remove your correction.');
      setBusy(false);
      return;
    }
    // The save is done, so anything on the page that quotes the correction is stale from here on, whether
    // or not the refresh below works. The detail page's "Thanks — that's recorded" receipt is the one:
    // arriving from a save and pressing Recompute is the natural route to this dialog, and the receipt
    // would go on telling the person the times they have just removed were recorded.
    onCorrectionRemoved?.();
    try {
      // Re-read the saved row so the dialog moves from "locked" to the ordinary before/after preview. The
      // server's `locked` is the authority again, not an assumption that the save worked: a second phone
      // that corrected the night in between would leave it locked, and the dialog must say so.
      const r = await api.get(`/children/${childId}/sleep/${date}?stored=1`);
      setStored(r?.night ?? null);
      setLocked(r?.locked === true);
      setConfirming(false);
      // The normal (overlaid) read, as `save` does: the page then shows the detector's own night.
      const overlaid = await api.get(`/children/${childId}/sleep/${date}?detail=1`);
      onRecomputed?.(overlaid);
    } catch (e) {
      // The removal HAPPENED (the PUT above succeeded), so this must not read as a failed removal.
      setError(`Your correction was removed, but this page could not refresh (${e?.message || 'network error'}). Close this and reload the page.`);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const rows = open && stored ? [
    ['Fell asleep', fmtTime(stored.onset_at), fmtTime(night.onset_at)],
    ['Woke', fmtTime(stored.wake_at), fmtTime(night.wake_at)],
    ['Asleep', fmtDur(stored.asleep_minutes), fmtDur(night.asleep_minutes)],
    ['Awake', fmtDur(stored.awake_minutes), fmtDur(night.awake_minutes)],
    ['Wake-ups', String(stored.wake_count ?? 0), String(night.wake_count ?? 0)],
  ] : [];
  const changed = !locked && rows.some(([, before, after]) => before !== after);
  const nothingSaved = !locked && open && stored === null;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // ⚠️ `?store=1` is RAW BY DESIGN (see the route's own comment in children.js): it reports what the
      // detector just saved to sleep_nights, not what the page should show. A parent's correction — a
      // typed time, or "no one was in the bed" — lives in sleep_reviews and is laid over every NORMAL
      // read of a night. Passing the store response straight to `onRecomputed` used to repaint the
      // screen with the detector's raw answer the instant you recomputed, silently undoing whatever
      // correction was showing a moment before — true for a time correction already, and it would have
      // been just as true for the new flag if this had not been fixed (plan review R3). Re-fetching the
      // normal route after the write is what keeps the overlay in force.
      await api.get(`/children/${childId}/sleep/${date}?store=1&detail=1`, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      const overlaid = await api.get(`/children/${childId}/sleep/${date}?detail=1`);
      onRecomputed?.(overlaid);
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
            // Strictly `true`: a server from before this field sends nothing, which must read as unlocked.
            setLocked(r?.locked === true);
            setConfirming(false);
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
      {/* A corrected night shows the person's times, not ours, so the button can look broken: the owner
          pressed it expecting a wrong time to be replaced, and nothing visible happened. Say where the
          times come from and where to change them. It used to add that recomputing "will not change what
          is shown", which read as harmless; since the lock a corrected night is usually not recomputed at
          all, and the dialog says so when it is locked. This line only makes claims true of every
          corrected night: recomputing never replaces a person's own times. */}
      {night?.corrected && (
        <div className="sleep-detail__recompute-note">
          {/* #521: Recompute is now reachable on a night flagged "no one was in the bed", where there are no
              times to speak of; "these times" would be false there. */}
          {night.nobody_in_bed
            ? 'Your answer that no one was in the bed is kept, and recomputing never replaces it. To change it, use '
            : 'These times are the ones you told us, and recomputing never replaces them. To change them, use '}
          <strong>Change what you told us about this night</strong>.
        </div>
      )}

      {open && (
        <Modal title="Recompute this night" onClose={() => !busy && closeDialog()}>
          {locked && confirming ? (
            // The confirm step lives INSIDE this modal (never window.confirm). It says what the button does
            // and, as important, what it does not: the event answers and the note stay. It must also say that
            // the times are REMOVED rather than hidden (nothing brings them back; "enter them again" is the
            // only way to a correction after this), that the recompute is the app's own estimate and may be
            // wrong (the very thing the person overruled), and that saving a correction locks the night
            // again. Owner's wording requirement for this step.
            <>
              <p style={{ marginTop: 0 }}>
                This removes the times you entered for this night (or your answer that no one was in the
                bed), so the night can be recomputed. They are removed, not hidden. Your answers to the
                events and your note are kept.
              </p>
              <p>
                Recomputing shows the app’s own estimate, which may be wrong. To keep a correction after
                that you will need to enter them again, and a corrected night locks again when you save it.
                The night is not recomputed until you choose to.
              </p>
            </>
          ) : locked ? (
            <p style={{ marginTop: 0 }}>
              This night is locked because you corrected it, so it won’t be recomputed, here or overnight.
              To change it, use <strong>Change what you told us about this night</strong>, or remove your
              correction here to unlock it.
            </p>
          ) : nothingSaved ? (
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
            {locked && confirming ? (
              <>
                <button type="button" className="btn" onClick={() => { setConfirming(false); setError(null); }} disabled={busy}>
                  Keep my correction
                </button>
                <button type="button" className="btn btn-danger" onClick={removeCorrection} disabled={busy}>
                  {busy ? 'Removing…' : 'Remove my correction'}
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={closeDialog} disabled={busy}>
                {changed || nothingSaved ? 'Cancel' : 'Close'}
              </button>
            )}
            {locked && !confirming && (
              <button type="button" className="btn btn-secondary" onClick={() => { setError(null); setConfirming(true); }} disabled={busy}>
                Remove my correction
              </button>
            )}
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
