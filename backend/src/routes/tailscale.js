import { Router } from 'express';
import db from '../db.js';
import { requireAuth, requireAdmin, verifyToken } from '../middleware/auth.js';
import { detectHostNetwork } from '../lib/hostNetwork.js';
import { tailnetEnableBlocker } from '../lib/tailnetPreconditions.js';
import { startTailscale, stopTailscale, getTailscaleStatus, hasLiveTailscaleProcess } from '../lib/tailscaleProcess.js';

export function createTailscaleRouter({ database = db, dataDir = process.env.DATA_DIR || '/app/data',
  detector = detectHostNetwork, blocker = tailnetEnableBlocker, start = startTailscale,
  stop = stopTailscale, status = getTailscaleStatus, hasLiveProcess = hasLiveTailscaleProcess,
  verify = verifyToken,
  write = (value) => database.prepare("UPDATE settings SET tailscale_enabled = ? WHERE id = 'app'").run(value) } = {}) {
  const router = Router();
  let tail = Promise.resolve();
  const enabled = () => database.prepare("SELECT tailscale_enabled FROM settings WHERE id = 'app'").get()?.tailscale_enabled === 1;
  const view = () => {
    const hostNetwork = detector();
    return { enabled: enabled(), process: status(),
      blocker: blocker(database, { hostNetwork })?.code ?? null, host_network: hostNetwork };
  };
  const conflict = (res, code, message) => res.status(409).json({ error: message, code });

  router.get('/', requireAuth, requireAdmin, (req, res) => {
    try { res.json(view()); }
    catch { conflict(res, 'status_unavailable', 'Tailscale status is unavailable.'); }
  });
  router.put('/', requireAuth, requireAdmin, (req, res) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 ||
      typeof req.body.enabled !== 'boolean') {
      return res.status(400).json({ error: 'Expected only enabled as a boolean.' });
    }
    // Opus plan review of #967: a queued request can lose its live session or
    // admin role while an earlier stop waits for its child to exit.
    const job = async () => {
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
      const live = verify(token);
      if (!live) return res.status(401).json({ error: 'Invalid or expired session' });
      if (live.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
      try {
        if (req.body.enabled) {
          const hostNetwork = detector();
          const blocked = blocker(database, { hostNetwork });
          if (blocked) return conflict(res, blocked.code, blocked.message);
          start({ db: database, dataDir });
          const now = status();
          if (now.state === 'stopping' || (now.state === 'unavailable' && hasLiveProcess())) {
            return conflict(res, 'busy', 'The tunnel daemon is still stopping.');
          }
          if (now.state === 'unavailable') {
            if (hasLiveProcess()) await stop();
            return conflict(res, now.reason || 'unavailable', 'The tunnel daemon could not start.');
          }
          if (!['starting', 'running', 'backoff'].includes(now.state)) {
            return conflict(res, 'busy', 'The tunnel daemon is not ready.');
          }
          try { write(1); }
          catch {
            await stop();
            return conflict(res, 'could_not_save', 'The Tailscale setting could not be saved.');
          }
        } else {
          try { write(0); }
          catch { return conflict(res, 'could_not_save', 'The Tailscale setting could not be saved.'); }
          await stop();
          if (status().state !== 'off') {
            return res.status(409).json({ ...view(), error: 'The tunnel daemon may still be running.', code: 'stop_uncertain' });
          }
        }
        return res.json(view());
      } catch { return conflict(res, 'operation_failed', 'Tailscale could not complete the request.'); }
    };
    // Opus plan review of #967: a rejected job must not poison later requests.
    const current = tail.then(job, job);
    tail = current.catch(() => {});
    return current.catch(() => {
      if (!res.headersSent) conflict(res, 'operation_failed', 'Tailscale could not complete the request.');
    });
  });
  return router;
}

export default createTailscaleRouter();
