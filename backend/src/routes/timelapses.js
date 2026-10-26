import { Router } from 'express';
import { join as joinPath } from 'path';
import { serveMediaFile } from '../lib/mediaFiles.js';
import { requireAuth, requireAdmin, requireAuthQueryOrHeader } from '../middleware/auth.js';
import { listChildTimelapses, getTimelapseVideoFile, getTimelapseThumbFile, deleteTimelapse } from '../lib/timelapse.js';

// Nightly "memories" timelapses (lib/timelapse.js). Kept out of the clip/alert routes because a
// timelapse is neither an alert nor a recorded clip — it's a per-child keepsake with its own table.
const router = Router();

// A child's ready timelapses, newest first (metadata only; the video streams from the route below).
router.get('/child/:childId', requireAuth, (req, res) => {
  res.json(listChildTimelapses(req.params.childId));
});

// Video + thumbnail use query-or-header auth so a plain <video>/<img> can load them (a browser can't
// attach an Authorization header to those). serveMediaFile honours Range so scrubbing works. The stored
// path is re-jailed under CLIPS_DIR by the lib; the file itself is opened once, checked and served from that
// descriptor (lib/mediaFiles.js, #553 phase 2b): ffmpeg wrote it, possibly as another user.
router.get('/:id/video', requireAuthQueryOrHeader, (req, res) => {
  const file = getTimelapseVideoFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No timelapse for this id' });
  serveMediaFile(req, res, joinPath(file.root, file.path), { contentType: 'video/mp4', root: file.root });
});
router.get('/:id/thumb', requireAuthQueryOrHeader, (req, res) => {
  const file = getTimelapseThumbFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No thumbnail for this id' });
  serveMediaFile(req, res, joinPath(file.root, file.path), { contentType: 'image/jpeg', root: file.root });
});

// Delete a timelapse (row + MP4 + thumbnail). Admin-only: a timelapse is a shared keepsake of someone
// else's child, so removing one is not a caregiver-level action. Irreversible — the frames it was built
// from are long gone, so the UI confirms in-app first.
// requireAuth BEFORE requireAdmin: this router has no router-level `router.use(requireAuth)` (unlike
// cameras.js), so requireAdmin alone would read an unpopulated req.user and 403 every caller.
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  if (!deleteTimelapse(req.params.id)) return res.status(404).json({ error: 'No timelapse for this id' });
  res.json({ ok: true });
});

export default router;
