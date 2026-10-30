import fs from 'fs';
import path from 'path';
import db from '../db.js';
import { logger } from './logger.js';
import { captureSnapshot, fetchHttpSnapshot } from './snapshot.js';
import { dataDirFrom, resolveSnapshotDir, TRANSITION_SNAPSHOTS_DIR } from './dataPaths.js';
import {
  findQuickReversals,
  findAllLingeringBedMotion,
  LINGERING_WINDOW_MS,
  LINGERING_MIN_ACTIVE_MINUTES,
} from './bedTransitionRules.js';

// Persisted bed-boundary transitions from the frame-diff detector — a child leaving the bed
// ('out_of_bed') or being placed into it ('into_bed'). These are the durable form of the [oob]/[intobed]
// log lines: a low-rate, meaningful signal (not raw motion), kept in their own table so they never
// pollute the cooldown-throttled detection_events alert feed. sleepAnalysis.js reads them to correct the
// sleep onset and morning wake (see its shadow computation). LOG-ONLY at the alert layer still — nothing
// here pushes or records a clip.

export const TRANSITION = {
  OUT_OF_BED: 'out_of_bed',
  INTO_BED: 'into_bed',
};

// Retained a bit longer than the 30-day activity_samples window so a recompute of any browsable night
// still has its transitions. Cheap rows, so this is generous.
const MAX_AGE_DAYS = 45;

// The frame each transition fired on, kept on disk rather than in the DB (the same split
// detection_events uses) so the SQLite file stays small and a prune is a file delete.
//
// Why capture at all: the detector says WHEN it thinks the bed changed, and until now there was no way
// to see what it was looking at when it decided. Measured 2026-08-29 across 238 stored transitions,
// 147 of them — 62% — are physically impossible on sequence alone: two `into_bed` in a row, or two
// `out_of_bed`, with nothing in between. At least one of every such pair is wrong, so the database can
// already point at its own mistakes; what was missing was the evidence to diagnose them. That evidence
// is also what any occupancy classifier has to be measured against, because the question that decides
// whether such a thing is worth shipping is not "how accurate is it on random frames" but "is it right
// on the frames the detector got wrong".
//
// #553 phase 2a: DATA_DIR/private/transition-snapshots once the start-up move has run (it moves the folder WITH the
// database, since the JPEGs are named by its row ids), the top-level one before that (lib/dataPaths.js,
// resolveSnapshotDir). The mkdir below never has to make private/ itself: db.js, imported first, already has.
const SNAPSHOT_DIR = resolveSnapshotDir(TRANSITION_SNAPSHOTS_DIR, dataDirFrom());
export { SNAPSHOT_DIR as TRANSITION_SNAPSHOT_DIR };
try {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
} catch (err) {
  logger.error('Failed to create transition-snapshots dir:', err.message);
}

// ids are integer autoincrement — coerce and validate so nothing can escape the directory.
function snapshotFile(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return path.join(SNAPSHOT_DIR, `${n}.jpg`);
}

// The path alone, existing or not: for a delete, which must not use an existence check that answers "no" for a
// file it merely cannot stat (lib/entityPurge.js, #719 re-review).
export { snapshotFile as transitionSnapshotFile };

export function transitionSnapshotPath(id) {
  const file = snapshotFile(id);
  return file && fs.existsSync(file) ? file : null;
}

const insertStmt = db.prepare(
  `INSERT INTO bed_transitions (camera_id, type, peak, out_peak, out_frames)
   VALUES (@camera_id, @type, @peak, @out_peak, @out_frames)`
);
const markSnapshotStmt = db.prepare('UPDATE bed_transitions SET snapshot = 1 WHERE id = ?');
const camForSnapshotStmt = db.prepare(
  'SELECT id, name, snapshot_url, mediamtx_path FROM cameras WHERE id = ?'
);
// Rows about to age out that carry an image, so the JPEGs go with them and never orphan on disk.
//
// A transition somebody has JUDGED is exempt from the sweep, deliberately. The 45-day window exists to
// stop an unbounded table of machine-generated guesses; a frame a person has labelled is the opposite
// of that — it is the scarce thing, the ground truth an occupancy check would have to be measured
// against, and it accrues at a handful a night. Dropping those on a timer would defeat the point of
// collecting them. Unreviewed rows still age out normally, so the table stays bounded in practice.
const AGED_UNJUDGED = `created_at < datetime('now', ?) AND verdict IS NULL`;
const agedWithSnapshotStmt = db.prepare(
  `SELECT id FROM bed_transitions WHERE ${AGED_UNJUDGED} AND snapshot = 1`
);
const pruneByAgeStmt = db.prepare(`DELETE FROM bed_transitions WHERE ${AGED_UNJUDGED}`);

