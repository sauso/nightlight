import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { registerToken, removeToken, pushEnabled, getClientConfig } from '../lib/push.js';

const router = Router();

// The mobile app registers its FCM device token here after the user grants notification
// permission. Idempotent (token is the key), so it's safe to call on every launch / token refresh.
router.post('/register', requireAuth, (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token is required' });
  registerToken(token, platform, req.user.id);
  res.json({ ok: true, push_enabled: pushEnabled() });
});

// Called on sign-out or when the user turns notifications off, so a device stops getting alerts.
router.post('/unregister', requireAuth, (req, res) => {
  const { token } = req.body || {};
  removeToken(token);
  res.json({ ok: true });
});

// The Firebase client config for the app to initialize FCM at runtime (self-hosted: each server
// provides its own project's config). `configured` false => this server has no Firebase set up, so
// the app can tell the user notifications aren't available here (and point them at the docs).
router.get('/config', requireAuth, (req, res) => {
  const cfg = getClientConfig();
  if (!cfg) return res.json({ configured: false });
  res.json({ configured: true, ...cfg });
});

// Whether the server can actually deliver push (service-account present) and is fully configured
// (client config present too). Lets the app show an accurate notifications status.
router.get('/status', requireAuth, (req, res) => {
  res.json({ push_enabled: pushEnabled(), configured: !!getClientConfig() });
});

export default router;
