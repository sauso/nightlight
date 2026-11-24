import crypto from 'node:crypto';
import db from '../db.js';
import { logger } from './logger.js';
import {
  computeAndStoreNight, isEvidenceFinal, lastCompletedNightDate,
  ONSET_LOOKBEHIND_MS, parseScoringContext, toSqlUtc,
} from './sleepAnalysis.js';

let inFlight = false;
const columns = db.prepare('PRAGMA table_info(sleep_nights)').all().map(({ name }) => name);
const identity = new Set(['id', 'child_id', 'night_date']);
const evidence = ['avg_temperature', 'avg_humidity', 'wake_at_sensor', 'sensor_rejects'];
// These are the only sleep_nights fields upsertNight does not write. Include every other column,
// including facts and coverage: a replay can change the underlying evidence without moving a figure.
const compared = columns.filter((name) => !identity.has(name)
  && !['notified_at', 'notified_wake_at', 'computed_at', 'scoring_context'].includes(name));
const figures = ['status', 'onset_at', 'wake_at', 'in_bed_at', 'asleep_minutes',
  'awake_minutes', 'wake_count', 'longest_stretch_minutes'];
const getNight = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?');
const hasReview = db.prepare('SELECT 1 FROM sleep_reviews WHERE child_id = ? AND night_date = ?');
const oldestSample = db.prepare('SELECT MIN(bucket_start) AS first FROM activity_samples WHERE camera_id = ?');
// Protected clips outlive the ordinary alert history, so they cannot prove a replay has full history.
const oldestEvent = db.prepare('SELECT MIN(created_at) AS first FROM detection_events WHERE camera_id = ? AND protected = 0');
const cameraExists = db.prepare('SELECT 1 FROM cameras WHERE id = ?');
const classifyAudio = db.prepare("SELECT classify_alert_audio FROM settings WHERE id = 'app'");
const saveBackup = db.prepare(`INSERT INTO sleep_night_rewrites
  (batch_id, child_id, night_date, before_json, after_json, applied_at, applied_by_user_id)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const restoreSql = (names) => db.prepare(`UPDATE sleep_nights SET ${names.map((n) => `"${n}" = @${n}`).join(', ')} WHERE child_id = @child_id AND night_date = @night_date`);
const restoreExact = restoreSql(columns.filter((n) => !identity.has(n)));
const restoreUndo = restoreSql(columns.filter((n) => !identity.has(n) && !n.startsWith('notified_')));
const restoreEvidence = restoreSql([...evidence, 'summary_facts']);

function factsWithOriginalClimate(beforeText, afterText) {
  const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const before = parse(beforeText);
  const after = parse(afterText);
  if (!after || typeof after !== 'object' || Array.isArray(after)) return afterText;
  // Preserve the saved room measurement while retaining today's newly scored sleep facts and their key order.
  if (before && typeof before === 'object' && Object.hasOwn(before, 'climate')) after.climate = before.climate;
  else delete after.climate;
  return JSON.stringify(after);
}

function refusal(reason, error, status = 409) {
  return Object.assign(new Error(error), { reason, status });
}
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function takeFlag() {
  if (inFlight) throw refusal('in_progress', 'An update or undo is already running');
  inFlight = true;
}
function skip(report, reason) {
  report.skipped[reason] = (report.skipped[reason] || 0) + 1;
}
function isOwnedByJob(row, lastDate, now) {
  // The nightly job still owes the last completed night a pass when its own last write was
  // provisional. An older night with the same early computed_at is outside the job's reach.
  const wroteAt = new Date(row.computed_at?.replace(' ', 'T') + 'Z').getTime();
  return !isEvidenceFinal(row.window_end, now)
    || (row.night_date === lastDate && !isEvidenceFinal(row.window_end, wroteAt));
}
function hasFullData(row, ctx, audioOn) {
  const needed = toSqlUtc(new Date(new Date(row.window_start.replace(' ', 'T') + 'Z').getTime() - ONSET_LOOKBEHIND_MS));
  if (ctx.camera_id == null) return false;
  const firstSample = oldestSample.get(ctx.camera_id)?.first;
  if (!firstSample || firstSample > needed) return false;
  const firstEvent = audioOn ? oldestEvent.get(ctx.camera_id)?.first : null;
  if (audioOn && (!firstEvent || firstEvent > needed)) return false;
  return true;
}

// A dry run is the real write path inside an immediate transaction, rolled back by a sentinel.
// That keeps the preview honest even when the score of a later night reads a rewritten earlier night.
export function rewritePastNights({ apply = false, expect, userId = null } = {}) {
  if (apply && (typeof expect !== 'string' || !/^[0-9a-f]{64}$/.test(expect))) {
    throw refusal('preview_required', 'Check what would change first, then update.', 400);
  }
  takeFlag();
  const rollback = Symbol('preview rollback');
  let report;
  try {
    const run = db.transaction(() => {
      const batchId = crypto.randomUUID();
      const appliedAt = toSqlUtc(new Date());
      const changes = [];
      // A check covers every candidate, including unchanged and skipped nights: a review or lost
      // evidence between clicks must invalidate it even when no changed-row backup would differ.
      const outcomes = [];
      const children = [];
      const now = Date.now();
      const audioOn = classifyAudio.get()?.classify_alert_audio !== 0;
      for (const child of db.prepare('SELECT id, name, track_sleep FROM children ORDER BY name, id').all()) {
        const childReport = { child_id: child.id, name: child.name, changed: [], unchanged: 0, skipped: {} };
        const lastDate = lastCompletedNightDate(child.id);
        // #700: a later night's departure baseline reads earlier stored wake candidates.
        // Keep the child's work synchronous and oldest first, inside this transaction.
        for (const before of db.prepare("SELECT * FROM sleep_nights WHERE child_id = ? AND status IN ('ok', 'empty') ORDER BY night_date").all(child.id)) {
          const outcomeKey = [child.id, before.night_date];
          const skipNight = (reason) => { skip(childReport, reason); outcomes.push([...outcomeKey, 'skipped', reason]); };
          if (!child.track_sleep) { skipNight('tracking_off'); continue; }
          const ctx = parseScoringContext(before.scoring_context);
          if (!ctx) { skipNight('no_saved_settings'); continue; }
          // Any review, including a dismissal or answered event, is wider than nightIsLocked.
          // This action promises to leave every parent-reviewed night alone.
          if (hasReview.get(child.id, before.night_date)) { skipNight('has_review'); continue; }
          if (isOwnedByJob(before, lastDate, now)) { skipNight('owned_by_nightly_job'); continue; }
          if (!cameraExists.get(ctx.camera_id)) { skipNight('stored_camera_missing'); continue; }
          if (!hasFullData(before, ctx, audioOn)) { skipNight('partial_data'); continue; }
          try {
            // The savepoint removes any partial writes from a failed compute without losing the run.
            const change = db.transaction(() => {
              const outcome = computeAndStoreNight(child.id, before.night_date,
                { allowDowngrade: false, context: before.scoring_context });
              if (outcome.refused) return { skipped: outcome.refused };
              if (before.status === 'ok' && outcome.status === 'empty') {
                restoreExact.run(before);
                return { skipped: 'would_become_empty' };
              }
              // Re-scoring must not re-source climate or sensor evidence from today's devices.
              restoreEvidence.run({ ...before, summary_facts: factsWithOriginalClimate(before.summary_facts,
                getNight.get(child.id, before.night_date).summary_facts) });
              const after = getNight.get(child.id, before.night_date);
              if (compared.every((name) => Object.is(before[name], after[name]))) {
                restoreExact.run(before);
                return { unchanged: true };
              }
              saveBackup.run(batchId, child.id, before.night_date, JSON.stringify(before),
                JSON.stringify(after), appliedAt, userId);
              return { after };
            }).immediate();
            if (change.skipped) { skipNight(change.skipped); continue; }
            if (change.unchanged) { childReport.unchanged++; outcomes.push([...outcomeKey, 'unchanged', hash(before)]); continue; }
            const { after } = change;
            const figuresChanged = figures.some((name) => !Object.is(before[name], after[name]));
            childReport.changed.push({ night_date: before.night_date, figures_changed: figuresChanged,
              before: Object.fromEntries(figures.map((name) => [name, before[name]])),
              after: Object.fromEntries(figures.map((name) => [name, after[name]])) });
            changes.push([child.id, before.night_date, hash(before),
              Object.fromEntries(compared.map((name) => [name, after[name]]))]);
            outcomes.push([...outcomeKey, 'changed', hash(before),
              Object.fromEntries(compared.map((name) => [name, after[name]]))]);
          } catch (error) {
            // SQLite can abort the outer transaction on FULL, IOERR or NOMEM; continuing would report success without writes.
            if (!db.inTransaction) throw error;
            // The savepoint already rolled this night back. Say so in the log (a bug here must not hide behind a
            // silent skip count), without the night's figures: only the date and the error.
            logger.warn(`[sleep-rewrite] night ${before.night_date} skipped after an error: ${error.message}`);
            skipNight('error');
          }
        }
        children.push(childReport);
      }
      report = { children, changed: changes.length, figures_changed: children.flatMap((c) => c.changed).filter((c) => c.figures_changed).length,
        facts_only: children.flatMap((c) => c.changed).filter((c) => !c.figures_changed).length,
        preview: hash(outcomes) };
      if (apply && expect !== report.preview) {
        throw refusal('changed_since_preview', 'Past nights changed since the check. Check what would change again.');
      }
      if (!apply) throw rollback;
    });
    run.immediate();
    return report;
  } catch (error) {
    if (error === rollback) return report;
    throw error;
  } finally {
    inFlight = false;
  }
}

export function latestRewrite() {
  const row = db.prepare(`SELECT batch_id, MIN(applied_at) AS applied_at, MAX(undone_at) AS undone_at,
    COUNT(*) AS changed, SUM(CASE WHEN undone_at IS NULL AND undo_skip_reason IS NULL THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN undone_at IS NOT NULL THEN 1 ELSE 0 END) AS restored,
    SUM(CASE WHEN undo_skip_reason IS NOT NULL THEN 1 ELSE 0 END) AS left
    FROM sleep_night_rewrites GROUP BY batch_id ORDER BY MAX(rowid) DESC LIMIT 1`).get();
  return row ? { batch_id: row.batch_id, applied_at: row.applied_at, changed: row.changed,
    undoable: row.pending > 0, undone_at: row.undone_at, restored: row.restored, left: row.left } : null;
}

export function undoRewrite({ batchId } = {}) {
  takeFlag();
  try {
    if (typeof batchId !== 'string' || !batchId) throw refusal('invalid_batch', 'Choose a rewrite batch to undo', 400);
    const latest = latestRewrite();
    if (!latest || latest.batch_id !== batchId) throw refusal('not_latest', 'Only the latest update can be undone');
    if (!latest.undoable) throw refusal('already_undone', 'This update has already been undone');
    return db.transaction(() => {
      const result = { restored: 0, skipped: {} };
      const rows = db.prepare('SELECT * FROM sleep_night_rewrites WHERE batch_id = ? AND undone_at IS NULL AND undo_skip_reason IS NULL ORDER BY child_id, night_date').all(batchId);
      // An undo is one attempt. Closing skipped rows prevents a removed review or re-save from
      // making an old batch unexpectedly restore data on a later tap.
      const markSkipped = db.prepare('UPDATE sleep_night_rewrites SET undo_skip_reason = ? WHERE batch_id = ? AND child_id = ? AND night_date = ?');
      for (const row of rows) {
        const current = getNight.get(row.child_id, row.night_date);
        if (hasReview.get(row.child_id, row.night_date)) {
          skip(result, 'corrected_since'); markSkipped.run('corrected_since', batchId, row.child_id, row.night_date); continue;
        }
        const after = JSON.parse(row.after_json);
        // computed_at is minute-truncated. Compare the whole row instead: even a save in the
        // same minute must protect someone else's subsequent work. Notifications are a ledger.
        if (!current || columns.some((name) => !name.startsWith('notified_') && !Object.is(current[name], after[name]))) {
          skip(result, 'saved_again_since'); markSkipped.run('saved_again_since', batchId, row.child_id, row.night_date); continue;
        }
        restoreUndo.run(JSON.parse(row.before_json));
        db.prepare('UPDATE sleep_night_rewrites SET undone_at = ? WHERE batch_id = ? AND child_id = ? AND night_date = ?')
          .run(toSqlUtc(new Date()), batchId, row.child_id, row.night_date);
        result.restored++;
      }
      return result;
    }).immediate();
  } finally {
    inFlight = false;
  }
}
