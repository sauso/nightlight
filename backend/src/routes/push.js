import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { registerToken, removeToken, pushEnabled } from '../lib/push.js';

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

// Lets the app show whether the server can actually deliver push (i.e. credentials are present).
router.get('/status', requireAuth, (req, res) => {
  res.json({ push_enabled: pushEnabled() });
});

export default router;
