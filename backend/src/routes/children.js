import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { normalizePhoto } from '../lib/photo.js';
import {
  getStoredNights, computeNight, computeAndStoreNight, currentNightDate, childTracksSleep, sleepInsights,
  nightIsLocked, storeNightBeforeCorrection, reportableSpanMs, MIN_COVERAGE_FRAC, EMPTY_MIN_COVERAGE_FRAC,
} from '../lib/sleepAnalysis.js';
import { startMotionDetector } from '../lib/motionDetector.js';
import { reconcileClipRing } from '../lib/clipCapture.js';
import { deleteRecording } from '../lib/recordings.js';
import { deleteTimelapse, discardAllTimelapseFrames } from '../lib/timelapse.js';
import { TRANSITION } from '../lib/bedTransitions.js';
import { getNightReview, saveNightReview, previewNightReview, inBedAfterOnset, asleepAfterWake, reviewCorrectsNight,
  reviewCardState, localHmToUtcSql, applyVerdicts, applyCorrection, applyCorrections, transitionInstant } from '../lib/sleepReviews.js';

const router = Router();
router.use(requireAuth);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// The UTC shape every timestamp in this database uses. Only used to sanity-check the values the
// client echoes back as "what you showed me"; times a person TYPES arrive as wall-clock 'HH:MM'.
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function withCameras(child) {
  const cameras = db
    .prepare('SELECT id, name, mediamtx_path FROM cameras WHERE child_id = ?')
    .all(child.id);
  return { ...child, cameras };
}

// A child's sleep-tracking state or window changed — (re)evaluate the motion activity leg for each of
// their cameras so it reflects the new setting immediately (rather than waiting up to 5 min for the
// periodic reconcile). startMotionDetector stops then re-checks motionLegWanted, which is now window-
// gated, so this handles both directions: tracking off (or a window that no longer contains now) stops
// the leg; the leg (re)starts here only if the window is currently open, else at bedtime via reconcile.
//
// The clip ring needs the same immediate treatment, for the same reason (issue #387): clipRingWanted
// now depends on childTracksSleep, so flipping "Track sleep" off must stop a wake-only ring right away
// rather than leaving it running until the next periodic reconcile — and turning it on must start one
// immediately rather than leaving the first night's wake unrecorded while nothing buffers.
// Exported (only) for children-clip-ring-reconcile.test.js: startClipCapture spawns ffmpeg, and on any
// machine that HAS one the async spawn failure that empties test PATH races a real HTTP round trip and
// tears down isSegmenterRunning's map entry regardless of what this function does — so the STOP
// direction can only be verified reliably with a direct, same-tick call, not through the route.
export function reconcileChildLegs(childId) {
  for (const cam of db.prepare('SELECT * FROM cameras WHERE child_id = ?').all(childId)) {
    startMotionDetector(cam).catch(() => {});
    reconcileClipRing(cam);
  }
}

router.get('/', (req, res) => {
  const children = db.prepare('SELECT * FROM children ORDER BY created_at').all();
  res.json(children.map(withCameras));
});

// A JSON body can carry any type for `name`, and `.trim()` on a number or an object threw a TypeError, which
// Express turned into a 500 (#541). Cloudflare strips 5xx bodies, so the client saw an empty failure instead of
// a readable message: a bad input is a 400. Absent (`undefined`) and `null` are NOT "not text": a partial PUT
// that omits the name keeps the stored one, and `null` has always been treated like a blank (kept on PUT,
// "required" on POST). The only answers that change are the ones that used to crash (a truthy non-string)
// and a POST of `0` or `false`, which was already a 400 and now says "must be text" instead of "required".
const NAME_NOT_TEXT = 'Name must be text';
const isNotText = (name) => name !== undefined && name !== null && typeof name !== 'string';

