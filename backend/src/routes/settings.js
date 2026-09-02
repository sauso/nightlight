import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { refreshMqttConnection, mqttStatus } from '../lib/mqttClient.js';
import { restartClipCapture } from '../lib/clipCapture.js';
import { clipStorageStats, sweepClips } from '../lib/clipStorage.js';
import { wakeClipStats } from '../lib/recordings.js';

const router = Router();

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const VALID_FONTS = ['warm-serif', 'modern-sans', 'rounded-friendly', 'classic-serif'];
const VALID_TEMP_UNITS = ['C', 'F'];

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
}

// GET /settings answers WITHOUT a token, because the login screen needs the app name, colours and
// font before anyone can sign in. That makes the response an ALLOW-LIST, and the distinction is not
// stylistic: the settings table gains columns with nearly every feature, and several of those columns
// are credentials. A deny-list is correct only until the next migration, and then it silently leaks
// whatever was added.
//
// It already failed exactly that way. This function used to exclude the five mqtt_* columns and spread
// the rest, which was right when it was written and wrong the moment ntfy, Gotify and Pushover added
// their own token columns to the same table — those were served to any unauthenticated caller. See
// GHSA-qffc-965c-x74m. Adding a field here must be a deliberate act; forgetting to add one is a
// missing setting on a page, which is visible, rather than a leaked secret, which is not.
const PUBLIC_FIELDS = [
  'app_name',
  'accent_color',
  'live_color',
  'offline_color',
  'font_choice',
  'temp_unit',
  'timezone',
];

// Additionally returned to an ADMIN. These are the non-secret config values the admin settings forms
// bind (SettingsGeneral / SettingsCamera / SettingsRecording seed their form state straight from this
// response), so removing one breaks a form field. Nothing here is a credential — provider tokens and
// broker passwords are served only by their own admin-only /config routes, which mask them.
// Caregivers deliberately get PUBLIC_FIELDS only: every settings page that uses these is admin-gated
// in the UI, and PUT /settings is requireAdmin.
const ADMIN_FIELDS = [
  ...PUBLIC_FIELDS,
  'camera_offline_alert_enabled',
  'camera_offline_alert_minutes',
  'clip_pre_roll_s',
  'clip_post_roll_s',
  'clip_retention_days',
  'clip_retention_max_gb',
  'ondemand_enabled',
  'ondemand_pre_roll_s',
  'ondemand_max_duration_s',
  'ptz_step',
  'wake_clips_enabled',
  'wake_clip_seconds',
  'wake_clip_retention_days',
];

function pick(row, fields) {
  const out = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}

// Public: the login screen (pre-authentication) also needs the app name/colors. optionalAuth attaches
// req.user when a valid token is present without rejecting when it isn't, so one route can serve both.
router.get('/', optionalAuth, (req, res) => {
  const fields = req.user?.role === 'admin' ? ADMIN_FIELDS : PUBLIC_FIELDS;
  res.json(pick(getSettings(), fields));
});

// Admin-only: MQTT broker config for the Settings page form. The password itself is
// never sent back once saved - only whether one is currently set - the same
// "leave blank to keep current" pattern used for resetting a caregiver's password.
router.get('/mqtt', requireAuth, requireAdmin, (req, res) => {
  const s = getSettings();
  res.json({
    mqtt_enabled: !!s.mqtt_enabled,
    mqtt_host: s.mqtt_host || '',
    mqtt_port: s.mqtt_port || '',
    mqtt_username: s.mqtt_username || '',
    mqtt_password_set: !!s.mqtt_password,
  });
});

// Admin-only: live broker connection state, for the "Connected" indicator on the Settings hub.
router.get('/mqtt/status', requireAuth, requireAdmin, (req, res) => {
  res.json(mqttStatus());
});

// Admin-only: recording storage usage + where clips live, for the Settings → Recording display.
router.get('/clip-storage', requireAuth, requireAdmin, (req, res) => {
  // Wake clips are reported alongside the alert clips they sit next to on disk: they are a NEW
  // automatic consumer, and their length/retention settings only mean something if you can see what
  // they are actually costing.
  res.json({ ...clipStorageStats(), wakeClips: wakeClipStats() });
});

function isValidTimezone(tz) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

