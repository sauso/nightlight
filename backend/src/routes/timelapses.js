import { Router } from 'express';
import { requireAuth, requireAuthQueryOrHeader } from '../middleware/auth.js';
import { listChildTimelapses, getTimelapseVideoFile, getTimelapseThumbFile } from '../lib/timelapse.js';

// Nightly "memories" timelapses (lib/timelapse.js). Kept out of the clip/alert routes because a
// timelapse is neither an alert nor a recorded clip — it's a per-child keepsake with its own table.
const router = Router();

// A child's ready timelapses, newest first (metadata only; the video streams from the route below).
router.get('/child/:childId', requireAuth, (req, res) => {
  res.json(listChildTimelapses(req.params.childId));
});

// Video + thumbnail use query-or-header auth so a plain <video>/<img> can load them (a browser can't
// attach an Authorization header to those). res.sendFile honours Range so scrubbing works. The stored
// path is re-jailed under CLIPS_DIR by the lib, and Express re-enforces containment via { root }.
router.get('/:id/video', requireAuthQueryOrHeader, (req, res) => {
  const file = getTimelapseVideoFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No timelapse for this id' });
  res.sendFile(file.path, { root: file.root, dotfiles: 'deny' });
});
router.get('/:id/thumb', requireAuthQueryOrHeader, (req, res) => {
  const file = getTimelapseThumbFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No thumbnail for this id' });
  res.sendFile(file.path, { root: file.root, dotfiles: 'deny' });
});

export default router;