router.post('/', (req, res) => {
  const { name, birthday, color, track_sleep, sleep_window_start, sleep_window_end } = req.body || {};
  if (isNotText(name)) return res.status(400).json({ error: NAME_NOT_TEXT });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  let photo;
  try { photo = normalizePhoto(req.body?.photo, null); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (sleep_window_start !== undefined && !HHMM.test(sleep_window_start)) return res.status(400).json({ error: 'Bedtime must be a time like 19:00' });
  if (sleep_window_end !== undefined && !HHMM.test(sleep_window_end)) return res.status(400).json({ error: 'Wake time must be a time like 07:00' });
  const id = uuid();
  db.prepare(
    `INSERT INTO children (id, name, birthday, color, photo, track_sleep, sleep_window_start, sleep_window_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name.trim(),
    birthday || null,
    color || '#F5D9A8',
    photo,
    track_sleep === undefined ? 1 : track_sleep ? 1 : 0,
    sleep_window_start || '19:00',
    sleep_window_end || '07:00'
  );
  res.status(201).json(withCameras(db.prepare('SELECT * FROM children WHERE id = ?').get(id)));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Child not found' });
  const { name, birthday, color, track_sleep, sleep_window_start, sleep_window_end } = req.body || {};
  if (isNotText(name)) return res.status(400).json({ error: NAME_NOT_TEXT });
  let photo;
  try { photo = normalizePhoto(req.body?.photo, existing.photo); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (sleep_window_start !== undefined && !HHMM.test(sleep_window_start)) return res.status(400).json({ error: 'Bedtime must be a time like 19:00' });
  if (sleep_window_end !== undefined && !HHMM.test(sleep_window_end)) return res.status(400).json({ error: 'Wake time must be a time like 07:00' });
  const newTrack = track_sleep === undefined ? existing.track_sleep : track_sleep ? 1 : 0;
  db.prepare(
    `UPDATE children SET name = ?, birthday = ?, color = ?, photo = ?, track_sleep = ?,
       sleep_window_start = ?, sleep_window_end = ? WHERE id = ?`
  ).run(
    name?.trim() || existing.name,
    birthday !== undefined ? birthday : existing.birthday,
    color || existing.color,
    photo,
    newTrack,
    sleep_window_start !== undefined ? sleep_window_start : existing.sleep_window_start,
    sleep_window_end !== undefined ? sleep_window_end : existing.sleep_window_end,
    req.params.id
  );
  // Turning tracking on/off — or moving the window so it no longer contains "now" — changes whether the
  // activity leg should run for this child's cameras right now, so re-evaluate immediately.
  const windowChanged =
    (sleep_window_start !== undefined && sleep_window_start !== existing.sleep_window_start) ||
    (sleep_window_end !== undefined && sleep_window_end !== existing.sleep_window_end);
  if (newTrack !== existing.track_sleep || windowChanged) reconcileChildLegs(req.params.id);
  res.json(withCameras(db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id)));
});

// The night to show on the summary tile: the night IN PROGRESS computed live (capped at "now") if a
// window is currently open, otherwise the latest stored completed night. `scope` tells the UI which it
// is so it can say "Tonight · so far" vs "Last night". Computed on demand — cheap, always fresh.
router.get('/:id/sleep/live', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  if (!childTracksSleep(req.params.id)) return res.json({ scope: 'off', night: null });
  const current = currentNightDate(req.params.id);
  if (current) {
    return res.json({ scope: 'tonight', night: computeNight(req.params.id, current) });
  }
  // Corrections are laid over the stored row — see applyCorrection. A night somebody has told us
  // the truth about must not keep showing the algorithm's version of it.
  const nights = applyCorrections(req.params.id, getStoredNights(req.params.id, 1));
  return res.json({ scope: 'last', night: nights[0] || null });
});

// Phase 5: does room temperature correlate with this child's sleep across their recent nights? A
// warmer-vs-cooler comparison + a correlation coefficient, or an "insufficient"/"off" status. Declared
// before '/:id/sleep/:date' so "insights" isn't captured as a date. Computed on demand from stored nights.
router.get('/:id/sleep/insights', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  res.json(sleepInsights(req.params.id));
});

// Recent stored sleep summaries for a child (newest first) — the "last night" card's data source.
router.get('/:id/sleep', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  const nights = Math.min(60, Math.max(1, parseInt(req.query.nights, 10) || 14));
  res.json({ nights: applyCorrections(req.params.id, getStoredNights(req.params.id, nights)) });
});

// Compute one night on demand for a specific LOCAL start date ('YYYY-MM-DD'). ?detail=1 includes the
// timeline segments + wake list for the Sleep detail view; ?debug=1 also adds the raw per-minute
// timeline (tuning); ?store=1 (admin) persists the recompute; ?stored=1 returns the SAVED row instead
// of computing anything.
router.get('/:id/sleep/:date', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  // The SAVED row, computed once the morning after and never revisited. This is what the child's
  // "last night" card shows, and it is the only thing a recompute can actually change — so it is the
  // only honest "before" to compare against.
  //
  // ⚠️ A RECOMPUTE IS NOT TIME-INVARIANT, so two fresh computes are not a valid before/after either.
  // This used to say comparing a recompute against a recompute "can never differ" (issue #319). It
  // can: `computeNight` analyses an open night only up to `Date.now()` (`inProgress` / `effEndMs`),
  // and a completed night's wake keeps DRIFTING LATER through the morning — measured at 2h40m between
  // two recomputes of the same night in this repo (see lib/sleepReviews.js), and corroborated by the
  // 2026-09-09 holdout scoring. That drift is why `computeAndStoreNight` has an `allowDowngrade`
  // guard: re-scoring is not a neutral operation and can make a night WORSE.
  //
  // ⚠️ RAW ON PURPOSE: no applyCorrection here, unlike every other read of a night in this file. Its
  // only caller is RecomputeNight's stored-vs-fresh comparison, which is a question about what the
  // DETECTOR saved. A parent's correction (typed times, or "no one was in the bed") lives in
  // sleep_reviews and is laid over the night on every normal read. Overlaying it here would make a
  // flagged night's "before" read empty, when the saved row the recompute would replace says otherwise.
  //
  // `locked` (added 2026-09-30, additive): whether this night is locked against recomputation because a
  // parent corrected it, decided HERE by the same function the refusal uses (nightIsLocked). The UI keys
  // on this rather than on `night.corrected` (plan review R8): a corrected night whose saved row is
  // missing or unscored is NOT locked, and Recompute is exactly how that one gets fixed.
  if (req.query.stored === '1') {
    const row = db
      .prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?')
      .get(req.params.id, req.params.date);
    return res.json({ night: row || null, locked: nightIsLocked(req.params.id, req.params.date) });
  }
  const wantStore = req.query.store === '1' && req.user?.role === 'admin';
  if (!wantStore) {
    return res.json(applyCorrection(req.params.id, computeNight(req.params.id, req.params.date, {
      includeTimeline: req.query.debug === '1' || req.query.detail === '1',
    })));
  }
  // Storing a recompute can only ever improve or re-score a night, never un-score one — see the
  // allowDowngrade guard in computeAndStoreNight. A refusal is not a server fault (the night is too old,
  // too little of it was watched, or it no longer scores — below), so it is a 4xx with a readable reason:
  // a 5xx would have its body stripped by Cloudflare and the user would see nothing at all.
  const summary = computeAndStoreNight(req.params.id, req.params.date, { allowDowngrade: false });
  // A night a parent has corrected is locked (see nightIsLocked in sleepAnalysis.js): it is kept as it was
  // when they corrected it, and the owner's rule is that nothing, this button included, re-scores it after
  // that. A 409 with a readable reason, like the other refusals below, because a 5xx body would be
  // stripped by Cloudflare. Checked before `would_downgrade` inside computeAndStoreNight, so a locked night
  // is never told its data "aged out".
  if (summary.refused === 'reviewed') {
    return res.status(409).json({
      error: "This night can't be recomputed: it was corrected in the morning review, and a corrected night "
        + 'is locked. To change it, change or remove the correction ("Change what you told us about this '
        + 'night"). The saved summary has been left as it is.',
      reason: 'reviewed',
    });
  }
  if (summary.refused === 'would_downgrade') {
    // THREE different things reach this refusal, and the message must not claim the wrong one (issue #508;
    // the first version of this split branched on coverage alone and got the third case wrong, found by
    // the #508 code review). The guard refuses ANY scored -> unscored change (SCORED is ok + empty), so the
    // refused summary's STATUS decides the case, and coverage only splits the no_data one:
    //   * `no_data`, coverage 0 -> nothing left to read for the window, which on a browsable night means
    //     its samples have aged out. `aged_out`, the pre-#508 wording, unchanged.
    //   * `no_data`, coverage > 0 -> minutes ARE there, but too few were WATCHED (since #508 a minute the
    //     video never saw is not coverage: a stalled camera whose sound kept running). That covers two
    //     different lines, and the wording has to be true for both: under half the window watched (the
    //     no_data gate), OR a quiet night watched for half to 90% of it, which #508's `empty` guard turns
    //     from "no one in the bed" into no_data. So it names both thresholds instead of claiming one.
    //     It also names aging out, because a night on the retention edge can be PARTLY aged out, which
    //     reads the same from here. `too_little_watched`.
    //   * anything else (`no_sleep`, `off`): the night was watched well enough, but re-scored now it no
    //     longer counts as a scored night — e.g. a stored `ok` that the current rules read as "no clear
    //     sleep". Nothing is missing, so saying the video was missing or the data aged out would be false.
    //     `no_longer_scored`.
    // Telling a user "aged out" about last week's night, or "the video was missing" about a fully watched
    // one, is simply false — the same class of defect #508 exists to remove from the numbers.
    //
    // ⚠️ API-ONLY TODAY: SleepDetail returns early for a fresh `no_data` / `no_sleep` / `empty` night
    // before it ever renders RecomputeNight, so the browser cannot reach this refusal (the e2e spec
    // `08-recompute-night` says so and drives it through this route). The wording is still written for a
    // person, because RecomputeNight shows `error` verbatim if it ever does arrive.
    //
    // ADDED to the response shape, never removed (a running SPA is a deployed client): `error` keeps its
    // meaning and its closing sentence (the e2e spec matches /aged out|left as it is/); `reason`,
    // `status` (what the recompute came out as) and `coverage_minutes` are new, for any client that wants
    // to branch on the case rather than parse prose. Known imprecision, pre-existing: a night whose camera
    // was since unassigned also computes coverage 0 and still gets the "aged out" wording.
    //
    // The two lines are quoted from sleepAnalysis.js's own constants, so the prose cannot drift from them.
    const pct = (frac) => Math.round(frac * 100);
    const watchedSome = summary.coverage_minutes > 0;
    const reason = summary.status !== 'no_data' ? 'no_longer_scored' : watchedSome ? 'too_little_watched' : 'aged_out';
    const READS_AS = { no_sleep: 'no clear sleep', off: 'sleep tracking is off for this child' };
    const MESSAGES = {
      aged_out: "This night can't be re-scored: its minute-by-minute data has aged out (kept 30 days). ",
      too_little_watched:
        `This night can't be re-scored: the camera's video was only seen for ${summary.coverage_minutes} `
        + `minute${summary.coverage_minutes === 1 ? '' : 's'} of it. `
        + 'That is too little to score it the way it now reads (a night needs at least '
        + `${pct(MIN_COVERAGE_FRAC)}% of its window watched to be scored at all, and ${pct(EMPTY_MIN_COVERAGE_FRAC)}% `
        + 'before it can be called "no one in the bed"); the video was missing for the rest, or that part of '
        + 'the data has aged out. ',
      no_longer_scored:
        "This night can't be re-scored: re-scored with the current rules it no longer counts as a scored "
        + `night (it now reads "${READS_AS[summary.status] || summary.status}"). `
        + 'This is not because data is missing or has aged out. ',
    };
    return res.status(409).json({
      error: MESSAGES[reason] + 'The saved summary has been left as it is.',
      reason,
      status: summary.status,
      coverage_minutes: summary.coverage_minutes,
    });
  }
  // ROADMAP §1.6: a follow-up notification already told the parent a specific wake time — refusing to
  // store a recompute that blanks it back to unknown (see computeAndStoreNight's own comment). Found by
  // adversarial review: this refusal used to fall through to a 200 here, so the modal would close and
  // SleepDetail would repaint with numbers that were never actually saved — "a claim that state changed
  // is verified by reading the state back, never by a UI report."
  if (summary.refused === 'would_blank_notified_wake') {
    return res.status(409).json({
      error: 'This night already has a wake time a parent was notified about. Recomputing would have '
        + 'cleared it back to unknown, so nothing was saved — the existing wake time has been left as it is.',
    });
  }
  // The raw recompute, not overlaid, like ?stored=1 above: it reports what the detector just SAVED. A
  // parent's correction is untouched by this write (it lives in sleep_reviews) and still applies on the
  // next normal read of this night.
  res.json(summary);
});

// --- Morning review: what actually happened, from the person who was there --------------------------
//
// Deliberately separate from /sleep/:date. That route is the app's OWN answer and recomputes on every
// call; this one records a human's, and never changes once given. Keeping them apart is what stops the
// ground truth being quietly re-derived from the thing it is supposed to be judging.

// Is there a night waiting to be reviewed? Drives the card on the child's page. Always 200 — "nothing
// to review" is a normal answer, not an error, and a 404 here would light up the console every morning.
router.get('/:id/review/pending', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  res.json(reviewCardState(req.params.id));
});

router.get('/:id/review/:date', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  if (!DATE_ONLY.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  res.json(getNightReview(req.params.id, req.params.date));
});

// Save the night's true times (or "no one was in the bed" instead of them), any per-transition
// verdicts, and/or a dismissal. Every field is optional: dismissing is just a save with nothing else in
// it, which is why one route covers both. Any signed-in user may save, caregivers included, the same
// as every other part of a review.
router.put('/:id/review/:date', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  if (!DATE_ONLY.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const body = req.body || {};
  // `reasons` is additive: an older open tab never sends it, and `undefined` means "unchanged", exactly
  // like `verdicts`. A stale reason cannot survive that tab changing a verdict — the verdict write
  // itself clears it (setTransitionVerdict).
  // `true_in_bed_local` / `true_in_bed_transition_id` (2026-09-30) are additive like `reasons`: a page
  // loaded before them never sends them, `undefined` keeps what is stored, and such a page's old "Put
  // down here" still sends its frame as `true_onset_transition_id` and saves exactly as it always did.
  const {
    true_onset_local: onsetHm, true_wake_local: wakeHm, true_in_bed_local: inBedHm, note, dismissed, verdicts, reasons,
  } = body;

  // Anything not a string reaches better-sqlite3 as an unbindable value and comes back as a 500 whose
  // body Cloudflare strips — the user would see nothing at all. Same reasoning as the verdict check.
  // ⚠️ `typeof` first, not `UTC_TIMESTAMP.test(String(v))` (fix round 3, 2026-10-02, Opus #3 / Codex #2,
  // reproduced by a test): the String of a one-element array is its element, so ['2026-07-02 09:00:00']
  // passed, and the array failed only in the final upsert, a 500 AFTER the verdicts had been written. Checked
  // here, before the typed times below, because those now read the echo (see localHmToUtcSql).
  for (const [label, v] of [['computed_onset_at', body.computed_onset_at], ['computed_wake_at', body.computed_wake_at]]) {
    if (v != null && (typeof v !== 'string' || !UTC_TIMESTAMP.test(v))) {
      return res.status(400).json({ error: `${label} must be 'YYYY-MM-DD HH:MM:SS' in UTC` });
    }
  }

  // The client sends what the person typed — a wall-clock 'HH:MM' — and the server resolves it against
  // the app's configured timezone and the night's date. `undefined` back from localHmToUtcSql means the
  // value was malformed, which is NOT the same as `null` (nothing recorded) and must not be stored as
  // if it were, or a garbled entry would silently become "no ground truth for this night".
  // The asleep and wake times also pass what the page SHOWED for them (the computed_* echo), so a time saved
  // exactly as shown is saved as the instant shown rather than dated by the noon rule (fix round 3, Opus #1:
  // a detected wake after local noon was refused as "before the asleep time"). See localHmToUtcSql. Nothing is
  // echoed for "in bed", which keeps the noon rule. The echo counts only inside the span this child's detector
  // can report for the night (fix round 4, Opus #1 + Codex #1: a calendar-day bound was wrong both ways).
  const echoSpan = reportableSpanMs(req.params.id, req.params.date);
  const onsetHm2 = localHmToUtcSql(req.params.date, onsetHm, body.computed_onset_at, echoSpan);
  const wakeHm2 = localHmToUtcSql(req.params.date, wakeHm, body.computed_wake_at, echoSpan);
  const inBedHm2 = localHmToUtcSql(req.params.date, inBedHm);
  for (const [label, v] of [['true_onset_local', onsetHm2], ['true_wake_local', wakeHm2], ['true_in_bed_local', inBedHm2]]) {
    if (v === undefined) return res.status(400).json({ error: `${label} must be a time like 19:33` });
  }

  // Naming a recorded frame beats typing a time: it is second-accurate rather than rounded from
  // memory, and it records WHICH picture means "they got up". So when a frame is named it WINS over
  // any typed value — the client clears the id the moment somebody edits the time by hand, which keeps
  // exactly one source of truth for each of the moments.
  const onsetFromFrame = transitionInstant(req.params.id, req.params.date, body.true_onset_transition_id);
  const wakeFromFrame = transitionInstant(req.params.id, req.params.date, body.true_wake_transition_id);
  for (const [label, v] of [['true_onset_transition_id', onsetFromFrame], ['true_wake_transition_id', wakeFromFrame]]) {
    if (v === undefined) return res.status(400).json({ error: `${label} is not an event of this night` });
  }
  // The put-down frame must be a GOT-INTO-BED event of this night: "they went into bed" cannot be read
  // off a got-out-of-bed frame. New with this field only; the onset and wake ids keep their old,
  // untyped check (see transitionInstant) so an already-open page cannot start failing.
  const inBedFromFrame = transitionInstant(req.params.id, req.params.date, body.true_in_bed_transition_id, TRANSITION.INTO_BED);
  if (inBedFromFrame === undefined) {
    return res.status(400).json({ error: 'true_in_bed_transition_id is not a got-into-bed event of this night' });
  }
  const onset = onsetFromFrame ?? onsetHm2;
  const wake = wakeFromFrame ?? wakeHm2;
  const inBed = inBedFromFrame ?? inBedHm2;
  if (note != null && typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be text' });
  }

  // "No one was in the bed" for the whole night. Additive: an older open page never sends it, and
  // `undefined` or `null` both mean "not answering this, keep what is stored" (the current client sends
  // explicit nulls for fields it is not answering).
  //
  // A strict boolean, deliberately stricter than `dismissed`'s truthiness. This flag hides the
  // detector's entire night, so a "false" string or a stray 1 from some other client must be refused,
  // not read as a yes.
  const nobodyInBed = body.nobody_in_bed;
  if (nobodyInBed != null && typeof nobodyInBed !== 'boolean') {
    return res.status(400).json({ error: 'nobody_in_bed must be true or false' });
  }
  // Both at once is a contradiction, and guessing which one the person meant would store a claim they
  // did not make (plan review R1). `onset`/`wake` are the RESOLVED times, so an explicit null or an
  // empty field is not a time and does not trip this — which matters, because the review page sends
  // explicit nulls for the times it is not answering (NightReview.jsx's save), and must be able to send
  // them alongside the flag. saveNightReview refuses the same combination on its own, for any caller
  // that skips this route. The in-bed time is one of "the times" for this rule (2026-09-30).
  if (nobodyInBed === true && (onset != null || wake != null || inBed != null)) {
    return res.status(400).json({ error: 'Choose either "no one was in the bed" or the times, not both' });
  }

  // A frame id as the patch stores it: `undefined` (not sent) keeps what is stored, and null or '' is "no
  // frame", exactly as transitionInstant reads them. '' used to become Number('') = 0 here, which
  // saveNightReview reads as a frame: sent beside "no one was in the bed" it tripped the flag-plus-times throw,
  // a 500 whose body Cloudflare strips, and without the flag it stored a frame id of 0 (fix round 2,
  // 2026-09-30). Anything else was already checked by transitionInstant above.
  const frameId = (v) => (v === undefined ? undefined : (v == null || v === '' ? null : Number(v)));
  const patch = {
    // `undefined` means "not supplied, keep what is stored" — a stale card on a second phone sending
    // only `{dismissed:true}` must not blank times a parent entered on the first.
    trueOnsetAt: onsetHm === undefined && body.true_onset_transition_id === undefined ? undefined : onset,
    trueWakeAt: wakeHm === undefined && body.true_wake_transition_id === undefined ? undefined : wake,
    trueOnsetTransitionId: frameId(body.true_onset_transition_id),
    trueWakeTransitionId: frameId(body.true_wake_transition_id),
    trueInBedAt: inBedHm === undefined && body.true_in_bed_transition_id === undefined ? undefined : inBed,
    trueInBedTransitionId: frameId(body.true_in_bed_transition_id),
    // What the person was LOOKING at when they judged, echoed back from the GET. Deliberately not
    // recomputed here — see saveNightReview.
    computedOnsetAt: body.computed_onset_at,
    computedWakeAt: body.computed_wake_at,
    note,
    dismissed,
    // saveNightReview owns the rest of the rule: true nulls the times, and a real time sent with the
    // flag omitted clears it (the newest answer wins). See its comment.
    nobodyInBed,
  };

  // The review this save WOULD leave: its values over whatever is already stored. Every ordering rule below
  // is judged on this, never on the request alone: a put-down saved today has to be checked against an
  // asleep time saved yesterday, or two individually valid saves would store "in bed 19:30, asleep 19:13"
  // between them.
  const merged = previewNightReview(req.params.id, req.params.date, patch);

  // "In bed" after "asleep" is a contradiction (plan review R2). One minute of slack for a frame's seconds
  // against a typed minute; see inBedAfterOnset.
  // ⚠️ KNOWN LIMIT, deploy window only (README): a page loaded before this field existed has no In bed
  // input. If it saves an asleep time earlier than an in-bed time a newer page already stored, it gets this
  // 400 about a field it cannot show or change, until it is reloaded.
  if (inBedAfterOnset(merged)) {
    return res.status(400).json({
      error: '"In bed" can\'t be after "Fell asleep" — they go into bed first. Check both times.',
    });
  }
  // "Asleep" after "up for the day" (fix round 2, 2026-09-30, Opus #4): the same kind of contradiction, with
  // the same minute of slack; see asleepAfterWake. A typed time before 12:00 is the morning after (see
  // localHmToUtcSql), so this is also what a mistyped "07:30" asleep beside a "06:30" wake meets.
  if (asleepAfterWake(merged)) {
    return res.status(400).json({
      error: '"Fell asleep" can\'t be after "Got up for the day". Check both times.',
    });
  }
  // THE STORED NIGHT FILLS IN WHAT THE REVIEW LEAVES OUT, so the two ordering rules above are also checked
  // against it. A time the review does not hold is shown from the night's STORED row (applyCorrection lays
  // the parent's times over it), so a review time can contradict a stored one on the card as surely as one
  // of its own. The same minute of slack, the same rules (inBedAfterOnset / asleepAfterWake).
  //
  // ⚠️ ONLY FOR A SAVE THAT TOUCHES THE TIME BEING JUDGED. These validate what is being saved now, so a later
  // note, event answer or dismissal is never refused over a stored night that has moved since (a review saved
  // before the night's first scored summary is laid over whatever that summary later says). A test pins this.
  //
  // ⚠️ KNOWN LIMIT, documented, not fixed (fix round 3, Codex #3, owner-settled): both read the night as
  // stored BEFORE the store-first step below, which can re-store a still-provisional night. Its times rarely
  // move once the window has closed, but if that pass moves the stored asleep time EARLIER than an in-bed time
  // that passed here (or the stored wake earlier than an asleep time), the card hides the put-down (or shows
  // asleep after up) all the same. The checks are not moved after the store, on purpose: the store must stay
  // after every refusal (see below). README, "Known limits".
  const storedNight = () => db
    .prepare('SELECT onset_at, wake_at FROM sleep_nights WHERE child_id = ? AND night_date = ?')
    .get(req.params.id, req.params.date);

  // In bed against the STORED asleep time, when the review has no asleep time of its own. showsInBed
  // (frontend/src/lib/inBed.js) shows a put-down only when it is at least a minute before the asleep time
  // beside it, so unchecked, a put-down after the stored asleep time saved "fine" and was then silently never
  // shown (fix round 2, Opus #4).
  // Run for a save that GIVES an in-bed time, and (fix round 3, Opus #2 + Codex #1, reproduced by a test) for
  // one that CLEARS the asleep time (`=== null`: `undefined` is "not sent"): a review holding in bed 19:30 and
  // asleep 19:45 is consistent, but clearing the asleep time left in bed 19:30 beside a stored 19:13, hidden.
  // Who reaches it: an old page never sends true_in_bed_*, but it can clear the asleep time over an in-bed
  // time a newer page stored, and gets this 400. The current edit card always sends its asleep field, so it
  // reaches this whenever that field is empty: a night with no detected asleep time, or a parent who emptied
  // it. No stored night (or none with an asleep time): nothing to check against.
  if ((patch.trueInBedAt != null || patch.trueOnsetAt === null) && !merged.true_onset_at) {
    if (inBedAfterOnset({ true_in_bed_at: merged.true_in_bed_at, true_onset_at: storedNight()?.onset_at })) {
      return res.status(400).json({
        error: '"In bed" can\'t be after the time they fell asleep — they go into bed first. Check "In bed", '
          + 'or give "Fell asleep" too.',
      });
    }
  }
  // Asleep against the STORED wake, when the review has no wake time of its own (fix round 3, Codex #1,
  // reproduced by a test): asleep "07:30" (by the noon rule, the morning after) saved fine beside a stored
  // 06:30 wake, and every screen then showed a night ending before it began, its total floored to 0. Only for
  // a save that GIVES an asleep time. No stored night, or no stored wake yet: nothing to check against.
  // NOT checked: a wake saved while the review has no asleep time, against the stored asleep time (the other
  // way round), and an API save that ONLY clears the wake beside an asleep time in the review (the edit card
  // always resends its asleep field with it, so from the screen that save is checked here). Neither was in the
  // round-3 findings; README, "Known limits".
  if (patch.trueOnsetAt != null && !merged.true_wake_at) {
    if (asleepAfterWake({ true_onset_at: merged.true_onset_at, true_wake_at: storedNight()?.wake_at })) {
      return res.status(400).json({
        error: '"Fell asleep" can\'t be after the time they got up for the day. Check "Fell asleep", '
          + 'or give "Got up for the day" too.',
      });
    }
  }

  // ⚠️ Every refusal above this line must stay above it, and so must the store-first step just below.
  // applyVerdicts WRITES, so a 400 after it would leave the verdicts saved while the person is told the
  // save failed.
  //
  // A save that corrects the night also LOCKS it, so a still-provisional night is first re-stored from a
  // fresh compute and the lock then keeps THAT (see storeNightBeforeCorrection / nightIsLocked). It runs
  // HERE, after every refusal and before applyVerdicts, because it runs a full computeNight: done inside
  // saveNightReview (after the verdicts had been written) a compute that threw 500'd a save that had already
  // written its verdicts (fix round 2, 2026-09-30, Opus #6). Now a throw is a 500 with nothing written.
  // applyVerdicts' own refusal of a bad id or label (an API-only mistake: the screen only sends this night's
  // events) comes after it, which is harmless: the store writes no answer and no lock, only the pass the
  // nightly job owes the night anyway (see storeNightBeforeCorrection).
  if (reviewCorrectsNight(merged)) storeNightBeforeCorrection(req.params.id, req.params.date);

  // Verdicts (and the reasons paired with them) are scoped to THIS child and THIS night inside
  // applyVerdicts, and rejected as a batch — except a reason for a non-'wrong' verdict, which it drops.
  const check = applyVerdicts(req.params.id, req.params.date, verdicts, reasons);
  if (check.error) return res.status(400).json({ error: check.error });

  // `storeFirst: false`: done above already, and a second store would compute the night again.
  const review = saveNightReview(req.params.id, req.params.date, patch, { storeFirst: false });
  res.json({ review, verdicts_applied: check.applied, reasons_applied: check.reasons_applied });
});

// ⚠️ DELETING A CHILD MUST TAKE ITS VIDEO WITH IT (issue #259). `timelapses` and `recordings` both
// carry a `child_id`, and neither was touched here — so the rows survived pointing at a child that no
// longer existed, every listing query that filters on the child returned nothing, and the FILES stayed
// on disk forever with no way left to reach them. The schema does not save us either: it has only two
// REFERENCES clauses and neither is on these tables, so there is no ON DELETE to fall back on.
//
// Worst for manual recordings, which have NO retention sweep BY DESIGN — they are keepsakes kept until
// a person deletes them, so deleting the child removed the only route to ever reclaiming that space.
// Storage is the resource this app is most sensitive to; the whole clip-retention system exists
// because the disk fills.
//
// ⚠️ DESTROY, NOT ORPHAN — a deliberate choice between the two the issue offers. Deleting a child is an
// explicit, confirmed act about that child, and a "no child" bucket would be a new surface to build,
// explain and prune. What is NOT acceptable is the third option we had: keeping them forever while
// hiding them. Said plainly in the changelog and docs so nobody meets it as a surprise.
// ⚠️ ADMIN-ONLY, added with the media deletion above (adversarial review of PR #284). This router only
// applied `requireAuth`, so a CAREGIVER could delete a child — verified, it returned 204 — while every
// other destructive route in the app (deleting a camera, a user, an alert) requires an admin. That was
// already wrong; making this call also erase video off the disk is what made it untenable to leave.
router.delete('/:id', requireAdmin, (req, res) => {
  const id = req.params.id;
  // Captured BEFORE the UPDATE below nulls child_id — after it, `WHERE child_id = ?` would find nothing
  // and a wake-only ring on one of these cameras would never be told to stop (issue #387 adversarial
  // review: confirmed clipRingWanted flips true->false across this delete while nothing issues the
  // stop). index.js's periodic reconcile now has a stop branch too, so a miss here would only cost up
  // to 5 minutes rather than leaking forever — but deleting a child is exactly the moment "this camera's
  // wake-only reason is gone" should take effect immediately, same as reconcileChildLegs does elsewhere.
  const affectedCameraIds = db.prepare('SELECT id FROM cameras WHERE child_id = ?').all(id).map((r) => r.id);
  db.prepare('UPDATE cameras SET child_id = NULL WHERE child_id = ?').run(id);
  for (const camId of affectedCameraIds) {
    const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(camId);
    if (cam) reconcileClipRing(cam); // no `else` needed -- a stale id just has nothing to reconcile
  }
  // Before the child row goes, so a failure part-way leaves the child (and its media) still reachable
  // rather than stranding exactly the rows this exists to clean up.
  for (const r of db.prepare('SELECT id FROM recordings WHERE child_id = ?').all(id)) deleteRecording(r.id);
  for (const t of db.prepare('SELECT id FROM timelapses WHERE child_id = ?').all(id)) deleteTimelapse(t.id);
  // Frames for a night still in progress have no timelapses row yet, so the loop above cannot see them.
  discardAllTimelapseFrames(id);
  db.prepare('DELETE FROM children WHERE id = ?').run(id);
  db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(id);
  res.status(204).end();
});

export default router;
