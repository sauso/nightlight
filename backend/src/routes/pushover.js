import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getPushoverConfig, pushoverConfigured, validatePushover, sendPushover } from '../lib/pushover.js';
import { maskSecret } from '../lib/secretMask.js';

const router = Router();

// What the Settings form gets back: never the raw tokens, only a masked preview (enough to recognise
// which token is saved) plus a "set" flag. Blank-on-save then means "keep the current one".
function publicConfig() {
  const c = getPushoverConfig();
  return {
    enabled: c.enabled,
    configured: pushoverConfigured(),
    app_token_masked: maskSecret(c.appToken),
    app_token_set: !!c.appToken,
    user_key_masked: maskSecret(c.userKey),
    user_key_set: !!c.userKey,
    // Device name isn't a secret — round-trip it in the clear so the field shows the current value.
    device: c.device,
  };
}

// Current Pushover config for the Settings form (admin only) — masked, see publicConfig.
router.get('/config', requireAuth, requireAdmin, (req, res) => {
  res.json(publicConfig());
});

// Save Pushover config. A blank token/key keeps the currently-saved one (the secret is never sent to
// the client to echo back). Turning it ON validates the effective app token + user/group key with
// Pushover first and rejects (400, so the message survives any reverse proxy) if they don't check out.
router.put('/config', requireAuth, requireAdmin, async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const existing = getPushoverConfig();
  const appToken = (req.body?.app_token || '').trim() || existing.appToken;
  const userKey = (req.body?.user_key || '').trim() || existing.userKey;
  // Device isn't a secret and round-trips in the clear, so — unlike the tokens — a blank value means
  // "clear it → send to all devices", not "keep the saved one". Save exactly what was submitted.
  const device = (req.body?.device ?? '').trim();

  if (enabled) {
    const check = await validatePushover(appToken, userKey, device);
    if (!check.ok) {
      logger.info(`[pushover] enable rejected: ${check.error}`);
      return res.status(400).json({ error: check.error });
    }
  }

  db.prepare(
    'UPDATE settings SET pushover_enabled = ?, pushover_app_token = ?, pushover_user_key = ?, pushover_device = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, appToken || null, userKey || null, device || null, 'app');
  logger.info(`[pushover] config saved — notifications ${enabled ? 'ENABLED' : 'disabled'}`);

  res.json(publicConfig());
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
