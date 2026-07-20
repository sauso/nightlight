import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const router = Router();

router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json({ lines: logger.getRecent() });
});

export default router;
