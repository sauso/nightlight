import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getNtfyConfig, ntfyConfigured, sendNtfy } from '../lib/ntfy.js';
import { maskSecret } from '../lib/secretMask.js';

const router = Router();

// The access token and basic-auth password are secrets — return a masked preview + "set" flag only,
// never the raw values; blank-on-save means "keep the current one". Server URL / topic / username are
// not secret and come back in full.
function publicConfig() {
  const c = getNtfyConfig();
  return {
    enabled: c.enabled, configured: ntfyConfigured(),
    server_url: c.serverUrl, topic: c.topic, username: c.username,
    token_masked: maskSecret(c.token), token_set: !!c.token,
    password_set: !!c.password,
  };
}

// Current ntfy config for the Settings form (admin only) — masked secrets, see publicConfig.
router.get('/config', requireAuth, requireAdmin, (req, res) => {
  res.json(publicConfig());
});

router.put('/config', requireAuth, requireAdmin, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const serverUrl = (req.body?.server_url || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  const topic = (req.body?.topic || '').trim();
  const username = (req.body?.username || '').trim();
  const existing = getNtfyConfig();
  const token = (req.body?.token || '').trim() || existing.token; // blank = keep
  const password = req.body?.password ? String(req.body.password) : existing.password; // blank = keep

  if (enabled && (!serverUrl || !topic)) {
    return res.status(400).json({ error: 'A server URL and a topic are required to enable ntfy.' });
  }

  db.prepare(
    'UPDATE settings SET ntfy_enabled = ?, ntfy_server_url = ?, ntfy_topic = ?, ntfy_token = ?, ntfy_username = ?, ntfy_password = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, serverUrl || 'https://ntfy.sh', topic || null, token || null, username || null, password || null, 'app');
  logger.info(`[ntfy] config saved — notifications ${enabled ? 'ENABLED' : 'disabled'}`);

  res.json(publicConfig());
});

router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  if (!ntfyConfigured()) return res.status(400).json({ error: 'Set a server URL and topic first.' });
  const result = await sendNtfy({ title: 'Nightlight', message: 'Test notification - ntfy is working.', priority: 3 });
  if (result && result.ok === false) return res.status(400).json({ error: result.error || 'ntfy rejected the message.' });
  res.json({ ok: true });
});

export default router;
