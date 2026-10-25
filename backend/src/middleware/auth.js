import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../db.js';
import { logger } from '../lib/logger.js';
import { dataDirFrom, ensurePrivateDir, JWT_SECRET_FILE, present, privateDirOf, resolveSecretFile } from '../lib/dataPaths.js';

const DATA_DIR = dataDirFrom();
// #553 phase 2a: private/.jwt_secret, or the top-level one on an install the start-up move has not reached; a new
// secret goes into private/ (lib/dataPaths.js, resolveSecretFile).
const SECRET_FILE = resolveSecretFile(JWT_SECRET_FILE, DATA_DIR);

// --- How long a sign-in lasts: SESSION_TTL_DAYS (#562 bullet 7) -------------------------------------
//
// The lifetime is ABSOLUTE, counted from sign-in (sessions.created_at), never from the last request:
// there is no idle sign-out, and a device is signed out at the same time of day it signed in, N days
// later. On that request the app shows the sign-in screen; push alerts to that device stop at the
// same moment, and nothing on the phone says so until someone opens the app.
//
// ⚠️ WHY 7-30 AND NOT 1-30 OR "ANY NUMBER" (owner said "configurable", 2026-10-13; the range is the
// builder's call and the PR says so):
//   * NOT ABOVE 30. A longer lifetime would also have to move the 31-day idle purge below, and every
//     comment and doc that assumes 30. Nobody asked for longer; "shorten only" keeps one ceiling.
//   * NOT BELOW 7. Because the end is absolute and silent for push, a short value turns into a
//     nightly outage on a baby monitor: at 1 day, a parent who signed in at 02:00 stops getting
//     alerts at 02:00 every night until they open the app. A week is the shortest value where that
//     happens rarely enough to notice and fix; anything shorter is not offered.
// Default 30 = the lifetime before this setting existed.
export const DEFAULT_SESSION_TTL_DAYS = 30;
export const MIN_SESSION_TTL_DAYS = 7;
export const MAX_SESSION_TTL_DAYS = DEFAULT_SESSION_TTL_DAYS;

/**
 * @param {string|undefined} raw  SESSION_TTL_DAYS as read from the environment
 * @returns {{ days: number, warning: string|null }}
 */
export function parseSessionTtlDays(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { days: DEFAULT_SESSION_TTL_DAYS, warning: null };
  // Digits only, checked BEFORE Number(): Number() reads '1e1' as 10, '0x1e' as 30 and ' 7 ' as 7, so a
  // typo or a hex/exponent spelling would quietly become a different lifetime. Leading zeros ('007') are
  // still plain decimal digits and read as 7.
  if (/^[0-9]+$/.test(s)) {
    const days = Number(s);
    if (days >= MIN_SESSION_TTL_DAYS && days <= MAX_SESSION_TTL_DAYS) return { days, warning: null };
  }
  // Same rule as UMASK, TRUST_PROXY and WEBRTC_UDP_PORT: a bad value is never fatal (a typo in an env var
  // must not crash-loop a baby monitor), it falls back to the default and says so in the log once.
  return {
    days: DEFAULT_SESSION_TTL_DAYS,
    warning:
      `SESSION_TTL_DAYS=${JSON.stringify(raw)} is not a whole number of days from ${MIN_SESSION_TTL_DAYS} to ` +
      `${MAX_SESSION_TTL_DAYS} - using the default, ${DEFAULT_SESSION_TTL_DAYS}.`,
  };
}

/** The start-up log line: a warning for a bad value, the value in effect whenever it is not the default. */
export function reportSessionTtl({ days, warning }, log = logger) {
  if (warning) log.warn(`[auth] ${warning}`);
  else if (days !== DEFAULT_SESSION_TTL_DAYS) {
    log.info(`[auth] sign-ins last ${days} days (SESSION_TTL_DAYS; the default is ${DEFAULT_SESSION_TTL_DAYS})`);
  }
}

