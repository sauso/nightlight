import { Router } from 'express';
import { readFileSync } from 'fs';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth, requireAdmin, requireAuthQueryOrHeader } from '../middleware/auth.js';
import { upsertPath, removePath, getPathStatus, toPathName } from '../lib/mediamtx.js';
import { startTranscoder, stopTranscoder } from '../lib/transcoder.js';
import { startSubStream, stopSubStream, subConfigured } from '../lib/subStream.js';
import { startMotionDetector, stopMotionDetector } from '../lib/motionDetector.js';
import { startSoundDetector, stopSoundDetector } from '../lib/soundDetector.js';
import { startClipCapture, stopClipCapture } from '../lib/clipCapture.js';
import {
  getRecentDetectionEvents,
  clearDetectionEvents,
  getEventSnapshotFile,
  getEventClipFile,
  deleteClipForEvent,
  getClips,
} from '../lib/detectionEvents.js';
import { verifyTalkCreds } from '../lib/twoWayAudio.js';
import { getReading, subscribeAllCameraTopics, refreshMqttConnection } from '../lib/mqttClient.js';
import { probeOnvifCamera, ptzNudge, ptzRelativeStep, probePtzRelativeSupport } from '../lib/onvif.js';
import { validateRtspStream, probeRtspDetailed, ffprobeVersion } from '../lib/rtspProbe.js';
import { logger } from '../lib/logger.js';

const router = Router();

// App version for the camera report (read once). Best-effort — matches routes/diagnostics.js.
let appVersion = 'unknown';
try {
  const url = new URL('../../package.json', import.meta.url);
  appVersion = JSON.parse(readFileSync(url, 'utf8')).version;
} catch { /* leave as unknown */ }

// Alert snapshot image — any authenticated user. Registered BEFORE the router-wide requireAuth
// so it can accept a ?token= query param: an <img> can't attach an Authorization header (same
// reason HLS uses query-token auth). The literal "/alerts/" prefix keeps it clear of the /:id
// routes further down.
router.get('/alerts/:id/snapshot', requireAuthQueryOrHeader, (req, res) => {
  const file = getEventSnapshotFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No snapshot for this alert' });
  res.sendFile(file);
});

// Recorded clip for an alert — same query-token auth as the snapshot above (a <video> element
// fetches the URL itself and can't attach an Authorization header). res.sendFile honours Range
// requests, so seeking/scrubbing works out of the box. 404 until the clip is 'ready'.
router.get('/alerts/:id/clip', requireAuthQueryOrHeader, (req, res) => {
  const file = getEventClipFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No clip for this alert' });
  res.sendFile(file);
});

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
// The crib zone is stored as a JSON string {x,y,w,h} in 0..1 frame fractions (null = whole
// frame). Parse leniently for output; null on anything malformed.
function parseZone(raw) {
  if (!raw) return null;
  try {
    const z = JSON.parse(raw);
    if (z && ['x', 'y', 'w', 'h'].every((k) => typeof z[k] === 'number')) return z;
  } catch {
    /* fall through */
  }
  return null;
}

