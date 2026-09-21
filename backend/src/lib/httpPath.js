// Shared by any guard that needs to compare a request path against a known shape without being
// fooled by Express's own lenient routing (neither `case sensitive routing` nor `strict routing`
// is set anywhere in this app, so a real request can reach a handler despite different casing or
// an extra trailing/internal slash).
//
// Found the hard way: an earlier version of this logic lived privately inside demoMode.js and
// only stripped a TRAILING slash. Express's router still dispatched an INTERNAL double slash
// (e.g. GET /api/auth//sessions) to the real handler, but that regex never saw it collapsed, so a
// demo visitor could bypass a blocklist entirely with nothing but an extra `/` in the URL. Now
// shared so this fix — and the reasoning behind it — exists in exactly one place, not two copies
// that could drift independently.
export function normalizeRequestPath(path) {
  return path.toLowerCase().replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}
