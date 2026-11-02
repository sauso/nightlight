import db from '../db.js';
import { logger } from './logger.js';

// #937: who this server is, for a phone that has found it on the network.
//
// `id` is the random UUID db.js makes once (settings.server_id; db.js says why it lives in the database). `name` is
// the existing app name (settings.app_name, default "Nightlight"), deliberately not a new setting: GET /api/settings
// already serves it WITHOUT sign-in (the login screen shows it), so putting it here exposes nothing new. Nothing else
// from the settings row is read here, so nothing else can reach the unauthenticated health reply
// (server-identity.test.js plants a marker in every settings column to hold that).
//
// Kept out of routes/settings.js on purpose: that router answers with an allow-list, and the id has no business in
// it (settings-exposure.test.js checks it stays out).

const DEFAULT_NAME = 'Nightlight';

// Prepared per call, not once at import: /api/health is asked about every 30 s (the image's HEALTHCHECK), which is
// nothing to SQLite, and a statement prepared at import would turn a broken settings table into a failed import of
// the whole app instead of the `{ ok: true }` fallback below.
export function readIdentityRow() {
  return db.prepare("SELECT server_id, app_name FROM settings WHERE id = 'app'").get();
}

/**
 * This server's identity: `{ id, name }`. `id` is null only if the settings row has none (db.js always writes
 * one, so that means a database edited by hand). Throws if `read` throws; healthBody is the caller that must not.
 */
export function getServerIdentity({ read = readIdentityRow } = {}) {
  const row = read() || {};
  return { id: row.server_id ?? null, name: row.app_name || DEFAULT_NAME };
}

// One WARN per process, not one per probe: the HEALTHCHECK alone would repeat it every 30 s.
let warnedReadFailure = false;

/**
 * The /api/health reply. ADDITIVE ONLY: `ok: true` is still there, because existing clients check for it (the
 * phone apps look for `"ok"` in the body, the Docker HEALTHCHECK and the e2e scripts look at the status alone).
 * The version is deliberately NOT included: this reply is public, and a version number helps someone find an
 * outdated install to attack.
 * If the identity cannot be read it answers `{ ok: true }` alone: this is a liveness probe, and the server being
 * up must never be reported as down because of the identity.
 */
export function healthBody({ read = readIdentityRow } = {}) {
  try {
    const { id, name } = getServerIdentity({ read });
    return { ok: true, app: 'nightlight', id, name };
  } catch (err) {
    if (!warnedReadFailure) {
      warnedReadFailure = true;
      logger.warn(`[health] could not read the server identity, so /api/health answers {"ok":true} only: ${err?.message || err}`);
    }
    return { ok: true };
  }
}

/**
 * GET /api/health. Exported as the handler itself, and mounted as this function in index.js, because index.js
 * cannot be imported by a test: health-route.test.js mounts THIS function, so the route and the test share one
 * piece of code (a test of healthBody alone would still pass if the route went back to `{ ok: true }`).
 */
export function healthHandler(req, res) {
  res.json(healthBody());
}
