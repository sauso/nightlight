import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json({ lines: logger.getRecent() });
});

// Clear the in-memory log buffer shown here (admin only). Doesn't affect `docker logs`.
router.delete('/', requireAuth, requireAdmin, (req, res) => {
  logger.clear();
  res.json({ ok: true });
});

export default router;
