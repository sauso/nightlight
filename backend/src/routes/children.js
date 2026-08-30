import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizePhoto } from '../lib/photo.js';
import { getStoredNights, computeNight, computeAndStoreNight, currentNightDate, childTracksSleep, sleepInsights } from '../lib/sleepAnalysis.js';
import { startMotionDetector } from '../lib/motionDetector.js';
import { getNightReview, saveNightReview, reviewCardState, localHmToUtcSql, applyVerdicts,
  applyCorrection, applyCorrections } from '../lib/sleepReviews.js';

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
function reconcileChildLegs(childId) {
  for (const cam of db.prepare('SELECT * FROM cameras WHERE child_id = ?').all(childId)) {
    startMotionDetector(cam).catch(() => {});
  }
}

router.get('/', (req, res) => {
  const children = db.prepare('SELECT * FROM children ORDER BY created_at').all();
  res.json(children.map(withCameras));
});

router.post('/', (req, res) => {
  const { name, birthday, color, track_sleep, sleep_window_start, sleep_window_end } = req.body || {};
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
  // only honest "before" to compare against. Everything else on this route recomputes, and comparing a
  // recompute against a recompute can never differ.
  if (req.query.stored === '1') {
    const row = db
      .prepare('SELECT * FROM sleep_nights WHERE child_id = ? AND night_date = ?')
      .get(req.params.id, req.params.date);
    return res.json({ night: row || null });
  }
  const wantStore = req.query.store === '1' && req.user?.role === 'admin';
  if (!wantStore) {
    return res.json(applyCorrection(req.params.id, computeNight(req.params.id, req.params.date, {
      includeTimeline: req.query.debug === '1' || req.query.detail === '1',
    })));
  }
  // Storing a recompute can only ever improve or re-score a night, never un-score one — see the
  // allowDowngrade guard in computeAndStoreNight. A refusal is the user's fault only in the sense that
  // the night is too old, so it is a 4xx with a readable reason: a 5xx would have its body stripped by
  // Cloudflare and the user would see nothing at all.
  const summary = computeAndStoreNight(req.params.id, req.params.date, { allowDowngrade: false });
  if (summary.refused === 'would_downgrade') {
    return res.status(409).json({
      error: "This night can't be re-scored: its minute-by-minute data has aged out (kept 30 days). "
        + 'The saved summary has been left as it is.',
    });
  }
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

// Save the night's true times, any per-transition verdicts, and/or a dismissal. Every field is
// optional: dismissing is just a save with nothing else in it, which is why one route covers both.
router.put('/:id/review/:date', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  if (!DATE_ONLY.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const body = req.body || {};
  const { true_onset_local: onsetHm, true_wake_local: wakeHm, note, dismissed, verdicts } = body;

  // The client sends what the person typed — a wall-clock 'HH:MM' — and the server resolves it against
  // the app's configured timezone and the night's date. `undefined` back from localHmToUtcSql means the
  // value was malformed, which is NOT the same as `null` (nothing recorded) and must not be stored as
  // if it were, or a garbled entry would silently become "no ground truth for this night".
  const onset = localHmToUtcSql(req.params.date, onsetHm);
  const wake = localHmToUtcSql(req.params.date, wakeHm);
  for (const [label, v] of [['true_onset_local', onset], ['true_wake_local', wake]]) {
    if (v === undefined) return res.status(400).json({ error: `${label} must be a time like 19:33` });
  }
  if (note != null && typeof note !== 'string') {
    return res.status(400).json({ error: 'note must be text' });
  }
  // Anything not a string reaches better-sqlite3 as an unbindable value and comes back as a 500 whose
  // body Cloudflare strips — the user would see nothing at all. Same reasoning as the verdict check.
  for (const [label, v] of [['computed_onset_at', body.computed_onset_at], ['computed_wake_at', body.computed_wake_at]]) {
    if (v != null && !UTC_TIMESTAMP.test(String(v))) {
      return res.status(400).json({ error: `${label} must be 'YYYY-MM-DD HH:MM:SS' in UTC` });
    }
  }

  // Verdicts are scoped to THIS child and THIS night inside applyVerdicts, and rejected as a batch.
  const check = applyVerdicts(req.params.id, req.params.date, verdicts);
  if (check.error) return res.status(400).json({ error: check.error });

  const review = saveNightReview(req.params.id, req.params.date, {
    // `undefined` means "not supplied, keep what is stored" — a stale card on a second phone sending
    // only `{dismissed:true}` must not blank times a parent entered on the first.
    trueOnsetAt: onsetHm === undefined ? undefined : onset,
    trueWakeAt: wakeHm === undefined ? undefined : wake,
    // What the person was LOOKING at when they judged, echoed back from the GET. Deliberately not
    // recomputed here — see saveNightReview.
    computedOnsetAt: body.computed_onset_at,
    computedWakeAt: body.computed_wake_at,
    note,
    dismissed,
  });
  res.json({ review, verdicts_applied: check.applied });
});

router.delete('/:id', (req, res) => {
  db.prepare('UPDATE cameras SET child_id = NULL WHERE child_id = ?').run(req.params.id);
  db.prepare('DELETE FROM children WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
