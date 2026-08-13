import { logger } from './logger.js';
import { recordDetectionEvent, saveEventSnapshot, ALERT } from './detectionEvents.js';
import { sendToAll, pushEnabled, getPublicBaseUrl } from './push.js';
import { pushoverEnabled, sendPushover } from './pushover.js';
import { ntfyEnabled, sendNtfy } from './ntfy.js';
import { gotifyEnabled, sendGotify } from './gotify.js';
import { captureSnapshot, fetchHttpSnapshot } from './snapshot.js';

// The single downstream shared by every detector — frame-diff motion (motionDetector.js),
// camera-native MQTT motion (mqttClient.js), and audio-loudness sound (soundDetector.js). Whatever
// detected it, the alert looks the same: one detection_events row (the in-app "Recent alerts" list)
// plus a Firebase and/or Pushover push carrying a snapshot. Callers gate on their own
// cooldown/schedule before calling; this just fires. `type` is an ALERT.* constant.

const WORDING = {
  [ALERT.MOTION]: { body: 'Motion detected', suffix: 'motion' },
  [ALERT.SOUND]: { body: 'Sound detected', suffix: 'sound' },
};

// Resolve the alert image: prefer the camera's own HTTP snapshot endpoint when set (instant, no
// keyframe wait), falling back to a one-shot grab off the local MediaMTX stream. Best-effort —
// returns a Buffer or null, and the alert still sends text-only on null.
async function resolveSnapshot(camera, snapshotPath) {
  if (camera.snapshot_url && String(camera.snapshot_url).trim()) {
    const img = await fetchHttpSnapshot(camera.snapshot_url);
    if (img) return img;
    logger.info(`[detect] camera snapshot URL failed for "${camera.name}" — falling back to stream grab`);
  }
  return captureSnapshot(snapshotPath || camera.mediamtx_path);
}

export async function fireDetectionAlert(camera, type, detail, { snapshotPath = null } = {}) {
  const w = WORDING[type] || { body: 'Alert', suffix: 'alert' };
  const eventId = recordDetectionEvent(camera.id, camera.name, type, detail);
  logger.info(`[detect] ${type} on "${camera.name}" (${detail})`);

  const firePush = pushEnabled();
  const firePushover = pushoverEnabled();
  const fireNtfy = ntfyEnabled();
  const fireGotify = gotifyEnabled();

  // Capture ONCE and reuse everywhere: the in-app Alerts feed thumbnail plus both push channels.
  // Done even when no push is configured, so the feed stays useful for push-less setups (best-effort).
  const image = await resolveSnapshot(camera, snapshotPath);
  if (image) {
    if (eventId) saveEventSnapshot(eventId, image);
  } else {
    logger.info(`[detect] no snapshot for "${camera.name}" (grab failed/timed out) — feed/alert without image`);
  }

  if (!firePush && !firePushover && !fireNtfy && !fireGotify) return;

  // Stamp the sending server onto the deep link (?server=…) so tapping an alert opens THIS server in
  // the app even if it was last showing a different one. Omitted until a registering app has taught
  // us our public URL, in which case it degrades to the plain nightlight://camera/:id (open in place).
  // Shared by every channel that carries a tap action.
  const server = getPublicBaseUrl();
  const deepLink = server
    ? `nightlight://camera/${camera.id}?server=${encodeURIComponent(server)}`
    : `nightlight://camera/${camera.id}`;
  const title = `${camera.name} — ${w.suffix}`;

  if (firePush) {
    logger.info(`[detect] sending Firebase alert for "${camera.name}"`);
    sendToAll(camera.name, w.body, { cameraId: camera.id, type }, image).catch(() => {});
  }
  if (firePushover) {
    logger.info(`[detect] sending Pushover alert for "${camera.name}"`);
    sendPushover({ title, message: w.body, url: deepLink, urlTitle: 'Open in Nightlight', image })
      .catch((e) => logger.error(`[pushover] alert failed for "${camera.name}": ${e.message}`));
  }
  if (fireNtfy) {
    logger.info(`[detect] sending ntfy alert for "${camera.name}"`);
    sendNtfy({ title, message: w.body, click: deepLink, image, priority: 4 })
      .catch((e) => logger.error(`[ntfy] alert failed for "${camera.name}": ${e.message}`));
  }
  if (fireGotify) {
    logger.info(`[detect] sending Gotify alert for "${camera.name}"`);
    sendGotify({ title, message: w.body, click: deepLink })
      .catch((e) => logger.error(`[gotify] alert failed for "${camera.name}": ${e.message}`));
  }
}
