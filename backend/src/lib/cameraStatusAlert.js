import { logger } from './logger.js';
import { sendToAll, pushEnabled, getPublicBaseUrl } from './push.js';
import { pushoverEnabled, sendPushover } from './pushover.js';
import { ntfyEnabled, sendNtfy } from './ntfy.js';
import { gotifyEnabled, sendGotify } from './gotify.js';

// Push notifications for a camera going offline (no frames for longer than the configured threshold)
// and coming back. Same multi-provider fan-out as detectionAlert.js, minus the snapshot (an offline
// camera has no frame to grab). Gated upstream by the watchdog in index.js, which only calls these
// when camera_offline_alert_enabled is on and the outage has crossed camera_offline_alert_minutes.
//
// Also the long-silence notice (#552): a camera's alerts kept silenced for a long time. Gated upstream by
// lib/silences.js (on/off, the threshold, once per silence). Unlike the two above, it is for the ADMINS, and
// not for the person who set the silence (owner decision 2026-10-10): see fanOut for what each channel can do.

function deepLink(cameraId) {
  const server = getPublicBaseUrl();
  return server
    ? `nightlight://camera/${cameraId}?server=${encodeURIComponent(server)}`
    : `nightlight://camera/${cameraId}`;
}

// Fire one text notification across every configured/enabled channel. Best-effort: each channel is
// independent and never throws up into the watchdog loop.
//
// `tag`, `adminsOnly` and `excludeUserId` (#552, the long-silence notice) reach the app's OWN push only
// (sendToAll), because it is the only channel that knows which device belongs to which account: there they
// mean "replace an earlier notice with the same tag", "admin accounts' devices only" and "not this account's
// devices". Pushover, ntfy and Gotify each deliver to one configured user/group key, topic or app, with no
// per-person address, so they are sent the message exactly as before and EVERYONE on them receives it, a
// caregiver and the person who set the silence included. That is stated in docs/camera-controls.md and on the
// settings card, not hidden. The offline/online callers pass none of the three and are unchanged: every
// device, no tag.
function fanOut(title, body, cameraId, type, { tag, adminsOnly = false, excludeUserId = null } = {}) {
  const link = deepLink(cameraId);
  if (pushEnabled()) {
    sendToAll(title, body, { cameraId, type }, null, { tag, adminsOnly, excludeUserId }).catch(() => {});
  }
  if (pushoverEnabled()) {
    sendPushover({ title, message: body, url: link, urlTitle: 'Open in Nightlight' })
      .catch((e) => logger.error(`[pushover] ${type} alert failed for "${title}": ${e.message}`));
  }
  if (ntfyEnabled()) {
    sendNtfy({ title, message: body, click: link, priority: 4 })
      .catch((e) => logger.error(`[ntfy] ${type} alert failed for "${title}": ${e.message}`));
  }
  if (gotifyEnabled()) {
    sendGotify({ title, message: body, click: link })
      .catch((e) => logger.error(`[gotify] ${type} alert failed for "${title}": ${e.message}`));
  }
}

// "45 min", "1 h", "2 h 5 min". A length of time, never a clock time: the notice goes to phones that may be
// in another timezone from the house, and a duration means the same thing everywhere.
export function formatSilenceLength(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// `minutes` is the silence's length, counted as lib/silences.js counts it: from the first silence's start to the
// latest one's end, the gaps of under 30 minutes between them INCLUDED. Hence "on and off", never "in a row":
// three 15-minute silences 30 minutes apart count as 1 h 45 min, of which only 45 minutes were silenced (PR #664
// review). `actorUserId` is who set the latest silence, whose own devices are left out of the app's push.
//
// ⚠️ NO USERNAME in the text, on any channel (PR #664 review, privacy). Pushover, ntfy (the public ntfy.sh by
// default) and Gotify are third-party or shared services, and this repo keeps login names out of anything that can
// leave the house (the same reason the snooze route and this log line carry none). Who set a silence is on the
// camera's tile while it lasts and in Camera history (admin-only), which is where the notice points.
export function notifyLongSilence(camera, minutes, actorUserId) {
  const length = formatSilenceLength(minutes);
  const title = `Alerts silenced on ${camera.name}`;
  const body = `Alerts from "${camera.name}" have been silenced on and off for ${length}. Camera history shows who set each silence.`;
  logger.warn(`[silence-alert] "${camera.name}": alerts silenced on and off for ${length}; notifying the admins`);
  fanOut(title, body, camera.id, 'silence', {
    // One tag per camera: on the app's own push a later notice for the same camera replaces the earlier one.
    // `silence_` + a camera id (a UUID) is 44 bytes, inside APNs' 64-byte collapse-id limit (lib/push.js).
    tag: `silence_${camera.id}`,
    adminsOnly: true,
    excludeUserId: actorUserId,
  });
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
