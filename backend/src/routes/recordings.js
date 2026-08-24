import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAuthQueryOrHeader } from '../middleware/auth.js';
import {
  listChildRecordings,
  getRecordingVideoFile,
  getRecordingThumbFile,
  deleteRecording,
} from '../lib/recordings.js';

// On-demand ("Record" button) recordings. Kept out of the clip/alert routes for the same reason they
// have their own table: a recording is a keepsake someone chose to make, not a detection event.
const router = Router();

// A child's finished recordings, newest first (metadata only; the video streams from the route below).
router.get('/child/:childId', requireAuth, (req, res) => {
  res.json(listChildRecordings(req.params.childId));
});

// Video + thumbnail use query-or-header auth so a plain <video>/<img> can load them (a browser can't
// attach an Authorization header to those). res.sendFile honours Range so scrubbing works. The stored
// path is re-jailed under CLIPS_DIR by the lib, and Express re-enforces containment via { root }.
router.get('/:id/video', requireAuthQueryOrHeader, (req, res) => {
  const file = getRecordingVideoFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No recording for this id' });
  res.sendFile(file.path, { root: file.root, dotfiles: 'deny' });
});

router.get('/:id/thumb', requireAuthQueryOrHeader, (req, res) => {
  const file = getRecordingThumbFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No thumbnail for this id' });
  res.sendFile(file.path, { root: file.root, dotfiles: 'deny' });
});

// Any signed-in user can delete a recording they can see — same single-household trust model as the
// rest of the app, and these have no automatic retention, so a manual delete is the only way to
// reclaim the space.
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No recording for this id' });
  deleteRecording(req.params.id);
  res.json({ ok: true });
});

export default router;
