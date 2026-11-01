import { Router } from 'express';
import { lookup } from 'node:dns/promises';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { buildRemoteAccess } from '../lib/remoteAccess.js';

export function createRemoteAccessRouter({ env = process.env, resolver = lookup, timeoutMs = 3000 } = {}) {
  const router = Router();
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
