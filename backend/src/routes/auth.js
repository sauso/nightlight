import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as passwordHash from '../lib/passwordHash.js';
import jwt from 'jsonwebtoken';
import rateLimit, { ipKeyGenerator, MemoryStore } from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
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
import { createAccountThrottle } from '../lib/accountThrottle.js';
import { isLoopbackAddress, isLoopbackExposed } from '../lib/loopbackExposure.js';
import { clientBucketKey } from '../lib/clientBucket.js';

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
//   perAccount — client bucket + the route-specific account identity. The real brute-force control, and
//     what stops one person's typo (or one account being attacked) from locking anyone else out.
//     ⚠️ NOT account alone: that would let someone lock a specific user out on purpose by failing
//     authentication from elsewhere. The source address (or bounded Tailscale identity slot while
//     the daemon is attached) keeps that attacker confined to their own bucket.
//   perClient — IP alone, deliberately loose. Caps a spray across many usernames from one source,
//     which per-account keying on its own would allow. Set high enough that a household sharing one
//     proxy IP cannot hit it by accident, which is the whole complaint above.
//
// With TRUST_PROXY at its default, remote users behind a normal proxy still share its address for
// both limits. While the tunnel daemon is attached, Serve's identity separates the account buckets;
// the per-client key deliberately remains the shared tunnel address. Setting TRUST_PROXY (see
// index.js) makes source addresses meaningful for a normal reverse proxy.
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
  // #961: only these per-account limits use a peer bucket. Keep the per-client, setup and guest
  // ceilings on the shared socket address, so a forged identity cannot multiply the 100-per-window
  // aggregate. /login also has loginThrottle; /me/password, /me/mfa/setup and /me/mfa/disable have
  // sessionThrottle; valid-token /login/mfa has mfaUserLimiter; /me/mfa/enable has its own per-user
  // wrong-code limit and per-secret cancel count. Invalid MFA tokens fall back to perClientLimiter;
  // setup and guest keep their own shared-address limits (unchanged).
  return rateLimit({
    windowMs: RATE_WINDOW_MS,
    limit: PER_ACCOUNT_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: limiterMessage,
    keyGenerator: (req) => `${clientBucketKey(req)}|${keyGen(req)}`,
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

// Rate-limiting the two-factor CONFIRMATION route (POST /me/mfa/enable). The route takes a signed-in session
// (requireAuth) but not the password, so it now limits wrong codes, like the other confirmation routes; a device
// without the password gets at most 10 guesses at any one key. Since #765 set-up returns the same pending secret
// when asked again, so the secret does not change between attempts: the bound follows the secret and the account,
// not the request. Two bounds:
//
//   1. MFA_ENABLE_MAX_WRONG_CODES (10) wrong codes cancel the pending set-up (the counter below; the cancel is in
//      the route). Set-up needs the PASSWORD on every call (#765), so a device without it cannot start another:
//      its guesses against any one secret are capped at 10, however long it waits, however many addresses it uses
//      and however many requests it sends at once. 10 guesses x 3 valid steps / 1,000,000 = 0.003%, once.
//      10 is a judgement, not a measurement: a person mistyping a code, or held up by a phone clock that is off,
//      starts over or asks for help long before 10, while 10 guesses at one key give the 0.003% above.
//   2. mfaEnableUserLimiter: 30 WRONG codes per 15 minutes per user, whatever the source address. 30 mirrors
//      PER_USER_MFA_LIMIT (#550), also a judgement. The cap above bounds guesses per KEY; this bounds them across
//      keys: each time the owner starts over (with the password), a device without the password gets 10 more
//      against the new key, so this is what caps such a device at 30 per window in all. It is also the per-account
//      bound for someone who holds the password and mints a new secret every 9 wrong codes. A SEPARATE bucket from
//      mfaUserLimiter (the sign-in second step): a pending set-up's failures must not carry over into the owner's
//      first sign-in with the new authenticator.
//
// ⚠️ ONLY A WRONG CODE COUNTS, for both (the handler sets res.locals.mfaWrongCode; plan review, Codex and Opus).
// Counting every 400 was the first design and had a hole: a password-less device cancels the set-up with 10 wrong
// codes, then fills the per-user bucket with "Start setup first." refusals, which cost it no guess, and so stops
// the owner's next set-up from confirming, again in every window. A refusal that needed no guess (nothing pending,
// "already on") and a correct code spend nothing. The answer that cancels the set-up IS a wrong code and counts.
// The 429 itself counts as nothing (the window is fixed, so hammering cannot extend it). The limiter counts a
// request when it arrives and gives it back when it finishes, so 30 requests in flight AT ONCE (even refusals that
// spend nothing) can make a right code that arrives among them a 429 until they finish (review, Codex; in the docs).
//
// NOT on this route, on purpose: the per-source + account limiter and perClientLimiter that set-up, turning
// two-factor off and changing the password have. The cap of 10 always fires before a per-source 20 could, so that
// limiter would add only lock-out surface; perClientLimiter counts successes too and would tie confirming two-factor
// to the budget a household behind one proxy address shares (Opus). Nothing here is keyed on an address, so a
// household behind one proxy IP shares no bucket on this route: each account has its own.
//
// Known limits (docs/mfa.md): the counter and the bucket are in memory, so a restart of the container resets both
// (an operator-only event, as for every limiter here; the app is one process). A device signed in to the account
// without the password can cancel the owner's pending set-up (10 wrong codes) each time the owner starts over, and
// across those start-overs use up the 30, after which even the right code is refused (429) for the rest of the window
// (review, Opus, verified by running: after three start-overs). It blocks nothing else. Signing that device out
// does not empty the bucket (the window has to run out, up to 15 minutes); changing the password does, at once
// (resetMfaEnableLimit below), in the same step that discards the pending set-up and signs the other devices out.
const MFA_ENABLE_MAX_WRONG_CODES = 10;
const PER_USER_MFA_ENABLE_LIMIT = 30;

const mfaEnableUserLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  limit: PER_USER_MFA_ENABLE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage,
  // Mounted AFTER requireAuth, so this is the id of a VERIFIED session's user: a client can neither mint a fresh
  // bucket for itself nor name someone else's.
  keyGenerator: (req) => `mfa-enable-user:${req.user.id}`,
  // "Successful" here means "not a wrong code" (see above): everything else is taken back off the count.
  requestWasSuccessful: (req, res) => !res.locals.mfaWrongCode,
  skipSuccessfulRequests: true,
});

