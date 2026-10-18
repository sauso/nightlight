import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as passwordHash from '../lib/passwordHash.js';
import jwt from 'jsonwebtoken';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import {
  requireAuth, requireAdmin, JWT_SECRET, SESSION_TOKEN_TTL_DAYS, sessionAgeCondition, isLiveSessionId,
} from '../middleware/auth.js';
import { isDemoModeActive } from '../middleware/demoMode.js';
import {
  generateSecret, keyUri, verifyToken, matchTokenStep, qrDataUrl, isLegacySecret,
  generateBackupCodes, verifyAndConsumeBackupCode, backupCodesRemaining,
} from '../lib/mfa.js';
import { normalizePhoto } from '../lib/photo.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const DEMO_READY_FILE = path.join(DATA_DIR, '.demo-ready');
const DEMO_GUEST_USERNAME = 'demo-guest';

function appName() {
  return db.prepare("SELECT app_name FROM settings WHERE id = 'app'").get()?.app_name || 'Nightlight';
}

// A short-lived, single-purpose token bridging the two login steps: it proves the password was just
// verified, but carries no session id, so it can never be used as an access token (requireAuth
// rejects any token without a live session). Exchanged at /login/mfa for a real session token.
function signMfaToken(userId) {
  return jwt.sign({ id: userId, purpose: 'mfa' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

// A short-lived, media-ONLY token for URLs the browser has to fetch itself and can't attach an
// Authorization header to: HLS playlists/segments, the talk WebSocket, and <img>/<video> snapshot/
// clip/timelapse loads. It carries the session id (so signing out or revoking that session kills it
// too), but purpose:'media' bars it from the JSON API (requireAuth rejects it) and it only rides in
// query params. So if one of these URLs ends up in a proxy log, browser history or Referer header,
// what leaks is a time-boxed, video-only capability — not the full-account session token.
// Since #562 a media token also stops when its SESSION's lifetime ends (SESSION_TTL_DAYS, checked in
// middleware/auth.js on every use), even if its own 12 hours have not run out.
const MEDIA_TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12h: covers a full overnight viewing session, tiny vs a 7-30 day session
function signMediaToken(userId, sessionId) {
  return jwt.sign({ id: userId, sid: sessionId, purpose: 'media' }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: MEDIA_TOKEN_TTL_SECONDS,
  });
}

// Login has no other protection against repeated guessing (no account lockout, no CAPTCHA) — this is
// the actual backstop against brute-forcing a password.
//
// ⚠️ ONE BUCKET FOR EVERY REMOTE USER WAS THE DEFECT (issue #248). The limiter keyed on `req.ip`, and
// behind the reverse proxy the README documents, `req.ip` is the PROXY. `index.js` trusts
// `X-Forwarded-For` only from loopback, and SWAG reaches Nightlight by its LAN IP — never loopback. So
// every remote user shared a single 20-per-15-minutes budget: one person mistyping their password a
// few times locked EVERYONE out of an app whose whole point is checking on a sleeping child, with no
// support desk to call. It also made the control weaker than it looked, since the attacker's budget
// and the household's were the same budget.
//
// Two keys now, and a request must pass both:
//
//   perAccount — IP + the route-specific account identity. The real brute-force control, and
//     what stops one person's typo (or one account being attacked) from locking anyone else out.
//     ⚠️ NOT account alone: that would let someone lock a specific user out on purpose by failing
//     authentication from elsewhere. Including the IP keeps that attacker confined to their own
//     bucket.
//   perClient — IP alone, deliberately loose. Caps a spray across many usernames from one source,
//     which per-account keying on its own would allow. Set high enough that a household sharing one
//     proxy IP cannot hit it by accident, which is the whole complaint above.
//
// Both degrade sensibly when TRUST_PROXY is left at its default: even with every remote user arriving
// as the same IP, they no longer share an account bucket. Setting TRUST_PROXY (see index.js) makes the
// per-client key meaningful as well.
const RATE_WINDOW_MS = 15 * 60 * 1000;

// Per account, per source. 20 was the previous whole-installation budget; it is now per route-specific
// account identity, so the strength against guessing ONE secret is unchanged and the collateral
// damage is gone.
const PER_ACCOUNT_LIMIT = 20;
// Per source, across all accounts. Five accounts' worth — loose enough to be invisible to a household
// behind one proxy IP, tight enough to stop an untargeted spray.
const PER_CLIENT_LIMIT = 100;

const limiterMessage = { error: 'Too many attempts - please wait a few minutes and try again.' };

// ⚠️ ipKeyGenerator, not `req.ip` directly: express-rate-limit v7+ requires it so IPv6 clients are
// keyed by subnet rather than by individual address, which a single client can rotate through freely.
const clientKey = (req) => ipKeyGenerator(req.ip);

// /login has no verified identity yet, so the submitted username is the account being attempted.
// Lower-casing keeps `Admin` and `admin` from becoming two budgets against one account.
function usernameKey(req) {
  return typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
}

// /login/mfa only: the account is inside its short-lived MFA token. DECODED, not verified — this
// only needs to produce a stable bucket, while the route itself verifies the token before checking a
// code. A forged token cannot buy guesses at the real code: a valid token always carries the same id,
// and the per-client limiter bounds forgery volume. Do not reuse this for routes without mfaToken.
function mfaTokenKey(req) {
  const mfaToken = typeof req.body?.mfaToken === 'string' ? req.body.mfaToken : '';
  if (!mfaToken) return '';
  const id = jwt.decode(mfaToken)?.id;
  if (id) return `mfa:${id}`;
  // An unparseable token gets its own bucket. A shared constant would let garbage tokens from one
  // source block a legitimate user's MFA completion — the same shared-bucket failure in miniature.
  return `mfa-bad:${createHash('sha256').update(mfaToken).digest('hex').slice(0, 16)}`;
}

// /me/password and /me/mfa/disable run requireAuth first, making the session user id their one
// trustworthy identity. Looking at client-submitted identity fields here would let a signed-in caller
// create a fresh bucket for every guess at their own password.
function sessionKey(req) {
  return req.user?.id || '';
}

function makeAccountLimiter(keyGen) {
  return rateLimit({
    windowMs: RATE_WINDOW_MS,
    limit: PER_ACCOUNT_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: limiterMessage,
    keyGenerator: (req) => `${clientKey(req)}|${keyGen(req)}`,
  });
}

const perClientLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  limit: PER_CLIENT_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage,
  keyGenerator: clientKey,
});

