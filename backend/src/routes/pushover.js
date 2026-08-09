import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getPushoverConfig, pushoverConfigured, validatePushover, sendPushover } from '../lib/pushover.js';

const router = Router();

// Current Pushover config for the Settings form (admin only). Tokens are shown so the admin can
// see/edit what's set — this endpoint is admin-gated and the same tokens go out in every request.
router.get('/config', requireAuth, requireAdmin, (req, res) => {
  const c = getPushoverConfig();
  res.json({ enabled: c.enabled, configured: pushoverConfigured(), app_token: c.appToken, user_key: c.userKey });
});

// Save Pushover config. Turning it ON validates the app token + user/group key with Pushover first
// and rejects (400, so the message survives any reverse proxy) if they don't check out — so an
// enabled config can always deliver.
router.put('/config', requireAuth, requireAdmin, async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const appToken = (req.body?.app_token || '').trim();
  const userKey = (req.body?.user_key || '').trim();

  if (enabled) {
    const check = await validatePushover(appToken, userKey);
    if (!check.ok) {
      logger.info(`[pushover] enable rejected: ${check.error}`);
      return res.status(400).json({ error: check.error });
    }
  }

  db.prepare(
    'UPDATE settings SET pushover_enabled = ?, pushover_app_token = ?, pushover_user_key = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, appToken || null, userKey || null, 'app');
  logger.info(`[pushover] config saved — notifications ${enabled ? 'ENABLED' : 'disabled'}`);

  const c = getPushoverConfig();
  res.json({ enabled: c.enabled, configured: pushoverConfigured(), app_token: c.appToken, user_key: c.userKey });
});

// Send a test notification with the CURRENTLY SAVED config, so the admin can confirm delivery end to
// end (including on their phone). 400s with Pushover's reason if it doesn't go through.
router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  if (!pushoverConfigured()) return res.status(400).json({ error: 'Save an application token and user/group key first.' });
  const result = await sendPushover({
    title: 'Nightlight',
    message: 'Test notification — Pushover is working. 🌙',
    priority: 0,
  });
  if (result && result.ok === false) return res.status(400).json({ error: result.error || 'Pushover rejected the message.' });
  res.json({ ok: true });
});

export default router;
