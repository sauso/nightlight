import { normalizeRequestPath } from '../lib/httpPath.js';

// GHSA-3h8x-wr97-gv22: /live used to forward EVERY method/sub-path to MediaMTX's WebRTC server
// verbatim, gated only by requireAuth. MediaMTX has no authorization model of its own, and its
// WHIP (publish) endpoint shares the same HTTP listener as WHEP (view) — any signed-in caregiver
// could hijack another camera's live feed by sending a publish request through this same mount.
// Confirmed against the running version (MediaMTX v1.21.0): overridePublisher defaults to true
// ("allow another client to disconnect the current publisher and publish in its place"),
// unmodified by this app's mediamtx.yml.
//
// This is a strict ALLOWLIST, not a blocklist like demoGuard's — the whole point is that nothing
// gets through except the two exact request shapes frontend/src/components/WhepPlayer.jsx ever
// sends: starting a viewing session, and ending one. No PATCH (trickle ICE) is allowlisted because
// none is used — this app sends one full SDP offer, not incremental candidates — and PATCH shares
// the identical path shape with the legitimate DELETE, so method is the ONLY thing distinguishing
// them; a pattern-only check would let a disguised PATCH straight through.
//
// req.path here is ALREADY /live-prefix-stripped by Express (app.use('/live', requireAuth,
// whepOnlyGuard, ...) strips it for every middleware in that chain, same reason requireAuth never
// needed to know about the prefix) — so a real request looks like /<mediamtxPath>/whep, not
// /live/<mediamtxPath>/whep.
const REJECTED_MESSAGE = 'Unsupported request for this endpoint.';

// This app's own guaranteed charset for the camera-path segment (see toPathName() in
// lib/mediamtx.js: cam_<uuid-chars>, optionally -sub) — deliberately NOT a generic "anything but a
// slash" class. A permissive [^/]+ here would accept a percent-encoded slash (%2F) inside the
// segment: Express's path parsing does not decode that, but MediaMTX's Go HTTP server likely does
// before its own routing runs — a decode-boundary mismatch between the two layers this guard sits
// between. The session-id segment stays permissive: MediaMTX generates that value, not us, and
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
