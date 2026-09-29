import db from '../db.js';
import {
  computeNight, lastCompletedNightDate, childTracksSleep, zonedToUtc, toSqlUtc,
} from './sleepAnalysis.js';
import {
  getBedTransitions, getActivitySamples, getPriorTransitionType, setTransitionVerdict, setTransitionReason,
  VERDICTS, WRONG_REASONS,
} from './bedTransitions.js';
import { findQuickReversals, findAllLingeringBedMotion, LINGERING_WINDOW_MS } from './bedTransitionRules.js';

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

export { VERDICTS, WRONG_REASONS };

const getReviewStmt = db.prepare('SELECT * FROM sleep_reviews WHERE child_id = ? AND night_date = ?');

const upsertReviewStmt = db.prepare(
  `INSERT INTO sleep_reviews
     (child_id, night_date, true_onset_at, true_wake_at, true_onset_transition_id,
      true_wake_transition_id, computed_onset_at, computed_wake_at, note, dismissed, nobody_in_bed,
      reviewed_at)
   VALUES (@child_id, @night_date, @true_onset_at, @true_wake_at, @true_onset_transition_id,
           @true_wake_transition_id, @computed_onset_at, @computed_wake_at, @note, @dismissed,
           @nobody_in_bed, datetime('now'))
   ON CONFLICT(child_id, night_date) DO UPDATE SET
     true_onset_at            = excluded.true_onset_at,
     true_wake_at             = excluded.true_wake_at,
     true_onset_transition_id = excluded.true_onset_transition_id,
     true_wake_transition_id  = excluded.true_wake_transition_id,
     computed_onset_at        = excluded.computed_onset_at,
     computed_wake_at         = excluded.computed_wake_at,
     note                     = excluded.note,
     dismissed                = excluded.dismissed,
     nobody_in_bed            = excluded.nobody_in_bed,
     reviewed_at              = datetime('now')`
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

// The exact instant of a transition the person NAMED as the bedtime or the morning departure, if it
// really belongs to this child and this night.
//
// Pointing at a frame beats typing a time on both counts that matter: it is second-accurate where a
// person rounds from memory, and it records WHICH picture means "they got up", which is the labelled
// pair the detector work needs. The scoping is not optional — an unchecked id would let a review claim
// another child's event, in the one table everything else gets measured against.
//
// Returns the UTC timestamp, null when no frame was named, or undefined when the id is not a
// transition of this night — which the caller must reject rather than quietly store as "no answer".
export function transitionInstant(childId, nightDate, id) {
  if (id == null || id === '') return null;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const match = transitionsFor(childId, nightDate).find((t) => t.id === n);
  return match ? match.created_at : undefined;
}

function transitionsFor(childId, nightDate) {
  const cams = camsForChild.all(childId);
  const byId = new Map(cams.map((c) => [c.id, c.name]));
  const { startSql, endSql } = nightBounds(nightDate);
  const camIds = cams.map((c) => c.id);
  const rows = getBedTransitions(camIds, startSql, endSql);
  // A goodnight kiss (or similar) can read as `out_of_bed` seconds after a genuine `into_bed` — see
  // findQuickReversals's own comment in bedTransitionRules.js for the evidence this is real and common.
  // Flagged here, rather than left for the owner to spot in a list of up to 30 events, because that is
  // what actually gets it labelled: only 1 of 86 such pairs carried a verdict before this (measured
  // 2026-09-13), since nothing had ever drawn attention to the pattern specifically.
  const reversalByOobId = new Map(
    findQuickReversals(rows).map((r) => [r.out_of_bed.id, { into_bed_id: r.into_bed.id, gap_s: Math.round(r.gap_ms / 1000) }])
  );
  // The run's oldest exit supplies the evidence window, while its newest gets the flag.
  // Widen BOTH edges to retain pre-noon anchors and post-noon evidence/returns without
  // scanning the full tables on every review. A prior-type lookup suppresses any leading
  // run whose true anchor is still outside this bounded fetch (plan review, 2026-09-14).
  // ⚠️ KNOWN, ACCEPTED LIMITATION (found in adversarial pre-merge review, a Claude subagent,
  // 2026-09-14, verified with a standalone reproduction): a same-direction run whose OLDEST
  // member sits more than an hour before this boundary while its NEWEST member falls after
  // it can go unreported on BOTH adjacent nights — the earlier night can correctly evaluate
  // it but the reported (newest) id isn't part of that night's own `rows`, and the later
  // night correctly refuses to evaluate it (its own boundary check can't see far enough back
  // to confirm the true anchor, exactly the fabrication guard doing its job). This never
  // fabricates or leaks a flag onto the wrong night — it only means a flag the whole-table
  // `getLingeringBedMotion()` would find can be silently absent from both morning reviews.
  // Same-direction runs are 62% of stored transitions and can plausibly span many hours (see
  // ROADMAP §1.2 item 3), so this is a real if narrow gap, not a contrived one. Not fixed
  // here: correctly attaching the flag to whichever night's page a human would expect it on
  // needs cross-night awareness this function doesn't have, and is out of scope for a
  // diagnostic whose whole posture is "fail toward not flagging" rather than "never miss one".
  const wideStart = toSqlUtc(new Date(Date.parse(`${startSql.replace(' ', 'T')}Z`) - LINGERING_WINDOW_MS));
  const wideEnd = toSqlUtc(new Date(Date.parse(`${endSql.replace(' ', 'T')}Z`) + LINGERING_WINDOW_MS));
  const wideRows = getBedTransitions(camIds, wideStart, wideEnd);
  const wideSamples = getActivitySamples(camIds, wideStart, wideEnd);
  const samplesByCamera = new Map();
  for (const s of wideSamples) {
    if (!samplesByCamera.has(s.camera_id)) samplesByCamera.set(s.camera_id, []);
    samplesByCamera.get(s.camera_id).push(s);
  }
  const boundaryTypeByCamera = new Map(camIds.map((id) => [id, getPriorTransitionType(id, wideStart)]));
  const lingeringByOobId = new Map(
    findAllLingeringBedMotion(wideRows, samplesByCamera, { boundaryTypeByCamera }).map((r) => [r.out_of_bed.id, r])
  );
  return rows.map((t) => ({
    ...t,
    camera_name: byId.get(t.camera_id) || null,
    quick_reversal_of: reversalByOobId.get(t.id)?.into_bed_id ?? null,
    quick_reversal_gap_s: reversalByOobId.get(t.id)?.gap_s ?? null,
    lingering_motion_minutes: lingeringByOobId.get(t.id)?.active_minutes ?? null,
    // Measured from the evaluated (oldest) exit, which can precede this reported transition.
    lingering_motion_gap_s: lingeringByOobId.has(t.id) ? Math.round(lingeringByOobId.get(t.id).gap_ms / 1000) : null,
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
      // The put-down ("in bed") beside onset_at ("asleep"). The review screen needs it as one of the
      // anchors that decide whether a night has a bedtime at all before it groups daytime events —
      // without it here the screen never receives the value, however correctly computeNight returns
      // it (caught by both plan reviewers, 2026-09-25).
      in_bed_at: computed.in_bed_at ?? null,
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
//
// `nobodyInBed` — "no one was in the bed" — and the four true_* fields are MUTUALLY EXCLUSIVE, and this
// is where that is enforced for every caller, not only the route (plan review R1, both reviewers):
//   - A true flag NULLS all four true_* columns. A row saying both "nobody slept here" and "they slept
//     19:40-06:10" would be a contradiction applyCorrection can only resolve by silently ignoring half
//     of it.
//   - A true flag together with a real time is refused with a throw. The route refuses it first with a
//     400, so reaching this throw means a caller skipped validation — a bug, not a user mistake.
//   - A real time with the flag OMITTED clears the flag: the newest answer wins. Without this, an older
//     open page (or a second phone) that has never heard of the flag could save times over a flagged
//     night and have them stored-but-invisible, because the flag would still win at display time.
//   - `null` counts as "not answering", for the flag and the times alike — the current client sends
//     explicit nulls for fields it isn't answering (NightReview.jsx's save), so null must not clear a
//     stored answer any more than `undefined` does.
//   - Explicitly saving the flag (either way) also resets `dismissed` to 0, unless this same save says
//     otherwise: the parent has now answered, and reviewCardState reads a dismissal before anything
//     else, so a dismissed-then-flagged night would never show its receipt.
export function saveNightReview(childId, nightDate, patch = {}) {
  const existing = getReviewStmt.get(childId, nightDate) || {};
  const pick = (key, val) => (val === undefined ? (existing[key] ?? null) : (val ?? null));
  const flagGiven = patch.nobodyInBed != null;
  const timesGiven = [patch.trueOnsetAt, patch.trueWakeAt, patch.trueOnsetTransitionId, patch.trueWakeTransitionId]
    .some((v) => v != null);
  if (flagGiven && patch.nobodyInBed && timesGiven) {
    throw new Error('nobody_in_bed cannot be saved together with a true time or event — pick one');
  }
  const nobody = flagGiven ? (patch.nobodyInBed ? 1 : 0) : timesGiven ? 0 : (existing.nobody_in_bed ?? 0);
  // Applied on EVERY save while the flag stands, not only the one that sets it, so no path through this
  // function can leave a flagged row carrying a time.
  const keepTime = (key, val) => (nobody ? null : pick(key, val));
  upsertReviewStmt.run({
    child_id: childId,
    night_date: nightDate,
    true_onset_at: keepTime('true_onset_at', patch.trueOnsetAt),
    true_wake_at: keepTime('true_wake_at', patch.trueWakeAt),
    true_onset_transition_id: keepTime('true_onset_transition_id', patch.trueOnsetTransitionId),
    true_wake_transition_id: keepTime('true_wake_transition_id', patch.trueWakeTransitionId),
    computed_onset_at: pick('computed_onset_at', patch.computedOnsetAt),
    computed_wake_at: pick('computed_wake_at', patch.computedWakeAt),
    note: pick('note', patch.note),
    dismissed: patch.dismissed !== undefined ? (patch.dismissed ? 1 : 0) : flagGiven ? 0 : (existing.dismissed ?? 0),
    nobody_in_bed: nobody,
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
//
// `reasons` (id -> a WRONG_REASONS value, or null to clear) is WHO it was, for a 'wrong' answer. Folded
// in here rather than a sibling applyReasons() so both maps are validated up front, before anything is
// written, off ONE transitionsFor() scan — a save already walks the night's transitions three times
// (here, and twice via transitionInstant), and it is the costliest call on this path.
//
// Validation is the same batch-refusal as verdicts: an id outside this night, or a reason value that is
// not in WRONG_REASONS, 400s the whole save — a typo'd label is worse than a missing one.
//
// ⚠️ ONE DELIBERATE ASYMMETRY. A well-formed reason for an id whose verdict AFTER THIS SAVE is not
// 'wrong' is DROPPED, not refused. A reader expecting parity with the all-or-nothing verdicts should
// know this is on purpose: the two are paired in the UI, and refusing would make a reason left over
// from a verdict the person has just changed sink every other answer in the save. Dropping it is
// correct, not merely lenient — a reason beside 'correct' would be a label nobody gave.
//
// ⚠️ "After this save" is `Object.hasOwn(verdicts, id) ? verdicts[id] : stored`, NEVER
// `verdicts[id] ?? stored`: an explicit null in `verdicts` CLEARS the verdict, and `??` would fall
// through to a stored 'wrong' and keep a reason for a verdict that no longer exists.
export function applyVerdicts(childId, nightDate, verdicts, reasons) {
  const entries = Object.entries(verdicts || {});
  const reasonEntries = Object.entries(reasons || {});
  if (entries.length === 0 && reasonEntries.length === 0) return { applied: 0, reasons_applied: 0 };
  const byId = new Map(transitionsFor(childId, nightDate).map((t) => [String(t.id), t]));
  for (const [id, verdict] of entries) {
    if (!byId.has(String(id))) return { error: `Transition ${id} is not part of this night` };
    if (verdict != null && !VERDICTS.includes(verdict)) return { error: `Not a valid verdict for transition ${id}` };
  }
  for (const [id, reason] of reasonEntries) {
    if (!byId.has(String(id))) return { error: `Transition ${id} is not part of this night` };
    if (reason != null && !WRONG_REASONS.includes(reason)) return { error: `Not a valid reason for transition ${id}` };
  }
  const given = verdicts || {};
  let applied = 0;
  let reasonsApplied = 0;
  // One transaction, so verdicts and reasons land together or not at all.
  db.transaction(() => {
    for (const [id, verdict] of entries) if (setTransitionVerdict(id, verdict)) applied++;
    for (const [id, reason] of reasonEntries) {
      const resulting = Object.hasOwn(given, id) ? given[id] : byId.get(String(id)).verdict;
      if (resulting !== 'wrong') continue; // dropped on purpose — see above
      if (setTransitionReason(id, reason)) reasonsApplied++;
    }
  })();
  return { applied, reasons_applied: reasonsApplied };
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
// "up at 05:29" above "slept 10h 15m" is visibly self-contradictory. Both awake_minutes AND
// unknown_minutes (issue #442) are kept as measured against the ORIGINAL span rather than recomputed
// against the corrected one — we cannot know how a correction redistributes either. A span recomputed
// as `span - awake_minutes` alone would silently count any camera-outage minutes within the corrected
// span as sleep again, reintroducing the exact bug #442 fixed, the moment a parent corrects a night
// that had one. `unknown_minutes` is NULL on a row computed before that fix shipped, which `?? 0`
// treats the same as a night with no outage — the best available answer for a row with no better
// information, matching how `awake_minutes` is already treated.
//
// ⚠️ KNOWN LIMIT, both directions, found by adversarial review — a documented gap, not a silent one.
// `unknown_minutes` is a single COUNT over the ORIGINAL [onset, sleepEnd), not a set of ranges, so it
// cannot track which specific minutes were unobserved once the span itself moves:
//   - Shrinking the span (e.g. a later corrected onset) still subtracts the FULL original count, even
//     though part of the original outage may now sit outside the corrected span — OVER-subtracts,
//     understating the corrected sleep total. The safer of the two directions: nobody is told a
//     duration is more confident than it is.
//   - Expanding the span BACKWARD past the original onset into territory computeNight() never
//     measured (an outage that happened before the algorithm's own onset, so it was never counted
//     toward unknown_minutes at all) — UNDER-subtracts, silently re-admitting exactly the outage #442
//     exists to exclude, for that specific correction shape.
// A precise fix needs the actual unobserved MINUTE RANGES persisted, not one aggregate count, and a
// real recompute against them — a materially bigger change than this fix's scope. Not attempted here.
// The result is floored at zero.
//
// "NO ONE WAS IN THE BED" (sleep_reviews.nobody_in_bed) is checked BEFORE the times. It carries no
// times at all — saving it nulls them — so the old "no true_onset_at and no true_wake_at, so nothing to
// do" early return would have swallowed it whole and the flag would have done nothing anywhere (plan
// review; the tests pin this). See asNobodyInBed for what the night becomes.
export function applyCorrection(childId, night) {
  if (!night || !night.night_date) return night;
  const r = getReviewStmt.get(childId, night.night_date);
  if (!r) return night;
  if (r.nobody_in_bed) {
    // Plan review R8. An `off` night had tracking disabled: nothing was measured, so there is no
    // detector claim to overrule, and turning "we weren't watching" into "we watched and nobody was
    // there" would invent an observation. A night still IN PROGRESS is the live "tonight so far" view,
    // which must show what the cameras see right now — the flag takes effect once the night is over.
    if (night.status === 'off' || nightNotOverYet(night)) return night;
    return asNobodyInBed(night);
  }
  if (!r.true_onset_at && !r.true_wake_at) return night;

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
    out.asleep_minutes = Math.max(0, span - (night.awake_minutes ?? 0) - (night.unknown_minutes ?? 0));
  }
  return out;
}

export function applyCorrections(childId, nights) {
  return (nights || []).map((n) => applyCorrection(childId, n));
}

// The sleep CLAIMS a detector-`empty` night carries as null. They are exactly the fields computeNight's
// EMPTY BED early return leaves at `base`'s null defaults (sleepAnalysis.js), and so exactly the columns
// upsertNight stores as NULL for such a night, including the shadow and algo figures (plan review R7).
// Everything NOT listed is an OBSERVATION about the night and is kept as measured: its window, how many
// minutes the camera actually saw (coverage_minutes), the room's temperature, which camera scored it, and
// what the parent was already notified. "Nobody was in the bed" is a statement about the child. It says
// nothing about whether the camera was watching, and a detector-empty night keeps all of those too.
//
// ⚠️ A sleep claim or detail-only field added to sleep_nights or computeNight later must be listed here,
// or it leaks onto a night the parent said was empty. The shape tests in nobody-in-bed.test.js exist to
// catch that, and they read the schema (PRAGMA) and a real detector-empty computeNight output rather than
// a list: a new sleep_nights column fails them until it is classified, and a new computeNight key fails
// them if it leaks (as long as the test's `ok` night gives it a value). A new OBSERVATION key on
// computeNight's `base` is kept automatically, which is the right default for those.
const EMPTY_NIGHT_NULLS = [
  'onset_at', 'wake_at', 'in_bed_at',
  'onset_at_shadow', 'wake_at_shadow', 'onset_at_algo', 'wake_at_algo',
  'asleep_minutes', 'awake_minutes', 'unknown_minutes', 'wake_count', 'longest_stretch_minutes',
];
// The detail view's per-minute extras (`?detail=1`). computeNight builds these only AFTER it has decided
// the night is `ok`, so a detector-empty night never has them. Removed rather than nulled, so a flagged
// night's response has the same keys as a detector-empty one, not the same keys with nulls in them.
const SCORED_NIGHT_DETAIL = [
  'transitions', 'timeline', 'wakes', 'visits', 'segments', 'display_start', 'display_end', 'alerts', 'wakeClips',
];

// The night exactly as a detector-`empty` night of the same window would read, plus what the parent
// overruled. `corrected: true` is what tells the UI this came from a parent and not the cameras, so its
// copy can say "you said" instead of claiming the cameras "saw no one sleeping here". `algo_status`,
// `algo_onset_at` and `algo_wake_at` keep the detector's own answer visible alongside, the same way a
// time correction keeps `algo_*`, and `sleep_nights` itself is never touched, so un-flagging restores
// the detector's night exactly.
//
// Applied whatever the stored status was (`ok`, `no_sleep`, `no_data`, or already `empty`). The UI
// attributes it to the parent, so it stays honest either way.
//
// `nobody_in_bed: true` is its OWN field, separate from `corrected` (code-review finding, 2026-09-29):
// a time correction on a night already `status:'empty'` ALSO sets `corrected: true` (see the branch
// below), so a frontend that keyed its "you said no one was in the bed" copy on `corrected` alone would
// mislabel a night where a parent had only fixed a time. This field is the one thing that's true only
// on THIS path.
function asNobodyInBed(night) {
  const out = { ...night };
  for (const k of EMPTY_NIGHT_NULLS) out[k] = null;
  for (const k of SCORED_NIGHT_DETAIL) delete out[k];
  out.status = 'empty';
  out.corrected = true;
  out.nobody_in_bed = true;
  out.algo_status = night.status ?? null;
  out.algo_onset_at = night.onset_at ?? null;
  out.algo_wake_at = night.wake_at ?? null;
  return out;
}

// Is this night's window still open? computeNight's output says so directly (`in_progress`). A STORED
// row has no such column, so for those it is read off window_end. An admin `?store=1` for tonight's
// date is the one way a still-running night gets into sleep_nights, and it must not slip past R8.
function nightNotOverYet(night) {
  if (typeof night.in_progress === 'boolean') return night.in_progress;
  const endMs = night.window_end ? Date.parse(`${night.window_end.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(endMs) && Date.now() < endMs;
}

// Is last night waiting to be reviewed? Drives the card on the child's page.
//
// ⚠️ THE CARD IS ABOUT THE LAST COMPLETED NIGHT AND NOTHING ELSE. An earlier version offered the most
// recent UNREVIEWED night within a week, which sounded generous and behaved terribly: every answer or
// dismissal made the card jump to an older night, so it walked backwards through the week while the
// night you actually wanted was no longer on offer. The owner hit exactly that — "the card I
// originally selected for 5.49 is now gone" — with the night they wanted to correct unreachable.
//
// A card that is always about last night is predictable. Older nights are reached from the sleep
// detail page's own button (ReviewNightButton), which is where you already are when you notice a night
// looks wrong, and which can reach ANY night the date picker offers rather than only unreviewed ones.
export function pendingReview(childId) {
  if (!childTracksSleep(childId)) return null;
  const nightDate = lastCompletedNightDate(childId);
  if (!nightDate) return null;
  if (getReviewStmt.get(childId, nightDate)) return null; // answered or dismissed — stop asking

  // Only a night there is something to be right or wrong about. 'no_data' and 'empty' carry no times to
  // confirm, and asking anyway would teach the habit of dismissing the card unread — which would cost
  // exactly the nights that matter.
  const stored = db
    .prepare("SELECT status, onset_at, wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ? AND status = 'ok'")
    .get(childId, nightDate);
  if (!stored) return null;
  return {
    night_date: nightDate,
    onset_at: stored.onset_at,
    wake_at: stored.wake_at,
    transition_count: transitionsFor(childId, nightDate).length,
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
  // the dismissal. "No one was in the bed" IS an answer even though it carries no times. Without it
  // here, a parent who flagged last night would see the card simply vanish, which is the "did it
  // save?" failure this state exists to prevent.
  if (!r || r.dismissed || (!r.true_onset_at && !r.true_wake_at && !r.nobody_in_bed)) return { state: 'none', pending: null };
  return {
    state: 'done',
    pending: null,
    night_date: nightDate,
    true_onset_at: r.true_onset_at,
    true_wake_at: r.true_wake_at,
    // Additive (never break open clients). A page loaded before this existed ignores the field and,
    // finding no times, renders its receipt as "You said — to —" (ReviewReceipt.jsx's '—' fallback).
    // That is still a visible "recorded" with a way back in, and it lasts only until that page reloads.
    nobody_in_bed: !!r.nobody_in_bed,
  };
}
