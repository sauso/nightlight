import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { pushEnabled, pushConfigured } from '../lib/push.js';
import { pushoverEnabled, pushoverConfigured } from '../lib/pushover.js';
import { ntfyEnabled, ntfyConfigured } from '../lib/ntfy.js';
import { gotifyEnabled, gotifyConfigured } from '../lib/gotify.js';

const router = Router();

// One call for the Push-notifications hub to show each provider's state at a glance. `configured` =
// it could deliver; `enabled` = an admin turned it on AND it's configured (so alerts will go out).
router.get('/status', requireAuth, requireAdmin, (req, res) => {
  res.json({
    firebase: { enabled: pushEnabled(), configured: pushConfigured() },
    pushover: { enabled: pushoverEnabled(), configured: pushoverConfigured() },
    gotify: { enabled: gotifyEnabled(), configured: gotifyConfigured() },
    ntfy: { enabled: ntfyEnabled(), configured: ntfyConfigured() },
  });
});

export default router;
