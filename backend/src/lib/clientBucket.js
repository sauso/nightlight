import { createHash } from 'node:crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import { isLoopbackAddress, isLoopbackExposed } from './loopbackExposure.js';
import { logger } from './logger.js';

const observedBucketHeaders = new Set();

export function _resetBucketLog() {
  observedBucketHeaders.clear();
}

export function clientBucketKey(req) {
  // Only Serve's loopback path can supply an identity for this purpose. A LAN caller or a normal
  // reverse proxy must keep the exact IPv4/IPv6 subnet key it had before #961.
  if (!(isLoopbackExposed() && isLoopbackAddress(req.ip))) return ipKeyGenerator(req.ip);

  // This staging measurement records whether Serve supplies identity and X-Forwarded-For. Four
  // fixed labels are logged at most once per process; no request-supplied value reaches the log.
  const raw = req.headers['tailscale-user-login'];
  const login = typeof raw === 'string' ? raw.slice(0, 256).trim() : '';
  const label = `identity header ${login ? 'present' : 'absent'}, x-forwarded-for ${req.headers['x-forwarded-for'] !== undefined ? 'present' : 'absent'}`;
  if (!observedBucketHeaders.has(label)) {
    observedBucketHeaders.add(label);
    logger.info(`[http] tunnel account bucket: ${label}`);
  }

  if (!login) return ipKeyGenerator(req.ip);

  // #961: cap a host-local forger at 64 buckets and bounded limiter memory. Serve strips and sets
  // this header for real peers, but a process on the host can forge it. Tagged devices have no
  // identity header and share the fallback; a user on a shared-in device has their own login.
  // Two people can collide in one slot (1 in 64) and then simply share a bucket as before.
  const hash = createHash('sha256').update(login.toLowerCase()).digest();
  return `tunnel:${hash.readUInt32BE(0) % 64}`;
}
