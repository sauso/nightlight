import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth, requireAdmin, JWT_SECRET } from '../middleware/auth.js';
import {
  generateSecret, keyUri, verifyToken, qrDataUrl,
  generateBackupCodes, verifyAndConsumeBackupCode, backupCodesRemaining,
} from '../lib/mfa.js';
import { normalizePhoto } from '../lib/photo.js';

const router = Router();

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
// what leaks is a time-boxed, video-only capability — not the 30-day full-account session token.
const MEDIA_TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12h: covers a full overnight viewing session, tiny vs the 30-day session
function signMediaToken(userId, sessionId) {
  return jwt.sign({ id: userId, sid: sessionId, purpose: 'media' }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: MEDIA_TOKEN_TTL_SECONDS,
  });
}

// Login has no other protection against repeated guessing (no account lockout, no
// CAPTCHA) - this is the actual backstop against brute-forcing a password. Keyed by
// IP, not username, so it can't be used to lock a legitimate user out by deliberately
// failing their login from elsewhere.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts - please wait a few minutes and try again.' },
});

function userCount() {
  return db.prepare('SELECT COUNT(*) as c FROM users').get().c;
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

function sign(user, sessionId) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role, sid: sessionId }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  });
}

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
  res.json({ needsSetup: userCount() === 0 });
});

// One-time: create the first admin account. Locked once any user exists.
router.post('/setup', loginLimiter, (req, res) => {
  if (userCount() > 0) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  const { username, password, first_name, last_name } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  const id = uuid();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, username, password_hash, 'admin', first_name?.trim() || null, last_name?.trim() || null);
  const user = { id, username, role: 'admin' };
  const sessionId = createSession(id, req.headers['user-agent']);
  res.json({
    token: sign(user, sessionId),
    user: toPublicUser({ ...user, first_name, last_name, created_at: null }),
  });
});

// Compared against when the username doesn't exist, so both failure paths cost one
// bcrypt comparison - otherwise the "no such user" path returns measurably faster
// than "wrong password", letting response timing confirm which usernames exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user =
    typeof username === 'string' ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
  const hashToCheck = user ? user.password_hash : DUMMY_HASH;
  if (!bcrypt.compareSync(String(password || ''), hashToCheck) || !user) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  // Password is correct. If the account has two-factor on, don't issue a session yet — hand back a
  // short-lived token the client exchanges at /login/mfa after the second step.
  if (user.mfa_enabled) {
    return res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) });
  }
  const sessionId = createSession(user.id, req.headers['user-agent']);
  res.json({ token: sign(user, sessionId), user: toPublicUser(user) });
});

// Second login step for MFA accounts: verify the 6-digit authenticator code (or a one-time backup
// code) against the token from /login, then issue the real session. Rate-limited like /login.
router.post('/login/mfa', loginLimiter, (req, res) => {
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
  let ok = verifyToken(user.mfa_secret, code);
  if (!ok) {
    const result = verifyAndConsumeBackupCode(user.mfa_backup_codes, code);
    if (result.ok) {
      ok = true;
      db.prepare('UPDATE users SET mfa_backup_codes = ? WHERE id = ?').run(result.hashesJson, user.id);
    }
  }
  if (!ok) return res.status(401).json({ error: 'Incorrect code' });

  const sessionId = createSession(user.id, req.headers['user-agent']);
  res.json({ token: sign(user, sessionId), user: toPublicUser(user) });
});

// Ends just the current session - the token stops working on its very next use,
// rather than remaining valid (just unused) until it naturally expires.
router.post('/logout', requireAuth, (req, res) => {
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
  const sessions = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(req.user.id);
  res.json(sessions.map((s) => toPublicSession(s, req.user.sid)));
});

// Admin: every active session across every account - lets an admin revoke a
// caregiver's access on a specific device without deleting their whole account.
router.get('/sessions/all', requireAuth, requireAdmin, (req, res) => {
  const sessions = db
    .prepare(
      `SELECT sessions.*, users.username FROM sessions
       JOIN users ON users.id = sessions.user_id
       ORDER BY last_seen_at DESC`
    )
    .all();
  res.json(sessions.map((s) => toPublicSession(s, req.user.sid)));
});

