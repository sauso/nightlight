import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { isDemoModeActive } from '../middleware/demoMode.js';
import setup, { SetupError } from '../lib/setupState.js';

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin);

// WHY: a camera test has its own budget and never spends a password or first-admin attempt.
const testLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true,
  legacyHeaders: false, keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${req.user.id}`,
  message: { error: 'Too many monitor tests. Try again later.', code: 'RATE_LIMITED' } });
const writeLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true,
  legacyHeaders: false, keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${req.user.id}`,
  message: { error: 'Too many setup changes. Try again later.', code: 'RATE_LIMITED' } });
const writeGuard = (req, res, next) => isDemoModeActive()
  ? res.status(403).json({ error: 'This is a read-only public demo - that action is disabled here.', code: 'DEMO_READ_ONLY' })
  : next();
const exact = (body, keys) => body && typeof body === 'object' && !Array.isArray(body)
  && Object.keys(body).every((key) => keys.includes(key));
const answer = (res, fn) => {
  try { return res.json(fn()); } catch (error) {
    if (error instanceof SetupError) return res.status(error.status).json({ error: error.message, code: error.code,
      ...(error.missing ? { missing: error.missing } : {}) });
    throw error;
  }
};

router.get('/', (req, res) => {
  // WHY: readiness depends on this login session's in-memory attestation.
  res.set('Cache-Control', 'private, no-store');
  res.vary('Authorization');
  return answer(res, () => setup.read(req.user.sid));
});
router.patch('/progress', writeGuard, writeLimiter, (req, res) => {
  if (!exact(req.body, ['activeStep', 'expectedRowVersion'])) return res.status(400).json({ error: 'Invalid progress fields.', code: 'INVALID_PROGRESS' });
  return answer(res, () => setup.advance(req.body.activeStep, req.body.expectedRowVersion, req.user.sid));
});
router.post('/monitor-tests', writeGuard, testLimiter, (req, res) => {
  if (!exact(req.body, ['cameraId']) || !Object.hasOwn(req.body, 'cameraId')) return res.status(400).json({ error: 'A camera id is required.', code: 'INVALID_CAMERA' });
  return answer(res, () => setup.startTest(req.body.cameraId, req.user.sid));
});
router.post('/monitor-tests/:id/confirm', writeGuard, testLimiter, (req, res) => {
  if (!exact(req.body, ['cameraId']) || !Object.hasOwn(req.body, 'cameraId')) return res.status(400).json({ error: 'A camera id is required.', code: 'INVALID_TEST' });
  return answer(res, () => setup.confirm(req.params.id, req.body.cameraId, req.user.sid));
});
router.post('/complete', writeGuard, writeLimiter, (req, res) => {
  const body = req.body ?? {};
  if (!exact(body, ['limited']) || (Object.hasOwn(body, 'limited') && typeof body.limited !== 'boolean')) {
    return res.status(400).json({ error: 'Limited must be true or false.', code: 'INVALID_COMPLETION' });
  }
  return answer(res, () => setup.complete(body.limited ?? false, req.user.sid));
});

export default router;
