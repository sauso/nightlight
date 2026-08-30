import db from '../db.js';
import {
  computeNight, lastCompletedNightDate, childTracksSleep, zonedToUtc, toSqlUtc,
} from './sleepAnalysis.js';
import { getBedTransitions, setTransitionVerdict, VERDICTS } from './bedTransitions.js';

// What actually happened last night, as told by the person who was there.
//
// Why this exists: every sleep change so far has been judged against the owner's recollection the next
// morning — "around 6am". That was fine while the errors were hours; it stopped being fine when they
// reached ~10 minutes, because the error became smaller than the measurement. Worse, the same handful
// of nights was used to design a change AND to validate it, so nothing was ever held out. This turns a
// morning's recollection into dated, precise, replayable data, captured while it is still fresh.
//
// It is not analysis and it is not a setting: nothing here feeds back into computeNight. It records
// what was true, so a future change can be scored rather than argued about.

export { VERDICTS };

const getReviewStmt = db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?');

const upsertReviewStmt = db.prepare(
  `INSERT INTO sleep_reviews
     (child_id, night_date, true_onset_at, true_wake_at, computed_onset_at, computed_wake_at, note,
      dismissed, reviewed_at)
   VALUES (@child_id, @night_date, @true_onset_at, @true_wake_at, @computed_onset_at, @computed_wake_at,
           @note, @dismissed, datetime('now'))
   ON CONFLICT(child_id, night_date) DO UPDATE SET
     true_onset_at     = excluded.true_onset_at,
     true_wake_at      = excluded.true_wake_at,
     computed_onset_at = excluded.computed_onset_at,
     computed_wake_at  = excluded.computed_wake_at,
     note              = excluded.note,
     dismissed         = excluded.dismissed,
     reviewed_at       = datetime('now')`
);

// The child's cameras in the same order the analysis picks its scoring camera, so the frames shown are
// the ones the decisions were actually made from.
const camsForChild = db.prepare(
  'SELECT id, name FROM cameras WHERE child_id = ? AND disabled = 0 ORDER BY sort_order, id'
);

const appTz = () => db.prepare("SELECT timezone FROM settings WHERE id = 'app'").get()?.timezone || 'UTC';

// The UTC span the review covers: local midday on the night's date to local midday the next day.
//
// ⚠️ This MUST follow settings.timezone, and an earlier version did not — it anchored on a literal
// `${nightDate}T04:00:00Z`, which is midday only in Melbourne. On a default install (settings.timezone
// is 'UTC') that window ended before dawn, so every MORNING transition — the wake, the exact events
// this screen exists to collect — was silently missing from the list. It looked like a working feature
// with a quiet night behind it.
//
// Midday-to-midday rather than the child's configured sleep window, deliberately: the review shows what
// HAPPENED, and an event landing outside the window is exactly the sort of thing worth being able to
// see. `zonedToUtc` carries the DST refinement pass, and `d + 1` is normalised by Date.UTC, so month
// and year ends need no special case.
function nightBounds(nightDate) {
  const tz = appTz();
  const [y, mo, d] = nightDate.split('-').map(Number);
  return {
    startSql: toSqlUtc(zonedToUtc(y, mo - 1, d, 12, 0, tz)),
    endSql: toSqlUtc(zonedToUtc(y, mo - 1, d + 1, 12, 0, tz)),
  };
}

// A wall-clock 'HH:MM' the person read off their own clock -> the UTC timestamp everything else in this
// database is stored as.
//
// Done HERE and not in the browser, deliberately. The rest of the app renders times in the app's
// CONFIGURED timezone, so converting with the browser's zone instead would make a review typed on a
// travelling phone disagree with the card it was correcting — and it would duplicate timezone maths
// that already exists, tested, in sleepAnalysis. `zonedToUtc` carries the DST refinement pass;
// hand-rolling this is how the daylight-saving bug in `localDateStr` got there in the first place.
//
// The night spans midnight, so a bare time is ambiguous: an hour at or after noon belongs to the
// night's own date, an hour before noon to the morning after. That puts 19:33 on the night's date,
// 05:48 on the next morning, and a child put down at 00:30 on the next morning too.
//
// Returns null for empty (nothing recorded) and undefined for malformed. The caller MUST tell those
// apart: storing a garbled time as "nothing" would lose ground truth while looking like a clean save.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function localHmToUtcSql(nightDate, hhmm) {
  if (hhmm == null || hhmm === '') return null;
  const m = HHMM.exec(String(hhmm));
  if (!m) return undefined;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const [y, mo, d] = nightDate.split('-').map(Number);
  return toSqlUtc(zonedToUtc(y, mo - 1, d + (h < 12 ? 1 : 0), h, mi, appTz()));
}

function transitionsFor(childId, nightDate) {
  const cams = camsForChild.all(childId);
  const byId = new Map(cams.map((c) => [c.id, c.name]));
  const { startSql, endSql } = nightBounds(nightDate);
  return getBedTransitions(cams.map((c) => c.id), startSql, endSql).map((t) => ({
    ...t,
    camera_name: byId.get(t.camera_id) || null,
  }));
}