// Wrong codes against the PENDING secret, per user: userId -> { secret, wrong }. `secret` is the pending secret the
// count belongs to, compared as-is. It used to be a sha256 prefix, "so the plaintext is not held twice" (#772), but
// that bought nothing: the plaintext is in the users row (mfa_secret) and in every request's `user` object already,
// and CodeQL (js/insufficient-password-hash, alert #27) read the hash of a secret as password hashing (#777). What is
// held here is a pending, not yet confirmed seed, one per account at most, deleted when it is confirmed, cancelled or
// rotated away, and when two-factor is turned off or reset; a second long-lived plaintext copy (review of #778).
// A different secret (a start over, a new set-up after a cancel) starts again from 0; a resume (#765: the same secret returned)
// does NOT, so reloading the set-up page part-way through does not start the count again. The entry is deleted on a
// successful confirmation and AFTER a cancel's write has succeeded (the order matters: see the cancel in the route).
// One whose secret went away some other way (turned off) is replaced by the next wrong code against the new secret;
// a password change, an admin two-factor reset and removing the account delete it (resetMfaEnableLimit). At most
// one small entry per account.
const mfaEnableWrongCodes = new Map();

// Empties the confirmation route's state for one user: its per-user bucket and its wrong-code counter. Called by
// both password-change paths (PUT /me/password, and PUT /users/:id with a password), by the admin two-factor reset
// (through resetMfaUserLimit) and by removing the account. Why a password change may: only the password holder or
// an admin can make one, and the same step discards the pending set-up and signs the other devices out, so the
// device that used up the budget is gone with it (review, Opus: before this the owner stayed blocked for the rest of
// the window). ⚠️ It does NOT touch mfaUserLimiter, the sign-in second step's bucket: emptying that on a password
// change would hand someone who holds the password (the very person a password change is aimed at) a fresh 30
// guesses at the second factor, weakening #550.
function resetMfaEnableLimit(userId) {
  mfaEnableUserLimiter.resetKey(`mfa-enable-user:${userId}`);
  mfaEnableWrongCodes.delete(userId);
}

// Empties one user's per-user buckets: the sign-in second step's and the confirmation route's, and the confirmation
// route's wrong-code counter. The admin MFA reset (DELETE /users/:id/mfa) calls it: the store is in
// memory, so clearing the row alone left a locked-out user blocked for the rest of the window although the
// docs said an admin reset clears it (review of #720, verified by running). The console script
// (scripts/reset-mfa.js) runs in its own process and cannot reach this store. Tests also use it, because
// the store is module-level and a test that exhausts one user's budget would otherwise 429 later tests.
export function resetMfaUserLimit(userId) {
  mfaUserLimiter.resetKey(`mfa-user:${userId}`);
  // The reset also clears any pending set-up (mfa_secret = NULL), so its budget goes with it.
  resetMfaEnableLimit(userId);
}

const loginAccountLimiter = makeAccountLimiter(usernameKey);
const mfaAccountLimiter = makeAccountLimiter(mfaTokenKey);
const sessionAccountLimiter = makeAccountLimiter(sessionKey);

// Applied together, in this order, so a caller who has exhausted their account budget is told so
// rather than being charged against the looser client budget as well.
const loginLimiter = [loginAccountLimiter, perClientLimiter];
const mfaLimiter = [mfaAccountLimiter, mfaUserLimiter, perClientLimiter];
const sessionActionLimiter = [sessionAccountLimiter, perClientLimiter];

// Per ACCOUNT, whatever the source address, for every route that CHECKS A PASSWORD (#553). Every limiter above
// includes the caller's IP, and `X-Forwarded-For` is trusted from loopback by default, so a process on 127.0.0.1
// could name a fresh address per guess and never meet a limit. lib/accountThrottle.js carries the why, the numbers
// and the trade (an account-only key lets someone slow a person's own sign-in on purpose, which #248 refused; the
// owner accepted it here, for the password step only, with a delay that grows to 15 minutes and never a hard
// lock-out). It engages at 30 failures, above the 20 a single source is held to, so one honest device never gets
// there: it only meets a guesser spread over many (or forged) addresses.
//   * loginThrottle: keyed by the submitted username EXACTLY AS SUBMITTED, the string the lookup below uses
//     (`WHERE username = ?`: exact and case-sensitive), and the SAME for a name that does not exist (an unknown name
//     is counted and answered exactly like a known one: no way to tell them apart). ⚠️ NOT trimmed or lower-cased
//     like usernameKey: the per-source limiters fold case to stop a retyped name buying a second budget, but
//     here one key must be ONE account. `alice` and `ALICE` are two rows (the column is UNIQUE, not NOCASE), and
//     folding them let a good sign-in as one reset the other's guesses (Codex review of #868, verified by running).
//     A retyped name that matches no row only reaches an account that does not exist, so it buys no guess.
//   * sessionThrottle: keyed by the signed-in user's id, ONE budget for the three routes that ask for the current
//     password (/me/password, /me/mfa/setup, /me/mfa/disable), as their per-source limiter already is.
// Separate stores on purpose: a correct sign-in resets only the login counter, so someone who holds a session cannot
// refill their budget for guessing the password by signing in again, and the two secrets' keys never collide.
// The MFA second step has its own per-user bound (mfaUserLimiter, #550) and is not repeated here.
const loginThrottle = createAccountThrottle();
const sessionThrottle = createAccountThrottle();

