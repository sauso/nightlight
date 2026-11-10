import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { buildRemoteAccess } from '../lib/remoteAccess.js';
import tailscaleRoutes from './tailscale.js';
import { customUrl } from '../lib/customUrl.js';

export function createRemoteAccessRouter({ env = process.env, resolver = lookup, timeoutMs = 3000,
  resolveAddress = tailscaleRoutes.resolveAddress } = {}) {
  const router = Router();
  router.get('/address', requireAuth, asyncHandler(async (req, res) => {
    const custom = customUrl(env);
    if (custom) return res.json({ url: custom, kind: 'custom' });
    const answer = await resolveAddress();
    if (answer.known) return res.json({ url: answer.url, kind: answer.url ? 'tailscale' : null });
    return res.status(409).json({ error: 'The Tailscale address is not known right now.', code: 'status_unavailable' });
  }));
  // Reads local configuration only; request query and body never supply a DNS host or port.
  router.get('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    res.json(await buildRemoteAccess({
      env,
      ip: req.ip,
      forwardedHeaderPresent: req.headers['x-forwarded-for'] !== undefined,
      trustedProxyChain: req.ips.length > 0,
      trustProxy: req.app.get('trust proxy'),
      resolver,
      timeoutMs,
    }));
  }));
  return router;
}

export default createRemoteAccessRouter();
