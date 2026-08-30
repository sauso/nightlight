import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardCheck, Check, X } from 'lucide-react';
import { api } from '../lib/api.js';

// "Was last night right?" — the prompt that turns a morning's recollection into data, and afterwards
// the receipt that says it landed.
//
// Why it sits HERE, on the child's page, rather than being its own screen or a push: this is where you
// already look the morning after, so it costs no new navigation and no new notification on a phone that
// currently only buzzes when something is actually wrong with your child.
//
// ⚠️ THREE states, not two. The first version simply vanished on save, which is indistinguishable from
// having failed — the owner's first report was "it then disappeared and the card didn't update". A
// short confirmation with a way back in makes a success visible and a mistake correctable, which
// matters here because a mis-recorded time is now what the sleep card displays.
export default function MorningReviewCard({ childId, fmtTime }) {
  const navigate = useNavigate();
  const [card, setCard] = useState(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let live = true;
    setHidden(false);
    api.get(`/children/${childId}/review/pending`)
      .then((r) => { if (live) setCard(r || null); })
      .catch(() => { /* the card is an invitation, not a feature — stay silent if it can't load */ });
    return () => { live = false; };
  }, [childId]);

  if (!card || hidden || card.state === 'none') return null;

  const open = () => navigate(`/children/${childId}/review/${card.night_date}`);

  // Dismissing writes a review row with nothing in it, which is what stops the card returning. Hidden
  // optimistically so it goes the instant it is tapped; a failed write only means it comes back
  // tomorrow, which is a far better failure than a card that will not go away.
  const dismiss = async () => {
    setHidden(true);
    try {
      await api.put(`/children/${childId}/review/${card.night_date}`, { dismissed: true });
    } catch { /* see above */ }
  };

  if (card.state === 'done') {
    return (
      <div className="card review-card review-card--done">
        <button type="button" className="review-card__body" onClick={open}>
          <span className="review-card__icon review-card__icon--done"><Check size={20} /></span>
          <span className="review-card__text">
            <span className="card-title">Thanks — that’s recorded</span>
            <span className="camera-tile__sub">
              You said {fmtTime(card.true_onset_at) || '—'} to {fmtTime(card.true_wake_at) || '—'}. Tap to change it.
            </span>
          </span>
          <span className="review-card__go" aria-hidden="true">›</span>
        </button>
      </div>
    );
  }

  const events = card.transition_count;
  return (
    <div className="card review-card">
      <button type="button" className="review-card__dismiss" onClick={dismiss} aria-label="Dismiss">
        <X size={16} />
      </button>
      <button type="button" className="review-card__body" onClick={open}>
        <span className="review-card__icon"><ClipboardCheck size={20} /></span>
        <span className="review-card__text">
          <span className="card-title">Was last night right?</span>
          <span className="camera-tile__sub">
            We think they fell asleep at {fmtTime(card.onset_at)} and got up at {fmtTime(card.wake_at)}
            {events > 0 && ` · ${events} recorded ${events === 1 ? 'event' : 'events'}`}
          </span>
        </span>
        <span className="review-card__go" aria-hidden="true">›</span>
      </button>
    </div>
  );
}