router.put('/', requireAuth, requireAdmin, (req, res) => {
  const existing = getSettings();
  const {
    app_name, accent_color, live_color, offline_color, timezone, font_choice,
    temp_unit, mqtt_enabled, mqtt_host, mqtt_port, mqtt_username, mqtt_password,
    ptz_step, clip_pre_roll_s, clip_post_roll_s, clip_retention_days, clip_retention_max_gb,
    ondemand_enabled, ondemand_pre_roll_s, ondemand_max_duration_s,
    wake_clips_enabled, wake_clip_seconds, wake_clip_retention_days,
    camera_offline_alert_enabled, camera_offline_alert_minutes,
  } = req.body || {};

  if (app_name !== undefined && !app_name.trim()) {
    return res.status(400).json({ error: 'App name cannot be empty' });
  }
  for (const [label, value] of [
    ['Accent color', accent_color],
    ['Live color', live_color],
    ['Offline color', offline_color],
  ]) {
    if (value !== undefined && !HEX_COLOR.test(value)) {
      return res.status(400).json({ error: `${label} must be a hex value like #F5D9A8` });
    }
  }
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    return res.status(400).json({ error: 'That timezone is not recognized' });
  }
  if (font_choice !== undefined && !VALID_FONTS.includes(font_choice)) {
    return res.status(400).json({ error: 'That font choice is not recognized' });
  }
  if (temp_unit !== undefined && !VALID_TEMP_UNITS.includes(temp_unit)) {
    return res.status(400).json({ error: 'Temperature unit must be C or F' });
  }
  let ptzStepVal = existing.ptz_step;
  if (ptz_step !== undefined) {
    const n = parseInt(ptz_step, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      return res.status(400).json({ error: 'PTZ step size must be a whole number between 1 and 100' });
    }
    ptzStepVal = n;
  }
  // Recording clip length. Bounds keep the segmenter ring sane and the disk safe.
  let preRoll = existing.clip_pre_roll_s;
  if (clip_pre_roll_s !== undefined) {
    const n = parseInt(clip_pre_roll_s, 10);
    if (!Number.isFinite(n) || n < 0 || n > 30) {
      return res.status(400).json({ error: 'Pre-roll must be between 0 and 30 seconds' });
    }
    preRoll = n;
  }
  let postRoll = existing.clip_post_roll_s;
  if (clip_post_roll_s !== undefined) {
    const n = parseInt(clip_post_roll_s, 10);
    if (!Number.isFinite(n) || n < 5 || n > 120) {
      return res.status(400).json({ error: 'Post-roll must be between 5 and 120 seconds' });
    }
    postRoll = n;
  }
  const clipLenChanged = preRoll !== existing.clip_pre_roll_s || postRoll !== existing.clip_post_roll_s;

  // On-demand recording. The pre-roll drives the segmenter ring depth (like the clip pre-roll), so a
  // change here has to re-arm the rings too. Cap it at 60s: the ring holds that much video for every
  // camera continuously, and reaching back further than a minute isn't what the button is for.
  let ondEnabled = existing.ondemand_enabled;
  if (ondemand_enabled !== undefined) ondEnabled = ondemand_enabled ? 1 : 0;
  let ondPreRoll = existing.ondemand_pre_roll_s;
  if (ondemand_pre_roll_s !== undefined) {
    const n = parseInt(ondemand_pre_roll_s, 10);
    if (!Number.isFinite(n) || n < 0 || n > 60) {
      return res.status(400).json({ error: 'Record pre-roll must be between 0 and 60 seconds' });
    }
    ondPreRoll = n;
  }
  let ondMaxDur = existing.ondemand_max_duration_s;
  if (ondemand_max_duration_s !== undefined) {
    const n = parseInt(ondemand_max_duration_s, 10);
    if (!Number.isFinite(n) || n < 5 || n > 600) {
      return res.status(400).json({ error: 'Maximum recording length must be between 5 and 600 seconds' });
    }
    ondMaxDur = n;
  }
  // Turning the feature on or off, or changing its pre-roll, changes which cameras need a ring and how
  // deep it must be — so both need the same re-arm as a clip-length change.
  const ondemandChanged =
    ondEnabled !== existing.ondemand_enabled || ondPreRoll !== existing.ondemand_pre_roll_s;
  // Retention. 0 disables a bound; otherwise days 1-365, cap 1-2000 GB.
  let retentionDays = existing.clip_retention_days;
  if (clip_retention_days !== undefined) {
    const n = parseInt(clip_retention_days, 10);
    if (!Number.isFinite(n) || n < 0 || n > 365) {
      return res.status(400).json({ error: 'Keep clips for must be between 0 and 365 days (0 = no day limit)' });
    }
    retentionDays = n;
  }
  let retentionGb = existing.clip_retention_max_gb;
  if (clip_retention_max_gb !== undefined) {
    const n = parseInt(clip_retention_max_gb, 10);
    if (!Number.isFinite(n) || n < 0 || n > 2000) {
      return res.status(400).json({ error: 'Storage cap must be between 0 and 2000 GB (0 = no size limit)' });
    }
    retentionGb = n;
  }
  const retentionChanged =
    retentionDays !== existing.clip_retention_days || retentionGb !== existing.clip_retention_max_gb;

  // Wake clips: on/off, clip length, and their own retention. Length is bounded at 120s because the
  // whole point is a bounded clip — an average wake runs ~19 minutes, and capturing wakes end to end
  // would be ~1.1 GiB a night. Retention takes 0 = keep forever, matching the clip-retention idiom
  // above, but note wake clips accrue every night whether or not anyone looks at them.
  let wakeEnabled = existing.wake_clips_enabled;
  if (wake_clips_enabled !== undefined) wakeEnabled = wake_clips_enabled ? 1 : 0;
  let wakeSeconds = existing.wake_clip_seconds;
  if (wake_clip_seconds !== undefined) {
    const n = parseInt(wake_clip_seconds, 10);
    if (!Number.isFinite(n) || n < 5 || n > 120) {
      return res.status(400).json({ error: 'Wake clip length must be between 5 and 120 seconds' });
    }
    wakeSeconds = n;
  }
  let wakeRetentionDays = existing.wake_clip_retention_days;
  if (wake_clip_retention_days !== undefined) {
    const n = parseInt(wake_clip_retention_days, 10);
    if (!Number.isFinite(n) || n < 0 || n > 365) {
      return res.status(400).json({ error: 'Keep wake clips for must be between 0 and 365 days (0 = keep forever)' });
    }
    wakeRetentionDays = n;
  }

  // Offline-camera alert: enable flag + threshold in whole minutes (1–1440).
  let offlineAlertEnabled = existing.camera_offline_alert_enabled;
  if (camera_offline_alert_enabled !== undefined) {
    offlineAlertEnabled = camera_offline_alert_enabled ? 1 : 0;
  }
  let offlineAlertMinutes = existing.camera_offline_alert_minutes;
  if (camera_offline_alert_minutes !== undefined) {
    const n = parseInt(camera_offline_alert_minutes, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      return res.status(400).json({ error: 'Offline alert threshold must be between 1 and 1440 minutes' });
    }
    offlineAlertMinutes = n;
  }

  db.prepare(
    `UPDATE settings
     SET app_name = ?, accent_color = ?, live_color = ?, offline_color = ?, timezone = ?, font_choice = ?,
         temp_unit = ?, mqtt_enabled = ?, mqtt_host = ?, mqtt_port = ?, mqtt_username = ?, mqtt_password = ?,
         ptz_step = ?, clip_pre_roll_s = ?, clip_post_roll_s = ?, clip_retention_days = ?, clip_retention_max_gb = ?,
         camera_offline_alert_enabled = ?, camera_offline_alert_minutes = ?,
         ondemand_enabled = ?, ondemand_pre_roll_s = ?, ondemand_max_duration_s = ?,
         wake_clips_enabled = ?, wake_clip_seconds = ?, wake_clip_retention_days = ?
     WHERE id = ?`
  ).run(
    app_name?.trim() || existing.app_name,
    accent_color || existing.accent_color,
    live_color || existing.live_color,
    offline_color || existing.offline_color,
    timezone || existing.timezone,
    font_choice || existing.font_choice,
    temp_unit || existing.temp_unit,
    mqtt_enabled !== undefined ? (mqtt_enabled ? 1 : 0) : existing.mqtt_enabled,
    mqtt_host !== undefined ? (mqtt_host || '').trim() || null : existing.mqtt_host,
    mqtt_port !== undefined ? (mqtt_port ? parseInt(mqtt_port, 10) : null) : existing.mqtt_port,
    mqtt_username !== undefined ? (mqtt_username || '').trim() || null : existing.mqtt_username,
    mqtt_password ? mqtt_password : existing.mqtt_password, // blank submission keeps the existing one
    ptzStepVal,
    preRoll,
    postRoll,
    retentionDays,
    retentionGb,
    offlineAlertEnabled,
    offlineAlertMinutes,
    ondEnabled,
    ondPreRoll,
    ondMaxDur,
    wakeEnabled,
    wakeSeconds,
    wakeRetentionDays,
    'app'
  );
  refreshMqttConnection();
  // New pre/post-roll changes the required ring depth, so re-arm any camera that's recording.
  if (clipLenChanged || ondemandChanged) {
    // Every enabled camera, not just the clip-recording ones: with on-demand on, a camera that doesn't
    // record detections still needs a ring for Record's pre-roll (and must lose it when turned off).
    for (const cam of db.prepare('SELECT * FROM cameras WHERE disabled = 0').all()) {
      restartClipCapture(cam);
    }
  }
  // Tighter retention should apply now, not just at the next 15-min sweep.
  if (retentionChanged) {
    try { sweepClips(); } catch { /* logged inside */ }
  }
  // PUT is requireAdmin, so it answers with the admin view — the forms re-seed from this response.
  res.json(pick(getSettings(), ADMIN_FIELDS));
});

export default router;
