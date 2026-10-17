import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getGotifyConfig, gotifyConfigured, sendGotify } from '../lib/gotify.js';
import { maskSecret } from '../lib/secretMask.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

// Never send the raw app token back — a masked preview + "set" flag only; blank-on-save keeps it.
function publicConfig() {
  const c = getGotifyConfig();
  return {
    enabled: c.enabled,
    configured: gotifyConfigured(),
    server_url: c.serverUrl,
    app_token_masked: maskSecret(c.appToken),
    app_token_set: !!c.appToken,
    priority: c.priority,
  };
}

// Current Gotify config for the Settings form (admin only) — masked token, see publicConfig.
router.get('/config', requireAuth, requireAdmin, (req, res) => {
  res.json(publicConfig());
});

// The application token travels in the X-Gotify-Key header (#555). Gotify generates tokens from letters, digits,
// `-` and `_`, and older Gotify versions also `.` (its auth/token.go on master and at v2.4.0, read 2026-10-17), so
// that is the allow-list. Why refuse instead of cleaning: a line break, NUL or non-Latin-1 character cannot be sent
// in a header at all, so every alert failed, and fetch's error quoted the WHOLE token into the log and the Test
// button's reply (post-merge review of PR #702). The message names the rule and never repeats the value.
// Checked on a NEWLY entered token only: blank still keeps the saved one, so a token saved before this check is
// left alone (lib/gotify.js keeps it out of the log and the reply either way). Known limit: a token Gotify did not
// generate (a future format with another character) is refused until this list is widened.
const GOTIFY_TOKEN = /^[A-Za-z0-9._-]+$/;
const GOTIFY_TOKEN_INVALID =
  'The application token can only contain letters, digits, dots, hyphens and underscores. Copy it again from the Apps page of your Gotify server.';

router.put('/config', requireAuth, requireAdmin, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const serverUrl = (req.body?.server_url || '').trim().replace(/\/+$/, '');
  const existing = getGotifyConfig();
  const rawToken = req.body?.app_token;
  // Any falsy value already meant "keep the saved one" (`|| ''` below), so only a truthy non-string is refused;
  // it used to throw on .trim() and answer 500.
  if (rawToken && typeof rawToken !== 'string') return res.status(400).json({ error: 'app_token must be text.' });
  const newToken = (rawToken || '').trim();
  if (newToken && !GOTIFY_TOKEN.test(newToken)) return res.status(400).json({ error: GOTIFY_TOKEN_INVALID });
  const appToken = newToken || existing.appToken; // blank = keep
  let priority = Number(req.body?.priority);
  if (!Number.isFinite(priority)) priority = 5;
  priority = Math.max(0, Math.min(10, Math.round(priority)));

  if (enabled && (!serverUrl || !appToken)) {
    return res.status(400).json({ error: 'A server URL and an application token are required to enable Gotify.' });
  }

  db.prepare(
    'UPDATE settings SET gotify_enabled = ?, gotify_server_url = ?, gotify_app_token = ?, gotify_priority = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, serverUrl || null, appToken || null, priority, 'app');
  logger.info(`[gotify] config saved — notifications ${enabled ? 'ENABLED' : 'disabled'}`);

  res.json(publicConfig());
});

router.post('/test', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (!gotifyConfigured()) return res.status(400).json({ error: 'Set a server URL and application token first.' });
  const result = await sendGotify({ title: 'Nightlight', message: 'Test notification — Gotify is working.' });
  if (result && result.ok === false) return res.status(400).json({ error: result.error || 'Gotify rejected the message.' });
  res.json({ ok: true });
}));

export default router;
