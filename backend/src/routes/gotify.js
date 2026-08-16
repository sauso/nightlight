import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getGotifyConfig, gotifyConfigured, sendGotify } from '../lib/gotify.js';
import { maskSecret } from '../lib/secretMask.js';

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

router.put('/config', requireAuth, requireAdmin, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const serverUrl = (req.body?.server_url || '').trim().replace(/\/+$/, '');
  const existing = getGotifyConfig();
  const appToken = (req.body?.app_token || '').trim() || existing.appToken; // blank = keep
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

router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  if (!gotifyConfigured()) return res.status(400).json({ error: 'Set a server URL and application token first.' });
  const result = await sendGotify({ title: 'Nightlight', message: 'Test notification — Gotify is working.' });
  if (result && result.ok === false) return res.status(400).json({ error: result.error || 'Gotify rejected the message.' });
  res.json({ ok: true });
});

export default router;