// Validate + clamp a zone from the client into a storable JSON string (or null = whole frame).
function serializeZone(z) {
  if (!z) return null;
  const nums = ['x', 'y', 'w', 'h'].map((k) => Number(z[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums.map((n) => Math.min(1, Math.max(0, n)));
  if (w <= 0 || h <= 0) return null;
  return JSON.stringify({ x, y, w, h });
}

function publicCamera(cam, isAdmin) {
  // snapshot_url can carry Basic-auth creds, so keep it admin-only (like the RTSP/ONVIF secrets).
  const { rtsp_url, onvif_username, onvif_password, talk_username, talk_password, sub_rtsp_url, snapshot_url, ...rest } = cam;
  // talk_configured / has_sub (safe for everyone) drive the tile's talk button + quality selector.
  const base = {
    ...rest,
    talk_configured: !!(cam.talk_backend && talk_username && talk_password),
    has_sub: !!(sub_rtsp_url && sub_rtsp_url.trim()),
    // Parse the crib zone (stored as a JSON string) into an object for the client.
    detect_zone: parseZone(cam.detect_zone),
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
    // Camera HTTP snapshot endpoint (admin-only — may embed Basic-auth creds), edited as-is.
    snapshot_url: snapshot_url || '',
  };
}

// ONVIF auto-fill: given a camera's IP + ONVIF credentials, connect and return a
// ready-to-use RTSP URL plus detected codec/resolution, so the admin doesn't hand-type the
// RTSP path. Read-only probe - creates nothing; the normal POST / still does the adding.
router.post('/onvif-probe', requireAdmin, async (req, res) => {
  const { host, port, username, id } = req.body || {};
  let { password } = req.body || {};
  if (!host || !host.trim()) return res.status(400).json({ error: 'Camera IP address is required' });
  // On edit, the password field comes back blank (we never return it). Fall back to the stored
  // credential so re-fetching ONVIF on an existing camera works without re-typing the password.
  if (!password && id) {
    const cam = db.prepare('SELECT rtsp_url, onvif_password FROM cameras WHERE id = ?').get(id);
    password = cam?.onvif_password || parseRtspComponents(cam?.rtsp_url || '')?.password || undefined;
  }
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

// "Unsupported camera" diagnostic report. When adding a camera fails (ONVIF probe or stream
// validation), the add screen offers to build this — a redacted JSON bundle of exactly what's needed
// to add support for a new camera: the address (no password), what ONVIF returned (or the fault), and
// a full ffprobe stream/codec dump of the main + low streams. The user downloads it and attaches it
// to a GitHub issue. Read-only; creates nothing. NEVER includes the password (only host/port/path/
// user + a has_password flag) — same allow-list discipline as the diagnostics bundle.
router.post('/probe-report', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const host = String(b.host || b.rtsp_host || '').trim();
  const port = String(b.port || b.rtsp_port || '554').trim() || '554';
  const rtspPath = String(b.path || b.rtsp_path || '').trim();
  const subPath = String(b.sub_path || b.sub_rtsp_path || '').trim();
  let username = String(b.username || b.rtsp_username || '').trim();
  let password = b.password || b.rtsp_password || '';
  const id = b.id;
  if (!host) return res.status(400).json({ error: 'Camera IP address is required to build a report.' });
  // On edit the password comes back blank (never returned); fall back to the stored credentials for
  // whichever field the caller didn't supply, so the probe authenticates like the real camera does.
  if (id && (!username || !password)) {
    const cam = db.prepare('SELECT rtsp_url, onvif_password FROM cameras WHERE id = ?').get(id);
    const parts = parseRtspComponents(cam?.rtsp_url || '') || {};
    if (!username) username = parts.username || '';
    if (!password) password = parts.password || cam?.onvif_password || '';
  }

  const withTimeout = (p, ms, onTimeout) =>
    Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(onTimeout), ms))]);

  // ONVIF: capture the result or the fault/error message — both are useful for adding support.
  let onvif;
  try {
    const r = await withTimeout(
      probeOnvifCamera({ host, port, username, password }),
      18000,
      { __timeout: true }
    );
    onvif = r && r.__timeout ? { ok: false, error: 'ONVIF probe timed out (no response in 18s)' } : { ok: true, ...r };
  } catch (err) {
    onvif = { ok: false, error: err.message || 'ONVIF probe failed' };
  }

  // Full stream/codec dump for the main and (if given) low-quality paths.
  const mainStream = await probeRtspDetailed(assembleRtspUrl({ host, port, path: rtspPath, username, password }));
  const subStream = subPath
    ? await probeRtspDetailed(assembleRtspUrl({ host, port, path: subPath, username, password }))
    : null;

  const report = {
    report: 'nightlight-camera-probe',
    note: 'Redacted camera report for adding support — address, ONVIF result, and stream codecs, but NO password. Review before sharing.',
    generated_at: new Date().toISOString(),
    app: {
      version: appVersion,
      git_sha: process.env.NIGHTLIGHT_GIT_SHA || null,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ffprobe: await ffprobeVersion(),
    },
    camera: {
      rtsp_host: host,
      rtsp_port: port,
      rtsp_path: rtspPath || null,
      sub_rtsp_path: subPath || null,
      rtsp_username: username || null,
      rtsp_has_password: !!password,
      mqtt_topic: (b.mqtt_topic || '').trim() || null,
    },
    onvif,
    stream_main: mainStream,
    stream_low: subStream,
  };

  logger.info(`[camera-report] built for ${host}:${port}${rtspPath} (onvif ${onvif.ok ? 'ok' : 'failed'}, main ${mainStream.ok ? 'ok' : 'failed'})`);
  res.json(report);
});

