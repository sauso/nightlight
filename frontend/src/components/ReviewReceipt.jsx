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
export default function ReviewReceipt({ onsetAt, wakeAt, fmtTime, onOpen }) {
  return (
    <div className="card review-card review-card--done">
      <button type="button" className="review-card__body" onClick={onOpen}>
        <span className="review-card__icon review-card__icon--done"><Check size={20} /></span>
        <span className="review-card__text">
          <span className="card-title">Thanks — that’s recorded</span>
          <span className="camera-tile__sub">
            You said {fmtTime(onsetAt) || '—'} to {fmtTime(wakeAt) || '—'}. Tap to change it.
          </span>
        </span>
        <span className="review-card__go" aria-hidden="true">›</span>
      </button>
    </div>
  );
}
