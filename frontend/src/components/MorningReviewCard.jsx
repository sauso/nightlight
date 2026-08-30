import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, X } from 'lucide-react';
import { api } from '../lib/api.js';

// "Was last night right?" — the prompt that turns a morning's recollection into data.
//
// Why it sits HERE, on the child's page, rather than being its own screen or a push: this is where you
// already look the morning after, so it costs no new navigation and no new notification on a phone that
// currently only buzzes when something is actually wrong with your child. It shows once per night and
// goes away for good once answered OR dismissed — a card that comes back after being dismissed teaches
// the habit of ignoring it, and then the nights that matter get ignored too.
//
// It renders nothing at all when there is nothing to ask about (sleep tracking off, no completed night,
// a night with no times to confirm, or one already reviewed), so it never occupies space idly.
export default function MorningReviewCard({ childId, fmtTime }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let live = true;
    setHidden(false);
    api.get(`/children/${childId}/review/pending`)
      .then((r) => { if (live) setPending(r?.pending || null); })
      .catch(() => { /* the card is an invitation, not a feature — stay silent if it can't load */ });
    return () => { live = false; };
  }, [childId]);

  if (!pending || hidden) return null;

  // Dismissing writes a review row with nothing in it, which is what stops the card returning. Hidden
  // optimistically so the card goes the instant it is tapped; a failed write only means it comes back
  // tomorrow, which is a far better failure than a card that will not go away.
  const dismiss = async () => {
    setHidden(true);
    try {
      await api.put(`/children/${childId}/review/${pending.night_date}`, { dismissed: true });
    } catch { /* see above */ }
  };

  const events = pending.transition_count;
  return (
    <div className="card review-card">
      <button type="button" className="review-card__dismiss" onClick={dismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
      <button
        type="button"
        className="review-card__body"
        onClick={() => navigate(`/children/${childId}/review/${pending.night_date}`)}
      >
        <span className="review-card__icon"><ClipboardCheck size={20} /></span>
        <span className="review-card__text">
          <span className="card-title">Was last night right?</span>
          <span className="camera-tile__sub">
            We think they fell asleep at {fmtTime(pending.onset_at)} and got up at {fmtTime(pending.wake_at)}
            {events > 0 && ` · ${events} recorded ${events === 1 ? 'event' : 'events'}`}
          </span>
        </span>
        <span className="review-card__go" aria-hidden="true">›</span>
      </button>
    </div>
  );
}
