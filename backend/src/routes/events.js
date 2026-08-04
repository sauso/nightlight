import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getRecentEvents, clearCameraEvents } from '../lib/cameraEvents.js';

const router = Router();

// Admin-only, matching the raw log viewer - this is diagnostic/operational data, not
// something every caregiver needs.
router.get('/', requireAuth, requireAdmin, (req, res) => {
  res.json({ events: getRecentEvents(200) });
});

// Clear the camera up/down/restart history (admin only).
router.delete('/', requireAuth, requireAdmin, (req, res) => {
  res.json({ cleared: clearCameraEvents() });
});

export default router;
