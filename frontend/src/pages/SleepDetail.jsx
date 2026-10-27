import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ChevronDown, Moon, DoorOpen, Thermometer, Sparkles, Zap, AudioLines, Play, Video } from 'lucide-react';
import { api } from '../lib/api.js';
import { useCameras } from '../lib/CamerasContext.jsx';
import { useSettings } from '../lib/SettingsContext.jsx';
import AppHeader from '../components/AppHeader.jsx';
import ClipPlayerModal from '../components/ClipPlayerModal.jsx';
import MediaPlayerModal from '../components/MediaPlayerModal.jsx';
import RecomputeNight from '../components/RecomputeNight.jsx';
import ReviewNightButton from '../components/ReviewNightButton.jsx';
import ReviewReceipt from '../components/ReviewReceipt.jsx';
import LoadFailed from '../components/LoadFailed.jsx';
import { showsInBed } from '../lib/inBed.js';
import { nightDetailPath, describeSettings } from '../lib/nightView.js';

// Sleep detail: a to-scale timeline of one night for a child, with the wake-ups marked, plus a date
// picker to browse back through the retained nights (~30 days of activity_samples). Reached by tapping
// the "last night" summary on the child page. Data comes from GET /children/:id/sleep/:date?detail=1,
// which recomputes the night (segments + wake list) from the per-minute activity samples on demand.
//
// #361 PR 4a: WITH WHICH SETTINGS. The page asks with `context=auto`, so a FINISHED night whose saved camera,
// timezone or sleep window differ from today's is worked out with the saved ones (what the child's card shows),
// and the server says so in `night.scoring_view`; every other night is worked out with today's settings, as it
// always was. `settingsView` is the person's switch between the two ('auto' or 'current'): page state only, never
// remembered, back to 'auto' on another child or night and after any Recompute save.

