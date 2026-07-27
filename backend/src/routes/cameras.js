import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { upsertPath, removePath, getPathStatus, toPathName } from '../lib/mediamtx.js';
import { startTranscoder, stopTranscoder } from '../lib/transcoder.js';
import { getReading, subscribeAllCameraTopics } from '../lib/mqttClient.js';
import { probeOnvifCamera, ptzContinuousMove, ptzStop } from '../lib/onvif.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

function isValidRtsp(url) {
  return typeof url === 'string' && /^rtsps?:\/\/.+/i.test(url.trim());
}

// ONVIF auto-fill: given a camera's IP + ONVIF credentials, connect and return a
// ready-to-use RTSP URL plus detected codec/resolution, so the admin doesn't hand-type the
// RTSP path. Read-only probe - creates nothing; the normal POST / still does the adding.
router.post('/onvif-probe', requireAdmin, async (req, res) => {
  const { host, port, username, password } = req.body || {};
  if (!host || !host.trim()) return res.status(400).json({ error: 'Camera IP address is required' });
  try {
    const result = await probeOnvifCamera({ host, port, username, password });
    res.json(result);
  } catch (err) {
    // Expected failure mode (wrong IP/creds, not an ONVIF camera, timeout) - 502, not 500,
    // and pass the message through so the UI can show it.
    logger.info(`[onvif] probe of ${host} failed: ${err.message}`);
    res.status(502).json({ error: err.message || 'ONVIF probe failed' });
  }
});

// PTZ control. Any signed-in user can reposition a camera (day-to-day, like reordering) -
// not admin-only. The camera auto-stops a few seconds after a move server-side (runaway
// failsafe in ptzContinuousMove); the client also calls /stop on release.
function ptzConnForCamera(id, res) {
  const cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
  if (!cam) {
    res.status(404).json({ error: 'Camera not found' });
    return null;
  }
  if (!cam.ptz_supported || !cam.onvif_device_url) {
    res.status(400).json({ error: 'This camera does not support PTZ' });
    return null;
  }
  try {
    const u = new URL(cam.onvif_device_url);
    return {
      host: u.hostname,
      port: u.port || 80,
      username: cam.onvif_username,
      password: cam.onvif_password,
      profileToken: cam.onvif_profile_token,
    };
  } catch {
    res.status(500).json({ error: 'Stored ONVIF address for this camera is invalid' });
    return null;
  }
}

router.post('/:id/ptz/move', async (req, res) => {
  const conn = ptzConnForCamera(req.params.id, res);
  if (!conn) return;
  const { pan, tilt, zoom } = req.body || {};
  try {
    await ptzContinuousMove({ ...conn, pan, tilt, zoom });
    res.json({ ok: true });
  } catch (e) {
    logger.info(`[ptz] move failed for ${req.params.id}: ${e.message}`);
    res.status(502).json({ error: e.message || 'PTZ move failed' });
  }
});

router.post('/:id/ptz/stop', async (req, res) => {
  const conn = ptzConnForCamera(req.params.id, res);
  if (!conn) return;
  try {
    await ptzStop(conn);
    res.json({ ok: true });
  } catch (e) {
    logger.info(`[ptz] stop failed for ${req.params.id}: ${e.message}`);
    res.status(502).json({ error: e.message || 'PTZ stop failed' });
  }
});

router.get('/', async (req, res) => {
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY sort_order, created_at').all();
  const isAdmin = req.user?.role === 'admin';
  const withStatus = await Promise.all(
    // rtsp_url and the ONVIF credentials embed camera logins - only the admin's
    // camera-management form needs them back; strip them for everyone else. ptz_supported
    // and onvif_device_url stay (the tiles need to know whether to show PTZ controls).
    cameras.map(async ({ rtsp_url, onvif_username, onvif_password, ...cam }) => ({
      ...cam,
      ...(isAdmin ? { rtsp_url, onvif_username, onvif_password } : {}),
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
  const {
    name, rtsp_url, child_id, mqtt_topic,
    discovery_source, onvif_device_url, backchannel_supported,
    ptz_supported, onvif_username, onvif_password, onvif_profile_token,
  } = req.body || {};
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
  // Record ONVIF provenance when the RTSP URL was auto-filled via the probe above, so
  // later ONVIF work (capability check, PTZ) can reconnect. Defaults to a plain manual add.
  const source = discovery_source === 'onvif' ? 'onvif' : 'manual';
  const isOnvif = source === 'onvif';
  const onvifUrl = isOnvif && onvif_device_url ? onvif_device_url.trim() : null;
  const backchannel = ['yes', 'no'].includes(backchannel_supported) ? backchannel_supported : 'unknown';
  // PTZ control needs the ONVIF credentials + profile token later - only meaningful for
  // ONVIF-added cameras. ptz_supported gates whether the UI ever shows PTZ controls.
  const ptz = isOnvif && ptz_supported ? 1 : 0;
  const onvifUser = isOnvif ? onvif_username || null : null;
  const onvifPass = isOnvif ? onvif_password || null : null;
  const profileToken = isOnvif ? onvif_profile_token || null : null;
  const { maxOrder } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM cameras').get();
  db.prepare(
    `INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, mqtt_topic,
       discovery_source, onvif_capable, onvif_device_url, backchannel_supported,
       ptz_supported, onvif_username, onvif_password, onvif_profile_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, name.trim(), rtsp_url.trim(), child_id || null, mediamtx_path, maxOrder + 1, mqtt_topic?.trim() || null,
    source, isOnvif ? 1 : 0, onvifUrl, backchannel,
    ptz, onvifUser, onvifPass, profileToken
  );
  await startTranscoder(id, rtsp_url.trim(), mediamtx_path, name.trim());
  subscribeAllCameraTopics();
  res.status(201).json(db.prepare('SELECT * FROM cameras WHERE id = ?').get(id));
});

// Admin-only, same as adding one: editing includes changing the RTSP URL, which
// points this server's FFmpeg at an arbitrary address - that's camera management,
// not day-to-day caregiving. (Reordering and child assignment below stay open to
// every signed-in user - those are cosmetic.)
router.put('/:id', requireAdmin, async (req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  const { name, rtsp_url, child_id, mqtt_topic } = req.body || {};
  if (rtsp_url !== undefined && !isValidRtsp(rtsp_url)) {
    return res.status(400).json({ error: 'A valid rtsp:// URL is required' });
  }
  const newRtsp = rtsp_url !== undefined ? rtsp_url.trim() : existing.rtsp_url;
  if (newRtsp !== existing.rtsp_url) {
    try {
      await upsertPath(existing.mediamtx_path);
    } catch (e) {
      return res.status(502).json({ error: `Could not update stream: ${e.message}` });
    }
    // RTSP URL changed - restart the transcoder pointed at the new address.
    await startTranscoder(req.params.id, newRtsp, existing.mediamtx_path, name?.trim() || existing.name);
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

router.delete('/:id', requireAdmin, async (req, res) => {
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
