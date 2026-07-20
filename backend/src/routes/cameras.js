import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { upsertPath, removePath, getPathStatus, toPathName } from '../lib/mediamtx.js';
import { startTranscoder, stopTranscoder } from '../lib/transcoder.js';
import { getReading, subscribeAllCameraTopics } from '../lib/mqttClient.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

function isValidRtsp(url) {
  return typeof url === 'string' && /^rtsps?:\/\/.+/i.test(url.trim());
}

router.get('/', async (req, res) => {
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY sort_order, created_at').all();
  const withStatus = await Promise.all(
    cameras.map(async (cam) => ({
      ...cam,
      status: await getPathStatus(cam.mediamtx_path),
      mqtt: cam.mqtt_topic ? getReading(cam.mqtt_topic) : null,
    }))
  );
  res.json(withStatus);
});

// Persists a custom drag-and-drop order for the Nursery page. Mounted before /:id so
// Express matches this literal path first, rather than treating "reorder" as an :id.
router.put('/reorder', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
    return res.status(400).json({ error: 'order must be an array of camera ids' });
  }
  const setOrder = db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?');
  const applyOrder = db.transaction((ids) => {
    ids.forEach((id, index) => setOrder.run(index, id));
  });
  applyOrder(order);
  res.json({ ok: true });
});

router.post('/', requireAdmin, async (req, res) => {
  const { name, rtsp_url, child_id, mqtt_topic } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isValidRtsp(rtsp_url)) {
    return res.status(400).json({ error: 'A valid rtsp:// URL is required' });
  }
  const id = uuid();
  const mediamtx_path = toPathName(id);
  try {
    await upsertPath(mediamtx_path);
  } catch (e) {
    return res.status(502).json({ error: `Could not register stream with MediaMTX: ${e.message}` });
  }
  const { maxOrder } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM cameras').get();
  db.prepare(
    'INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, mqtt_topic) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, name.trim(), rtsp_url.trim(), child_id || null, mediamtx_path, maxOrder + 1, mqtt_topic?.trim() || null);
  await startTranscoder(id, rtsp_url.trim(), mediamtx_path);
  subscribeAllCameraTopics();
  res.status(201).json(db.prepare('SELECT * FROM cameras WHERE id = ?').get(id));
});

router.put('/:id', async (req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  const { name, rtsp_url, child_id, mqtt_topic } = req.body || {};
  const newRtsp = rtsp_url !== undefined ? rtsp_url.trim() : existing.rtsp_url;
  if (rtsp_url !== undefined && !isValidRtsp(rtsp_url)) {
    return res.status(400).json({ error: 'A valid rtsp:// URL is required' });
  }
  if (newRtsp !== existing.rtsp_url) {
    try {
      await upsertPath(existing.mediamtx_path);
    } catch (e) {
      return res.status(502).json({ error: `Could not update stream: ${e.message}` });
    }
    // RTSP URL changed - restart the transcoder pointed at the new address.
    await startTranscoder(req.params.id, newRtsp, existing.mediamtx_path);
  }
  db.prepare('UPDATE cameras SET name = ?, rtsp_url = ?, child_id = ?, mqtt_topic = ? WHERE id = ?').run(
    name?.trim() || existing.name,
    newRtsp,
    child_id !== undefined ? child_id || null : existing.child_id,
    mqtt_topic !== undefined ? mqtt_topic?.trim() || null : existing.mqtt_topic,
    req.params.id
  );
  subscribeAllCameraTopics();
  res.json(db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id));
});

// Dedicated assignment endpoint: attach (or unattach with child_id: null) a camera to a child.
router.put('/:id/assign', (req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  const { child_id } = req.body || {};
  if (child_id) {
    const child = db.prepare('SELECT id FROM children WHERE id = ?').get(child_id);
    if (!child) return res.status(400).json({ error: 'Child not found' });
  }
  db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(child_id || null, req.params.id);
  res.json(db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id));
});

router.delete('/:id', async (req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  await stopTranscoder(req.params.id);
  try {
    await removePath(existing.mediamtx_path);
  } catch (e) {
    // Log but don't block deletion of the DB record.
    logger.error('Failed to remove MediaMTX path:', e.message);
  }
  db.prepare('DELETE FROM cameras WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
