import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
// `Baby` on "Put down here" is a reuse, not a new icon (design-language.md §4.1 keeps the set small):
// the child going into bed, beside `Moon` for the child falling asleep.
import { Check, X, HelpCircle, Moon, Baby } from 'lucide-react';
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
  // `loaded`: the server's settings have arrived, so `tz` is the app's REAL zone, not SettingsContext's
  // placeholder 'UTC'. Two things wait for it: "Before bedtime" (see `groupEarly`) and every control that
  // can send a time (see `timesReady`).
  const { settings, loaded: settingsLoaded } = useSettings();
  const tz = settings?.timezone;
  // ⚠️ NOTHING THAT CAN SEND A TIME WORKS UNTIL THE REAL TIMEZONE HAS ARRIVED (fix round 2, 2026-09-30,
  // Codex P1, verified). "Fell asleep" and "Got up for the day" are UTC instants shown in `tz`, and until
  // /settings resolves `tz` is the placeholder 'UTC', so a Sydney night of 19:13 / 06:37 reads 09:13 / 20:37.
  // The seed puts them into the real zone when it arrives, but only while nothing is `touched`, and a chip tap
  // or a keystroke in that moment set it: the two fields stayed in the placeholder zone and Save sent them (a
  // wake before the asleep time, asleep 0). "That's right" sent them at once. So every control that can set
  // `touched` or send a time waits for this: the four fields of the edit card (the note too, since typing it
  // sets `touched`), the moment chips, "Not quite…" / "Add the times", "That's right" and "Save review", and
  // `save()` itself refuses times without it. One gate over the whole time form rather than a touched flag
  // per field, because a per-field flag still let a pressed-on-arrival chip keep a placeholder-zone time when
  // un-pressed (`tapMoment` keeps asleep/wake as they were), and still let Save send the untouched fields
  // before the zone arrived. Gated on `loaded`, NOT `tz !== 'UTC'`, for the reason `groupEarly` gives.
  // Scoped like `groupEarly`: verdicts, "No one was in the bed" and "Save just the event answers" carry no
  // time and stay usable, which is what matters if /settings FAILED and `loaded` never arrives this visit
  // (the page then says why the times can't be changed). ⚠️ A new control that sets `touched` or sends a time
  // must be gated on this too.
  const timesReady = settingsLoaded;
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
  // "In bed": when they were PUT DOWN, which is not when they fell asleep (2026-09-30). On the night of
  // 2026-09-29 the detector had a child asleep at 19:13, which was right; they had been put down at 18:49 for
  // a bedtime story, and the only frame button, "Put down here", wrote 18:49 into "Fell asleep". So the put-
  // down now has its own time and its own frame, and "Asleep here" is the button that sets the asleep time.
  //
  // ⚠️ Seeded ONLY from what the parent already said (`review.true_in_bed_at`), never from the detector's
  // `computed.in_bed_at`, and SENT only once touched (plan review R3). Seeding it from the detector would
  // store the detector's put-down as the parent's on every save, and then the card would keep showing a
  // put-down nobody confirmed, beside an asleep time they did. Its own touched flag for the same two
  // reasons as `nobodyTouched`: it must keep re-seeding into the real timezone until the person uses it,
  // and a second phone that never touched it must not blank the one the first phone saved.
  const [inBed, setInBed] = useState('');
  const [inBedFrame, setInBedFrame] = useState(null);
  const [inBedTouched, setInBedTouched] = useState(false);
  // What each moment field (inBed / onset / wake) held just before a frame chip filled it, so tapping the
  // SAME chip again puts it back. A second tap is "not this one", and it used to leave the frame's time in
  // the field and save it anyway, as a typed time with no frame: pick "Put down here", un-pick it, save,
  // and an in-bed time was still recorded (fix round, 2026-09-30). See `tapMoment`.
  const [beforePick, setBeforePick] = useState({});
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
  // "No one was in the bed" for the whole night — an overlay flag, not a time. Seeded from
  // `data.review.nobody_in_bed`, which GET /review returns as the RAW stored 0/1 (same column shape as
  // `dismissed`), never a real boolean — so the seed below reads truthiness, not `=== true`. A strict
  // equality check would silently treat a genuine `1` as "not flagged" and every reopened flagged night
  // would render as if nobody had ever answered it.
  const [nobody, setNobody] = useState(false);
  // Its OWN guard, deliberately not folded into `touched` (plan review R5). `touched` exists so a tap
  // stops the onset/wake inputs re-seeding once the real timezone arrives (see the seeding effect's own
  // comment) — but the flag carries no times and no timezone-dependent value at all, so tying it to the
  // same flag would only ever cost something: toggling the flag would freeze the (still hidden, still
  // stale) time inputs out of ever re-seeding into the right zone once they became visible again via
  // "Someone was in the bed". Kept in the same seeding effect as `touched`/`verdictsTouched` (same
  // pattern that already protects those two from a late-arriving `tz`), just gated on its own flag.
  const [nobodyTouched, setNobodyTouched] = useState(false);
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
      // An in-bed-only answer is an answer too: reopening it must land on the times, not on "That's right".
      setEditing(Boolean(data.review?.true_onset_at || data.review?.true_wake_at || data.review?.true_in_bed_at));
    }
    if (!inBedTouched) {
      setInBed(toLocalHhmm(data.review?.true_in_bed_at, tz));
      setInBedFrame(data.review?.true_in_bed_transition_id ?? null);
    }
    // ⚠️ Reasons are seeded INSIDE this guard, not in an effect of their own. This file has been bitten
    // twice by a tz arriving late and re-running a seed over someone's answers (see `touched` and
    // `verdictsTouched` above); an unguarded reasons seed would be the third.
    if (!verdictsTouched) {
      setVerdicts(Object.fromEntries((data.transitions || []).filter((t) => t.verdict).map((t) => [t.id, t.verdict])));
      setReasons(Object.fromEntries((data.transitions || []).filter((t) => t.wrong_reason).map((t) => [t.id, t.wrong_reason])));
    }
    // Reopening a flagged night must seed straight into "You said no one was in the bed", not fall
    // through to the confirm block offering "That's right" for the detector's OWN times (plan review
    // R5) — `editing` above is seeded from `review.true_onset_at`/`true_wake_at`, which a flag always
    // clears, so without this the screen would silently misrepresent what the parent actually said.
    if (!nobodyTouched) setNobody(!!data.review?.nobody_in_bed);
  }, [data, tz, touched, verdictsTouched, nobodyTouched, inBedTouched]);

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

  // One tap on a moment chip ("Put down here", "Asleep here", "Up for the day here").
  //
  // Picking a frame fills that moment's field with the frame's time and names the frame (it is sent too,
  // and wins on the server: second-accurate). It also opens the edit card, because naming a frame IS
  // correcting the night: without that the screen stayed on "That's right / Not quite" and the pick led
  // nowhere. `touched` is set for every moment: it is what stops a late-arriving timezone re-running the
  // seed and closing the card this tap just opened.
  //
  // Tapping the SAME chip again undoes the pick: the field goes back to exactly what it held before
  // (`beforePick`), including, for "In bed", whether there was anything to send at all. So pick + un-pick
  // + save sends nothing about the put-down. A chip that was already pressed when the page opened (a frame
  // on record from an earlier save) has no "before" on this screen:
  //   - for "In bed" the un-press removes the answer (the field empties, and the removal is sent only if a
  //     put-down is actually on record). In bed is optional, so "not this frame, and no other" is empty;
  //   - for asleep and wake the time is kept and only the frame is dropped, as it always was. Those two
  //     fields are always sent, and emptying one would silently delete an answer on record.
  const tapMoment = (key, t) => {
    // The chips are disabled until then; this is the same rule for any other way in (see `timesReady`).
    if (!timesReady) return;
    const m = {
      inBed: { value: inBed, setValue: setInBed, frame: inBedFrame, setFrame: setInBedFrame },
      onset: { value: onset, setValue: setOnset, frame: onsetFrame, setFrame: setOnsetFrame },
      wake: { value: wake, setValue: setWake, frame: wakeFrame, setFrame: setWakeFrame },
    }[key];
    setTouched(true);
    setEditing(true);
    if (m.frame !== t.id) {
      setBeforePick((b) => ({ ...b, [key]: { value: m.value, frame: m.frame, inBedTouched } }));
      m.setFrame(t.id);
      m.setValue(fmtEvent(t));
      if (key === 'inBed') setInBedTouched(true);
      return;
    }
    const prev = beforePick[key];
    setBeforePick((b) => ({ ...b, [key]: undefined }));
    if (prev) {
      m.setValue(prev.value);
      m.setFrame(prev.frame);
      if (key === 'inBed') setInBedTouched(prev.inBedTouched);
    } else if (key === 'inBed') {
      setInBed('');
      setInBedFrame(null);
      setInBedTouched(Boolean(data?.review?.true_in_bed_at));
    } else {
      m.setFrame(null);
    }
  };

  // The enlarged view's title/meta. A plain camera name as the title (Modal always shows one), the
  // time + which kind of event as the meta line underneath the photo — the same two facts the
  // thumbnail's own row already states, just readable at a glance once the image itself is legible.
  const previewTitle = (t) => t?.camera_name || 'Snapshot';
  const previewMeta = (t) => (t ? `${fmtEvent(t)} — ${t.type === 'into_bed' ? 'got into bed' : 'got out of bed'}` : '');

  // `withTimes` false saves only the verdicts and leaves any recorded times alone.
  const save = async (withTimes, onsetHm = onset, wakeHm = wake) => {
    // Never a time read in the placeholder zone, whichever button asked (see `timesReady`).
    if (withTimes && !timesReady) return;
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
        // Only once the person has touched "In bed" (see `inBedTouched`). Left `undefined` otherwise, which
        // the server reads as "keep what is stored": correcting only the asleep time must store nothing
        // about the put-down, and a second phone must not blank one the first phone saved.
        true_in_bed_local: withTimes && inBedTouched ? (inBed || null) : undefined,
        true_in_bed_transition_id: withTimes && inBedTouched ? inBedFrame : undefined,
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

  // "No one was in the bed" — a one-tap save, deliberately its OWN network call rather than routed
  // through `save()` above. It carries no times at all, by design: the flag and a time are mutually
  // exclusive on the server (a 400, "pick one"), and `save()` defaults times to whatever `onset`/`wake`
  // still hold — which, once this control replaces the time inputs, can be stale (never cleared, just
  // hidden). Sending them alongside the flag would either trip that refusal, or — for the UNDO
  // direction ("Someone was in the bed") — silently attach the detector's guessed times to what is
  // supposed to be a bare "no answer" undo. That matters because undoing with nothing else entered is a
  // real, documented path (README): the detector's night comes back, but nothing typed before the flag
  // was set comes back with it, and this call must not paper over that by inventing an answer.
  // No confirm modal, unlike a destructive action elsewhere in the app — the flag is reversible (see
  // `saveNobody(false)`), and the receipt this lands on is what confirms it, same as "That's right".
  //
  // The note, if any was typed in edit mode, rides along — `saveNightReview`'s `note` handling is
  // completely independent of the flag/time mutual-exclusion logic (checked in sleepReviews.js), so
  // there is no server-side reason to drop it, and the ORIGINAL bug here was that a note typed but not
  // yet saved (e.g. "he was sick, checked on him twice") vanished the moment this button was tapped
  // instead of "Save review" — silently, because this call sent nothing but the flag. Per-transition
  // verdicts/reasons are deliberately NOT included here, unlike the note: unlike a note, which is just
  // a fact about the night, a verdict is a judgement about a SPECIFIC recorded event, and attaching
  // whatever happens to be sitting in that in-memory map to a same one-tap "the whole night was empty"
  // action risks saving half-considered judgements the person never meant to submit yet. They stay
  // reachable afterwards via "Save just the event answers", unaffected by this call either way.
  const saveNobody = async (flag) => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/children/${id}/review/${date}`, { nobody_in_bed: flag, note: note.trim() || null });
      // Only now — confirmed by the server — do we say so. Setting `nobody`/`nobodyTouched` BEFORE this
      // await (as this used to) meant a failed save left the screen claiming the flag was set (or
      // cleared) when the server actually still held the OTHER value — and the only button left then
      // was the one for the OPPOSITE action, applied to a state that was never really reached. Compare
      // `save()` above, which never mutates an answer before its own await for the same reason.
      setNobodyTouched(true);
      setNobody(flag);
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
  // The detector's put-down, shown so the person can see what "in bed" it recorded. Display only: it is
  // never copied into the In bed field (see `inBed`), and "That's right" confirms asleep and wake only.
  const shownInBed = toLocalHhmm(data.computed?.in_bed_at, tz);
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
  // A put-down the person named or typed (`inBedFrame`, `review.true_in_bed_at`) is as much a bedtime as
  // an onset is: "Put down here" set `onsetFrame` before the in-bed split, so without these a night whose
  // only anchor is a picked put-down would stop grouping.
  const hasBedtime = Boolean(
    data.computed?.in_bed_at || onsetFrame || inBedFrame || data.computed?.onset_at || data.review?.true_onset_at
    || data.review?.true_in_bed_at
  );
  const isEarly = (t) => {
    const { date: localDate, hour } = localDateHour(t.created_at, tz);
    return localDate === date && hour < EARLY_CUTOFF_HOUR;
  };
  // ⚠️ ...and only once the app's REAL timezone has arrived. The fourth time a late timezone has bitten
  // this file (see `touched`, `verdictsTouched` and the reasons seed), and the first where the damage is
  // a WRITE the person made rather than a reseed over one: SettingsContext starts at 'UTC' and replaces it
  // when /settings resolves, so for that moment — or for the whole visit, if that request failed — 16:00
  // is judged in the wrong zone. Found in the 0.34.0 release review (Codex, 2026-09-28): a real 19:20
  // Melbourne put-down is 09:20 UTC, so it was grouped as "Before bedtime", its one-tap "None of these"
  // saved it "No", and the answer stayed saved after the real zone arrived. Unlike a reseed, a stored
  // verdict cannot be put right by the zone arriving later, so the group is never offered on a guess.
  // Gated on `loaded`, NOT on `tz !== 'UTC'`: UTC is a real configured zone too ("the cutoff follows the
  // APP timezone" test pins a UTC install still grouping). Scoped to the grouping alone, the way
  // `verdictsTouched` was scoped to the verdicts: until then the list renders flat, exactly as for a night
  // with no bedtime, every event with its own chips, and the rest of the screen is unaffected.
  const groupEarly = settingsLoaded && hasBedtime;
  const early = groupEarly ? transitions.filter(isEarly) : [];
  const later = groupEarly ? transitions.filter((t) => !isEarly(t)) : transitions;
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
            the wake to the "correct" verdict would have ended that night at the wrong one.
            A got-into-bed event offers TWO moments, because going into bed and falling asleep are
            different times on a bedtime-story night (see `inBed`): "Put down here" fills "In bed"
            and never "Fell asleep"; "Asleep here" fills "Fell asleep". */}
        <div className="review-event__verdicts">
          {t.type === 'into_bed' && (
            <button
              type="button"
              className={`review-chip review-chip--moment${inBedFrame === t.id ? ' review-chip--on' : ''}`}
              aria-pressed={inBedFrame === t.id}
              disabled={!timesReady}
              onClick={() => tapMoment('inBed', t)}
            >
              <Baby size={16} aria-hidden="true" /> Put down here
            </button>
          )}
          <button
            type="button"
            className={`review-chip review-chip--moment${
              (t.type === 'into_bed' ? onsetFrame : wakeFrame) === t.id ? ' review-chip--on' : ''}`}
            aria-pressed={(t.type === 'into_bed' ? onsetFrame : wakeFrame) === t.id}
            disabled={!timesReady}
            onClick={() => tapMoment(t.type === 'into_bed' ? 'onset' : 'wake', t)}
          >
            <Moon size={16} aria-hidden="true" /> {t.type === 'into_bed' ? 'Asleep here' : 'Up for the day here'}
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

          {/* "No one was in the bed" takes priority over confirm-or-edit, whatever `editing` says —
              that is the whole fix for R5: a flag always clears the review's stored times, so `editing`
              alone would seed straight back into "confirm the detector's guess" and silently misstate
              what the parent actually answered. Reversible, so no confirm modal — the receipt this
              lands on (SleepDetail's ReviewReceipt) is what confirms it, same as "That's right" below. */}
          {nobody ? (
            <>
              <div className="camera-tile__sub">You said no one was in the bed.</div>
              <div className="review-actions">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => saveNobody(false)}>
                  {busy ? 'Saving…' : 'Someone was in the bed'}
                </button>
              </div>
            </>
          ) : (
          <>
          {/* Says why the time controls are greyed out (see `timesReady`). Usually gone a moment after the
              page opens; it stays for the visit only if the settings request failed. */}
          {!timesReady && (
            <div className="camera-tile__sub">
              Waiting for the app’s timezone setting before any time can be confirmed or changed. If this
              doesn’t go away, reload the page.
            </div>
          )}
          {/* Confirm-or-correct, deliberately NOT a pre-filled form you can save by reflex. A pre-filled
              form puts the app's own answer one tap from becoming "ground truth" — and that answer is
              sometimes badly wrong (a drifted wake of 08:29 against a real 06:00). Blessing it by
              accident poisons the very data this screen exists to collect, and on first real use that
              is exactly what happened. */}
          {!editing && (
            <>
              {hasOpinion ? (
                <div className="review-shown">
                  {shownInBed && (
                    <div><span className="review-shown__label">In bed</span><strong>{shownInBed}</strong></div>
                  )}
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
                    disabled={busy || !timesReady}
                    onClick={() => save(true, shownOnset, shownWake)}
                  >
                    {busy ? 'Saving…' : 'That’s right'}
                  </button>
                )}
                <button type="button" className="btn btn-secondary" disabled={!timesReady} onClick={() => setEditing(true)}>
                  {hasOpinion ? 'Not quite…' : 'Add the times'}
                </button>
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => saveNobody(true)}>
                  No one was in the bed
                </button>
              </div>
            </>
          )}

          {editing && (
            <>
              <div className="camera-tile__sub">
                {hasOpinion && `We said ${shownOnset || '—'} to ${shownWake || '—'}. `}
                Put in what actually happened — your times are what {kid?.name || 'their'}’s card will show.
                {(onsetFrame || wakeFrame || inBedFrame) && ' Times you picked from a frame are exact to the second.'}
              </div>
              {/* Above "Fell asleep", in the order the two happen. Optional: leave it empty and nothing
                  about the put-down is recorded (and nothing is sent, see `inBedTouched`). */}
              <label className="field">
                <span className="field__label">In bed</span>
                <input
                  type="time"
                  value={inBed}
                  disabled={!timesReady}
                  onChange={(e) => { setTouched(true); setInBedTouched(true); setInBedFrame(null); setInBed(e.target.value); }}
                />
              </label>
              <label className="field">
                <span className="field__label">Fell asleep</span>
                <input type="time" value={onset} disabled={!timesReady} onChange={(e) => { setTouched(true); setOnsetFrame(null); setOnset(e.target.value); }} />
              </label>
              <label className="field">
                <span className="field__label">Got up for the day</span>
                <input type="time" value={wake} disabled={!timesReady} onChange={(e) => { setTouched(true); setWakeFrame(null); setWake(e.target.value); }} />
              </label>
              <label className="field">
                <span className="field__label">Anything else worth noting</span>
                <input
                  type="text"
                  value={note}
                  disabled={!timesReady}
                  placeholder="e.g. put back on the bed to get dressed at 5:45"
                  onChange={(e) => { setTouched(true); setNote(e.target.value); }}
                />
              </label>
              <div className="review-actions">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => saveNobody(true)}>
                  No one was in the bed
                </button>
              </div>
            </>
          )}
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
          {/* Inline help rather than a help screen (there is none): said ONCE above the list, not under
              every got-into-bed row, because a night can carry a dozen of them. Only when the list has a
              got-into-bed event, since those are the only rows with the two buttons. */}
          {showEvents && transitions.some((t) => t.type === 'into_bed') && (
            <div className="review-events__help">
              <strong>Put down here</strong> = they went into bed. <strong>Asleep here</strong> = they fell
              asleep. Reading a story first? Mark both.
            </div>
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
        {/* `&& !nobody`: `editing` can still be stale-true here (e.g. someone typed times, then tapped
            "No one was in the bed" from inside edit mode) while `saveNobody`'s own PUT is in flight or
            has just failed — the top card already hid the time inputs in that state, so this button
            must not reappear offering to save whatever they were last set to. */}
        {editing && !nobody ? (
          <button type="button" className="btn btn-primary btn-block" disabled={busy || !timesReady} onClick={() => save(true)}>
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