const HISTORY_DAYS = 30; // how far back the underlying activity_samples are retained

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function fmtDur(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

// Colours for the timeline segments — tuned to read on both themes (defined against tokens in CSS).
// 'gap' (issue #442): minutes with no sample at all — a distinct neutral, not folded into 'asleep'
// or any other state, so a camera outage reads as missing data rather than a claim about the child.
const SEG_CLASS = {
  asleep: 'sleep-seg--asleep', stir: 'sleep-seg--stir', wake: 'sleep-seg--wake',
  settling: 'sleep-seg--awake', awake: 'sleep-seg--awake', gap: 'sleep-seg--gap',
};

export default function SleepDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { settings } = useSettings();
  const tz = settings.timezone || 'UTC';
  const { kids } = useCameras();
  const kid = kids.find((k) => k.id === id);

  const [searchParams] = useSearchParams();
  const [maxDate, setMaxDate] = useState(null); // latest browsable night (last completed)
  const [date, setDate] = useState(null); // selected night's local start date
  const [night, setNight] = useState(undefined); // undefined = loading (or failed: see nightError)
  // The failure of the night request, kept apart from `night` (#375). A failed request used to become
  // `null`, the very value the server's "nothing recorded" answer produces, so an outage read as "No sleep
  // data for this night - either it predates tracking...". `night` is now only ever set by an answer.
  const [nightError, setNightError] = useState('');
  const [nightRetry, setNightRetry] = useState(0); // bumped by Retry to re-run the fetch effect
  // #361 PR 4a: 'auto' (the default: a finished night with differing saved settings is shown with them) or
  // 'current' (today's settings, after "Show with today's settings"). See the header.
  //
  // ⚠️ KEYED TO THE CHILD AND NIGHT IT WAS CHOSEN ON, and DERIVED during render, not only reset by an effect. The
  // plan (R5) put a reset in the reset effect below, declared before the fetch effect, to keep the first request for
  // another night from carrying the old view. That alone does not do it: a setState inside an effect only takes
  // effect on the NEXT render, so the fetch effect of the same commit still reads the old value, sends one request
  // with it, and only the re-render fixes it (the first answer is dropped by `alive`, but the request is wrong).
  // Deriving the view from the key makes it 'auto' in the very render that changes the night, so the first request
  // is right; the reset effect then forgets the choice, so coming back to a night does not bring it back either.
  const nightKey = `${id}|${date}`;
  const [viewChoice, setViewChoice] = useState({ key: null, view: 'auto' });
  const settingsView = viewChoice.key === nightKey ? viewChoice.view : 'auto';
  const chooseSettingsView = (view) => {
    // #813: after a failed switch the old night still supplies the button's label, but the requested view
    // is already selected. Pressing that same button must retry instead of setting the same state again.
    if (view === settingsView && nightError) setNightRetry((n) => n + 1);
    else setViewChoice({ key: nightKey, view });
  };
  // The receipt for a correction just saved, when we arrived here from the review screen.
  const [receipt, setReceipt] = useState(null);
  // Bumped each time the receipt is dropped because the correction it quotes was removed (#679). The receipt
  // fetch below remembers the value it started under and discards its answer if it has moved: a GET still
  // in flight when the person removes the correction would otherwise land AFTER `setReceipt(null)` and put
  // the removed times back. A counter, not `alive`: that only flips when the page's date or id changes.
  const receiptRemovals = useRef(0);

  // Local calendar 'today' in the app tz, and the default max = yesterday (a completed night).
  const todayLocal = useMemo(
    () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()),
    [tz]
  );

  // Start on the live night — the one in progress if a window is open (so you land on "tonight · so
  // far"), else the last completed night. That date is also the max the picker allows.
  //
  // ...UNLESS `?date=` names one. Saving a review returns you here, and landing on the live night
  // instead of the night you just corrected meant re-picking the date for every older night you
  // wanted to fix — which is exactly when someone is working through a backlog of them. The param is
  // additive: every existing link into this page has none and is unaffected.
  useEffect(() => {
    let alive = true;
    const fallback = addDays(todayLocal, -1);
    // Only a well-formed local date is honoured; anything else falls through to the live night rather
    // than loading a night that cannot exist.
    const wanted = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') || '') ? searchParams.get('date') : null;
    api.get(`/children/${id}/sleep/live`)
      .then((r) => {
        const nd = r?.night?.night_date || fallback;
        if (!alive) return;
        const max = nd > fallback ? nd : fallback;
        setMaxDate(max);
        // Clamp: the picker will not go past `max`, so neither may a hand-typed or stale URL.
        setDate(wanted && wanted <= max ? wanted : nd);
      })
      .catch(() => {
        if (!alive) return;
        setMaxDate(fallback);
        setDate(wanted && wanted <= fallback ? wanted : fallback);
      });
    return () => { alive = false; };
  }, [id, todayLocal, searchParams]);

  // Forget the night only when the child or the date CHANGES. This used to be the first lines of the fetch
  // effect below, which Retry (nightRetry) also re-runs: Retry on the "may be out of date" banner then blanked
  // a night that was on screen, and a retry that failed again became a blocking first-load error that
  // unmounted NightContent (an open clip modal with it). Declared BEFORE the fetch effect so a date change
  // resets and then fetches within the same commit. (Review finding on PR #716.)
  //
  // #361 PR 4a: the settings view is forgotten here too (see `viewChoice` above for why that is not what keeps the
  // first request for another night right, and what does), so it is never remembered across nights.
  useEffect(() => {
    setNight(undefined);
    setNightError('');
    setViewChoice({ key: null, view: 'auto' });
  }, [id, date]);

  // ONE read of the night, used for the first load, the 2-minute refresh and Retry, always in the page's current
  // settings view (`settingsView` is a dependency, so the switch only sets state and this effect refetches, under
  // its own `alive` guard). The Recompute dialog's re-reads build the same URL (lib/nightView.js).
  useEffect(() => {
    if (!date) return;
    let alive = true;
    const load = () => api.get(nightDetailPath(id, date, settingsView))
      .then((r) => { if (alive) { setNight(r || null); setNightError(''); } })
      // A failed 2-minute refresh leaves the night already on screen in place (stale) rather than blanking it.
      .catch((err) => { if (alive) setNightError(err?.message || 'Request failed'); });
    load();
    // Keep the live (in-progress) night fresh — only the latest night can still be changing.
    const t = date === maxDate ? setInterval(load, 2 * 60 * 1000) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [id, date, maxDate, nightRetry, settingsView]);

  // ⚠️ THE RECEIPT HAS TO FOLLOW YOU HERE, and this is not a nicety.
  //
  // Saving a correction used to land on the child's page, where the morning prompt turns into
  // "Thanks — that's recorded". Sending you to the night you just corrected is better for working
  // through a backlog, but the first attempt at it simply dropped that confirmation — and the e2e
  // suite caught what the unit tests could not. A save that shows nothing is indistinguishable from
  // one that failed, which is the exact report that caused the receipt to be built in the first place.
  //
  // Fetched for THIS date rather than reusing the child page's "pending" card, because that card is
  // about the most recent reviewable night and you may well have just corrected an older one.
  useEffect(() => {
    if (searchParams.get('saved') !== '1' || !date) { setReceipt(null); return; }
    let alive = true;
    const removalsAtStart = receiptRemovals.current;
    // ⚠️ The saved times are under `review`, NOT at the top level: GET /review/:date returns
    // { computed, review, transitions }. Reading them from the root silently yields undefined and the
    // receipt simply never appears — which is what shipped, because the unit test mocked the shape I
    // had assumed rather than the one the route returns. Only e2e, which talks to the real server,
    // could tell the difference.
    api.get(`/children/${id}/review/${date}`)
      .then((r) => {
        if (!alive || removalsAtStart !== receiptRemovals.current) return;
        // ⚠️ Gated on the flag TOO (plan review R4), not only the two times: "no one was in the bed"
        // carries neither, so the original `true_onset_at || true_wake_at` check alone showed nothing
        // after a flag-only save — a successful save that reads exactly like a failed one, the same
        // class of bug the receipt exists to prevent in the first place. `nobody_in_bed` here is the
        // RAW stored column (0/1, same as `dismissed`), not reviewCardState's boolean, hence truthiness.
        // An in-bed-only answer (2026-09-30) is an answer too, and gets a receipt of its own: the gate is
        // no longer "raw onset or wake present" (plan review R1).
        //
        // The receipt reads back ONLY what the parent answered (the review's own `true_*` times), never the
        // detector's: the review now asks one question, and a wake-only answer must not be read back with an
        // asleep time the person never gave (2026-10-27; see ReviewReceipt).
        const rev = r?.review;
        setReceipt(rev && (rev.true_onset_at || rev.true_wake_at || rev.true_in_bed_at || rev.nobody_in_bed)
          ? rev
          : null);
      })
      .catch(() => { /* the receipt is confirmation, not function — never block the night on it */ });
    return () => { alive = false; };
  }, [id, date, searchParams]);

  const minDate = maxDate ? addDays(maxDate, -(HISTORY_DAYS - 1)) : null;
  const canPrev = date && minDate && date > minDate;
  const canNext = date && maxDate && date < maxDate;

  const fmtTime = (utc) => {
    if (!utc) return '';
    const d = new Date(String(utc).replace(' ', 'T') + 'Z');
    return new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  };
  const fmtDateLong = (dstr) => {
    if (!dstr) return '';
    const d = new Date(dstr + 'T00:00:00');
    return new Intl.DateTimeFormat([], { weekday: 'long', day: 'numeric', month: 'short' }).format(d);
  };

  const back = { to: `/children/${id}`, label: kid?.name || 'Child' };

  return (
    <>
      <AppHeader title="Sleep" back={back} />
      <main className="app-main">
        {/* Date navigator */}
        <div className="sleep-nav">
          <button type="button" className="sleep-nav__arrow" disabled={!canPrev}
            onClick={() => canPrev && setDate(addDays(date, -1))} aria-label="Previous night">
            <ChevronLeft size={20} />
          </button>
          <label className="sleep-nav__date">
            <span className="sleep-nav__date-label">
              {date ? fmtDateLong(date) : '…'}
              {night?.in_progress && <span className="sleep-live-badge">so far</span>}
            </span>
            <span className="sleep-nav__date-sub">night of</span>
            {date && (
              <input type="date" className="sleep-nav__date-input" value={date} min={minDate || undefined} max={maxDate || undefined}
                onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Pick a night" />
            )}
          </label>
          <button type="button" className="sleep-nav__arrow" disabled={!canNext}
            onClick={() => canNext && setDate(addDays(date, 1))} aria-label="Next night">
            <ChevronRight size={20} />
          </button>
        </div>

        {receipt && (
          <ReviewReceipt onsetAt={receipt.true_onset_at} wakeAt={receipt.true_wake_at} inBedAt={receipt.true_in_bed_at}
            nobodyInBed={!!receipt.nobody_in_bed}
            fmtTime={fmtTime} onOpen={() => navigate(`/children/${id}/review/${date}`)} />
        )}

        <NightBody night={night} error={nightError} onRetry={() => setNightRetry((n) => n + 1)} fmtTime={fmtTime} tz={tz} tempUnit={settings.temp_unit}
          childId={id} date={date} onRecomputed={setNight} onCorrectionRemoved={() => { receiptRemovals.current += 1; setReceipt(null); }}
          settingsView={settingsView} onSettingsView={chooseSettingsView} />

        <SleepInsights childId={id} tempUnit={settings.temp_unit} childName={kid?.name} />

        <div className="sleep-detail__est">
          <Moon size={13} aria-hidden="true" /> Estimated from movement &amp; sound over the night window — a
          sleep-pattern guide, not a medical measurement.
        </div>
      </main>
    </>
  );
}

