import { Check } from 'lucide-react';

// The receipt that says a night's correction landed: your times, read back, with a way in to change
// them.
//
// ⚠️ IT LIVES HERE, IN ONE PLACE, ON PURPOSE. It is shown from two screens — the child's page, where
// the morning prompt turns into a receipt, and the sleep detail page, where saving a correction now
// returns you. Written out twice it would be free to drift, and this is user-facing copy asserting
// that something was recorded: the two halves disagreeing is exactly the kind of defect that is
// invisible in review.
//
// The wording is load-bearing rather than decorative. The first version of the morning prompt simply
// vanished on save, which is indistinguishable from having failed — the owner's report was "it then
// disappeared and the card didn't update". A confirmation that names the times back, with a way to
// correct them, is what makes a success visible and a mistake fixable.
//
// `nobodyInBed`: "no one was in the bed" carries no times at all, so it needs its own line rather than
// falling into the `fmtTime(onsetAt) || '—'` branch below, which would read as "You said — to —" — a
// blank-looking receipt for what was actually a complete, deliberate answer (issue: the "no one was in
// the bed" plan, R4/R9 — this is also what an OLDER client, which has never heard of the flag, falls
// back to when reading a flagged reviewCardState response; additive fields degrade gracefully to that,
// not to nothing).
//
// `inBedAt` (2026-09-30): the put-down the person gave, read back BEFORE the asleep time — "You said in
// bed 6:49, asleep 7:13 to 6:37." `onsetAt`/`wakeAt` are the RESOLVED times (theirs where they gave one,
// otherwise the detector's the card is showing), so an in-bed-only answer still reads back a whole night
// instead of "— to —", which would look like a save that failed (plan review R1).
export default function ReviewReceipt({ onsetAt, wakeAt, inBedAt, nobodyInBed, fmtTime, onOpen }) {
  const span = `${fmtTime(onsetAt) || '—'} to ${fmtTime(wakeAt) || '—'}`;
  return (
    <div className="card review-card review-card--done">
      <button type="button" className="review-card__body" onClick={onOpen}>
        <span className="review-card__icon review-card__icon--done"><Check size={20} /></span>
        <span className="review-card__text">
          <span className="card-title">Thanks — that’s recorded</span>
          <span className="camera-tile__sub">
            {nobodyInBed
              ? 'You said no one was in the bed. Tap to change it.'
              : inBedAt
                ? `You said in bed ${fmtTime(inBedAt)}, asleep ${span}. Tap to change it.`
                : `You said ${span}. Tap to change it.`}
          </span>
        </span>
        <span className="review-card__go" aria-hidden="true">›</span>
      </button>
    </div>
  );
}
