import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { normalizeRequestPath } from '../lib/httpPath.js';

// DEMO_MODE — makes the running app read-only except for logging in and out, for the public
// read-only demo instance (a separate, isolated deployment; not this module's concern beyond this
// flag). A complete no-op unless DEMO_MODE is exactly the string 'true' — every real self-hosted
// install leaves it unset, so this file changes nothing for them.
//
// Read fresh on every call rather than memoized at module load (contrast DATA_DIR/JWT_SECRET/
// TRUST_PROXY): this is a cheap string compare with no file I/O or parsing behind it, and reading
// it live is what lets the test suite exercise both the on and off behaviour from one imported
// module instead of spawning a child process per case (see jwt-secret.test.js for why THAT
// pattern exists — it's needed there only because that value really is resolved once, expensively).
export function isDemoModeActive() {
  return process.env.DEMO_MODE === 'true';
}

const BLOCKED_MESSAGE = 'This is a read-only public demo - that action is disabled here.';

// The viewer cap limits newly-created login sessions, not the work one admitted browser can ask the
// server to do. Keep a separate per-IP ceiling in front of API and media signalling so snapshot and
// WHEP/HLS request floods are bounded too. 600/minute leaves room for normal app bootstrap plus HLS
// playlist/segment traffic; the public deployment still needs the plan's ~25-viewer load measurement
// before anyone treats this as a CPU or bandwidth capacity claim.
const DEMO_REQUESTS_PER_MINUTE = 600;
export const demoRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: DEMO_REQUESTS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !isDemoModeActive(),
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: { error: 'Too many demo requests - please wait a moment and try again.' },
});

// Exact METHOD + path pairs a demo visitor may still perform, despite being a mutating verb.
// EXACT-MATCH, not a /api/auth prefix allow: routes/auth.js has plenty of OTHER POST/PUT/DELETE
// routes under /api/auth (password change, MFA enrolment, user CRUD...) that must stay blocked
// even though the demo account runs as admin and could otherwise reach every one of them.
//
// POST /api/auth/media-token is allowlisted deliberately, found missing in design review: it's
// the ONLY way the frontend obtains the short-lived token that requireAuthQueryOrHeader routes
// need for <img>/<video> src URLs — snapshots, clips, recordings, timelapses. Without it the demo
// wouldn't error, it would just silently fail to show any of that.
const MUTATION_ALLOWLIST = new Set([
  'POST /api/auth/guest',
  'POST /api/auth/login',
  'POST /api/auth/login/mfa',
  'POST /api/auth/logout',
  'POST /api/auth/media-token',
]);

// GETs blocked regardless of the mutation check below, because they leak server internals or
// cross-visitor session data, not because they mutate anything. NOT prefix-matched — if either
// router ever grows a second matching GET route, add it here explicitly.
const GET_BLOCKLIST = new Set([
  '/api/diagnostics',
  '/api/logs',
  '/api/auth/sessions',
  '/api/auth/sessions/all',
]);

// The one GET that mutates, found in design review: GET /children/:id/sleep/:date?store=1 (admin
// only) calls computeAndStoreNight() — the server side of the real "Recompute this night -> Save
// the new numbers" admin feature. A dedicated audit of every router.get() handler in the app found
// this is the ONLY such instance; if a future route adds a second one, it needs its own clause
// here too, same as GET_BLOCKLIST above.
const RECOMPUTE_STORE_PATH = /^\/api\/children\/[^/]+\/sleep\/[^/]+$/;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function demoGuard(req, res, next) {
  if (!isDemoModeActive()) return next();

  const method = req.method.toUpperCase();
  const path = normalizeRequestPath(req.path);

  // HEAD is covered alongside GET: Express serves HEAD via the GET handler when no explicit HEAD
  // route exists, so without this a HEAD request would still run the full (expensive, internals-
  // leaking) handler body while only the response body was withheld.
  if ((method === 'GET' || method === 'HEAD') && GET_BLOCKLIST.has(path)) {
    return res.status(403).json({ error: BLOCKED_MESSAGE });
  }

  if (
    (method === 'GET' || method === 'HEAD')
    && req.query.store === '1'
    && RECOMPUTE_STORE_PATH.test(path)
  ) {
    return res.status(403).json({ error: BLOCKED_MESSAGE });
  }

  if (MUTATING_METHODS.has(method) && !MUTATION_ALLOWLIST.has(`${method} ${path}`)) {
    return res.status(403).json({ error: BLOCKED_MESSAGE });
  }

  next();
}