function NightBody({ night, error, onRetry, ...rest }) {
  // "Displayable" = something worth keeping on screen beside a stale banner. A null / `no_data` answer is the
  // EMPTY result: its copy ("No sleep data for this night") cannot be verified once a refresh fails, so a
  // failure after it is a blocking `error`, the same rule as loadState (docs/design-language.md, #375). The
  // other statuses (`ok`, `empty`, `no_sleep`, `off`) are real answers and stay as stale. (Review finding on PR #716.)
  const displayable = !!night && night.status !== 'no_data';
  if (!displayable) {
    if (error) return <LoadFailed what="this night" error={error} onRetry={onRetry} />;
    if (night === undefined) return <div className="card"><div className="empty-state" style={{ padding: 20 }}>Loading night…</div></div>;
  }
  // A refresh failed but the last night is still shown: say it may be out of date, then render it as usual.
  // One fragment shape whether or not the banner is there, so NightContent keeps its state (an open clip
  // modal) when the banner comes and goes. The settings line (#361 PR 4a) is a slot of its own in that same
  // shape, so it coming and going does not remount NightContent either. It sits ABOVE NightContent, whose
  // statuses each return early, so it is there for every status that can carry it (plan D4/R3). For a saved
  // camera that no longer exists, the line takes the place of the no-data card's text (NightContent, below).
  // #813: keep it in this slot even when the deleted-camera night changes to today's view, so its button
  // remains the same focused element across the switch.
  return (
    <>
      {error && <LoadFailed what="this night" error={error} onRetry={onRetry} stale />}
      {night?.scoring_view && (
        <SettingsViewLine night={night} onSettingsView={rest.onSettingsView} />
      )}
      <NightContent night={night} {...rest} />
    </>
  );
}

// #361 PR 4a: the saved settings name a camera that has since been deleted, so the replay is `no_data` with
// `scoring.problem` set (never quietly another camera's night: sleepAnalysis.js computeNight).
const savedCameraGone = (night) => night?.scoring?.problem === 'camera_deleted';

// #361 PR 4a: which settings this night was worked out with, and the switch to the other ones. Shown only when the
// server sent `scoring_view`, which it does only for a FINISHED night whose saved camera, timezone or window differ
// from today's, and never for a child whose sleep tracking is off (sleepAnalysis.js computeNightForDisplay, plan R3:
// `off` has nothing to choose between, so no line and no switch; checked here too, so an `off` night never offers
// one). The switch only changes the page's view: SleepDetail's fetch effect does the request.
//
// ⚠️ What the line names are the SETTINGS, from the server's two contexts, with the camera's LIVE name (a deleted one
// reads "a camera that no longer exists"). The timezone it names is the one the night was saved in, while every
// time on the page is shown in today's (the app setting): a stated limit (docs/sleep-tracking.md).
function SettingsViewLine({ night, onSettingsView }) {
  if (!night?.scoring_view || night.status === 'off') return null;
  const v = night.scoring_view;
  const showingSaved = v.applied === 'stored';
  let text;
  if (showingSaved && savedCameraGone(night)) {
    text = 'The camera this night was measured from no longer exists, so it can’t be worked out with those settings.';
  } else if (showingSaved) {
    text = `Worked out with the settings this night was saved with (${describeSettings(v.stored, v.camera_names?.stored)}), `
      + 'using today’s detection rules.'
      // The saved numbers came from older rules: the replay can match the settings but not the rules (plan R3).
      + (v.algo_differs ? ' It was first worked out under earlier detection rules, so the numbers can differ from the child’s card.' : '');
  } else {
    text = `Showing today’s settings (${describeSettings(v.current, v.camera_names?.current)}). `
      + 'The saved summary for this night keeps the settings it was saved with.';
  }
  return (
    <div className="card sleep-settings-view">
      <div className="sleep-settings-view__text">{text}</div>
      <button type="button" className="btn btn-secondary btn-sm sleep-settings-view__switch"
        onClick={() => onSettingsView?.(showingSaved ? 'current' : 'auto')}>
        {showingSaved ? 'Show with today’s settings' : 'Show with the settings this night was saved with'}
      </button>
    </div>
  );
}

