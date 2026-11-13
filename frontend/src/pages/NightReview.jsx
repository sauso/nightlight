import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, Clock, Bed, Plus } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';
import AppHeader from '../components/AppHeader.jsx';
import Modal from '../components/Modal.jsx';
import { toLocalHhmm } from '../lib/reviewConfirm.js';

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
// ★ ONE QUESTION, NOT A FORM (owner, 2026-10-27). This page used to ask for three times, then a verdict
// on each of the 20-35 recorded events (photos, "what was it?", a "before bedtime" group), and it was
// skipped most mornings: the person wants to say "yes, they got up at 6:37" and go. So the page asks only
// when the child got up, which is the one time a parent can answer from memory and the one the detector
// gets wrong by the most (family-C measurement, 2026-10-27: the true wake is often not among the logged
// exits at all). Bedtime and fell-asleep are still stored and still editable, in the "Edit sleep times" sheet
// (opened from "Something else was off"), for the rare night they are wrong. Per-event answers are no longer asked here; the ones already stored are
// untouched (this page never sends `verdicts`), and the backend routes and columns are unchanged.
//
// ⚠️ Times are typed as local wall-clock and sent AS TYPED. The server resolves them against the app's
// configured timezone — see toLocalHhmm below for why that direction is deliberate.

// `toLocalHhmm` (UTC 'YYYY-MM-DD HH:MM:SS' -> the 'HH:MM' in the app's configured timezone, the value of a
// `<input type="time">`) lives in lib/reviewConfirm.js, where the child page's one-tap "That's right" shares it. The
// times READ on this page (the question, the hints) go through useHomeTime like every other screen. The reverse
// direction is deliberately NOT done in the browser: see the note on toLocalHhmm.

const toDate = (utc) => new Date(`${utc.replace(' ', 'T')}Z`);

// ★ THE -5m / +5m STEPPER (UI refresh PR I). It moves the typed 'HH:MM' by whole minutes and NEVER past midnight:
// it stops at 00:00 and 23:59. Wrapping would be a silent day change, and the page does not know the day: the
// server resolves a bare 'HH:MM' by the noon rule (before 12:00 is the morning after the night's date, lib/sleepReviews.js
// localHmToUtcSql), so 23:57 + 5 -> 00:02 would quietly become a different calendar day than the one on screen. A wake
// that really is either side of midnight is typed by hand, where the person sees the digits they send. Whether a stepped
// time is VALID stays the server's call (its ordering 400s surface in the error slot exactly as for a typed time).
// An empty or malformed value is left alone (null): there is nothing to step from, and inventing a starting time would
// put a time the person never chose into the answer.
const STEP_MINUTES = 5;
function stepHhmm(hhmm, deltaMinutes) {
  const m = /^(\d{2}):(\d{2})/.exec(hhmm || '');
  if (!m) return null;
  const total = Math.min(1439, Math.max(0, Number(m[1]) * 60 + Number(m[2]) + deltaMinutes));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ★ LOGGED OUT-OF-BED EVENTS AS SUGGESTIONS under the stepper. The review response already carries the night's recorded
// events (`transitions`, the same list the server checks a frame id against), so no new field or call is needed. Only
// the ones that can plausibly BE the wake are offered: an out-of-bed event within an hour of a time the page already
// shows (the app's wake, either end of a range, or the person's own stored answer), at most four, nearest first.
// ⚠️ Why these filters and numbers (not measured on a real night; a reasoned default, stated so it can be changed):
//   - 60 minutes: a night has 20-35 events and the wake is rarely further than that from the app's estimate; wider only
//     lists the night's other exits. A wake the app was wrong about by more than an hour is typed (the stepper or the field).
//   - verdict 'wrong' is skipped (the owner already said that event is not real) and so is an exit that is the quick
//     reversal of a put-down (quick_reversal_of is set; a goodnight kiss reading as an exit, bedTransitionRules.js).
//   - Nothing at all on a night with no wake and no stored answer: there is nothing to be "near".
// The listed minute is shown in home time like every other time on this page, and a tap sends the event's id as
// `true_wake_transition_id`, which the server resolves to the event's exact instant and which WINS over the typed text
// (routes/children.js). Typing or stepping after a tap drops the id (see `setField`).
const SUGGEST_WINDOW_MS = 60 * 60 * 1000;
const SUGGEST_MAX = 4;
function wakeSuggestions(transitions, anchorsUtc) {
  const anchors = anchorsUtc.filter(Boolean).map((u) => toDate(u).getTime());
  if (!Array.isArray(transitions) || anchors.length === 0) return [];
  return transitions
    .filter((t) => t && t.type === 'out_of_bed' && t.created_at && t.verdict !== 'wrong' && t.quick_reversal_of == null)
    .map((t) => ({ t, gap: Math.min(...anchors.map((a) => Math.abs(toDate(t.created_at).getTime() - a))) }))
    .filter(({ gap }) => gap <= SUGGEST_WINDOW_MS)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, SUGGEST_MAX)
    .map(({ t }) => t)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}

