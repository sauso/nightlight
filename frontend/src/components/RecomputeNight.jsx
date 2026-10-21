import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { useAuth } from '../lib/AuthContext.jsx';
import { nightDetailPath, settingsParts } from '../lib/nightView.js';
import Modal from './Modal.jsx';

// Durations read as "9h 01m" here, matching the summary card this dialog is comparing against.
function fmtDur(min) {
  if (min == null) return null;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// A night today's settings cannot score (PR 3, plan R1): its dialog offers only the stored-settings re-score.
const unscoredNight = (n) => n?.status === 'no_data' || n?.status === 'no_sleep';

// For example "Saved with: Bed cam, 19:30–07:00, Europe/London. Now: Door cam, 19:30–07:00, Europe/London."
// Only what differs is emphasised: the reader's question is "what changed since this night was saved?".
function SettingsCompare({ contexts }) {
  const was = settingsParts(contexts.stored, contexts.camera_names?.stored);
  const now = settingsParts(contexts.current, contexts.camera_names?.current);
  const differs = {
    camera: contexts.stored.camera_id !== contexts.current.camera_id,
    window: was.window !== now.window,
    tz: was.tz !== now.tz,
  };
  const show = (parts, key) => (differs[key] ? <strong>{parts[key]}</strong> : parts[key]);
  return (
    <>
      Saved with: {show(was, 'camera')}, {show(was, 'window')}, {show(was, 'tz')}. Now: {show(now, 'camera')},{' '}
      {show(now, 'window')}, {show(now, 'tz')}.
    </>
  );
}

// Admin-only "Recompute this night".
//
// Why it exists: a stored night is written once, the morning after, and never revisited, so after any
// change to the sleep logic the child's "last night" CARD keeps showing the old answer while the sleep
// detail page — which recomputes on every view — shows the new one. They disagree and never converge.
// On 2026-08-29 the stored row said a child fell asleep at 16:56 while the detail page correctly said
// 20:15, and the only way to reconcile it was pasting a fetch into a browser console.
//
// ⚠️ THE BASELINE IS THE STORED ROW, AND THAT IS THE WHOLE POINT. The first cut of this compared the
// page's `night` — which is ALREADY a fresh recompute — against another fresh recompute, so the two
// sides were the same computation and the dialog always reported "exactly the same numbers" while the
// card stayed wrong. `?stored=1` fetches what is actually saved. If this ever regresses to comparing
// against the page's night, the feature silently does nothing.
//
// It shows BEFORE -> AFTER rather than just asking "are you sure?". The comparison is the point: it
// turns an irreversible write into something you can read and judge first, and it is how an improvement
// to the sleep algorithm becomes visible instead of theoretical. The write itself refuses to downgrade
// a scored night (see computeAndStoreNight), so the worst case here is "nothing changed".
//
// ⚠️ A NIGHT A PARENT CORRECTED IS LOCKED (2026-09-30, the owner's rule: once corrected, a night is
// complete and nothing re-scores it). The server refuses the write, and `?stored=1` says so up front as
// `locked`, so the dialog opens on "this night is locked" instead of offering numbers that could never
// be saved. It keys on the server's `locked`, deliberately NOT on `night.corrected` (plan review R8): a
// corrected night whose saved row is missing or unscored is not locked, and this button is its only fix.
//
// ⚠️ THE LOCKED DIALOG USED TO SAY "Removing your correction unlocks it" WITH NOTHING TO REMOVE IT WITH
// (owner, staging, 2026-10). The review screen seeds its asleep and wake inputs with the detector's value, so
// a person who cleared only the in-bed time stayed locked (true_onset_at and true_wake_at still set) and
// nothing said why. "Remove my correction" is that missing control. It is a plain save of the EXISTING review
// route, deliberately and only with the three times, their three frame ids and (only when the stored review
// says no one was in the bed) the flag. See `removeCorrection` for exactly what is and is not sent.
//
// ⚠️ #361 PR 3: A THIRD BASELINE, "the settings this night was saved with". The "before" column is still the
// saved row; what changes is the "after". By default it is the PAGE's night, worked out with TODAY's camera,
// timezone and window (with a parent's correction laid over it, as the page shows it), exactly as before (since
// PR 4a only while the page itself shows today's settings: see the ⚠️ below). Ticking
// "Use the settings this night was saved with" swaps it for a PREVIEW from `?context=stored&raw=1`: the night
// worked out with the camera, timezone and window it was saved with (today's detection rules either way), WITHOUT
// the correction overlay, because a store writes the detector's answer and the dialog must show what Save will
// write. Comparing the saved row with the page's night while saving the replay would preview one thing and write
// another. The choice arrives with `?stored=1` (`contexts`), so opening the dialog costs no extra request.
//   - The box starts UNTICKED every time the dialog opens, and an unticked save sends exactly today's URL (no
//     `context` at all): the owner chose today's settings as the default (2026-10-20, #361 Q4).
//   - It is offered only when the saved settings are usable AND differ from today's (camera, timezone or
//     window). A night saved before the app recorded its settings, or whose record can't be read, shows the
//     box disabled with the reason, so the option is not silently missing; identical settings show nothing.
//   - Save sends `expect_context` (the exact record the dialog was shown): another phone that re-saves the night
//     in between makes the server answer 409 rather than store numbers nobody previewed (plan R2).
//   - On a night today's settings cannot score (`no_data`, `no_sleep`) this control used to be absent, so the
//     night the feature exists for (a camera turned off since) could not reach it (plan R1). There it renders
//     ONLY after its own `?stored=1` finds usable, differing saved settings on an unlocked night (otherwise the
//     page looks exactly as before), and the dialog offers only the stored-settings path: a save with today's
//     settings could at best store "no data" again (over a scored row it is refused, `would_downgrade`), and
//     comparing the saved row with "no data" means nothing.
//
// ⚠️ #361 PR 4a: THE PAGE'S NIGHT IS NO LONGER ALWAYS TODAY'S SETTINGS. A finished night whose saved settings differ
// from today's is shown WITH the saved ones (the server says so in `night.scoring_view`). The unticked "after" column
// still has to mean "today's settings", so whenever `scoring_view` is present the dialog fetches its own TODAY'S
// preview (`?context=current&raw=1`) when it opens, and uses THAT as the unticked baseline, and to decide whether
// today's settings can score the night at all (the no_data / no_sleep restriction above), never the page's night
// (plan R4, both plan reviewers: a stored view `ok` over a today's `no_data` would otherwise offer a Save that is
// certain to be refused with the false "aged out"; a stored view `no_data` over a today's `ok` would say "today's
// settings find no data"). With no `scoring_view` the page's night is today's settings, the baseline as before.
//   - After ANY save the page goes back to its default view (`onSettingsViewChange('auto')`) and is re-read in it:
//     the row just written is now what the card shows, and the default view shows exactly that row's settings (a
//     stored-settings save keeps the saved settings, which still differ, so they are replayed; a today's-settings
//     save writes today's, so there is nothing to replay). PR 3's line "this page still works the night out with
//     today's settings" is gone with the premise that made it true.
//   - "Remove my correction" re-reads the page in the view it is ALREADY in (`settingsView`): removing a correction
//     changes no settings, so it must not flip what the page is showing.
export default function RecomputeNight({ childId, date, night, fmtTime, onRecomputed, onCorrectionRemoved,
  settingsView = 'auto', onSettingsViewChange }) {
  const { user } = useAuth();
  const [stored, setStored] = useState(undefined); // the saved row: undefined = not looked yet, null = none
  const [locked, setLocked] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false); // the "Remove my correction" confirm step, in the modal
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // #361 PR 3 (see the header): the two contexts from `?stored=1` (null = an older server sent none), the box,
  // the stored-settings preview, and (no_data/no_sleep nights only) whether this control is offered at all.
  const [contexts, setContexts] = useState(null);
  const [useStoredSettings, setUseStoredSettings] = useState(false);
  const [preview, setPreview] = useState(null);
  const [offered, setOffered] = useState(false);
  // #361 PR 4a (plan R4): today's-settings preview, fetched when the dialog opens on a page that is showing a night
  // with its saved settings (`night.scoring_view`). null otherwise.
  const [todayPreview, setTodayPreview] = useState(null);

  const isAdmin = user?.role === 'admin';
  // From the PAGE's night: whether the control is offered at all, and its layout (see the R1 effect below).
  const unscored = unscoredNight(night);
  const inProgress = !!night?.in_progress;
  // Plan R4: the page's night is today's settings only when the server did not say otherwise.
  const pageShowsSaved = !!night?.scoring_view;
  // Today's preview, read raw (`raw=1`): what a today's-settings save would store. Fetched only while unlocked.
  const readTodayPreview = () => api.get(`/children/${childId}/sleep/${date}?context=current&raw=1`, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
  // Plan R1: one read, admin only, and only on a night today's settings cannot score. Any failure, or an answer
  // without usable differing settings, leaves the control hidden: the page then looks exactly as before.
  useEffect(() => {
    setOffered(false);
    if (!isAdmin || !unscored || inProgress || !childId || !date) return undefined;
    let alive = true;
    api.get(`/children/${childId}/sleep/${date}?stored=1`)
      .then((r) => {
        if (alive) setOffered(r?.locked !== true && r?.contexts?.stored_state === 'ok' && r?.contexts?.differs === true);
      })
      .catch(() => { /* not offered */ });
    return () => { alive = false; };
  }, [isAdmin, unscored, inProgress, childId, date]);

  if (user?.role !== 'admin' || !childId || !date || night?.in_progress) return null;
  if (unscored && !offered) return null;

  const closeDialog = () => {
    setOpen(false);
    setConfirming(false);
  };

  // Clears the person's correction so the night can be recomputed, and keeps everything else they said.
  //
  // ⚠️ WHAT IS SENT IS THE WHOLE POINT. The review route reads `undefined` (key omitted) as "keep what is
  // stored" and `null` as "clear it" (sleepReviews.previewNightReview, `pick`), so this body names ONLY the
  // six time fields, each null. No verdicts, reasons, note or computed_* are sent, so the person's answers
  // about the events, their note and what the app showed them at the time all survive. Sending them "to be
  // safe" would re-save them as this person's answer, and a note re-sent from a stale page would overwrite
  // a newer one.
  //
  // The flag is the one exception, and it is conditional: "no one was in the bed" and the times are mutually
  // exclusive on the server, and with the times all null a stored flag would simply stay set (the night
  // would still be locked). `nobody_in_bed: false` is sent ONLY when the stored review has it, because
  // sending it also counts as an answer on the server (it resets a dismissal and puts the sender's name on
  // the review), which clearing three times does not. The stored review is read fresh here, not taken from
  // the page's night: that one is overlaid and goes stale on a second phone.
  const removeCorrection = async () => {
    setBusy(true);
    setError(null);
    try {
      const review = await api.get(`/children/${childId}/review/${date}`);
      const body = {
        true_onset_local: null,
        true_wake_local: null,
        true_in_bed_local: null,
        true_onset_transition_id: null,
        true_wake_transition_id: null,
        true_in_bed_transition_id: null,
      };
      // Strictly `=== 1`: the same reading as the server's saidNobody, so a value it would not treat as the
      // flag does not make this send an answer it did not need to.
      if (review?.review?.nobody_in_bed === 1) body.nobody_in_bed = false;
      await api.put(`/children/${childId}/review/${date}`, body);
    } catch (e) {
      // Nothing was removed: the dialog stays locked and says why.
      setError(e?.message || 'Could not remove your correction.');
      setBusy(false);
      return;
    }
    // The save is done, so anything on the page that quotes the correction is stale from here on, whether
    // or not the refresh below works. The detail page's "Thanks — that's recorded" receipt is the one:
    // arriving from a save and pressing Recompute is the natural route to this dialog, and the receipt
    // would go on telling the person the times they have just removed were recorded.
    onCorrectionRemoved?.();
    try {
      // Re-read the saved row so the dialog moves from "locked" to the ordinary before/after preview. The
      // server's `locked` is the authority again, not an assumption that the save worked: a second phone
      // that corrected the night in between would leave it locked, and the dialog must say so.
      const r = await api.get(`/children/${childId}/sleep/${date}?stored=1`);
      // Unlocked now, the dialog shows the before/after comparison, so it needs today's baseline (plan R4).
      const todayRead = pageShowsSaved && r?.locked !== true ? await readTodayPreview() : null;
      setStored(r?.night ?? null);
      setLocked(r?.locked === true);
      setContexts(r?.contexts ?? null);
      setTodayPreview(todayRead ?? null);
      setConfirming(false);
      // The normal (overlaid) read, as `save` does: the page then shows the detector's own night, in the view it
      // was already in (see the header: removing a correction changes no settings).
      const overlaid = await api.get(nightDetailPath(childId, date, settingsView));
      onRecomputed?.(overlaid);
    } catch (e) {
      // The removal HAPPENED (the PUT above succeeded), so this must not read as a failed removal.
      setError(`Your correction was removed, but this page could not refresh (${e?.message || 'network error'}). Close this and reload the page.`);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  // Today's settings for this night, as the dialog compares them (plan R4): the page's night, unless the page is
  // showing the saved settings, in which case the dialog's own today's preview. `todayUnscored` is the PR 3
  // no_data / no_sleep restriction, judged on THAT, never on the page's night.
  const today = pageShowsSaved ? todayPreview : night;
  const todayUnscored = unscoredNight(today);
  // What the "after" column is (the third baseline, see the header): the stored-settings preview while the box is
  // ticked, else today's settings. No table while a preview is loading or names a camera that is gone. (An
  // unscored night's today's-settings side shows its explanation instead of the table, and `canSave` refuses it.)
  const afterNight = useStoredSettings ? preview : today;
  const previewGone = useStoredSettings && preview?.scoring?.problem === 'camera_deleted';
  const showTable = !!afterNight && !previewGone;
  const rows = open && stored && showTable ? [
    ['Fell asleep', fmtTime(stored.onset_at), fmtTime(afterNight.onset_at)],
    ['Woke', fmtTime(stored.wake_at), fmtTime(afterNight.wake_at)],
    ['Asleep', fmtDur(stored.asleep_minutes), fmtDur(afterNight.asleep_minutes)],
    ['Awake', fmtDur(stored.awake_minutes), fmtDur(afterNight.awake_minutes)],
    ['Wake-ups', String(stored.wake_count ?? 0), String(afterNight.wake_count ?? 0)],
  ] : [];
  const changed = !locked && rows.some(([, before, after]) => before !== after);
  const nothingSaved = !locked && open && stored === null;
  // The settings choice, on an unlocked night with a saved row. 'offer': usable saved settings that differ from
  // today's. 'none' (a legacy row: no record) and 'unreadable': shown disabled, with the reason. Identical
  // settings, or no `contexts` from the server: no choice at all.
  let choice = null;
  if (!locked && stored && contexts) {
    if (contexts.stored_state === 'ok' && contexts.differs) choice = 'offer';
    else if (contexts.stored_state === 'none' || contexts.stored_state === 'unreadable') choice = contexts.stored_state;
  }
  // Unscored nights offer ONLY the stored-settings save (plan R1): unticked, their saved row against today's "no
  // data" would read as a change, and a "Save this night" for a row that vanished since the offer would store
  // today's "no data". A preview whose camera is gone builds no table, so `changed` is already false there.
  const canSave = !locked && !(todayUnscored && !useStoredSettings) && (changed || nothingSaved);

  // Ticking fetches the stored-settings preview; unticking goes back to today's settings (`today` above).
  // The box is disabled while a request runs, so two previews cannot race.
  const chooseStored = async (checked) => {
    setError(null);
    setPreview(null);
    setUseStoredSettings(checked);
    if (!checked) return;
    setBusy(true);
    try {
      // `raw=1`: no correction overlay, so this is what a store would write (see the header).
      const r = await api.get(`/children/${childId}/sleep/${date}?context=stored&raw=1`, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      setPreview(r ?? null);
    } catch (e) {
      // A 400 `no_stored_context` means the server no longer has usable settings for this night (another phone
      // changed it after this dialog opened): say so in the server's words and go back to today's settings.
      setUseStoredSettings(false);
      setError(e?.message || 'Could not work this night out with the settings it was saved with.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    const withStored = useStoredSettings;
    // Ticked: the stored settings, bound to the exact record this dialog was shown (`expect_context`, plan R2).
    // Unticked: NOTHING is added, so the request is byte-for-byte the one this dialog always sent.
    const storedSettings = withStored
      ? `&context=stored&expect_context=${encodeURIComponent(stored?.scoring_context ?? '')}`
      : '';
    try {
      // ⚠️ `?store=1` is RAW BY DESIGN (see the route's own comment in children.js): it reports what the
      // detector just saved to sleep_nights, not what the page should show. A parent's correction — a
      // typed time, or "no one was in the bed" — lives in sleep_reviews and is laid over every NORMAL
      // read of a night. Passing the store response straight to `onRecomputed` used to repaint the
      // screen with the detector's raw answer the instant you recomputed, silently undoing whatever
      // correction was showing a moment before — true for a time correction already, and it would have
      // been just as true for the new flag if this had not been fixed (plan review R3). Re-fetching the
      // normal route after the write is what keeps the overlay in force.
      // #361 PR 4a (plan R4): the re-read is the page's DEFAULT view whichever settings were saved, and the page is
      // told to go back to it, so what it shows is the row just written (see the header).
      await api.get(`/children/${childId}/sleep/${date}?store=1&detail=1${storedSettings}`, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      const overlaid = await api.get(nightDetailPath(childId, date, 'auto'));
      onSettingsViewChange?.('auto');
      onRecomputed?.(overlaid);
      setOpen(false);
      setStored(undefined); // force a fresh look next time
    } catch (e) {
      if (e?.data?.reason === 'no_stored_context') {
        setUseStoredSettings(false);
        setPreview(null);
      }
      setError(e?.message || 'Could not save the recomputed night.');
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <>
      <button
        type="button"
        className="btn btn-secondary btn-sm sleep-detail__recompute"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await api.get(`/children/${childId}/sleep/${date}?stored=1`);
            // Plan R4: on a page showing the saved settings, today's baseline comes from its own read. Not on a
            // locked night (no comparison is shown there).
            const todayRead = pageShowsSaved && r?.locked !== true ? await readTodayPreview() : null;
            setStored(r?.night ?? null);
            // Strictly `true`: a server from before this field sends nothing, which must read as unlocked.
            setLocked(r?.locked === true);
            setContexts(r?.contexts ?? null);
            setTodayPreview(todayRead ?? null);
            // Every opening starts on today's settings (#361 Q4): the choice is never remembered.
            setUseStoredSettings(false);
            setPreview(null);
            setConfirming(false);
            setOpen(true);
          } catch (e) {
            setError(e?.message || 'Could not read the saved summary for this night.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={16} aria-hidden="true" /> Recompute this night
      </button>
      {error && !open && <div className="sleep-detail__recompute-error">{error}</div>}
      {/* A corrected night shows the person's times, not ours, so the button can look broken: the owner
          pressed it expecting a wrong time to be replaced, and nothing visible happened. Say where the
          times come from and where to change them. It used to add that recomputing "will not change what
          is shown", which read as harmless; since the lock a corrected night is usually not recomputed at
          all, and the dialog says so when it is locked. This line only makes claims true of every
          corrected night: recomputing never replaces a person's own times. */}
      {night?.corrected && (
        <div className="sleep-detail__recompute-note">
          {/* #521: Recompute is now reachable on a night flagged "no one was in the bed", where there are no
              times to speak of; "these times" would be false there. */}
          {night.nobody_in_bed
            ? 'Your answer that no one was in the bed is kept, and recomputing never replaces it. To change it, use '
            : 'These times are the ones you told us, and recomputing never replaces them. To change them, use '}
          <strong>Change what you told us about this night</strong>.
        </div>
      )}

      {open && (
        <Modal title="Recompute this night" onClose={() => !busy && closeDialog()}>
          {locked && confirming ? (
            // The confirm step lives INSIDE this modal (never window.confirm). It says what the button does
            // and, as important, what it does not: the event answers and the note stay. It must also say that
            // the times are REMOVED rather than hidden (nothing brings them back; "enter them again" is the
            // only way to a correction after this), that the recompute is the app's own estimate and may be
            // wrong (the very thing the person overruled), and that saving a correction locks the night
            // again. Owner's wording requirement for this step.
            <>
              <p style={{ marginTop: 0 }}>
                This removes the times you entered for this night (or your answer that no one was in the
                bed), so the night can be recomputed. They are removed, not hidden. Your answers to the
                events and your note are kept.
              </p>
              <p>
                Recomputing shows the app’s own estimate, which may be wrong. To keep a correction after
                that you will need to enter them again, and a corrected night locks again when you save it.
                The night is not recomputed until you choose to.
              </p>
            </>
          ) : locked ? (
            <p style={{ marginTop: 0 }}>
              This night is locked because you corrected it, so it won’t be recomputed, here or overnight.
              To change it, use <strong>Change what you told us about this night</strong>, or remove your
              correction here to unlock it.
            </p>
          ) : nothingSaved && todayUnscored ? (
            // The offer was made from a saved row that has gone since (another phone, a removed child): there are
            // no saved settings left to use, and today's give this night nothing to save.
            <p style={{ marginTop: 0 }}>
              Nothing is saved for this night any more, so there are no saved settings to use.
            </p>
          ) : nothingSaved ? (
            <p style={{ marginTop: 0 }}>
              Nothing is saved for this night yet, so there is no summary on the child’s page to correct.
              Saving now records the night as it is shown here.
            </p>
          ) : (
            <>
              {/* #361 PR 3: the settings choice (see the header). A real checkbox in a label, so it is
                  reachable by keyboard and named for a screen reader; disabled, with the reason beside it, when
                  this night has no usable record of its settings. */}
              {choice && (
                <div className="recompute-choice">
                  <label className="recompute-choice__option">
                    <input type="checkbox" checked={useStoredSettings} disabled={choice !== 'offer' || busy}
                      onChange={(e) => chooseStored(e.target.checked)} />
                    Use the settings this night was saved with
                  </label>
                  {choice === 'offer' ? (
                    <>
                      <div className="recompute-choice__help"><SettingsCompare contexts={contexts} /></div>
                      <div className="recompute-choice__help">Uses today’s detection rules either way.</div>
                    </>
                  ) : (
                    <div className="recompute-choice__help">
                      {choice === 'none'
                        ? 'This night was saved before the app recorded its settings.'
                        : 'The settings saved with this night can’t be read.'}
                    </div>
                  )}
                </div>
              )}
              {useStoredSettings && !preview ? (
                busy && <p style={{ marginTop: 0 }}>Working the night out with the settings it was saved with…</p>
              ) : previewGone ? (
                <p style={{ marginTop: 0 }}>
                  The camera this night was saved from no longer exists, so the night can’t be worked out with
                  those settings. Nothing will be saved.
                </p>
              ) : todayUnscored && !useStoredSettings ? (
                // Plan R1: today's settings give this night nothing to compare (plan R4: judged on today's
                // settings themselves, which the page may not be showing).
                <p style={{ marginTop: 0 }}>
                  {today?.status === 'no_sleep'
                    ? 'Today’s settings find no clear sleep in this night. '
                    : 'Today’s settings find no data for this night. '}
                  The settings it was saved with may still work.
                </p>
              ) : changed ? (
                <>
                  <p style={{ marginTop: 0 }}>
                    The summary saved for this night — the one on the child’s page — no longer matches what
                    the recorded movement says. Saving replaces it with the figures on the right.
                  </p>
                  <div className="recompute-diff">
                    {rows.map(([label, before, after]) => (
                      <div key={label} className={`recompute-diff__row${before === after ? '' : ' is-changed'}`}>
                        <span className="recompute-diff__label">{label}</span>
                        <span className="recompute-diff__was">{before || '—'}</span>
                        <span className="recompute-diff__arrow" aria-hidden="true">→</span>
                        <span className="recompute-diff__now">{after || '—'}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p style={{ marginTop: 0 }}>
                  The saved summary already matches the recorded movement, so there is nothing to change.
                </p>
              )}
            </>
          )}
          {error && <div className="sleep-detail__recompute-error">{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {locked && confirming ? (
              <>
                <button type="button" className="btn" onClick={() => { setConfirming(false); setError(null); }} disabled={busy}>
                  Keep my correction
                </button>
                <button type="button" className="btn btn-danger" onClick={removeCorrection} disabled={busy}>
                  {busy ? 'Removing…' : 'Remove my correction'}
                </button>
              </>
            ) : (
              <button type="button" className="btn" onClick={closeDialog} disabled={busy}>
                {canSave ? 'Cancel' : 'Close'}
              </button>
            )}
            {locked && !confirming && (
              <button type="button" className="btn btn-secondary" onClick={() => { setError(null); setConfirming(true); }} disabled={busy}>
                Remove my correction
              </button>
            )}
            {canSave && (
              <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : nothingSaved ? 'Save this night' : 'Save the new numbers'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
  // On a night today's settings cannot score, the card around this has no padding of its own (SleepDetail's
  // no-data / no-sleep cards), so the control brings its own. It only renders here once it is offered, so a
  // night without the offer gains no empty space.
  return unscored ? <div className="sleep-detail__recompute-unscored">{body}</div> : body;
}
