import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const VALID_FONTS = ['warm-serif', 'modern-sans', 'rounded-friendly', 'classic-serif'];

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
}

// Public: the login screen (pre-authentication) also needs the app name/colors.
router.get('/', (req, res) => {
  res.json(getSettings());
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
  const { app_name, accent_color, live_color, offline_color, timezone, font_choice } = req.body || {};

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

  db.prepare(
    `UPDATE settings
     SET app_name = ?, accent_color = ?, live_color = ?, offline_color = ?, timezone = ?, font_choice = ?
     WHERE id = ?`
  ).run(
    app_name?.trim() || existing.app_name,
    accent_color || existing.accent_color,
    live_color || existing.live_color,
    offline_color || existing.offline_color,
    timezone || existing.timezone,
    font_choice || existing.font_choice,
    'app'
  );
  res.json(getSettings());
});

export default router;
