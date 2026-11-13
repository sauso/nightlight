import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useSettings } from '../lib/SettingsContext.jsx';
import { confirmWakeBody } from '../lib/reviewConfirm.js';
import ReviewReceipt from './ReviewReceipt.jsx';

// "Up at 6:20 AM. Is that right?" — the question that turns a morning's recollection into data, and afterwards the
// receipt that says it landed. It lives INSIDE the child page's night card (design, 2026-11-12), under the headline, so the
// answer is one tap away from the night it is about; it used to be a card of its own below the hero.
//
// Why it sits on the child's page, rather than being its own screen or a push: this is where you already look the morning
// after, so it costs no new navigation and no new notification on a phone that currently only buzzes when something is
// actually wrong with your child.
//
// ⚠️ THREE states, not two. The first version simply vanished on save, which is indistinguishable from having failed — the
// owner's first report was "it then disappeared and the card didn't update". A short confirmation with a way back in makes
// a success visible and a mistake correctable, which matters here because a mis-recorded time is now what the sleep card
// displays.
//
// "That's right" SAVES FROM HERE (one tap, as drawn); "Not quite" opens the review screen, where the time is corrected. The
// screen stays the one place that decides what may be confirmed (see confirmWakeBody for the nights it sends there
// instead), and the route the push notification opens (/children/:id/review/:date) is untouched.
//
// `forNight` (optional, a 'YYYY-MM-DD' night date or null): the night the card above shows. Given, the question or the receipt is
// drawn ONLY when the server's answer is about that same night: while tonight is in progress (null) there is no row at all, and a
// receipt from the previous night never sits under "Tonight · so far" (the server answers about the last completed night whatever
// the card shows). Omitted (undefined), the card behaves as before, for any other caller.
export default function MorningReviewCard({ childId, fmtTime, forNight }) {
  const navigate = useNavigate();
  // ⚠️ NOTHING THAT SENDS A TIME WORKS UNTIL THE REAL TIMEZONE HAS ARRIVED (#512, same rule as NightReview.jsx). Until
  // /settings resolves `tz` is the placeholder 'UTC', so a time read in it and saved would be a wrong time stored as the
  // parent's own answer. The question is not drawn either, so the placeholder zone's time is never on screen to confirm.
  const { settings, loaded: settingsLoaded, loading: settingsLoading } = useSettings();
  // `loading` false with `loaded` still false is a FAILED first /settings request (SettingsContext clears `loading` when a request
  // settles and only a success sets `loaded`), so this visit is stuck on the placeholder zone for good. Same reading as NightReview.jsx.
  const settingsFailed = !settingsLoaded && !settingsLoading;
  const tz = settings?.timezone;
  const [card, setCard] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A guard that is true the instant a tap starts, before React has re-rendered the disabled buttons: two taps in one frame must
  // still be one save.
  const inFlight = useRef(false);

  const loadPending = useCallback(
    () => api.get(`/children/${childId}/review/pending`),
    [childId]
  );

  useEffect(() => {
    let live = true;
    setHidden(false);
    setError('');
    loadPending()
      .then((r) => { if (live) setCard(r || null); })
      .catch(() => { /* the card is an invitation, not a feature — stay silent if it can't load */ });
    return () => { live = false; };
  }, [loadPending]);

  if (!card || hidden || card.state === 'none') return null;
  if (forNight !== undefined && card.night_date !== forNight) return null;

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

  // "That's right". Reads the night as the review screen would (GET), builds the screen's own confirm body, and saves it;
  // when the screen would ask something else (confirmWakeBody returns null) it opens the screen instead, which is exactly
  // today's tap. On success the pending state is read again so the receipt comes from the server's own view of the answer;
  // if only that read fails, the receipt is built from what was just saved, because a prompt that vanishes looks like a
  // failed save.
  //
  // ⚠️ KNOWN LIMIT, THE SAME AS THE REVIEW SCREEN'S OWN: the PUT has no server-side precondition (it upserts), so a second device
  // that answers between this GET and this PUT is overwritten. The screen has the identical gap between ITS load and ITS save;
  // closing it is a server change (an "unanswered" precondition) and out of scope here. What this does to keep the window small:
  // the PUT goes out immediately after the GET's answer, with nothing awaited in between, and both buttons are disabled (and
  // `inFlight` set) for the whole round trip, so one tap cannot become two saves.
  const confirm = async () => {
    if (inFlight.current || busy || !settingsLoaded) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await api.get(`/children/${childId}/review/${card.night_date}`);
      const body = confirmWakeBody(data, tz, card.wake_at);
      if (!body) { open(); return; }
      await api.put(`/children/${childId}/review/${card.night_date}`, body);
      try {
        setCard(await loadPending());
      } catch {
        setCard({ state: 'done', night_date: card.night_date, true_wake_at: data.computed.wake_at, nobody_in_bed: false });
      }
    } catch (e) {
      setError(e?.message || 'Could not save');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (card.state === 'done') {
    // `card.nobody_in_bed` comes from reviewCardState, NOT the raw review row — that route already
    // returns a real boolean (unlike GET /review's raw 0/1 column), so no truthiness cast is needed
    // here the way NightReview.jsx's seed needs one.
    //
    // The receipt reads back ONLY what the person answered, so it takes the raw `true_*` times and not the
    // resolved `onset_at`/`wake_at` (the stored detector's where they gave none). Those two fields are still
    // in the response for older clients; this one no longer reads them (2026-10-27, the one-question review).
    return (
      <ReviewReceipt
        onsetAt={card.true_onset_at}
        wakeAt={card.true_wake_at}
        inBedAt={card.true_in_bed_at}
        nobodyInBed={card.nobody_in_bed}
        fmtTime={fmtTime}
        onOpen={open}
        embedded
      />
    );
  }

  // A night the app found no wake for has no time to confirm: one button into the screen, which opens at its time field. The same
  // goes when /settings FAILED to load: the time cannot be read in the real zone, so no time is shown and nothing here can save one;
  // the screen explains the state (and still offers "No one was in the bed"). While settings are merely LOADING the question is just
  // not drawn yet, and arrives a moment later.
  const hasWake = Boolean(card.wake_at) && !settingsFailed;
  return (
    <div className="night__review">
      {/* A 44px hit area around a 16px icon, top right of the question, where the old card kept it. */}
      <button type="button" className="night__review-dismiss" onClick={dismiss} aria-label="Dismiss">
        <X size={16} aria-hidden="true" />
      </button>
      {hasWake ? (
        <>
          {settingsLoaded && <div className="night__review-q">Up at {fmtTime(card.wake_at)}. Is that right?</div>}
          <div className="night__review-actions">
            <button type="button" className="btn night__review-yes" disabled={busy || !settingsLoaded} onClick={confirm}>
              {busy ? 'Saving…' : 'That’s right'}
            </button>
            <button type="button" className="btn night__review-no" disabled={busy || !settingsLoaded} onClick={open}>
              Not quite
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="night__review-q">Was last night right? Tap to check the times.</div>
          <div className="night__review-actions">
            <button type="button" className="btn night__review-no" onClick={open}>Check the times</button>
          </div>
        </>
      )}
      {error && <div className="night__review-err" role="alert">{error}</div>}
    </div>
  );
}