export default function NightReview() {
  const { id, date } = useParams();
  const navigate = useNavigate();
  const { kids } = useCameras();
  const home = useHomeTime();
  // `loaded`: the server's settings have arrived, so `tz` is the app's REAL zone, not SettingsContext's
  // placeholder 'UTC'. Every control that can send a time waits for it (see `timesReady`).
  const { settings, loaded: settingsLoaded, loading: settingsLoading } = useSettings();
  const tz = settings?.timezone;
  // ⚠️ NOTHING THAT CAN SEND A TIME WORKS UNTIL THE REAL TIMEZONE HAS ARRIVED (issue #512, fix round 2 of
  // 2026-09-30, Codex P1, verified). A time is a UTC instant shown in `tz`, and until /settings resolves
  // `tz` is the placeholder 'UTC', so a Sydney night's 06:37 reads 20:37. A time read in that zone and
  // saved is a wrong time stored as the owner's own answer: a wake before the asleep time, asleep 0. So
  // "That's right", "Not quite", Save and every time input wait for this; the question itself is not shown
  // until then either, so the placeholder zone's time is never on screen to be confirmed.
  // Gated on `loaded`, NOT `tz !== 'UTC'`: UTC is a real configured zone too (a UTC install must work).
  // Scoped to what carries a time: "No one was in the bed" carries none and stays usable, which is what
  // matters if /settings FAILED and `loaded` never arrives this visit (the page then says why).
  //
  // The convention (owner, 2026-10-10) is that times are shown and entered in HOME time, never the
  // browser's and never the placeholder. This page used to need a "touched" flag per field to stop a late
  // zone re-seeding over typing; it no longer seeds at all: a field shows what the person TYPED if they
  // typed anything, else the stored value read in the current zone (`typed` below). So a zone arriving
  // late cannot overwrite typing, and the gate cannot be bypassed by a field that was "touched" early.
  // ⚠️ A new control that can send a time must be gated on this too.
  const timesReady = settingsLoaded;
  // `loading` false with `loaded` still false is a FAILED first /settings request (SettingsContext clears
  // `loading` when the request settles, success or not, and only a success sets `loaded`). The visit is then
  // stuck on the placeholder zone for good, so "waiting" would be a lie: the page says what happened and
  // how to recover instead.
  const settingsFailed = !settingsLoaded && !settingsLoading;
  const kid = kids.find((k) => k.id === id);

  const [data, setData] = useState(null);
  // What the person has typed, by field; a key is ABSENT until they type in it. Absent means "keep what is
  // stored" both on screen (the input shows the stored value) and on the wire (the key is not sent). An
  // empty string is a real value (they cleared the field), which is why this is keyed presence and not a
  // string that defaults to ''.
  const [typed, setTyped] = useState({});
  const [editToggled, setEditToggled] = useState(null); // null = not chosen yet, follow `seededEditing`
  // The "Edit sleep times" sheet. `draft` holds what has been typed INSIDE it (keys inBed / onset / note, absent until
  // typed, like `typed`). It is deliberately separate from `typed`: closing the sheet (Escape, the backdrop, the close
  // button) throws the draft away, as the sheet's own wording promises, while the wake typed on the page behind it stays.
  // Save in the sheet merges the draft over `typed` for that one save (see `save`).
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState({});
  // The step's note field is hidden behind "Add a note" until asked for (or until a note exists); same for the sheet's.
  const [noteOpen, setNoteOpen] = useState(false);
  const [sheetNoteOpen, setSheetNoteOpen] = useState(false);
  // The logged exit the person tapped as their wake, by event id (see `wakeSuggestions`). Valid only while the wake
  // field still holds exactly what that tap put there: `setField('wake', ...)` clears it.
  const [frame, setFrame] = useState(null);
  const [nobodyLocal, setNobodyLocal] = useState(null); // set only after the server confirms (see saveNobody)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // ⚠️ FETCH ON [id, date] ONLY. `tz` must NOT be in here.
  //
  // SettingsContext starts at its defaults (timezone 'UTC') and replaces them when /settings resolves,
  // so `tz` CHANGES a moment after the app boots. With `tz` in these dependencies the effect re-ran,
  // re-fetched, and discarded whatever had been typed in between. The owner corrected a wake to 05:52,
  // watched it save as 08:29, and had no way of knowing why: the form had quietly reset itself back to
  // the server's value under their hands.
  useEffect(() => {
    let live = true;
    api.get(`/children/${id}/review/${date}`)
      .then((r) => { if (live) setData(r); })
      .catch((e) => live && setError(e.message || 'Could not load that night'));
    return () => { live = false; };
  }, [id, date]);

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

  const review = data.review;
  const computed = data.computed;
  const hasComputedWake = Boolean(computed?.wake_at);

  // What each field shows when the person has not typed in it. Wake: their stored answer, else the app's.
  // Fell asleep: likewise (it is only ever SENT once typed, so showing the detector's time here cannot
  // turn the app's guess into the parent's answer). In bed: only what the parent said, never the
  // detector's put-down (plan review R3, 2026-09-30: seeding it would store the detector's put-down as the
  // parent's own answer on a save that never touched it; the sent-only-once-typed rule below makes that
  // impossible, and showing nothing keeps the field honest about what is on record).
  // ★ "UP BETWEEN" MODE (server's `wake_range`, lib/wakeRange.js): the app has two wake estimates 10+ minutes
  // apart, so it asks "Up between A and B. When did they get up?" and offers each end, or another time. It is
  // never a confirmation: the review stores ONE true wake, and "That's right" on a pair would record a time
  // nobody checked (plan amendment 1). So there is no "That's right" here. The server sends no range for a
  // night already answered or corrected; `review?.true_wake_at` is checked too so a stale page cannot offer to
  // overwrite an answer as if it were a first one. Without a range nothing on this screen changes.
  // ⚠️ ...AND ONLY WHEN BOTH ENDS FALL ON THE SAME SIDE OF NOON (home time) as the wake the server echoes back.
  // The server turns a typed "HH:MM" into a day by the noon rule (lib/sleepReviews.js localHmToUtcSql: before 12:00
  // is the morning after the night's date, otherwise the night's start date), and honours the exact echoed
  // `computed_wake_at` as the one exception. An "Around" button sends only HH:MM, so the end that is NOT the echoed
  // wake would resolve to the wrong day if the two ends straddle noon (possible when a household's sleep window
  // runs past midday). Found in the Codex gpt-6-sol review of this change (verified by running localHmToUtcSql).
  // The server file is in test:core and is not edited; the screen asks the ordinary single-time question instead,
  // which sends the echoed wake and so always resolves correctly.
  const beforeNoon = (utc) => Number(toLocalHhmm(utc, tz).slice(0, 2)) < 12;
  const range = computed?.wake_at && !review?.true_wake_at && data.wake_range?.from && data.wake_range?.to
    && beforeNoon(data.wake_range.from) === beforeNoon(computed.wake_at)
    && beforeNoon(data.wake_range.to) === beforeNoon(computed.wake_at)
    ? data.wake_range
    : null;
  // In range mode the wake field starts EMPTY: "Another time" means neither estimate was right, so
  // pre-filling one of them would put a time the person just rejected one reflex-tap from becoming their answer.
  const wakeShown = typed.wake ?? (range ? '' : toLocalHhmm(review?.true_wake_at || computed?.wake_at, tz));
  const onsetShown = typed.onset ?? toLocalHhmm(review?.true_onset_at || computed?.onset_at, tz);
  const inBedShown = typed.inBed ?? toLocalHhmm(review?.true_in_bed_at, tz);
  const noteShown = typed.note ?? (review?.note || '');

  // A night already answered, or one the app found no wake for, opens straight into the time field:
  // coming back to change an answer must not make you confirm from scratch, and with no wake to confirm
  // there is nothing to say "That's right" to.
  const seededEditing = !hasComputedWake || Boolean(review?.true_wake_at);
  const editing = editToggled ?? seededEditing;
  const nobody = nobodyLocal ?? Boolean(review?.nobody_in_bed);

  // The bedtime and fell-asleep times live in the "Edit sleep times" sheet (UI refresh PR I), which used to be a disclosure
  // that OPENED BY ITSELF in two cases. A sheet must not open by itself, so each case is carried by the row that opens it
  // instead: (1) an answer already on record for either time is read out on the row, so a stored answer is never hidden;
  // (2) a night the app found no wake for says what the sheet is for, because such a night only becomes a scored night
  // when a parent gives BOTH times (#355; a lone wake leaves it "no one in the bed", docs/sleep-tracking.md) and the
  // review is the only way in.
  const setField = (key, value) => {
    setTyped((t) => ({ ...t, [key]: value }));
    // A hand-typed (or stepped) wake is no longer the logged event the person tapped: drop that id, so the body never
    // names a frame beside a different time (the server lets the frame win over the text).
    if (key === 'wake') setFrame(null);
  };
  const setDraftField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const openSheet = () => { setDraft({}); setSheetNoteOpen(false); setSheetOpen(true); };
  // Closing DISCARDS what was typed in the sheet (the draft), whichever way it was closed. Nothing is sent.
  const closeSheet = () => { setSheetOpen(false); setDraft({}); };
  const pickSuggestion = (t) => {
    setTyped((prev) => ({ ...prev, wake: toLocalHhmm(t.created_at, tz) }));
    setFrame(t.id);
  };
  const stepWake = (delta) => {
    const next = stepHhmm(wakeShown, delta);
    if (next !== null) setField('wake', next);
  };

  // The time as a person reads it (home time, via the shared formatter). Never called before `timesReady`.
  const readable = (utc) => (utc ? home.time(toDate(utc)) : '');
  // What the person already answered for the two sheet times, read out on the sheet's row ("in bed 6:10 pm, asleep ...").
  const storedSleepParts = [
    review?.true_in_bed_at && `in bed ${readable(review.true_in_bed_at)}`,
    review?.true_onset_at && `asleep ${readable(review.true_onset_at)}`,
  ].filter(Boolean);
  // Logged exits near the wake the page shows, offered as one-tap answers under the stepper (see `wakeSuggestions`).
  // Anchored on every time the page already shows: the person's stored answer, the app's wake, or both ends of a range.
  const suggestions = timesReady
    ? wakeSuggestions(data.transitions, [review?.true_wake_at, ...(range ? [range.from, range.to] : [computed?.wake_at])])
    : [];

  // Something to save: a wake to send, or something the person typed (an emptied wake clears it, a lone
  // asleep time on a night with no wake is a valid answer). Save is NOT tied to the wake alone: the old screen
  // let a caregiver empty a time to remove a correction, and a night the app found no wake for can still be
  // given just an asleep time (restored in the PR #897 fix round, the owner's decision).
  const canSave = Boolean(wakeShown) || Object.keys(typed).length > 0;

  // `wakeOverride`: the 'HH:MM' of an "Around ..." button in range mode, sent as the wake answer through the
  // SAME payload as every other wake save (so the server's checks, the store-first step and the lock are the
  // ones "That's right" already goes through). Absent for every other caller.
  //
  // `sheetDraft`: set ONLY by the "Edit sleep times" sheet's Save, and it is what was typed in the sheet. It is laid over
  // `typed` for this one save (`t` below). ⚠️ A sheet save does not CONFIRM the app's wake: on a night still waiting at
  // "Up at 6:20. Is that right?" the wake shown is the detector's guess, and the old page sent it along with a bedtime fix
  // because the one "That's right" button did both. The sheet's Save is its own button on its own question, so it sends
  // the wake only when the person has answered it (typed it, or the page is already on the wake field, where Save always
  // sent the shown value). Anything else would store the app's guess as the parent's answer from a tap on a different
  // question, the exact failure the confirm-or-correct design exists to prevent.
  const save = async (wakeOverride, sheetDraft) => {
    const t = sheetDraft ? { ...typed, ...sheetDraft } : typed;
    // Never a time read in the placeholder zone, whichever button asked (see `timesReady`).
    if (!timesReady || !((sheetDraft ? Object.keys(t).length > 0 : canSave) || wakeOverride)) return;
    setBusy(true);
    setError(null);
    // ⚠️ THE PAYLOAD IS THE WAKE ANSWER PLUS WHAT WAS ON SCREEN, AND NOTHING ELSE (plan amendment 3,
    // Codex gpt-6-sol plan review, 2026-10-27). Every other key is OMITTED, not sent as null, because the
    // server reads `undefined` as "keep what is stored" and null as "clear it": an omitted key cannot
    // blank a bedtime or note saved from another phone, and cannot store the detector's guess as the
    // parent's answer (the old "That's right" sent the detector's fell-asleep time as the owner's own).
    // ★ A time reaches the body only if the person typed in that field — `typed` holds a key only then.
    const body = {
      // ⚠️ WHAT WE SHOWED THIS PERSON, sent back so the server records it beside their answer. The
      // server deliberately does not recompute it: a night's answer drifts while the page is open
      // (05:51 at 08:16 → 08:31 at 09:50), so recomputing at save time filed a confirmation as a
      // disagreement. Omitting these is just as bad and is what actually shipped once — every stored
      // review then read "the app had no opinion", which was false for every one of them. The wake echo
      // also tells the server which day a time saved exactly as shown is on (localHmToUtcSql).
      computed_onset_at: computed?.onset_at ?? null,
      computed_wake_at: computed?.wake_at ?? null,
      // Which settings this page's times were worked out with (#361 PR 4b), sent back as given. The server
      // refuses the save (409, "settings changed… reload") if the night would now be worked out with
      // other ones. Not sent by `saveNobody`: "No one was in the bed" carries no time.
      settings_key: data.settings?.key,
    };
    // The wake: a time to send, else — only if the person emptied the field themselves — null, which clears
    // it (exactly as the old screen did). An untouched empty wake (a night with none) omits the key.
    const wakeAnswered = editing || 'wake' in t;
    if (wakeOverride) body.true_wake_local = wakeOverride;
    else if (sheetDraft && !wakeAnswered) { /* the sheet is not the wake question: omit the key (see above) */ }
    else if (wakeShown) body.true_wake_local = wakeShown;
    else if ('wake' in t) body.true_wake_local = null;
    if ('onset' in t) body.true_onset_local = t.onset || null;
    if ('inBed' in t) body.true_in_bed_local = t.inBed || null;
    if ('note' in t) body.note = t.note.trim() || null;
    // A time typed by hand replaces a FRAME the answer was once taken from (a review saved by the old
    // screen's "Up for the day here" etc.). The server keeps a stored frame id when none is sent, and a
    // frame beside a different time would label the wrong picture as "they got up"; the old screen cleared
    // the id the moment a time was edited, and this keeps that. Only when a frame is actually on record and
    // the time really changed: a first-time answer carries no frame key at all.
    const changed = (key, stored, frameId) => key in t && frameId != null && t[key] !== toLocalHhmm(stored, tz);
    // A logged exit the person tapped under the stepper (`frame`) is a frame-backed answer: its id goes with the time, and
    // the server takes the event's exact instant. Never with an "Around" button's time (that is a different answer), and
    // only while the wake still holds what the tap put there (`setField` clears `frame` the moment it is edited).
    if (frame != null && !wakeOverride && 'wake' in t) body.true_wake_transition_id = frame;
    else if (changed('wake', review?.true_wake_at, review?.true_wake_transition_id)) body.true_wake_transition_id = null;
    if (changed('onset', review?.true_onset_at, review?.true_onset_transition_id)) body.true_onset_transition_id = null;
    if (changed('inBed', review?.true_in_bed_at, review?.true_in_bed_transition_id)) body.true_in_bed_transition_id = null;
    try {
      await api.put(`/children/${id}/review/${date}`, body);
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
  // exclusive on the server (a 400, "pick one"). Sending a time alongside the flag would either trip that
  // refusal, or — for the UNDO direction ("Someone was in the bed") — silently attach a time to what is
  // supposed to be a bare "no answer" undo. That matters because undoing with nothing else entered is a
  // real, documented path (README): the detector's night comes back, but nothing typed before the flag
  // was set comes back with it, and this call must not paper over that by inventing an answer.
  // No confirm modal, unlike a destructive action elsewhere in the app — the flag is reversible
  // (`saveNobody(false)`), and the receipt this lands on is what confirms it, same as "That's right".
  //
  // The note, if one was typed (on the page, or in the "Edit sleep times" sheet this is tapped from: `sheetDraft`),
  // rides along: it describes the NIGHT, not a time, and the original bug here was that a note typed but not yet saved
  // vanished the moment this was tapped, silently, because the call sent nothing but the flag. Untyped, it is omitted
  // (keep what is stored). ⚠️ Still NEVER sent with a time, now that the action lives in the same sheet as the time
  // fields: the body is built here from the note alone, and a time typed in the sheet is abandoned, as before.
  const saveNobody = async (flag, sheetDraft) => {
    const t = sheetDraft ? { ...typed, ...sheetDraft } : typed;
    setBusy(true);
    setError(null);
    try {
      const body = { nobody_in_bed: flag };
      if ('note' in t) body.note = t.note.trim() || null;
      await api.put(`/children/${id}/review/${date}`, body);
      // Only now — confirmed by the server — do we say so. Setting the flag BEFORE this await (as this
      // used to) meant a failed save left the screen claiming the flag was set (or cleared) when the
      // server actually still held the OTHER value, and the only button left was the one for the
      // OPPOSITE action, applied to a state that was never really reached.
      setNobodyLocal(flag);
      navigate(`/children/${id}/sleep?date=${date}&saved=1`);
    } catch (e) {
      setError(e.message || 'Could not save');
      setBusy(false);
    }
  };

  const onType = (key) => (e) => setField(key, e.target.value);

  return (
    <>
      <AppHeader title="Was this right?" back={back} />
      <main className="app-main">
        <div className="card">
          {/* "No one was in the bed" takes priority over confirm-or-edit: a flag always clears the
              review's stored times, so the review alone would seed straight back into "confirm the
              detector's guess" and silently misstate what the parent actually answered. Reversible, so no
              confirm modal — the receipt this lands on is what confirms it. */}
          {nobody ? (
            <>
              <div className="review-question">You said no one was in the bed.</div>
              <div className="review-actions">
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => saveNobody(false)}>
                  {busy ? 'Saving…' : 'Someone was in the bed'}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Says why the time controls are greyed out (see `timesReady`). "Waiting" is gone a moment
                  after the page opens; the error stays for the whole visit, because a failed /settings
                  request is not retried (see `settingsFailed`). */}
              {!timesReady && !settingsFailed && (
                <div className="camera-tile__sub">
                  Waiting for the app’s timezone setting before any time can be confirmed or changed.
                </div>
              )}
              {settingsFailed && (
                <div className="error-banner">
                  The app’s timezone setting could not be loaded, so times can’t be confirmed or changed on this
                  visit. Reload the page to try again. “No one was in the bed” still works.
                </div>
              )}

              {/* Confirm-or-correct, deliberately NOT a pre-filled form you can save by reflex. A
                  pre-filled form puts the app's own answer one tap from becoming "ground truth" — and
                  that answer is sometimes badly wrong (a drifted wake of 08:29 against a real 06:00).
                  The confirm is one deliberate button, and correcting is a separate act. */}
              {!editing && range ? (
                <>
                  {timesReady && (
                    <div className="review-question">
                      Up between {readable(range.from)} and {readable(range.to)}. When did they get up?
                    </div>
                  )}
                  {/* Two equal choices, so both use the secondary style: `--accent` is for the ONE primary
                      action, and a pair of estimates has no favourite (design-language.md). Each saves that
                      end as the wake answer, minute-precise like any typed time. No "That's right": a range
                      cannot be confirmed (see `range`). */}
                  <div className="review-actions">
                    <button type="button" className="btn btn-secondary" disabled={busy || !timesReady}
                      onClick={() => save(toLocalHhmm(range.from, tz))}>
                      Around {readable(range.from)}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy || !timesReady}
                      onClick={() => save(toLocalHhmm(range.to, tz))}>
                      Around {readable(range.to)}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy || !timesReady} onClick={() => setEditToggled(true)}>
                      Another time
                    </button>
                  </div>
                </>
              ) : !editing ? (
                <>
                  {timesReady && (
                    <div className="review-question">Up at {readable(computed.wake_at)}. Is that right?</div>
                  )}
                  <div className="review-actions">
                    <button type="button" className="btn btn-primary" disabled={busy || !timesReady} onClick={() => save()}>
                      {busy ? 'Saving…' : 'That’s right'}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy || !timesReady} onClick={() => setEditToggled(true)}>
                      Not quite
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* The correcting step (UI refresh PR I, as drawn): a question, what the app had, then a -5m / time / +5m
                      stepper, the logged exits near it as one-tap answers, an optional note and Save. The time is always
                      a real <input type="time">: typing and the stepper edit the SAME value, which is sent as HH:MM exactly
                      as it stands (the server resolves the day, see stepHhmm). The question names the child, so it is not
                      a time and is drawn at once; the hint below it carries times and waits for the real zone. */}
                  <div className="review-question">When did {kid?.name || 'they'} get up for the day?</div>
                  {timesReady && (
                    <div className="camera-tile__sub review-hint">
                      {review?.true_wake_at
                        ? `You said up at ${readable(review.true_wake_at)}.`
                        : range
                          ? `We said up between ${readable(range.from)} and ${readable(range.to)}.`
                          : hasComputedWake
                            ? `We had ${readable(computed.wake_at)}.`
                            : 'We didn’t work out when they got up. To count the night, add when they went to bed and fell asleep too, under “Something else was off”.'}
                      {' '}Your time is what {kid?.name || 'their'}’s card will show.
                    </div>
                  )}
                  <div className="review-stepper">
                    <button type="button" className="review-stepper__btn" aria-label={`${STEP_MINUTES} minutes earlier`}
                      disabled={!timesReady || !wakeShown} onClick={() => stepWake(-STEP_MINUTES)}>
                      −{STEP_MINUTES}m
                    </button>
                    <label className="review-stepper__time">
                      <span className="review-sr">Got up for the day</span>
                      <input type="time" value={wakeShown} disabled={!timesReady} onChange={onType('wake')} />
                    </label>
                    <button type="button" className="review-stepper__btn" aria-label={`${STEP_MINUTES} minutes later`}
                      disabled={!timesReady || !wakeShown} onClick={() => stepWake(STEP_MINUTES)}>
                      +{STEP_MINUTES}m
                    </button>
                  </div>
                  {suggestions.length > 0 && (
                    <div className="review-suggest" role="group" aria-label="Logged out-of-bed times">
                      {suggestions.map((s) => (
                        <button key={s.id} type="button" className="review-suggest__btn" aria-pressed={frame === s.id}
                          disabled={busy} onClick={() => pickSuggestion(s)}>
                          {readable(s.created_at)} · out of bed
                        </button>
                      ))}
                    </div>
                  )}
                  {(noteOpen || noteShown) ? (
                    <label className="field">
                      <span className="field__label">Anything else worth noting</span>
                      <input type="text" value={noteShown} disabled={!timesReady} onChange={onType('note')}
                        placeholder="e.g. put back on the bed to get dressed at 5:45" />
                    </label>
                  ) : (
                    <button type="button" className="review-add" onClick={() => setNoteOpen(true)}>
                      <Plus size={16} aria-hidden="true" /> Add a note
                    </button>
                  )}
                  <div className="review-actions">
                    <button type="button" className="btn btn-primary" disabled={busy || !timesReady || !canSave} onClick={() => save()}>
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* The quieter way out of the question (UI refresh PR I): ONE row, "Something else was off", which opens the "Edit sleep
            times" sheet below. It used to be two rows (PR H): a disclosure of the bedtime and fell-asleep fields, and "No one was
            in the bed". Both now live in the sheet, as drawn. A 44px target, an icon at the left and a chevron at the right.
            The second line carries what the old disclosure showed by opening itself (see `storedSleepParts`). */}
        {!nobody && (
          <div className="card review-rows">
            <button type="button" className="review-link" aria-haspopup="dialog" onClick={openSheet}>
              <Clock size={18} className="review-row__icon" aria-hidden="true" />
              <span className="review-row__text">
                Something else was off
                <span className="review-row__sub">
                  {timesReady && storedSleepParts.length > 0
                    ? `You said ${storedSleepParts.join(', ')}. Tap to change it.`
                    : !hasComputedWake
                      ? 'Add when they went to bed and fell asleep.'
                      : 'Change bedtime or fell-asleep time, or say no one was in the bed.'}
                </span>
              </span>
              <ChevronRight size={16} className="review-row__go" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* "Edit sleep times": a bottom sheet (the shared Modal, so focus moves in, Tab stays in, Escape and a tap outside close
            it, and focus goes back to the row that opened it). ⚠️ CLOSING DISCARDS: what is typed here lives in `draft`, which
            `closeSheet` empties, and nothing is sent until Save or "No one was in the bed". The In bed field shows only what the
            parent said, never the detector's put-down (plan review R3, 2026-09-30), and "We had" under each field says what the app
            had; Fell asleep SHOWS the app's time so there is something to edit, but is sent only once changed. */}
        {sheetOpen && !nobody && (
          <Modal title="Edit sleep times" onClose={closeSheet} error={error || ''}>
            <div className="review-sheet">
              {timesReady && (
                <div className="camera-tile__sub review-hint">
                  Only a time you change here is saved. Closing this without saving throws away what you typed.
                </div>
              )}
              {/* In the order the two happen. Optional: leave it alone and nothing about the put-down is recorded or sent. */}
              <label className="field">
                <span className="field__label">In bed</span>
                <input type="time" value={draft.inBed ?? inBedShown} disabled={!timesReady} aria-describedby="review-had-inbed"
                  onChange={(e) => setDraftField('inBed', e.target.value)} />
              </label>
              {timesReady && computed?.in_bed_at && <div id="review-had-inbed" className="review-sheet__had">We had {readable(computed.in_bed_at)}.</div>}
              <label className="field">
                <span className="field__label">Fell asleep</span>
                <input type="time" value={draft.onset ?? onsetShown} disabled={!timesReady} aria-describedby="review-had-onset"
                  onChange={(e) => setDraftField('onset', e.target.value)} />
              </label>
              {timesReady && computed?.onset_at && <div id="review-had-onset" className="review-sheet__had">We had {readable(computed.onset_at)}.</div>}
              {(sheetNoteOpen || draft.note || noteShown) ? (
                <label className="field">
                  <span className="field__label">Anything else worth noting</span>
                  <input type="text" value={draft.note ?? noteShown} disabled={!timesReady}
                    placeholder="e.g. put back on the bed to get dressed at 5:45"
                    onChange={(e) => setDraftField('note', e.target.value)} />
                </label>
              ) : (
                <button type="button" className="review-add" onClick={() => setSheetNoteOpen(true)}>
                  <Plus size={16} aria-hidden="true" /> Add a note
                </button>
              )}
              <div className="review-actions">
                <button type="button" className="btn btn-primary"
                  disabled={busy || !timesReady || Object.keys(draft).length === 0} onClick={() => save(undefined, draft)}>
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
              {/* A flag and a time are mutually exclusive on the server: this sends the flag (and a typed note) and abandons any
                  time typed above (see `saveNobody`). Carries no time, so it works before the timezone has arrived. */}
              <button type="button" className="review-link review-link--sheet" disabled={busy} onClick={() => saveNobody(true, draft)}>
                <Bed size={18} className="review-row__icon" aria-hidden="true" />
                <span className="review-row__text">No one was in the bed</span>
              </button>
            </div>
          </Modal>
        )}

        {error && !sheetOpen && <div className="error-banner">{error}</div>}
      </main>
    </>
  );
}
