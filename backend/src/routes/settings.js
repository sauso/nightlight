import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { refreshMqttConnection, mqttStatus } from '../lib/mqttClient.js';
import { restartClipCapture } from '../lib/clipCapture.js';
import { clipStorageStats, sweepClips } from '../lib/clipStorage.js';

const router = Router();

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const VALID_FONTS = ['warm-serif', 'modern-sans', 'rounded-friendly', 'classic-serif'];
const VALID_TEMP_UNITS = ['C', 'F'];

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
}

// Deliberately excludes mqtt_host/port/username/password - this is fetched by
// unauthenticated visitors too (the login screen needs the app name/theme), and MQTT
// broker credentials have no reason to ever reach a client that isn't the admin
// settings page specifically.
function toPublicSettings(s) {
  const { mqtt_host, mqtt_port, mqtt_username, mqtt_password, mqtt_enabled, ...pub } = s;
  return pub;
}

// Public: the login screen (pre-authentication) also needs the app name/colors.
router.get('/', (req, res) => {
  res.json(toPublicSettings(getSettings()));
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
  res.json(clipStorageStats());
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

  db.prepare(
    `UPDATE settings
     SET app_name = ?, accent_color = ?, live_color = ?, offline_color = ?, timezone = ?, font_choice = ?,
         temp_unit = ?, mqtt_enabled = ?, mqtt_host = ?, mqtt_port = ?, mqtt_username = ?, mqtt_password = ?,
         ptz_step = ?, clip_pre_roll_s = ?, clip_post_roll_s = ?, clip_retention_days = ?, clip_retention_max_gb = ?
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
    'app'
  );
  refreshMqttConnection();
  // New pre/post-roll changes the required ring depth, so re-arm any camera that's recording.
  if (clipLenChanged) {
    for (const cam of db.prepare('SELECT * FROM cameras WHERE detect_record_clips = 1 AND disabled = 0').all()) {
      restartClipCapture(cam);
    }
  }
  // Tighter retention should apply now, not just at the next 15-min sweep.
  if (retentionChanged) {
    try { sweepClips(); } catch { /* logged inside */ }
  }
  res.json(toPublicSettings(getSettings()));
});

export default router;