// PTZ control. Any signed-in user can reposition a camera (day-to-day, like reordering) -
// not admin-only. The camera auto-stops a few seconds after a move server-side (runaway
// failsafe in ptzContinuousMove); the client also calls /stop on release.
// Returns { cam, conn } for a PTZ-capable camera, or null after having sent the error response.
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
      cam,
      conn: {
        host: u.hostname,
        port: u.port || 80,
        username: cam.onvif_username,
        password: cam.onvif_password,
        profileToken: cam.onvif_profile_token,
      },
    };
  } catch {
    res.status(500).json({ error: 'Stored ONVIF address for this camera is invalid' });
    return null;
  }
}

// One fixed-distance step per call, so each press of a D-pad arrow travels a consistent amount. The
// client sends one per tap and repeats while a button is held. Prefer ONVIF RelativeMove (the camera
// moves a set distance and stops itself — deterministic) when the camera supports it; fall back to
// the continuous start->hold->stop nudge otherwise. Relative support is probed once on first PTZ and
// cached in cameras.ptz_relative (null = unprobed).
router.post('/:id/ptz/nudge', async (req, res) => {
  const ctx = ptzConnForCamera(req.params.id, res);
  if (!ctx) return;
  const { cam, conn } = ctx;
  const { pan, tilt, zoom } = req.body || {};
  try {
    let relative = cam.ptz_relative;
    if (relative === null || relative === undefined) {
      relative = (await probePtzRelativeSupport(conn)) ? 1 : 0;
      db.prepare('UPDATE cameras SET ptz_relative = ? WHERE id = ?').run(relative, cam.id);
      logger.info(`[ptz] ${cam.name}: RelativeMove support = ${relative ? 'yes' : 'no'} (probed)`);
    }
    if (relative) {
      try {
        const step = db.prepare('SELECT ptz_step FROM settings WHERE id = ?').get('app')?.ptz_step;
        await ptzRelativeStep({ ...conn, pan, tilt, zoom, step });
        return res.json({ ok: true });
      } catch (e) {
        // Advertised but this move failed — fall back to the continuous nudge for THIS call. Left
        // as still-supported (a transient failure shouldn't permanently downgrade the camera).
        logger.info(`[ptz] ${cam.name}: RelativeMove failed (${e.message}); falling back to continuous nudge`);
      }
    }
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

// Recent detection alerts (motion now, sound later) — the "Recent alerts" list. Any signed-in
// caregiver can see them. Literal path, mounted before /:id so it isn't treated as an :id.
router.get('/alerts', requireAuth, (req, res) => {
  res.json(getRecentDetectionEvents(200));
});

// Clear the whole Recent alerts history (admin only). Mounted before /:id like the GET above.
router.delete('/alerts', requireAuth, requireAdmin, (req, res) => {
  res.json({ cleared: clearDetectionEvents() });
});

// Delete just the recorded clip for one alert (any signed-in user — it's a contextual action on an
// alert they can already see). Removes the video file; the alert row + snapshot stay.
router.delete('/alerts/:id/clip', requireAuth, (req, res) => {
  const had = deleteClipForEvent(req.params.id);
  if (!had) return res.status(404).json({ error: 'No clip for this alert' });
  res.status(204).end();
});

// List every alert that has a playable clip, for the Clip Management screen. Metadata only.
router.get('/clips', requireAuth, (req, res) => {
  res.json(getClips());
});

// Historical temperature/humidity for one camera, for charting on the Child detail page. Any signed-in
// user. `hours` (default 24, capped at 7 days) selects the window; readings are ascending by time so
// the client can plot them directly. Empty array if the camera has no sensor / no samples yet.
router.get('/:id/sensor-history', requireAuth, (req, res) => {
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
  const rows = db
    .prepare(
      `SELECT created_at AS t, temperature, humidity FROM sensor_readings
         WHERE camera_id = ? AND created_at >= datetime('now', ?)
         ORDER BY created_at ASC`
    )
    .all(req.params.id, `-${hours} hours`);
  res.json({ hours, readings: rows });
});

// Per-minute motion/sound activity timeline for one camera (the raw signal sleep tracking is built
// on). Any signed-in user. `hours` (default 24, capped at 7 days); ascending by minute. Empty until
// the camera has run a detector for a while.
router.get('/:id/activity-history', requireAuth, (req, res) => {
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours, 10) || 24));
  const rows = db
    .prepare(
      `SELECT bucket_start AS t, motion_level, motion_peak, sound_level, sound_peak, motion_frames, sound_windows
         FROM activity_samples
         WHERE camera_id = ? AND bucket_start >= datetime('now', ?)
         ORDER BY bucket_start ASC`
    )
    .all(req.params.id, `-${hours} hours`);
  res.json({ hours, samples: rows });
});