const sessionTtl = parseSessionTtlDays(process.env.SESSION_TTL_DAYS);
reportSessionTtl(sessionTtl);

// The session token's absolute lifetime (routes/auth.js's sign()). Exported here, not there, so
// anything needing to reason about a session's absolute age can import one number rather than a second
// hardcoded copy silently drifting from it. Read ONCE, at start: changing SESSION_TTL_DAYS needs a
// restart, like every other environment setting.
export const SESSION_TOKEN_TTL_DAYS = sessionTtl.days;

// THE ONE DEFINITION of "this session is still within its lifetime", as a SQL fragment plus its one
// parameter. Every place that asks the question uses it (#562: the plan review found five copies would
// drift): sessionWithUser (every API request, verifyToken, the media-token routes and the talk socket),
// isLiveSessionId (the live-view sweep), lib/push.js's activePushTokens, purgeExpiredSessions, and the
// two session LISTS in routes/auth.js. Before #562 the request path did NOT check age at all: a session
// was bounded only by its token's own `exp`, while push and the live-view sweep already cut at 30 days.
//
// Why created_at, not the token's `exp`: lowering SESSION_TTL_DAYS must end sessions that already hold a
// 30-day token, and only the row knows when the session began. Tokens are never re-signed for an existing
// session, so created_at is the sign-in time.
//
// ⚠️ UP TO 1 SECOND EARLY, by design. createSession writes created_at (SQLite's datetime('now'), whole
// seconds, rounded down) BEFORE sign() stamps the token's `iat`, so the row can be up to a second older
// than the token and the session ends up to a second before its `exp`. Harmless, and why the tests age
// sessions by N days +/- 1 MINUTE rather than asserting to the second.
//
// ⚠️ THE MEDIA TOKEN NOW ENDS WITH ITS SESSION. A 12-hour media token minted near the end of a session used
// to keep working for up to 12 hours past the session token's expiry (HLS, snapshots, clips, talk). Its
// requests go through sessionWithUser too, so it now stops at the same moment, which also makes HLS agree
// with the WebRTC sweep that already cut at 30 days.
//
// `alias` qualifies the column for a query that joins: /sessions/all joins `users`, which has a
// created_at of its own. It is always a literal written in this codebase, never input; the check is so a
// slip fails loudly instead of building odd SQL.
const SESSION_AGE_COLUMN = 'created_at';
export function sessionAgeCondition(alias = '') {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error(`sessionAgeCondition: bad alias ${alias}`);
  const column = alias ? `${alias}.${SESSION_AGE_COLUMN}` : SESSION_AGE_COLUMN;
  return { sql: `${column} > datetime('now', ?)`, params: [`-${SESSION_TOKEN_TTL_DAYS} days`] };
}

