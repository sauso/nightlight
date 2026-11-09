import { Router } from 'express';
import { join as joinPath } from 'path';
import { serveMediaFile } from '../lib/mediaFiles.js';
import db from '../db.js';
import { requireAuth, requireAdmin, requireAuthQueryOrHeader } from '../middleware/auth.js';
import {
  listChildRecordings,
  getRecordingVideoFile,
  getRecordingThumbFile,
  deleteRecording,
  setWakeClipProtected,
} from '../lib/recordings.js';

// On-demand ("Record" button) recordings. Kept out of the clip/alert routes for the same reason they
// have their own table: a recording is a keepsake someone chose to make, not a detection event.
const router = Router();

// A child's finished recordings, newest first (metadata only; the video streams from the route below).
router.get('/child/:childId', requireAuth, (req, res) => {
  res.json(listChildRecordings(req.params.childId));
});

// Video + thumbnail use query-or-header auth so a plain <video>/<img> can load them (a browser can't
// attach an Authorization header to those). serveMediaFile honours Range so scrubbing works. The stored
// path is re-jailed under CLIPS_DIR by the lib; the file itself is opened once, checked and served from that
// descriptor (lib/mediaFiles.js, #553 phase 2b): ffmpeg wrote it, possibly as another user.
router.get('/:id/video', requireAuthQueryOrHeader, (req, res) => {
  const file = getRecordingVideoFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No recording for this id' });
  serveMediaFile(req, res, joinPath(file.root, file.path), { contentType: 'video/mp4', root: file.root });
});

router.get('/:id/thumb', requireAuthQueryOrHeader, (req, res) => {
  const file = getRecordingThumbFile(req.params.id);
  if (!file) return res.status(404).json({ error: 'No thumbnail for this id' });
  serveMediaFile(req, res, joinPath(file.root, file.path), { contentType: 'image/jpeg', root: file.root });
});

router.put('/:id/protected', requireAuth, requireAdmin, (req, res) => {
  if (typeof req.body?.protected !== 'boolean') return res.status(400).json({ error: 'protected must be a boolean' });
  if (!setWakeClipProtected(req.params.id, req.body.protected)) return res.status(404).json({ error: 'No ready wake clip for this id' });
  res.json({ protected: req.body.protected });
});

// Deleting a recording (a manual one or a wake clip) is admin-only (owner decision 2026-10-10, #552): a
// caregiver can watch and act in the moment, which includes pressing Record, but not destroy, and a
// manual recording has no automatic retention, so a delete is the only thing that ever removes it and
// it cannot be undone. Watching and downloading stay open (the two media routes above).
// requireAuth FIRST: this router has no router-level use(requireAuth), so requireAdmin first would read an
// unpopulated req.user and refuse everyone, admins included, with a 403 where an anonymous caller should
// get 401 (same note as timelapses.js).
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const row = db.prepare('SELECT id, protected FROM recordings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'No recording for this id' });
  // #932: direct deletion needs an explicit unlock; child/camera purge still removes all owned data.
  if (row.protected) return res.status(409).json({ error: 'This clip is protected. Unprotect it first.' });
  deleteRecording(req.params.id);
  res.json({ ok: true });
});

export default router;
