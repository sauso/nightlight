import { logger } from './logger.js';
import { sendToAll, pushEnabled, getPublicBaseUrl } from './push.js';
import { pushoverEnabled, sendPushover } from './pushover.js';
import { ntfyEnabled, sendNtfy } from './ntfy.js';
import { gotifyEnabled, sendGotify } from './gotify.js';

// Push notifications for a camera going offline (no frames for longer than the configured threshold)
// and coming back. Same multi-provider fan-out as detectionAlert.js, minus the snapshot (an offline
// camera has no frame to grab). Gated upstream by the watchdog in index.js, which only calls these
// when camera_offline_alert_enabled is on and the outage has crossed camera_offline_alert_minutes.

function deepLink(cameraId) {
  const server = getPublicBaseUrl();
  return server
    ? `nightlight://camera/${cameraId}?server=${encodeURIComponent(server)}`
    : `nightlight://camera/${cameraId}`;
}

// Fire one text notification across every configured/enabled channel. Best-effort: each channel is
// independent and never throws up into the watchdog loop.
function fanOut(title, body, cameraId, type) {
  const link = deepLink(cameraId);
  if (pushEnabled()) {
    sendToAll(title, body, { cameraId, type }).catch(() => {});
  }
  if (pushoverEnabled()) {
    sendPushover({ title, message: body, url: link, urlTitle: 'Open in Nightlight' })
      .catch((e) => logger.error(`[pushover] offline alert failed for "${title}": ${e.message}`));
  }
  if (ntfyEnabled()) {
    sendNtfy({ title, message: body, click: link, priority: 4 })
      .catch((e) => logger.error(`[ntfy] offline alert failed for "${title}": ${e.message}`));
  }
  if (gotifyEnabled()) {
    sendGotify({ title, message: body, click: link })
      .catch((e) => logger.error(`[gotify] offline alert failed for "${title}": ${e.message}`));
  }
}

export function notifyCameraOffline(camera, minutes) {
  const title = `${camera.name} — offline`;
  const body = `No video from "${camera.name}" for ${minutes}+ minute${minutes === 1 ? '' : 's'}.`;
  logger.warn(`[offline-alert] ${body}`);
  fanOut(title, body, camera.id, 'offline');
}

export function notifyCameraRecovered(camera, offlineSinceTs) {
  const mins = offlineSinceTs ? Math.max(1, Math.round((Date.now() - offlineSinceTs) / 60000)) : null;
  const title = `${camera.name} — back online`;
  const body = mins
    ? `"${camera.name}" is back online after about ${mins} minute${mins === 1 ? '' : 's'} offline.`
    : `"${camera.name}" is back online.`;
  logger.info(`[offline-alert] ${body}`);
  fanOut(title, body, camera.id, 'online');
}