// Everything the review screen needs for one night: what the app currently says, what a person has
// already said, and every recorded transition with whether it has a frame and a verdict.
export function getNightReview(childId, nightDate) {
  const computed = computeNight(childId, nightDate);
  return {
    child_id: childId,
    night_date: nightDate,
    computed: {
      status: computed.status,
      onset_at: computed.onset_at ?? null,
      wake_at: computed.wake_at ?? null,
      asleep_minutes: computed.asleep_minutes ?? null,
      wake_count: computed.wake_count ?? null,
    },
    review: getReviewStmt.get(childId, nightDate) || null,
    transitions: transitionsFor(childId, nightDate),
  };
}

// Save a review.
//
// ⚠️ `computedOnsetAt`/`computedWakeAt` are WHAT THE PERSON WAS LOOKING AT, passed back by the client
// from the GET that filled the form. They are NOT recomputed here, and that is the whole point: a
// completed night's computed wake genuinely moves while the page is open (measured 2026-08-29: 05:51 at
// 08:16 and 08:31 at 09:50, same night, same data, as daytime activity accumulates inside the analysis
// lookahead). An earlier version called computeNight again at save time and stored THAT, so a person
// confirming "yes, 19:40 was right" could have the row record the app as having said nothing at all —
// a confirmation silently becoming a disagreement, in the one table meant to settle such questions.
//
// This does mean trusting the client for those two fields. That is the correct trade here: the value
// being recorded is what the browser displayed, and the browser is the only thing that knows it. They
// are format-validated by the route, and nothing downstream treats them as authoritative about the
// night — only as a record of what was on screen when the judgement was made.
//
// Only keys actually supplied are written; anything left `undefined` keeps its stored value. Without
// that, a stale card on a second device sending `{dismissed:true}` would blank the times and note a
// parent had carefully entered on the first — the two-phones case this app is built for.
export function saveNightReview(childId, nightDate, patch = {}) {
  const existing = getReviewStmt.get(childId, nightDate) || {};
  const pick = (key, val) => (val === undefined ? (existing[key] ?? null) : (val ?? null));
  upsertReviewStmt.run({
    child_id: childId,
    night_date: nightDate,
    true_onset_at: pick('true_onset_at', patch.trueOnsetAt),
    true_wake_at: pick('true_wake_at', patch.trueWakeAt),
    computed_onset_at: pick('computed_onset_at', patch.computedOnsetAt),
    computed_wake_at: pick('computed_wake_at', patch.computedWakeAt),
    note: pick('note', patch.note),
    dismissed: patch.dismissed === undefined ? (existing.dismissed ?? 0) : (patch.dismissed ? 1 : 0),
  });
  return getReviewStmt.get(childId, nightDate);
}

// Apply verdicts, but ONLY to transitions that belong to this child and this night.
//
// ⚠️ The id in the request is not to be trusted on its own. `setTransitionVerdict` updates by primary
// key alone, so without this scoping any authenticated caller could stamp a label on another child's
// event from another month — and because a verdict exempts a row from the 45-day prune, could also pin
// arbitrary rows and their JPEGs on disk forever. These labels are what every future change gets
// measured against; one written from the wrong screen is exactly the corruption this feature exists to
// prevent.
//
// Rejected as a batch rather than partially applied: a half-saved review leaves the person unable to
// tell which of their answers landed.
export function applyVerdicts(childId, nightDate, verdicts) {
  const entries = Object.entries(verdicts || {});
  if (entries.length === 0) return { applied: 0 };
  const allowed = new Set(transitionsFor(childId, nightDate).map((t) => String(t.id)));
  for (const [id, verdict] of entries) {
    if (!allowed.has(String(id))) return { error: `Transition ${id} is not part of this night` };
    if (verdict != null && !VERDICTS.includes(verdict)) return { error: `Not a valid verdict for transition ${id}` };
  }
  let applied = 0;
  for (const [id, verdict] of entries) if (setTransitionVerdict(id, verdict)) applied++;
  return { applied };
}

// A night as it should be SHOWN: the algorithm's answer with any human correction laid over the top.
//
// ⚠️ This is the difference between a feature and a chore. Correcting a night and then watching the
// card keep showing the old, wrong time reads as the app having ignored you — the owner's words on
// first use were "this is actually worse". If a person has told us when their child actually woke,
// that IS the best information available and it is what we should display.
//
// It is NOT fed back into detection: `sleep_nights` still holds the algorithm's own answer, untouched,
// and it is returned alongside as `algo_*` so a future change can still be scored against ground truth.
// Overlaying at display time rather than overwriting the row is what keeps both facts.
//
// `asleep_minutes` is re-derived from the corrected span because the two must agree — a card reading
// "up at 05:29" above "slept 10h 15m" is visibly self-contradictory. Awake minutes are kept as measured
// (we cannot know how a correction redistributes them) and the result is floored at zero.
export function applyCorrection(childId, night) {
  if (!night || !night.night_date) return night;
  const r = getReviewStmt.get(childId, night.night_date);
  if (!r || (!r.true_onset_at && !r.true_wake_at)) return night;

  const onset = r.true_onset_at || night.onset_at;
  const wake = r.true_wake_at || night.wake_at;
  const out = {
    ...night,
    onset_at: onset,
    wake_at: wake,
    corrected: true,
    algo_onset_at: night.onset_at ?? null,
    algo_wake_at: night.wake_at ?? null,
  };
  if (onset && wake) {
    const span = Math.round((Date.parse(`${wake.replace(' ', 'T')}Z`) - Date.parse(`${onset.replace(' ', 'T')}Z`)) / 60000);
    out.asleep_minutes = Math.max(0, span - (night.awake_minutes ?? 0));
  }
  return out;
}

