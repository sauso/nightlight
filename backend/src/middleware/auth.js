import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../db.js';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');

// If JWT_SECRET isn't explicitly set, generate a random one and persist it in the
// data volume so it survives restarts (sessions would otherwise invalidate every
// time the container restarts). This also removes what would otherwise be a real
// security footgun for a publicly-distributed image: a hardcoded fallback secret
// would mean every default install shares the same, publicly-known signing key.
function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    if (fs.existsSync(SECRET_FILE)) {
      return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
  } catch {
    // Fall through to generating a fresh one.
  }
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  } catch {
    // If this can't be persisted, sessions just won't survive a restart - the
    // app still works fine for the current run either way.
  }
  return secret;
}

const JWT_SECRET = loadOrCreateSecret();

// A JWT being cryptographically valid only proves it was issued by us and hasn't
// expired - it says nothing about whether the session it names is still active.
// Checking the session (rather than just whether the user still exists) is what
// makes both "sign out this specific device" and "delete this caregiver" take effect
// on the very next request, rather than waiting for the token to naturally expire.
const touchSession = db.prepare(
  "UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ? AND last_seen_at < datetime('now', '-60 seconds')"
);
// Returns the session joined to its user's CURRENT row, or null. The join is the point.
//
// ⚠️ AUTHORISATION MUST BE EVALUATED NOW, NOT WHEN THE TOKEN WAS MINTED (issue #261). This used to
// return a bare boolean, and every caller then trusted the `role` claim inside the JWT. Changing a
// user's role writes to `users` and does nothing to their existing tokens, so demoting an admin did
// not take effect until the token expired — up to 30 DAYS. That window includes the routes that set
// roles, so the demoted user could promote themselves back and make the demotion permanent-proof.
// Demotion is a security action: a departing carer, an account being locked down. The UI confirmed it
// and nothing said it would not apply for a month.
//
// The session lookup was already happening on every authenticated request, so carrying the live role
// out of the same query costs nothing extra. The JWT carries identity; the database decides what that
// identity may do.
const sessionWithUser = db.prepare(
  'SELECT s.id AS sid, s.user_id AS user_id, u.role AS role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
);
function liveSession(sessionId) {
  if (!sessionId) return null;
  // A session whose user row has been deleted returns nothing from the JOIN, which is the behaviour we
  // want — a deleted account's token stops working immediately, exactly as a revoked session does.
  const row = sessionWithUser.get(sessionId);
  if (!row) return null;
  touchSession.run(sessionId); // throttled - only actually writes if last_seen_at is stale
  return row;
}

// Verify a raw JWT the same way the middleware does (signature + live session), for contexts
// without an Express req/res - e.g. the WebSocket upgrade handshake. Returns the payload or null.
// Pass { purpose } to require a specific token purpose (e.g. 'media' for the talk WebSocket, whose
// token travels in the URL and so must be a media-scoped capability, not a full session token).
export function verifyToken(token, { purpose } = {}) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (purpose ? payload.purpose !== purpose : payload.purpose === 'media') return null;
    const sess = liveSession(payload.sid);
    if (!sess) return null;
    // The role comes from the DB, never from the claim — see liveSession (issue #261).
    return { ...payload, role: sess.role };
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    // A media-scoped token (see routes/auth.js /media-token) is a video/image-only capability meant
    // to ride in URL query params — it must NEVER authenticate a full API request, even though it
    // names a live session. This is what confines a leaked media URL to media, not account access.
    if (payload.purpose === 'media') return res.status(401).json({ error: 'Invalid or expired session' });
    const sess = liveSession(payload.sid);
    if (!sess) return res.status(401).json({ error: 'Invalid or expired session' });
    // ⚠️ The database's role overrides the token's (issue #261) — see liveSession.
    req.user = { ...payload, role: sess.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Same as requireAuth, but also accepts the token as a ?token= query param.
// Needed for HLS: Safari's native <video> player fetches playlist/segment URLs
// itself with no way for us to attach an Authorization header to those requests.
// A token in the QUERY STRING must be media-scoped: query strings leak into reverse-proxy/CDN access
// logs, browser history and Referer headers, so only a short-lived, media-only capability may travel
// that way. A full session token is accepted only via the Authorization header (which those channels
// don't record).
export function requireAuthQueryOrHeader(req, res, next) {
  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = headerToken || req.query.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (!headerToken && payload.purpose !== 'media') {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    const sess = liveSession(payload.sid);
    if (!sess) return res.status(401).json({ error: 'Invalid or expired session' });
    // ⚠️ The database's role overrides the token's (issue #261) — see liveSession.
    req.user = { ...payload, role: sess.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Populates req.user when a valid session token is present, and does NOT reject when one is absent or
// invalid. For a route that must answer unauthenticated callers but reveal more to a signed-in one —
// currently only GET /settings, whose public half feeds the login screen before anyone can sign in.
// Reuses verifyToken, so a media-scoped token is rejected here exactly as it is in requireAuth: a
// leaked media URL must never widen a response.
export function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (payload) req.user = payload;
  next();
}

// Is this request an admin's? For routes that serve BOTH roles and vary the response SHAPE — not a
// gate (that is requireAdmin), which is why it returns a boolean instead of ending the request.
//
// Own-property read, not a plain `req.user?.role === 'admin'`: jwt.verify hands back a JSON.parse'd
// object, so a plain read resolves through the prototype chain and a token carrying no role claim
// would answer as admin if Object.prototype.role were ever set. No vector was found for setting it,
// but the direction it fails in is WIDENING a response, so every such decision goes through this one
// function rather than repeating the idiom and having the copies drift.
export function isAdminRequest(req) {
  const user = req?.user;
  return user != null && Object.hasOwn(user, 'role') && user.role === 'admin';
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export { JWT_SECRET };