// One guess at a password under a throttle. `verify` runs the compare and says whether it matched. The attempt is
// RESERVED before the first await (the compare yields to a worker thread), so parallel requests cannot all pass the
// gate before any failure is recorded, and the outcome is recorded right after the compare. A throw is a server
// fault, not a guess: it gives the reservation back and counts as nothing.
// `known` says whether the name matches a real account: sign-in passes it (an invented name is tracked in a separate,
// capped table, see lib/accountThrottle.js); the signed-in routes are always real accounts.
export async function throttledPasswordCheck(throttle, key, verify, { known = true } = {}) {
  const slot = throttle.acquire(key, { known });
  if (!slot.allowed) return { throttled: true, retryAfterSec: slot.retryAfterSec };
  let ok = false;
  try {
    ok = !!(await verify());
  } catch (err) {
    slot.release();
    throw err;
  }
  if (ok) slot.succeed();
  else slot.fail();
  return { throttled: false, ok };
}

// The same status and body as every other limiter here (the app already shows it), plus Retry-After.
function answerThrottled(res, retryAfterSec) {
  res.set('Retry-After', String(retryAfterSec));
  return res.status(429).json(limiterMessage);
}

// A new password empties the account's guesses: the old ones mean nothing against a new secret, and it is how a
// person who was slowed by someone else's attempts gets back in at once (docs/mfa.md). Exported for tests, which
// share the store across cases the way they share the limiters.
export function resetPasswordThrottles(userId, username) {
  sessionThrottle.reset(userId);
  loginThrottle.reset(loginAccountKey(username));
}

// The login throttle's key: the name exactly as the lookup will use it (see the comment above loginThrottle).
function loginAccountKey(username) {
  return typeof username === 'string' ? username : '';
}

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

// Only admins who can actually sign in count (#1094, Opus plan review H1). An account still waiting on its invite
// (password_set = 0) cannot, so an install whose only "admin" is pending has no admin at all, and the guard below must
// refuse the change that would leave it so. The API never makes a pending admin (invites are for caregivers, and PUT
// /users/:id refuses the role while the account is pending), so this only matters for a database edited by hand or
// restored from elsewhere; it is the same post-condition, counted honestly.
const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND password_set = 1");

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

// MEASURED 2026-11-03: userspace tailscaled delivers every tailnet peer to the app as a
// connection from 127.0.0.1. Gate A makes req.ip the socket address while exposed, so a
// forwarded header cannot make a remote peer look like a LAN caller.
export function setupBlockedByExposedLoopback(exposed, address) {
  return exposed && isLoopbackAddress(address);
}

function refuseExposedLoopbackSetup(req, res) {
  if (!setupBlockedByExposedLoopback(isLoopbackExposed(), req.ip)) return false;
  res.status(403).json({ error: 'Finish setup from a device on your home network, not through Tailscale.' });
  return true;
}

// A password that is not valid text (an unpaired UTF-16 surrogate) is refused before hashing: see the warning at the
// top of lib/passwordHash.js, which refuses it too. This early check is for the routes that SET a password, so the
// refusal comes before their other work (the invite's single-flight slot, a counted confirmation guess) and with the
// route's own 400. The routes that only COMPARE need nothing here: compare() answers false, a wrong password.
// True (and the 400 already sent) when it refused.
function refusedUnusablePassword(res, password) {
  if (!passwordHash.isUnusablePassword(password)) return false;
  res.status(400).json({ error: passwordHash.UNUSABLE_PASSWORD_MESSAGE });
  return true;
}

