import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, X, HelpCircle, Moon } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import ImagePreviewModal from '../components/ImagePreviewModal.jsx';

// Recording what actually happened last night, from the person who was there.
//
// Every sleep change so far has been judged against a recollection the next morning — "around 6am".
// That was fine while the errors were hours. It stopped being fine when they reached ~10 minutes,
// because the error became smaller than the measurement; and the same handful of nights was used to
// design a change AND to validate it, so nothing was ever held out. This screen is the fix: precise,
// dated, and captured while it is fresh.
//
// ⚠️ NOT immutable, despite what this used to claim (issue #323). The save is an UPSERT
// (lib/sleepReviews.js) and there is no already-reviewed guard, so a person may revise an answer and
// the revision REPLACES the previous one — including its `reviewed_at`. That is almost certainly the
// right design (someone who mis-taps should be able to correct it), but it means the table cannot
// distinguish a first answer from a revised one. ★ That already cost something: the holdout scoring
// read the clustered `reviewed_at` values as evidence the reviews were recorded in one retrospective
// sitting, and the schema does not actually support that conclusion. If an analysis ever needs to
// tell the two apart, the table needs a `first_reviewed_at` or a revision counter — it is not
// recoverable afterwards.
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

// After a "No": WHO it was. Keys must match WRONG_REASONS in backend/src/lib/bedTransitions.js — the
// server refuses anything else. "No" alone lumps a parent leaving after a story, the child rolling
// over and someone walking past into one label, and a rule to tell them apart could not be scored
// against 542 such labels because of exactly that (2026-09-25).
//
// Only on the FULL list's plain "No", deliberately not under the quick check-in or "Still moving?"
// cards: their own buttons already say more than a bare "wrong" ("That was me" answers who by itself,
// and records 'adult' automatically), and they share this screen's one verdict map — a reason picker
// keyed on "wrong" there would also pop up under "No, still in bed", which is a different question.
// For the same reason those events get no picker when they ALSO appear in the full list (hasOwnCard).
const WRONG_REASONS = [
  { key: 'adult', label: 'Me or another adult' },
  { key: 'child_moved', label: 'They moved in bed' },
  { key: 'other', label: 'Someone walking by / nothing' },
];

// Events before this LOCAL hour on the night's own date are grouped as "Before bedtime" and can be
// answered in one tap. A STARTING GUESS, not a measured threshold — it comes from the owner's own
// description of the noise (someone walking across the zone in the early afternoon), not from any
// scored nights. Revisit it once the grouped events have verdicts to measure against.
//
// A fixed clock time, deliberately NOT an offset from the computed bedtime: a badly late computed onset
// (the 4:20am mis-onset case sleepAnalysis.js documents) would put the REAL put-down inside the
// collapsed group, "Put down here" button and all — hiding the one event the person needs to find.
// This cannot move with whatever the algorithm currently believes. It is in the app's configured
// timezone like every other time here, so it means the same thing in any house. ⚠️ KNOWN LIMIT, stated
// in the README rather than left silent: a family whose night genuinely starts before 16:00 still sees
// every event (grouped, nothing answered without a tap), but the one-tap button would mark their real
// put-down "No" — so for them the button is wrong, and the README says not to use it.
const EARLY_CUTOFF_HOUR = 16;
const EARLY_CUTOFF_LABEL = `${String(EARLY_CUTOFF_HOUR).padStart(2, '0')}:00`;