// Bulk-delete clips (admin — this lives on the admin Settings screen). Body: { ids: [eventId, ...] }.
router.post('/clips/delete', requireAdmin, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  let deleted = 0;
  for (const id of ids) {
    if (deleteClipForEvent(id)) deleted++;
  }
  res.json({ deleted });
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

// Verify two-way-audio (talk) credentials without saving - the "Verify login" button in the
// add/edit form. On edit, a blank password + camera id falls back to the stored password (same
// "blank = keep" rule as elsewhere). Mounted before /:id so "verify-talk" isn't matched as an :id.
router.post('/verify-talk', requireAdmin, async (req, res) => {
  const { host, username, password, id } = req.body || {};
  if (!host || !host.trim()) return res.status(400).json({ error: 'Camera IP address is required' });
  let pass = password;
  if (!pass && id) pass = db.prepare('SELECT talk_password FROM cameras WHERE id = ?').get(id)?.talk_password || null;
  if (!username || !pass) return res.status(400).json({ error: 'Enter the talk username and password first' });
  const result = await verifyTalkCreds({ host: host.trim(), username, password: pass });
  // 422 (not 5xx) so a reverse proxy passes the message through - see the onvif-probe note above.
  if (!result.ok) return res.status(422).json({ error: result.error || 'Verification failed' });
  res.json({ ok: true, codec: result.codec });
});

router.post('/', requireAdmin, async (req, res) => {
  const {
    name, rtsp_host, rtsp_port, rtsp_path, rtsp_username, rtsp_password,
    child_id, mqtt_topic, force,
    discovery_source, onvif_device_url, backchannel_supported,
    ptz_supported, onvif_profile_token,
    talk_username, talk_password, sub_rtsp_path,
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
  // Two-way audio creds (optional at add time - a username enables the Hikvision ISAPI sink).
  const talkUser = talk_username && talk_username.trim() ? talk_username.trim() : null;
  const talkBackend = talkUser ? 'hikvision-isapi' : null;
  const talkPass = talkUser ? talk_password || null : null;
  // Low-quality sub-stream: a path on the same camera (reuses the main host/port/creds).
  const subUrl = sub_rtsp_path && sub_rtsp_path.trim()
    ? assembleRtspUrl({ host: rtsp_host, port: rtsp_port, path: sub_rtsp_path.trim(), username: rtsp_username, password: rtsp_password })
    : null;
  const { maxOrder } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM cameras').get();
  db.prepare(
    `INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path, sort_order, mqtt_topic,
       discovery_source, onvif_capable, onvif_device_url, backchannel_supported,
       ptz_supported, onvif_username, onvif_password, onvif_profile_token,
       talk_backend, talk_username, talk_password, sub_rtsp_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, name.trim(), rtsp_url.trim(), child_id || null, mediamtx_path, maxOrder + 1, mqtt_topic?.trim() || null,
    source, isOnvif ? 1 : 0, onvifUrl, backchannel,
    ptz, onvifUser, onvifPass, profileToken,
    talkBackend, talkUser, talkPass, subUrl
  );
  await startTranscoder(id, rtsp_url, mediamtx_path, name.trim());
  const added = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
  if (subConfigured(added)) await startSubStream(added).catch((e) => logger.error(`[substream] add failed: ${e.message}`));
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
    talk_username, talk_password, sub_rtsp_path,
    discovery_source, onvif_device_url, backchannel_supported, ptz_supported, onvif_profile_token } = req.body || {};

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
  // ONVIF-detected capabilities, from a re-fetch in the edit form (payload has discovery_source
  // === 'onvif'). Lets an existing camera pick up two-way-audio / PTZ support without re-adding it.
  // A plain edit doesn't send these, so everything stays as-is.
  let discSource = existing.discovery_source;
  let onvifCapable = existing.onvif_capable;
  let onvifUrl = existing.onvif_device_url;
  let backchannel = existing.backchannel_supported;
  let ptz = existing.ptz_supported;
  let profileToken = existing.onvif_profile_token;
  let onvifUser = existing.onvif_username;
  let onvifPass = existing.onvif_password;
  if (discovery_source === 'onvif') {
    discSource = 'onvif';
    onvifCapable = 1;
    if (onvif_device_url !== undefined) onvifUrl = onvif_device_url ? onvif_device_url.trim() : null;
    if (backchannel_supported !== undefined) backchannel = ['yes', 'no'].includes(backchannel_supported) ? backchannel_supported : 'unknown';
    if (ptz_supported !== undefined) ptz = ptz_supported ? 1 : 0;
    if (onvif_profile_token !== undefined) profileToken = onvif_profile_token || null;
    // ONVIF control (PTZ) reuses the RTSP credentials the user entered.
    if (rtsp_username !== undefined) onvifUser = rtsp_username || null;
    if (rtsp_password) onvifPass = rtsp_password; // blank keeps the stored one
  }
  db.prepare(`UPDATE cameras SET name = ?, rtsp_url = ?, child_id = ?, mqtt_topic = ?,
      talk_backend = ?, talk_username = ?, talk_password = ?, sub_rtsp_url = ?,
      discovery_source = ?, onvif_capable = ?, onvif_device_url = ?, backchannel_supported = ?,
      ptz_supported = ?, onvif_profile_token = ?, onvif_username = ?, onvif_password = ?
    WHERE id = ?`).run(
    name?.trim() || existing.name,
    newRtsp,
    child_id !== undefined ? child_id || null : existing.child_id,
    mqtt_topic !== undefined ? mqtt_topic?.trim() || null : existing.mqtt_topic,
    talkBackend,
    talkUser,
    talkPass,
    subUrl,
    discSource,
    onvifCapable,
    onvifUrl,
    backchannel,
    ptz,
    profileToken,
    onvifUser,
    onvifPass,
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
    // The stream (or which path the detector should read) may have changed — restart the
    // motion detector so it re-attaches to the current stream. No-op if detection is off.
    if (updated.detect_motion_enabled) await startMotionDetector(updated).catch(() => {});
    else await stopMotionDetector(updated.id).catch(() => {});
    if (updated.detect_sound_enabled) await startSoundDetector(updated).catch(() => {});
    else await stopSoundDetector(updated.id).catch(() => {});
    // Restart the clip segmenter too so it re-attaches to the (possibly changed) path. No-op if off.
    stopClipCapture(updated.id);
    startClipCapture(updated);
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
    if (existing.detect_motion_enabled) await startMotionDetector(existing).catch(() => {});
    if (existing.detect_sound_enabled) await startSoundDetector(existing).catch(() => {});
    if (existing.detect_record_clips) startClipCapture(existing);
  } else {
    await stopTranscoder(req.params.id);
    await stopSubStream(existing).catch(() => {});
    await stopMotionDetector(req.params.id).catch(() => {});
    await stopSoundDetector(req.params.id).catch(() => {});
    stopClipCapture(req.params.id);
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

// Motion-detection settings for a camera (admin). Applies immediately — starts/stops/restarts
// the detector to match. `zone` is {x,y,w,h} in 0..1 frame fractions, or null for the whole frame.
router.put('/:id/detection', requireAdmin, async (req, res) => {
  const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  const {
    motion_enabled, zone, sensitivity, cooldown_s, confirm_s, schedule_enabled, start, end,
    source, motion_mqtt_topic, motion_mqtt_value, snapshot_url,
    sound_enabled, sound_sensitivity, sound_confirm_s, sound_cooldown_s,
    record_clips,
  } = req.body || {};

  const enabled = motion_enabled ? 1 : 0;
  const recordClips = record_clips === undefined ? existing.detect_record_clips : record_clips ? 1 : 0;
  const zoneJson = zone === undefined ? existing.detect_zone : serializeZone(zone);
  // Detection source: only the two known values; anything else falls back to the current value.
  const detectSource =
    source === undefined ? existing.detect_source : source === 'mqtt' ? 'mqtt' : 'framediff';
  const motionTopic =
    motion_mqtt_topic === undefined ? existing.motion_mqtt_topic : (motion_mqtt_topic?.trim() || null);
  const motionValue =
    motion_mqtt_value === undefined ? existing.motion_mqtt_value : (motion_mqtt_value?.trim() || null);
  const snapUrl =
    snapshot_url === undefined ? existing.snapshot_url : (snapshot_url?.trim() || null);
  const sens =
    sensitivity === undefined
      ? existing.detect_sensitivity
      : Math.min(100, Math.max(1, Math.round(Number(sensitivity)) || 50));
  const cooldown =
    cooldown_s === undefined ? existing.detect_cooldown_s : Math.max(1, Math.round(Number(cooldown_s)) || 60);
  const confirm =
    confirm_s === undefined ? existing.detect_confirm_s : Math.max(0, Math.round(Number(confirm_s)) || 0);
  // Alert-window schedule. start/end are minutes since midnight (0..1439) in the app timezone; the
  // frontend converts to/from HH:MM. start > end means the window wraps midnight.
  const clampMin = (v, fb) => (v === undefined ? fb : Math.min(1439, Math.max(0, Math.round(Number(v)) || 0)));
  const schedEnabled = schedule_enabled === undefined ? existing.detect_schedule_enabled : schedule_enabled ? 1 : 0;
  const startMin = clampMin(start, existing.detect_start);
  const endMin = clampMin(end, existing.detect_end);
  // Sound detection (its own enable + sensitivity/confirm/cooldown; shares the schedule above).
  const soundEnabled = sound_enabled === undefined ? existing.detect_sound_enabled : sound_enabled ? 1 : 0;
  const soundSens =
    sound_sensitivity === undefined
      ? existing.sound_sensitivity
      : Math.min(100, Math.max(1, Math.round(Number(sound_sensitivity)) || 50));
  const soundConfirm =
    sound_confirm_s === undefined ? existing.sound_confirm_s : Math.max(0, Math.round(Number(sound_confirm_s)) || 0);
  const soundCooldown =
    sound_cooldown_s === undefined ? existing.sound_cooldown_s : Math.max(1, Math.round(Number(sound_cooldown_s)) || 120);

  db.prepare(
    `UPDATE cameras SET detect_motion_enabled = ?, detect_zone = ?, detect_sensitivity = ?,
       detect_cooldown_s = ?, detect_confirm_s = ?, detect_schedule_enabled = ?, detect_start = ?,
       detect_end = ?, detect_source = ?, motion_mqtt_topic = ?, motion_mqtt_value = ?,
       snapshot_url = ?, detect_sound_enabled = ?, sound_sensitivity = ?, sound_confirm_s = ?,
       sound_cooldown_s = ?, detect_record_clips = ? WHERE id = ?`
  ).run(
    enabled, zoneJson, sens, cooldown, confirm, schedEnabled, startMin, endMin,
    detectSource, motionTopic, motionValue, snapUrl,
    soundEnabled, soundSens, soundConfirm, soundCooldown, recordClips, req.params.id
  );

  const updated = db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
  // Apply to the live frame-diff detector now (a disabled camera's detector starts when it's
  // re-enabled). startMotionDetector itself no-ops for the 'mqtt' source, so switching a camera to
  // MQTT here stops any running frame-diff leg; switching back to frame-diff starts it.
  if (!updated.disabled) {
    if (updated.detect_motion_enabled) {
      await startMotionDetector(updated).catch((e) => logger.error(`[detect] start failed: ${e.message}`));
    } else {
      await stopMotionDetector(updated.id).catch(() => {});
    }
    if (updated.detect_sound_enabled) {
      await startSoundDetector(updated).catch((e) => logger.error(`[sound] start failed: ${e.message}`));
    } else {
      await stopSoundDetector(updated.id).catch(() => {});
    }
    // Clip-recording segmenter follows its own opt-in.
    if (updated.detect_record_clips) startClipCapture(updated);
    else stopClipCapture(updated.id);
  }
  // Re-subscribe MQTT so a new/changed/removed motion topic takes effect immediately.
  refreshMqttConnection();
  res.json(publicCamera(updated, true));
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
  await stopMotionDetector(req.params.id).catch(() => {});
  await stopSoundDetector(req.params.id).catch(() => {});
  stopClipCapture(req.params.id);
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
