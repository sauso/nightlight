import { normalizeRequestPath } from '../lib/httpPath.js';

// /live proxies straight through to the media server, which has no authorization model of its
// own beyond requireAuth above this. A prior version of this proxy forwarded every method and
// sub-path unrestricted — see this repo's Security Advisories for the full writeup of what that
// allowed and how it was found. This guard is a strict ALLOWLIST, not a blocklist like
// demoGuard's — the whole point is that nothing gets through except the two exact request shapes
// frontend/src/components/WhepPlayer.jsx ever sends: starting a viewing session, and ending one.
// No PATCH (trickle ICE) is allowlisted because none is used — this app sends one full SDP offer,
// not incremental candidates — and PATCH shares the identical path shape with the legitimate
// DELETE, so method is the ONLY thing distinguishing them; a pattern-only check would let a
// disguised PATCH straight through.
//
// req.path here is ALREADY /live-prefix-stripped by Express (app.use('/live', requireAuth,
// whepOnlyGuard, ...) strips it for every middleware in that chain, same reason requireAuth never
// needed to know about the prefix) — so a real request looks like /<mediamtxPath>/whep, not
// /live/<mediamtxPath>/whep.
const REJECTED_MESSAGE = 'Unsupported request for this endpoint.';

// This app's own guaranteed charset for the camera-path segment (see toPathName() in
// lib/mediamtx.js: cam_<uuid-chars>, optionally -sub) — deliberately NOT a generic "anything but a
// slash" class. A permissive [^/]+ here would accept a percent-encoded slash (%2F) inside the
// segment, which this app's own path parsing does not decode but the downstream media server's
// HTTP layer may — a decode-boundary mismatch worth closing even though it costs nothing to close.
// The session-id segment stays permissive: the media server generates that value, not us, and
// over-constraining a format we don't control risks breaking real cleanup DELETEs if it changes.
const CAMERA_PATH = '[a-z0-9_-]+';
const WHEP_START = new RegExp(`^/${CAMERA_PATH}/whep$`);
const WHEP_SESSION = new RegExp(`^/${CAMERA_PATH}/whep/[^/]+$`);

export function whepOnlyGuard(req, res, next) {
  const method = req.method.toUpperCase();
  const path = normalizeRequestPath(req.path);

  if (method === 'POST' && WHEP_START.test(path)) return next();
  if (method === 'DELETE' && WHEP_SESSION.test(path)) return next();

  return res.status(403).json({ error: REJECTED_MESSAGE });
}
