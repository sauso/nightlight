import { logger } from './logger.js';
import { isIP } from 'node:net';

const warned = new Set();

export function parseCustomUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { url: null, warning: null };
  const bad = (reason) => ({ url: null, warning: `CUSTOM_URL value ignored: ${reason}` });
  if (value.length > 255) return bad('address is longer than 255 characters');
  // Validate the raw host before URL canonicalisation: URL accepts credentials, IPs, port zero and invalid DNS labels.
  const shape = /^https:\/\/([^/?#:@]+)(?::([0-9]+))?\/?$/i.exec(value);
  if (!shape) return bad('use a single HTTPS origin with no path, credentials, query or fragment');
  const host = shape[1];
  const lower = host.toLowerCase();
  if (!/^[\x00-\x7f]+$/.test(host)) return bad('use the xn-- form for internationalised names');
  if (host.length > 253 || !host.includes('.') || host.endsWith('.') || isIP(host) ||
      lower === 'ts.net' || lower.endsWith('.ts.net') || lower.endsWith('.local') ||
      host.split('.').some((label) => label.length < 1 || label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) {
    return bad('host must be a DNS name with at least two valid labels, outside .local and .ts.net');
  }
  if (shape[2] && (Number(shape[2]) < 1 || Number(shape[2]) > 65535)) return bad('port must be 1–65535');
  try { return { url: new URL(value).origin, warning: null }; }
  catch { return bad('invalid HTTPS origin'); }
}

export function customUrl(env = process.env) {
  const raw = env.CUSTOM_URL;
  const parsed = parseCustomUrl(raw);
  if (parsed.warning && !warned.has(raw)) {
    warned.add(raw);
    logger.warn(parsed.warning);
  }
  return parsed.url;
}
