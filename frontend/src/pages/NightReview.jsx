import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, X, HelpCircle, Moon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';

// Recording what actually happened last night, from the person who was there.
//
// Every sleep change so far has been judged against a recollection the next morning — "around 6am".
// That was fine while the errors were hours. It stopped being fine when they reached ~10 minutes,
// because the error became smaller than the measurement; and the same handful of nights was used to
// design a change AND to validate it, so nothing was ever held out. This screen is the fix: precise,
// dated, captured while it is fresh, and never rewritten afterwards.
//
// Two things are collected, and they answer different questions. The TIMES give a scored ground-truth
// set, and are also what the child's card then displays. The per-event VERDICTS give labelled frames:
// 62% of recorded bed transitions are physically impossible on sequence alone, and knowing WHICH of a
// contradictory pair is wrong needs a person to look at the picture.
//
// ⚠️ Times are typed as local wall-clock and sent AS TYPED. The server resolves them against the app's
// configured timezone — see toLocalHhmm below for why that direction is deliberate.

const VERDICTS = [
  { key: 'correct', label: 'Yes', Icon: Check },
  { key: 'wrong', label: 'No', Icon: X },
  { key: 'unclear', label: "Can't tell", Icon: HelpCircle },
];

// UTC 'YYYY-MM-DD HH:MM:SS' -> the 'HH:MM' shown in the app's configured timezone — the same zone the
// sleep card renders in, so the review and the thing it is correcting always agree.
//
// The reverse direction is deliberately NOT done here. The server resolves what was typed against the
// app timezone and the night's date, because that is where the timezone setting lives and where the
// DST-safe conversion already exists and is tested. Doing it in the browser would use the phone's zone
// instead, so a review typed while travelling would disagree with the card it was correcting.
function toLocalHhmm(utc, tz) {
  if (!utc) return '';
  const d = new Date(`${utc.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(d);
}

export default function NightReview() {
  const { id, date } = useParams();
  const navigate = useNavigate();
  const { kids } = useCameras();
  const { settings } = useSettings();
  const tz = settings?.timezone;
  const kid = kids.find((k) => k.id === id);

  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [onset, setOnset] = useState('');
  const [wake, setWake] = useState('');
  const [note, setNote] = useState('');
  const [verdicts, setVerdicts] = useState({});
  // The recorded events named as the bedtime and the morning departure, if any were picked.
  const [onsetFrame, setOnsetFrame] = useState(null);
  const [wakeFrame, setWakeFrame] = useState(null);
  // Has the person actually touched the form? Nothing may overwrite their typing once they have.
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // ⚠️ FETCH ON [id, date] ONLY. `tz` must NOT be in here.
  //
  // SettingsContext starts at its defaults (timezone 'UTC') and replaces them when /settings resolves,
  // so `tz` CHANGES a moment after the app boots. With `tz` in these dependencies the effect re-ran,
  // re-fetched, and re-seeded the inputs — silently discarding whatever had been typed in between. The
  // owner corrected a wake to 05:52, watched it save as 08:29, and had no way of knowing why: the form
  // had quietly reset itself back to the server's value under their hands.
  useEffect(() => {
    let live = true;
    api.get(`/children/${id}/review/${date}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => live && setError(e.message || 'Could not load that night'));
    return () => { live = false; };
  }, [id, date]);

  // Seeding the form is a SEPARATE concern from fetching it, and it stops the moment the person types.
  // It still depends on `tz` because the times have to be shown in the app's zone, not the browser's —
  // which is exactly why re-running it had to stop clobbering their input rather than simply not run.
  useEffect(() => {
    if (!data || touched) return;
    setOnset(toLocalHhmm(data.review?.true_onset_at || data.computed?.onset_at, tz));
    setWake(toLocalHhmm(data.review?.true_wake_at || data.computed?.wake_at, tz));
    setNote(data.review?.note || '');
    setVerdicts(Object.fromEntries((data.transitions || []).filter((t) => t.verdict).map((t) => [t.id, t.verdict])));
    // A night already answered opens straight into its recorded values, so coming back to change
    // something does not make you confirm from scratch.
    setOnsetFrame(data.review?.true_onset_transition_id ?? null);
    setWakeFrame(data.review?.true_wake_transition_id ?? null);
    setEditing(Boolean(data.review?.true_onset_at || data.review?.true_wake_at));
  }, [data, tz, touched]);

  const fmtEvent = useMemo(() => (t) => toLocalHhmm(t.created_at, tz), [tz]);

  // `withTimes` false saves only the verdicts and leaves any recorded times alone.
  const save = async (withTimes, onsetHm = onset, wakeHm = wake) => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/children/${id}/review/${date}`, {
        true_onset_local: withTimes ? (onsetHm || null) : undefined,
        true_wake_local: withTimes ? (wakeHm || null) : undefined,
        // A named frame wins over a typed time on the server — it is second-accurate rather than
        // rounded from memory, and it records which picture means "they got up". Editing a time by
        // hand clears the id, so exactly one of the two is ever the answer.
        true_onset_transition_id: withTimes ? onsetFrame : undefined,
        true_wake_transition_id: withTimes ? wakeFrame : undefined,
        note: note.trim() || null,
        // ⚠️ WHAT WE SHOWED THIS PERSON, sent back so the server records it beside their answer. The
        // server deliberately does not recompute it: a night's answer drifts while the page is open
        // (05:51 at 08:16 → 08:31 at 09:50), so recomputing at save time filed a confirmation as a
        // disagreement. Omitting these is just as bad and is what actually shipped — every stored
        // review then read "the app had no opinion", which was false for every one of them.
        computed_onset_at: data?.computed?.onset_at ?? null,
        computed_wake_at: data?.computed?.wake_at ?? null,
        verdicts,
      });
      navigate(`/children/${id}`);
    } catch (e) {
      setError(e.message || 'Could not save');
      setBusy(false);
    }
  };

  const back = { to: `/children/${id}`, label: kid?.name || 'Child' };
  if (error && !data) {
    return (
      <>
        <AppHeader title="Was this right?" back={back} />
        <main className="app-main"><div className="empty-state">{error}</div></main>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <AppHeader title="Was this right?" back={back} />
        <main className="app-main"><div className="empty-state">Loading…</div></main>
      </>
    );
  }

  const transitions = data.transitions || [];
  const shownOnset = toLocalHhmm(data.computed?.onset_at, tz);
  const shownWake = toLocalHhmm(data.computed?.wake_at, tz);
  const hasOpinion = Boolean(shownOnset || shownWake);

  return (
    <>
      <AppHeader title="Was this right?" back={back} />
      <main className="app-main">
        <div className="card">
          <div className="card-title">What we recorded</div>

          {/* Confirm-or-correct, deliberately NOT a pre-filled form you can save by reflex. A pre-filled
              form puts the app's own answer one tap from becoming "ground truth" — and that answer is
              sometimes badly wrong (a drifted wake of 08:29 against a real 06:00). Blessing it by
              accident poisons the very data this screen exists to collect, and on first real use that
              is exactly what happened. */}
          {!editing && (
            <>
              {hasOpinion ? (
                <div className="review-shown">
                  <div><span className="review-shown__label">Fell asleep</span><strong>{shownOnset || '—'}</strong></div>
                  <div><span className="review-shown__label">Got up for the day</span><strong>{shownWake || '—'}</strong></div>
                </div>
              ) : (
                <div className="camera-tile__sub">
                  We didn’t work out any times for this night. If you know them, add them — a night we
                  saw nothing on is the most useful one of all to have on record.
                </div>
              )}
              <div className="review-actions">
                {hasOpinion && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => save(true, shownOnset, shownWake)}
                  >
                    {busy ? 'Saving…' : 'That’s right'}
                  </button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>
                  {hasOpinion ? 'Not quite…' : 'Add the times'}
                </button>
              </div>
            </>
          )}

          {editing && (
            <>
              <div className="camera-tile__sub">
                {hasOpinion && `We said ${shownOnset || '—'} to ${shownWake || '—'}. `}
                Put in what actually happened — your times are what {kid?.name || 'their'}’s card will show.
                {(onsetFrame || wakeFrame) && ' Times you picked from a frame are exact to the second.'}
              </div>
              <label className="field">
                <span className="field__label">Fell asleep</span>
                <input type="time" value={onset} onChange={(e) => { setTouched(true); setOnsetFrame(null); setOnset(e.target.value); }} />
              </label>
              <label className="field">
                <span className="field__label">Got up for the day</span>
                <input type="time" value={wake} onChange={(e) => { setTouched(true); setWakeFrame(null); setWake(e.target.value); }} />
              </label>
              <label className="field">
                <span className="field__label">Anything else worth noting</span>
                <input
                  type="text"
                  value={note}
                  placeholder="e.g. put back on the bed to get dressed at 5:45"
                  onChange={(e) => { setTouched(true); setNote(e.target.value); }}
                />
              </label>
            </>
          )}
        </div>

        {/* Collapsed by default, and that is the point. A night carries 20-35 recorded transitions —
            Raffa's 2026-08-29 had 31 — and opening the screen straight into a wall of frames buries
            the two times that actually matter. The owner's words on first use: "it's also flooded with
            in and out of bed". Confirming the night is the job; judging frames is optional extra
            credit for when there is time. */}
        <div className="card tight">
          {transitions.length === 0 ? (
            <>
              <div className="card-title">Events we recorded</div>
              <div className="camera-tile__sub">
                Nothing was recorded for this night — so there is nothing here to check.
              </div>
            </>
          ) : (
            <button
              type="button"
              className="review-events__toggle"
              aria-expanded={showEvents}
              onClick={() => setShowEvents((v) => !v)}
            >
              <span className="review-events__toggle-text">
                <span className="card-title">
                  {showEvents ? 'Hide the recorded events' : `Check the ${transitions.length} recorded events`}
                </span>
                <span className="camera-tile__sub">
                  Optional — it helps us work out which ones we got wrong
                </span>
              </span>
              <span className="review-card__go" aria-hidden="true">{showEvents ? '⌃' : '›'}</span>
            </button>
          )}
          {showEvents && transitions.map((t) => (
            <div key={t.id} className="review-event">
              {t.snapshot ? (
                <img
                  className="review-event__frame"
                  src={api.url(`/cameras/bed-transitions/${t.id}/snapshot`)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div className="review-event__frame review-event__frame--none">No frame</div>
              )}
              <div className="review-event__body">
                <div className="review-event__when">
                  {fmtEvent(t)} — we said they{' '}
                  <strong>{t.type === 'into_bed' ? 'got into bed' : 'got out of bed'}</strong>
                </div>
                {t.camera_name && <div className="camera-tile__sub">{t.camera_name}</div>}
                {/* Naming the moment, which is a DIFFERENT claim from "this event is correct". An exit
                    can be perfectly real and still not be the end of the night — 05:45 was a genuine
                    got-out-of-bed on a morning the child went back and got up again at 06:00. Tying
                    the wake to the "correct" verdict would have ended that night at the wrong one. */}
                <div className="review-event__verdicts">
                  <button
                    type="button"
                    className={`review-chip review-chip--moment${
                      (t.type === 'into_bed' ? onsetFrame : wakeFrame) === t.id ? ' review-chip--on' : ''}`}
                    aria-pressed={(t.type === 'into_bed' ? onsetFrame : wakeFrame) === t.id}
                    onClick={() => {
                      setTouched(true);
                      // Naming a frame IS correcting the night, so open the times for review: the
                      // filled value has to be visible and there has to be something to press. Without
                      // this the screen stayed on "That's right / Not quite" and the pick led nowhere.
                      setEditing(true);
                      const time = fmtEvent(t);
                      if (t.type === 'into_bed') {
                        const on = onsetFrame === t.id;
                        setOnsetFrame(on ? null : t.id);
                        if (!on) setOnset(time);
                      } else {
                        const on = wakeFrame === t.id;
                        setWakeFrame(on ? null : t.id);
                        if (!on) setWake(time);
                      }
                    }}
                  >
                    <Moon size={16} /> {t.type === 'into_bed' ? 'Put down here' : 'Up for the day here'}
                  </button>
                </div>
                <div className="review-event__verdicts">
                  {VERDICTS.map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className={`review-chip${verdicts[t.id] === key ? ' review-chip--on' : ''}`}
                      aria-pressed={verdicts[t.id] === key}
                      // Tapping the chosen verdict again clears it: a mis-tap must be undoable, because
                      // a wrong label is worse than a missing one — everything else gets scored on it.
                      onClick={() => { setTouched(true); setVerdicts((v) => ({ ...v, [t.id]: v[t.id] === key ? null : key })); }}
                    >
                      <Icon size={16} /> {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {editing ? (
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => save(true)}>
            {busy ? 'Saving…' : 'Save review'}
          </button>
        ) : showEvents && transitions.length > 0 && (
          <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => save(false)}>
            {busy ? 'Saving…' : 'Save just the event answers'}
          </button>
        )}
      </main>
    </>
  );
}