// Grab the frame and attach it. Deliberately fire-and-forget and fully swallowed: the detector runs
// several times a second and a camera that is slow to answer must never delay it, and a transition
// with no picture is still a perfectly good transition. Same source preference as an alert snapshot —
// the camera's own HTTP endpoint when it has one (instant, full frame), else a one-shot ffmpeg grab
// off the already-published local stream (no extra hit on the camera).
async function attachSnapshot(id, cameraId) {
  try {
    const cam = camForSnapshotStmt.get(cameraId);
    if (!cam) return;
    let buf = null;
    if (cam.snapshot_url) buf = await fetchHttpSnapshot(cam.snapshot_url).catch(() => null);
    if (!buf && cam.mediamtx_path) buf = await captureSnapshot(cam.mediamtx_path).catch(() => null);
    if (!buf || !buf.length) return;
    const file = snapshotFile(id);
    if (!file) return;
    await fs.promises.writeFile(file, buf);
    // The row can be gone by now (#719 review, reproduced): the grab above can take seconds, and removing the
    // child or camera in that window deletes the row first, so this write put back a frame no row names, still
    // served by id. The UPDATE runs straight after the write with no await between, so a row it does not find
    // is gone for good: remove the file just written. (A failure here is logged by the catch below.)
    if (markSnapshotStmt.run(id).changes === 0) fs.rmSync(file, { force: true });
  } catch (err) {
    logger.info(`[bedtx] snapshot for transition ${id} failed: ${err.message}`);
  }
}

// Prune runs rarely (a transition is a once-per-couple-minutes-at-most event), so an age sweep on each
// insert is negligible and keeps the table bounded without a separate scheduler.
//
// `outPeak`/`outFrames` (ROADMAP §1.2 item 2): the outside channel's evidence for this specific
// transition — see db.js's migration comment for what they mean per type. Optional and additive:
// omitting them (any existing or future caller that doesn't pass evidence) stores NULL, unchanged
// from before this column existed.
export function recordBedTransition(cameraId, type, peak = null, { outPeak = null, outFrames = null } = {}) {
  try {
    const info = insertStmt.run({
      camera_id: cameraId,
      type,
      peak: peak == null ? null : Math.round(peak * 1000) / 1000,
      out_peak: outPeak == null ? null : Math.round(outPeak * 1000) / 1000,
      out_frames: outFrames == null ? null : Math.round(outFrames),
    });
    // Delete the images BEFORE the rows, or the ids that name them are gone and the files orphan.
    //
    // Synchronously, and deliberately: an async fire-and-forget unlink makes "the row is gone, so the
    // image is gone" only eventually true, and a failure has nowhere to be noticed — the orphan just
    // sits there forever with nothing left in the database able to name it. This runs at most once per
    // transition (minutes apart at worst) over a handful of files a day, so the cost is nil.
    for (const row of agedWithSnapshotStmt.all(`-${MAX_AGE_DAYS} days`)) {
      const file = snapshotFile(row.id);
      if (!file) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch (e) {
        logger.info(`[bedtx] could not remove aged snapshot ${row.id}: ${e.message}`);
      }
    }
    pruneByAgeStmt.run(`-${MAX_AGE_DAYS} days`);
    // Not awaited: see attachSnapshot.
    attachSnapshot(info.lastInsertRowid, cameraId);
    return info.lastInsertRowid;
  } catch (err) {
    logger.error('Failed to record bed transition:', err.message);
    return null;
  }
}