// One-time: create the first admin account. Locked once any user exists.
router.post('/setup', setupLimiter, asyncHandler(async (req, res) => {
  if (userCount() > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  // Refuse before the costly hash, but preserve the existing completed-setup answer above.
  if (refuseExposedLoopbackSetup(req, res)) return;
  const { username, password, first_name, last_name } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  if (refusedUnusablePassword(res, password)) return;
  const id = uuid();
  const password_hash = await passwordHash.hash(password, 10);
  // The hash yields to the event loop (#548), so a second /setup can pass the check above while this one
  // hashes. It was impossible while the hash was synchronous. Re-check straight before the insert (no
  // await between here and the INSERT) so two simultaneous setups cannot both create an admin.
  if (userCount() > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  // The flag can turn on while hashing yields; check again with no await before the INSERT.
  if (refuseExposedLoopbackSetup(req, res)) return;
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
  // The compare runs for an unknown name too (against DUMMY_HASH), and a miss on an unknown name is counted exactly
  // like a miss on a real one: neither the status, the body nor the timing says which names exist.
  // (A password that is not valid text is a miss with no compare at all, for every name alike: lib/passwordHash.js
  // answers false at once, so it is counted and answered like any wrong password and still says nothing about names.)
  // An account still waiting on its invite (#1094, password_set = 0) is a miss too, AFTER the same compare (against
  // its placeholder hash, same cost) and counted the same way, so it answers exactly like a wrong password. Its
  // placeholder is a hash of 32 random bytes nobody knows and can never match; this guard is what holds if the stored
  // hash is ever one somebody knows (an older version set a password, a database edited by hand).
  const attempt = await throttledPasswordCheck(
    loginThrottle,
    loginAccountKey(username),
    async () => (await passwordHash.compare(String(password || ''), hashToCheck)) && !!user && user.password_set === 1,
    { known: !!user }
  );
  if (attempt.throttled) return answerThrottled(res, attempt.retryAfterSec);
  if (!attempt.ok) {
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
  // #1094 (Codex plan review C1): an MFA token minted before the account was made pending must not finish a sign-in.
  // The same answer as a token for an account that no longer exists.
  if (user.password_set !== 1) return res.status(401).json({ error: 'Invalid verification token' });

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
// The list only (not every user object) also says, per account, whether it has a password and where its invite stands
// (#1094): `password_set`, `invite_expires_at` and `invite_accepted_at` (see inviteFields). Added keys only, so a page
// opened before the update keeps working.
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  const invites = inviteStatesByUser();
  res.json(users.map((u) => ({ ...toPublicUser(u), ...inviteFields(u, invites.get(u.id)) })));
});

router.post('/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  // #1094: `invite: true` creates the account WITHOUT a password and answers with a one-time invite (its own function,
  // in the invites section at the end of this file). The boolean true only, like `restart` on /me/mfa/setup: a sloppy
  // "true" string or a 1 takes the password path below and is refused there for having no password, never quietly
  // turned into an invite. Everything below is the password path, unchanged.
  if (req.body?.invite === true) return createInvitedUser(req, res);
  const { username, password, role, first_name, last_name } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  if (refusedUnusablePassword(res, password)) return;
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
  // Nor for a password that is not valid text: it is refused below, after the same checks as before
  // (refusedUnusablePassword), so it never reaches the worker.
  const submittedPassword = req.body?.password;
  const newHash =
    typeof submittedPassword === 'string' && submittedPassword.length >= 8 && !passwordHash.isUnusablePassword(submittedPassword)
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
  if (refusedUnusablePassword(res, password)) return;
  // #1094 (Opus plan review H1): an account still waiting on its invite is never made an admin, or whoever holds the
  // link would choose an admin's password. Allowed when this same request sets a password: the account then stops
  // being pending and its invites are deleted in the same transaction (below), so no link is left to use.
  if (role === 'admin' && existing.password_set !== 1 && !password) {
    return res.status(400).json({ error: PENDING_CANNOT_BE_ADMIN });
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
      // #1094: a password an admin sets ends any invite. The account is no longer pending, and its unused invite links
      // are deleted so they stop working at once, not merely outranked: a link that still looked valid would be a
      // second way in. This is also the recovery when an older version set the password (that leaves the account
      // pending here): set it again from this version (docs/caregivers.md). Inside the transaction, so a refused
      // change leaves the invite alone too.
      if (password) {
        markPasswordSet.run(req.params.id);
        revokeUnusedInvites.run(req.params.id);
      }
    });
  } catch (e) {
    if (e instanceof LastAdminError) return res.status(409).json({ error: LAST_ADMIN_MESSAGE });
    throw e;
  }
  // After the transaction, so a refused (rolled-back) change leaves it alone: a new password also empties the
  // confirmation route's budget, as on PUT /me/password (see resetMfaEnableLimit).
  if (password) {
    resetMfaEnableLimit(req.params.id);
    // And the password guesses against the account, under the old and the new name (#553; see resetPasswordThrottles).
    resetPasswordThrottles(req.params.id, existing.username);
    resetPasswordThrottles(req.params.id, username?.trim() || existing.username);
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
  // Before the current password is checked, so an unusable NEW password costs no guess. (An unusable CURRENT one
  // needs nothing here: compare() answers false, the same 400 as a wrong one.)
  if (refusedUnusablePassword(res, new_password)) return;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const attempt = await throttledPasswordCheck(
    sessionThrottle,
    req.user.id,
    async () => !!user && (await passwordHash.compare(current_password || '', user.password_hash))
  );
  if (attempt.throttled) return answerThrottled(res, attempt.retryAfterSec);
  if (!attempt.ok) {
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
  // And the confirmation route's budget: a device that used it up is signed out just above (see resetMfaEnableLimit).
  resetMfaEnableLimit(req.user.id);
  // And the account's password guesses (#553): the new password makes them moot, and a person who had been slowed by
  // someone else's failed sign-ins gets back in at once.
  resetPasswordThrottles(req.user.id, user.username);
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
  // The same compare /me/mfa/disable uses (the worker-thread bcrypt of #548), under the same per-account throttle.
  const attempt = await throttledPasswordCheck(
    sessionThrottle,
    req.user.id,
    () => passwordHash.compare(String(req.body?.password || ''), user.password_hash)
  );
  if (attempt.throttled) return answerThrottled(res, attempt.retryAfterSec);
  if (!attempt.ok) {
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
    // Compare-and-set on BOTH things this rotation was decided from, because the password check above yields:
    //   * `mfa_enabled = 0`: two-factor may have been switched on meanwhile. An unconditional write would
    //     replace the ACTIVE secret, and the owner's authenticator would then fail every sign-in at the code
    //     step (a lockout).
    //   * `mfa_secret IS ?`, the secret read before the check (`IS`, so a NULL "nothing pending" compares
    //     equal): another set-up may have stored its own secret meanwhile (review of #765, verified by
    //     running: two simultaneous starts both answered 200, and the second overwrote the first's key, so
    //     the first device held a key that could never confirm). The one that loses is told to try again.
    const stored = db
      .prepare('UPDATE users SET mfa_secret = ?, mfa_last_step = NULL WHERE id = ? AND mfa_secret IS ? AND mfa_enabled = 0')
      .run(secret, user.id, user.mfa_secret);
    if (stored.changes !== 1) {
      const current = db.prepare('SELECT mfa_enabled FROM users WHERE id = ?').get(user.id);
      return res.status(400).json({ error: !current || current.mfa_enabled ? SETUP_ALREADY_ON : SETUP_CHANGED_MEANWHILE });
    }
    // The rotated-away secret's count goes with it (same reason as in /me/mfa/disable). The count would start again
    // at the next wrong code anyway (the secret differs); this only drops the old plaintext from memory.
    mfaEnableWrongCodes.delete(user.id);
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
// ten cost-10 hashes, about 0.8 s of the one worker's time, and this route had no attempt limiter (its limits
// count wrong codes only, so they still do not bound requests with the right code), so every
// simultaneous enable for one account queued ten more hashes ahead of everyone's sign-ins, only for the
// compare-and-set below to refuse all but one of them. A second enable for a user while one is in flight is
// now refused BEFORE any hashing, with the same 400 the losing compare-and-set used to give. In memory, per
// process: the app is one process, and the compare-and-set still guards the write if that ever changes.
const mfaEnableInFlight = new Set();

// The answer to the wrong code that cancels a pending set-up (see MFA_ENABLE_MAX_WRONG_CODES). 400 like every other
// refusal here, never 401 (#697: that would sign the person out). The set-up card still offers Continue set-up and
// Start over until the page reloads, and either one now makes a new key ("There was no set-up to continue" for the
// first), so the text names both. The phone's clock is the usual reason a real person's codes keep failing.
const MFA_ENABLE_CANCELLED =
  "Too many wrong codes, so this set-up was cancelled. Choose Continue set-up or Start over to get a new key (also check your phone's clock).";
// The cancel. A compare-and-set on the secret that was guessed against (`IS ?`), with two-factor still off, as on
// the enable write below. Nothing awaits between the read of `user` and this statement today, so the compare
// cannot lose: it is defence in depth for the day an await is added, so a cancel can never clear a newer set-up's
// secret, nor an ACTIVE secret (that would leave two-factor on with no secret, a lockout at the code step).
const cancelPendingSetup = db.prepare(
  'UPDATE users SET mfa_secret = NULL, mfa_last_step = NULL WHERE id = ? AND mfa_enabled = 0 AND mfa_secret IS ?',
);

// Confirm a code against the pending secret; on success, enable MFA and return one-time backup
// codes to show the user once (only their hashes are kept).
// mfaEnableUserLimiter after requireAuth: it is keyed on the session's user (see its comment).
router.post('/me/mfa/enable', requireAuth, mfaEnableUserLimiter, asyncHandler(async (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.mfa_enabled) return res.status(400).json({ error: 'Two-factor is already on.' });
  if (!user.mfa_secret) return res.status(400).json({ error: 'Start setup first.' });
  if (!verifyToken(user.mfa_secret, code)) {
    // A wrong code: the one kind of request either bound counts (see the comment above mfaEnableUserLimiter).
    // Counted with NO await between the read of `user` above and the cancel below, so requests sent at once
    // cannot all slip past the cap: each one runs this whole block before the next can start.
    res.locals.mfaWrongCode = true;
    // String() on both sides, as the hash version did: SQLite lets a TEXT column hold a BLOB, which comes back as a
    // new object on every read and would never compare equal (review of #778, verified by running).
    const secret = String(user.mfa_secret);
    let entry = mfaEnableWrongCodes.get(user.id);
    if (!entry || entry.secret !== secret) {
      entry = { secret, wrong: 0 };
      mfaEnableWrongCodes.set(user.id, entry);
    }
    entry.wrong += 1;
    if (entry.wrong >= MFA_ENABLE_MAX_WRONG_CODES) {
      // The write FIRST, the count's delete only after it succeeded (review, Opus, verified with a failing write).
      // The other way round, a cancel whose UPDATE throws had already dropped the count while the key stayed
      // pending, so the next wrong code counted from 1 again and the cap of 10 never held. Kept, the count stays
      // at 10 or more and the next wrong code tries the cancel again.
      cancelPendingSetup.run(user.id, user.mfa_secret);
      mfaEnableWrongCodes.delete(user.id);
      return res.status(400).json({ error: MFA_ENABLE_CANCELLED });
    }
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
    // Two-factor is on, so nothing is pending and its wrong-code count can go. Tidiness, not a rule anything
    // depends on: a later set-up has a new secret, whose count starts at 0 anyway (so no test pins this line).
    mfaEnableWrongCodes.delete(user.id);
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
  const attempt = await throttledPasswordCheck(
    sessionThrottle,
    req.user.id,
    async () => !!user && (await passwordHash.compare(String(password || ''), user.password_hash))
  );
  if (attempt.throttled) return answerThrottled(res, attempt.retryAfterSec);
  if (!attempt.ok) {
    // 400 not 401, same reason as /me/password above (#697): a mistyped confirmation must not sign the person out.
    return res.status(400).json({ error: 'Password is incorrect' });
  }
  if (signInEnded(req, res)) return;
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL, mfa_last_step = NULL WHERE id = ?').run(user.id);
  // The pending secret the count belongs to is gone: do not keep its plaintext in memory until the next wrong code.
  mfaEnableWrongCodes.delete(user.id);
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
  // A removed account must not leave its confirmation-route state behind in memory (review, Codex).
  resetMfaEnableLimit(req.params.id);
  res.status(204).end();
});

// --- Caregiver invites (#1094) -----------------------------------------------------------------------------------
//
// An admin creates a caregiver account WITHOUT a password and gets a one-time link (a QR code in the app); the
// caregiver opens it and chooses their own password. Design: PLAN D, with the Opus (H1, M1-M4, L1-L8) and Codex
// (C1-C5) plan-review amendments; docs/caregivers.md and SECURITY.md say what it means for the people using it.
//
// The link carries a TOKEN, never a password: 32 random bytes (256 bits), base64url, 43 characters. Only its sha256 is
// stored (user_invites.token_hash): with 256 random bits there is nothing to brute-force, so a slow hash would buy
// nothing, and the lookup is by equality. The token is answered ONCE, to the admin who made it, and never again: no
// list, GET or log line carries it (secrets-never-returned.test.js plants a marker in token_hash).
//
// The rules that keep a leaked link from being worse than the account it was made for:
//   * invites are for role `caregiver` only (a link is never an admin account), and the redeem's compare-and-swap
//     re-checks the role, so an account promoted while its invite was open cannot be claimed (H1);
//   * single use: a compare-and-swap on `used_at IS NULL`, inside one transaction with the password write (M1);
//   * 7 days (owner's answer, 2026-11-14), checked again AFTER the bcrypt await, so an invite that runs out while its
//     password is hashing is refused (M1);
//   * the password write is a compare-and-swap on the placeholder hash the invite was made with (stored on the invite
//     row, read before the await), so a password an admin, or an older version of the app (C2), set since is never
//     overwritten by a link (M4);
//   * no session or MFA step is ever given to an account that is still pending (/login, /login/mfa and the session
//     check in middleware/auth.js all require password_set = 1: C1).

// Owner's answer when the feature was asked for (2026-11-14): an invite is valid for 7 days, single use.
const INVITE_TTL_DAYS = 7;
// The exact shape the app hands out: 43 base64url characters (32 bytes, no padding). Anything else is refused with the
// same answer as an unknown token, after the same lookup (see liveInvite).
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// ONE answer for every invite that cannot be used: unknown, expired, already used, revoked, malformed, or one whose
// account is no longer a pending caregiver. Same status, same body, about the same work, so nothing tells a
// guesser which of those it was (no enumeration). A machine-readable code, not a sentence: the page words it.
const INVITE_INVALID = { error: 'invite_invalid' };
// How long the Users list keeps saying an invite was accepted ("joined", L7). Not a security rule: long enough for an
// admin to notice, short enough not to clutter the list.
const INVITE_ACCEPTED_SHOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const INVITE_CAREGIVER_ONLY = 'An invite can only create a caregiver account. Create an admin with a password.';
const PENDING_CANNOT_BE_ADMIN =
  'This account has not chosen its password yet, so it cannot be an admin. Set a password for it in the same change, or wait until the invite is used.';

// The UTC 'YYYY-MM-DD HH:MM:SS' text SQLite's datetime('now') writes, so invite times compare as text with each other
// and read like every other time in this API (sessions, users). Taken from the JavaScript clock rather than SQLite's
// so a test can move it across the redeem's bcrypt await (node:test mock timers); in the app both are the system clock.
function utcText(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function inviteTokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

// --- the limits on the two public routes --------------------------------------------------------------------------
//
// ONE limiter for /invite/check AND /invite/redeem, its OWN instance (Opus plan review M2), counting FAILURES only.
//   * Its own: perClientLimiter is the budget /login shares, and behind a reverse proxy or Tailscale every remote user
//     is one bucket there. Junk tokens sprayed at the invite routes must not lock the household out of signing in.
//   * Failures only (skipSuccessfulRequests): a caregiver who opens their link, reloads the page and redeems never
//     spends anything. A wrong, expired or used token, a short password and the aggregate 429 below all count.
//   * 100 per 15 minutes per source address, the order of the login per-client limit (PER_CLIENT_LIMIT). A judgement,
//     not a measurement: a 256-bit token cannot be guessed whatever the limit, so this only bounds noise; the CPU is
//     bounded by the hashing limits below, which a junk token never reaches. Known limit: behind one proxy address a
//     spray of 100 bad tokens makes the invite routes answer 429 to everyone behind it for the rest of the window
//     (sign-in is not affected). There is NO per-token limiter (dropped in M2): a junk token gets a fresh bucket for
//     free, and the real token is covered by the single flight below.
// In memory, like every limiter here: a restart empties it.
export const INVITE_FAILURES_PER_WINDOW = 100;
const inviteLimiterStore = new MemoryStore();
const inviteLimiter = rateLimit({
  windowMs: RATE_WINDOW_MS,
  limit: INVITE_FAILURES_PER_WINDOW,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterMessage,
  keyGenerator: clientKey,
  store: inviteLimiterStore,
  skipSuccessfulRequests: true, // #1094 M2: failures only (see above)
});

// Tests share the module-level store across cases, as they do the other limiters (see resetMfaUserLimit).
export function resetInviteAttemptLimits() {
  inviteLimiterStore.resetAll();
}

// The redeem is the only unauthenticated route that hashes a password with bcrypt (cost 10, about 80 ms of the ONE
// shared worker that every sign-in also queues on: lib/passwordHash.js). Two bounds, both checked and taken with no
// await in between, both released in `finally` (a failed hash too: a worker that died mid-hash must not leave the link
// locked, or the cap used up, until a restart; both are tested by stopping the worker during a redeem):
//   * per token (M1): one redeem per token hash at a time. A second request for the same token while one is hashing
//     is refused before it queues a hash, with `409 invite_in_progress` (review of #1094, L1). Not the 404: a double
//     tap, or a retry while the first is still hashing, would then show "this link is not valid" for a link that is
//     about to work, and the docs tell an admin to remove an account whose person says that. It reveals nothing new:
//     only someone holding a live token reaches this line, and /invite/check already tells them the token is valid.
//     The page must disable its button while a redeem is in flight, and treat a 409 as "wait a moment, then try
//     signing in with the password you chose".
//   * across tokens (Codex plan review C3): at most INVITE_MAX_HASHES_IN_FLIGHT invite hashes queued at once. Each one
//     needs a VALID invite, so this only engages when many real invites are redeemed at the same moment, or when
//     someone holding several links replays them; the excess gets the limiter's 429 and can simply try again. 4 is a
//     judgement (not measured): about a third of a second of the worker at most (four cost-10 hashes), so a burst of
//     invite redeems cannot hold up the household's sign-ins behind it, while no real household redeems more than a
//     few at once. That bound holds only because a password that is not valid text is refused BEFORE it takes a slot
//     (refusedUnusablePassword below; lib/passwordHash.js): bcryptjs spends far longer than one hash failing on one.
// In memory, per process: the app is one process, and the compare-and-swap still guards the write if that changes.
const INVITE_MAX_HASHES_IN_FLIGHT = 4;
const INVITE_IN_PROGRESS = { error: 'invite_in_progress' };
let inviteHashesInFlight = 0;
const inviteRedeemInFlight = new Set();

// --- statements ---------------------------------------------------------------------------------------------------

// The cheap check both public routes start with: an invite that is unused, unexpired, and whose account is still a
// pending caregiver holding the placeholder the invite was made with. The redeem repeats every one of these conditions
// in its compare-and-swap after the await; this copy is what keeps a stale or junk token from ever reaching bcrypt.
// `u.password_hash = i.placeholder_hash` (M4, C2): an account whose password was set some other way since the invite
// was made (an OLDER version of the app sets it and leaves password_set at 0, as it knows nothing of the column) has
// a password somebody chose, and the link must not replace it. Comparing with the hash read at request time instead
// would only catch a change made during the hashing, never one made before the link was opened.
// ONE text for "this invite can be used" (`i` an invite joined to its account `u`, `?` the time now), shared with the
// Users list (inviteStates), so the list never calls a link open that /invite/check refuses (review of #1094, Codex 2
// and Opus L2: a link whose account's hash was replaced behind it was listed as open).
const USABLE_INVITE = `i.used_at IS NULL AND i.expires_at > ? AND u.password_set = 0 AND u.role = 'caregiver'
     AND u.password_hash = i.placeholder_hash`;
const liveInviteByHash = db.prepare(
  `SELECT i.token_hash, i.placeholder_hash, i.user_id, u.username, u.first_name
   FROM user_invites i JOIN users u ON u.id = i.user_id
   WHERE i.token_hash = ? AND ${USABLE_INVITE}`
);
const insertInvite = db.prepare(
  'INSERT INTO user_invites (id, user_id, token_hash, placeholder_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
// Unused invites only: a used one is the record that the account was claimed (the "joined" line in the Users list,
// and the purge's 30 days), and can never be used again anyway.
const revokeUnusedInvites = db.prepare('DELETE FROM user_invites WHERE user_id = ? AND used_at IS NULL');
const markPasswordSet = db.prepare('UPDATE users SET password_set = 1 WHERE id = ?');
const insertInvitedUser = db.prepare(
  'INSERT INTO users (id, username, password_hash, role, first_name, last_name, photo, password_set) VALUES (?, ?, ?, ?, ?, ?, ?, 0)'
);
// The redeem's two compare-and-swaps (see the route).
const claimInvite = db.prepare('UPDATE user_invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?');
const inviteOwner = db.prepare('SELECT user_id FROM user_invites WHERE token_hash = ?');
const setInvitedPassword = db.prepare(
  "UPDATE users SET password_hash = ?, password_set = 1 WHERE id = ? AND password_set = 0 AND role = 'caregiver' AND password_hash = ?"
);
// Per account, for the Users list: the expiry of its newest invite that can be used (the SAME rule as the public
// routes, USABLE_INVITE), and when an invite was last accepted within INVITE_ACCEPTED_SHOWN_DAYS. Grouped in one query
// rather than two per account.
const inviteStates = db.prepare(
  `SELECT i.user_id,
     MAX(CASE WHEN ${USABLE_INVITE} THEN i.expires_at END) AS live_expires_at,
     MAX(CASE WHEN i.used_at > ? THEN i.used_at END) AS accepted_at
   FROM user_invites i JOIN users u ON u.id = i.user_id GROUP BY i.user_id`
);

// --- helpers ------------------------------------------------------------------------------------------------------

// The live invite a token names, or null. The token's shape is checked AFTER the lookup, which then runs on the hash
// of an empty string for a malformed token: a malformed, an unknown, a used and an expired token all cost one sha256
// and one indexed SELECT, and all answer the same 404 (as near equal timing as this can make it).
function liveInvite(token, now) {
  const wellFormed = typeof token === 'string' && INVITE_TOKEN_PATTERN.test(token);
  const row = liveInviteByHash.get(inviteTokenHash(wellFormed ? token : ''), now);
  return wellFormed ? row ?? null : null;
}

// A new invite for `userId`, bound to the account's current placeholder hash: the token (answered once, never stored)
// and its expiry. Callers run it inside their transaction, so an account is never left with a half-made invite.
function mintInvite(userId, placeholderHash, createdBy) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = utcText(now + INVITE_TTL_DAYS * DAY_MS);
  insertInvite.run(uuid(), userId, inviteTokenHash(token), placeholderHash, createdBy, utcText(now), expiresAt);
  return { token, expires_at: expiresAt };
}

function inviteStatesByUser() {
  const now = Date.now();
  const rows = inviteStates.all(utcText(now), utcText(now - INVITE_ACCEPTED_SHOWN_DAYS * DAY_MS));
  return new Map(rows.map((r) => [r.user_id, r]));
}

// The Users list's three invite keys for one account:
//   password_set        false while the account waits on its invite;
//   invite_expires_at   when its invite stops working, or null when it has NO USABLE INVITE: none made, expired,
//                       cancelled (revoked), used, or one the link can no longer use because the account is not a
//                       pending caregiver still holding the invite's placeholder (exactly what /invite/check would
//                       refuse: inviteStates uses the same USABLE_INVITE rule). Pending + null means "no active
//                       invite" (the screens must not word it "expired": a cancelled one is null too);
//   invite_accepted_at  when an invite was used, for INVITE_ACCEPTED_SHOWN_DAYS after it, else null.
// Times are UTC 'YYYY-MM-DD HH:MM:SS', like the session times. Never the token or its hash.
function inviteFields(u, state) {
  return {
    password_set: u.password_set === 1,
    invite_expires_at: state?.live_expires_at ?? null,
    invite_accepted_at: state?.accepted_at ?? null,
  };
}

// A names field the invite path accepts: absent, null, or text. (The password path keeps its old handling.)
const optionalText = (v) => v === undefined || v === null || typeof v === 'string';

// POST /users with `invite: true` (see that route). Every field is type-checked (Opus plan review L3) before anything
// costs a hash; then the same discipline as the password path: the hash first, then adminRightsEnded and the
// username check with no await before the INSERT.
async function createInvitedUser(req, res) {
  const { username, password, role, first_name, last_name } = req.body;
  // Both at once is a client bug, not a choice to guess at. An empty or null password means "none" (a form that left
  // the field blank).
  if (password !== undefined && password !== null && password !== '') {
    return res.status(400).json({ error: 'Send either a password or invite: true, not both.' });
  }
  if (typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: 'A username is required' });
  }
  if (role !== undefined && role !== null && role !== 'caregiver') {
    return res.status(400).json({ error: INVITE_CAREGIVER_ONLY });
  }
  if (!optionalText(first_name) || !optionalText(last_name)) {
    return res.status(400).json({ error: 'First and last name must be text' });
  }
  // The account still needs a password_hash (NOT NULL). A real bcrypt hash of 32 random bytes nobody ever sees, never
  // '': it can never match anything typed at /login (which also refuses a pending account outright), and the redeem
  // swaps it out only if it is still exactly this value.
  const placeholder = await passwordHash.hash(randomBytes(32).toString('base64url'), 10);
  if (adminRightsEnded(req, res)) return;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'That username is already taken' });
  let photo;
  try { photo = normalizePhoto(req.body?.photo, null); } catch (e) { return res.status(400).json({ error: e.message }); }
  const id = uuid();
  // ONE transaction (M1): never an account without its invite, nor an invite without its account.
  const invite = db.transaction(() => {
    insertInvitedUser.run(id, username, placeholder, 'caregiver', first_name?.trim() || null, last_name?.trim() || null, photo);
    return mintInvite(id, placeholder, req.user.id);
  })();
  // The usual user object, plus the invite. The ONLY answer that ever carries the token.
  res.status(201).json({ ...toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), invite });
}

// Admin: a new invite for an account that is still waiting on one (the old link was lost, or ran out). Every unused
// invite of the account is deleted in the same transaction, so the old link stops working the moment the new one
// exists. Refused for an account that has a password (an invite would be a back door into it: resetting a password is
// PUT /users/:id) and for any role but caregiver (H1). Synchronous: no await between the checks and the writes.
// The new invite is bound to the account's hash as it is NOW. For an account an older version gave a password while
// it was pending, that is the admin choosing, on this version, to hand the account to whoever opens the new link.
router.post('/users/:id/invite', requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id, role, password_set, password_hash FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.password_set !== 0 || user.role !== 'caregiver') {
    return res.status(400).json({ error: 'Only a caregiver account that has not chosen its password yet can be sent a new invite.' });
  }
  const invite = db.transaction(() => {
    revokeUnusedInvites.run(user.id);
    return mintInvite(user.id, user.password_hash, req.user.id);
  })();
  res.status(201).json({ invite });
});

// Admin: stop an account's open invite without making a new one (L2). The account stays pending: it can be sent a new
// invite, given a password (PUT /users/:id), or removed. `revoked` is how many links stopped working (0 or 1 in
// practice).
router.delete('/users/:id/invite', requireAuth, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { changes } = revokeUnusedInvites.run(user.id);
  res.json({ ok: true, revoked: changes });
});

