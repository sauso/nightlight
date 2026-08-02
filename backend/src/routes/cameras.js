import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { upsertPath, removePath, getPathStatus, toPathName } from '../lib/mediamtx.js';
import { startTranscoder, stopTranscoder } from '../lib/transcoder.js';
import { startSubStream, stopSubStream, subConfigured } from '../lib/subStream.js';
import { getReading, subscribeAllCameraTopics } from '../lib/mqttClient.js';
import { probeOnvifCamera, ptzNudge } from '../lib/onvif.js';
import { validateRtspStream } from '../lib/rtspProbe.js';
import { logger } from '../lib/logger.js';

const router = Router();
router.use(requireAuth);

function isValidRtsp(url) {
  return typeof url === 'string' && /^rtsps?:\/\/.+/i.test(url.trim());
}

// The credential parts live in the UI as separate fields (IP / port / path / username /
// password) and only get combined into the rtsp:// URL that FFmpeg uses here on the server -
// so the password never appears in a visible URL field. assembleRtspUrl builds the URL;
// parseRtspComponents splits an existing one back into fields for the edit form.
function assembleRtspUrl({ host, port, path, username, password }) {
  const h = String(host || '').trim();
  if (!h) return null;
  const p = String(port || '').trim() || '554';
  let pathPart = String(path || '').trim();
  if (pathPart && !pathPart.startsWith('/')) pathPart = `/${pathPart}`;
  const cred = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@` : '';
  return `rtsp://${cred}${h}:${p}${pathPart}`;
}
function parseRtspComponents(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: u.port || '554',
      path: (u.pathname || '') + (u.search || ''),
      username: u.username ? decodeURIComponent(u.username) : '',
      password: u.password ? decodeURIComponent(u.password) : '',
    };
  } catch {
    return null;
  }
}

// Sanitized camera for API responses: never leaks the password or the credentialed URL.
// Admins additionally get the address broken into fields (for the edit form) plus a
// credential-free display URL and a flag for whether a password is set. ONVIF credentials
// (used server-side for PTZ) are always stripped.
function publicCamera(cam, isAdmin) {
  const { rtsp_url, onvif_username, onvif_password, talk_username, talk_password, sub_rtsp_url, ...rest } = cam;
  // talk_configured / has_sub (safe for everyone) drive the tile's talk button + quality selector.
  const base = {
    ...rest,
    talk_configured: !!(cam.talk_backend && talk_username && talk_password),
    has_sub: !!(sub_rtsp_url && sub_rtsp_url.trim()),
  };
  if (!isAdmin) return base;
  const parts = parseRtspComponents(rtsp_url) || {};
  const subParts = sub_rtsp_url ? parseRtspComponents(sub_rtsp_url) || {} : {};
  return {
    ...base,
    rtsp_host: parts.host || '',
    rtsp_port: parts.port || '',
    rtsp_path: parts.path || '',
    rtsp_username: parts.username || '',
    rtsp_has_password: !!parts.password,
    rtsp_display: parts.host ? `rtsp://${parts.host}:${parts.port}${parts.path || ''}` : '',
    // Two-way-audio creds for the edit form: username shown, password never returned (a set flag
    // plus "blank keeps existing" on save, same pattern as the RTSP password).
    talk_username: talk_username || '',
    talk_has_password: !!talk_password,
    // Low-quality sub-stream: only the path is edited (it reuses the main stream's host/creds).
    sub_rtsp_path: subParts.path || '',
  };
}