// Terminate a session - your own, or (admins only) anyone's.
router.delete('/sessions/:id', requireAuth, (req, res) => {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not allowed' });
  }
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Admin: manage caregiver accounts.
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at').all();
  res.json(users.map(toPublicUser));
});

router.post('/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, role, first_name, last_name } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'That username is already taken' });
  let photo;
  try { photo = normalizePhoto(req.body?.photo, null); } catch (e) { return res.status(400).json({ error: e.message }); }
  const id = uuid();
  const password_hash = bcrypt.hashSync(password, 10);
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
});

router.put('/users/:id', requireAuth, requireAdmin, (req, res) => {
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

  const password_hash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
  let photo;
  try { photo = normalizePhoto(req.body?.photo, existing.photo); } catch (e) { return res.status(400).json({ error: e.message }); }

  // A password reset means the old credential can no longer be trusted - any session
  // opened under it shouldn't outlive it. Spares only the requesting admin's own
  // current session, for the case where they're resetting their own password.
  if (password) {
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
  res.json(toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
});

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
router.put('/me/password', requireAuth, loginLimiter, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const password_hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, req.user.id);
  // Sign every other device out. Changing your password is exactly the move someone
  // makes when a logged-in device is lost or no longer trusted - leaving those
  // sessions valid for the rest of their 30 days would defeat the point.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.user.sid);
  res.json({ ok: true });
});

// --- Two-factor auth (TOTP), self-service ---

// Current MFA state for the signed-in user (drives the Account toggle).
router.get('/me/mfa', requireAuth, (req, res) => {
  const u = db.prepare('SELECT mfa_enabled, mfa_backup_codes FROM users WHERE id = ?').get(req.user.id);
  res.json({ enabled: !!u?.mfa_enabled, backup_codes_remaining: backupCodesRemaining(u?.mfa_backup_codes) });
});

// Begin enrolment: generate + stash a secret (still disabled) and return the QR + manual key. The
// secret only becomes active once a code is confirmed at /me/mfa/enable.
router.post('/me/mfa/setup', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.mfa_enabled) return res.status(400).json({ error: 'Two-factor is already on. Turn it off first to re-enrol.' });
  const secret = generateSecret();
  db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret, user.id);
  const uri = keyUri(user.username, secret, appName());
  res.json({ secret, otpauth_uri: uri, qr: await qrDataUrl(uri) });
});

// Confirm a code against the pending secret; on success, enable MFA and return one-time backup
// codes to show the user once (only their hashes are kept).
router.post('/me/mfa/enable', requireAuth, (req, res) => {
  const { code } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.mfa_enabled) return res.status(400).json({ error: 'Two-factor is already on.' });
  if (!user.mfa_secret) return res.status(400).json({ error: 'Start setup first.' });
  if (!verifyToken(user.mfa_secret, code)) {
    return res.status(400).json({ error: "That code didn't match — check your authenticator app and try again." });
  }
  const { codes, hashesJson } = generateBackupCodes();
  db.prepare('UPDATE users SET mfa_enabled = 1, mfa_backup_codes = ? WHERE id = ?').run(hashesJson, user.id);
  res.json({ backup_codes: codes });
});

// Turn MFA off. Requires the account password (not just the live session) so a borrowed unlocked
// device can't quietly strip someone's second factor.
router.post('/me/mfa/disable', requireAuth, loginLimiter, (req, res) => {
  const { password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Password is incorrect' });
  }
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

// Admin: clear a locked-out user's MFA (lost authenticator + backup codes). The self-lockout case
// for the last admin is handled out-of-band by the console reset script (see docs/mfa.md).
router.delete('/users/:id/mfa', requireAuth, requireAdmin, (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, mfa_backup_codes = NULL WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't remove your own account" });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

export default router;