// Public: is this invite usable, and whose is it? For the page the link opens, before the person types a password.
// The token travels in the BODY (never a query string, which proxies and browsers log; the link itself carries it in
// the URL fragment, which never reaches a server). The username is answered so the page can show it and a password
// manager can save the pair (L5).
router.post('/invite/check', inviteLimiter, (req, res) => {
  const invite = liveInvite(req.body?.token, utcText(Date.now()));
  if (!invite) return res.status(404).json(INVITE_INVALID);
  res.json({ first_name: invite.first_name || null, username: invite.username, app_name: appName() });
});

// Thrown inside the redeem transaction for any compare-and-swap that misses, so the transaction rolls back (a plain
// return from a better-sqlite3 transaction COMMITS whatever ran before it, e.g. the invite marked used). Never sent.
class InviteGoneError extends Error {}

// The claim, as one transaction:
//   1. the invite: used_at set only if still unused and unexpired at `now` (the time read AFTER the hash);
//   2. the account, found through the invite row: the new password only if it is still pending, still a caregiver,
//      and still holds the invite's placeholder, as read before the hash (so a password set before the link was
//      opened, or while it was hashing, is never overwritten);
//   3. its other unused invites, sessions and push registrations go (M4: a session or alert registration that
//      predates the account having a password must not survive into it; there should be none, this makes sure).
// Each compare-and-swap must change exactly one row, or the whole claim rolls back and the route answers the 404.
const redeemInvite = db.transaction((tokenHash, placeholderHash, newHash, now) => {
  if (claimInvite.run(now, tokenHash, now).changes !== 1) throw new InviteGoneError();
  const { user_id: userId } = inviteOwner.get(tokenHash);
  if (setInvitedPassword.run(newHash, userId, placeholderHash).changes !== 1) throw new InviteGoneError();
  revokeUnusedInvites.run(userId);
  db.prepare('DELETE FROM push_tokens WHERE user_id = ? OR session_id IN (SELECT id FROM sessions WHERE user_id = ?)')
    .run(userId, userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
});

// Public: choose a password with an invite, and be signed in. Answers exactly like /login: `{ token, user }` (or the
// MFA step, which a pending account cannot have set up, so in practice never).
router.post('/invite/redeem', inviteLimiter, asyncHandler(async (req, res) => {
  const { token, password } = req.body || {};
  // The cheap checks first, so a junk or stale token never costs a bcrypt hash.
  const checkedAt = utcText(Date.now());
  const invite = liveInvite(token, checkedAt);
  if (!invite) return res.status(404).json(INVITE_INVALID);
  // The same 8-character rule as creating an account. Refused before anything is written, so the invite still works.
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Choose a password of at least 8 characters' });
  }
  // Before either slot is taken, and before anything is written, so the invite still works (see the bounds above).
  if (refusedUnusablePassword(res, password)) return;
  if (inviteRedeemInFlight.has(invite.token_hash)) return res.status(409).json(INVITE_IN_PROGRESS);
  if (inviteHashesInFlight >= INVITE_MAX_HASHES_IN_FLIGHT) return res.status(429).json(limiterMessage);
  inviteRedeemInFlight.add(invite.token_hash);
  inviteHashesInFlight += 1;
  try {
    let newHash;
    try {
      newHash = await passwordHash.hash(password, 10);
    } finally {
      inviteHashesInFlight -= 1;
    }
    // The clock is read again AFTER the await (M1): an invite that ran out while its password was hashing is refused.
    const now = utcText(Date.now());
    let user;
    try {
      user = redeemInvite(invite.token_hash, invite.placeholder_hash, newHash, now);
    } catch (e) {
      if (e instanceof InviteGoneError) return res.status(404).json(INVITE_INVALID);
      throw e;
    }
    // After the commit (L1): a new password empties the account's password guesses and its two-factor confirmation
    // budget, as both other password-setting paths do.
    resetPasswordThrottles(user.id, user.username);
    resetMfaEnableLimit(user.id);
    if (user.mfa_enabled) return res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) });
    const sessionId = createSession(user.id, req.headers['user-agent']);
    res.json({ token: sign(user, sessionId), user: toPublicUser(user) });
  } finally {
    inviteRedeemInFlight.delete(invite.token_hash);
  }
}));

export default router;