function NightContent({ night, fmtTime, tz, tempUnit, childId, date, onRecomputed, onCorrectionRemoved, settingsView, onSettingsView }) {
  // The wake↔alert clip currently open in the shared player (or null). Lives here so it survives a
  // 2-min live refresh of `night` without tearing the modal down mid-watch.
  const [clipFor, setClipFor] = useState(null);
  const [wakeClip, setWakeClip] = useState(null);
  // #361 PR 4a: the page's settings view travels into every Recompute below, so its re-reads keep (or, after a
  // save, reset) the view the page is in.
  const viewProps = { settingsView, onSettingsViewChange: onSettingsView };
  if (night && night.status === 'off') {
    return (
      <div className="card">
        <div className="camera-tile__sub" style={{ padding: 14 }}>
          Sleep tracking is off for this child. Turn it on in their settings to record and see nightly sleep.
        </div>
      </div>
    );
  }
  // #361 PR 3 (plan R1): Recompute on a night TODAY's settings cannot score. The night the feature exists for (its
  // camera turned off, moved or demoted since it was saved) reads exactly like this, and the control used to be
  // unreachable here. RecomputeNight decides for itself whether to show anything: only for an admin, only after
  // its own read finds usable saved settings that differ from today's on an unlocked night, and then it offers
  // only the stored-settings re-score. Otherwise it renders nothing and these cards look as they always did. Not
  // for a null night (nothing to compare) or `off` (tracking is off: nothing is scored either way).
  if (!night || night.status === 'no_data') {
    // #813: the deleted-camera explanation is the stable settings line above this content. Its replay
    // has no generic no-data explanation; only an offered Recompute control belongs below the line.
    if (savedCameraGone(night) && night.scoring_view) {
      return <RecomputeNight childId={childId} date={date} night={night} fmtTime={fmtTime}
        onRecomputed={onRecomputed} onCorrectionRemoved={onCorrectionRemoved} standaloneCard {...viewProps} />;
    }
    return (
      <div className="card">
        <div className="camera-tile__sub" style={{ padding: 14 }}>
          No sleep data for this night — either it predates tracking, or the cameras weren’t running motion/sound
          detection with enough coverage.
        </div>
        {night && <RecomputeNight childId={childId} date={date} night={night} fmtTime={fmtTime}
          onRecomputed={onRecomputed} onCorrectionRemoved={onCorrectionRemoved} {...viewProps} />}
      </div>
    );
  }
  if (night.status === 'no_sleep') {
    return (
      <div className="card">
        <div className="camera-tile__sub" style={{ padding: 14 }}>No clear sleep detected in this night’s window.</div>
        <RecomputeNight childId={childId} date={date} night={night} fmtTime={fmtTime}
          onRecomputed={onRecomputed} onCorrectionRemoved={onCorrectionRemoved} {...viewProps} />
      </div>
    );
  }
  if (night.status === 'empty') {
    // `nobody_in_bed` splits the copy, deliberately NOT `corrected` (code-review finding, 2026-09-29):
    // a detector-empty night can honestly claim full camera coverage, but a PARENT-flagged one cannot —
    // the cameras may have seen the whole night just fine, the parent is simply overruling what the
    // detector made of it, so the coverage claim would be false here. `corrected` alone is too broad a
    // test for that split: a plain TIME correction on a night that was ALREADY `status: 'empty'` also
    // sets `corrected: true` (sleepReviews.js's other `applyCorrection` branch, not `asNobodyInBed`), so
    // keying on `corrected` told a parent who had only fixed a time "You said no one was in the bed" —
    // false. `nobody_in_bed` is true ONLY on the flag path.
    return (
      <div className="card">
        <div className="camera-tile__sub" style={{ padding: 14 }}>
          {night.nobody_in_bed
            ? 'You said no one was in the bed for this night.'
            : `No one in the bed for this night. The cameras watched the whole window `
              + `(${night.coverage_minutes} minutes covered) and saw no one sleeping here, so there’s no sleep to report.`}
        </div>
        {/* The way into the review on an `empty` night, which otherwise returns above the `ok`-night render
            and its `ReviewNightButton`. Two jobs. A flagged night MUST stay reachable here, or the flag could
            never be taken back. And a detector-empty night is the "reverse error" (the detector says empty,
            a child was really there), which #355 made correctable: giving it both an asleep and a wake-up
            time turns it into a scored night (sleepReviews.js, asScoredFromEmpty). Before #355 this was shown
            only on a `corrected` night, so that correction was unreachable from the app (PR #721 review): the
            morning card never asks about an empty night (pendingReview offers `ok` nights only, on purpose),
            and this was the one other way in. The review page opens on its time field with the bedtime
            disclosure already open for a night with no times, so both are offered. Same rule as on an `ok` night: not while the night is in progress
            (nothing is promoted until it is over). Deliberately not added to a morning prompt for every
            empty night. */}
        {!night.in_progress && (
          <div style={{ padding: '0 14px 14px' }}>
            <ReviewNightButton childId={childId} date={date} corrected={night.corrected} />
          </div>
        )}
        {/* #521: Recompute used to be unreachable here, because this branch returns before the `ok`-night
            render below where it lives. An admin who tuned a threshold had no way to ask "does the detector
            still call this night empty?" short of un-flagging the night first. It is the SAME component as on
            an `ok` night, so every guard comes with it and none is re-implemented: admin-only, the dialog
            previews the saved row against this one before anything is written (the second press applies),
            and the server's allowDowngrade / locked refusals still decide what can be stored. A flagged night
            is a corrected night, so it normally opens on "locked" (nothing to recompute until the correction
            is removed). On no_data / no_sleep it is offered only for the stored-settings re-score (#361 PR 3,
            see those branches above): with today's settings those are a coverage or scoring question, not a
            "did the detector change its mind" one. */}
        <div style={{ padding: '0 14px 14px' }}>
          <RecomputeNight childId={childId} date={date} night={night} fmtTime={fmtTime} onRecomputed={onRecomputed}
            onCorrectionRemoved={onCorrectionRemoved} {...viewProps} />
        </div>
      </div>
    );
  }

  const range = night.in_progress
    ? night.wake_at
      ? `${fmtTime(night.onset_at)} – awake since ${fmtTime(night.wake_at)}`
      : `asleep since ${fmtTime(night.onset_at)} (ongoing)`
    : night.wake_at && night.wake_range?.from && night.wake_range?.to
      // "Up between" (the server's wake_range, lib/wakeRange.js): two wake estimates 10+ minutes apart. The
      // server leaves it null for a corrected night (the parent's single time shows) and for a night in
      // progress (handled above), so nothing here re-checks either.
      ? `${fmtTime(night.onset_at)} – up between ${fmtTime(night.wake_range.from)} and ${fmtTime(night.wake_range.to)}`
      : night.wake_at
        ? `${fmtTime(night.onset_at)} – ${fmtTime(night.wake_at)}`
        : `from ${fmtTime(night.onset_at)} · still asleep at ${fmtTime(night.window_end)}`;
  const wakes = night.wakes || [];
  const visits = night.visits || [];
  const hasChildOut = visits.some((v) => v.type === 'child_out');
  const hasRoom = visits.some((v) => v.type !== 'child_out');
  const hasGap = (night.segments || []).some((s) => s.state === 'gap');
  const alerts = night.alerts || [];
  const wakeClips = night.wakeClips || [];
  // Coverage is measured against elapsed time so far for a live night, not the full window.
  const covEnd = night.in_progress && night.as_of ? night.as_of : night.window_end;
  const covPct = Math.round((night.coverage_minutes / Math.max(1, Math.round((utcMs(covEnd) - utcMs(night.window_start)) / 60000))) * 100);

  return (
    <>
      <div className="card sleep-detail__summary">
        <div className="sleep-detail__big">{fmtDurBig(night.asleep_minutes)}<span> asleep{night.in_progress ? ' so far' : ''}</span></div>
        <div className="sleep-detail__stats">
          {/* "In bed" first, so the two times read in the order they happened. Only when the put-down
              is a real minute or more before sleep — see showsInBed for why that check is one-way. */}
          {showsInBed(night) && <Stat label="In bed" value={fmtTime(night.in_bed_at)} />}
          <Stat label={night.in_progress ? 'Asleep' : 'Asleep from → to'} value={range} />
          <Stat label="Wake-ups" value={String(night.wake_count ?? 0)} />
          <Stat label="Longest stretch" value={fmtDurAbbr(night.longest_stretch_minutes)} />
          <Stat label="Coverage" value={`${covPct}%`} />
        </div>
        <RefinedTimes night={night} fmtTime={fmtTime} />
        {night.analysis_camera_name && (
          <div className="sleep-detail__source">
            Measured from <strong>{night.analysis_camera_name}</strong>
          </div>
        )}
        {/* The way into a review for any night, not just the one the card is offering. Without it a
            mistake is permanent. Its own component because `navigate` belongs to whichever component
            calls the hook — inline here it was out of scope and the button silently did nothing. */}
        {!night.in_progress && (
          <ReviewNightButton childId={childId} date={date} corrected={night.corrected} />
        )}
        <RecomputeNight childId={childId} date={date} night={night} fmtTime={fmtTime} onRecomputed={onRecomputed}
          onCorrectionRemoved={onCorrectionRemoved} {...viewProps} />
      </div>

      <div className="card">
        <div className="sleep-detail__section-title">Night timeline</div>
        <Timeline night={night} fmtTime={fmtTime} tz={tz} tempUnit={tempUnit} />
        <div className="sleep-legend">
          <span><i className="sleep-legend__sw sleep-seg--asleep" /> Asleep</span>
          <span><i className="sleep-legend__sw sleep-seg--stir" /> Stirring</span>
          <span><i className="sleep-legend__sw sleep-seg--wake" /> Awake</span>
          <span><i className="sleep-legend__sw sleep-seg--awake" /> Before/after sleep</span>
          {hasGap && <span><i className="sleep-legend__sw sleep-seg--gap" /> No data</span>}
          {hasRoom && <span><i className="sleep-legend__sw sleep-legend__sw--visit" /> Movement outside the bed</span>}
          {hasChildOut && <span><i className="sleep-legend__sw sleep-legend__sw--out" /> Out of bed</span>}
          {(night.transitions || []).length > 0 && (
            <span><i className="sleep-tl__tx sleep-tl__tx--in" style={{ position: 'static', display: 'inline-block', transform: 'none', margin: '0 4px 1px 0', verticalAlign: 'middle' }} /> Got into bed
              <i className="sleep-tl__tx sleep-tl__tx--out" style={{ position: 'static', display: 'inline-block', transform: 'none', margin: '0 4px 0 10px', verticalAlign: 'middle' }} /> Got out of bed</span>
          )}
        </div>
        <ClimateTrack night={night} startMs={utcMs(night.display_start || night.window_start)} endMs={utcMs(night.display_end || night.window_end)} tempUnit={tempUnit} />
      </div>

      <div className="card">
        <div className="sleep-detail__section-title">Wake-ups · {wakes.length}</div>
        {wakes.length === 0 ? (
          <div className="camera-tile__sub" style={{ padding: '2px 2px 4px' }}>No awakenings counted (a stir under 5 minutes doesn’t count).</div>
        ) : (
          <ul className="sleep-wakes">
            {wakes.map((w, i) => (
              <WakeItem key={i} wake={w} hits={alertsInRange(alerts, w.start_at, w.end_at)}
                clip={clipForWake(wakeClips, w.start_at, w.end_at)}
                fmtTime={fmtTime} onPlay={setClipFor} onPlayWake={setWakeClip} />
            ))}
          </ul>
        )}
      </div>

      {visits.length > 0 && (
        <div className="card">
          <div className="sleep-detail__section-title"><DoorOpen size={15} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />Room activity · {visits.length}</div>
          <div className="camera-tile__sub" style={{ margin: '-6px 0 10px' }}>Movement the camera saw away from the bed. Before your child settles and after they get up it&rsquo;s them; in between, it could be them or someone else — the camera can&rsquo;t tell who.</div>
          <ul className="sleep-wakes">
            {visits.map((v, i) => {
              const isOut = v.type === 'child_out';
              return (
                <li key={i} className="sleep-wakes__row">
                  <span className="sleep-wakes__time">{fmtTime(v.start_at)}{v.minutes > 1 ? ` – ${fmtTime(v.end_at)}` : ''}</span>
                  <span className="sleep-visit-right">
                    <span className={`sleep-visit-tag${isOut ? ' sleep-visit-tag--out' : ''}`}>{isOut ? 'Out of bed' : 'Movement outside the bed'}</span>
                    <span className={`sleep-wakes__dur ${isOut ? 'sleep-wakes__dur--out' : 'sleep-wakes__dur--visit'}`}>{fmtDur(v.minutes)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {clipFor && <ClipPlayerModal ev={clipFor} onClose={() => setClipFor(null)} />}
      {wakeClip && (
        <MediaPlayerModal
          title={`Wake-up · ${fmtTime(wakeClip.started_at)}`}
          videoPath={`/recordings/${wakeClip.id}/video`}
          posterPath={`/recordings/${wakeClip.id}/thumb`}
          filename={`wake-${wakeClip.id}.mp4`}
          meta={`Recorded automatically${wakeClip.duration_s ? ` · ${wakeClip.duration_s}s` : ''}`}
          onClose={() => setWakeClip(null)}
        />
      )}
    </>
  );
}

// One wake-up row. Collapsed by default (time + duration + chips); expand it to see the correlated
// alerts and play whatever was recorded.
//
// Most wakes have no alert at all — measured over 101 nights, 53% of them — because the sleep tracker
// counts a minute active on a ~200 ms blip while an alert waits for 2-3 seconds sustained. That used to
// leave a row you couldn't investigate. The automatic wake clip (roadmap 2.4) fills exactly that gap,
// so a wake is expandable when it has EITHER an alert or a clip.
function WakeItem({ wake, hits, clip, fmtTime, onPlay, onPlayWake }) {
  const [open, setOpen] = useState(false);
  const expandable = hits.length > 0 || !!clip;
  const head = (
    <>
      <span className="sleep-wakes__time">{fmtTime(wake.start_at)} – {fmtTime(wake.end_at)}</span>
      <span className="sleep-wakes__headright">
        <span className="sleep-wakes__dur">{fmtDur(wake.minutes)} awake</span>
        {hits.length > 0 && (
          <span className="sleep-wakes__badge">
            <Zap size={11} aria-hidden="true" />{hits.length} alert{hits.length === 1 ? '' : 's'}
          </span>
        )}
        {clip && (
          <span className="sleep-wakes__badge" title="Recorded automatically — this wake did not raise an alert">
            <Video size={11} aria-hidden="true" />clip
          </span>
        )}
        {expandable && <ChevronDown size={16} className={`sleep-wakes__chev${open ? ' is-open' : ''}`} aria-hidden="true" />}
      </span>
    </>
  );
  return (
    <li className={`sleep-wakes__item${expandable ? ' sleep-wakes__item--expandable' : ''}`}>
      {expandable ? (
        <button type="button" className="sleep-wakes__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {head}
        </button>
      ) : (
        <div className="sleep-wakes__head">{head}</div>
      )}
      {open && (
        <ul className="sleep-wakes__alerts">
          {clip && <WakeClipRow clip={clip} fmtTime={fmtTime} onPlay={onPlayWake} />}
          {hits.map((a) => <AlertRow key={a.id} a={a} fmtTime={fmtTime} onPlay={onPlay} />)}
        </ul>
      )}
    </li>
  );
}

// A single correlated alert inside an expanded wake. Shows the snapshot thumbnail (falling back to a
// type icon) + label + time/camera/detail; when a clip was recorded (clip_status === 'ready') the
// thumbnail becomes a play button that opens the same clip player used in the alert feed.
function AlertRow({ a, fmtTime, onPlay }) {
  const hasClip = a.clip_status === 'ready';
  const thumb = a.snapshot ? (
    <img className="sleep-wakes__thumb" src={api.url(`/cameras/alerts/${a.id}/snapshot`)} alt="" loading="lazy" />
  ) : (
    <span className="sleep-wakes__thumb sleep-wakes__thumb--empty" aria-hidden="true"><AlertTypeIcon type={a.type} /></span>
  );
  return (
    <li className="sleep-wakes__alert">
      {hasClip ? (
        <button type="button" className="sleep-wakes__thumbwrap" onClick={() => onPlay(a)}
          aria-label={`Play clip from ${a.camera_name || 'camera'}`}>
          {thumb}
          <span className="sleep-wakes__play" aria-hidden="true"><Play size={13} fill="currentColor" /></span>
        </button>
      ) : (
        <span className="sleep-wakes__thumbwrap">{thumb}</span>
      )}
      <div className="sleep-wakes__alert-body">
        <span className="sleep-wakes__alert-label">{alertLabel(a.type)}{a.clip_status === 'pending' ? ' · recording…' : ''}</span>
        <span className="sleep-wakes__alert-meta">
          {fmtTime(a.created_at)}{a.camera_name ? ` · ${a.camera_name}` : ''}{a.detail ? ` · ${a.detail}` : ''}
        </span>
      </div>
    </li>
  );
}

function Stat({ label, value }) {
  return (
    <div className="sleep-stat">
      <div className="sleep-stat__label">{label}</div>
      <div className="sleep-stat__value">{value}</div>
    </div>
  );
}

// The headline times now come from bed entry/exit detection where a real transition supports them. This
// strip shows what movement & sound ALONE would have reported, and only when the two differ — so the two
// methods can still be compared each morning now that the better one is the default. Older nights
// (computed before the promotion) have no *_algo values and simply show nothing.
function RefinedTimes({ night, fmtTime }) {
  const onsetDiff = night.onset_at_algo && night.onset_at_algo !== night.onset_at;
  const wakeDiff = night.wake_at_algo && night.wake_at_algo !== night.wake_at;
  if (!onsetDiff && !wakeDiff) return null;
  return (
    <div className="sleep-refined">
      <span className="sleep-refined__label"><DoorOpen size={13} aria-hidden="true" /> Movement-only estimate</span>
      {onsetDiff && (
        <span className="sleep-refined__item">
          Asleep <span className="sleep-refined__old">{fmtTime(night.onset_at_algo)}</span><b>{fmtTime(night.onset_at)}</b>
        </span>
      )}
      {wakeDiff && (
        <span className="sleep-refined__item">
          Woke <span className="sleep-refined__old">{fmtTime(night.wake_at_algo)}</span><b>{night.wake_at ? fmtTime(night.wake_at) : '—'}</b>
        </span>
      )}
      <span className="sleep-refined__note">The times above use bed entry/exit detection. Struck through is what movement &amp; sound alone would have reported.</span>
    </div>
  );
}

// The to-scale bar: each segment positioned by its share of the window, plus hour tick labels and
// onset/wake markers so the wake-ups read against a real time axis.
function Timeline({ night, fmtTime, tz, tempUnit }) {
  // The bar spans the night that was actually SLEPT, which can start before the configured window — see
  // display_start in sleepAnalysis. Falls back to the window for an older payload that has neither.
  const startMs = utcMs(night.display_start || night.window_start);
  const endMs = utcMs(night.display_end || night.window_end);
  const totalMs = Math.max(1, endMs - startMs);
  const segs = night.segments || [];

  // Hover bubble: as the cursor (or a finger) moves across the bar, show the time under it, the sleep
  // status at that moment, and — if the room had a sensor — the temperature then. `null` = not hovering.
  const barRef = useRef(null);
  const [hover, setHover] = useState(null);

  const tempSeries = useMemo(
    () => (night.climate?.series || []).filter((p) => p.temperature != null).map((p) => ({ ms: utcMs(p.t), c: p.temperature })),
    [night]
  );
  const toF = tempUnit === 'F';
  const tempUnitLabel = `°${tempUnit || 'C'}`;

  function stateAt(ms) {
    const s = segs.find((seg) => utcMs(seg.from_at) <= ms && ms < utcMs(seg.to_at));
    return (s || segs[ms >= endMs ? segs.length - 1 : 0] || {}).state;
  }
  function tempAt(ms) {
    if (!tempSeries.length) return null;
    let best = tempSeries[0];
    for (const p of tempSeries) if (Math.abs(p.ms - ms) < Math.abs(best.ms - ms)) best = p;
    // Only report a nearby reading (within ~10 min) so we don't label a gap with a far-off temperature.
    if (Math.abs(best.ms - ms) > 10 * 60000) return null;
    const c = best.c;
    return `${(toF ? (c * 9) / 5 + 32 : c).toFixed(1)}${tempUnitLabel}`;
  }
  const fmtMs = (ms) => new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

  function updateHover(clientX) {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const ms = startMs + f * totalMs;
    setHover({ pct: f * 100, time: fmtMs(ms), status: labelFor(stateAt(ms)), temp: tempAt(ms) });
  }

  const ticks = useMemo(() => {
    const out = [];
    // First whole hour at/after the window start (the window is aligned to a local hour, so stepping
    // by 1h keeps local-hour alignment). Label every 2h to avoid clutter.
    let ms = Math.ceil(startMs / 3600000) * 3600000;
    let n = 0;
    for (; ms <= endMs; ms += 3600000, n++) {
      out.push({ pct: ((ms - startMs) / totalMs) * 100, label: n % 2 === 0 ? shortHour(ms, tz) : null });
    }
    return out;
  }, [startMs, endMs, totalMs, tz]);

  const onsetPct = pctOf(night.onset_at, startMs, totalMs);
  const wakePct = night.wake_at ? pctOf(night.wake_at, startMs, totalMs) : null;
  const nowPct = night.in_progress && night.as_of ? pctOf(night.as_of, startMs, totalMs) : null;
  const visits = night.visits || [];
  // Bed entry/exit transitions — clamp to [0,100] since the morning exit can land just past the window
  // end (the shadow-wake lookahead), and drop any that fall well outside the bar.
  const transitions = (night.transitions || [])
    .map((t) => ({ ...t, pct: pctOf(t.at, startMs, totalMs) }))
    .filter((t) => t.pct != null && t.pct >= -1 && t.pct <= 101)
    .map((t) => ({ ...t, pct: Math.max(0, Math.min(100, t.pct)) }));

  return (
    <div className="sleep-tl">
      {/* Moment markers: ▼ got into bed / ▲ got out of bed, from the frame-diff detector. These are
          instants; the round markers below are spans, which is why the wording differs. */}
      {transitions.length > 0 && (
        <div className="sleep-tl__txs">
          {transitions.map((t, i) => (
            <span key={i} className={`sleep-tl__tx ${t.type === 'into_bed' ? 'sleep-tl__tx--in' : 'sleep-tl__tx--out'}`}
              style={{ left: `${t.pct}%` }}
              title={`${t.type === 'into_bed' ? 'Got into bed' : 'Got out of bed'} · ${fmtTime(t.at)}`} />
          ))}
        </div>
      )}
      {/* Room-activity (outside-bed) markers sit above the bar so they read as events, not sleep state. */}
      {visits.length > 0 && (
        <div className="sleep-tl__visits">
          {visits.map((v, i) => (
            <span key={i} className={`sleep-tl__visit${v.type === 'child_out' ? ' sleep-tl__visit--out' : ''}`}
              style={{ left: `${pctOf(v.start_at, startMs, totalMs)}%` }}
              title={`${v.type === 'child_out' ? 'Out of bed' : 'Movement outside the bed'} · ${fmtTime(v.start_at)}`} />
          ))}
        </div>
      )}
      <div className="sleep-tl__barwrap" ref={barRef}
        onMouseMove={(e) => updateHover(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onTouchStart={(e) => updateHover(e.touches[0].clientX)}
        onTouchMove={(e) => updateHover(e.touches[0].clientX)}
        onTouchEnd={() => setHover(null)}
      >
        <div className="sleep-tl__bar">
          {segs.map((s, i) => (
            <div key={i} className={`sleep-seg ${SEG_CLASS[s.state] || 'sleep-seg--awake'}`}
              style={{ width: `${(s.minutes / (totalMs / 60000)) * 100}%` }} />
          ))}
          {onsetPct != null && <span className="sleep-tl__mark" style={{ left: `${onsetPct}%` }} />}
          {wakePct != null && <span className="sleep-tl__mark" style={{ left: `${wakePct}%` }} />}
          {nowPct != null && <span className="sleep-tl__now" style={{ left: `${nowPct}%` }} title="as of now" />}
        </div>
        {hover && (
          <div className="sleep-tl__tip" style={{ left: `${hover.pct}%` }} aria-hidden="true">
            <span className="sleep-tl__tip-time">{hover.time}</span>
            <span className="sleep-tl__tip-status">{hover.status}</span>
            {hover.temp && <span className="sleep-tl__tip-temp"><Thermometer size={11} aria-hidden="true" />{hover.temp}</span>}
          </div>
        )}
        {hover && <span className="sleep-tl__cursor" style={{ left: `${hover.pct}%` }} aria-hidden="true" />}
      </div>
      <div className="sleep-tl__axis">
        {ticks.map((t, i) => (
          <span key={i} className="sleep-tl__tick" style={{ left: `${t.pct}%` }}>
            {t.label && <span className="sleep-tl__tick-label">{t.label}</span>}
          </span>
        ))}
      </div>
      <div className="sleep-tl__ends">
        <span>{fmtTime(night.window_start)}</span>
        <span>{fmtTime(night.window_end)}</span>
      </div>
    </div>
  );
}

// A companion track under the sleep bar: room temperature across the same time axis, so you can read a
// wake against how warm the room was. Line is positioned by each reading's real timestamp (not index),
// keeping it aligned to the timeline above. Temperature is stored in Celsius; converted to the user's
// unit here. Draws nothing when the child's cameras have no sensor (or too few readings).
function ClimateTrack({ night, startMs, endMs, tempUnit }) {
  const climate = night.climate;
  const series = (climate?.series || []).filter((p) => p.temperature != null);
  if (series.length < 2) return null;
  const totalMs = Math.max(1, endMs - startMs);
  const toF = tempUnit === 'F';
  const conv = (c) => (toF ? (c * 9) / 5 + 32 : c);
  const unit = `°${tempUnit || 'C'}`;
  const vals = series.map((p) => conv(p.temperature));
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (max - min < 1) { min -= 0.5; max += 0.5; } // don't pin a near-flat night to the edges
  const span = max - min;
  const H = 46;
  const coords = series.map((p) => {
    const x = Math.max(0, Math.min(100, ((utcMs(p.t) - startMs) / totalMs) * 100));
    const y = H - 5 - ((conv(p.temperature) - min) / span) * (H - 10);
    return [x, y];
  });
  const d = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${d} L${coords[coords.length - 1][0].toFixed(2)} ${H} L${coords[0][0].toFixed(2)} ${H} Z`;

  const fmt1 = (c) => conv(c).toFixed(1);
  const caption = [`avg ${fmt1(climate.temp_avg)}${unit}`];
  if (climate.temp_min != null && climate.temp_max != null) caption.push(`${fmt1(climate.temp_min)}–${fmt1(climate.temp_max)}${unit}`);
  if (climate.humidity_avg != null) caption.push(`${climate.humidity_avg}% humidity`);

  return (
    <div className="sleep-climate">
      <div className="sleep-climate__head">
        <span className="sleep-climate__label"><Thermometer size={13} aria-hidden="true" /> Room temperature</span>
        <span className="sleep-climate__caption">{caption.join(' · ')}</span>
      </div>
      <div className="sleep-climate__chart">
        <svg width="100%" height={H} viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          <path d={area} fill="var(--sleep-temp)" opacity="0.12" />
          <path d={d} fill="none" stroke="var(--sleep-temp)" strokeWidth="2" vectorEffect="non-scaling-stroke"
            strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span className="sleep-climate__hi">{max.toFixed(1)}{unit}</span>
        <span className="sleep-climate__lo">{min.toFixed(1)}{unit}</span>
      </div>
    </div>
  );
}

// Phase 5: temperature ↔ sleep correlation across this child's recent nights. Fetched once per child
// (not per night). Only renders something meaningful once there are enough tracked nights; otherwise it
// nudges to keep tracking (or stays hidden when tracking is off / there's no sensor data at all).
function SleepInsights({ childId, tempUnit, childName }) {
  const [ins, setIns] = useState(undefined); // undefined = loading

  useEffect(() => {
    let alive = true;
    api.get(`/children/${childId}/sleep/insights`)
      .then((r) => { if (alive) setIns(r || null); })
      .catch(() => { if (alive) setIns(null); });
    return () => { alive = false; };
  }, [childId]);

  if (ins === undefined || !ins || ins.status === 'off') return null;

  const toF = tempUnit === 'F';
  const unit = `°${tempUnit || 'C'}`;
  const t = (c) => (c == null ? '' : `${(toF ? (c * 9) / 5 + 32 : c).toFixed(1)}${unit}`);
  const name = childName || 'this child';

  if (ins.status === 'insufficient') {
    // Don't show the card at all until there's at least one tracked night — nothing useful to say yet.
    if (!ins.nights_analyzed) return null;
    return (
      <div className="card sleep-insight">
        <div className="sleep-insight__title"><Sparkles size={15} aria-hidden="true" /> Sleep &amp; room temperature</div>
        <div className="sleep-insight__body">
          Collecting nights — after about {ins.min_nights} tracked nights this will compare {name}’s wake-ups on
          warmer vs cooler nights. {ins.nights_analyzed} so far.
        </div>
      </div>
    );
  }

  const warm = ins.warmer;
  const cool = ins.cooler;

  // #365: the server withholds the verdict until BOTH the cooler and the warmer group have enough nights.
  // Show the counts and no comparison columns: two averages from one or two nights each would read as a
  // finding, which is the thing being held back. The target comes from the server (min_group_nights), so
  // the number is never written in two places.
  if (ins.verdict === 'not_enough_nights') {
    const need = ins.min_group_nights;
    return (
      <div className="card sleep-insight">
        <div className="sleep-insight__title"><Sparkles size={15} aria-hidden="true" /> Sleep &amp; room temperature</div>
        <div className="sleep-insight__body">
          Not enough nights yet to compare {name}’s wake-ups on warmer vs cooler nights. It needs {need} of each:
          so far {cool?.nights ?? 0} cooler and {warm?.nights ?? 0} warmer.
        </div>
      </div>
    );
  }

  let headline;
  if (ins.verdict === 'warm_more_wakes') headline = `Warmer nights tend to mean more wake-ups for ${name}.`;
  else if (ins.verdict === 'warm_fewer_wakes') headline = `Warmer nights actually saw fewer wake-ups for ${name}.`;
  else if (ins.verdict === 'flat') headline = `Room temperature barely changed across these nights, so there’s no clear link to report yet.`;
  else headline = `No clear link between room temperature and ${name}’s wake-ups over these ${ins.nights_analyzed} nights.`;

  return (
    <div className="card sleep-insight">
      <div className="sleep-insight__title"><Sparkles size={15} aria-hidden="true" /> Sleep &amp; room temperature</div>
      <div className="sleep-insight__headline">{headline}</div>
      {warm && cool && ins.verdict !== 'flat' && (
        <div className="sleep-insight__cmp">
          <div className="sleep-insight__col">
            <div className="sleep-insight__col-h"><Thermometer size={13} aria-hidden="true" /> Cooler nights</div>
            <div className="sleep-insight__temp">{t(cool.avg_temp)}</div>
            <div className="sleep-insight__metric">{cool.avg_wakes} wake-ups avg</div>
            <div className="sleep-insight__sub">{fmtDur(cool.avg_asleep_minutes)} asleep · {cool.nights} night{cool.nights === 1 ? '' : 's'}</div>
          </div>
          <div className="sleep-insight__col">
            <div className="sleep-insight__col-h sleep-insight__col-h--warm"><Thermometer size={13} aria-hidden="true" /> Warmer nights</div>
            <div className="sleep-insight__temp">{t(warm.avg_temp)}</div>
            <div className="sleep-insight__metric">{warm.avg_wakes} wake-ups avg</div>
            <div className="sleep-insight__sub">{fmtDur(warm.avg_asleep_minutes)} asleep · {warm.nights} night{warm.nights === 1 ? '' : 's'}</div>
          </div>
        </div>
      )}
      <div className="sleep-insight__foot">
        Based on {ins.nights_analyzed} tracked nights{ins.overall?.avg_humidity != null ? ` · ${ins.overall.avg_humidity}% avg humidity` : ''}.
        A pattern, not a cause — lots of things affect sleep.
      </div>
    </div>
  );
}

// --- small helpers ---
export const utcMs = (s) => new Date(String(s).replace(' ', 'T') + 'Z').getTime();

// The automatic clip recorded at the start of a wake. Deliberately reads as a recording, not an alert:
// nothing was sent to anyone's phone, it was captured so there is something to look at in the morning.
function WakeClipRow({ clip, fmtTime, onPlay }) {
  return (
    <li className="sleep-wakes__alert">
      <button
        type="button"
        className="sleep-wakes__thumbwrap"
        onClick={() => onPlay(clip)}
        aria-label="Play the clip recorded at the start of this wake"
      >
        <img className="sleep-wakes__thumb" src={api.url(`/recordings/${clip.id}/thumb`)} alt="" loading="lazy" />
        <Play size={14} className="sleep-wakes__play" aria-hidden="true" />
      </button>
      <div className="sleep-wakes__alert-main">
        <div className="sleep-wakes__alert-title">
          <Video size={13} className="sleep-wakes__alert-ico" aria-hidden="true" />
          Recorded at the start of this wake
        </div>
        <div className="sleep-wakes__alert-sub">
          {fmtTime(clip.started_at)}
          {clip.duration_s ? ` · ${clip.duration_s}s` : ''} · no alert was sent
        </div>
      </div>
    </li>
  );
}

// The automatic clip belonging to a wake, if one was captured. Matched on time like the alerts are:
// the clip is anchored on the wake's first active minute, so it lands at the very start of the span.
export function clipForWake(clips, startAt, endAt) {
  const s = utcMs(startAt) - ALERT_MARGIN_MS;
  const e = utcMs(endAt) + ALERT_MARGIN_MS;
  return clips.find((c) => {
    const t = utcMs(c.started_at);
    return t >= s && t <= e;
  }) || null;
}

// Detection alerts that fired within a wake's window, allowing a few minutes either side (a wake run is
// trimmed to its active minutes, and an alert can fire just before/after). Keeps ascending order.
const ALERT_MARGIN_MS = 3 * 60000;
export function alertsInRange(alerts, startAt, endAt) {
  const s = utcMs(startAt) - ALERT_MARGIN_MS;
  const e = utcMs(endAt) + ALERT_MARGIN_MS;
  return alerts.filter((a) => {
    const t = utcMs(a.created_at);
    return t >= s && t <= e;
  });
}
export const alertLabel = (type) => (type === 'sound' ? 'Sound' : type === 'motion' ? 'Motion' : type || 'Alert');
function AlertTypeIcon({ type }) {
  const Icon = type === 'sound' ? AudioLines : Zap;
  return <Icon size={13} className="sleep-wakes__alert-ico" aria-hidden="true" />;
}

export const pctOf = (s, startMs, totalMs) => (s ? ((utcMs(s) - startMs) / totalMs) * 100 : null);
export const labelFor = (state) => (state === 'asleep' ? 'asleep' : state === 'stir' ? 'stirring' : state === 'wake' ? 'awake' : state === 'gap' ? 'no data' : 'before/after sleep');
export function shortHour(ms, tz) {
  const s = new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', hour12: true }).format(new Date(ms));
  return s.replace(/\s?AM/i, 'a').replace(/\s?PM/i, 'p');
}
export function fmtDurBig(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
export function fmtDurAbbr(min) { return min ? fmtDurBig(min) : '—'; }