export function applyCorrections(childId, nights) {
  return (nights || []).map((n) => applyCorrection(childId, n));
}

// Is there a night waiting to be reviewed? Drives the card on the child's page.
//
// The most recent scored, unreviewed night within the last week — NOT simply "yesterday". Anchoring on
// yesterday alone means a morning you don't open the app loses that night permanently, and the nights
// most worth asking about are exactly the ones on the days you were too busy to look. A week's backlog
// is the compromise: recent enough that you still remember it, forgiving enough to survive a weekend
// away. Older than that and recollection is no better than the detector's guess, which would poison the
// ground truth this whole table exists to hold.
const REVIEW_BACKLOG_NIGHTS = 7;

const pendingStmt = db.prepare(
  `SELECT n.night_date, n.onset_at, n.wake_at
     FROM sleep_nights n
     LEFT JOIN sleep_reviews r ON r.child_id = n.child_id AND r.night_date = n.night_date
    WHERE n.child_id = ? AND n.status = 'ok' AND n.night_date >= ? AND r.child_id IS NULL
    ORDER BY n.night_date DESC
    LIMIT 1`
);

export function pendingReview(childId) {
  if (!childTracksSleep(childId)) return null;
  // Anchored on the last completed night rather than on `new Date()` so the cutoff uses the app's
  // configured timezone — the same calendar the nights themselves are dated in. Shifting the DATE on
  // the calendar, never the instant: subtracting milliseconds crosses a daylight-saving boundary twice
  // a year and silently drops or repeats a night.
  const anchor = lastCompletedNightDate(childId);
  if (!anchor) return null;
  const [y, m, d] = anchor.split('-').map(Number);
  const cutoff = new Date(Date.UTC(y, m - 1, d - (REVIEW_BACKLOG_NIGHTS - 1))).toISOString().slice(0, 10);

  // Only nights there is something to be right or wrong about: 'no_data' and 'empty' carry no times to
  // confirm, and asking anyway would teach the habit of dismissing the card unread — which would cost
  // exactly the nights that matter. The LEFT JOIN excludes anything already answered OR dismissed.
  const stored = pendingStmt.get(childId, cutoff);
  if (!stored) return null;
  return {
    night_date: stored.night_date,
    onset_at: stored.onset_at,
    wake_at: stored.wake_at,
    transition_count: transitionsFor(childId, stored.night_date).length,
  };
}

// What the card on the child's page should show. Three states, and the middle one exists because a
// prompt that simply VANISHES on save is indistinguishable from one that failed: the owner's first
// report was "it then disappeared and the card didn't update". Answering now leaves a short
// confirmation with a way back in, so a mistake is correctable and a success is visible.
//
//   { state: 'none' }  nothing to say
//   { state: 'ask'  }  a night is waiting to be reviewed
//   { state: 'done' }  last night has been reviewed — show what was recorded, and let them change it
// ⚠️ `pending` is repeated alongside `state` FOR THE CLIENT THAT IS ALREADY OPEN. This response used
// to be `{ pending }` and nothing else; adding `state` and dropping `pending` silently blanked the card
// on every page that had been loaded before the deploy — a phone left open on the child's screen simply
// lost the feature, with no error and nothing to click. The owner hit exactly that, minutes after
// telling me it "feels like a real backwards step", and they were right.
//
// A running SPA is a deployed client you cannot update. Add to a response shape; never take away.
export function reviewCardState(childId) {
  const pending = pendingReview(childId);
  if (pending) return { state: 'ask', pending, ...pending };
  if (!childTracksSleep(childId)) return { state: 'none', pending: null };
  const nightDate = lastCompletedNightDate(childId);
  if (!nightDate) return { state: 'none', pending: null };
  const r = getReviewStmt.get(childId, nightDate);
  // A dismissal is not an answer: there is nothing to confirm back, and re-showing it would defeat
  // the dismissal.
  if (!r || r.dismissed || (!r.true_onset_at && !r.true_wake_at)) return { state: 'none', pending: null };
  return {
    state: 'done',
    pending: null,
    night_date: nightDate,
    true_onset_at: r.true_onset_at,
    true_wake_at: r.true_wake_at,
  };
}
