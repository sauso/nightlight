import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { v4 as uuid } from 'uuid';
import db from '../db.js';
import { requireAuth, requireAdmin, JWT_SECRET } from '../middleware/auth.js';

const router = Router();

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
  };
}

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '30d',
  });
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
  res.json({
    token: sign(user),
    user: toPublicUser({ ...user, first_name, last_name, created_at: null }),
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  res.json({ token: sign(user), user: toPublicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(toPublicUser(user));
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
  const id = uuid();
  const password_hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    username,
    password_hash,
    role === 'admin' ? 'admin' : 'caregiver',
    first_name?.trim() || null,
    last_name?.trim() || null
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

  db.prepare(
    'UPDATE users SET username = ?, role = ?, first_name = ?, last_name = ?, password_hash = ? WHERE id = ?'
  ).run(
    username?.trim() || existing.username,
    role === 'admin' || role === 'caregiver' ? role : existing.role,
    first_name !== undefined ? first_name?.trim() || null : existing.first_name,
    last_name !== undefined ? last_name?.trim() || null : existing.last_name,
    password_hash,
    req.params.id
  );
  res.json(toPublicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)));
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