// Per USER, across every source (#550). The two limiters above both include the caller's IP, so a
// guesser spread over many addresses gets a fresh 20 guesses per address at a 6-digit code. This one is
// keyed by the account alone, so the guesses add up however many addresses they come from.
//
// ⚠️ THREE DECISIONS, each guarding against turning this into a way to lock the real user out (the
// objection that kept account lockout out of #248):
//   1. The key is the id inside a token whose SIGNATURE IS VERIFIED (purpose 'mfa'). mfaTokenKey above
//      only decodes, which is fine for a per-IP bucket but would let anyone who learns a user id burn
//      that user's budget with a forged token. An unverifiable token is skipped here (the handler
//      answers it with the usual 401) and is still counted by the per-IP limiters.
//   2. Only FAILED attempts count (skipSuccessfulRequests): the real user signing in correctly never
//      spends the budget, however often they do it.
//   3. The limit is deliberately well above the per-source one (20). A single source hits its own bucket
//      first, so this only ever engages for a DISTRIBUTED guesser. 30 per 15 min caps them at about
//      0.009% odds per window against a 6-digit code with three valid steps (30 x 3 / 1,000,000), which
//      is 2,880 guesses and about 0.86% odds a day (96 windows: 1 - (1 - 0.00009)^96).
// Residual cost, stated plainly (a known limit, in docs/mfa.md): someone who already holds the password
// (so can obtain an MFA token) can spend the budget from many addresses and block that user's second step,
// and can do it again in every window, so the block lasts as long as they keep doing it: waiting does
// not end it. Changing the password does (no new MFA token can be obtained; one already issued lives
// 5 minutes). An admin reset (DELETE /users/:id/mfa) or a restart empties the current bucket, but does not
// stop someone who still has the password from filling it again, and a reset ON ITS OWN is worse than
// nothing against them: it turns two-factor off, so the password alone signs in and they could enrol their
// own authenticator. Against a password holder, reset only together with (or after) a password change; the
// docs say so. Backup codes share the budget. That
// attacker has already beaten the first factor; without a per-account limit the 6-digit code was open to
// anyone with many addresses.
// The per-source limiters are untouched: nothing here loosens them.
const PER_USER_MFA_LIMIT = 30;

function verifiedMfaUserId(req) {
  const mfaToken = req.body?.mfaToken;
  if (typeof mfaToken !== 'string' || !mfaToken) return null;
  try {
    const payload = jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] });
    return payload.purpose === 'mfa' && typeof payload.id === 'string' && payload.id ? payload.id : null;
  } catch {
    return null;
  }
}

const mfaUserLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  limit: PER_USER_MFA_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage,
  skipSuccessfulRequests: true,
  skip: (req) => verifiedMfaUserId(req) === null,
  keyGenerator: (req) => `mfa-user:${verifiedMfaUserId(req)}`,
});

// Empties one user's per-user bucket. The admin MFA reset (DELETE /users/:id/mfa) calls it: the store is in
// memory, so clearing the row alone left a locked-out user blocked for the rest of the window although the
// docs said an admin reset clears it (review of #720, verified by running). The console script
// (scripts/reset-mfa.js) runs in its own process and cannot reach this store. Tests also use it, because
// the store is module-level and a test that exhausts one user's budget would otherwise 429 later tests.
export function resetMfaUserLimit(userId) {
  mfaUserLimiter.resetKey(`mfa-user:${userId}`);
}

const loginAccountLimiter = makeAccountLimiter(usernameKey);
const mfaAccountLimiter = makeAccountLimiter(mfaTokenKey);
const sessionAccountLimiter = makeAccountLimiter(sessionKey);

// Applied together, in this order, so a caller who has exhausted their account budget is told so
// rather than being charged against the looser client budget as well.
const loginLimiter = [loginAccountLimiter, perClientLimiter];
const mfaLimiter = [mfaAccountLimiter, mfaUserLimiter, perClientLimiter];
const sessionActionLimiter = [sessionAccountLimiter, perClientLimiter];

// First-run only, and it 400s once any user exists — so it cannot be used for guessing and does not
// belong on the login budget. Sharing it meant an install's very first action spent part of the
// household's login allowance (issue #248).
const setupLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage,
  keyGenerator: clientKey,
});

// Guest sign-in has no account secret to guess, so it gets an IP-only budget separate from the
// password/MFA limiters. It is skipped completely outside demo mode, preserving the endpoint's plain
// 404 fail-closed behaviour even if somebody probes it repeatedly on a normal installation.
const DEMO_GUEST_SIGN_INS_PER_WINDOW = 20;
const guestLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  limit: DEMO_GUEST_SIGN_INS_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !isDemoModeActive(),
  keyGenerator: clientKey,
  message: { error: 'Too many demo sign-ins - please wait a few minutes and try again.' },
});

function userCount() {
  return db.prepare('SELECT COUNT(*) as c FROM users').get().c;
}

// Thrown by keepingAnAdmin (never sent to a client directly) so its two call sites can tell "the
// mutation would leave no admin" apart from any other error and answer 409 instead of 500.
class LastAdminError extends Error {}

const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'");