// All transitions for the given cameras within [startSql, endSql) (UTC 'YYYY-MM-DD HH:MM:SS' strings),
// ascending by time. Returns [{ id, camera_id, type, created_at, peak, out_peak, out_frames, snapshot,
// verdict, wrong_reason }]. Empty for no cameras.
export function getBedTransitions(cameraIds, startSql, endSql) {
  if (!cameraIds || cameraIds.length === 0) return [];
  const ph = cameraIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, camera_id, type, created_at, peak, out_peak, out_frames, snapshot, verdict, wrong_reason
         FROM bed_transitions
         WHERE camera_id IN (${ph}) AND created_at >= ? AND created_at < ?
         ORDER BY created_at ASC`
    )
    .all(...cameraIds, startSql, endSql);
}

// #907. How far outside a Room activity row a saved frame may sit and still be offered on it. The sleep
// detail page applies the same figure in `framesForVisit` (frontend/src/pages/SleepDetail.jsx): the two are
// ONE rule in two places, and the page can only match what this list contains, so changing one means
// changing the other. A minute because a visit is drawn to the minute (start_at/end_at are whole minutes)
// while a transition keeps its real second, so a frame fired 40 s after the minute a row "ends" at is still
// that row's frame.
export const FRAME_ROW_SLACK_MS = 60000;

// UTC 'YYYY-MM-DD HH:MM:SS' <-> ms. Local to this file on purpose: sleepAnalysis.js has the same helpers but
// imports THIS module, so importing back would be a cycle. The strings are the shape every created_at,
// window_* and display_* field in the sleep payload already has.
const sqlToMs = (s) => new Date(`${s.replace(' ', 'T')}Z`).getTime();
const msToSql = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// #907. The saved bed-transition frames the sleep detail page can offer for one night, as
// [{ id, type, at }] ascending by `at` (`at` is the transition's own created_at, real second included).
// Takes a night as the sleep route is about to send it (after any parent correction), and returns ONLY
// what an <img> can show:
//   - From the night's ANALYSIS camera and no other. A child's second camera, or another child's, may have
//     frames in the same hours; they are not what the night's numbers were worked out from.
//   - `snapshot = 1` AND the file is on disk. The flag alone is not enough: the age sweep deletes the file
//     with the row, but a data folder restored from a backup, or a hand-cleared folder, leaves flags with no
//     file, and the page would draw a broken picture. A missing frame shows no button instead.
//   - Over the range the timeline is DRAWN (display_start..display_end, else the window), widened by
//     FRAME_ROW_SLACK_MS at each end so a frame just past the last row's edge is not dropped before the page
//     can match it. Every Room activity row lies inside that range.
//   - ALL transitions in range, not only the two the analysis adopted (night.transitions). The case this
//     exists for is a weak burst adopted as the wake while the true exit, 40 minutes later, is NOT adopted:
//     a list built from the adopted pair would leave out the very frame someone needs to see. For the same
//     reason the page links a row to frames by TIME, not by transition id.
// [] (never undefined) for a night that has no camera or no timeline to attach to (off, empty, no_data,
// "nobody in bed"), so a client can read the key without checking the night's status first. Read-only; the
// frame itself is still served by GET /cameras/bed-transitions/:id/snapshot behind sign-in, unchanged.
export function framesForNight(night) {
  if (!night || night.status !== 'ok' || !night.analysis_camera_id) return [];
  const start = night.display_start || night.window_start;
  const end = night.display_end || night.window_end;
  if (!start || !end) return [];
  // getBedTransitions' end is EXCLUSIVE and the slack is INCLUSIVE (a frame exactly 60 s past the edge still
  // matches a row), hence the extra second.
  const rows = getBedTransitions(
    [night.analysis_camera_id],
    msToSql(sqlToMs(start) - FRAME_ROW_SLACK_MS),
    msToSql(sqlToMs(end) + FRAME_ROW_SLACK_MS + 1000),
  );
  return rows
    .filter((r) => r.snapshot === 1 && transitionSnapshotPath(r.id))
    .map((r) => ({ id: r.id, type: r.type, at: r.created_at }));
}

// Activity for the given cameras within [startSql, endSqlExclusive), in the order the pure
// lingering-motion rule expects. Keep morning-review work bounded to this night's evidence.
export function getActivitySamples(cameraIds, startSql, endSqlExclusive) {
  if (!cameraIds || cameraIds.length === 0) return [];
  const ph = cameraIds.map(() => '?').join(',');
  return db.prepare(
    `SELECT camera_id, bucket_start, motion_peak FROM activity_samples
       WHERE camera_id IN (${ph}) AND bucket_start >= ? AND bucket_start < ?
       ORDER BY camera_id, bucket_start ASC`
  ).all(...cameraIds, startSql, endSqlExclusive);
}

// One boundary lookup per camera detects a same-direction run truncated by a bounded fetch.
export function getPriorTransitionType(cameraId, beforeSql) {
  const row = db.prepare(
    `SELECT type FROM bed_transitions WHERE camera_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1`
  ).get(cameraId, beforeSql);
  return row ? row.type : null;
}

// Transitions that are provably wrong: the same type twice in a row for one camera, with nothing
// between. You cannot get into a bed you are already in. Returns the SECOND of each such pair along
// with the one it contradicts, newest first — the working set for diagnosing the classifier, and the
// measure of how much a believed-occupancy state machine (ROADMAP 1.2) would clean up.
export function getImpossibleTransitions({ limit = 200 } = {}) {
  const rows = db
    .prepare(
      `SELECT t.id, t.camera_id, c.name AS camera_name, t.type, t.created_at, t.peak,
              t.out_peak, t.out_frames, t.snapshot
         FROM bed_transitions t JOIN cameras c ON c.id = t.camera_id
        ORDER BY t.camera_id, t.created_at ASC`
    )
    .all();
  const out = [];
  const prev = new Map();
  for (const r of rows) {
    const before = prev.get(r.camera_id);
    if (before && before.type === r.type) out.push({ ...r, contradicts: before.id, contradicts_at: before.created_at });
    prev.set(r.camera_id, r);
  }
  // Newest first ACROSS ALL CAMERAS, then trim. The query orders by camera_id first, so `out` comes
  // out grouped by camera and only then by time. Reversing THAT yields every row of one camera
  // before any row of another, so the slice dropped whole cameras rather than old rows: with two
  // children and the limit reached, one child's transitions came back and the other child's were
  // silently absent. Measured 2026-08-31 at ~197 pairs against a limit of 200.
  //
  // (The scan itself does NOT depend on that grouping — `prev` is keyed on camera_id, so a pair is
  // confined to one camera by the map key, not by row order. Sorting here rather than changing the
  // query keeps the two concerns separate.)
  //
  // ⚠️ Nothing in the app calls this yet — it is invoked ad hoc while diagnosing the classifier, and
  // is the report the zone repaint gets scored against at the end of a monitor phase. Wire it to a
  // route or move it to scripts/ before it drifts.
  //
  // Sort on the timestamp itself, tie-broken by id so the order is total and a page is stable when
  // two cameras fire inside the same second.
  out.sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : a.created_at < b.created_at ? 1 : -1));
  return out.slice(0, Math.min(500, Math.max(1, limit)));
}

// `into_bed` immediately followed (same camera) by `out_of_bed` within `maxGapMs`. Measured 2026-09-13:
// 86 of 1053 stored transitions (~8%) match this shape, and it is NOT the classifier picking up a real
// child getting straight back up:
//   - A 9-case visual sample of the paired snapshots showed a parent in frame leaving via the door in
//     every case where anyone was visible at all, and the child lying still in every single case — never
//     the reverse.
//   - Independently, the bed zone's own motion in the hour AFTER the `out_of_bed` (motion_peak >
//     MOTION_ACTIVE, sleepAnalysis.js's own calibrated per-minute test) kept showing normal stirring in
//     60% of all 86 cases — essentially impossible if the bed were actually empty, per the same
//     assumption the empty-bed guard itself already relies on ("a sleeping room reads ~0, so does an
//     empty one" — MOTION_ACTIVE's own comment). Only 9 of 86 (all Child B, none Child A) showed a fully
//     silent hour after — the one signature actually consistent with a real departure.
// Leading theory (the owner's, unprompted, matching the visual sample exactly): a goodnight kiss —
// leaning over the bed right after placing the child (bed active), then leaving (outside active, then
// quiet) is precisely the shape `out_of_bed` looks for, with no child movement involved at all. This is
// ROADMAP §1.2 item 3's exact gap (telling a parent's motion from a child's), approached from the entry
// side rather than the exit side it was originally framed around.
//
// Query only, same reasoning as getImpossibleTransitions above: nothing today ACTS on this (no gating,
// no wake_count change) — it needs owner-verdict ground truth on this specific pattern before anything
// downstream can safely use it, and there is almost none yet (1 of 86 verdicted). This is what makes
// that possible to build: surfacing these pairs for review, or scoring a discount rule against real
// labels once they exist, rather than guessing.
export function getQuickReversals({ maxGapMs = 60000, limit = 200 } = {}) {
  // LEFT JOIN, deliberately unlike getImpossibleTransitions's inner join above: camera_id carries no
  // foreign key (cameras can be deleted, e.g. hardware replacement), so an inner join would silently
  // drop a deleted camera's historical rows from this report. Found in adversarial review, 2026-09-13.
  const rows = db
    .prepare(
      `SELECT t.id, t.camera_id, COALESCE(c.name, t.camera_id) AS camera_name, t.type, t.created_at,
              t.peak, t.out_peak, t.out_frames, t.snapshot, t.verdict
         FROM bed_transitions t LEFT JOIN cameras c ON c.id = t.camera_id
        ORDER BY t.camera_id, t.created_at ASC`
    )
    .all();
  const out = findQuickReversals(rows, { maxGapMs });
  // Same lesson as getImpossibleTransitions: sort on the actual timestamp AFTER building the list,
  // rather than trusting the camera-grouped scan order — a naive slice on that order can silently drop
  // an entire camera's pairs once the limit is reached.
  out.sort((x, y) => {
    const xt = x.out_of_bed.created_at;
    const yt = y.out_of_bed.created_at;
    return xt === yt ? y.out_of_bed.id - x.out_of_bed.id : xt < yt ? 1 : -1;
  });
  return out.slice(0, Math.min(500, Math.max(1, limit)));
}

// Continued bed-zone motion after ANY out_of_bed, in a stretch the classifier itself still believes is
// UNOCCUPIED (no into_bed recorded on the same camera between the exit and the motion). Generalizes
// findQuickReversals/getQuickReversals's own SECOND, data-driven check above — the bed zone's own
// motion_peak in the hour after a quick reversal's trailing out_of_bed — from "only quick-reversal
// pairs" (~8% of transitions) to every out_of_bed still within activity_samples' retention window
// (NOT literally "every out_of_bed on record" — bed_transitions outlives activity_samples by 15 days
// and exempts verdicted rows from pruning forever, so the oldest verdicted rows specifically can have
// no samples left to check; "not flagged" here can mean either "checked, found quiet" or "nothing left
// to check" — same outcome, different meaning, found in second review). Generalizing MECHANICALLY is
// not the same claim as generalizing STATISTICALLY — the quick-reversal work also leaned on an
// independent visual sample this broader population doesn't have, and its dominant case (a terminal/
// morning exit with no into_bed until the next bedtime) is exactly where ordinary daytime room use
// would flag at a rate nobody has measured yet. See findLingeringBedMotion in bedTransitionRules.js
// for the exact per-transition rule, and DO NOT trust any flag-rate claim about this query until the
// mandatory post-implementation measurement (against the verdict column already selected below) has
// actually run — see this function's shipping plan for that step.
//
// Same-direction repeats (62% of stored transitions, item 1's own measurement) are deliberately
// evaluated only once — see the "SEPARATE dedup" note in this function's design — so one unoccupied
// stretch bracketed by several repeated out_of_bed markers produces one row, not several. ⚠️ The
// evaluation is anchored at the run's OLDEST member, not its newest — see findAllLingeringBedMotion for
// why: anchoring at the newest member (the first-shipped version of this code, fixed 2026-09-14 after
// an adversarial pre-merge review caught it independently via Codex AND a parallel Claude subagent)
// silently LOST real evidence rather than merely deduplicating it, whenever the run's earlier member(s)
// had qualifying motion that the newest member's own post-exit window could never see.
//
// Diagnostic only: the morning review uses the same pure scan on bounded rows to collect owner
// verdicts on THIS broader population. Nothing gates sleepAnalysis.js/detectMidnightEpisodes or
// wake_count on it. See ROADMAP §1.2 item 3, still open pending ground truth.
export function getLingeringBedMotion({
  windowMs = LINGERING_WINDOW_MS,
  minActiveMinutes = LINGERING_MIN_ACTIVE_MINUTES,
  limit = 200,
} = {}) {
  const transitions = db
    .prepare(
      `SELECT t.id, t.camera_id, COALESCE(c.name, t.camera_id) AS camera_name, t.type, t.created_at,
              t.peak, t.out_peak, t.out_frames, t.snapshot, t.verdict
         FROM bed_transitions t LEFT JOIN cameras c ON c.id = t.camera_id
        ORDER BY t.camera_id, t.created_at ASC`
    )
    .all();

  const samples = db
    .prepare(`SELECT camera_id, bucket_start, motion_peak FROM activity_samples ORDER BY camera_id, bucket_start ASC`)
    .all();

  const samplesByCamera = new Map();
  for (const s of samples) {
    if (!samplesByCamera.has(s.camera_id)) samplesByCamera.set(s.camera_id, []);
    samplesByCamera.get(s.camera_id).push(s);
  }
  const out = findAllLingeringBedMotion(transitions, samplesByCamera, { windowMs, minActiveMinutes });

  out.sort((a, b) => {
    const xt = a.out_of_bed.created_at;
    const yt = b.out_of_bed.created_at;
    return xt === yt ? b.out_of_bed.id - a.out_of_bed.id : xt < yt ? 1 : -1;
  });
  return out.slice(0, Math.min(500, Math.max(1, limit)));
}

// Record what a person said about one transition: 'correct', 'wrong', or 'unclear' — or null to clear
// it again. Anything else is rejected rather than stored, because these values are the labels a future
// occupancy check gets measured against and a typo'd one is worse than a missing one. Returns whether
// a row was actually updated.
// The single source of truth for what a verdict may be. Exported so the route, the lib and the UI all
// validate against ONE list — a second copy would drift, and a typo'd label is worse than a missing one
// because everything else gets measured against these.
export const VERDICTS = Object.freeze(['correct', 'wrong', 'unclear']);

// WHO it was, when a person answers 'wrong': another adult (typically the parent leaving after a
// story), the child moving in bed, or someone walking past / nothing at all. Same frozen
// single-source-of-truth shape as VERDICTS, and deliberately a SEPARATE list, never extra verdict
// values: 'wrong' means "the detector's claim did not happen", and every existing score, the prune
// exemption and the quick-reversal/lingering cards all read the verdict as exactly that three-way
// answer. Folding "who" into it would silently change what 'wrong' counts. It exists because 542
// staging-verdicted exits could not score a parent-exit rule at all (2026-09-25): "wrong" lumped the
// three cases together, so no candidate rule could be told from noise.
export const WRONG_REASONS = Object.freeze(['adult', 'child_moved', 'other']);

// ⚠️ A verdict other than 'wrong' clears wrong_reason IN THE SAME STATEMENT. A reason only means
// something beside a 'wrong' verdict; if the person later changes their mind to 'correct' (or clears
// it), a surviving 'adult' would be a label nobody gave. Doing it here rather than trusting the client
// to send a matching `reasons` entry is what keeps an already-open older tab — which never sends
// `reasons` at all — from leaving a stale one behind. Found by both plan reviewers, 2026-09-25.
const setVerdictKeepReasonStmt = db.prepare('UPDATE bed_transitions SET verdict = ? WHERE id = ?');
const setVerdictClearReasonStmt = db.prepare('UPDATE bed_transitions SET verdict = ?, wrong_reason = NULL WHERE id = ?');

export function setTransitionVerdict(id, verdict) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (verdict != null && !VERDICTS.includes(verdict)) return false;
  const stmt = verdict === 'wrong' ? setVerdictKeepReasonStmt : setVerdictClearReasonStmt;
  return stmt.run(verdict ?? null, n).changes > 0;
}

// Record (or clear, with null) WHO it was for one transition. Same validation shape as
// setTransitionVerdict: a positive-integer id, and a value from WRONG_REASONS or null. Returns whether a
// row was updated.
//
// ⚠️ This does NOT check the row's verdict, and the caller must: sleepReviews.applyVerdicts decides
// from the verdict the row will have AFTER the same save, and only calls this when that is 'wrong'.
// An `AND verdict = 'wrong'` in the SQL was tried and taken out (2026-09-25): applyVerdicts writes the
// verdicts first, so the SQL guard reproduced that decision exactly and made it untestable — a broken
// null-vs-absent check there (see applyVerdicts) survived every test. One check that a test can break
// beats two where one hides the other. The only caller is applyVerdicts; keep it that way.
const setReasonStmt = db.prepare('UPDATE bed_transitions SET wrong_reason = ? WHERE id = ?');

export function setTransitionReason(id, reason) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (reason != null && !WRONG_REASONS.includes(reason)) return false;
  return setReasonStmt.run(reason ?? null, n).changes > 0;
}
