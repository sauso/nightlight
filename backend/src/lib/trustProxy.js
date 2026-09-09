import { logger } from './logger.js';

// Turning the TRUST_PROXY environment variable into a value Express will accept.
//
// ⚠️ A TYPO HERE USED TO BRICK THE CONTAINER (issue #248, found by adversarial review of the PR that
// added the setting). `app.set('trust proxy', 'true')` does not merely misconfigure anything — it
// THROWS synchronously out of proxy-addr with `invalid IP address: true`. That happens during startup,
// before the server is listening, so the crash guard correctly exits non-zero — and because the faulty
// value is an environment variable, the next container start reads exactly the same value and dies the
// same way. The result is a permanent restart loop that never serves, on a baby monitor.
//
// ★ `true` is the value someone is MOST likely to type: it is the canonical example in Express's own
// `trust proxy` documentation, where the setting really does take a boolean. Here it is a string env
// var, and the string 'true' is not a boolean. The README even used it as an example of a value that
// is merely insecure — which was wrong twice over, since the actual outcome is total unavailability.
//
// So: validate first, and fall back to the safe default with a loud log rather than taking the app
// down. An operator who fat-fingers this gets a working monitor and a warning, not an outage.
export const DEFAULT_TRUST_PROXY = 'loopback';

// The named ranges Express understands, plus the boolean-ish words people reach for by mistake.
const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * @param {string|undefined} raw  the TRUST_PROXY value, as read from the environment
 * @returns {{ value: string|number|boolean, warning: string|null }}
 */
export function parseTrustProxy(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { value: DEFAULT_TRUST_PROXY, warning: null };

  // A bare integer is a HOP COUNT and must be a Number: Express reads the STRING '1' as an IP address
  // to trust, which matches nothing, so the setting silently does nothing at all.
  if (/^\d+$/.test(s)) return { value: Number(s), warning: null };

  // ⚠️ Accepted deliberately, and it is the dangerous one. `true` trusts EVERY upstream, so any client
  // can forge X-Forwarded-For and pick its own rate-limit bucket. Honoured because an operator who
  // typed it meant "trust the proxy", and refusing outright would be its own surprise — but it is
  // never silent.
  if (s === 'true') {
    return {
      value: true,
      warning:
        'TRUST_PROXY=true trusts EVERY upstream, so any client can forge X-Forwarded-For and evade ' +
        'the login rate limit. Set it to your proxy\'s address instead.',
    };
  }
  if (s === 'false') return { value: false, warning: null };

  // Everything else must be something proxy-addr can compile: a named range, or a comma-separated
  // list of IPs/CIDRs. Validated HERE rather than by letting app.set throw.
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  const bad = parts.filter((p) => !NAMED.has(p) && !isIpOrCidr(p));
  if (bad.length) {
    return {
      value: DEFAULT_TRUST_PROXY,
      warning:
        `TRUST_PROXY=${s} is not a valid value (${bad.join(', ')}) — falling back to ` +
        `'${DEFAULT_TRUST_PROXY}'. Expected an IP or CIDR, a comma-separated list of them, a hop ` +
        "count like 1, or one of: loopback, linklocal, uniquelocal.",
    };
  }
  return { value: s, warning: null };
}

// Deliberately permissive on the address itself and strict on the SHAPE: the job here is to keep
// proxy-addr from throwing, not to re-implement its parser. Anything shaped like an IPv4/IPv6 address
// with an optional prefix length passes; proxy-addr does the exact validation.
function isIpOrCidr(p) {
  const [addr, prefix, ...rest] = p.split('/');
  if (rest.length) return false;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return false;
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(addr) && addr.split('.').every((o) => Number(o) <= 255);
  const v6 = /^[0-9a-fA-F:]+$/.test(addr) && addr.includes(':');
  return v4 || v6;
}

/** Apply it to an Express app, logging whatever the operator needs to know. */
export function applyTrustProxy(app, raw) {
  const { value, warning } = parseTrustProxy(raw);
  if (warning) logger.error(`[http] ${warning}`);
  try {
    app.set('trust proxy', value);
  } catch (err) {
    // Belt and braces. parseTrustProxy should have caught anything proxy-addr rejects, but a startup
    // crash here is an outage that no restart can clear — so if validation ever misses a case, degrade
    // to the safe default instead of taking the monitor down.
    logger.error(`[http] TRUST_PROXY was rejected by Express (${err.message}) — using '${DEFAULT_TRUST_PROXY}'.`);
    app.set('trust proxy', DEFAULT_TRUST_PROXY);
    return DEFAULT_TRUST_PROXY;
  }
  if (raw?.trim()) logger.info(`[http] trust proxy = ${JSON.stringify(value)} (from TRUST_PROXY)`);
  return value;
}
