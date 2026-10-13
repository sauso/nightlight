// The Content-Security-Policy, and every other helmet option, that index.js serves (#562 bullet 6).
//
// WHY THE WHOLE helmet(...) OPTIONS OBJECT LIVES HERE AND NOT IN index.js: index.js cannot be imported by a
// test (it starts MediaMTX, MQTT and an HTTP listener; see route-permissions.test.js). A policy built inline
// there could only ever be read as text. Built here, the exact object index.js hands to helmet is the one
// csp-directives.test.js deep-equals and serves through a real helmet to read the header back (plan review,
// 2026-10-13: tests of a pure builder prove nothing if the live header still comes from a hard-coded copy, so
// the same test file also pins that index.js calls this and holds no origin of its own).
//
// ENFORCING, validated by a report-only rollout on staging that exercised every feature (2026-08-24). The
// report-uri still logs any future violation to /api/csp-report, so a regression (a new dependency pulling a
// third-party script) shows up in the container log instead of silently. Directives are tuned to this app:
//  - script-src 'self': Vite emits one external module script (no inline scripts; don't add unsafe-*).
//  - style-src 'self': theming uses element.style.setProperty (CSSOM), which CSP doesn't police; app CSS is
//    an external <link>. (If real style violations show up, add 'unsafe-inline': low risk.)
//  - media-src/worker-src blob:: hls.js feeds <video> via MSE blob URLs and runs its demuxer worker from a
//    blob: URL. img-src data:: snapshot posters/icons. font-src data:: any inlined @font-face.
//  - connect-src adds the client-side WebRTC STUN host (WhepPlayer.jsx); keep it in sync if it ever changes.
//  - No upgrade-insecure-requests: the app is also served over plain http on the LAN.
//
// ⚠️ CLOUDFLARE WEB ANALYTICS IS OPT-IN (#562 bullet 6, owner decision 2026-10-13). Until then script-src and
// connect-src allowed Cloudflare's beacon origins on EVERY install, "by choice": a choice made for one
// Cloudflare-fronted deployment that every other install inherited, letting a third-party script run on a
// baby monitor that had never asked for it. Now the two origins are added only when CLOUDFLARE_ANALYTICS is
// on. What someone relying on the beacon sees after upgrading without setting it: Cloudflare's proxy still
// injects the beacon <script> into every page, the browser refuses it (a CSP violation in the console), and
// each refusal is POSTed to /api/csp-report (logged, at most 10 a minute). The two ways out, documented in
// docs/architecture.md and the README: set the variable, or turn off the automatic beacon injection for that
// site in the Cloudflare dashboard.

export const CLOUDFLARE_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com'; // serves beacon.min.js
export const CLOUDFLARE_BEACON_ORIGIN = 'https://cloudflareinsights.com'; //         the beacon POSTs here

// The usual spellings of a yes/no environment flag. Only these turn it ON; the OFF list exists so that an
// explicit "no" is quiet while a typo is not (see parseCloudflareAnalytics).
const ON_VALUES = new Set(['1', 'true', 'yes', 'on']);
const OFF_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Read the CLOUDFLARE_ANALYTICS environment value.
 *
 * Trimmed and case-insensitive. ON: 1, true, yes, on. Everything else is OFF, the default, including unset
 * and blank. ⚠️ An unrecognised non-blank value (`enabled`, `maybe`, `ture`) is also OFF, never ON: a typo
 * fails CLOSED (the beacon stays blocked, which costs an analytics page view) rather than open (a third-party
 * script allowed that nobody meant to allow). But it comes with a warning, so the operator who typed it finds
 * out why their analytics went quiet: the same idea as UMASK's "anything else is ignored with a warning".
 *
 * @param {string|undefined} raw
 * @returns {{ enabled: boolean, warning: string|null }}
 */
export function parseCloudflareAnalytics(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const v = s.toLowerCase();
  if (ON_VALUES.has(v)) return { enabled: true, warning: null };
  if (v === '' || OFF_VALUES.has(v)) return { enabled: false, warning: null };
  return {
    enabled: false,
    warning:
      `CLOUDFLARE_ANALYTICS=${JSON.stringify(s)} is not a recognised value, so Cloudflare Web Analytics stays ` +
      'BLOCKED by the Content-Security-Policy. Set it to 1, true, yes or on to allow the beacon; leave it blank ' +
      '(or 0, false, no, off) to keep it blocked.',
  };
}

/**
 * The CSP directives. A fresh object (fresh arrays too) on every call, so nothing a caller or helmet does to
 * one can leak into the next.
 *
 * @param {Record<string, string|undefined>} [env]  normally process.env
 */
export function buildCspDirectives(env = process.env) {
  const { enabled } = parseCloudflareAnalytics(env.CLOUDFLARE_ANALYTICS);
  // Appended LAST, at the positions they had before #562, so that with the setting on the header is
  // byte-for-byte what every install served until now (csp-directives.test.js deep-equals it).
  const cfScript = enabled ? [CLOUDFLARE_SCRIPT_ORIGIN] : [];
  const cfConnect = enabled ? [CLOUDFLARE_BEACON_ORIGIN] : [];
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...cfScript],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    mediaSrc: ["'self'", 'blob:'],
    workerSrc: ["'self'", 'blob:'],
    connectSrc: ["'self'", 'stun.l.google.com:19302', ...cfConnect],
    fontSrc: ["'self'", 'data:'],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    reportUri: ['/api/csp-report'],
  };
}

/**
 * Everything index.js passes to helmet(). `useDefaults: false` so helmet adds no directive of its own: the
 * policy is exactly the list above.
 *
 * @param {Record<string, string|undefined>} [env]  normally process.env
 * @param {{ warn: Function, info: Function }|null} [log]  index.js passes the app logger, once, at start; tests
 *   pass a recorder or nothing (null = no logging, so the builder stays pure for the cases that only want
 *   the object).
 */
export function buildHelmetOptions(env = process.env, log = null) {
  if (log) {
    const { enabled, warning } = parseCloudflareAnalytics(env.CLOUDFLARE_ANALYTICS);
    if (warning) log.warn(`[http] ${warning}`);
    // Said once at start when it is on, so an operator checking "did my setting reach the app" can see it in
    // `docker logs`. Silent when off: that is the default, and every install would otherwise log it.
    else if (enabled) log.info('[http] CSP allows Cloudflare Web Analytics (CLOUDFLARE_ANALYTICS is on)');
  }
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: buildCspDirectives(env),
    },
  };
}
