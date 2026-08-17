import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { normalizePhoto } from '../lib/photo.js';
import { getStoredNights, computeNight, computeAndStoreNight, currentNightDate } from '../lib/sleepAnalysis.js';

const router = Router();
router.use(requireAuth);

function withCameras(child) {
  const cameras = db
    .prepare('SELECT id, name, mediamtx_path FROM cameras WHERE child_id = ?')
    .all(child.id);
  return { ...child, cameras };
}

router.get('/', (req, res) => {
  const children = db.prepare('SELECT * FROM children ORDER BY created_at').all();
  res.json(children.map(withCameras));
});

router.post('/', (req, res) => {
  const { name, birthday, color } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  let photo;
  try { photo = normalizePhoto(req.body?.photo, null); } catch (e) { return res.status(400).json({ error: e.message }); }
  const id = uuid();
  db.prepare('INSERT INTO children (id, name, birthday, color, photo) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name.trim(),
    birthday || null,
    color || '#F5D9A8',
    photo
  );
  res.status(201).json(withCameras(db.prepare('SELECT * FROM children WHERE id = ?').get(id)));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Child not found' });
  const { name, birthday, color } = req.body || {};
  let photo;
  try { photo = normalizePhoto(req.body?.photo, existing.photo); } catch (e) { return res.status(400).json({ error: e.message }); }
  db.prepare('UPDATE children SET name = ?, birthday = ?, color = ?, photo = ? WHERE id = ?').run(
    name?.trim() || existing.name,
    birthday !== undefined ? birthday : existing.birthday,
    color || existing.color,
    photo,
    req.params.id
  );
  res.json(withCameras(db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id)));
});

// The night to show on the summary tile: the night IN PROGRESS computed live (capped at "now") if a
// window is currently open, otherwise the latest stored completed night. `scope` tells the UI which it
// is so it can say "Tonight · so far" vs "Last night". Computed on demand — cheap, always fresh.
router.get('/:id/sleep/live', (req, res) => {
  const child = db.prepare('SELECT id FROM children WHERE id = ?').get(req.params.id);
  if (!child) return res.status(404).json({ error: 'Child not found' });
  const current = currentNightDate();
  if (current) {
    return res.json({ scope: 'tonight', night: computeNight(req.params.id, current) });
  }
  const nights = getStoredNights(req.params.id, 1);
  return res.json({ scope: 'last', night: nights[0] || null });
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
