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
// `nobodyInBed`: "no one was in the bed" carries no times at all, so it needs its own line (issue: the
// "no one was in the bed" plan, R4/R9 — this is also what an OLDER client, which has never heard of the
// flag, falls back to when reading a flagged reviewCardState response; additive fields degrade gracefully
// to that, not to nothing).
//
// ★ IT READS BACK ONLY WHAT THE PERSON ANSWERED (2026-10-27, the one-question review). `inBedAt`,
// `onsetAt` and `wakeAt` are the RAW answers (the review's `true_*` values), not the resolved times this
// used to take (theirs where they gave one, otherwise the detector's). The review now asks only when the
// child got up, so a wake-only answer must read "You said up at 6:37." and not also quote an asleep time
// the person never gave: the receipt is a statement about what THEY said, and reading the detector's guess
// back as if it were theirs is the confusion the one-question screen exists to remove. The cost is
// accepted: an old review that holds all three still reads all three, in order.
export default function ReviewReceipt({ onsetAt, wakeAt, inBedAt, nobodyInBed, fmtTime, onOpen }) {
  const said = [
    inBedAt && `in bed ${fmtTime(inBedAt)}`,
    onsetAt && `asleep ${fmtTime(onsetAt)}`,
    wakeAt && `up at ${fmtTime(wakeAt)}`,
  ].filter(Boolean);
  return (
    <div className="card review-card review-card--done">
      <button type="button" className="review-card__body" onClick={onOpen}>
        <span className="review-card__icon review-card__icon--done"><Check size={20} /></span>
        <span className="review-card__text">
          <span className="card-title">Thanks — that’s recorded</span>
          <span className="camera-tile__sub">
            {nobodyInBed
              ? 'You said no one was in the bed. Tap to change it.'
              : said.length
                ? `You said ${said.join(', ')}. Tap to change it.`
                : 'Your answer is saved. Tap to change it.'}
          </span>
        </span>
        <span className="review-card__go" aria-hidden="true">›</span>
      </button>
    </div>
  );
}