// Issue #441: the sole admin could demote themselves via PUT (sending role=caregiver), and the very
// next request from ANYONE reads the new role straight from the database (middleware/auth.js, issue
// #261) — so the install lost anyone who could manage accounts or settings, immediately and with no
// way back (first-run /setup refuses once a user exists; see the recovery script
// backend/src/scripts/promote-admin.js). PUT is the real path here: DELETE /users/:id already blocks
// self-delete outright (checked in that route before this wrapper is ever reached), so wrapping it in
// keepingAnAdmin too is defence in depth against deleting a DIFFERENT admin down to zero, not against
// self-delete (see that route's own comment).
//
// This checks the admin count AFTER `mutate` runs, inside the same transaction, rather than before —
// a pre-check only rules out the one write path it was written against, while a post-condition holds
// for every way `mutate` could reduce the count, including ones added later. If it would leave zero
// admins, the whole transaction (including any session/push-token deletes `mutate` already made)
// rolls back, so a rejected change is truly a no-op, not a partial one.
//
// ⚠️ NOT a defence against concurrent requests racing each other — Node runs each request's
// middleware and handler synchronously, back to back, so two "concurrent" admin-demoting requests
// are already serialized before either reaches here; a check-then-write implementation would pass a
// concurrency test today for that reason alone. The post-condition-in-a-transaction shape is what
// keeps the invariant true if that ever stops being so (a future await inside the handler, a
// multi-process deployment) — the test suite's concurrency cases pin today's serialized behaviour,
// they cannot by themselves prove this design over a naive one, and the PR says so.
function keepingAnAdmin(mutate) {
  return db.transaction(() => {
    const out = mutate();
    if (adminCount.get().c === 0) throw new LastAdminError();
    return out;
  })();
}

const LAST_ADMIN_MESSAGE = 'This is the only admin account. Make another account an admin first, then change this one.';

function demoMaxGuests() {
  const configured = Number(process.env.DEMO_MAX_GUESTS ?? 25);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 25;
}

const activeGuestCount = db.prepare(
  // Sessions persist for weeks, but the auth middleware refreshes last_seen_at at most once a
  // minute. Two minutes therefore keeps an actively browsing guest counted while abandoned tabs
  // release their slot promptly; this is the exact demo image/seed contract, not session expiry.
  "SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND last_seen_at >= datetime('now', '-2 minutes')"
);
const demoGuestByUsername = db.prepare(
  "SELECT * FROM users WHERE username = ? AND role = 'admin' AND mfa_enabled = 0"
);

function demoIsFull() {
  const user = demoGuestByUsername.get(DEMO_GUEST_USERNAME);
  // Found by code review 2026-09-21: status must use the admission route's active-session rule,
  // otherwise the lobby sends a visitor into a predictable 429 instead of showing "full".
  return user ? activeGuestCount.get(user.id).c >= demoMaxGuests() : false;
}

function toPublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    first_name: u.first_name || null,
    last_name: u.last_name || null,
    created_at: u.created_at,
    mfa_enabled: !!u.mfa_enabled,
    photo: u.photo || null,
  };
}

