import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { refreshMqttConnection } from '../lib/mqttClient.js';

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
  const { mqtt_host, mqtt_port, mqtt_username, mqtt_password, ...pub } = s;
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
    mqtt_host: s.mqtt_host || '',
    mqtt_port: s.mqtt_port || '',
    mqtt_username: s.mqtt_username || '',
    mqtt_password_set: !!s.mqtt_password,
  });
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
    temp_unit, mqtt_host, mqtt_port, mqtt_username, mqtt_password,
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

  db.prepare(
    `UPDATE settings
     SET app_name = ?, accent_color = ?, live_color = ?, offline_color = ?, timezone = ?, font_choice = ?,
         temp_unit = ?, mqtt_host = ?, mqtt_port = ?, mqtt_username = ?, mqtt_password = ?
     WHERE id = ?`
  ).run(
    app_name?.trim() || existing.app_name,
    accent_color || existing.accent_color,
    live_color || existing.live_color,
    offline_color || existing.offline_color,
    timezone || existing.timezone,
    font_choice || existing.font_choice,
    temp_unit || existing.temp_unit,
    mqtt_host !== undefined ? (mqtt_host || '').trim() || null : existing.mqtt_host,
    mqtt_port !== undefined ? (mqtt_port ? parseInt(mqtt_port, 10) : null) : existing.mqtt_port,
    mqtt_username !== undefined ? (mqtt_username || '').trim() || null : existing.mqtt_username,
    mqtt_password ? mqtt_password : existing.mqtt_password, // blank submission keeps the existing one
    'app'
  );
  refreshMqttConnection();
  res.json(toPublicSettings(getSettings()));
});

export default router;
