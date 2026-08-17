import db from '../db.js';
import { logger } from './logger.js';
import { subscribeMotionEvents } from './onvif.js';
import { inActiveWindow } from './detectSchedule.js';
import { fireDetectionAlert } from './detectionAlert.js';
import { ALERT } from './detectionEvents.js';

// Camera-native motion over ONVIF (detect_source = 'onvif'). Instead of Nightlight diffing the
// video (framediff) or listening on an MQTT topic (mqtt), the camera reports motion over its ONVIF
// Event service and we subscribe directly — reusing the ONVIF connection we already hold for PTZ /
// two-way audio, with no MQTT broker required. A motion edge fires the same shared detection alert
// (event + push + clip) as the other sources, gated by the camera's quiet-hours window + cooldown.
//
// This never touches the video pipeline. It's a peer to motionDetector.js / soundDetector.js: the
// pixel-diff leg still runs for a child-assigned ONVIF camera in ACTIVITY-ONLY mode (sleep tracking),
// since ONVIF motion is too coarse for the per-minute activity timeline — but it fires no alerts
// (see motionDetector.motionAlerting), so an ONVIF-source camera alerts only from here.

const subs = new Map(); // camera_id -> { handle, stopped }
const lastAlert = new Map(); // camera_id -> last alert time (ms), for per-camera cooldown

export function isOnvifMotion(cameraId) {
  return subs.has(cameraId);
}

// Should this camera run an ONVIF motion subscription? Only an enabled, non-disabled camera on the
// 'onvif' source. (onvif_motion_capable gates whether the UI ever offers the source; by the time a
// camera is on it, it advertised a motion topic — but a subscription that finds none simply idles.)
export function onvifMotionWanted(camera) {
  return !!camera && !camera.disabled && !!camera.detect_motion_enabled && camera.detect_source === 'onvif';
}

// Derive the ONVIF host/port from the stored device-service URL (http://host:port/onvif/device_service).
function onvifEndpoint(camera) {
  if (!camera.onvif_device_url) return null;
  try {
    const u = new URL(camera.onvif_device_url);
    return { host: u.hostname, port: u.port || '80' };
  } catch {
    return null;
  }
}

export async function startOnvifMotion(camera) {
  await stopOnvifMotion(camera.id);
  if (!onvifMotionWanted(camera)) return;
  const ep = onvifEndpoint(camera);
  if (!ep) {
    logger.warn(`[onvif-motion] "${camera.name}" has no ONVIF endpoint stored — cannot subscribe`);
    return;
  }
  // Claim the slot before subscribing so a concurrent start/reconcile can't double-subscribe.
  const entry = { handle: null, stopped: false };
  subs.set(camera.id, entry);
  const handle = subscribeMotionEvents({
    host: ep.host,
    port: ep.port,
    username: camera.onvif_username,
    password: camera.onvif_password,
    onLog: (topic, state) =>
      logger.info(
        `[onvif-motion] "${camera.name}" ${topic} → ${state === false ? 'clear' : state === true ? 'MOTION' : 'motion?'}`
      ),
    onError: (e) => logger.warn(`[onvif-motion] "${camera.name}" event error: ${e?.message || e}`),
    onMotion: () => handleMotion(camera.id),
  });
  entry.handle = handle;
  // If stop() landed during the (synchronous) subscribe above, tear the handle down now.
  if (entry.stopped) {
    try { handle.stop(); } catch { /* ignore */ }
    return;
  }
  logger.info(`[onvif-motion] subscribed to "${camera.name}" motion events (${ep.host}:${ep.port})`);
}

// A motion edge arrived. Re-read the camera fresh so live settings (window/cooldown/source/enabled)
// apply, then fire the shared alert unless suppressed by the quiet-hours window or the cooldown.
function handleMotion(cameraId) {
  let cam;
  try {
    cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get(cameraId);
  } catch {
    return;
  }
  if (!cam || !onvifMotionWanted(cam)) return;
  if (!inActiveWindow(cam)) {
    logger.info(`[onvif-motion] "${cam.name}" motion ignored — outside its active/quiet-hours window`);
    return;
  }
  const now = Date.now();
  const cooldownMs = Math.max(1, cam.detect_cooldown_s ?? 60) * 1000;
  if (now - (lastAlert.get(cam.id) || 0) < cooldownMs) {
    logger.info(`[onvif-motion] "${cam.name}" motion within cooldown — not re-alerting`);
    return;
  }
  lastAlert.set(cam.id, now);
  logger.info(`[detect] ONVIF motion on "${cam.name}"`);
  fireDetectionAlert(cam, ALERT.MOTION, 'camera-reported (ONVIF)').catch(() => {});
}

export async function stopOnvifMotion(cameraId) {
  const entry = subs.get(cameraId);
  if (!entry) return;
  entry.stopped = true;
  subs.delete(cameraId);
  try { entry.handle?.stop(); } catch { /* ignore */ }
}

export async function stopAllOnvifMotion() {
  for (const id of [...subs.keys()]) await stopOnvifMotion(id);
}
