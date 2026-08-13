import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { getNtfyConfig, ntfyConfigured, sendNtfy } from '../lib/ntfy.js';

const router = Router();

// Current ntfy config for the Settings form (admin only). The access token is shown (like Pushover's
// tokens — admin-gated, and it's sent on every publish); the basic-auth password is not returned,
// just a "set" flag, with blank-on-save meaning "keep the current one".
router.get('/config', requireAuth, requireAdmin, (req, res) => {
  const c = getNtfyConfig();
  res.json({
    enabled: c.enabled, configured: ntfyConfigured(),
    server_url: c.serverUrl, topic: c.topic, token: c.token,
    username: c.username, password_set: !!c.password,
  });
});

router.put('/config', requireAuth, requireAdmin, (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  const serverUrl = (req.body?.server_url || 'https://ntfy.sh').trim().replace(/\/+$/, '');
  const topic = (req.body?.topic || '').trim();
  const token = (req.body?.token || '').trim();
  const username = (req.body?.username || '').trim();
  const existing = getNtfyConfig();
  const password = req.body?.password ? String(req.body.password) : existing.password; // blank = keep

  if (enabled && (!serverUrl || !topic)) {
    return res.status(400).json({ error: 'A server URL and a topic are required to enable ntfy.' });
  }

  db.prepare(
    'UPDATE settings SET ntfy_enabled = ?, ntfy_server_url = ?, ntfy_topic = ?, ntfy_token = ?, ntfy_username = ?, ntfy_password = ? WHERE id = ?'
  ).run(enabled ? 1 : 0, serverUrl || 'https://ntfy.sh', topic || null, token || null, username || null, password || null, 'app');
  logger.info(`[ntfy] config saved — notifications ${enabled ? 'ENABLED' : 'disabled'}`);

  const c = getNtfyConfig();
  res.json({
    enabled: c.enabled, configured: ntfyConfigured(),
    server_url: c.serverUrl, topic: c.topic, token: c.token,
    username: c.username, password_set: !!c.password,
  });
});

router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  if (!ntfyConfigured()) return res.status(400).json({ error: 'Set a server URL and topic first.' });
  const result = await sendNtfy({ title: 'Nightlight', message: 'Test notification - ntfy is working.', priority: 3 });
  if (result && result.ok === false) return res.status(400).json({ error: result.error || 'ntfy rejected the message.' });
  res.json({ ok: true });
});

export default router;