// UTC 'YYYY-MM-DD HH:MM:SS' -> { date: 'YYYY-MM-DD', hour } in the app's timezone. Via Intl so DST is
// the platform's problem, not ours.
function localDateHour(utc, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date(`${utc.replace(' ', 'T')}Z`));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

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
  // Separate from `touched`, deliberately: a verdict tap and an onset/wake edit are unrelated, but a
  // shared flag would make them fate-share. Found in adversarial review, 2026-09-13: the new "Quick
  // check-in?" prompt is often the very FIRST tap on this page — far more likely than the old, opt-in
  // collapsed event list — and if that tap were the thing that set `touched`, a `/settings` timezone
  // resolving a moment later (SettingsContext starts at UTC, see the fetch effect's own comment) would
  // never re-seed `onset`/`wake` into the RIGHT zone; the exact bug that comment already describes,
  // just reached from a new direction. Verdicts still need their OWN protection from the same race
  // (the seeding effect below also resets `verdicts`), which is what this flag is for.
  const [verdictsTouched, setVerdictsTouched] = useState(false);
  // id -> WRONG_REASONS key, or null. Rides on `verdictsTouched`, not a flag of its own: a reason is
  // part of the same answer as its "No", and must survive the same late-timezone reseed a verdict does.
  const [reasons, setReasons] = useState({});
  // The "Before bedtime" group inside the full event list starts collapsed, like the list itself.
  const [showEarly, setShowEarly] = useState(false);
  // Has "Before bedtime" been opened at least once this sitting? The one-tap "None of these" stays
  // disabled until it has. Without this it could mark every unanswered event in the group "No" without
  // anyone having looked — and a genuine nap sitting in there, unanswered, would be written into the
  // ground-truth labels as a false detector event (found in adversarial code review, 2026-09-25).
  // Deliberately NOT reset when the group is closed again: the point is one glance at what is in there,
  // not keeping it open while tapping.
  const [earlyOpened, setEarlyOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The transition whose snapshot is currently open full-size, or null. A transition row (id, type,
  // created_at, camera_name) carries everything ImagePreviewModal's title/meta need — no reason to
  // shadow those fields into a separate shape.
  const [preview, setPreview] = useState(null);

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
    if (!data) return;
    if (!touched) {
      setOnset(toLocalHhmm(data.review?.true_onset_at || data.computed?.onset_at, tz));
      setWake(toLocalHhmm(data.review?.true_wake_at || data.computed?.wake_at, tz));
      setNote(data.review?.note || '');
      // A night already answered opens straight into its recorded values, so coming back to change
      // something does not make you confirm from scratch.
      setOnsetFrame(data.review?.true_onset_transition_id ?? null);
      setWakeFrame(data.review?.true_wake_transition_id ?? null);
      setEditing(Boolean(data.review?.true_onset_at || data.review?.true_wake_at));
    }
    // ⚠️ Reasons are seeded INSIDE this guard, not in an effect of their own. This file has been bitten
    // twice by a tz arriving late and re-running a seed over someone's answers (see `touched` and
    // `verdictsTouched` above); an unguarded reasons seed would be the third.
    if (!verdictsTouched) {
      setVerdicts(Object.fromEntries((data.transitions || []).filter((t) => t.verdict).map((t) => [t.id, t.verdict])));
      setReasons(Object.fromEntries((data.transitions || []).filter((t) => t.wrong_reason).map((t) => [t.id, t.wrong_reason])));
    }
  }, [data, tz, touched, verdictsTouched]);

  // Every verdict button on the screen goes through here, because all three places share one map.
  // Tapping the chosen answer again clears it: a mis-tap must be undoable, since a wrong label is worse
  // than a missing one — everything else gets scored on it.
  //
  // Leaving "No" also drops that event's reason, to null rather than deleting the key: null is SENT,
  // and clears a reason already stored. Deleting would leave a stored "Me or another adult" alive if the
  // person went No -> Yes -> No and saved with no reason picked. (The server also clears a reason
  // whenever a verdict other than 'wrong' is written; this keeps the screen honest before the save.)
  const answer = (id, key) => {
    const next = verdicts[id] === key ? null : key;
    setVerdictsTouched(true);
    setVerdicts((v) => ({ ...v, [id]: next }));
    if (next !== 'wrong' && reasons[id] != null) setReasons((r) => ({ ...r, [id]: null }));
  };
  const answerReason = (id, key) => {
    setVerdictsTouched(true);
    setReasons((r) => ({ ...r, [id]: r[id] === key ? null : key }));
  };

  const fmtEvent = useMemo(() => (t) => toLocalHhmm(t.created_at, tz), [tz]);

  // The enlarged view's title/meta. A plain camera name as the title (Modal always shows one), the
  // time + which kind of event as the meta line underneath the photo — the same two facts the
  // thumbnail's own row already states, just readable at a glance once the image itself is legible.
  const previewTitle = (t) => t?.camera_name || 'Snapshot';
  const previewMeta = (t) => (t ? `${fmtEvent(t)} — ${t.type === 'into_bed' ? 'got into bed' : 'got out of bed'}` : '');

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
        // Beside the verdicts they belong to. The server keeps a reason only where the verdict after
        // this save is 'wrong', and drops (not refuses) the rest.
        reasons,
      });
      // Back to the night just corrected, not the child page. Correcting a backlog of older nights
      // means saving and immediately wanting the next one, and landing on the child screen cost a
      // tab-hop plus a date re-pick every single time.
      navigate(`/children/${id}/sleep?date=${date}&saved=1`);
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

  // An out_of_bed the server flagged as immediately following an into_bed (quick_reversal_of names
  // that into_bed's id) — measured 2026-09-13 to be mostly a parent's presence read as a child's exit,
  // not classifier noise or a real return trip. Surfaced on its own, NOT behind "Check the recorded
  // events" below: that section is deliberately collapsed by default (the owner's own words: "it's
  // also flooded with in and out of bed"), so relying on it here would mean this specific, high-value
  // question is the one thing MOST likely to go unnoticed and unanswered — the exact problem this
  // exists to fix (1 of 86 such pairs had ever been verdicted before this).
  const quickReversals = transitions
    .filter((t) => t.quick_reversal_of != null)
    .map((oob) => ({ oob, ib: transitions.find((t) => t.id === oob.quick_reversal_of) }))
    .filter((p) => p.ib);
  // Quick reversals have the better-evidenced, sharper question. Keep both backend facts,
  // but ask only once per event; both cards write into the same shared verdict.
  const lingeringOnly = transitions.filter(
    (t) => t.lingering_motion_minutes != null && t.quick_reversal_of == null
  );
  // A transition asked about on its OWN card above ("Quick check-in?" or "Still moving?"). Such an
  // event still appears in the full list below, but two things the full list does must leave it alone:
  // the one-tap "None of these" (its own card asks a sharper question), and the "What was it?"
  // follow-up to a "No" (its own card's "No" already says what it was — "That was me" records
  // reason 'adult' by itself — so a second picker under it could contradict the answer given above).
  // One predicate for both, so the two exclusions cannot drift apart.
  const hasOwnCard = (t) => t.quick_reversal_of != null || t.lingering_motion_minutes != null;

  // "Before bedtime": the early-afternoon events a walk across the zone produces (see
  // EARLY_CUTOFF_HOUR for why a fixed clock hour). Only once the night has SOME bedtime anchor — a
  // computed put-down, a frame the person named, or a computed onset. With none of those there is no
  // night to be "before", so the list renders flat exactly as it always did.
  // `review.true_onset_at` covers a correction the person TYPED, with no frame named: it is as much a
  // bedtime as a named frame is, and without it a night the detector missed but a person fixed would
  // lose its grouping on the next visit (found in adversarial code review, 2026-09-25).
  const hasBedtime = Boolean(
    data.computed?.in_bed_at || onsetFrame || data.computed?.onset_at || data.review?.true_onset_at
  );
  const isEarly = (t) => {
    const { date: localDate, hour } = localDateHour(t.created_at, tz);
    return localDate === date && hour < EARLY_CUTOFF_HOUR;
  };
  const early = hasBedtime ? transitions.filter(isEarly) : [];
  const later = hasBedtime ? transitions.filter((t) => !isEarly(t)) : transitions;
  // What "None of these were a bedtime event" may pre-fill. NOT a quick check-in or "Still moving?"
  // event — those have their own card and their own sharper question. NOT anything already answered,
  // either here or earlier in this sitting (checked again inside the updater, against the live map):
  // silently overwriting a "Yes" or "Can't tell" is how a genuine nap turns into a false label.
  const bulkable = early.filter((t) => !hasOwnCard(t));
  const bulkLeft = bulkable.filter((t) => verdicts[t.id] == null).length;
  const markEarlyWrong = () => {
    setVerdictsTouched(true);
    setVerdicts((v) => {
      const next = { ...v };
      for (const t of bulkable) if (next[t.id] == null) next[t.id] = 'wrong';
      return next;
    });
  };

  // One row of the full event list — used both inside "Before bedtime" and for everything after it,
  // so a grouped event is answered with exactly the same controls as any other.
  const renderEvent = (t) => (
    <div key={t.id} className="review-event">
      {t.snapshot ? (
        <button
          type="button"
          className="review-event__frame-btn"
          aria-label="Enlarge photo"
          onClick={() => setPreview(t)}
        >
          <img
            className="review-event__frame"
            src={api.url(`/cameras/bed-transitions/${t.id}/snapshot`)}
            alt=""
            loading="lazy"
          />
        </button>
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
              onClick={() => answer(t.id, key)}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
        </div>
        {/* The follow-up to "No" — see WRONG_REASONS for why only here, and hasOwnCard for why not on
            an event that also has a card of its own. Optional: a "No" with no reason is still a
            complete answer, exactly as before this existed. */}
        {verdicts[t.id] === 'wrong' && !hasOwnCard(t) && (
          <div className="review-event__reasons" role="group" aria-label="What was it?">
            <span className="review-event__reasons-label">What was it?</span>
            {WRONG_REASONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`review-chip${reasons[t.id] === key ? ' review-chip--on' : ''}`}
                aria-pressed={reasons[t.id] === key}
                onClick={() => answerReason(t.id, key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

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

        {/* NOT collapsed, deliberately unlike the full event list below — see quickReversals' own
            comment for why relying on that collapse here would defeat the point. Kept neutral rather
            than suggesting "this was probably you": the whole reason this exists is to collect an
            honest label, and leading the answer would poison exactly the ground truth it's after. */}
        {quickReversals.map(({ oob, ib }) => (
          <div className="card" key={oob.id}>
            <div className="card-title">Quick check-in?</div>
            <div className="review-event">
              {oob.snapshot ? (
                <button
                  type="button"
                  className="review-event__frame-btn"
                  aria-label="Enlarge photo"
                  onClick={() => setPreview(oob)}
                >
                  <img
                    className="review-event__frame"
                    src={api.url(`/cameras/bed-transitions/${oob.id}/snapshot`)}
                    alt=""
                    loading="lazy"
                  />
                </button>
              ) : (
                <div className="review-event__frame review-event__frame--none">No frame</div>
              )}
              <div className="review-event__body">
                <div className="review-event__when">
                  Got into bed at {fmtEvent(ib)}, then got out of bed again {oob.quick_reversal_gap_s}s
                  later — what actually happened?
                </div>
                {oob.camera_name && <div className="camera-tile__sub">{oob.camera_name}</div>}
                <div className="review-event__verdicts">
                  {[
                    { key: 'wrong', label: 'That was me', Icon: X },
                    { key: 'correct', label: 'They got up', Icon: Check },
                    { key: 'unclear', label: 'Not sure', Icon: HelpCircle },
                  ].map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className={`review-chip${verdicts[oob.id] === key ? ' review-chip--on' : ''}`}
                      aria-pressed={verdicts[oob.id] === key}
                      onClick={() => {
                        answer(oob.id, key);
                        // "That was me" IS the reason, in the button's own words — record it as 'adult'
                        // with no extra question, so these answers land in the same "who was it" data as
                        // the full list's. Only when this tap SETS 'wrong': tapping it again clears the
                        // verdict, and answer() then clears the reason with it.
                        if (key === 'wrong' && verdicts[oob.id] !== 'wrong') {
                          setReasons((r) => ({ ...r, [oob.id]: 'adult' }));
                        }
                      }}
                    >
                      <Icon size={16} /> {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}

        {/* Evidence can precede this run's newest (displayed) exit. State a separate-minute
            count, never a continuous duration or a gap measured from the displayed timestamp. */}
        {lingeringOnly.map((t) => (
          <div className="card" key={t.id}>
            <div className="card-title">Still moving?</div>
            <div className="review-event">
              {t.snapshot ? (
                <button
                  type="button"
                  className="review-event__frame-btn"
                  aria-label="Enlarge photo"
                  onClick={() => setPreview(t)}
                >
                  <img
                    className="review-event__frame"
                    src={api.url(`/cameras/bed-transitions/${t.id}/snapshot`)}
                    alt=""
                    loading="lazy"
                  />
                </button>
              ) : (
                <div className="review-event__frame review-event__frame--none">No frame</div>
              )}
              <div className="review-event__body">
                <div className="review-event__when">
                  Recorded as out of bed at {fmtEvent(t)} — the bed also showed movement in{' '}
                  {t.lingering_motion_minutes} separate minutes with no return logged in between. What actually
                  happened?
                </div>
                {t.camera_name && <div className="camera-tile__sub">{t.camera_name}</div>}
                <div className="review-event__verdicts">
                  {[
                    { key: 'wrong', label: 'No, still in bed', Icon: X },
                    { key: 'correct', label: 'Yes, they got up', Icon: Check },
                    { key: 'unclear', label: 'Not sure', Icon: HelpCircle },
                  ].map(({ key, label, Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className={`review-chip${verdicts[t.id] === key ? ' review-chip--on' : ''}`}
                      aria-pressed={verdicts[t.id] === key}
                      onClick={() => answer(t.id, key)}
                    >
                      <Icon size={16} /> {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}

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
          {/* Grouped at the TOP of the open list, itself collapsed, with a one-tap answer for the lot —
              the owner's complaint was a 2pm walk across the zone flooding the list. The group is a
              shortcut, never a lock: open it and every event has its own chips, same as below. */}
          {showEvents && early.length > 0 && (
            <div className="review-early">
              <button
                type="button"
                className="review-events__toggle"
                aria-expanded={showEarly}
                onClick={() => { setShowEarly((v) => !v); setEarlyOpened(true); }}
              >
                <span className="review-events__toggle-text">
                  <span className="card-title">Before bedtime ({early.length})</span>
                  <span className="camera-tile__sub">
                    Recorded before {EARLY_CUTOFF_LABEL} — usually someone passing through, not bedtime
                  </span>
                </span>
                <span className="review-card__go" aria-hidden="true">{showEarly ? '⌃' : '›'}</span>
              </button>
              {/* Says "not a bedtime event", deliberately NOT "none of these happened": a nap is a real
                  event in this window (sleepAnalysis.js carries a nap guard for exactly that), and this
                  must not claim otherwise on the person's behalf. */}
              <div className="review-early__bulk">
                {/* Disabled until the group has been opened once — see `earlyOpened`. Not hidden: the
                    button being visible is what tells someone the shortcut exists at all. */}
                <button
                  type="button"
                  className="review-chip"
                  disabled={!earlyOpened || bulkLeft === 0}
                  onClick={markEarlyWrong}
                >
                  <X size={16} /> None of these were a bedtime event
                </button>
                <span className="camera-tile__sub">
                  {earlyOpened
                    ? 'Marks the unanswered ones “No”. A nap? Answer that one yourself first.'
                    : 'Open this to check first — a nap in here is a real event, not a “No”.'}
                </span>
              </div>
              {showEarly && early.map(renderEvent)}
            </div>
          )}
          {showEvents && later.map(renderEvent)}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {editing ? (
          <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => save(true)}>
            {busy ? 'Saving…' : 'Save review'}
          </button>
        ) : (showEvents || quickReversals.length > 0 || lingeringOnly.length > 0) && transitions.length > 0 && (
          <button type="button" className="btn btn-secondary btn-block" disabled={busy} onClick={() => save(false)}>
            {busy ? 'Saving…' : 'Save just the event answers'}
          </button>
        )}
      </main>
      {preview && (
        <ImagePreviewModal
          title={previewTitle(preview)}
          imagePath={`/cameras/bed-transitions/${preview.id}/snapshot`}
          meta={previewMeta(preview)}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