// If JWT_SECRET isn't explicitly set, generate a random one and persist it in the
// data volume so it survives restarts (sessions would otherwise invalidate every
// time the container restarts). This also removes what would otherwise be a real
// security footgun for a publicly-distributed image: a hardcoded fallback secret
// would mean every default install shares the same, publicly-known signing key.
function loadOrCreateSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (present(SECRET_FILE)) {
    try {
      return fs.readFileSync(SECRET_FILE, 'utf8').trim();
    } catch (err) {
      // It EXISTS but cannot be read (a restore that left it owner-writable but not readable, say). Never write over
      // it: that would destroy the real secret and sign everyone out for good, which a fresh secret written over it
      // used to do without a word (Codex review of PR #870). This run signs with a temporary secret instead, and says so.
      logger.error(
        `[auth] the session signing secret at ${SECRET_FILE} exists but cannot be read (${err.code || err.message}). It ` +
          'was left as it is, and this run uses a temporary secret, so every sign-in ends at the next restart. Give the ' +
          'file to PUID:PGID with mode 600 on the host (or set JWT_SECRET), then restart.'
      );
      return crypto.randomBytes(48).toString('hex');
    }
  }
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // #553 phase 2a: a new secret goes into private/, which may not exist yet (a fresh install whose JWT_SECRET was
    // set before, an install whose database the start-up move left at the top level). Created 0700 by an explicit
    // chmod first: writeFileSync does not create folders, and this used to fail SILENTLY (plan review, C9).
    if (path.dirname(SECRET_FILE) === privateDirOf(DATA_DIR)) ensurePrivateDir(DATA_DIR);
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  } catch (err) {
    // The app still works for this run, so this is not fatal; but every restart would then sign everyone out (and
    // stop their push alerts), with nothing else to say why. So it is said here, once, loudly.
    logger.error(
      `[auth] could not save the session signing secret to ${SECRET_FILE} (${err.message}): everyone will be signed ` +
        'out at every restart until it can be saved. Check that the data directory, and private/ inside it, belong ' +
        'to PUID:PGID, or set JWT_SECRET.'
    );
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
//
// The lifetime check (#562) is in this WHERE clause, not a test after it, so a session past its lifetime
// returns no row and liveSession below never reaches touchSession: a client that keeps retrying with a
// dead token must not keep refreshing last_seen_at, which is what the idle purge keys on.
const requestAge = sessionAgeCondition('s');
const sessionWithUser = db.prepare(
  `SELECT s.id AS sid, s.user_id AS user_id, u.role AS role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND ${requestAge.sql}`
);
function liveSession(sessionId) {
  if (!sessionId) return null;
  // A session whose user row has been deleted returns nothing from the JOIN, which is the behaviour we
  // want — a deleted account's token stops working immediately, exactly as a revoked session does.
  const row = sessionWithUser.get(sessionId, ...requestAge.params);
  if (!row) return null;
  touchSession.run(sessionId); // throttled - only actually writes if last_seen_at is stale
  return row;
}

// For the WebRTC live-view sweep (index.js): is the login session that opened a view still valid? The
// same lifetime rule as a request, without touching last_seen_at (the sweep is the server checking, not
// the person using the app) and without the users join (deleting a user cascades its sessions).
const sweepAge = sessionAgeCondition();
const sessionAlive = db.prepare(`SELECT 1 FROM sessions WHERE id = ? AND ${sweepAge.sql}`);
export function isLiveSessionId(sid) {
  if (!sid) return false;
  return !!sessionAlive.get(sid, ...sweepAge.params);
}

// Housekeeping (index.js runs it at start and daily). Every login inserts a sessions row and only an
// explicit sign-out deletes one, so rows would otherwise pile up forever. Two reasons a row goes:
//   * past its lifetime (created_at, #562): it can never authenticate again, and deleting it also takes
//     it off the session lists at once rather than leaving a dead device listed until it goes idle;
//   * idle for 31 days (last_seen_at, the rule before #562): kept so a row whose created_at is in the
//     future (a clock that went backwards, a restored backup) still goes eventually.
// push_tokens has no FK to sessions (deliberate, see lib/push.js), so a row bound to a session about to go
// is deleted FIRST, matching every other revocation path in routes/auth.js. Not strictly needed
// (activePushTokens already excludes it) but it keeps push_tokens from collecting rows nothing cleans up.
const purgeAge = sessionAgeCondition();
const purgeable = `last_seen_at < datetime('now', '-31 days') OR NOT (${purgeAge.sql})`;
const purgePushTokens = db.prepare(`DELETE FROM push_tokens WHERE session_id IN (SELECT id FROM sessions WHERE ${purgeable})`);
const purgeSessions = db.prepare(`DELETE FROM sessions WHERE ${purgeable}`);
export function purgeExpiredSessions() {
  purgePushTokens.run(...purgeAge.params);
  const { changes } = purgeSessions.run(...purgeAge.params);
  if (changes > 0) logger.info(`Purged ${changes} expired session(s).`);
  return changes;
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
