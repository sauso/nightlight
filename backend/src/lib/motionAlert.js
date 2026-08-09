import { logger } from './logger.js';
import { recordDetectionEvent, ALERT } from './detectionEvents.js';
import { sendToAll, pushEnabled } from './push.js';
import { pushoverEnabled, sendPushover } from './pushover.js';
import { captureSnapshot, fetchHttpSnapshot } from './snapshot.js';

// The single downstream shared by BOTH motion sources — the frame-diff detector
// (motionDetector.js) and the camera-native MQTT source (mqttClient.js). Whatever detected the
// motion, the alert looks identical: one detection_events row (the in-app "Recent alerts" list)
// plus a Firebase and/or Pushover push carrying the same snapshot. Callers gate on their own
// cooldown/schedule before calling; this just fires.

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

// Record the event and fan out the push(es). `detail` is the human-readable reason stored on the
// event and is source-specific (e.g. "motion (7.0% of zone)" or "camera-reported motion").
// `snapshotPath` is the MediaMTX path to grab from if there's no camera snapshot URL (the frame-diff
// detector passes the exact path it's analysing; MQTT lets it default to the camera's main path).
export async function fireMotionAlert(camera, detail, { snapshotPath = null } = {}) {
  recordDetectionEvent(camera.id, camera.name, ALERT.MOTION, detail);
  logger.info(`[detect] motion on "${camera.name}" (${detail})`);

  const firePush = pushEnabled();
  const firePushover = pushoverEnabled();
  if (!firePush && !firePushover) return;

  // Capture ONCE and share across both channels.
  const image = await resolveSnapshot(camera, snapshotPath);
  if (!image) logger.info(`[detect] no snapshot for "${camera.name}" (grab failed/timed out) — sending without image`);

  if (firePush) {
    logger.info(`[detect] sending Firebase alert for "${camera.name}"`);
    sendToAll(camera.name, 'Motion detected', { cameraId: camera.id, type: ALERT.MOTION }, image).catch(() => {});
  }
  if (firePushover) {
    logger.info(`[detect] sending Pushover alert for "${camera.name}"`);
    sendPushover({
      title: `${camera.name} — motion`,
      message: 'Motion detected',
      url: `nightlight://camera/${camera.id}`,
      urlTitle: 'Open in Nightlight',
      image,
    }).catch((e) => logger.error(`[pushover] alert failed for "${camera.name}": ${e.message}`));
  }
}
