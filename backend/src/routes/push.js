import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  registerToken, removeToken, pushEnabled, pushConfigured, getClientConfig,
  validatePushSetup, initPush,
} from '../lib/push.js';
import { getSnapshot } from '../lib/pushSnapshots.js';
import db from '../db.js';

const router = Router();

// The picture for an FCM image alert. Deliberately UNAUTHENTICATED: the phone downloads a push
// image in the Android system layer, which can't attach the app's bearer token. Safe because the
// :id is 256 bits of randomness and the frame expires after a few minutes (see pushSnapshots.js) —
// a single transient snapshot behind an unguessable, short-lived URL. Mounted before requireAuth.
router.get('/snapshot/:id', (req, res) => {
  const buf = /^[a-f0-9]{64}$/.test(req.params.id || '') ? getSnapshot(req.params.id) : null;
  if (!buf) return res.status(404).end();
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=180');
  res.send(buf);
});

// The mobile app registers its FCM device token here after the user grants notification
// permission. Idempotent (token is the key), so it's safe to call on every launch / token refresh.
// baseUrl is the origin the app reaches this server through, used to build a device-fetchable
// snapshot URL for image alerts (see lib/push.js sendToAll).
router.post('/register', requireAuth, (req, res) => {
  const { token, platform, baseUrl } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token is required' });
  registerToken(token, platform, req.user.id, typeof baseUrl === 'string' ? baseUrl : null);
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

// Notifications status. `configured` = the server can technically deliver (Firebase files present
// and valid); `push_enabled` = an admin has turned push on AND it's configured (i.e. pushes will
// actually be sent). The app uses these to show accurate state and gate its per-device toggle.
router.get('/status', requireAuth, (req, res) => {
  res.json({ push_enabled: pushEnabled(), configured: pushConfigured() });
});

// Admin-only server-level switch for push, kept separate from motion detection: motion detection
// still logs in-app alerts on its own, but nothing is pushed to phones unless this is on. Turning
// it ON validates the Firebase files up front and rejects (400, so the message survives any reverse
// proxy) if anything is missing, rather than silently accepting a setting that can't deliver.
router.put('/enable', requireAuth, requireAdmin, async (req, res) => {
  const enabled = !!(req.body && req.body.enabled);
  if (enabled) {
    const check = validatePushSetup();
    if (!check.ok) return res.status(400).json({ error: check.error });
    // Files are present now even if they were dropped in after startup — initialize on the spot so
    // enabling takes effect without a container restart.
    const ready = await initPush();
    if (!ready || !pushConfigured()) {
      return res.status(400).json({ error: 'Firebase failed to initialize from those files — check the server logs.' });
    }
  }
  db.prepare('UPDATE settings SET push_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, 'app');
  res.json({ push_enabled: pushEnabled(), configured: pushConfigured() });
});

export default router;
