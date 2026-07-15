import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';

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
  const id = uuid();
  db.prepare('INSERT INTO children (id, name, birthday, color) VALUES (?, ?, ?, ?)').run(
    id,
    name.trim(),
    birthday || null,
    color || '#F5D9A8'
  );
  res.status(201).json(withCameras(db.prepare('SELECT * FROM children WHERE id = ?').get(id)));
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Child not found' });
  const { name, birthday, color } = req.body || {};
  db.prepare('UPDATE children SET name = ?, birthday = ?, color = ? WHERE id = ?').run(
    name?.trim() || existing.name,
    birthday !== undefined ? birthday : existing.birthday,
    color || existing.color,
    req.params.id
  );
  res.json(withCameras(db.prepare('SELECT * FROM children WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', (req, res) => {
  db.prepare('UPDATE cameras SET child_id = NULL WHERE child_id = ?').run(req.params.id);
  db.prepare('DELETE FROM children WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
