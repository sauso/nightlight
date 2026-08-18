import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizePhoto } from '../lib/photo.js';
import { getStoredNights, computeNight, computeAndStoreNight, currentNightDate, childTracksSleep, sleepInsights } from '../lib/sleepAnalysis.js';
import { startMotionDetector } from '../lib/motionDetector.js';

const router = Router();
router.use(requireAuth);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  const nights = getStoredNights(req.params.id, 1);
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
  res.json({ nights: getStoredNights(req.params.id, nights) });
});

// Compute one night on demand for a specific LOCAL start date ('YYYY-MM-DD'). ?detail=1 includes the
// timeline segments + wake list for the Sleep detail view; ?debug=1 also adds the raw per-minute
// timeline (tuning); ?store=1 (admin) persists the recompute.
router.get('/:id/sleep/:date', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  const wantStore = req.query.store === '1' && req.user?.role === 'admin';
  const summary = wantStore
    ? computeAndStoreNight(req.params.id, req.params.date)
    : computeNight(req.params.id, req.params.date, { includeTimeline: req.query.debug === '1' || req.query.detail === '1' });
  res.json(summary);
});

router.delete('/:id', (req, res) => {
  db.prepare('UPDATE cameras SET child_id = NULL WHERE child_id = ?').run(req.params.id);
  db.prepare('DELETE FROM children WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sleep_nights WHERE child_id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
