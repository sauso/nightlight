import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import { useHomeTime } from '../lib/useHomeTime.js';
import AppHeader from '../components/AppHeader.jsx';

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
// exits at all). Bedtime and fell-asleep are still stored and still editable, behind a disclosure, for
// the rare night they are wrong. Per-event answers are no longer asked here; the ones already stored are
// untouched (this page never sends `verdicts`), and the backend routes and columns are unchanged.
//
// ⚠️ Times are typed as local wall-clock and sent AS TYPED. The server resolves them against the app's
// configured timezone — see toLocalHhmm below for why that direction is deliberate.

// UTC 'YYYY-MM-DD HH:MM:SS' -> the 'HH:MM' shown in the app's configured timezone — the same zone the
// sleep card renders in, so the review and the thing it is correcting always agree. This is the value of
// a `<input type="time">`, which needs the 24-hour 'HH:MM' form whatever the device's own clock format;
// the times READ on this page (the question, the hints) go through useHomeTime like every other screen.
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

const toDate = (utc) => new Date(`${utc.replace(' ', 'T')}Z`);

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
  const [moreToggled, setMoreToggled] = useState(null); // same, for the disclosure
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
  // The disclosure opens by itself in two cases. (1) The owner has already answered one of its two times,
  // so a stored answer is never hidden from them. (2) The app found no wake for the night: a night the
  // detector scored empty only becomes a scored night when a parent gives BOTH times (#355; a lone wake
  // leaves it "no one in the bed", docs/sleep-tracking.md), and the review of such a night is the only way
  // in, so hiding the asleep field there would make that path unreachable from the screen.
  const seededMore = Boolean(review?.true_onset_at || review?.true_in_bed_at) || !hasComputedWake;
  const moreOpen = moreToggled ?? seededMore;
  const nobody = nobodyLocal ?? Boolean(review?.nobody_in_bed);

  const setField = (key, value) => setTyped((t) => ({ ...t, [key]: value }));

  // The time as a person reads it (home time, via the shared formatter). Never called before `timesReady`.
  const readable = (utc) => (utc ? home.time(toDate(utc)) : '');
  // The detector's put-down and fell-asleep times, read out for the disclosure ("in bed 6:10 pm, asleep ...").
  const saidParts = [
    computed?.in_bed_at && `in bed ${readable(computed.in_bed_at)}`,
    computed?.onset_at && `asleep ${readable(computed.onset_at)}`,
  ].filter(Boolean);

  // Something to save: a wake to send, or something the person typed (an emptied wake clears it, a lone
  // asleep time on a night with no wake is a valid answer). Save is NOT tied to the wake alone: the old screen
  // let a caregiver empty a time to remove a correction, and a night the app found no wake for can still be
  // given just an asleep time (restored in the PR #897 fix round, the owner's decision).
  const canSave = Boolean(wakeShown) || Object.keys(typed).length > 0;

  // `wakeOverride`: the 'HH:MM' of an "Around ..." button in range mode, sent as the wake answer through the
  // SAME payload as every other wake save (so the server's checks, the store-first step and the lock are the
  // ones "That's right" already goes through). Absent for every other caller.
  const save = async (wakeOverride) => {
    // Never a time read in the placeholder zone, whichever button asked (see `timesReady`).
    if (!timesReady || !(canSave || wakeOverride)) return;
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
    if (wakeOverride) body.true_wake_local = wakeOverride;
    else if (wakeShown) body.true_wake_local = wakeShown;
    else if ('wake' in typed) body.true_wake_local = null;
    if ('onset' in typed) body.true_onset_local = typed.onset || null;
    if ('inBed' in typed) body.true_in_bed_local = typed.inBed || null;
    if ('note' in typed) body.note = typed.note.trim() || null;
    // A time typed by hand replaces a FRAME the answer was once taken from (a review saved by the old
    // screen's "Up for the day here" etc.). The server keeps a stored frame id when none is sent, and a
    // frame beside a different time would label the wrong picture as "they got up"; the old screen cleared
    // the id the moment a time was edited, and this keeps that. Only when a frame is actually on record and
    // the time really changed: a first-time answer carries no frame key at all.
    const changed = (key, stored, frameId) => key in typed && frameId != null && typed[key] !== toLocalHhmm(stored, tz);
    if (changed('wake', review?.true_wake_at, review?.true_wake_transition_id)) body.true_wake_transition_id = null;
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
  // The note, if one was typed in the disclosure, rides along: it describes the NIGHT, not a time, and
  // the original bug here was that a note typed but not yet saved vanished the moment this was tapped,
  // silently, because the call sent nothing but the flag. Untyped, it is omitted (keep what is stored).
  const saveNobody = async (flag) => {
    setBusy(true);
    setError(null);
    try {
      const body = { nobody_in_bed: flag };
      if ('note' in typed) body.note = typed.note.trim() || null;
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
                  {timesReady && (
                    <div className="camera-tile__sub">
                      {review?.true_wake_at
                        ? `You said up at ${readable(review.true_wake_at)}. `
                        : range
                          ? `We said up between ${readable(range.from)} and ${readable(range.to)}. `
                          : hasComputedWake
                            ? `We said up at ${readable(computed.wake_at)}. `
                            : 'We didn’t work out when they got up. '}
                      Put in what actually happened — your time is what {kid?.name || 'their'}’s card will show.
                    </div>
                  )}
                  <label className="field">
                    <span className="field__label">Got up for the day</span>
                    <input type="time" value={wakeShown} disabled={!timesReady} onChange={onType('wake')} />
                  </label>
                  <div className="review-actions">
                    <button type="button" className="btn btn-primary" disabled={busy || !timesReady || !canSave} onClick={() => save()}>
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}

              {/* The rare night the other two times are wrong. Collapsed by default: three time fields and a
                  note were the old screen's first impression, and only the wake is asked of everyone. */}
              <div className="review-more">
                <button
                  type="button"
                  className="review-more__toggle"
                  aria-expanded={moreOpen}
                  onClick={() => setMoreToggled(!moreOpen)}
                >
                  <ChevronDown size={16} className={`review-more__chev${moreOpen ? ' is-open' : ''}`} aria-hidden="true" />
                  Change bedtime or fell-asleep time
                </button>
                {moreOpen && (
                  <div className="review-more__body">
                    {timesReady && saidParts.length > 0 && (
                      <div className="camera-tile__sub">
                        We said {saidParts.join(', ')}. Only a time you type here is saved.
                      </div>
                    )}
                    {/* Above "Fell asleep", in the order the two happen. Optional: leave it alone and
                        nothing about the put-down is recorded or sent. */}
                    <label className="field">
                      <span className="field__label">In bed</span>
                      <input type="time" value={inBedShown} disabled={!timesReady} onChange={onType('inBed')} />
                    </label>
                    <label className="field">
                      <span className="field__label">Fell asleep</span>
                      <input type="time" value={onsetShown} disabled={!timesReady} onChange={onType('onset')} />
                    </label>
                    <label className="field">
                      <span className="field__label">Anything else worth noting</span>
                      <input
                        type="text"
                        value={noteShown}
                        disabled={!timesReady}
                        placeholder="e.g. put back on the bed to get dressed at 5:45"
                        onChange={onType('note')}
                      />
                    </label>
                  </div>
                )}
              </div>

              <button type="button" className="review-link" disabled={busy} onClick={() => saveNobody(true)}>
                No one was in the bed
              </button>
            </>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}
      </main>
    </>
  );
}