// ONVIF auto-fill: given a camera's IP + ONVIF credentials, connect and return a
// ready-to-use RTSP URL plus detected codec/resolution, so the admin doesn't hand-type the
// RTSP path. Read-only probe - creates nothing; the normal POST / still does the adding.
router.post('/onvif-probe', requireAdmin, async (req, res) => {
  const { host, port, username, password } = req.body || {};
  if (!host || !host.trim()) return res.status(400).json({ error: 'Camera IP address is required' });
  try {
    // Cap the whole probe so a slow/unresponsive camera can't keep the request open long
    // enough for a reverse proxy in front of us to time out and return its own (bodiless)
    // 502 - which the client can only show as a generic "Request failed". We'd rather always
    // answer with a clear JSON error the UI can surface in the add-camera dialog.
    const result = await Promise.race([
      probeOnvifCamera({ host, port, username, password }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('ONVIF probe timed out — the camera didn’t respond in time. Check the IP/port, that the camera is reachable, and the ONVIF username/password.')),
          18000
        )
      ),
    ]);
    res.json(result);
  } catch (err) {
    // Expected failure mode (wrong IP/creds, not an ONVIF camera, timeout). Use 422, NOT a
    // 5xx: a reverse proxy (e.g. Cloudflare) will replace a 5xx from the origin with its own
    // bodiless error page, so the client would only ever see a generic "Request failed (502)"
    // instead of the real reason. A 4xx passes through with our JSON message intact.
    logger.info(`[onvif] probe of ${host} failed: ${err.message}`);
    res.status(422).json({ error: err.message || 'ONVIF probe failed' });
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

// One fixed-distance nudge per call (start -> hold -> stop, server-side), so each press of
// a D-pad arrow travels a consistent amount. The client sends one per tap, and repeats while
// a button is held for continued movement.
router.post('/:id/ptz/nudge', async (req, res) => {
  const conn = ptzConnForCamera(req.params.id, res);
  if (!conn) return;
  const { pan, tilt, zoom } = req.body || {};
  try {
    await ptzNudge({ ...conn, pan, tilt, zoom });
    res.json({ ok: true });
  } catch (e) {
    logger.info(`[ptz] nudge failed for ${req.params.id}: ${e.message}`);
    res.status(502).json({ error: e.message || 'PTZ move failed' });
  }
});

router.get('/', async (req, res) => {
  const cameras = db.prepare('SELECT * FROM cameras ORDER BY sort_order, created_at').all();
  const isAdmin = req.user?.role === 'admin';
  const withStatus = await Promise.all(
    cameras.map(async (cam) => ({
      ...publicCamera(cam, isAdmin),
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
    name, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password,
    child_id, mqtt_topic, force,
    discovery_source, onvif_device_url, backchannel_supported,
    ptz_supported, onvif_profile_token,
  } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const rtsp_url = assembleRtspUrl({
    host: rtsp_host,
    port: rtsp_port,
    path: rtsp_path,
    username: rtsp_username,
    password: rtsp_password,
  });
  if (!isValidRtsp(rtsp_url)) {
    return res.status(400).json({ error: 'A camera IP address is required' });
  }
  // Verify the stream actually works before saving (unless the user chose "save anyway"
  // after a failed check). Catches wrong credentials / path / IP instead of storing a dead
  // camera. 422 + needsConfirm lets the UI offer an override for a camera that's just
  // briefly offline.
  if (!force) {
    const check = await validateRtspStream(rtsp_url);
    if (!check.ok) {
      return res.status(422).json({ error: `Couldn't reach the camera stream: ${check.error}`, needsConfirm: true });
    }
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
  // ONVIF control (PTZ) reuses the same single credential set the user entered for the
  // camera - no separate ONVIF login to enter twice.
  const onvifUser = isOnvif ? rtsp_username || null : null;
  const onvifPass = isOnvif ? rtsp_password || null : null;
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
  await startTranscoder(id, rtsp_url, mediamtx_path, name.trim());
  subscribeAllCameraTopics();
  res.status(201).json(publicCamera(db.prepare('SELECT * FROM cameras WHERE id = ?').get(id), true));
});

// Admin-only, same as adding one: editing includes changing the RTSP URL, which
// points this server's FFmpeg at an arbitrary address - that's camera management,
// not day-to-day caregiving. (Reordering and child assignment below stay open to
// every signed-in user - those are cosmetic.)
router.put('/:id', requireAdmin, async (req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  const { name, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password, child_id, mqtt_topic, force,
    talk_username, talk_password, sub_rtsp_path } = req.body || {};

  // Reassemble the RTSP URL from the edited fields. A field not sent keeps its current
  // value; a blank password specifically means "keep the existing one" (the browser never
  // received it, so it can't resend it). Nothing address-related sent => URL unchanged.
  let newRtsp = existing.rtsp_url;
  const addressEdited = [rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password].some((v) => v !== undefined);
  if (addressEdited) {
    const cur = parseRtspComponents(existing.rtsp_url) || {};
    const password = rtsp_password ? rtsp_password : cur.password; // blank/absent => keep
    newRtsp = assembleRtspUrl({
      host: rtsp_host !== undefined ? rtsp_host : cur.host,
      port: rtsp_port !== undefined ? rtsp_port : cur.port,
      path: rtsp_path !== undefined ? rtsp_path : cur.path,
      username: rtsp_username !== undefined ? rtsp_username : cur.username,
      password,
    });
    if (!isValidRtsp(newRtsp)) return res.status(400).json({ error: 'A camera IP address is required' });
  }

  // Validate the new address before applying it (unless overridden) - same as adding.
  if (newRtsp !== existing.rtsp_url && !force) {
    const check = await validateRtspStream(newRtsp);
    if (!check.ok) {
      return res.status(422).json({ error: `Couldn't reach the camera stream: ${check.error}`, needsConfirm: true });
    }
  }

  // A disabled camera has no MediaMTX path or transcoder by design - just save the new
  // address; it takes effect when the camera is re-enabled. Touching MediaMTX here would
  // silently bring a turned-off camera back to life.
  if (newRtsp !== existing.rtsp_url && !existing.disabled) {
    try {
      await upsertPath(existing.mediamtx_path);
    } catch (e) {
      return res.status(502).json({ error: `Could not update stream: ${e.message}` });
    }
    // Address changed - restart the transcoder pointed at the new one.
    await startTranscoder(req.params.id, newRtsp, existing.mediamtx_path, name?.trim() || existing.name);
  }
  // Two-way audio credentials. talk_username not sent => leave unchanged; sent empty => disable
  // talk-back (clear backend + creds); a value => enable the Hikvision ISAPI sink. A blank password
  // keeps the stored one (same "blank = keep" rule as the RTSP password).
  let talkBackend = existing.talk_backend;
  let talkUser = existing.talk_username;
  let talkPass = existing.talk_password;
  if (talk_username !== undefined) {
    if (!talk_username.trim()) {
      talkBackend = null; talkUser = null; talkPass = null;
    } else {
      talkBackend = 'hikvision-isapi';
      talkUser = talk_username.trim();
      talkPass = talk_password ? talk_password : existing.talk_password;
    }
  }
  // Low-quality sub-stream (adaptive quality). sub_rtsp_path not sent => unchanged; sent empty =>
  // no sub-stream; a value => build a sub URL reusing the (possibly updated) main stream's host/
  // port/creds, differing only in the path (e.g. Hikvision .../Streaming/Channels/102).
  let subUrl = existing.sub_rtsp_url;
  if (sub_rtsp_path !== undefined) {
    const sp = String(sub_rtsp_path).trim();
    if (!sp) {
      subUrl = null;
    } else {
      const cur = parseRtspComponents(newRtsp) || {};
      subUrl = assembleRtspUrl({ host: cur.host, port: cur.port, path: sp, username: cur.username, password: cur.password });
    }
  }
  db.prepare('UPDATE cameras SET name = ?, rtsp_url = ?, child_id = ?, mqtt_topic = ?, talk_backend = ?, talk_username = ?, talk_password = ?, sub_rtsp_url = ? WHERE id = ?').run(
    name?.trim() || existing.name,
    newRtsp,
    child_id !== undefined ? child_id || null : existing.child_id,
    mqtt_topic !== undefined ? mqtt_topic?.trim() || null : existing.mqtt_topic,
    talkBackend,
    talkUser,
    talkPass,
    subUrl,
    req.params.id
  );
  // Apply the sub-stream change to the running pipeline (unless the camera is disabled): start/
  // restart its transcoder if a sub-stream is configured, or tear it down if it was cleared.
  if (!existing.disabled) {
    const updated = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    try {
      if (subConfigured(updated)) await startSubStream(updated);
      else await stopSubStream(updated);
    } catch (e) {
      logger.error(`[substream] failed to apply for ${updated.name}: ${e.message}`);
    }
  }
  subscribeAllCameraTopics();
  res.json(publicCamera(db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id), true));
});

// Turn a camera fully on/off server-side (admin-only, like editing). Disabling stops the
// transcoder and drops the MediaMTX path, so it stops pulling from the camera and streaming
// entirely; enabling re-registers the path and restarts the transcoder. The row (and its
// settings/history) is kept - this is a reversible on/off switch, not a delete.
router.put('/:id/enabled', requireAdmin, async (req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  const enabled = !!(req.body || {}).enabled;
  if (enabled) {
    try {
      await upsertPath(existing.mediamtx_path);
    } catch (e) {
      return res.status(502).json({ error: `Could not re-register stream with MediaMTX: ${e.message}` });
    }
    await startTranscoder(req.params.id, existing.rtsp_url, existing.mediamtx_path, existing.name);
    if (subConfigured(existing)) await startSubStream(existing).catch((e) => logger.error(`[substream] enable failed: ${e.message}`));
  } else {
    await stopTranscoder(req.params.id);
    await stopSubStream(existing).catch(() => {});
    try {
      await removePath(existing.mediamtx_path);
    } catch (e) {
      // Log but still record it as disabled - the transcoder is already stopped, so no
      // frames flow regardless of whether the path removal succeeded.
      logger.error('Failed to remove MediaMTX path on disable:', e.message);
    }
  }
  db.prepare('UPDATE cameras SET disabled = ? WHERE id = ?').run(enabled ? 0 : 1, req.params.id);
  res.json(publicCamera(db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id), true));
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
  await stopSubStream(existing).catch(() => {});
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
