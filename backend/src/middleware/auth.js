import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// Same as requireAuth, but also accepts the token as a ?token= query param.
// Needed for HLS: Safari's native <video> player fetches playlist/segment URLs
// itself with no way for us to attach an Authorization header to those requests.
export function requireAuthQueryOrHeader(req, res, next) {
  const header = req.headers.authorization || '';
  const token = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

export { JWT_SECRET };