// Lightweight device/browser description for the sessions list - not meant to be a
// precise parser, just enough for someone to recognize "oh, that's my old phone."
function describeDevice(userAgent) {
  if (!userAgent) return 'Unknown device';
  let os = 'Unknown OS';
  if (/iPhone/.test(userAgent)) os = 'iPhone';
  else if (/iPad/.test(userAgent)) os = 'iPad';
  else if (/Android/.test(userAgent)) os = 'Android';
  else if (/Mac OS X/.test(userAgent)) os = 'Mac';
  else if (/Windows/.test(userAgent)) os = 'Windows';
  else if (/Linux/.test(userAgent)) os = 'Linux';

  let browser = 'Unknown browser';
  if (/Edg\//.test(userAgent)) browser = 'Edge';
  else if (/OPR\//.test(userAgent)) browser = 'Opera';
  else if (/CriOS\//.test(userAgent) || (/Chrome\//.test(userAgent) && !/Chromium/.test(userAgent))) browser = 'Chrome';
  else if (/Firefox\//.test(userAgent)) browser = 'Firefox';
  else if (/Safari\//.test(userAgent) && !/Chrome/.test(userAgent)) browser = 'Safari';

  return `${browser} on ${os}`;
}

function createSession(userId, userAgent) {
  const id = uuid();
  db.prepare('INSERT INTO sessions (id, user_id, user_agent) VALUES (?, ?, ?)').run(id, userId, userAgent || null);
  return id;
}

// Every sign-in path (setup, login, the MFA step, a demo guest) issues its token here, so all of them
// get SESSION_TTL_DAYS. The token's `exp` and the row's created_at agree to within a second (see
// sessionAgeCondition in middleware/auth.js); the row is what ends a session early when the setting
// is lowered after the token was issued.
function sign(user, sessionId) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role, sid: sessionId }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${SESSION_TOKEN_TTL_DAYS}d`,
  });
}

// The two session LISTS show only sessions still within their lifetime (#562): a session past it is
// refused on its next request, so listing it as a signed-in device would be wrong for up to a day (until
// the daily purge deletes it). Same condition as the request check, from the same helper.
const listAge = sessionAgeCondition();
const ownSessions = db.prepare(`SELECT * FROM sessions WHERE user_id = ? AND ${listAge.sql} ORDER BY last_seen_at DESC`);
// Qualified: `users` has a created_at of its own.
const allAge = sessionAgeCondition('sessions');
const everySession = db.prepare(
  `SELECT sessions.*, users.username FROM sessions
   JOIN users ON users.id = sessions.user_id
   WHERE ${allAge.sql}
   ORDER BY last_seen_at DESC`
);

function toPublicSession(s, currentSessionId) {
  return {
    id: s.id,
    device: describeDevice(s.user_agent),
    created_at: s.created_at,
    last_seen_at: s.last_seen_at,
    is_current: s.id === currentSessionId,
    ...(s.username ? { username: s.username } : {}),
  };
}

// Tells the frontend whether first-run setup (creating the admin account) is needed.
router.get('/status', (req, res) => {
  const demo = isDemoModeActive()
    ? {
        endsAt: process.env.DEMO_ENDS_AT || null,
        lobbyUrl: process.env.DEMO_LOBBY_URL || null,
        // The launcher writes this only after seeding, fakecam publication and camera-path setup;
        // /api/health is intentionally too shallow to tell the lobby the demo is safe to enter.
        ready: fs.existsSync(DEMO_READY_FILE),
        full: demoIsFull(),
      }
    : false;
  res.json({ needsSetup: userCount() === 0, demo });
});

// Public demo sessions can only ever be minted for the one identity created by demo/seed.mjs. The
// request body is deliberately ignored: accepting even a user id here would turn an unauthenticated
// convenience endpoint into an identity selector. Outside exact DEMO_MODE=true, next() produces the
// same unremarkable 404 as a route that does not exist.
router.post('/guest', guestLimiter, (req, res, next) => {
  if (!isDemoModeActive()) return next();
  const user = demoGuestByUsername.get(DEMO_GUEST_USERNAME);
  if (!user) return res.status(404).json({ error: 'Demo guest is not available' });

  if (activeGuestCount.get(user.id).c >= demoMaxGuests()) {
    // 429 is intentional rather than 503: Cloudflare may replace a 5xx body, losing the calm,
    // actionable message the lobby and in-app auto-sign-in need to show.
    return res.status(429).json({ error: 'The demo is full - try again in a few minutes.' });
  }

  const sessionId = createSession(user.id, req.headers['user-agent']);
  res.json({ token: sign(user, sessionId), user: toPublicUser(user) });
});

// One-time: create the first admin account. Locked once any user exists.
router.post('/setup', setupLimiter, asyncHandler(async (req, res) => {
  if (userCount() > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  const { username, password, first_name, last_name } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  const id = uuid();
  const password_hash = await passwordHash.hash(password, 10);
  // The hash yields to the event loop (#548), so a second /setup can pass the check above while this one
  // hashes. It was impossible while the hash was synchronous. Re-check straight before the insert (no
  // await between here and the INSERT) so two simultaneous setups cannot both create an admin.
  if (userCount() > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, username, password_hash, 'admin', first_name?.trim() || null, last_name?.trim() || null);
  const user = { id, username, role: 'admin' };
  const sessionId = createSession(id, req.headers['user-agent']);
  res.json({
    token: sign(user, sessionId),
    user: toPublicUser({ ...user, first_name, last_name, created_at: null }),
  });
}));

// Compared against when the username doesn't exist, so both failure paths cost one
// bcrypt comparison - otherwise the "no such user" path returns measurably faster
// than "wrong password", letting response timing confirm which usernames exist.
// (Synchronous on purpose: runs once at start-up, not on a request path. Same cost factor as real hashes.)
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

// #548: every bcrypt call on a request path goes through lib/passwordHash.js, which runs bcryptjs in a
// worker thread. The sync compare blocked the whole event loop for ~82 ms per attempt (measured at cost
// 10), and the same loop reads the camera pipes and runs the HLS proxy. (bcryptjs's own async API would
// not help: it yields only after 100 ms of work. See passwordHash.js.) Same cost factor, same hashes,
// same dummy compare for an unknown user, same status codes and error text.
//
// The price of yielding is that a request is no longer atomic from "read the row" to "act on it": the
// row can change during the compare. Where that matters the code re-reads (login), or writes with a
// compare-and-swap (password change, backup codes, MFA enable), or does its checks after the await
// (setup, create). A signed-in route also re-checks its own session after the await (signInEnded below).
//
// signInEnded: true (and the 401 already sent) when the requesting session ended while the handler was
// awaiting bcrypt. requireAuth checked the session when the request arrived, but a sign-out, a revoke or
// another device's password change can delete it during the ~80 ms hash, and the write used to land anyway
// (review of #720, verified by running: session deleted at +112 ms, the password change from it written
// at +577 ms). Every signed-in route that awaits bcrypt and then writes calls this with NO await between
// the call and the write. Same liveness rule as the auth middleware (isLiveSessionId: the row exists and
// is within SESSION_TTL_DAYS), and the same 401 body: here the sign-in really is over, so the web app's
// "any 401 = signed out" handling is right (unlike the wrong-confirmation 400s of #697).
function signInEnded(req, res) {
  if (isLiveSessionId(req.user?.sid)) return false;
  res.status(401).json({ error: 'Invalid or expired session' });
  return true;
}

// The same re-check for the two admin routes that hash (POST /users, PUT /users/:id), plus the caller's
// LIVE role: requireAdmin read it when the request arrived, and an admin demoted while their own request was
// hashing could otherwise still write, including PUT /users/<self> {role:'admin'}, which undid the demotion
// (review of #720, verified by running). That is the self-re-promotion middleware/auth.js's #261 comment
// exists to prevent; it was impossible while these routes were synchronous. Same 403 body as requireAdmin.
// Called, like signInEnded, with NO await between the call and the write.
const callerRole = db.prepare('SELECT role FROM users WHERE id = ?');
function adminRightsEnded(req, res) {
  if (signInEnded(req, res)) return true;
  if (callerRole.get(req.user.id)?.role === 'admin') return false;
  res.status(403).json({ error: 'Admin access required' });
  return true;
}

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  const user =
    typeof username === 'string' ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  const hashToCheck = user ? user.password_hash : DUMMY_HASH;
  if (!(await passwordHash.compare(String(password || ''), hashToCheck)) || !user) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  // The compare yields, long enough for the row to change under it, so everything below decides from the
  // row as it is NOW (`current`), never from `user` as it was read before the await:
  //   * a password reset landed (it signs every other session out): no session under a credential that
  //     was just replaced; a user deleted meanwhile gets none either;
  //   * two-factor was turned on meanwhile: the CURRENT mfa_enabled decides. Branching on the stale value
  //     gave a password-only sign-in that started before /me/mfa/enable finished a full session, skipping
  //     the second factor (review of #720, verified by running).
  const current = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  if (!current || current.password_hash !== user.password_hash) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  // Password is correct. If the account has two-factor on, don't issue a session yet — hand back a
  // short-lived token the client exchanges at /login/mfa after the second step.
  if (current.mfa_enabled) {
    return res.json({ mfaRequired: true, mfaToken: signMfaToken(current.id) });
  }
  const sessionId = createSession(current.id, req.headers['user-agent']);
  res.json({ token: sign(current, sessionId), user: toPublicUser(current) });
}));

// Second login step for MFA accounts: verify the 6-digit authenticator code (or a one-time backup
// code) against the token from /login, then issue the real session. Rate-limited like /login.
router.post('/login/mfa', mfaLimiter, asyncHandler(async (req, res) => {
  const { mfaToken, code } = req.body || {};
  let payload;
  try {
    payload = jwt.verify(mfaToken, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'This verification step expired — please sign in again.' });
  }
  if (payload.purpose !== 'mfa') return res.status(401).json({ error: 'Invalid verification token' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.mfa_enabled) return res.status(401).json({ error: 'Invalid verification token' });

  // Try the authenticator code first, then fall back to consuming a one-time backup code.
  //
  // #550 replay: a correct code is accepted only if its time step is GREATER than the newest step
  // already accepted for this user, and the check and the record are ONE statement. The WHERE clause is
  // the check; `changes === 1` says this request won it. better-sqlite3 is synchronous, so two
  // simultaneous submissions of one code serialise on that statement and exactly one changes a row.
  // (A read-then-write pair would not be safe the moment anything between them awaits.)
  // A replayed code falls through to the backup-code path and ends in the same 401 'Incorrect code' as a
  // wrong one, after the same work, so neither the status, the text nor the timing says "this was a real
  // code". The step is claimed before the session is minted: a code is spent even if the sign-in then
  // fails further down, which is the safe direction.
  let ok = false;
  const step = matchTokenStep(user.mfa_secret, code);
  if (step !== null) {
    ok = db
      .prepare('UPDATE users SET mfa_last_step = ? WHERE id = ? AND (mfa_last_step IS NULL OR mfa_last_step < ?)')
      .run(step, user.id, step).changes === 1;
  }
  if (!ok) {
    const result = await verifyAndConsumeBackupCode(user.mfa_backup_codes, code);
    if (result.ok) {
      // Compare-and-swap on the list that was read: the async compares above let another submission of
      // the same backup code finish first. `IS ?` (not `= ?`) so a NULL list still compares equal.
      ok = db
        .prepare('UPDATE users SET mfa_backup_codes = ? WHERE id = ? AND mfa_backup_codes IS ?')
        .run(result.hashesJson, user.id, user.mfa_backup_codes ?? null).changes === 1;
    }
  }
  if (!ok) return res.status(401).json({ error: 'Incorrect code' });

  const sessionId = createSession(user.id, req.headers['user-agent']);
  res.json({ token: sign(user, sessionId), user: toPublicUser(user) });
}));

// Ends just the current session - the token stops working on its very next use,
// rather than remaining valid (just unused) until it naturally expires.
//
// Also stops this device's push registration, if it has one - a signed-out device must not keep
// receiving alerts. Run before the session delete so a caller reading this in order sees cause
// before effect (activePushTokens() filters live regardless of ordering, but the explicit delete
// here matches the same order used at every other revocation site below).
router.post('/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM push_tokens WHERE session_id = ?').run(req.user.sid);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.user.sid);
  res.status(204).end();
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(toPublicUser(user));
});

// Mint a media token for the current session (see signMediaToken). requireAuth guarantees a real
// session token in the Authorization header; the media token inherits that session's id, so it's
// revoked the moment the session is. The client refreshes it before it expires.
router.post('/media-token', requireAuth, (req, res) => {
  res.json({ token: signMediaToken(req.user.id, req.user.sid), expires_in: MEDIA_TOKEN_TTL_SECONDS });
});

// Self-service: your own active sessions (other devices/browsers you're logged in on).
router.get('/sessions', requireAuth, (req, res) => {
  const sessions = ownSessions.all(req.user.id, ...listAge.params);
  res.json(sessions.map((s) => toPublicSession(s, req.user.sid)));
});

// Admin: every active session across every account - lets an admin revoke a
// caregiver's access on a specific device without deleting their whole account.
router.get('/sessions/all', requireAuth, requireAdmin, (req, res) => {
  const sessions = everySession.all(...allAge.params);
  res.json(sessions.map((s) => toPublicSession(s, req.user.sid)));
});

// Terminate a session - your own, or (admins only) anyone's.
router.delete('/sessions/:id', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not allowed' });
  }
  // Same reasoning as /logout above - ending a session (here, possibly someone ELSE'S device)
  // must also stop that device's push registration.
  db.prepare('DELETE FROM push_tokens WHERE session_id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Admin: manage caregiver accounts.
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  res.json(users.map(toPublicUser));
});

router.post('/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { username, password, role, first_name, last_name } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  // Hashed BEFORE the username-taken check, not after: the async hash yields, and a check made before it
  // would let two simultaneous creates of one name both pass and the second die on the UNIQUE index (500).
  // Everything from the check to the INSERT stays synchronous.
  const password_hash = await passwordHash.hash(password, 10);
  if (adminRightsEnded(req, res)) return;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'That username is already taken' });
  let photo;
  try { photo = normalizePhoto(req.body?.photo, null); } catch (e) { return res.status(400).json({ error: e.message }); }
  const id = uuid();
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, first_name, last_name, photo) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    username,
    password_hash,
    role === 'admin' ? 'admin' : 'caregiver',
    first_name?.trim() || null,
    last_name?.trim() || null,
    photo
  );
  res.status(201).json(toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

// Both password write paths (PUT /users/:id with a password, PUT /me/password) also discard a PENDING two-factor
// set-up (review of #765). A password change is the move someone makes when a signed-in device is lost or no
// longer trusted (see /me/password), and that device may have read the pending key, so the set-up must not
// survive into the new password: the owner starts it again. `AND mfa_enabled = 0` is the whole safety of this
// statement: an account whose two-factor is ON keeps its secret (clearing it would leave mfa_enabled = 1 with no
// secret, and every sign-in would fail at the code step); that secret is guarded by the second factor itself.
// (A pending secret that is cleared during an in-flight resume is caught by the set-up route's re-read.)
const discardPendingSetup = db.prepare('UPDATE users SET mfa_secret = NULL, mfa_last_step = NULL WHERE id = ? AND mfa_enabled = 0');

router.put('/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  // Hash first (#548), so every read-validate-write step below stays synchronous, as it was. Only for a
  // password that will pass the length check below; the rest fall through to the same 400/404 as before.
  // Hashing for a user that turns out not to exist is wasted work, bounded by the admin gate.
  const submittedPassword = req.body?.password;
  const newHash =
    typeof submittedPassword === 'string' && submittedPassword.length >= 8
      ? await passwordHash.hash(submittedPassword, 10)
      : null;
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  const { username, role, first_name, last_name, password } = req.body || {};
  if (username !== undefined && !username.trim()) {
    return res.status(400).json({ error: 'Username cannot be empty' });
  }
  if (username && username !== existing.username) {
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.params.id);
    if (taken) return res.status(400).json({ error: 'That username is already taken' });
  }
  if (password !== undefined && password !== '' && password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  // (`newHash ?? await` only reaches the await for a non-string truthy password, where bcrypt throws as
  // it always did, before any write.)
  const password_hash = password ? (newHash ?? (await passwordHash.hash(password, 10))) : existing.password_hash;
  let photo;
  try { photo = normalizePhoto(req.body?.photo, existing.photo); } catch (e) { return res.status(400).json({ error: e.message }); }
  // After the last await above, before any write (see adminRightsEnded).
  if (adminRightsEnded(req, res)) return;

  // #441: the password-driven deletes below AND the role UPDATE both run inside keepingAnAdmin, so a
  // demotion that would leave the install with no admin rolls back BOTH — otherwise a rejected
  // request could still have quietly deleted the other sessions/tokens (see LastAdminError).
  try {
    keepingAnAdmin(() => {
      // A password reset means the old credential can no longer be trusted - any session
      // opened under it shouldn't outlive it. Spares only the requesting admin's own
      // current session, for the case where they're resetting their own password.
      //
      // The push_tokens cleanup runs FIRST, as a subquery over the sessions about to be deleted - it
      // has to see them before the next statement removes them. Same reasoning as /logout: an ended
      // session must also stop that device's push registration, not just its API access.
      if (password) {
        db.prepare(
          'DELETE FROM push_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ? AND id != ?)'
        ).run(req.params.id, req.user.sid);
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.params.id, req.user.sid);
      }

      db.prepare(
        'UPDATE users SET username = ?, role = ?, first_name = ?, last_name = ?, password_hash = ?, photo = ? WHERE id = ?'
      ).run(
        username?.trim() || existing.username,
        role === 'admin' || role === 'caregiver' ? role : existing.role,
        first_name !== undefined ? first_name?.trim() || null : existing.first_name,
        last_name !== undefined ? last_name?.trim() || null : existing.last_name,
        password_hash,
        photo,
        req.params.id
      );
      // Inside keepingAnAdmin like the session deletes above, so a refused demotion rolls this back too (#441).
      if (password) discardPendingSetup.run(req.params.id);
    });
  } catch (e) {
    if (e instanceof LastAdminError) return res.status(409).json({ error: LAST_ADMIN_MESSAGE });
    throw e;
  }
  res.json(toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
}));

// Self-service: any logged-in user can change their own display name (first/last). The
// username (login id) is deliberately not editable here — that stays an admin action.
router.put('/me', requireAuth, (req, res) => {
  const { first_name, last_name } = req.body || {};
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  let photo;
  try { photo = normalizePhoto(req.body?.photo, existing.photo); } catch (e) { return res.status(400).json({ error: e.message }); }
  db.prepare('UPDATE users SET first_name = ?, last_name = ?, photo = ? WHERE id = ?').run(
    first_name !== undefined ? first_name?.trim() || null : existing.first_name,
    last_name !== undefined ? last_name?.trim() || null : existing.last_name,
    photo,
    req.user.id
  );
  res.json(toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)));
});

// Self-service: any logged-in user can change their own password, given their
// current one - unlike the admin reset above, this doesn't skip verification.
router.put('/me/password', requireAuth, sessionActionLimiter, asyncHandler(async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !(await passwordHash.compare(current_password || '', user.password_hash))) {
    // 400, NOT 401 (#697). frontend/src/lib/api.js treats ANY 401 as "this sign-in is over": it clears the
    // token and sends the person to the sign-in form. Here the sign-in is fine (requireAuth just passed) and
    // only the typed confirmation is wrong, so a typo must show a message next to the field, not sign them out.
    // 400 matches the other validation errors on this route; 403 is left to role gates and the demo marker.
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const password_hash = await passwordHash.hash(new_password, 10);
  if (signInEnded(req, res)) return;
  // Compare-and-swap on the hash that was verified (#548): both bcrypt calls yield, so a second change
  // could have landed in between. Without this, two simultaneous changes would both "verify" the same
  // current password and the later one would silently win. Losing the race from the SAME device (one
  // session) gets the same 400 as a wrong current password, which is what a serial second request would
  // have received. 400, NOT 401, for the #697 reason above: this request's sign-in is still fine, and a 401
  // would sign the person out. Losing it from ANOTHER device ends at signInEnded above instead, with a 401
  // that is correct: the winner has just signed every other session out, the loser's included.
  const swapped = db
    .prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?')
    .run(password_hash, req.user.id, user.password_hash);
  if (swapped.changes !== 1) return res.status(400).json({ error: 'Current password is incorrect' });
  // Sign every other device out. Changing your password is exactly the move someone
  // makes when a logged-in device is lost or no longer trusted - leaving those
  // sessions valid for the rest of their lifetime (SESSION_TTL_DAYS) would defeat the point.
  //
  // Same push_tokens cleanup, same reasoning and ordering, as the admin reset path above.
  db.prepare(
    'DELETE FROM push_tokens WHERE session_id IN (SELECT id FROM sessions WHERE user_id = ? AND id != ?)'
  ).run(req.user.id, req.user.sid);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.user.sid);
  // And a pending two-factor set-up, for the same reason (see discardPendingSetup above PUT /users/:id).
  discardPendingSetup.run(req.user.id);
  res.json({ ok: true });
}));

// --- Two-factor auth (TOTP), self-service ---

// Current MFA state for the signed-in user (drives the Account toggle).
router.get('/me/mfa', requireAuth, (req, res) => {
  const u = db.prepare('SELECT mfa_enabled, mfa_secret, mfa_backup_codes FROM users WHERE id = ?').get(req.user.id);
  res.json({
    enabled: !!u?.mfa_enabled,
    backup_codes_remaining: backupCodesRemaining(u?.mfa_backup_codes),
    // True for an account still on a pre-0.26.0 (80-bit) secret. It keeps working — this is a
    // prompt to re-enrol into a stronger one when convenient, not a lockout. See lib/mfa.js.
    needs_reenrolment: !!u?.mfa_enabled && isLegacySecret(u?.mfa_secret),
    // A set-up was begun and not finished (#765), so "Continue set-up" can offer the same QR again after a
    // reload. A boolean ONLY: the secret itself is never in this response. Same rule as the set-up route
    // (resumablePendingSecret), so the card never offers to continue a set-up the server would not continue.
    setup_pending: !!resumablePendingSecret(u),
  });
});

// The pending secret a set-up may be RESUMED with (#765): two-factor off, a secret stored, and not a legacy
// (pre-0.26.0, 80-bit) one. A legacy pending secret is never handed back (review of #765): continuing it would
// keep a weak key alive through the very set-up that should replace it. The next set-up discards it and makes a
// 160-bit one instead.
function resumablePendingSecret(u) {
  return u && !u.mfa_enabled && u.mfa_secret && !isLegacySecret(u.mfa_secret) ? u.mfa_secret : null;
}

// The set-up route's answers after an await (the first check keeps its literal text, the same words).
const SETUP_ALREADY_ON = 'Two-factor is already on. Turn it off first to re-enrol.';
// The answer when the row changed under an in-flight set-up (see the end of the route). Not "already on": the
// account is still off, so that text would send the person looking for a switch that is not there.
const SETUP_CHANGED_MEANWHILE = 'The set-up was changed meanwhile, on this or another device. Try again.';
// The same text /me/mfa/disable answers for a wrong confirmation password, on purpose (one message for one
// mistake). Held in a constant rather than repeated as a literal line.
const WRONG_CONFIRMATION_PASSWORD = 'Password is incorrect';

// Begin enrolment: generate + stash a secret (still disabled) and return the QR + manual key. The
// secret only becomes active once a code is confirmed at /me/mfa/enable.
//
// IDEMPOTENT while an enrolment is pending (#765). On a phone the person leaves for the authenticator app
// and the page reloads on return (or the browser discards the tab), losing the secret from the page; asking
// for set-up again used to mint a NEW secret and overwrite the pending one, so the entry they had just added
// to their authenticator held a secret the server had already replaced and its codes never confirmed. Now a
// pending secret (two-factor off, secret stored, not legacy) is handed back unchanged, with `resumed: true`,
// and mfa_last_step is left alone. It is rotated only when none is pending or the body says `restart: true`
// (the explicit "Start over"). The enable route's secret-bound compare-and-set is untouched, so an enable that
// began before a start-over still fails.
//
// EVERY CALL NEEDS THE ACCOUNT PASSWORD: a first start, a resume and a restart alike (review of #765, owner's
// decision). Idempotency is what made this necessary. Once a pending secret can be handed back, any live session
// of the account (a borrowed unlocked phone, a forgotten signed-in browser) could either READ it (call set-up and
// get the owner's pending key) or PLANT one (start or restart, so the secret is one it knows, and wait: the
// owner's "Continue set-up" then shows that planted key, the owner scans it and confirms). Either way that device
// can later make valid codes for the second factor that was meant to stop it. Before #765 neither worked, because
// the owner's next set-up always replaced whatever was pending; a password on the resume alone closed the read
// but not the plant (verified in review). Turning two-factor off asks for the password for the same
// borrowed-device reason. Wrong or missing password: 400, not 401 (#697: a mistyped confirmation must not sign the
// person out), and the secret is in no error. A missing password used to be accepted: an API client calling
// set-up now has to send one.
//
// sessionActionLimiter: the same limiter instances as /me/password and /me/mfa/disable, so guessing this
// account's password has ONE budget per source and account whichever of the three routes is used. Every set-up
// call is counted (each one checks the password), including the "already on" refusal, as disable counts its own.
router.post('/me/mfa/setup', requireAuth, sessionActionLimiter, asyncHandler(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.mfa_enabled) return res.status(400).json({ error: 'Two-factor is already on. Turn it off first to re-enrol.' });
  // The same compare /me/mfa/disable uses (the worker-thread bcrypt of #548).
  if (!(await passwordHash.compare(String(req.body?.password || ''), user.password_hash))) {
    return res.status(400).json({ error: WRONG_CONFIRMATION_PASSWORD });
  }
  // After the await and before the write below (see signInEnded).
  if (signInEnded(req, res)) return;
  // Strictly boolean true: a string "false" or 1 from a sloppy client must not rotate (or fail to) by accident.
  const restart = req.body?.restart === true;
  // Decided from `user`, read before the compare; anything that changed meanwhile is caught below, by the
  // compare-and-set on a rotation and by the re-read before the answer on a resume.
  const resume = !!resumablePendingSecret(user) && !restart;
  let secret;
  if (resume) {
    secret = user.mfa_secret;
  } else {
    secret = generateSecret();
    // Compare-and-set on `mfa_enabled = 0`: the password check above yields, and two-factor may have been
    // switched on meanwhile. An unconditional write would replace the ACTIVE secret, and the owner's
    // authenticator would then fail every sign-in at the code step (a lockout); this refuses instead.
    const stored = db
      .prepare('UPDATE users SET mfa_secret = ?, mfa_last_step = NULL WHERE id = ? AND mfa_enabled = 0')
      .run(secret, user.id);
    if (stored.changes !== 1) return res.status(400).json({ error: SETUP_ALREADY_ON });
  }
  const uri = keyUri(user.username, secret, appName());
  const qr = await qrDataUrl(uri);
  // Decided from the row as it is NOW, after the last await (the password check, the QR), with no await between
  // these checks and the answer (review of #765, Codex). Meanwhile /me/mfa/enable may have switched two-factor ON
  // for this very secret: handing it out then gives the caller an ACTIVE second factor. Or a restart, turning
  // two-factor off, a reset or a password change replaced or cleared it: handing out the stale secret gives an
  // authenticator entry that can never confirm, the bug #765 fixed. The session is re-checked too (signInEnded):
  // a device signed out during the awaits gets no secret.
  if (signInEnded(req, res)) return;
  const now = db.prepare('SELECT mfa_enabled, mfa_secret FROM users WHERE id = ?').get(user.id);
  if (!now || now.mfa_enabled) return res.status(400).json({ error: SETUP_ALREADY_ON });
  if (now.mfa_secret !== secret) return res.status(400).json({ error: SETUP_CHANGED_MEANWHILE });
  res.json(resume ? { secret, otpauth_uri: uri, qr, resumed: true } : { secret, otpauth_uri: uri, qr });
}));

// Per-user single flight for /me/mfa/enable (review of #720, verified by running). generateBackupCodes() is
// ten cost-10 hashes, about 0.8 s of the one worker's time, and this route has no attempt limiter, so every
// simultaneous enable for one account queued ten more hashes ahead of everyone's sign-ins, only for the
// compare-and-set below to refuse all but one of them. A second enable for a user while one is in flight is
// now refused BEFORE any hashing, with the same 400 the losing compare-and-set used to give. In memory, per
// process: the app is one process, and the compare-and-set still guards the write if that ever changes.
const mfaEnableInFlight = new Set();

// Confirm a code against the pending secret; on success, enable MFA and return one-time backup
// codes to show the user once (only their hashes are kept).
router.post('/me/mfa/enable', requireAuth, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.mfa_enabled) return res.status(400).json({ error: 'Two-factor is already on.' });
  if (!user.mfa_secret) return res.status(400).json({ error: 'Start setup first.' });
  if (!verifyToken(user.mfa_secret, code)) {
    return res.status(400).json({ error: "That code didn't match — check your authenticator app and try again." });
  }
  // Checked and taken with no await in between, released whatever happens (finally).
  if (mfaEnableInFlight.has(user.id)) return res.status(400).json({ error: 'Two-factor is already on.' });
  mfaEnableInFlight.add(user.id);
  try {
    const { codes, hashesJson } = await generateBackupCodes();
    if (signInEnded(req, res)) return;
    // The hashing above yields (#548), so the row may have changed meanwhile. The write is a compare-and-set
    // on BOTH things this request checked: MFA still off, and the pending secret still the one the code was
    // verified against. Without the secret, a /me/mfa/setup that stored a new secret during the hashing let
    // this request switch two-factor on for a secret no code was ever checked against (review of #720,
    // verified by running), and the person's app, set up from the old QR, would then fail every sign-in.
    // With the single flight above no other enable for this user can be in flight, so a lost write means
    // the pending secret changed or was cleared: the user has to scan the current set-up, hence 'Start
    // setup first.' (`IS ?`, not `= ?`, so a secret cleared to NULL also fails the compare.)
    const enabled = db
      .prepare('UPDATE users SET mfa_enabled = 1, mfa_backup_codes = ? WHERE id = ? AND mfa_enabled = 0 AND mfa_secret IS ?')
      .run(hashesJson, user.id, user.mfa_secret);
    if (enabled.changes !== 1) return res.status(400).json({ error: 'Start setup first.' });
    res.json({ backup_codes: codes });
  } finally {
    mfaEnableInFlight.delete(user.id);
  }
}));

// Turn MFA off. Requires the account password (not just the live session) so a borrowed unlocked
// device can't quietly strip someone's second factor.
router.post('/me/mfa/disable', requireAuth, sessionActionLimiter, asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !(await passwordHash.compare(String(password || ''), user.password_hash))) {
    // 400 not 401, same reason as /me/password above (#697): a mistyped confirmation must not sign the person out.
    return res.status(400).json({ error: 'Password is incorrect' });
  }
  if (signInEnded(req, res)) return;
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL, mfa_last_step = NULL WHERE id = ?').run(user.id);
  res.json({ ok: true });
}));

// Admin: clear a locked-out user's MFA (lost authenticator + backup codes). The self-lockout case
// for the last admin is handled out-of-band by the console reset script (see docs/mfa.md).
router.delete('/users/:id/mfa', requireAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL, mfa_last_step = NULL WHERE id = ?').run(req.params.id);
  // And the in-memory per-user second-step budget, so a user locked out by it can sign in again once they
  // re-enrol (see resetMfaUserLimit).
  resetMfaUserLimit(req.params.id);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't remove your own account" });
  }
  // #441, defence in depth: today this can never actually fire. The self-delete guard above and the
  // fact that requireAdmin re-checks the LIVE role on every request (issue #261) already mean the
  // caller was an admin at the moment of this synchronous, non-`await`ing handler — deleting anyone
  // else can only reduce a count of >=2 admins, or delete a caregiver and not touch the count at all.
  // It costs one wrapper to hold the same invariant as PUT /users/:id, and it stops being a no-op the
  // moment this route (or anything reachable from it) grows an `await` before the deletes, which
  // would let another request interleave.
  try {
    keepingAnAdmin(() => {
      // push_tokens.user_id has no FK/cascade (GHSA-q98f) — a removed caregiver's device otherwise kept
      // receiving alerts, including camera-snapshot image links, indefinitely. sendToAll (lib/push.js)
      // also filters its recipient query against live users as defense in depth, so a row missed here (or
      // by a future caller of this route's logic) still can't be delivered to — but the row should still
      // be deleted, not just excluded, since a stale row otherwise makes push.js's recipient count read
      // wrong forever.
      db.prepare('DELETE FROM push_tokens WHERE user_id = ?').run(req.params.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    });
  } catch (e) {
    if (e instanceof LastAdminError) return res.status(409).json({ error: LAST_ADMIN_MESSAGE });
    throw e;
  }
  res.status(204).end();
});

export default router;
